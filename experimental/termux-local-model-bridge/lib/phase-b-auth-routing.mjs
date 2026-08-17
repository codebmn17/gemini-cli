import { LOCAL_PLACEHOLDER_API_KEY } from './phase-b-recorder.mjs';

export const AUTH_ROUTING_SCHEMA_VERSION = 1;
export const PINNED_GEMINI_CLI_VERSION = '0.55.1';
export const PINNED_GEMINI_CLI_COMMIT =
  '41327e407da58aa01c409ef6685b7b5d379f295e';

export const AUTH_CANDIDATES = Object.freeze({
  USE_GEMINI: 'use-gemini',
  GATEWAY: 'gateway',
});

const AUTH_TYPES = Object.freeze({
  [AUTH_CANDIDATES.USE_GEMINI]: 'gemini-api-key',
  [AUTH_CANDIDATES.GATEWAY]: 'gateway',
});

// Values that must never flow from the parent shell or a selected .env into
// the local-only child. Keys needed by the candidate are overwritten later
// with safe literals. Empty strings intentionally count as "already set" to
// dotenv, preventing a selected .env from repopulating them.
export const MASK_TO_EMPTY_ENV_KEYS = Object.freeze([
  'ALL_PROXY',
  'CLOUD_SHELL',
  'CLOUD_SHELL_VERSION',
  'GEMINI_CLI_CUSTOM_HEADERS',
  'GEMINI_CLI_SYSTEM_DEFAULTS_PATH',
  'GEMINI_CLI_USE_COMPUTE_ADC',
  'GEMINI_DEFAULT_AUTH_TYPE',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_CLOUD_ACCESS_TOKEN',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT_ID',
  'GOOGLE_GENAI_API_VERSION',
  'GOOGLE_GENAI_USE_GCA',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_VERTEX_BASE_URL',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  'all_proxy',
  'https_proxy',
  'http_proxy',
  'no_proxy',
]);

export const FORBIDDEN_FORWARD_ARG_PREFIXES = Object.freeze([
  '--telemetry',
  '--telemetry-target',
  '--telemetry-otlp-endpoint',
  '--telemetry-otlp-protocol',
  '--telemetry-log-prompts',
  '--telemetry-outfile',
]);

function fail(message) {
  const error = new Error(message);
  error.code = 'PHASE_B_AUTH_ROUTING_BLOCKED';
  throw error;
}

function isPlainObject(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

export function validatePreflightReport(report) {
  if (!isPlainObject(report)) fail('preflight report must be an object');
  if (report.schemaVersion !== 1) {
    fail('preflight report schemaVersion must be 1');
  }
  if (report.pinnedGeminiCliVersion !== PINNED_GEMINI_CLI_VERSION) {
    fail(`preflight report must target Gemini CLI ${PINNED_GEMINI_CLI_VERSION}`);
  }
  if (!Array.isArray(report.blockers)) {
    fail('preflight report blockers must be an array');
  }
  if (report.allowed !== true || report.blockers.length !== 0) {
    fail('preflight did not allow the Phase B probe');
  }
  return true;
}

export function normalizeRecorderOrigin(input) {
  if (typeof input !== 'string' || input.length === 0) {
    fail('recorder URL must be a non-empty string');
  }

  // Avoid WHATWG URL host canonicalization accepting alternate spellings such
  // as 127.1 or integer-form IPv4. Phase B means the literal loopback address.
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(input);
  if (!match) {
    fail('recorder URL must be the literal http://127.0.0.1:PORT origin');
  }
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail('recorder URL port must be an integer from 1 through 65535');
  }

  return `http://127.0.0.1:${port}`;
}

function buildSafeEnvironment(recorderOrigin) {
  return {
    // A non-empty placeholder is deliberate for BOTH candidates. In pinned
    // 0.55.1 createContentGeneratorConfig computes geminiApiKey before its
    // gateway branch; this short-circuits any stored-key/keychain lookup.
    GEMINI_API_KEY: LOCAL_PLACEHOLDER_API_KEY,
    GOOGLE_GEMINI_BASE_URL: recorderOrigin,
    GEMINI_API_KEY_AUTH_MECHANISM: 'x-goog-api-key',

    // Environment overrides beat settings in pinned telemetry resolution.
    GEMINI_TELEMETRY_ENABLED: 'false',
    GEMINI_TELEMETRY_TRACES_ENABLED: 'false',
    GEMINI_TELEMETRY_LOG_PROMPTS: 'false',
    GEMINI_TELEMETRY_USE_COLLECTOR: 'false',
    GEMINI_TELEMETRY_USE_CLI_AUTH: 'false',
    GEMINI_TELEMETRY_TARGET: 'local',
    GEMINI_TELEMETRY_OTLP_PROTOCOL: 'http',
    GEMINI_TELEMETRY_OTLP_ENDPOINT: 'http://127.0.0.1:1',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
  };
}

function buildSettings(candidate) {
  return {
    security: {
      auth: {
        selectedType: AUTH_TYPES[candidate],
        enforcedType: AUTH_TYPES[candidate],
        useExternal: candidate === AUTH_CANDIDATES.GATEWAY,
      },
    },
    advanced: {
      // Defense in depth only. Pinned 0.55.1 can still select trusted
      // .gemini/.env files, so env masking remains mandatory.
      ignoreLocalEnv: true,
    },
    telemetry: {
      enabled: false,
      traces: false,
      logPrompts: false,
      useCollector: false,
      useCliAuth: false,
      target: 'local',
      otlpProtocol: 'http',
      otlpEndpoint: 'http://127.0.0.1:1',
    },
    privacy: {
      usageStatisticsEnabled: false,
    },
  };
}

export function buildAuthRoutingContract({
  candidate,
  recorderUrl,
  preflightReport,
}) {
  if (!Object.values(AUTH_CANDIDATES).includes(candidate)) {
    fail('unknown Phase B auth candidate');
  }
  validatePreflightReport(preflightReport);
  const recorderOrigin = normalizeRecorderOrigin(recorderUrl);

  return {
    schemaVersion: AUTH_ROUTING_SCHEMA_VERSION,
    pinnedGeminiCliVersion: PINNED_GEMINI_CLI_VERSION,
    pinnedGeminiCliCommit: PINNED_GEMINI_CLI_COMMIT,
    candidate,
    recorderOrigin,
    reviewOnly: true,
    executableLaunchImplemented: false,
    childEnvironment: {
      inheritancePolicy: 'copy-parent-then-mask-and-set',
      applicationOrder: ['copy-parent', 'maskToEmpty', 'set', 'runtimeBindings'],
      maskToEmpty: [...MASK_TO_EMPTY_ENV_KEYS],
      set: buildSafeEnvironment(recorderOrigin),
      runtimeBindings: {
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: 'isolated-settings-file-required',
      },
    },
    isolatedSettings: buildSettings(candidate),
    argvPolicy: {
      injected: [],
      forbiddenForwardPrefixes: [...FORBIDDEN_FORWARD_ARG_PREFIXES],
    },
    safetyNotes: [
      'Do not launch Gemini from this contract artifact.',
      'The runtime settings path is intentionally unresolved in this review slice.',
      'Masking is mandatory even with advanced.ignoreLocalEnv=true.',
      'Only the recorder origin may receive model API traffic during the later probe.',
    ],
  };
}
