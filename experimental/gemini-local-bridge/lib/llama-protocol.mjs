/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * llama.cpp-side wire protocol: builds outbound OpenAI-compatible
 * `llama-server` requests and parses its responses (non-stream and SSE
 * streaming), bounded and defensive throughout.
 */

export class LlamaProtocolError extends Error {
  constructor(category, message) {
    super(message);
    this.name = 'LlamaProtocolError';
    this.category = category;
  }
}

const MAX_SSE_BUFFER_BYTES = 1024 * 1024;
const DONE_SENTINEL = '[DONE]';

export function buildChatCompletionRequest({
  backendModel,
  systemText,
  messages,
  generation,
  stream,
}) {
  if (typeof backendModel !== 'string' || backendModel.length === 0) {
    throw new TypeError('backendModel is required');
  }

  const chatMessages = [];
  if (systemText) {
    chatMessages.push({ role: 'system', content: systemText });
  }
  for (const message of messages) {
    chatMessages.push({
      role: message.role === 'model' ? 'assistant' : 'user',
      content: message.text,
    });
  }

  const body = {
    model: backendModel,
    messages: chatMessages,
    stream: Boolean(stream),
  };
  const g = generation ?? {};
  if (g.temperature !== undefined) body.temperature = g.temperature;
  if (g.topP !== undefined) body.top_p = g.topP;
  if (g.topK !== undefined) body.top_k = g.topK;
  if (g.maxOutputTokens !== undefined) body.max_tokens = g.maxOutputTokens;
  if (g.stopSequences !== undefined) body.stop = g.stopSequences;
  if (g.seed !== undefined) body.seed = g.seed;
  if (g.presencePenalty !== undefined) {
    body.presence_penalty = g.presencePenalty;
  }
  if (g.frequencyPenalty !== undefined) {
    body.frequency_penalty = g.frequencyPenalty;
  }
  if (stream) {
    body.stream_options = { include_usage: true };
  }
  return body;
}

export function buildInputTokensRequest({
  backendModel,
  systemText,
  messages,
}) {
  return buildChatCompletionRequest({
    backendModel,
    systemText,
    messages,
    generation: {},
    stream: false,
  });
}

function isPlainObject(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

export function parseChatCompletionResponse(json) {
  if (
    !isPlainObject(json) ||
    !Array.isArray(json.choices) ||
    json.choices.length === 0
  ) {
    throw new LlamaProtocolError(
      'BACKEND_INVALID_RESPONSE',
      'backend response missing choices[]',
    );
  }

  const choice = json.choices[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string') {
    throw new LlamaProtocolError(
      'BACKEND_INVALID_RESPONSE',
      'backend response missing choices[0].message.content string',
    );
  }
  if (typeof choice.finish_reason !== 'string') {
    throw new LlamaProtocolError(
      'BACKEND_INVALID_RESPONSE',
      'backend response missing choices[0].finish_reason string',
    );
  }

  const result = {
    text: content,
    finishReason: choice.finish_reason,
  };
  if (isPlainObject(json.usage)) {
    result.usage = extractUsage(json.usage);
  }
  return result;
}

function extractUsage(usage) {
  const out = {};
  if (
    typeof usage.prompt_tokens === 'number' &&
    Number.isFinite(usage.prompt_tokens)
  ) {
    out.promptTokens = usage.prompt_tokens;
  }
  if (
    typeof usage.completion_tokens === 'number' &&
    Number.isFinite(usage.completion_tokens)
  ) {
    out.completionTokens = usage.completion_tokens;
  }
  if (
    typeof usage.total_tokens === 'number' &&
    Number.isFinite(usage.total_tokens)
  ) {
    out.totalTokens = usage.total_tokens;
  }
  return out;
}

export function parseInputTokensResponse(json) {
  if (
    !isPlainObject(json) ||
    typeof json.input_tokens !== 'number' ||
    !Number.isFinite(json.input_tokens)
  ) {
    throw new LlamaProtocolError(
      'BACKEND_INVALID_RESPONSE',
      'backend response missing numeric input_tokens',
    );
  }
  return { totalTokens: json.input_tokens };
}

function findNextBoundary(buffer) {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1) return crlf === -1 ? null : { index: crlf, length: 4 };
  if (crlf === -1) return { index: lf, length: 2 };
  return lf < crlf
    ? { index: lf, length: 2 }
    : { index: crlf, length: 4 };
}

export function createSseFrameSplitter() {
  let buffer = '';

  return {
    push(chunkText) {
      buffer += chunkText;

      if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_BUFFER_BYTES) {
        throw new LlamaProtocolError(
          'BACKEND_INVALID_RESPONSE',
          'backend SSE stream exceeded bounded buffer without a frame terminator',
        );
      }

      const frames = [];
      while (true) {
        const boundary = findNextBoundary(buffer);
        if (!boundary) break;

        const rawFrame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);

        const dataLines = rawFrame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice('data:'.length).trimStart());

        if (dataLines.length > 0) {
          frames.push(dataLines.join('\n').trim());
        }
      }
      return frames;
    },

    finish() {
      const remaining = buffer;
      buffer = '';
      if (remaining.trim().length > 0) {
        throw new LlamaProtocolError(
          'BACKEND_INVALID_RESPONSE',
          'backend SSE stream ended with an incomplete trailing frame',
        );
      }
    },
  };
}

/**
 * llama.cpp currently emits a terminal usage-only streaming chunk with
 * `choices: []` and `usage` populated. Its own server test explicitly
 * handles that shape. Treat it as a valid metadata-only chunk instead of
 * rejecting an otherwise successful stream.
 */
export function parseChatCompletionChunk(framePayload) {
  if (framePayload === DONE_SENTINEL) {
    return { done: true };
  }

  let json;
  try {
    json = JSON.parse(framePayload);
  } catch {
    throw new LlamaProtocolError(
      'BACKEND_INVALID_RESPONSE',
      'malformed SSE JSON payload from backend',
    );
  }

  if (!isPlainObject(json) || !Array.isArray(json.choices)) {
    throw new LlamaProtocolError(
      'BACKEND_INVALID_RESPONSE',
      'backend stream chunk missing choices[]',
    );
  }

  if (json.choices.length === 0) {
    if (!isPlainObject(json.usage)) {
      throw new LlamaProtocolError(
        'BACKEND_INVALID_RESPONSE',
        'backend stream chunk has empty choices[] without usage metadata',
      );
    }
    return {
      done: false,
      usageOnly: true,
      textDelta: '',
      usage: extractUsage(json.usage),
    };
  }

  const choice = json.choices[0];
  if (!isPlainObject(choice)) {
    throw new LlamaProtocolError(
      'BACKEND_INVALID_RESPONSE',
      'backend stream choice is invalid',
    );
  }

  const delta = choice.delta;
  let textDelta = '';
  if (delta !== undefined && delta !== null) {
    if (!isPlainObject(delta)) {
      throw new LlamaProtocolError(
        'BACKEND_INVALID_RESPONSE',
        'backend stream delta is invalid',
      );
    }
    if (
      delta.content !== undefined &&
      delta.content !== null &&
      typeof delta.content !== 'string'
    ) {
      throw new LlamaProtocolError(
        'BACKEND_INVALID_RESPONSE',
        'backend stream delta.content is not text',
      );
    }
    if (typeof delta.content === 'string') {
      textDelta = delta.content;
    }
  }

  const result = {
    done: false,
    usageOnly: false,
    textDelta,
  };

  if (
    choice.finish_reason !== undefined &&
    choice.finish_reason !== null
  ) {
    if (typeof choice.finish_reason !== 'string') {
      throw new LlamaProtocolError(
        'BACKEND_INVALID_RESPONSE',
        'backend stream finish_reason is invalid',
      );
    }
    result.finishReason = choice.finish_reason;
  }

  if (isPlainObject(json.usage)) {
    result.usage = extractUsage(json.usage);
  }

  return result;
}
