import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AUTH_CANDIDATES,
  AUTH_ROUTING_SCHEMA_VERSION,
  PINNED_GEMINI_CLI_COMMIT,
  PINNED_GEMINI_CLI_VERSION,
  normalizeRecorderOrigin,
} from './phase-b-auth-routing.mjs';

export const PHASE_B_RUNTIME_SCHEMA_VERSION = 1;
const RUNTIME_PREFIX = 'gemini-local-phase-b-';
const ACTIVE_RUNTIMES = new WeakMap();

function fail(message) {
  const error = new Error(message);
  error.code = 'PHASE_B_RUNTIME_BLOCKED';
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

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be a plain object`);
  return value;
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(`${label} must be an array of strings`);
  }
  if (new Set(value).size !== value.length) {
    fail(`${label} must not contain duplicates`);
  }
  return value;
}

function requireStringRecord(value, label) {
  requirePlainObject(value, label);
  for (const [key, item] of Object.entries(value)) {
    if (key.length === 0 || typeof item !== 'string') {
      fail(`${label} must contain only non-empty string keys and string values`);
    }
  }
  return value;
}

function arraysEqual(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function validateAuthRoutingContractForRuntime(contract) {
  requirePlainObject(contract, 'auth-routing contract');

  if (contract.schemaVersion !== AUTH_ROUTING_SCHEMA_VERSION) {
    fail('auth-routing contract schemaVersion mismatch');
  }
  if (contract.pinnedGeminiCliVersion !== PINNED_GEMINI_CLI_VERSION) {
    fail('auth-routing contract Gemini CLI version mismatch');
  }
  if (contract.pinnedGeminiCliCommit !== PINNED_GEMINI_CLI_COMMIT) {
    fail('auth-routing contract Gemini CLI commit mismatch');
  }
  if (!Object.values(AUTH_CANDIDATES).includes(contract.candidate)) {
    fail('auth-routing contract candidate is invalid');
  }
  if (contract.reviewOnly !== true || contract.executableLaunchImplemented !== false) {
    fail('auth-routing contract is not a reviewed non-launch artifact');
  }
  if (normalizeRecorderOrigin(contract.recorderOrigin) !== contract.recorderOrigin) {
    fail('auth-routing contract recorder origin is not canonical loopback');
  }

  const childEnvironment = requirePlainObject(
    contract.childEnvironment,
    'childEnvironment',
  );
  if (childEnvironment.inheritancePolicy !== 'copy-parent-then-mask-and-set') {
    fail('childEnvironment inheritance policy mismatch');
  }
  const expectedOrder = ['copy-parent', 'maskToEmpty', 'set', 'runtimeBindings'];
  if (!arraysEqual(childEnvironment.applicationOrder, expectedOrder)) {
    fail('childEnvironment application order mismatch');
  }
  const maskToEmpty = requireStringArray(
    childEnvironment.maskToEmpty,
    'childEnvironment.maskToEmpty',
  );
  const setValues = requireStringRecord(childEnvironment.set, 'childEnvironment.set');
  const runtimeBindings = requireStringRecord(
    childEnvironment.runtimeBindings,
    'childEnvironment.runtimeBindings',
  );
  if (runtimeBindings.GEMINI_CLI_HOME !== 'isolated-gemini-home-required') {
    fail('GEMINI_CLI_HOME runtime binding is missing');
  }
  if (
    runtimeBindings.GEMINI_CLI_SYSTEM_SETTINGS_PATH !==
    'isolated-settings-file-required'
  ) {
    fail('system-settings runtime binding is missing');
  }

  const masked = new Set(maskToEmpty);
  for (const key of Object.keys(setValues)) {
    if (masked.has(key)) fail(`set key is also masked: ${key}`);
  }
  for (const key of Object.keys(runtimeBindings)) {
    if (masked.has(key) || Object.hasOwn(setValues, key)) {
      fail(`runtime binding overlaps another environment layer: ${key}`);
    }
  }

  const settings = requirePlainObject(contract.isolatedSettings, 'isolatedSettings');
  if (settings.general?.defaultApprovalMode !== 'default') {
    fail('default approval mode is not pinned to default');
  }
  if (
    settings.security?.disableYoloMode !== true ||
    settings.security?.disableAlwaysAllow !== true
  ) {
    fail('hard approval-disable settings are missing');
  }
  if (!Array.isArray(settings.tools?.allowed) || settings.tools.allowed.length !== 0) {
    fail('tools.allowed must be an empty array');
  }
  if (settings.ide?.enabled !== false) fail('IDE mode must be disabled');
  if (settings.advanced?.ignoreLocalEnv !== true) {
    fail('ignoreLocalEnv must be enabled');
  }
  if (
    settings.telemetry?.enabled !== false ||
    settings.telemetry?.traces !== false ||
    settings.telemetry?.logPrompts !== false ||
    settings.telemetry?.useCollector !== false ||
    settings.telemetry?.useCliAuth !== false ||
    settings.privacy?.usageStatisticsEnabled !== false
  ) {
    fail('telemetry/privacy controls are not fully disabled');
  }

  const auth = requirePlainObject(settings.security?.auth, 'isolatedSettings.security.auth');
  if (auth.selectedType !== auth.enforcedType) {
    fail('selectedType and enforcedType must match');
  }
  if (
    contract.candidate === AUTH_CANDIDATES.USE_GEMINI &&
    (auth.selectedType !== 'gemini-api-key' || auth.useExternal !== false)
  ) {
    fail('USE_GEMINI auth settings mismatch');
  }
  if (
    contract.candidate === AUTH_CANDIDATES.GATEWAY &&
    (auth.selectedType !== 'gateway' || auth.useExternal !== true)
  ) {
    fail('GATEWAY auth settings mismatch');
  }

  const argvPolicy = requirePlainObject(contract.argvPolicy, 'argvPolicy');
  if (
    argvPolicy.mode !== 'launcher-owned-only' ||
    argvPolicy.forwardCallerArgs !== false ||
    !Array.isArray(argvPolicy.injected) ||
    argvPolicy.injected.length !== 0
  ) {
    fail('argv policy is not closed-world');
  }

  const isolation = requirePlainObject(contract.runtimeIsolation, 'runtimeIsolation');
  if (
    isolation.runtimeRoot !== 'fresh-private-temporary-directory-required' ||
    isolation.geminiHome !==
      'fresh-private-directory-under-runtime-root-required' ||
    isolation.workingDirectory !==
      'fresh-private-empty-directory-under-runtime-root-required' ||
    isolation.systemSettingsFile !==
      'fresh-regular-file-under-runtime-root-required' ||
    isolation.rejectPreexistingRuntimePaths !== true ||
    isolation.rejectSymlinkRuntimePaths !== true ||
    isolation.cleanupRequired !== true ||
    isolation.nativeSystemPolicyHandling !== 'deferred-before-tools-slice'
  ) {
    fail('runtime-isolation contract mismatch');
  }

  return true;
}

function resolveSafeTempParent(tempParent) {
  if (typeof tempParent !== 'string' || tempParent.length === 0) {
    fail('temporary parent must be a non-empty path');
  }
  const resolved = fs.realpathSync(tempParent);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('temporary parent must resolve to a real directory');
  }
  return resolved;
}

function verifyPrivateDirectory(directoryPath) {
  fs.chmodSync(directoryPath, 0o700);
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('runtime directory is not a real directory');
  }
}

function createPrivateDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { mode: 0o700 });
  verifyPrivateDirectory(directoryPath);
}

function writePrivateSettings(settingsPath, settings) {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(
    settingsPath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      noFollow,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(settingsPath, 0o600);
  const stat = fs.lstatSync(settingsPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('isolated settings path is not a regular file');
  }
}

function buildChildEnvironment(contract, parentEnv, runtimeBindings) {
  requirePlainObject(parentEnv, 'parent environment');
  const child = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (typeof value === 'string') child[key] = value;
  }
  for (const key of contract.childEnvironment.maskToEmpty) child[key] = '';
  Object.assign(child, contract.childEnvironment.set);
  Object.assign(child, runtimeBindings);
  return child;
}

function removeRuntimeRoot(runtimeRoot) {
  try {
    const stat = fs.lstatSync(runtimeRoot);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(runtimeRoot);
      return;
    }
    fs.rmSync(runtimeRoot, { recursive: true, force: false });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function materializePhaseBRuntime({
  contract,
  parentEnv = process.env,
  tempParent = os.tmpdir(),
} = {}) {
  validateAuthRoutingContractForRuntime(contract);
  const safeTempParent = resolveSafeTempParent(tempParent);

  let runtimeRoot;
  try {
    runtimeRoot = fs.mkdtempSync(path.join(safeTempParent, RUNTIME_PREFIX));
    verifyPrivateDirectory(runtimeRoot);

    const geminiHome = path.join(runtimeRoot, 'gemini-home');
    const workingDirectory = path.join(runtimeRoot, 'cwd');
    const systemSettingsFile = path.join(runtimeRoot, 'system-settings.json');

    createPrivateDirectory(geminiHome);
    createPrivateDirectory(workingDirectory);
    writePrivateSettings(systemSettingsFile, contract.isolatedSettings);

    const childEnvironment = buildChildEnvironment(contract, parentEnv, {
      GEMINI_CLI_HOME: geminiHome,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemSettingsFile,
    });

    const runtime = Object.freeze({
      schemaVersion: PHASE_B_RUNTIME_SCHEMA_VERSION,
      runtimeRoot,
      geminiHome,
      workingDirectory,
      systemSettingsFile,
      childEnvironment: Object.freeze(childEnvironment),
      launcherArgs: Object.freeze([]),
      executableLaunchImplemented: false,
    });
    ACTIVE_RUNTIMES.set(runtime, runtimeRoot);
    return runtime;
  } catch (error) {
    if (runtimeRoot) {
      try {
        removeRuntimeRoot(runtimeRoot);
      } catch {
        // Preserve the original fail-closed error; cleanup is best effort here.
      }
    }
    throw error;
  }
}

export function cleanupPhaseBRuntime(runtime) {
  if (!isPlainObject(runtime) && !Object.isFrozen(runtime)) {
    fail('runtime handle is invalid');
  }
  const runtimeRoot = ACTIVE_RUNTIMES.get(runtime);
  if (!runtimeRoot) fail('runtime handle is unknown or already cleaned');
  removeRuntimeRoot(runtimeRoot);
  ACTIVE_RUNTIMES.delete(runtime);
}
