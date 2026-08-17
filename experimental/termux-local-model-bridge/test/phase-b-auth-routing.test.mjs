import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  AUTH_CANDIDATES,
  FORBIDDEN_FORWARD_ARG_PREFIXES,
  MASK_TO_EMPTY_ENV_KEYS,
  PINNED_GEMINI_CLI_COMMIT,
  buildAuthRoutingContract,
  normalizeRecorderOrigin,
  validatePreflightReport,
} from '../lib/phase-b-auth-routing.mjs';
import { LOCAL_PLACEHOLDER_API_KEY } from '../lib/phase-b-recorder.mjs';

const GOOD_PREFLIGHT = Object.freeze({
  schemaVersion: 1,
  pinnedGeminiCliVersion: '0.55.1',
  allowed: true,
  blockers: [],
});

const EXPECTED_MASKED_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT_ID',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_ACCESS_TOKEN',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_USE_GCA',
  'GEMINI_DEFAULT_AUTH_TYPE',
  'GEMINI_CLI_CUSTOM_HEADERS',
  'GOOGLE_GENAI_API_VERSION',
  'GOOGLE_VERTEX_BASE_URL',
  'GEMINI_CLI_USE_COMPUTE_ADC',
  'CLOUD_SHELL',
];

function build(candidate = AUTH_CANDIDATES.USE_GEMINI) {
  return buildAuthRoutingContract({
    candidate,
    recorderUrl: 'http://127.0.0.1:43123',
    preflightReport: GOOD_PREFLIGHT,
  });
}

test('accepts only a strict explicit 127.0.0.1 recorder origin', () => {
  assert.equal(
    normalizeRecorderOrigin('http://127.0.0.1:43123'),
    'http://127.0.0.1:43123',
  );
  for (const value of [
    'https://127.0.0.1:43123',
    'http://localhost:43123',
    'http://127.1:43123',
    'http://2130706433:43123',
    ' http://127.0.0.1:43123',
    'http://[::1]:43123',
    'http://127.0.0.1',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://user@127.0.0.1:43123',
    'http://127.0.0.1:43123/v1',
    'http://127.0.0.1:43123/?x=1',
    'http://127.0.0.1:43123/#frag',
    'not-a-url',
  ]) {
    assert.throws(() => normalizeRecorderOrigin(value));
  }
});

test('preflight must be internally consistent, allowed, and pinned to 0.55.1', () => {
  assert.equal(validatePreflightReport(GOOD_PREFLIGHT), true);
  for (const report of [
    null,
    {},
    { ...GOOD_PREFLIGHT, schemaVersion: 2 },
    { ...GOOD_PREFLIGHT, pinnedGeminiCliVersion: '0.56.0' },
    { ...GOOD_PREFLIGHT, allowed: false },
    { ...GOOD_PREFLIGHT, blockers: ['proxy-present'] },
    { ...GOOD_PREFLIGHT, blockers: 'none' },
  ]) {
    assert.throws(() => validatePreflightReport(report));
  }
});

test('unknown candidate fails closed', () => {
  assert.throws(() =>
    buildAuthRoutingContract({
      candidate: 'oauth-personal',
      recorderUrl: 'http://127.0.0.1:43123',
      preflightReport: GOOD_PREFLIGHT,
    }),
  );
});

test('USE_GEMINI contract uses pinned auth type, non-external validation, and no launch', () => {
  const contract = build();
  assert.equal(contract.pinnedGeminiCliCommit, PINNED_GEMINI_CLI_COMMIT);
  assert.equal(contract.candidate, 'use-gemini');
  assert.equal(contract.reviewOnly, true);
  assert.equal(contract.executableLaunchImplemented, false);
  assert.deepEqual(contract.isolatedSettings.security.auth, {
    selectedType: 'gemini-api-key',
    enforcedType: 'gemini-api-key',
    useExternal: false,
  });
});

test('GATEWAY contract uses explicit gateway type and external-auth validation bypass', () => {
  const contract = build(AUTH_CANDIDATES.GATEWAY);
  assert.deepEqual(contract.isolatedSettings.security.auth, {
    selectedType: 'gateway',
    enforcedType: 'gateway',
    useExternal: true,
  });
});

test('both candidates force the same harmless placeholder and loopback base URL', () => {
  for (const candidate of Object.values(AUTH_CANDIDATES)) {
    const env = build(candidate).childEnvironment.set;
    assert.equal(env.GEMINI_API_KEY, LOCAL_PLACEHOLDER_API_KEY);
    assert.equal(env.GOOGLE_GEMINI_BASE_URL, 'http://127.0.0.1:43123');
    assert.equal(env.GEMINI_API_KEY_AUTH_MECHANISM, 'x-goog-api-key');
  }
});

test('dangerous inherited auth, cloud, custom-header, API-version, and proxy keys are masked', () => {
  const masked = new Set(MASK_TO_EMPTY_ENV_KEYS);
  for (const key of EXPECTED_MASKED_KEYS) assert.equal(masked.has(key), true, key);
});

test('candidate-owned safe keys are not simultaneously mask-to-empty', () => {
  const contract = build();
  const masked = new Set(contract.childEnvironment.maskToEmpty);
  for (const key of Object.keys(contract.childEnvironment.set)) {
    assert.equal(masked.has(key), false, key);
  }
  assert.equal(masked.has('GEMINI_CLI_SYSTEM_SETTINGS_PATH'), false);
  assert.equal(
    contract.childEnvironment.runtimeBindings.GEMINI_CLI_SYSTEM_SETTINGS_PATH,
    'isolated-settings-file-required',
  );
});

test('telemetry and usage-statistics controls are disabled with safe local fallbacks', () => {
  const contract = build();
  const env = contract.childEnvironment.set;
  assert.equal(env.GEMINI_TELEMETRY_ENABLED, 'false');
  assert.equal(env.GEMINI_TELEMETRY_TRACES_ENABLED, 'false');
  assert.equal(env.GEMINI_TELEMETRY_LOG_PROMPTS, 'false');
  assert.equal(env.GEMINI_TELEMETRY_USE_COLLECTOR, 'false');
  assert.equal(env.GEMINI_TELEMETRY_USE_CLI_AUTH, 'false');
  assert.equal(env.GEMINI_TELEMETRY_TARGET, 'local');
  assert.equal(env.GEMINI_TELEMETRY_OTLP_PROTOCOL, 'http');
  assert.equal(env.GEMINI_TELEMETRY_OTLP_ENDPOINT, 'http://127.0.0.1:1');
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://127.0.0.1:1');
  assert.equal(contract.isolatedSettings.telemetry.enabled, false);
  assert.equal(contract.isolatedSettings.privacy.usageStatisticsEnabled, false);
});

test('ignoreLocalEnv is defense in depth and dangerous env masking remains present', () => {
  const contract = build();
  assert.equal(contract.isolatedSettings.advanced.ignoreLocalEnv, true);
  assert.ok(contract.childEnvironment.maskToEmpty.includes('HTTPS_PROXY'));
  assert.ok(contract.childEnvironment.maskToEmpty.includes('GOOGLE_API_KEY'));
});

test('telemetry CLI flags are explicitly forbidden from future argument forwarding', () => {
  const contract = build();
  assert.deepEqual(
    contract.argvPolicy.forbiddenForwardPrefixes,
    [...FORBIDDEN_FORWARD_ARG_PREFIXES],
  );
  assert.ok(contract.argvPolicy.forbiddenForwardPrefixes.includes('--telemetry'));
});

test('serialized contract never includes inherited secret/proxy/path sentinel values', () => {
  const sentinelSecret = 'DO_NOT_LEAK_SECRET_4e6f';
  const sentinelProxy = 'http://proxy-user:proxy-pass@evil.invalid:9999';
  const sentinelPath = '/private/device/path/DO_NOT_LEAK';
  const pollutedPreflight = {
    ...GOOD_PREFLIGHT,
    inherited: {
      sensitive: { GEMINI_API_KEY: true },
      proxy: { HTTPS_PROXY: true },
    },
    irrelevantNestedValues: {
      secret: sentinelSecret,
      proxy: sentinelProxy,
      path: sentinelPath,
    },
  };
  const serialized = JSON.stringify(
    buildAuthRoutingContract({
      candidate: AUTH_CANDIDATES.USE_GEMINI,
      recorderUrl: 'http://127.0.0.1:43123',
      preflightReport: pollutedPreflight,
    }),
  );
  assert.equal(serialized.includes(sentinelSecret), false);
  assert.equal(serialized.includes(sentinelProxy), false);
  assert.equal(serialized.includes(sentinelPath), false);
});

test('library has no launcher/network/filesystem behavior by construction', async () => {
  const source = await fs.promises.readFile(
    new URL('../lib/phase-b-auth-routing.mjs', import.meta.url),
    'utf8',
  );
  for (const forbidden of [
    "node:child_process",
    "node:http",
    "node:https",
    "node:net",
    "node:tls",
    "node:fs",
    'spawn(',
    'fetch(',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('CLI emits a contract from a regular bounded preflight file without echoing its path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-b-auth-routing-'));
  try {
    const sentinelPathPart = 'SECRET_PATH_SENTINEL';
    const preflightPath = path.join(dir, `${sentinelPathPart}.json`);
    fs.writeFileSync(preflightPath, JSON.stringify(GOOD_PREFLIGHT));
    const cli = new URL('../bin/phase-b-auth-routing.mjs', import.meta.url);
    const result = spawnSync(
      process.execPath,
      [
        cli.pathname,
        '--candidate',
        'gateway',
        '--recorder-url',
        'http://127.0.0.1:43123',
        '--preflight-file',
        preflightPath,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.candidate, 'gateway');
    assert.equal(result.stdout.includes(sentinelPathPart), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI rejects a FIFO preflight input promptly without reading it', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-b-auth-routing-'));
  try {
    const fifoPath = path.join(dir, 'preflight.fifo');
    const mkfifo = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
    assert.equal(mkfifo.status, 0, mkfifo.stderr);
    const cli = new URL('../bin/phase-b-auth-routing.mjs', import.meta.url);
    const started = Date.now();
    const result = spawnSync(
      process.execPath,
      [
        cli.pathname,
        '--candidate',
        'use-gemini',
        '--recorder-url',
        'http://127.0.0.1:43123',
        '--preflight-file',
        fifoPath,
      ],
      { encoding: 'utf8', timeout: 1000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2);
    assert.ok(Date.now() - started < 1000);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /failed closed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI fails closed generically for blocked/malformed input without raw detail leakage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-b-auth-routing-'));
  try {
    const sentinel = 'RAW_SECRET_SHOULD_NOT_PRINT';
    const preflightPath = path.join(dir, 'preflight.json');
    fs.writeFileSync(
      preflightPath,
      JSON.stringify({ ...GOOD_PREFLIGHT, allowed: false, blockers: [sentinel] }),
    );
    const cli = new URL('../bin/phase-b-auth-routing.mjs', import.meta.url);
    const result = spawnSync(
      process.execPath,
      [
        cli.pathname,
        '--candidate',
        'use-gemini',
        '--recorder-url',
        'http://127.0.0.1:43123',
        '--preflight-file',
        preflightPath,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /failed closed/);
    assert.equal(result.stderr.includes(sentinel), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Pinned 0.55.1 packages/cli/src/config/config.ts defines these as real
// yargs flags capable of bypassing approval/trust/auth-routing regardless of
// this contract's isolatedSettings/childEnvironment: --yolo and
// --approval-mode=yolo both set ApprovalMode.YOLO (auto-approve all tools);
// --skip-trust sets process.env.GEMINI_CLI_TRUST_WORKSPACE='true', the same
// override checkPathTrust() consults first; --acp/--experimental-acp switch
// to the ACP JSON-RPC surface, whose acpSessionManager/acpRpcDispatcher
// construct AuthType directly and bypass validateAuthMethod() by a different
// mechanism than security.auth.useExternal; --policy/--admin-policy load
// additional policy files; --sandbox changes sandboxing. A future launcher
// forwarding any of these would silently invalidate this contract's safety
// argument even though isolatedSettings/childEnvironment themselves stay
// correct.
test('forbidden-forward list covers the real pinned flags capable of bypassing approval, trust, or auth routing', () => {
  const required = [
    '--yolo',
    '--approval-mode',
    '--skip-trust',
    '--acp',
    '--experimental-acp',
    '--policy',
    '--admin-policy',
    '--sandbox',
  ];
  for (const prefix of required) {
    assert.ok(
      FORBIDDEN_FORWARD_ARG_PREFIXES.includes(prefix),
      `missing forbidden prefix: ${prefix}`,
    );
  }
});

// checkPathTrust() (packages/core/src/utils/trust.ts) checks
// GEMINI_CLI_TRUST_WORKSPACE === 'true' before anything else, unconditionally
// trusting the workspace. --skip-trust (packages/cli/src/config/config.ts)
// sets exactly this variable. If the parent shell already carries a truthy
// value here (e.g. left over from a previous --skip-trust invocation), it
// must not silently make the child more trusting than the preflight verified.
test('GEMINI_CLI_TRUST_WORKSPACE is masked so an inherited truthy value cannot bypass verified trust', () => {
  assert.ok(MASK_TO_EMPTY_ENV_KEYS.includes('GEMINI_CLI_TRUST_WORKSPACE'));
});

// config.ts: `const ideMode = settings.ide?.enabled ?? false;` gates whether
// IdeClient.connect() runs at startup at all. The preflight already fails
// closed on a settings-driven ide.enabled=true, but that is an upstream
// precondition of this contract, not something this contract re-asserts on
// its own -- explicitly forcing it false here keeps the guarantee
// self-contained at the same isolated-settings precedence layer as every
// other control, rather than resting silently on the preflight never
// changing.
test('isolated settings explicitly disable ide mode as defense in depth', () => {
  for (const candidate of Object.values(AUTH_CANDIDATES)) {
    const contract = build(candidate);
    assert.equal(contract.isolatedSettings.ide.enabled, false);
  }
});
