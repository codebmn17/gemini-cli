import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  AUTH_CANDIDATES,
  buildAuthRoutingContract,
} from '../lib/phase-b-auth-routing.mjs';
import {
  GENERIC_RUNTIME_MASK_KEYS,
  GENERIC_RUNTIME_MASK_PREFIXES,
  cleanupPhaseBRuntime,
  materializePhaseBRuntime,
  validateAuthRoutingContractForRuntime,
  verifyPhaseBRuntime,
} from '../lib/phase-b-runtime.mjs';
import { LOCAL_PLACEHOLDER_API_KEY } from '../lib/phase-b-recorder.mjs';

const GOOD_PREFLIGHT = Object.freeze({
  schemaVersion: 1,
  pinnedGeminiCliVersion: '0.55.1',
  allowed: true,
  blockers: [],
});

function buildContract(candidate = AUTH_CANDIDATES.USE_GEMINI) {
  return buildAuthRoutingContract({
    candidate,
    recorderUrl: 'http://127.0.0.1:43123',
    preflightReport: GOOD_PREFLIGHT,
  });
}

function makeTempParent() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phase-b-runtime-test-'));
}

function modeBits(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

test('accepts both reviewed auth-routing candidates and rejects approval-policy tampering', () => {
  assert.equal(validateAuthRoutingContractForRuntime(buildContract()), true);
  assert.equal(
    validateAuthRoutingContractForRuntime(buildContract(AUTH_CANDIDATES.GATEWAY)),
    true,
  );

  const tampered = structuredClone(buildContract());
  tampered.argvPolicy.forwardCallerArgs = true;
  assert.throws(() => validateAuthRoutingContractForRuntime(tampered));

  const autoEdit = structuredClone(buildContract());
  autoEdit.isolatedSettings.general.defaultApprovalMode = 'auto_edit';
  assert.throws(() => validateAuthRoutingContractForRuntime(autoEdit));

  const allowedTool = structuredClone(buildContract());
  allowedTool.isolatedSettings.tools.allowed = ['run_shell_command(git)'];
  assert.throws(() => validateAuthRoutingContractForRuntime(allowedTool));
});

test('rejects tampering with the recorder endpoint, placeholder key, mask set, or runtime bindings', () => {
  const externalBaseUrl = structuredClone(buildContract());
  externalBaseUrl.childEnvironment.set.GOOGLE_GEMINI_BASE_URL =
    'https://generativelanguage.googleapis.com';
  assert.throws(() => validateAuthRoutingContractForRuntime(externalBaseUrl));

  const realKey = structuredClone(buildContract());
  realKey.childEnvironment.set.GEMINI_API_KEY = 'REAL_KEY_MUST_NEVER_FLOW';
  assert.throws(() => validateAuthRoutingContractForRuntime(realKey));

  const missingMask = structuredClone(buildContract());
  missingMask.childEnvironment.maskToEmpty = missingMask.childEnvironment.maskToEmpty.filter(
    (key) => key !== 'GOOGLE_API_KEY',
  );
  assert.throws(() => validateAuthRoutingContractForRuntime(missingMask));

  const extraBinding = structuredClone(buildContract());
  extraBinding.childEnvironment.runtimeBindings.HOME = '/real/home';
  assert.throws(() => validateAuthRoutingContractForRuntime(extraBinding));
});

test('materializes a fresh private runtime with empty cwd and exact isolated settings', () => {
  const tempParent = makeTempParent();
  let runtime;
  try {
    const contract = buildContract();
    runtime = materializePhaseBRuntime({
      contract,
      parentEnv: {},
      tempParent,
    });

    assert.equal(fs.lstatSync(runtime.runtimeRoot).isDirectory(), true);
    assert.equal(fs.lstatSync(runtime.runtimeRoot).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(runtime.geminiHome).isDirectory(), true);
    assert.equal(fs.lstatSync(runtime.geminiHome).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(runtime.workingDirectory).isDirectory(), true);
    assert.equal(fs.lstatSync(runtime.workingDirectory).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(runtime.systemSettingsFile).isFile(), true);
    assert.equal(fs.lstatSync(runtime.systemSettingsFile).isSymbolicLink(), false);
    assert.deepEqual(fs.readdirSync(runtime.workingDirectory), []);

    const writtenSettings = JSON.parse(
      fs.readFileSync(runtime.systemSettingsFile, 'utf8'),
    );
    assert.deepEqual(writtenSettings, contract.isolatedSettings);
    assert.equal(verifyPhaseBRuntime(runtime), true);

    if (process.platform !== 'win32') {
      assert.equal(modeBits(runtime.runtimeRoot), 0o700);
      assert.equal(modeBits(runtime.geminiHome), 0o700);
      assert.equal(modeBits(runtime.workingDirectory), 0o700);
      assert.equal(modeBits(runtime.systemSettingsFile), 0o600);
    }
  } finally {
    if (runtime) cleanupPhaseBRuntime(runtime);
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
});

test('default materialization accepts Node process.env rather than requiring a plain object prototype', () => {
  const tempParent = makeTempParent();
  let runtime;
  try {
    assert.notEqual(Object.getPrototypeOf(process.env), Object.prototype);
    runtime = materializePhaseBRuntime({
      contract: buildContract(),
      tempParent,
    });
    assert.equal(runtime.childEnvironment.GEMINI_API_KEY, LOCAL_PLACEHOLDER_API_KEY);
    assert.equal(runtime.childEnvironment.GEMINI_CLI_HOME, runtime.geminiHome);
    assert.equal(verifyPhaseBRuntime(runtime), true);
  } finally {
    if (runtime) cleanupPhaseBRuntime(runtime);
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
});

test('builds child environment in copy-mask-set-runtime order without mutating parent', () => {
  const tempParent = makeTempParent();
  let runtime;
  try {
    const parentEnv = {
      KEEP_ME: 'kept',
      GEMINI_API_KEY: 'REAL_SECRET_MUST_NOT_SURVIVE',
      GOOGLE_API_KEY: 'ANOTHER_REAL_SECRET',
      HTTPS_PROXY: 'http://user:pass@evil.invalid:9999',
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
      GEMINI_CLI_HOME: '/real/user/home',
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/real/system/settings.json',
    };
    const originalParent = structuredClone(parentEnv);

    runtime = materializePhaseBRuntime({
      contract: buildContract(),
      parentEnv,
      tempParent,
    });

    assert.deepEqual(parentEnv, originalParent);
    assert.equal(Object.getPrototypeOf(runtime.childEnvironment), null);
    assert.equal(runtime.childEnvironment.KEEP_ME, 'kept');
    assert.equal(runtime.childEnvironment.GOOGLE_API_KEY, '');
    assert.equal(runtime.childEnvironment.HTTPS_PROXY, '');
    assert.equal(runtime.childEnvironment.GEMINI_CLI_TRUST_WORKSPACE, '');
    assert.equal(
      runtime.childEnvironment.GEMINI_API_KEY,
      LOCAL_PLACEHOLDER_API_KEY,
    );
    assert.equal(
      runtime.childEnvironment.GOOGLE_GEMINI_BASE_URL,
      'http://127.0.0.1:43123',
    );
    assert.equal(runtime.childEnvironment.GEMINI_CLI_HOME, runtime.geminiHome);
    assert.equal(
      runtime.childEnvironment.GEMINI_CLI_SYSTEM_SETTINGS_PATH,
      runtime.systemSettingsFile,
    );
    assert.notEqual(runtime.childEnvironment.GEMINI_CLI_HOME, '/real/user/home');
    assert.notEqual(
      runtime.childEnvironment.GEMINI_CLI_SYSTEM_SETTINGS_PATH,
      '/real/system/settings.json',
    );
  } finally {
    if (runtime) cleanupPhaseBRuntime(runtime);
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
});

test('integrity recheck rejects cwd contamination and settings-file replacement', () => {
  const tempParent = makeTempParent();
  let runtime;
  try {
    runtime = materializePhaseBRuntime({
      contract: buildContract(),
      parentEnv: {},
      tempParent,
    });

    const unexpected = path.join(runtime.workingDirectory, 'unexpected.txt');
    fs.writeFileSync(unexpected, 'not empty');
    assert.throws(() => verifyPhaseBRuntime(runtime));
    fs.unlinkSync(unexpected);
    assert.equal(verifyPhaseBRuntime(runtime), true);

    const settingsText = fs.readFileSync(runtime.systemSettingsFile, 'utf8');
    fs.unlinkSync(runtime.systemSettingsFile);
    fs.writeFileSync(runtime.systemSettingsFile, settingsText, { mode: 0o600 });
    assert.throws(() => verifyPhaseBRuntime(runtime));
  } finally {
    if (runtime) cleanupPhaseBRuntime(runtime);
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
});

test('runtime remains non-launching with zero forwarded or injected arguments', () => {
  const tempParent = makeTempParent();
  let runtime;
  try {
    runtime = materializePhaseBRuntime({
      contract: buildContract(AUTH_CANDIDATES.GATEWAY),
      parentEnv: {},
      tempParent,
    });
    assert.equal(runtime.executableLaunchImplemented, false);
    assert.deepEqual(runtime.launcherArgs, []);
  } finally {
    if (runtime) cleanupPhaseBRuntime(runtime);
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
});

test('cleanup removes only a runtime handle issued by this module and cannot be replayed', () => {
  const tempParent = makeTempParent();
  try {
    const runtime = materializePhaseBRuntime({
      contract: buildContract(),
      parentEnv: {},
      tempParent,
    });
    const runtimeRoot = runtime.runtimeRoot;
    assert.equal(fs.existsSync(runtimeRoot), true);
    cleanupPhaseBRuntime(runtime);
    assert.equal(fs.existsSync(runtimeRoot), false);
    assert.throws(() => cleanupPhaseBRuntime(runtime));
    assert.throws(() =>
      cleanupPhaseBRuntime(
        Object.freeze({ runtimeRoot: path.join(tempParent, 'not-a-runtime') }),
      ),
    );
  } finally {
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
});

test('invalid contract fails before creating runtime filesystem state', () => {
  const tempParent = makeTempParent();
  try {
    const contract = structuredClone(buildContract());
    contract.runtimeIsolation.rejectSymlinkRuntimePaths = false;
    assert.deepEqual(fs.readdirSync(tempParent), []);
    assert.throws(() =>
      materializePhaseBRuntime({ contract, parentEnv: {}, tempParent }),
    );
    assert.deepEqual(fs.readdirSync(tempParent), []);
  } finally {
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
});

test('runtime source contains filesystem materialization but no process or network execution surface', async () => {
  const source = await fs.promises.readFile(
    new URL('../lib/phase-b-runtime.mjs', import.meta.url),
    'utf8',
  );
  for (const forbidden of [
    'node:child_process',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'spawn(',
    'exec(',
    'fetch(',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.equal(source.includes("from 'node:fs'"), true);
});

// Node/OS-runtime variables interpreted before any Gemini application code
// runs: NODE_OPTIONS can `--require` arbitrary code into the process,
// LD_PRELOAD/DYLD_INSERT_LIBRARIES force a shared library into it, and
// HOME/XDG_*/NODE_EXTRA_CA_CERTS/SSL_CERT_* redirect config, cache, or TLS
// trust. None of these are in the auth-routing contract's maskToEmpty list
// (which only covers Gemini/API/proxy-specific keys), so the runtime module
// must mask them itself as a second, contract-independent layer -- this is
// what a real materialized childEnvironment would hand to a future spawn.
test('masks generic Node/OS runtime-injection variables independently of the contract mask list', () => {
  const tempParent = makeTempParent();
  let runtime;
  try {
    const maliciousParentEnv = {
      NODE_OPTIONS: '--require /tmp/evil-preload.js',
      NODE_PATH: '/tmp/attacker-node-modules',
      LD_PRELOAD: '/tmp/evil.so',
      LD_LIBRARY_PATH: '/tmp/attacker-libs',
      LD_AUDIT: '/tmp/attacker-audit.so',
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
      DYLD_LIBRARY_PATH: '/tmp/attacker-libs-mac',
      DYLD_FALLBACK_LIBRARY_PATH: '/tmp/attacker-fallback-libs',
      HOME: '/tmp/attacker-controlled-home',
      XDG_CONFIG_HOME: '/tmp/attacker-xdg-config',
      XDG_DATA_HOME: '/tmp/attacker-xdg-data',
      XDG_CACHE_HOME: '/tmp/attacker-xdg-cache',
      XDG_STATE_HOME: '/tmp/attacker-xdg-state',
      XDG_RUNTIME_DIR: '/tmp/attacker-xdg-runtime',
      NODE_EXTRA_CA_CERTS: '/tmp/attacker-ca.pem',
      SSL_CERT_FILE: '/tmp/attacker-ssl-cert-file.pem',
      SSL_CERT_DIR: '/tmp/attacker-ssl-cert-dir',
      KEEP_ME: 'kept',
    };

    runtime = materializePhaseBRuntime({
      contract: buildContract(),
      parentEnv: maliciousParentEnv,
      tempParent,
    });

    for (const key of Object.keys(maliciousParentEnv)) {
      if (key === 'KEEP_ME') continue;
      assert.equal(runtime.childEnvironment[key], '', key);
    }
    assert.equal(runtime.childEnvironment.KEEP_ME, 'kept');
  } finally {
    if (runtime) cleanupPhaseBRuntime(runtime);
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
});

test('generic runtime mask keys and prefixes are exported and cover the named injection surfaces', () => {
  for (const key of [
    'HOME',
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_STATE_HOME',
  ]) {
    assert.ok(GENERIC_RUNTIME_MASK_KEYS.includes(key), key);
  }
  assert.ok(GENERIC_RUNTIME_MASK_PREFIXES.includes('LD_'));
  assert.ok(GENERIC_RUNTIME_MASK_PREFIXES.includes('DYLD_'));
});

// Directory creation now opens the new directory (O_NOFOLLOW|O_DIRECTORY) and
// chmods/stats that descriptor rather than the path, closing the window
// between mkdtempSync/mkdirSync and a path-based chmodSync+lstatSync where
// the path could be swapped. This test covers the complementary, always-
// testable half: that a runtime root swapped for a symlink *after*
// materialization is still caught, extending symlink-attack coverage to the
// runtime root itself (previously only cwd-contamination and settings-file
// replacement were covered here).
test('integrity recheck rejects a runtime root swapped for a symlink after materialization', () => {
  const tempParent = makeTempParent();
  let runtime;
  try {
    runtime = materializePhaseBRuntime({
      contract: buildContract(),
      parentEnv: {},
      tempParent,
    });
    assert.equal(verifyPhaseBRuntime(runtime), true);

    const decoy = path.join(tempParent, 'decoy-target');
    fs.mkdirSync(decoy, { mode: 0o700 });
    fs.rmSync(runtime.runtimeRoot, { recursive: true, force: true });
    fs.symlinkSync(decoy, runtime.runtimeRoot);

    assert.throws(() => verifyPhaseBRuntime(runtime));

    fs.unlinkSync(runtime.runtimeRoot);
    fs.rmSync(decoy, { recursive: true, force: true });
    runtime = null;
  } finally {
    if (runtime) cleanupPhaseBRuntime(runtime);
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
});

// Reproduces a failed directory removal (via chattr +i, which this sandbox
// enforces even for root) to prove cleanup no longer leaves the handle
// "active" after fs.closeSync has already succeeded. Before the fix, a retry
// found the stale handle still registered and called fs.closeSync again on
// an already-closed descriptor number -- confusing at best (EBADF) and
// unsafe at worst (silently closing an unrelated fd if the number had been
// reused elsewhere in the process). Skips cleanly where chattr/immutable
// attributes aren't available so this stays portable across CI filesystems.
test('a failed cleanup still deregisters the handle so a retry fails cleanly instead of double-closing', (t) => {
  if (process.platform !== 'linux') {
    t.skip('chattr immutable-attribute test is Linux-specific');
    return;
  }
  const tempParent = makeTempParent();
  let runtime;
  let madeImmutable = false;
  try {
    runtime = materializePhaseBRuntime({
      contract: buildContract(),
      parentEnv: {},
      tempParent,
    });
    try {
      execFileSync('chattr', ['+i', runtime.systemSettingsFile], {
        stdio: 'pipe',
      });
      madeImmutable = true;
    } catch {
      t.skip('chattr +i unsupported on this filesystem');
      return;
    }

    assert.throws(() => cleanupPhaseBRuntime(runtime));
    let secondError;
    try {
      cleanupPhaseBRuntime(runtime);
    } catch (e) {
      secondError = e;
    }
    assert.ok(secondError, 'retry must still throw');
    assert.equal(secondError.code, 'PHASE_B_RUNTIME_BLOCKED');
    assert.match(secondError.message, /unknown or already cleaned/);
  } finally {
    if (madeImmutable) {
      try {
        execFileSync('chattr', ['-i', runtime.systemSettingsFile], {
          stdio: 'pipe',
        });
      } catch {
        // best effort so the finally below can still remove the tree
      }
    }
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
});
