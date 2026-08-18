/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * llama.cpp-side wire protocol: builds outbound OpenAI-compatible
 * `llama-server` requests and parses its responses (non-stream and SSE
 * streaming), bounded and defensive throughout.
 *
 * Sourcing note (see the C1 implementation report for full detail): unlike
 * the Gemini side, there is no pinned llama.cpp commit and no vendored SDK
 * to read locally, and no live llama-server was launched for this slice
 * (out of scope — no real llama.cpp install in C1). `/v1/chat/completions`,
 * `/v1/chat/completions/input_tokens`, and `/v1/embeddings` route names and
 * field names below were confirmed against the current upstream
 * `ggml-org/llama.cpp` `tools/server/README.md`. The streaming chunk shape
 * and finish_reason vocabulary follow the long-stable, widely implemented
 * OpenAI Chat Completions wire format that llama-server documents itself
 * as compatible with — not a guess at "whatever the newest API does".
 * Because this is a documentation-only derivation rather than a source
 * read, every parser here is defensive: any response that does not match
 * the expected shape is treated as BACKEND_INVALID_RESPONSE and fails
 * closed rather than being guessed at.
 */

export class LlamaProtocolError extends Error {
  constructor(category, message) {
    super(message);
    this.name = 'LlamaProtocolError';
    this.category = category;
  }
}

const MAX_SSE_BUFFER_BYTES = 1024 * 1024; // 1 MiB — bounded, never unbounded buffering.
const DONE_SENTINEL = '[DONE]';

/**
 * Builds the outbound `/v1/chat/completions` (or, with stream:false, the
 * same route non-streaming) request body. `backendModel` is always the
 * adapter's configured/discovered local model identity — never the
 * inbound Gemini clientRequestedModel; see the model-identity section of
 * the C1 report.
 */
export function buildChatCompletionRequest({ backendModel, systemText, messages, generation, stream }) {
  if (typeof backendModel !== 'string' || backendModel.length === 0) {
    throw new TypeError('backendModel is required');
  }
  const chatMessages = [];
  if (systemText) {
    chatMessages.push({ role: 'system', content: systemText });
  }
  for (const message of messages) {
    chatMessages.push({ role: message.role === 'model' ? 'assistant' : 'user', content: message.text });
  }
  const body = { model: backendModel, messages: chatMessages, stream: Boolean(stream) };
  const g = generation ?? {};
  if (g.temperature !== undefined) body.temperature = g.temperature;
  if (g.topP !== undefined) body.top_p = g.topP;
  if (g.topK !== undefined) body.top_k = g.topK;
  if (g.maxOutputTokens !== undefined) body.max_tokens = g.maxOutputTokens;
  if (g.stopSequences !== undefined) body.stop = g.stopSequences;
  if (g.seed !== undefined) body.seed = g.seed;
  if (g.presencePenalty !== undefined) body.presence_penalty = g.presencePenalty;
  if (g.frequencyPenalty !== undefined) body.frequency_penalty = g.frequencyPenalty;
  if (stream) {
    // Ask for a final usage-bearing chunk when the backend supports it
    // (widely implemented OpenAI-compatible streaming extension). If the
    // backend ignores this, usage is simply absent from the last chunk —
    // handled as "usage metadata when available", never fabricated.
    body.stream_options = { include_usage: true };
  }
  return body;
}

/** Builds the `/v1/chat/completions/input_tokens` request body (llama-server's own tokenizer, not a locally-estimated count with a different tokenizer). */
export function buildInputTokensRequest({ backendModel, systemText, messages }) {
  return buildChatCompletionRequest({ backendModel, systemText, messages, generation: {}, stream: false });
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses a non-streaming `/v1/chat/completions` response. Throws LlamaProtocolError(BACKEND_INVALID_RESPONSE) on anything unexpected. */
export function parseChatCompletionResponse(json) {
  if (!isPlainObject(json) || !Array.isArray(json.choices) || json.choices.length === 0) {
    throw new LlamaProtocolError('BACKEND_INVALID_RESPONSE', 'backend response missing choices[]');
  }
  const choice = json.choices[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string') {
    throw new LlamaProtocolError('BACKEND_INVALID_RESPONSE', 'backend response missing choices[0].message.content string');
  }
  if (typeof choice.finish_reason !== 'string') {
    throw new LlamaProtocolError('BACKEND_INVALID_RESPONSE', 'backend response missing choices[0].finish_reason string');
  }
  const result = { text: content, finishReason: choice.finish_reason };
  if (isPlainObject(json.usage)) {
    result.usage = extractUsage(json.usage);
  }
  return result;
}

function extractUsage(usage) {
  const out = {};
  if (typeof usage.prompt_tokens === 'number') out.promptTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === 'number') out.completionTokens = usage.completion_tokens;
  if (typeof usage.total_tokens === 'number') out.totalTokens = usage.total_tokens;
  return out;
}

/** Parses a `/v1/chat/completions/input_tokens` response: `{ input_tokens: number }`. */
export function parseInputTokensResponse(json) {
  if (!isPlainObject(json) || typeof json.input_tokens !== 'number' || !Number.isFinite(json.input_tokens)) {
    throw new LlamaProtocolError('BACKEND_INVALID_RESPONSE', 'backend response missing numeric input_tokens');
  }
  return { totalTokens: json.input_tokens };
}

/**
 * Bounded, incremental SSE frame splitter for llama-server's OpenAI-
 * compatible streaming responses. Events are separated by a blank line
 * (`\n\n`); each frame is expected to start with `data:`. Never buffers
 * past MAX_SSE_BUFFER_BYTES without finding a terminator — a backend that
 * violates this is treated as protocol-invalid, not buffered forever.
 */
export function createSseFrameSplitter() {
  let buffer = '';
  return {
    /** Feeds one chunk of decoded text, returns an array of raw frame payload strings (already stripped of the leading "data:" prefix). */
    push(chunkText) {
      buffer += chunkText;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_BUFFER_BYTES) {
        throw new LlamaProtocolError('BACKEND_INVALID_RESPONSE', 'backend SSE stream exceeded bounded buffer without a frame terminator');
      }
      const frames = [];
      let boundary;
      // Support both \n\n and \r\n\r\n framing.
      while ((boundary = buffer.indexOf('\n\n')) !== -1 || (boundary = buffer.indexOf('\r\n\r\n')) !== -1) {
        const sepLen = buffer[boundary] === '\r' ? 4 : 2;
        const rawFrame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + sepLen);
        const line = rawFrame.split(/\r?\n/).find((l) => l.startsWith('data:'));
        if (line !== undefined) {
          frames.push(line.slice('data:'.length).trim());
        }
      }
      return frames;
    },
    /** Call when the backend connection ends. Throws if an incomplete frame remains unterminated (mirrors the pinned Gemini client's own "Incomplete JSON segment at the end" check). */
    finish() {
      const remaining = buffer;
      buffer = '';
      if (remaining.trim().length > 0) {
        throw new LlamaProtocolError('BACKEND_INVALID_RESPONSE', 'backend SSE stream ended with an incomplete trailing frame');
      }
    },
  };
}

/**
 * Parses one SSE frame payload. Returns `{ done: true }` for the literal
 * `[DONE]` terminator, or `{ done: false, textDelta, finishReason?, usage? }`
 * for a chat-completion chunk. Throws LlamaProtocolError on malformed JSON
 * or an unexpected shape — callers must stop translating and never emit a
 * fabricated final chunk after this.
 */
export function parseChatCompletionChunk(framePayload) {
  if (framePayload === DONE_SENTINEL) {
    return { done: true };
  }
  let json;
  try {
    json = JSON.parse(framePayload);
  } catch {
    throw new LlamaProtocolError('BACKEND_INVALID_RESPONSE', 'malformed SSE JSON payload from backend');
  }
  if (!isPlainObject(json) || !Array.isArray(json.choices) || json.choices.length === 0) {
    throw new LlamaProtocolError('BACKEND_INVALID_RESPONSE', 'backend stream chunk missing choices[]');
  }
  const choice = json.choices[0];
  const delta = choice?.delta;
  const textDelta = isPlainObject(delta) && typeof delta.content === 'string' ? delta.content : '';
  const result = { done: false, textDelta };
  if (typeof choice.finish_reason === 'string') {
    result.finishReason = choice.finish_reason;
  }
  if (isPlainObject(json.usage)) {
    result.usage = extractUsage(json.usage);
  }
  return result;
}
