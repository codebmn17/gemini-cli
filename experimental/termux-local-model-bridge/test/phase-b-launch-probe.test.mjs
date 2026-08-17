import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  HARMLESS_PROBE_PROMPT,
  resolvePinnedGeminiDistribution,
  reverifyPinnedEntrypoint,
  runPhaseBLaunchProbe,
} from '../lib/phase-b-launch-probe.mjs';
import {
  PINNED_GEMINI_CLI_COMMIT,
  PINNED_GEMINI_CLI_VERSION,
} from '../lib/phase-b-auth-routing.mjs';
import { LOCAL_PLACEHOLDER_API_KEY } from '../lib/phase-b-recorder.mjs';

const GOOD_PREFLIGHT = Object.freeze({
  schemaVersion: 1,
  pinnedGeminiCliVersion: PINNED_GEMINI_CLI_VERSION,
  allowed: true,
  blockers: [],
});

function makeTempParent() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phase-b-launch-test-'));
}

function makeDistribution(tempParent, scriptBody) {
  const root = fs.mkdtempSync(path.join(tempParent, 'gemini-dist-'));
  const bundleDir = path.join(root, 'bundle');
  fs.mkdirSync(bundleDir);
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: '@google/gemini-cli',
      version: PINNED_GEMINI_CLI_VERSION,
      bin: { gemini: 'bundle/gemini.js' },
    }),
  );
  fs.writeFileSync(path.join(bundleDir, 'gemini.js'), scriptBody);
  return root;
}

function goodFakeBundle() {
  return `
import fs from 'node:fs';
import http from 'node:http';

const expected = ${JSON.stringify([
  '--prompt',
  HARMLESS_PROBE_PROMPT,
  '--output-format',
  'json',
])};
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(21);
if (process.env.GEMINI_CLI_NO_RELAUNCH !== 'true') process.exit(22);
if (process.env.GEMINI_EXP !== '') process.exit(23);
if (process.env.GEMINI_API_KEY !== ${JSON.stringify(LOCAL_PLACEHOLDER_API_KEY)}) process.exit(24);
if (!process.env.GEMINI_CLI_HOME || process.env.HOME !== process.env.GEMINI_CLI_HOME) process.exit(25);
const settings = JSON.parse(fs.readFileSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8'));
if (settings.general?.enableAutoUpdate !== false) process.exit(26);
if (settings.general?.defaultApprovalMode !== 'default') process.exit(27);
if (settings.security?.disableYoloMode !== true || settings.security?.disableAlwaysAllow !== true) process.exit(28);
if (!Array.isArray(settings.tools?.allowed) || settings.tools.allowed.length !== 0) process.exit(29);

const origin = new URL(process.env.GOOGLE_GEMINI_BASE_URL);
const request = http.request({
  hostname: origin.hostname,
  port: Number(origin.port),
  method: 'POST',
  path: '/v1beta/models/gemini-test:streamGenerateContent?alt=sse',
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'x-goog-api-key': process.env.GEMINI_API_KEY,
  },
});
request.on('error', () => process.exit(30));
request.end(JSON.stringify({contents:[{role:'user',parts:[{text:'fixed'}]}]}));
setInterval(() => {}, 1000);
`;
}

test('synthetic pinned distribution reaches only the local recorder with fixed launcher state', async () => {
  const tempParent = makeTempParent();
  try {
    const geminiRoot = makeDistribution(tempParent, goodFakeBundle());
    const report = await runPhaseBLaunchProbe({
      geminiRoot,
      preflightReport: GOOD_PREFLIGHT,
      parentEnv: {
        GEMINI_EXP: '/tmp/attacker-experiments.json',
        GEMINI_CLI_NO_RELAUNCH: 'false',
        HOME: '/tmp/attacker-home',
        NODE_OPTIONS: '--require /tmp/evil.js',
      },
      tempParent,
      timeoutMs: 3000,
    });

    assert.equal(report.success, true);
    assert.equal(report.pinnedGeminiCliCommit, PINNED_GEMINI_CLI_COMMIT);
    assert.equal(report.request.method, 'POST');
    assert.match(report.request.path, /:streamGenerateContent$/);
    assert.equal(report.request.auth.xGoogApiKey, 'placeholder-match');
    assert.equal(report.request.auth.authorizationPresent, false);
    assert.equal(report.request.auth.privilegedUserIdPresent, false);
    assert.equal(report.launch.forwardedCallerArgs, false);
    assert.equal(report.launch.noRelaunch, true);
    assert.equal(report.launch.autoUpdateDisabled, true);
    assert.ok(report.recorderRecordCount >= 1);
  } finally {
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
});

test('rejects caller-controlled launch surface instead of silently ignoring it', async () => {
  const tempParent = makeTempParent();
  try {
    const geminiRoot = makeDistribution(tempParent, goodFakeBundle());
    await assert.rejects(
      runPhaseBLaunchProbe({
        geminiRoot,
        preflightReport: GOOD_PREFLIGHT,
        tempParent,
        callerArgs: ['--yolo'],
      }),
      /unknown launch probe option/,
    );
  } finally {
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
});

test('rejects an unreviewed Gemini package version before spawn', () => {
  const tempParent = makeTempParent();
  try {
    const geminiRoot = makeDistribution(tempParent, 'process.exit(0);');
    const manifestPath = path.join(geminiRoot, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.version = '999.0.0';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(
      () => resolvePinnedGeminiDistribution(geminiRoot),
      /version does not match/,
    );
  } finally {
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
});

test('rejects a FIFO package.json without hanging', { timeout: 5000 }, () => {
  const tempParent = makeTempParent();
  try {
    const geminiRoot = makeDistribution(tempParent, 'process.exit(0);');
    fs.unlinkSync(path.join(geminiRoot, 'package.json'));
    try {
      execFileSync('mkfifo', [path.join(geminiRoot, 'package.json')]);
    } catch {
      return; // mkfifo unavailable on this platform/filesystem; skip.
    }
    const start = Date.now();
    assert.throws(
      () => resolvePinnedGeminiDistribution(geminiRoot),
      /must be a regular file/,
    );
    assert.ok(
      Date.now() - start < 2000,
      'must fail fast, not block on the FIFO open',
    );
  } finally {
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
});

test('reverifyPinnedEntrypoint accepts an unchanged distribution and rejects a swapped one', () => {
  const tempParent = makeTempParent();
  try {
    const geminiRoot = makeDistribution(tempParent, 'process.exit(0);');
    const distribution = resolvePinnedGeminiDistribution(geminiRoot);
    assert.doesNotThrow(() => reverifyPinnedEntrypoint(distribution));

    // Simulate an entrypoint swap that happens after resolution (the window
    // between resolvePinnedGeminiDistribution's checks and the actual spawn
    // call, which child_process.spawn's path-based API cannot close outright
    // since Node has no exec-by-descriptor primitive). Written elsewhere then
    // renamed into place, the standard atomic-replace idiom and the only way
    // to reliably force a different inode: this filesystem reuses the same
    // inode for a plain unlink()-then-recreate() at the same path.
    const replacement = path.join(geminiRoot, 'swapped-content.js');
    fs.writeFileSync(replacement, '// swapped after validation');
    fs.renameSync(replacement, distribution.entrypoint);
    assert.throws(
      () => reverifyPinnedEntrypoint(distribution),
      /entrypoint identity changed before spawn/,
    );
  } finally {
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
});

test('reverifyPinnedEntrypoint rejects the entrypoint becoming a symlink after resolution', () => {
  const tempParent = makeTempParent();
  try {
    const geminiRoot = makeDistribution(tempParent, 'process.exit(0);');
    const distribution = resolvePinnedGeminiDistribution(geminiRoot);
    const target = path.join(geminiRoot, 'swapped-target.js');
    fs.renameSync(distribution.entrypoint, target);
    fs.symlinkSync(target, distribution.entrypoint);
    assert.throws(
      () => reverifyPinnedEntrypoint(distribution),
      /entrypoint changed before spawn/,
    );
  } finally {
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
});

test('rejects a symlink Gemini entrypoint', () => {
  const tempParent = makeTempParent();
  try {
    const geminiRoot = makeDistribution(tempParent, 'process.exit(0);');
    const entrypoint = path.join(geminiRoot, 'bundle', 'gemini.js');
    const target = path.join(geminiRoot, 'real.js');
    fs.renameSync(entrypoint, target);
    fs.symlinkSync(target, entrypoint);
    assert.throws(
      () => resolvePinnedGeminiDistribution(geminiRoot),
      /regular non-symlink file/,
    );
  } finally {
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
});

test('fails closed when child exits before reaching recorder', async () => {
  const tempParent = makeTempParent();
  try {
    const geminiRoot = makeDistribution(tempParent, 'process.exit(17);');
    await assert.rejects(
      runPhaseBLaunchProbe({
        geminiRoot,
        preflightReport: GOOD_PREFLIGHT,
        tempParent,
        timeoutMs: 1500,
      }),
      /exited before reaching/,
    );
  } finally {
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
});

test('times out and terminates a child that never reaches recorder', async () => {
  const tempParent = makeTempParent();
  try {
    const geminiRoot = makeDistribution(
      tempParent,
      'setInterval(() => {}, 1000);',
    );
    await assert.rejects(
      runPhaseBLaunchProbe({
        geminiRoot,
        preflightReport: GOOD_PREFLIGHT,
        tempParent,
        timeoutMs: 150,
      }),
      /timed out before reaching/,
    );
  } finally {
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
});

test('rejects bearer/Authorization routing even if a child reaches recorder', async () => {
  const tempParent = makeTempParent();
  try {
    const geminiRoot = makeDistribution(
      tempParent,
      `
import http from 'node:http';
const origin = new URL(process.env.GOOGLE_GEMINI_BASE_URL);
const req = http.request({
  hostname: origin.hostname,
  port: Number(origin.port),
  method: 'POST',
  path: '/v1beta/models/gemini-test:generateContent',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer fake',
    'x-goog-api-key': process.env.GEMINI_API_KEY,
  },
});
req.end('{}');
setInterval(() => {}, 1000);
`,
    );
    await assert.rejects(
      runPhaseBLaunchProbe({
        geminiRoot,
        preflightReport: GOOD_PREFLIGHT,
        tempParent,
        timeoutMs: 1500,
      }),
      /unexpectedly contained Authorization/,
    );
  } finally {
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
});

test('launch source introduces process spawn but no network client capability', async () => {
  const source = await fs.promises.readFile(
    new URL('../lib/phase-b-launch-probe.mjs', import.meta.url),
    'utf8',
  );
  assert.equal(source.includes("from 'node:child_process'"), true);
  assert.equal(source.includes('spawn('), true);
  for (const forbidden of [
    "from 'node:http'",
    "from 'node:https'",
    "from 'node:net'",
    "from 'node:tls'",
    'fetch(',
    'XMLHttpRequest',
    'WebSocket',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
