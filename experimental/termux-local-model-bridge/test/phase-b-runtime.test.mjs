import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AUTH_CANDIDATES,
  buildAuthRoutingContract,
} from '../lib/phase-b-auth-routing.mjs';
import {
  cleanupPhaseBRuntime,
  materializePhaseBRuntime,
  validateAuthRoutingContractForRuntime,
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
