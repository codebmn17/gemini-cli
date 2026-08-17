import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AUTH_CANDIDATES,
  AUTH_ROUTING_SCHEMA_VERSION,
  MASK_TO_EMPTY_ENV_KEYS,
  PINNED_GEMINI_CLI_COMMIT,
  PINNED_GEMINI_CLI_VERSION,
  normalizeRecorderOrigin,
} from './phase-b-auth-routing.mjs';
import { LOCAL_PLACEHOLDER_API_KEY } from './phase-b-recorder.mjs';

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

function requireEnvironmentRecord(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be an environment-like object`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (
      key.length === 0 ||
      (typeof item !== 'string' && item !== undefined)
    ) {
      fail(`${label} must contain only string or undefined values`);
    }
  }
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

function stringRecordsEqual(actual, expected) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    arraysEqual(actualKeys, expectedKeys) &&
    expectedKeys.every((key) => actual[key] === expected[key])
  );
}

function expectedSafeEnvironment(recorderOrigin) {
  return {
    GEMINI_API_KEY: LOCAL_PLACEHOLDER_API_KEY,
    GOOGLE_GEMINI_BASE_URL: recorderOrigin,
    GEMINI_API_KEY_AUTH_MECHANISM: 'x-goog-api-key',
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
  if (!arraysEqual(maskToEmpty, [...MASK_TO_EMPTY_ENV_KEYS])) {
    fail('childEnvironment mask set does not match the reviewed contract');
  }
  const setValues = requireStringRecord(childEnvironment.set, 'childEnvironment.set');
  if (!stringRecordsEqual(setValues, expectedSafeEnvironment(contract.recorderOrigin))) {
    fail('childEnvironment safe literals do not match the reviewed contract');
  }
  const runtimeBindings = requireStringRecord(
    childEnvironment.runtimeBindings,
    'childEnvironment.runtimeBindings',
  );
  if (
    !stringRecordsEqual(runtimeBindings, {
      GEMINI_CLI_HOME: 'isolated-gemini-home-required',
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: 'isolated-settings-file-required',
    })
  ) {
    fail('runtime bindings do not match the reviewed contract');
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

function requirePrivateMode(stat, label) {
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    fail(`${label} permissions are not private`);
  }
}

function verifyPrivateDirectory(directoryPath) {
  fs.chmodSync(directoryPath, 0o700);
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('runtime directory is not a real directory');
  }
  requirePrivateMode(stat, 'runtime directory');
  return stat;
}

function createPrivateDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { mode: 0o700 });
  return verifyPrivateDirectory(directoryPath);
}

function settingsText(settings) {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function writePrivateSettings(settingsPath, settings) {
  const expectedText = settingsText(settings);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(
    settingsPath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      noFollow,
    0o600,
  );
  let keepOpen = false;
  try {
    fs.writeFileSync(descriptor, expectedText, 'utf8');
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o600);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) fail('isolated settings descriptor is not a regular file');
    requirePrivateMode(stat, 'isolated settings file');
    const pathStat = fs.lstatSync(settingsPath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      fail('isolated settings path is not a regular file');
    }
    if (pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
      fail('isolated settings path does not match its open descriptor');
    }
    keepOpen = true;
    return { descriptor, stat, expectedText };
  } finally {
    if (!keepOpen) fs.closeSync(descriptor);
  }
}

function identity(stat) {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(stat, expected) {
  return stat.dev === expected.dev && stat.ino === expected.ino;
}

function buildChildEnvironment(contract, parentEnv, runtimeBindings) {
  requireEnvironmentRecord(parentEnv, 'parent environment');
  const child = Object.create(null);
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

function requireActiveRuntime(runtime) {
  if (!isPlainObject(runtime) || !Object.isFrozen(runtime)) {
    fail('runtime handle is invalid');
  }
  const metadata = ACTIVE_RUNTIMES.get(runtime);
  if (!metadata) fail('runtime handle is unknown or already cleaned');
  return metadata;
}

export function materializePhaseBRuntime({
  contract,
  parentEnv = process.env,
  tempParent = os.tmpdir(),
} = {}) {
  validateAuthRoutingContractForRuntime(contract);
  const safeTempParent = resolveSafeTempParent(tempParent);

  let runtimeRoot;
  let settingsDescriptor;
  let runtime;
  try {
    runtimeRoot = fs.mkdtempSync(path.join(safeTempParent, RUNTIME_PREFIX));
    const runtimeRootStat = verifyPrivateDirectory(runtimeRoot);

    const geminiHome = path.join(runtimeRoot, 'gemini-home');
    const workingDirectory = path.join(runtimeRoot, 'cwd');
    const systemSettingsFile = path.join(runtimeRoot, 'system-settings.json');

    const geminiHomeStat = createPrivateDirectory(geminiHome);
    const workingDirectoryStat = createPrivateDirectory(workingDirectory);
    const settingsResult = writePrivateSettings(
      systemSettingsFile,
      contract.isolatedSettings,
    );
    settingsDescriptor = settingsResult.descriptor;

    const childEnvironment = buildChildEnvironment(contract, parentEnv, {
      GEMINI_CLI_HOME: geminiHome,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemSettingsFile,
    });

    runtime = Object.freeze({
      schemaVersion: PHASE_B_RUNTIME_SCHEMA_VERSION,
      runtimeRoot,
      geminiHome,
      workingDirectory,
      systemSettingsFile,
      childEnvironment: Object.freeze(childEnvironment),
      launcherArgs: Object.freeze([]),
      executableLaunchImplemented: false,
    });
    ACTIVE_RUNTIMES.set(runtime, {
      runtimeRoot,
      settingsDescriptor,
      expectedSettingsText: settingsResult.expectedText,
      identities: {
        runtimeRoot: identity(runtimeRootStat),
        geminiHome: identity(geminiHomeStat),
        workingDirectory: identity(workingDirectoryStat),
        systemSettingsFile: identity(settingsResult.stat),
      },
    });
    verifyPhaseBRuntime(runtime);
    return runtime;
  } catch (error) {
    if (runtime) ACTIVE_RUNTIMES.delete(runtime);
    if (settingsDescriptor !== undefined) {
      try {
        fs.closeSync(settingsDescriptor);
      } catch {
        // Preserve the original fail-closed error.
      }
    }
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

export function verifyPhaseBRuntime(runtime) {
  const metadata = requireActiveRuntime(runtime);
  const heldSettingsStat = fs.fstatSync(metadata.settingsDescriptor);
  if (!heldSettingsStat.isFile()) fail('held settings descriptor changed type');
  requirePrivateMode(heldSettingsStat, 'held settings descriptor');
  if (
    !sameIdentity(
      heldSettingsStat,
      metadata.identities.systemSettingsFile,
    )
  ) {
    fail('held settings descriptor identity changed');
  }

  const checks = [
    ['runtimeRoot', runtime.runtimeRoot, 'directory'],
    ['geminiHome', runtime.geminiHome, 'directory'],
    ['workingDirectory', runtime.workingDirectory, 'directory'],
    ['systemSettingsFile', runtime.systemSettingsFile, 'file'],
  ];

  for (const [key, targetPath, kind] of checks) {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) fail(`${key} became a symbolic link`);
    if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) {
      fail(`${key} changed filesystem type`);
    }
    requirePrivateMode(stat, key);
    if (!sameIdentity(stat, metadata.identities[key])) {
      fail(`${key} identity changed after materialization`);
    }
  }

  if (!arraysEqual(fs.readdirSync(runtime.workingDirectory), [])) {
    fail('working directory is no longer empty');
  }
  if (
    fs.readFileSync(runtime.systemSettingsFile, 'utf8') !==
    metadata.expectedSettingsText
  ) {
    fail('isolated settings file changed after materialization');
  }
  if (
    runtime.childEnvironment.GEMINI_CLI_HOME !== runtime.geminiHome ||
    runtime.childEnvironment.GEMINI_CLI_SYSTEM_SETTINGS_PATH !==
      runtime.systemSettingsFile
  ) {
    fail('runtime environment bindings no longer match runtime paths');
  }
  return true;
}

export function cleanupPhaseBRuntime(runtime) {
  const metadata = requireActiveRuntime(runtime);
  try {
    fs.closeSync(metadata.settingsDescriptor);
  } finally {
    removeRuntimeRoot(metadata.runtimeRoot);
    ACTIVE_RUNTIMES.delete(runtime);
  }
}
