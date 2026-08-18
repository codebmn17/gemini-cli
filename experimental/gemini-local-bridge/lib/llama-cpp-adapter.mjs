/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Loopback-only HTTP adapter: accepts requests shaped like the pinned
 * `@google/genai` client's Gemini calls and translates them to/from a
 * llama.cpp-compatible (OpenAI-style) backend.
 *
 * Protocol translation only — see lib/gemini-protocol.mjs and
 * lib/llama-protocol.mjs for the wire-shape derivations. This module owns
 * the network/process-facing safety properties: loopback-only binding,
 * backend origin validation, a closed outbound-header allowlist, bounded
 * request/backend sizes and timeouts, client-disconnect cancellation, and
 * sanitized error responses. It never falls back to hosted Gemini or any
 * other external endpoint — the only network destination it ever contacts
 * is the single validated `backendOrigin` it was constructed with.
 *
 * Deliberately separate from doctor.mjs (no network/process capability)
 * and run.mjs (still refuses arbitrary prompts in this build — nothing
 * wires this adapter into the CLI dispatch path yet).
 */

import http from 'node:http';
import {
  ERROR_CATEGORY,
  GeminiProtocolError,
  parseGeminiRoute,
  validateGenerateContentRequest,
  validateCountTokensRequest,
  buildGenerateContentResponse,
  buildStreamChunk,
  buildUsageMetadata,
  buildCountTokensResponse,
  buildErrorBody,
  encodeSseEvent,
  mapFinishReason,
} from './gemini-protocol.mjs';
import {
  buildChatCompletionRequest,
  buildInputTokensRequest,
  parseChatCompletionResponse,
  parseInputTokensResponse,
  createSseFrameSplitter,
  parseChatCompletionChunk,
} from './llama-protocol.mjs';

const LOOPBACK_HOST = '127.0.0.1';
const BACKEND_ORIGIN_RE = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/;
const CLIENT_DISCONNECTED = Symbol('client-disconnected');

const DEFAULT_MAX_BODY_BYTES = 1_000_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_BACKEND_TIMEOUT_MS = 30_000;

/**
 * Validates a backend origin string. C1 accepts only the literal loopback
 * form `http://127.0.0.1:<port>` — no hostnames (including "localhost"),
 * no all-interfaces address, no IPv6 loopback (deliberately deferred, not expanded
 * casually), no path/query/fragment, https out of scope for C1.
 */
export function validateBackendOrigin(origin) {
  if (typeof origin !== 'string') {
    throw new TypeError('backendOrigin must be a string');
  }
  const match = BACKEND_ORIGIN_RE.exec(origin);
  if (!match) {
    throw new Error(
      `backendOrigin must be exactly "http://127.0.0.1:<port>" (loopback-only, http-only, no hostname/path); got: ${JSON.stringify(origin)}`,
    );
  }
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`backendOrigin port out of range: ${port}`);
  }
  return { host: LOOPBACK_HOST, port };
}

function readBoundedBody(req, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(() => finish(() => {
      reject(new GeminiProtocolError(ERROR_CATEGORY.REQUEST_TIMEOUT, 'timed out reading request body', 408));
    }), timeoutMs);
    function finish(action) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      action();
    }
    function onData(chunk) {
      total += chunk.length;
      if (total > maxBytes) {
        // Stop consuming (finish() already unregistered the listeners
        // above) but do NOT destroy the socket here — destroying it before
        // the error response is flushed can reset the connection out from
        // under the response we are about to send. The caller destroys
        // the request stream only after the response has actually been
        // written (see sendError's res 'finish' handler).
        finish(() => {
          reject(new GeminiProtocolError(ERROR_CATEGORY.REQUEST_TOO_LARGE, 'request body exceeds bounded size limit', 413));
        });
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      finish(() => resolve(Buffer.concat(chunks)));
    }
    function onError() {
      finish(() => reject(new GeminiProtocolError(ERROR_CATEGORY.MALFORMED_REQUEST, 'error reading request body', 400)));
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function parseJsonBody(buffer) {
  const text = buffer.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new GeminiProtocolError(ERROR_CATEGORY.MALFORMED_REQUEST, 'request body is not valid JSON');
  }
}

async function callBackend(backendOrigin, path, requestBody, { backendTimeoutMs, fetchImpl, clientSignal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('backend-timeout')), backendTimeoutMs);
  const onClientAbort = () => controller.abort(new Error('client-disconnected'));
  clientSignal?.addEventListener('abort', onClientAbort);
  try {
    let response;
    try {
      response = await fetchImpl(backendOrigin + path, {
        method: 'POST',
        // Closed allowlist, built fresh — never derived from the inbound
        // request's headers. This is the only place outbound headers are
        // constructed, so there is nothing to accidentally forward.
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch {
      if (clientSignal?.aborted) throw CLIENT_DISCONNECTED;
      if (controller.signal.aborted) {
        throw new GeminiProtocolError(ERROR_CATEGORY.BACKEND_TIMEOUT, 'backend request timed out', 504);
      }
      throw new GeminiProtocolError(ERROR_CATEGORY.BACKEND_UNAVAILABLE, 'local backend is unavailable', 503);
    }
    if (!response.ok) {
      throw new GeminiProtocolError(ERROR_CATEGORY.BACKEND_INVALID_RESPONSE, `backend returned HTTP ${response.status}`, 502);
    }
    try {
      return await response.json();
    } catch {
      throw new GeminiProtocolError(ERROR_CATEGORY.BACKEND_INVALID_RESPONSE, 'backend returned malformed JSON', 502);
    }
  } finally {
    clearTimeout(timer);
    clientSignal?.removeEventListener('abort', onClientAbort);
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendError(res, error, req) {
  if (res.headersSent || res.writableEnded) return;
  const category = error instanceof GeminiProtocolError ? error.category : ERROR_CATEGORY.INTERNAL;
  const status = error instanceof GeminiProtocolError ? error.httpStatus : 500;
  // Only the fixed category and a short, developer-authored message ever
  // reach the client — never raw backend body content, header values, or
  // exception internals (see module doc comment).
  sendJson(res, status, buildErrorBody(category, error instanceof GeminiProtocolError ? error.message : 'internal adapter error', status));
  // Only stop draining/destroy the (possibly still-arriving, e.g.
  // oversized) request stream once the error response has actually been
  // flushed — destroying it earlier can reset the connection out from
  // under the response we just wrote.
  if (req && !req.destroyed) {
    res.on('finish', () => {
      if (!req.destroyed) req.destroy();
    });
  }
}

async function handleGenerateContent({ req, res, body, cfg, stream, clientSignal }) {
  const normalized = validateGenerateContentRequest(body);
  const backendPath = '/v1/chat/completions';
  const backendRequest = buildChatCompletionRequest({
    backendModel: cfg.backendModel,
    systemText: normalized.systemText,
    messages: normalized.messages,
    generation: normalized.generation,
    stream,
  });

  if (!stream) {
    const backendJson = await callBackend(cfg.backendOrigin, backendPath, backendRequest, {
      backendTimeoutMs: cfg.backendTimeoutMs,
      fetchImpl: cfg.fetchImpl,
      clientSignal,
    });
    const parsed = parseChatCompletionResponse(backendJson);
    const finishReason = mapFinishReason(parsed.finishReason);
    if (!finishReason) {
      throw new GeminiProtocolError(ERROR_CATEGORY.BACKEND_INVALID_RESPONSE, `backend returned an unmapped finish_reason: ${parsed.finishReason}`, 502);
    }
    const usage = parsed.usage ? buildUsageMetadata(parsed.usage) : undefined;
    sendJson(res, 200, buildGenerateContentResponse({ text: parsed.text, finishReason, usage, backendModel: cfg.backendModel }));
    return;
  }

  // Streaming: perform the backend call first without committing the
  // Gemini-side response, so a failure before any bytes are sent can still
  // use the clean single-JSON-error path.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('backend-timeout')), cfg.backendTimeoutMs);
  const onClientAbort = () => controller.abort(new Error('client-disconnected'));
  clientSignal?.addEventListener('abort', onClientAbort);
  let backendResponse;
  try {
    try {
      backendResponse = await cfg.fetchImpl(cfg.backendOrigin + backendPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(backendRequest),
        signal: controller.signal,
      });
    } catch {
      if (clientSignal?.aborted) throw CLIENT_DISCONNECTED;
      if (controller.signal.aborted) {
        throw new GeminiProtocolError(ERROR_CATEGORY.BACKEND_TIMEOUT, 'backend request timed out', 504);
      }
      throw new GeminiProtocolError(ERROR_CATEGORY.BACKEND_UNAVAILABLE, 'local backend is unavailable', 503);
    }
    if (!backendResponse.ok) {
      throw new GeminiProtocolError(ERROR_CATEGORY.BACKEND_INVALID_RESPONSE, `backend returned HTTP ${backendResponse.status}`, 502);
    }
  } finally {
    clearTimeout(timer);
  }

  // Backend accepted the stream: commit to Gemini-side SSE headers now.
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const reader = backendResponse.body?.getReader?.();
  if (!reader) {
    clientSignal?.removeEventListener('abort', onClientAbort);
    // Nothing was sent yet on the Gemini side; safe to still end cleanly
    // without a fabricated chunk.
    res.end();
    return;
  }
  const decoder = new TextDecoder('utf-8');
  const splitter = createSseFrameSplitter();
  try {
    while (true) {
      if (clientSignal?.aborted) {
        controller.abort(new Error('client-disconnected'));
        break;
      }
      const { done, value } = await reader.read();
      if (done) {
        splitter.finish(); // throws if a trailing frame was left incomplete
        break;
      }
      const frames = splitter.push(decoder.decode(value, { stream: true }));
      for (const frame of frames) {
        const parsed = parseChatCompletionChunk(frame);
        if (parsed.done) continue; // "[DONE]" — no corresponding Gemini chunk
        if (parsed.textDelta.length > 0 || parsed.finishReason) {
          const finishReason = parsed.finishReason ? mapFinishReason(parsed.finishReason) : undefined;
          if (parsed.finishReason && !finishReason) {
            // Unmapped finish reason mid-stream: stop translating rather
            // than emit a chunk we cannot faithfully represent. Nothing
            // fabricated after this point.
            res.end();
            return;
          }
          const usage = parsed.usage ? buildUsageMetadata(parsed.usage) : undefined;
          res.write(encodeSseEvent(buildStreamChunk({ textDelta: parsed.textDelta, finishReason, usage, backendModel: cfg.backendModel })));
        }
      }
    }
  } catch {
    // Malformed/incomplete backend SSE, or a translation error mid-stream:
    // fail closed by simply not writing anything further. Never emit a
    // synthetic final chunk to paper over the failure.
  } finally {
    clientSignal?.removeEventListener('abort', onClientAbort);
    if (!res.writableEnded) res.end();
  }
}

async function handleCountTokens({ body, cfg, clientSignal }) {
  const normalized = validateCountTokensRequest(body);
  const backendRequest = buildInputTokensRequest({ backendModel: cfg.backendModel, messages: normalized.messages });
  const backendJson = await callBackend(cfg.backendOrigin, '/v1/chat/completions/input_tokens', backendRequest, {
    backendTimeoutMs: cfg.backendTimeoutMs,
    fetchImpl: cfg.fetchImpl,
    clientSignal,
  });
  const parsed = parseInputTokensResponse(backendJson);
  return buildCountTokensResponse(parsed);
}

async function handleRequest(req, res, cfg) {
  const clientAbort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) clientAbort.abort();
  });

  if (req.method !== 'POST') {
    sendError(res, new GeminiProtocolError(ERROR_CATEGORY.UNSUPPORTED_METHOD, `unsupported method: ${req.method}`, 405), req);
    return;
  }

  let route;
  try {
    const url = new URL(req.url, `http://${LOOPBACK_HOST}`);
    route = parseGeminiRoute(url.pathname);
  } catch (error) {
    sendError(res, error, req);
    return;
  }

  let bodyBuffer;
  try {
    bodyBuffer = await readBoundedBody(req, cfg.maxBodyBytes, cfg.requestTimeoutMs);
  } catch (error) {
    sendError(res, error, req);
    return;
  }

  let body;
  try {
    body = parseJsonBody(bodyBuffer);
  } catch (error) {
    sendError(res, error, req);
    return;
  }

  try {
    switch (route.verb) {
      case 'generateContent':
        await handleGenerateContent({ req, res, body, cfg, stream: false, clientSignal: clientAbort.signal });
        return;
      case 'streamGenerateContent':
        await handleGenerateContent({ req, res, body, cfg, stream: true, clientSignal: clientAbort.signal });
        return;
      case 'countTokens': {
        const result = await handleCountTokens({ body, cfg, clientSignal: clientAbort.signal });
        sendJson(res, 200, result);
        return;
      }
      case 'batchEmbedContents':
        throw new GeminiProtocolError(
          ERROR_CATEGORY.UNSUPPORTED_REQUEST,
          'embedContent is not supported in this build: it requires a separately configured embedding-capable backend/model, which is not guaranteed by the general local-chat path (see docs)',
          501,
        );
      default:
        throw new GeminiProtocolError(ERROR_CATEGORY.UNSUPPORTED_ROUTE, 'unreachable route', 404);
    }
  } catch (error) {
    if (error === CLIENT_DISCONNECTED) {
      if (!res.writableEnded) res.end();
      return;
    }
    sendError(res, error, req);
  }
}

/**
 * Creates (but does not start) the adapter's HTTP server. Callers must
 * `.listen(port, '127.0.0.1')` explicitly — this module never binds
 * itself, so the literal-loopback requirement stays visible at the call
 * site rather than being hidden behind a convenience wrapper.
 */
export function createAdapterServer(options) {
  const opts = options ?? {};
  if (typeof opts.backendModel !== 'string' || opts.backendModel.length === 0) {
    throw new TypeError('backendModel is required');
  }
  validateBackendOrigin(opts.backendOrigin); // throws on anything but http://127.0.0.1:<port>

  const cfg = {
    backendOrigin: opts.backendOrigin,
    backendModel: opts.backendModel,
    maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    backendTimeoutMs: opts.backendTimeoutMs ?? DEFAULT_BACKEND_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl ?? fetch,
  };

  return http.createServer((req, res) => {
    handleRequest(req, res, cfg).catch(() => {
      if (!res.headersSent) {
        sendError(res, new GeminiProtocolError(ERROR_CATEGORY.INTERNAL, 'internal adapter error', 500));
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });
}

export const LOOPBACK_ONLY_HOST = LOOPBACK_HOST;
