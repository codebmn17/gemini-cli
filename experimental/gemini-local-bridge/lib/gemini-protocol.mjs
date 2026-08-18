/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Gemini-side wire protocol: parses inbound requests shaped like the
 * `@google/genai` client's HTTP calls and builds outbound responses shaped
 * like what that client expects back.
 *
 * Derived directly from pinned Gemini CLI 0.55.1 (commit
 * 41327e407da58aa01c409ef6685b7b5d379f295e) and its exact locked
 * `@google/genai` dependency, version 1.30.0 (read from
 * packages/{cli,core}/package.json and package-lock.json at that commit),
 * by reading the SDK's own compiled request/response mapping functions
 * (`*ToMldev` / `*FromMldev` in dist/node/index.mjs) rather than assuming
 * current Google API documentation. See the C1 implementation report for
 * the full derivation notes. Route/header findings are additionally
 * corroborated by the accepted Phase B recorder's real E2E capture
 * (`/v1beta/models/<model>:generateContent`, `x-goog-api-key` auth
 * header) from earlier in this project.
 *
 * This module has no network/process capability itself — it only
 * transforms plain JS values.
 */

export class GeminiProtocolError extends Error {
  constructor(category, message, httpStatus = 400) {
    super(message);
    this.name = 'GeminiProtocolError';
    this.category = category;
    this.httpStatus = httpStatus;
  }
}

export const ERROR_CATEGORY = Object.freeze({
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  UNSUPPORTED_ROUTE: 'UNSUPPORTED_ROUTE',
  UNSUPPORTED_METHOD: 'UNSUPPORTED_METHOD',
  UNSUPPORTED_CONTENT_PART: 'UNSUPPORTED_CONTENT_PART',
  UNSUPPORTED_REQUEST: 'UNSUPPORTED_REQUEST',
  UNSUPPORTED_GENERATION_CONFIG: 'UNSUPPORTED_GENERATION_CONFIG',
  REQUEST_TOO_LARGE: 'REQUEST_TOO_LARGE',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  BACKEND_UNAVAILABLE: 'BACKEND_UNAVAILABLE',
  BACKEND_TIMEOUT: 'BACKEND_TIMEOUT',
  BACKEND_INVALID_RESPONSE: 'BACKEND_INVALID_RESPONSE',
  INTERNAL: 'INTERNAL',
});

// Fields the pinned `@google/genai` wire format supports on a Part beyond
// `text`. If any is present with a truthy value we fail closed rather than
// silently dropping it — see generateContentConfigToMldev / partToMldev$1
// in the pinned SDK.
const NON_TEXT_PART_FIELDS = Object.freeze([
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

// Top-level request fields (siblings of `contents`) that have no safe
// local-backend translation and must not be silently dropped.
const UNSUPPORTED_TOP_LEVEL_FIELDS = Object.freeze([
  'tools',
  'toolConfig',
  'safetySettings',
  'cachedContent',
]);

/**
 * Pinned Gemini CLI 0.55.1's Client.startChat()/setTools()
 * (packages/core/src/core/client.ts) unconditionally builds
 * `tools: [{ functionDeclarations: toolRegistry.getFunctionDeclarations() }]`
 * for every chat session, including headless single-prompt mode -- there is
 * no code path that omits the `tools` key. `toolRegistry.getFunctionDeclarations()`
 * is empty only when the isolated launch settings restrict the built-in
 * tool allowlist to nothing (`tools.core: []` in settings.json ->
 * `Config.getCoreTools()` -> `createToolRegistry()`'s `maybeRegister()`
 * treats an empty allowlist as "enable none" for every core tool --
 * packages/core/src/config/config.ts). When that holds, the `tools` field
 * the real CLI sends is a syntactically-present but semantically-empty
 * wrapper: nothing is being offered to the model, so nothing is lost by
 * accepting it. This is deliberately narrower than "ignore tools": any
 * entry that carries a real function declaration, or any other Tool
 * variant (googleSearch/codeExecution/urlContext/retrieval/...), still
 * fails closed exactly as before -- see isHarmlessEmptyToolsWrapper below.
 */
function isHarmlessEmptyToolsWrapper(tools) {
  if (!Array.isArray(tools)) return false;
  return tools.every((entry) => {
    if (!isPlainObject(entry)) return false;
    const keys = Object.keys(entry);
    if (keys.some((key) => key !== 'functionDeclarations')) return false;
    if (!('functionDeclarations' in entry)) return true;
    const declarations = entry.functionDeclarations;
    return Array.isArray(declarations) && declarations.length === 0;
  });
}

/**
 * Pinned Gemini CLI 0.55.1's ModelConfigService falls back to its
 * `chat-base` alias for any model string it does not recognize as a real
 * Gemini model (packages/core/src/services/modelConfigService.ts's
 * `fallbackAlias = 'chat-base'` path) -- which is exactly what happens for
 * every neutral/local clientModel this bridge ever sends, by design (it
 * must never be a Gemini-branded name). `chat-base`
 * (packages/core/src/config/defaultModelConfigs.ts) sets
 * `generateContentConfig.thinkingConfig = { includeThoughts: true }` with no
 * budget/level -- so, like the `tools` wrapper above, every real headless
 * invocation carries this exact field whether or not "thinking" is actually
 * wanted. `includeThoughts` only asks that thought parts be included *if the
 * model produces any*; a backend/model with no thinking capability produces
 * none either way, so the translated response already looks exactly like a
 * real non-thinking Gemini model's would. Accepting only this precise
 * default shape costs nothing; a real, deliberate ask -- `thinkingBudget`,
 * `thinkingLevel`, or any other key -- still fails closed exactly as before.
 */
function isHarmlessDefaultThinkingConfig(thinkingConfig) {
  if (!isPlainObject(thinkingConfig)) return false;
  const keys = Object.keys(thinkingConfig);
  if (keys.some((key) => key !== 'includeThoughts')) return false;
  if (!('includeThoughts' in thinkingConfig)) return true;
  return typeof thinkingConfig.includeThoughts === 'boolean';
}

// generationConfig fields with no faithful llama.cpp-side equivalent for
// C1 (non-text modalities, JSON-schema-constrained output, logprobs shape
// differences, routing/labels that are Google-infrastructure-specific).
const UNSUPPORTED_GENERATION_CONFIG_FIELDS = Object.freeze([
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

const ROUTE_RE =
  /^\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent|countTokens|batchEmbedContents)$/;

/**
 * Parses `/v1beta/models/<model>:<verb>` — the exact route template the
 * pinned SDK builds (`{model}:generateContent` etc., apiVersion `v1beta`
 * by default for the non-Vertex/API-key path). `<model>` may itself
 * contain `/` (e.g. `models/local/gemma-2b`), matching `tModel()`'s
 * `models/${model}` prefixing behavior for any string not already
 * starting with `models/` or `tunedModels/`.
 */
export function parseGeminiRoute(pathname) {
  const match = ROUTE_RE.exec(pathname);
  if (!match) {
    throw new GeminiProtocolError(
      ERROR_CATEGORY.UNSUPPORTED_ROUTE,
      `unsupported route: ${pathname}`,
      404,
    );
  }
  const [, modelPath, verb] = match;
  // tModel() strips a leading "models/" for the mldev path before this
  // point in the real client, so mirror that here for clientRequestedModel.
  const clientRequestedModel = modelPath.startsWith('models/')
    ? modelPath.slice('models/'.length)
    : modelPath;
  return { clientRequestedModel, verb };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractText(content, whereForErrors) {
  if (!isPlainObject(content) || !Array.isArray(content.parts) || content.parts.length === 0) {
    throw new GeminiProtocolError(
      ERROR_CATEGORY.MALFORMED_REQUEST,
      `${whereForErrors}: expected a non-empty parts[] array`,
    );
  }
  const textFragments = [];
  for (const part of content.parts) {
    if (!isPlainObject(part)) {
      throw new GeminiProtocolError(ERROR_CATEGORY.MALFORMED_REQUEST, `${whereForErrors}: part is not an object`);
    }
    for (const field of NON_TEXT_PART_FIELDS) {
      if (part[field] !== undefined && part[field] !== null) {
        throw new GeminiProtocolError(
          ERROR_CATEGORY.UNSUPPORTED_CONTENT_PART,
          `${whereForErrors}: unsupported content part field "${field}" (text-only in this build)`,
        );
      }
    }
    if (typeof part.text !== 'string') {
      throw new GeminiProtocolError(
        ERROR_CATEGORY.UNSUPPORTED_CONTENT_PART,
        `${whereForErrors}: part has no "text" string and no other supported field`,
      );
    }
    // Multiple text parts within one Content is well-established Gemini
    // semantics (they are simple concatenation) — safe to join here.
    // Distinct Content entries (separate turns) are never merged; see
    // validateGenerateContentRequest below.
    textFragments.push(part.text);
  }
  return textFragments.join('');
}

/**
 * Validates and normalizes an inbound generateContent/streamGenerateContent
 * request body into `{ systemText, messages: [{role, text}], generation }`.
 * Throws GeminiProtocolError for anything this text-only, tool-free C1
 * adapter cannot faithfully translate — never silently drops it.
 */
export function validateGenerateContentRequest(body) {
  if (!isPlainObject(body)) {
    throw new GeminiProtocolError(ERROR_CATEGORY.MALFORMED_REQUEST, 'request body must be a JSON object');
  }
  for (const field of UNSUPPORTED_TOP_LEVEL_FIELDS) {
    if (body[field] === undefined || body[field] === null) continue;
    if (field === 'tools' && isHarmlessEmptyToolsWrapper(body[field])) {
      // The real pinned CLI always sends this wrapper (see
      // isHarmlessEmptyToolsWrapper's doc comment) even with zero built-in
      // tools registered; it offers the model no capability, so there is
      // nothing here to silently drop.
      continue;
    }
    throw new GeminiProtocolError(
      ERROR_CATEGORY.UNSUPPORTED_REQUEST,
      `unsupported request field "${field}" (tools/function-calling and cached content are out of scope in this build)`,
    );
  }
  if (!Array.isArray(body.contents) || body.contents.length === 0) {
    throw new GeminiProtocolError(ERROR_CATEGORY.MALFORMED_REQUEST, 'request must include a non-empty contents[] array');
  }

  const messages = body.contents.map((content, index) => {
    if (!isPlainObject(content) || (content.role !== 'user' && content.role !== 'model')) {
      throw new GeminiProtocolError(
        ERROR_CATEGORY.UNSUPPORTED_CONTENT_PART,
        `contents[${index}]: role must be "user" or "model" (function/tool roles are out of scope)`,
      );
    }
    return { role: content.role, text: extractText(content, `contents[${index}]`) };
  });

  let systemText;
  if (body.systemInstruction !== undefined && body.systemInstruction !== null) {
    systemText = extractText(body.systemInstruction, 'systemInstruction');
  }

  const generation = {};
  const config = isPlainObject(body.generationConfig) ? body.generationConfig : {};
  for (const field of UNSUPPORTED_GENERATION_CONFIG_FIELDS) {
    if (config[field] === undefined || config[field] === null) continue;
    if (field === 'thinkingConfig' && isHarmlessDefaultThinkingConfig(config[field])) {
      // See isHarmlessDefaultThinkingConfig's doc comment: this is the
      // unavoidable unknown-model default, not a deliberate ask.
      continue;
    }
    throw new GeminiProtocolError(
      ERROR_CATEGORY.UNSUPPORTED_GENERATION_CONFIG,
      `unsupported generationConfig field "${field}" in this build`,
    );
  }
  if (config.candidateCount !== undefined && config.candidateCount !== null && config.candidateCount !== 1) {
    throw new GeminiProtocolError(
      ERROR_CATEGORY.UNSUPPORTED_GENERATION_CONFIG,
      'generationConfig.candidateCount other than 1 is not supported in this build',
    );
  }
  const numeric = (name) => {
    const value = config[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new GeminiProtocolError(ERROR_CATEGORY.MALFORMED_REQUEST, `generationConfig.${name} must be a finite number`);
    }
    return value;
  };
  generation.temperature = numeric('temperature');
  generation.topP = numeric('topP');
  generation.topK = numeric('topK');
  generation.maxOutputTokens = numeric('maxOutputTokens');
  generation.seed = numeric('seed');
  generation.presencePenalty = numeric('presencePenalty');
  generation.frequencyPenalty = numeric('frequencyPenalty');
  if (config.stopSequences !== undefined && config.stopSequences !== null) {
    if (!Array.isArray(config.stopSequences) || config.stopSequences.some((s) => typeof s !== 'string')) {
      throw new GeminiProtocolError(ERROR_CATEGORY.MALFORMED_REQUEST, 'generationConfig.stopSequences must be a string array');
    }
    generation.stopSequences = config.stopSequences;
  }

  return { systemText, messages, generation };
}

/** Validates a countTokens request body: only `contents` is supported (pinned SDK's countTokensConfigToMldev throws client-side on systemInstruction/tools/generationConfig for this auth path). */
export function validateCountTokensRequest(body) {
  if (!isPlainObject(body)) {
    throw new GeminiProtocolError(ERROR_CATEGORY.MALFORMED_REQUEST, 'request body must be a JSON object');
  }
  for (const field of ['systemInstruction', 'tools', 'generationConfig']) {
    if (body[field] !== undefined && body[field] !== null) {
      throw new GeminiProtocolError(
        ERROR_CATEGORY.UNSUPPORTED_REQUEST,
        `countTokens does not support "${field}" (matches pinned SDK client-side restriction for this auth mode)`,
      );
    }
  }
  if (!Array.isArray(body.contents) || body.contents.length === 0) {
    throw new GeminiProtocolError(ERROR_CATEGORY.MALFORMED_REQUEST, 'request must include a non-empty contents[] array');
  }
  const messages = body.contents.map((content, index) => {
    if (!isPlainObject(content) || (content.role !== 'user' && content.role !== 'model')) {
      throw new GeminiProtocolError(
        ERROR_CATEGORY.UNSUPPORTED_CONTENT_PART,
        `contents[${index}]: role must be "user" or "model"`,
      );
    }
    return { role: content.role, text: extractText(content, `contents[${index}]`) };
  });
  return { messages };
}

// Pinned SDK FinishReason enum (packages/@google/genai 1.30.0). Only a
// reviewed subset is reachable from this adapter's mapping — see
// mapFinishReason.
export const FINISH_REASON = Object.freeze({
  UNSPECIFIED: 'FINISH_REASON_UNSPECIFIED',
  STOP: 'STOP',
  MAX_TOKENS: 'MAX_TOKENS',
  OTHER: 'OTHER',
});

/**
 * Maps a llama.cpp/OpenAI-compatible finish_reason to the pinned SDK's
 * FinishReason vocabulary. Deliberately narrow: "stop"/"length" have clear
 * equivalents; "content_filter" maps to the generic OTHER bucket (no local
 * safety-classifier concept to name more precisely); anything else
 * (including tool_calls/function_call, which should never occur since this
 * adapter never sends tools) is treated as an invalid backend response by
 * the caller, not silently mapped here.
 */
export function mapFinishReason(backendReason) {
  switch (backendReason) {
    case 'stop':
      return FINISH_REASON.STOP;
    case 'length':
      return FINISH_REASON.MAX_TOKENS;
    case 'content_filter':
      return FINISH_REASON.OTHER;
    default:
      return undefined;
  }
}

/** Builds the exact GenerateContentResponse shape the pinned SDK expects (see generateContentResponseFromMldev / candidateFromMldev). */
export function buildGenerateContentResponse({ text, finishReason, usage, backendModel }) {
  const candidate = {
    content: { role: 'model', parts: [{ text }] },
    finishReason,
    index: 0,
  };
  const response = { candidates: [candidate] };
  if (backendModel) {
    // Deliberately the REAL backend model identity, never a Gemini-branded
    // name — see the model-identity section of the C1 report. A caller
    // reading modelVersion sees the true local model that answered.
    response.modelVersion = backendModel;
  }
  if (usage) {
    response.usageMetadata = usage;
  }
  return response;
}

/** Builds one Gemini-shaped streaming chunk (same overall shape as the non-stream response — see the pinned client's per-chunk `generateContentResponseFromMldev` reuse). */
export function buildStreamChunk({ textDelta, finishReason, usage, backendModel }) {
  const candidate = {
    content: { role: 'model', parts: [{ text: textDelta }] },
    index: 0,
  };
  if (finishReason) {
    candidate.finishReason = finishReason;
  }
  const chunk = { candidates: [candidate] };
  if (backendModel) {
    chunk.modelVersion = backendModel;
  }
  if (usage) {
    chunk.usageMetadata = usage;
  }
  return chunk;
}

export function buildUsageMetadata({ promptTokens, completionTokens, totalTokens }) {
  const usage = {};
  if (typeof promptTokens === 'number') usage.promptTokenCount = promptTokens;
  if (typeof completionTokens === 'number') usage.candidatesTokenCount = completionTokens;
  if (typeof totalTokens === 'number') usage.totalTokenCount = totalTokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function buildCountTokensResponse({ totalTokens }) {
  return { totalTokens };
}

/** `{error:{code,status,message}}` — the standard Google API error envelope; the pinned client accepts any JSON body on a non-2xx response, but this is the shape real Gemini errors use. */
export function buildErrorBody(category, message, httpStatus) {
  return {
    error: {
      code: httpStatus,
      status: category,
      message,
    },
  };
}

/**
 * Encodes one Gemini-shaped SSE event exactly the way the pinned SDK's
 * `responseLineRE` (`/^\s*data: (.*)(?:\n\n|\r\r|\r\n\r\n)/`) requires:
 * a single line (no embedded newlines — JSON.stringify never emits raw
 * newlines) prefixed with "data: " and terminated by a blank line.
 */
export function encodeSseEvent(jsonValue) {
  return `data: ${JSON.stringify(jsonValue)}\n\n`;
}
