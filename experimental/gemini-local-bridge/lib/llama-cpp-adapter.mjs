/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Loopback-only HTTP adapter between the pinned Gemini/GenAI wire shape and
 * a llama.cpp-compatible OpenAI-style local backend.
 *
 * C1 remains protocol-only: this file is not wired into run.mjs and has no
 * hosted fallback path.
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
import { LOOPBACK_HOST, validateBackendOrigin } from './loopback-origin.mjs';

export { validateBackendOrigin };

const CLIENT_DISCONNECTED = Symbol('client-disconnected');

const DEFAULT_MAX_BODY_BYTES = 1_000_000;
const DEFAULT_MAX_BACKEND_BODY_BYTES = 2_000_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_BACKEND_TIMEOUT_MS = 30_000;

const KNOWN_PART_FIELDS = new Set([
  'text',
  'inlineData',
  'fileData',
  'functionCall',
  'functionResponse',
  'executableCode',
  'codeExecutionResult',
  'thought',
  'thoughtSignature',
  'videoMetadata',
  'mediaResolution',
]);

const KNOWN_GENERATION_CONFIG_FIELDS = new Set([
  'temperature',
  'topP',
  'topK',
  'maxOutputTokens',
  'stopSequences',
  'candidateCount',
  'seed',
  'presencePenalty',
  'frequencyPenalty',
  'responseMimeType',
  'responseSchema',
  'responseJsonSchema',
  'responseLogprobs',
  'logprobs',
  'responseModalities',
  'mediaResolution',
  'speechConfig',
  'thinkingConfig',
  'imageConfig',
  'routingConfig',
  'modelSelectionConfig',
  'labels',
]);

function requirePositiveSafeInteger(name, value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function rejectUnknownKeys(value, allowed, where) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new GeminiProtocolError(
        ERROR_CATEGORY.UNSUPPORTED_REQUEST,
        `${where}: unknown field "${key}" is not accepted by this closed-world C1 adapter`,
        400,
      );
    }
  }
}

function validateClosedWorldBody(body, verb) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return;

  if (verb === 'generateContent' || verb === 'streamGenerateContent') {
    rejectUnknownKeys(
      body,
      new Set([
        'contents',
        'systemInstruction',
        'tools',
        'toolConfig',
        'safetySettings',
        'cachedContent',
        'generationConfig',
      ]),
      'request',
    );
    if (Array.isArray(body.contents)) {
      body.contents.forEach((content, contentIndex) => {
        rejectUnknownKeys(content, new Set(['role', 'parts']), `contents[${contentIndex}]`);
        if (Array.isArray(content?.parts)) {
          content.parts.forEach((part, partIndex) => {
            rejectUnknownKeys(part, KNOWN_PART_FIELDS, `contents[${contentIndex}].parts[${partIndex}]`);
          });
        }
      });
    }
    if (body.systemInstruction && typeof body.systemInstruction === 'object') {
      rejectUnknownKeys(body.systemInstruction, new Set(['role', 'parts']), 'systemInstruction');
      if (Array.isArray(body.systemInstruction.parts)) {
        body.systemInstruction.parts.forEach((part, partIndex) => {
          rejectUnknownKeys(part, KNOWN_PART_FIELDS, `systemInstruction.parts[${partIndex}]`);
        });
      }
    }
    if (body.generationConfig && typeof body.generationConfig === 'object') {
      rejectUnknownKeys(body.generationConfig, KNOWN_GENERATION_CONFIG_FIELDS, 'generationConfig');
    }
    return;
  }

  if (verb === 'countTokens') {
    rejectUnknownKeys(
      body,
      new Set(['contents', 'systemInstruction', 'tools', 'generationConfig']),
      'countTokens request',
    );
    if (Array.isArray(body.contents)) {
      body.contents.forEach((content, contentIndex) => {
        rejectUnknownKeys(content, new Set(['role', 'parts']), `contents[${contentIndex}]`);
        if (Array.isArray(content?.parts)) {
          content.parts.forEach((part, partIndex) => {
            rejectUnknownKeys(part, KNOWN_PART_FIELDS, `contents[${contentIndex}].parts[${partIndex}]`);
          });
        }
      });
    }
  }
}

function validateQuery(url, verb) {
  const entries = [...url.searchParams.entries()];
  if (verb === 'streamGenerateContent') {
    if (entries.length !== 1 || entries[0][0] !== 'alt' || entries[0][1] !== 'sse') {
      throw new GeminiProtocolError(
        ERROR_CATEGORY.UNSUPPORTED_ROUTE,
        'streamGenerateContent requires exactly ?alt=sse',
        404,
      );
    }
    return;
  }
  if (entries.length !== 0) {
    throw new GeminiProtocolError(
      ERROR_CATEGORY.UNSUPPORTED_ROUTE,
      'query parameters are not supported on this route',
      404,
    );
  }
}

function readBoundedBody(req, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(
      () =>
        finish(() => {
          reject(
            new GeminiProtocolError(
              ERROR_CATEGORY.REQUEST_TIMEOUT,
              'timed out reading request body',
              408,
            ),
          );
        }),
      timeoutMs,
    );

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
        finish(() => {
          reject(
            new GeminiProtocolError(
              ERROR_CATEGORY.REQUEST_TOO_LARGE,
              'request body exceeds bounded size limit',
              413,
            ),
          );
        });
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      finish(() => resolve(Buffer.concat(chunks)));
    }

    function onError() {
      finish(() =>
        reject(
          new GeminiProtocolError(
            ERROR_CATEGORY.MALFORMED_REQUEST,
            'error reading request body',
            400,
          ),
        ),
      );
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function parseJsonBody(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new GeminiProtocolError(
      ERROR_CATEGORY.MALFORMED_REQUEST,
      'request body is not valid JSON',
      400,
    );
  }
}

async function readBoundedBackendJson(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    throw new GeminiProtocolError(
      ERROR_CATEGORY.BACKEND_INVALID_RESPONSE,
      'backend response body is unavailable',
      502,
    );
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new GeminiProtocolError(
          ERROR_CATEGORY.BACKEND_INVALID_RESPONSE,
          'backend response exceeded bounded size limit',
          502,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof GeminiProtocolError) throw error;
    throw new GeminiProtocolError(
      ERROR_CATEGORY.BACKEND_INVALID_RESPONSE,
      'backend returned malformed JSON',
      502,
    );
  }
}

async function callBackend(
  backendOrigin,
  path,
  requestBody,
  { backendTimeoutMs, maxBackendBodyBytes, fetchImpl, clientSignal },
) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('backend-timeout')),
    backendTimeoutMs,
  );
  const onClientAbort = () => controller.abort(new Error('client-disconnected'));
  clientSignal?.addEventListener('abort', onClientAbort);

  try {
    let response;
    try {
      response = await fetchImpl(backendOrigin + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch {
      if (clientSignal?.aborted) throw CLIENT_DISCONNECTED;
      if (controller.signal.aborted) {
        throw new GeminiProtocolError(
          ERROR_CATEGORY.BACKEND_TIMEOUT,
          'backend request timed out',
          504,
        );
      }
      throw new GeminiProtocolError(
        ERROR_CATEGORY.BACKEND_UNAVAILABLE,
        'local backend is unavailable',
        503,
      );
    }

    if (!response.ok) {
      throw new GeminiProtocolError(
        ERROR_CATEGORY.BACKEND_INVALID_RESPONSE,
        `backend returned HTTP ${response.status}`,
        502,
      );
    }

    try {
      return await readBoundedBackendJson(response, maxBackendBodyBytes);
    } catch (error) {
      if (clientSignal?.aborted) throw CLIENT_DISCONNECTED;
      if (controller.signal.aborted) {
        throw new GeminiProtocolError(
          ERROR_CATEGORY.BACKEND_TIMEOUT,
          'backend request timed out',
          504,
        );
      }
      throw error;
    }
  } finally {
    clearTimeout(timer);
    clientSignal?.removeEventListener('abort', onClientAbort);
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res, error, req) {
  if (res.headersSent || res.writableEnded) return;
  const category = error instanceof GeminiProtocolError ? error.category : ERROR_CATEGORY.INTERNAL;
  const status = error instanceof GeminiProtocolError ? error.httpStatus : 500;
  sendJson(
    res,
    status,
    buildErrorBody(
      category,
      error instanceof GeminiProtocolError ? error.message : 'internal adapter error',
      status,
    ),
  );
  if (req && !req.destroyed) {
    res.on('finish', () => {
      if (!req.destroyed) req.destroy();
    });
  }
}

async function handleGenerateContent({ res, body, cfg, stream, clientSignal }) {
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
      maxBackendBodyBytes: cfg.maxBackendBodyBytes,
      fetchImpl: cfg.fetchImpl,
      clientSignal,
    });
    const parsed = parseChatCompletionResponse(backendJson);
    const finishReason = mapFinishReason(parsed.finishReason);
    if (!finishReason) {
      throw new GeminiProtocolError(
        ERROR_CATEGORY.BACKEND_INVALID_RESPONSE,
        `backend returned an unmapped finish_reason: ${parsed.finishReason}`,
        502,
      );
    }
    const usage = parsed.usage ? buildUsageMetadata(parsed.usage) : undefined;
    sendJson(
      res,
      200,
      buildGenerateContentResponse({
        text: parsed.text,
        finishReason,
        usage,
        backendModel: cfg.backendModel,
      }),
    );
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('backend-timeout')),
    cfg.backendTimeoutMs,
  );
  const onClientAbort = () => controller.abort(new Error('client-disconnected'));
  clientSignal?.addEventListener('abort', onClientAbort);

  let backendResponse;
  let reader;
  try {
    try {
      backendResponse = await cfg.fetchImpl(cfg.backendOrigin + backendPath, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(backendRequest),
        signal: controller.signal,
      });
    } catch {
      if (clientSignal?.aborted) throw CLIENT_DISCONNECTED;
      if (controller.signal.aborted) {
        throw new GeminiProtocolError(
          ERROR_CATEGORY.BACKEND_TIMEOUT,
          'backend request timed out',
          504,
        );
      }
      throw new GeminiProtocolError(
        ERROR_CATEGORY.BACKEND_UNAVAILABLE,
        'local backend is unavailable',
        503,
      );
    }

    if (!backendResponse.ok) {
      throw new GeminiProtocolError(
        ERROR_CATEGORY.BACKEND_INVALID_RESPONSE,
        `backend returned HTTP ${backendResponse.status}`,
        502,
      );
    }

    reader = backendResponse.body?.getReader?.();
    if (!reader) {
      throw new GeminiProtocolError(
        ERROR_CATEGORY.BACKEND_INVALID_RESPONSE,
        'backend stream body is unavailable',
        502,
      );
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const decoder = new TextDecoder('utf-8');
    const splitter = createSseFrameSplitter();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          splitter.finish();
          break;
        }
        const frames = splitter.push(decoder.decode(value, { stream: true }));
        for (const frame of frames) {
          const parsed = parseChatCompletionChunk(frame);
          if (parsed.done || parsed.usageOnly) continue;

          if (parsed.textDelta.length > 0 || parsed.finishReason) {
            const finishReason = parsed.finishReason
              ? mapFinishReason(parsed.finishReason)
              : undefined;
            if (parsed.finishReason && !finishReason) return;
            const usage = parsed.usage ? buildUsageMetadata(parsed.usage) : undefined;
            res.write(
              encodeSseEvent(
                buildStreamChunk({
                  textDelta: parsed.textDelta,
                  finishReason,
                  usage,
                  backendModel: cfg.backendModel,
                }),
              ),
            );
          }
        }
      }
    } catch {
      // Mid-stream timeout, malformed SSE, disconnect, or translation failure:
      // stop emitting immediately and never fabricate a completion chunk.
    }
  } finally {
    clearTimeout(timer);
    clientSignal?.removeEventListener('abort', onClientAbort);
    if (reader && controller.signal.aborted) {
      await reader.cancel().catch(() => {});
    }
    if (!res.writableEnded) res.end();
  }
}

async function handleCountTokens({ body, cfg, clientSignal }) {
  const normalized = validateCountTokensRequest(body);
  const backendRequest = buildInputTokensRequest({
    backendModel: cfg.backendModel,
    messages: normalized.messages,
  });
  const backendJson = await callBackend(
    cfg.backendOrigin,
    '/v1/chat/completions/input_tokens',
    backendRequest,
    {
      backendTimeoutMs: cfg.backendTimeoutMs,
      maxBackendBodyBytes: cfg.maxBackendBodyBytes,
      fetchImpl: cfg.fetchImpl,
      clientSignal,
    },
  );
  return buildCountTokensResponse(parseInputTokensResponse(backendJson));
}

async function handleRequest(req, res, cfg) {
  const clientAbort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) clientAbort.abort();
  });

  if (req.method !== 'POST') {
    sendError(
      res,
      new GeminiProtocolError(
        ERROR_CATEGORY.UNSUPPORTED_METHOD,
        `unsupported method: ${req.method}`,
        405,
      ),
      req,
    );
    return;
  }

  let route;
  let url;
  try {
    url = new URL(req.url, `http://${LOOPBACK_HOST}`);
    route = parseGeminiRoute(url.pathname);
    validateQuery(url, route.verb);
  } catch (error) {
    sendError(res, error, req);
    return;
  }

  let body;
  try {
    const bodyBuffer = await readBoundedBody(req, cfg.maxBodyBytes, cfg.requestTimeoutMs);
    body = parseJsonBody(bodyBuffer);
    validateClosedWorldBody(body, route.verb);
  } catch (error) {
    sendError(res, error, req);
    return;
  }

  try {
    switch (route.verb) {
      case 'generateContent':
        await handleGenerateContent({
          res,
          body,
          cfg,
          stream: false,
          clientSignal: clientAbort.signal,
        });
        return;
      case 'streamGenerateContent':
        await handleGenerateContent({
          res,
          body,
          cfg,
          stream: true,
          clientSignal: clientAbort.signal,
        });
        return;
      case 'countTokens': {
        const result = await handleCountTokens({
          body,
          cfg,
          clientSignal: clientAbort.signal,
        });
        sendJson(res, 200, result);
        return;
      }
      case 'batchEmbedContents':
        throw new GeminiProtocolError(
          ERROR_CATEGORY.UNSUPPORTED_REQUEST,
          'embedContent is not supported in this build: it requires a separately configured embedding-capable backend/model',
          501,
        );
      default:
        throw new GeminiProtocolError(
          ERROR_CATEGORY.UNSUPPORTED_ROUTE,
          'unreachable route',
          404,
        );
    }
  } catch (error) {
    if (error === CLIENT_DISCONNECTED) {
      if (!res.writableEnded) res.end();
      return;
    }
    sendError(res, error, req);
  }
}

function installLoopbackOnlyListen(server) {
  const rawListen = server.listen.bind(server);

  function guardedListen(first, ...rest) {
    if (first && typeof first === 'object') {
      if ('path' in first) {
        throw new Error('adapter does not support Unix-socket listening');
      }
      const options = { ...first };
      if (options.host !== undefined && options.host !== LOOPBACK_HOST) {
        throw new Error(`adapter may listen only on ${LOOPBACK_HOST}`);
      }
      options.host = LOOPBACK_HOST;
      return rawListen(options, ...rest);
    }

    if (
      typeof first !== 'number' &&
      !(typeof first === 'string' && /^\d+$/.test(first))
    ) {
      throw new TypeError('adapter listen requires a TCP port');
    }

    if (typeof rest[0] === 'string') {
      if (rest[0] !== LOOPBACK_HOST) {
        throw new Error(`adapter may listen only on ${LOOPBACK_HOST}`);
      }
      return rawListen(first, ...rest);
    }

    return rawListen(first, LOOPBACK_HOST, ...rest);
  }

  Object.defineProperty(server, 'listen', {
    value: guardedListen,
    writable: false,
    configurable: false,
  });
}

export function createAdapterServer(options) {
  const opts = options ?? {};
  if (typeof opts.backendModel !== 'string' || opts.backendModel.trim().length === 0) {
    throw new TypeError('backendModel is required');
  }
  validateBackendOrigin(opts.backendOrigin);

  const cfg = {
    backendOrigin: opts.backendOrigin,
    backendModel: opts.backendModel,
    maxBodyBytes: requirePositiveSafeInteger(
      'maxBodyBytes',
      opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    ),
    maxBackendBodyBytes: requirePositiveSafeInteger(
      'maxBackendBodyBytes',
      opts.maxBackendBodyBytes ?? DEFAULT_MAX_BACKEND_BODY_BYTES,
    ),
    requestTimeoutMs: requirePositiveSafeInteger(
      'requestTimeoutMs',
      opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    backendTimeoutMs: requirePositiveSafeInteger(
      'backendTimeoutMs',
      opts.backendTimeoutMs ?? DEFAULT_BACKEND_TIMEOUT_MS,
    ),
    fetchImpl: opts.fetchImpl ?? fetch,
  };

  if (typeof cfg.fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be a function');
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res, cfg).catch(() => {
      if (!res.headersSent) {
        sendError(
          res,
          new GeminiProtocolError(
            ERROR_CATEGORY.INTERNAL,
            'internal adapter error',
            500,
          ),
          req,
        );
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  installLoopbackOnlyListen(server);
  return server;
}

export const LOOPBACK_ONLY_HOST = LOOPBACK_HOST;
