import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  HARMLESS_PROBE_PROMPT,
  buildLaunchContract,
  resolvePinnedGeminiDistribution,
  reverifyPinnedEntrypoint,
  runPhaseBLaunchProbe,
  verifyNoPinnedGeminiEnvSource,
} from '../lib/phase-b-launch-probe.mjs';
import {
  materializePhaseBRuntime,
  cleanupPhaseBRuntime,
  verifyPhaseBRuntime,
} from '../lib/phase-b-runtime.mjs';
import {
  PINNED_GEMINI_CLI_COMMIT,
  PINNED_GEMINI_CLI_VERSION,
} from '../lib/phase-b-auth-routing.mjs';
import { LOCAL_PLACEHOLDER_API_KEY } from '../lib/phase-b-recorder.mjs';
import {
  CONTROL_ENV_KEYS,
  PROXY_ENV_KEYS,
  SENSITIVE_ENV_KEYS,
  presenceMap,
} from '../lib/phase-b-preflight.mjs';

// Builds a preflight report whose tracked inherited-environment presence
// genuinely matches parentEnv, so requireConsistentPreflightEnvironment()
// accepts it -- mirroring how a real caller must preserve the same tracked
// presence profile between preflight and launch, without recording raw values.
function buildPreflightReport(parentEnv = process.env) {
  return Object.freeze({
    schemaVersion: 1,
    pinnedGeminiCliVersion: PINNED_GEMINI_CLI_VERSION,
    allowed: true,
    blockers: [],
    inherited: {
      sensitive: presenceMap(parentEnv, SENSITIVE_ENV_KEYS),
      proxy: presenceMap(parentEnv, PROXY_ENV_KEYS),
      control: presenceMap(parentEnv, CONTROL_ENV_KEYS),
    },
  });
}

const GOOD_PREFLIGHT = buildPreflightReport();

function makeTempParent() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phase-b-launch-test-'));
}

function makeEnvBoundaryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-b-env-boundary-'));
  const runtimeRoot = path.join(root, 'runtime');
  const workingDirectory = path.join(runtimeRoot, 'cwd');
  const geminiHome = path.join(runtimeRoot, 'gemini-home');
  fs.mkdirSync(workingDirectory, { recursive: true });
  fs.mkdirSync(geminiHome, { recursive: true });
  return { root, runtimeRoot, workingDirectory, geminiHome };
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
    const parentEnv = {
      GEMINI_EXP: '/tmp/attacker-experiments.json',
      GEMINI_CLI_NO_RELAUNCH: 'false',
      HOME: '/tmp/attacker-home',
      NODE_OPTIONS: '--require /tmp/evil.js',
    };
    const report = await runPhaseBLaunchProbe({
      geminiRoot,
      preflightReport: buildPreflightReport(parentEnv),
      parentEnv,
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

// Pinned userStartupWarnings.ts's folderTrustCheck throws a fatal
// FatalUntrustedWorkspaceError for any headless invocation in an untrusted
// folder, which this isolated cwd always is. security.folderTrust.enabled is
// the narrow, source-verified fix (isFolderTrustEnabled() short-circuits the
// check), added alongside -- not instead of -- every other already-reviewed
// trust/tool/auth control. This proves the new field landed without
// loosening any of the others.
test('launch contract pins folder trust disabled alongside every other already-reviewed control', () => {
  const contract = buildLaunchContract(GOOD_PREFLIGHT, 'http://127.0.0.1:43123');

  assert.equal(contract.isolatedSettings.security.folderTrust.enabled, false);
  assert.equal(contract.isolatedSettings.general.enableAutoUpdate, false);
  assert.equal(contract.isolatedSettings.general.defaultApprovalMode, 'default');
  assert.equal(contract.isolatedSettings.security.disableYoloMode, true);
  assert.equal(contract.isolatedSettings.security.disableAlwaysAllow, true);
  assert.deepEqual(contract.isolatedSettings.tools.allowed, []);
  assert.equal(contract.isolatedSettings.ide.enabled, false);
  assert.equal(contract.isolatedSettings.advanced.ignoreLocalEnv, true);

  // The two broad bypasses this narrower fix deliberately avoids stay exactly
  // as PR #4 left them: GEMINI_CLI_TRUST_WORKSPACE still unconditionally
  // masked to empty, and --skip-trust still on the forbidden-forward list.
  assert.ok(
    contract.childEnvironment.maskToEmpty.includes('GEMINI_CLI_TRUST_WORKSPACE'),
  );
  assert.notEqual(
    contract.childEnvironment.set.GEMINI_CLI_TRUST_WORKSPACE,
    'true',
  );
  assert.equal(contract.argvPolicy.forwardCallerArgs, false);
  assert.ok(contract.argvPolicy.forbiddenForwardPrefixes.includes('--skip-trust'));
});

test('pinned Gemini local-env verifier accepts a clean isolated boundary', () => {
  const fixture = makeEnvBoundaryFixture();
  try {
    assert.equal(
      verifyNoPinnedGeminiEnvSource({
        workingDirectory: fixture.workingDirectory,
        geminiHome: fixture.geminiHome,
      }),
      true,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('pinned Gemini local-env verifier blocks working-directory .gemini/.env', () => {
  const fixture = makeEnvBoundaryFixture();
  try {
    const geminiDir = path.join(fixture.workingDirectory, '.gemini');
    fs.mkdirSync(geminiDir);
    fs.writeFileSync(path.join(geminiDir, '.env'), 'SECRET=not-read');
    assert.throws(
      () =>
        verifyNoPinnedGeminiEnvSource({
          workingDirectory: fixture.workingDirectory,
          geminiHome: fixture.geminiHome,
        }),
      /pinned Gemini local-environment source is discoverable/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('pinned Gemini local-env verifier blocks runtime-ancestor .gemini/.env', () => {
  const fixture = makeEnvBoundaryFixture();
  try {
    const geminiDir = path.join(fixture.runtimeRoot, '.gemini');
    fs.mkdirSync(geminiDir);
    fs.writeFileSync(path.join(geminiDir, '.env'), 'SECRET=not-read');
    assert.throws(
      () =>
        verifyNoPinnedGeminiEnvSource({
          workingDirectory: fixture.workingDirectory,
          geminiHome: fixture.geminiHome,
        }),
      /pinned Gemini local-environment source is discoverable/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test(
  'runPhaseBLaunchProbe blocks an ancestor .gemini/.env outside runtimeRoot before spawn',
  async () => {
  const tempParent = makeTempParent();
  const marker = path.join(tempParent, 'child-spawned.txt');
  try {
    const geminiDir = path.join(tempParent, '.gemini');
    fs.mkdirSync(geminiDir);
    fs.writeFileSync(path.join(geminiDir, '.env'), 'SECRET=not-read');
    const geminiRoot = makeDistribution(
      tempParent,
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'spawned');`,
    );

    await assert.rejects(
      runPhaseBLaunchProbe({
        geminiRoot,
        preflightReport: GOOD_PREFLIGHT,
        tempParent,
        timeoutMs: 1500,
      }),
      /pinned Gemini local-environment source is discoverable/,
    );
    assert.equal(fs.existsSync(marker), false, 'child must never spawn');
  } finally {
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
  },
);

test('pinned Gemini local-env verifier blocks isolated-home .gemini/.env fallback', () => {
  const fixture = makeEnvBoundaryFixture();
  try {
    const geminiDir = path.join(fixture.geminiHome, '.gemini');
    fs.mkdirSync(geminiDir);
    fs.writeFileSync(path.join(geminiDir, '.env'), 'SECRET=not-read');
    assert.throws(
      () =>
        verifyNoPinnedGeminiEnvSource({
          workingDirectory: fixture.workingDirectory,
          geminiHome: fixture.geminiHome,
        }),
      /pinned Gemini local-environment source is discoverable/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('pinned Gemini local-env verifier blocks isolated-home .env fallback', () => {
  const fixture = makeEnvBoundaryFixture();
  try {
    fs.writeFileSync(path.join(fixture.geminiHome, '.env'), 'SECRET=not-read');
    assert.throws(
      () =>
        verifyNoPinnedGeminiEnvSource({
          workingDirectory: fixture.workingDirectory,
          geminiHome: fixture.geminiHome,
        }),
      /pinned Gemini local-environment source is discoverable/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('pinned Gemini local-env verifier blocks a symlink candidate without following it', () => {
  const fixture = makeEnvBoundaryFixture();
  try {
    const geminiDir = path.join(fixture.workingDirectory, '.gemini');
    fs.mkdirSync(geminiDir);
    const target = path.join(fixture.root, 'dotenv-target');
    fs.writeFileSync(target, 'SECRET=not-read');
    try {
      fs.symlinkSync(target, path.join(geminiDir, '.env'));
    } catch {
      return; // symlink creation unavailable on this platform.
    }
    assert.throws(
      () =>
        verifyNoPinnedGeminiEnvSource({
          workingDirectory: fixture.workingDirectory,
          geminiHome: fixture.geminiHome,
        }),
      /pinned Gemini local-environment source is discoverable/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('pinned Gemini local-env verifier blocks a FIFO candidate without hanging', { timeout: 5000 }, () => {
  const fixture = makeEnvBoundaryFixture();
  try {
    const geminiDir = path.join(fixture.workingDirectory, '.gemini');
    fs.mkdirSync(geminiDir);
    const fifo = path.join(geminiDir, '.env');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      return; // mkfifo unavailable on this platform/filesystem.
    }
    const start = Date.now();
    assert.throws(
      () =>
        verifyNoPinnedGeminiEnvSource({
          workingDirectory: fixture.workingDirectory,
          geminiHome: fixture.geminiHome,
        }),
      /pinned Gemini local-environment source is discoverable/,
    );
    assert.ok(Date.now() - start < 2000, 'must lstat and fail without opening FIFO');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('runPhaseBLaunchProbe rejects tracked environment-presence drift after preflight', async () => {
  const staleReport = buildPreflightReport({});
  await assert.rejects(
    runPhaseBLaunchProbe({
      geminiRoot: '/nonexistent-on-purpose',
      preflightReport: staleReport,
      parentEnv: { HTTPS_PROXY: 'http://attacker-proxy.example:8080' },
    }),
    /current tracked environment presence no longer matches/,
  );
});

test('runPhaseBLaunchProbe rejects a preflight report missing the inherited-environment snapshot', async () => {
  const legacyShapedReport = Object.freeze({
    schemaVersion: 1,
    pinnedGeminiCliVersion: PINNED_GEMINI_CLI_VERSION,
    allowed: true,
    blockers: [],
  });
  await assert.rejects(
    runPhaseBLaunchProbe({
      geminiRoot: '/nonexistent-on-purpose',
      preflightReport: legacyShapedReport,
      parentEnv: {},
    }),
    /missing the inherited-environment snapshot/,
  );
});

// The launch probe's own environment-consistency check must not itself
// become a way to leak values: it may only ever compare presence booleans.
test('preflight/launch environment consistency check compares presence only, never leaks values', () => {
  const source = fs.readFileSync(
    new URL('../lib/phase-b-launch-probe.mjs', import.meta.url),
    'utf8',
  );
  const fn = source.slice(
    source.indexOf('function requireConsistentPreflightEnvironment'),
    source.indexOf('\n}\n', source.indexOf('function requireConsistentPreflightEnvironment')),
  );
  assert.ok(fn.includes('presenceMap'));
  assert.equal(/console\.(log|error)/.test(fn), false);
});

// verifyPhaseBRuntime (PR #5, unmodified here) still enforces cwd/runtime
// integrity. PR #6 then closes the pinned-v0.55.1 local-env discovery boundary
// before the final entrypoint identity re-check and spawn. This proves those
// synchronous gates remain ordered together immediately before process launch,
// while the underlying cwd-tampering protection still fails closed.
test('runtime and pinned local-env verification remain wired in before spawn', async () => {
  const source = await fs.promises.readFile(
    new URL('../lib/phase-b-launch-probe.mjs', import.meta.url),
    'utf8',
  );
  const runtimeVerifyIndex = source.indexOf('verifyPhaseBRuntime(runtime);');
  const envVerifyIndex = source.indexOf(
    'verifyNoPinnedGeminiEnvSource(runtime);',
    runtimeVerifyIndex,
  );
  const entryVerifyIndex = source.indexOf(
    'reverifyPinnedEntrypoint(distribution);',
    envVerifyIndex,
  );
  const launcherArgsIndex = source.indexOf('const launcherArgs', entryVerifyIndex);
  const spawnCallIndex = source.indexOf('child = spawn(');
  assert.ok(runtimeVerifyIndex > 0, 'verifyPhaseBRuntime must still be called');
  assert.ok(
    envVerifyIndex > runtimeVerifyIndex,
    'local-env verification must follow runtime verification',
  );
  assert.ok(
    entryVerifyIndex > envVerifyIndex,
    'entrypoint identity must be rechecked after local-env verification',
  );
  assert.ok(
    entryVerifyIndex < launcherArgsIndex && launcherArgsIndex < spawnCallIndex,
    'all final verification must happen before argv construction and spawn',
  );

  // Confirm the mechanism it depends on is still intact: a cwd contaminated
  // after materialization must still be caught before anything would spawn.
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-b-launch-cwd-check-'));
  let runtime;
  try {
    runtime = materializePhaseBRuntime({
      contract: buildLaunchContract(GOOD_PREFLIGHT, 'http://127.0.0.1:43123'),
      parentEnv: {},
      tempParent,
    });
    fs.writeFileSync(path.join(runtime.workingDirectory, 'unexpected.txt'), 'x');
    assert.throws(() => verifyPhaseBRuntime(runtime));
  } finally {
    if (runtime) cleanupPhaseBRuntime(runtime);
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
});
