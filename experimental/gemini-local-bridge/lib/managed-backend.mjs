/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Optional managed llama.cpp lifecycle for gemini-local.
 *
 * The accepted C2 six-key protocol config remains unchanged. A separate
 * filesystem-only launch config opts the backend into process ownership and
 * pins the exact executable/model artifacts gemini-local is authorized to run:
 *
 *   ~/.config/gemini-local-bridge/llama-cpp-launch.json
 *   {
 *     "schemaVersion": 1,
 *     "serverPath": "/absolute/path/to/llama-server",
 *     "serverSha256": "<64 hex>",
 *     "modelPath": "/absolute/path/to/model.gguf",
 *     "modelSha256": "<64 hex>"
 *   }
 *
 * If the configured backend is already healthy, gemini-local reuses it and
 * never starts a duplicate. If it is unhealthy and this launch config is
 * present, gemini-local verifies the configured artifacts, starts them
 * loopback-only, waits for /health, records narrowly-scoped ownership state,
 * and leaves the server alive for subsequent prompts. No downloads, builds,
 * shell execution, or Android-boot persistence are added here.
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  constants as fsConstants,
  accessSync,
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { checkBackendHealth } from './local-gemini-runner.mjs';
import { validateBackendOrigin } from './loopback-origin.mjs';
import { resolveLayout } from './paths.mjs';

export const MANAGED_LAUNCH_SCHEMA_VERSION = 1;
export const DEFAULT_BACKEND_STARTUP_TIMEOUT_MS = 120_000;
export const MAX_BACKEND_STARTUP_TIMEOUT_MS = 300_000;
export const BACKEND_STOP_GRACE_MS = 5_000;
export const BACKEND_KILL_GRACE_MS = 2_000;
export const MAX_MANAGED_FILE_BYTES = 16 * 1024;

const LAUNCH_KEYS = Object.freeze([
  'schemaVersion',
  'serverPath',
  'serverSha256',
  'modelPath',
  'modelSha256',
]);
const LEGACY_STATE_KEYS = Object.freeze([
  'schemaVersion',
  'pid',
  'procStartTicks',
  'backendOrigin',
  'backendModel',
  'serverPath',
  'serverSha256',
  'modelPath',
  'modelSha256',
  'startedAt',
]);
const STATE_KEYS = Object.freeze([
  ...LEGACY_STATE_KEYS,
  'launchArgvSha256',
]);

const SAFE_CHILD_ENV_KEYS = Object.freeze([
  'HOME',
  'PATH',
  'TMPDIR',
  'PREFIX',
  'LD_LIBRARY_PATH',
  'LANG',
  'LC_ALL',
  'TERMUX_VERSION',
  'ANDROID_ROOT',
  'ANDROID_DATA',
]);

export class ManagedBackendError extends Error {
  constructor(category, message) {
    super(message);
    this.name = 'ManagedBackendError';
    this.category = category;
  }
}

function fail(category, message) {
  throw new ManagedBackendError(category, message);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(object, keys) {
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requireSha256(value, field) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
    fail('MANAGED_CONFIG_INVALID', `${field} must be exactly 64 hexadecimal SHA-256 characters`);
  }
  return value.toLowerCase();
}

function readRegularFileNoFollow(targetPath, maxBytes, { absentOk = false } = {}) {
  let before;
  try {
    before = lstatSync(targetPath);
  } catch (error) {
    if (absentOk && error?.code === 'ENOENT') return null;
    fail('MANAGED_CONFIG_INVALID', `unable to stat managed backend file: ${targetPath}`);
  }
  if (before.isSymbolicLink()) {
    fail('MANAGED_CONFIG_INVALID', `managed backend file must not be a symlink: ${targetPath}`);
  }
  if (!before.isFile()) {
    fail('MANAGED_CONFIG_INVALID', `managed backend file must be a regular file: ${targetPath}`);
  }
  if (before.size > maxBytes) {
    fail('MANAGED_CONFIG_INVALID', `managed backend file exceeds ${maxBytes} bytes: ${targetPath}`);
  }

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const nonBlock = fsConstants.O_NONBLOCK ?? 0;
  let fd;
  try {
    fd = openSync(targetPath, fsConstants.O_RDONLY | noFollow | nonBlock);
  } catch (error) {
    if (error?.code === 'ELOOP') {
      fail('MANAGED_CONFIG_INVALID', `managed backend file must not be a symlink: ${targetPath}`);
    }
    fail('MANAGED_CONFIG_INVALID', `unable to open managed backend file safely: ${targetPath}`);
  }

  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail('MANAGED_CONFIG_INVALID', `managed backend file identity changed while opening: ${targetPath}`);
    }
    if (opened.size > maxBytes) {
      fail('MANAGED_CONFIG_INVALID', `managed backend file exceeds ${maxBytes} bytes: ${targetPath}`);
    }
    const buffer = Buffer.alloc(opened.size);
    let total = 0;
    while (total < buffer.length) {
      const count = readSync(fd, buffer, total, buffer.length - total, total);
      if (count === 0) break;
      total += count;
    }
    return buffer.subarray(0, total).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function parseJsonObject(text, description) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('MANAGED_CONFIG_INVALID', `${description} is not valid JSON`);
  }
  if (!isPlainObject(parsed)) {
    fail('MANAGED_CONFIG_INVALID', `${description} must be a JSON object`);
  }
  return parsed;
}

function requireAbsoluteRegularFile(targetPath, field, { executable = false } = {}) {
  if (typeof targetPath !== 'string' || targetPath.length === 0 || !path.isAbsolute(targetPath)) {
    fail('MANAGED_CONFIG_INVALID', `${field} must be a non-empty absolute path`);
  }
  let stat;
  try {
    stat = lstatSync(targetPath);
  } catch {
    fail('MANAGED_CONFIG_INVALID', `${field} does not exist: ${targetPath}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail('MANAGED_CONFIG_INVALID', `${field} must be a non-symlink regular file: ${targetPath}`);
  }
  if (executable) {
    try {
      accessSync(targetPath, fsConstants.X_OK);
    } catch {
      fail('MANAGED_CONFIG_INVALID', `${field} is not executable: ${targetPath}`);
    }
  }
  return realpathSync(targetPath);
}

/** Hash a held, no-follow regular-file descriptor so path substitution during hashing fails closed. */
function sha256RegularFileNoFollow(targetPath, field) {
  const before = lstatSync(targetPath);
  if (before.isSymbolicLink() || !before.isFile()) {
    fail('MANAGED_CONFIG_INVALID', `${field} must remain a non-symlink regular file`);
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const nonBlock = fsConstants.O_NONBLOCK ?? 0;
  let fd;
  try {
    fd = openSync(targetPath, fsConstants.O_RDONLY | noFollow | nonBlock);
  } catch {
    fail('MANAGED_CONFIG_INVALID', `unable to open ${field} safely for SHA-256 verification`);
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail('MANAGED_CONFIG_INVALID', `${field} identity changed before SHA-256 verification`);
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      fail('MANAGED_CONFIG_INVALID', `${field} changed while its SHA-256 was being verified`);
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

function loadManagedLaunchIdentity(env = process.env) {
  const layout = resolveLayout(env);
  const text = readRegularFileNoFollow(layout.backendLaunchConfigPath, MAX_MANAGED_FILE_BYTES, {
    absentOk: true,
  });
  if (text === null) return null;
  const parsed = parseJsonObject(text, 'managed backend launch config');
  if (!exactKeys(parsed, LAUNCH_KEYS)) {
    fail('MANAGED_CONFIG_INVALID', `managed backend launch config must contain exactly: ${LAUNCH_KEYS.join(', ')}`);
  }
  if (parsed.schemaVersion !== MANAGED_LAUNCH_SCHEMA_VERSION) {
    fail('MANAGED_CONFIG_INVALID', `managed backend launch schemaVersion must be ${MANAGED_LAUNCH_SCHEMA_VERSION}`);
  }

  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    serverPath: requireAbsoluteRegularFile(parsed.serverPath, 'serverPath', { executable: true }),
    serverSha256: requireSha256(parsed.serverSha256, 'serverSha256'),
    modelPath: requireAbsoluteRegularFile(parsed.modelPath, 'modelPath'),
    modelSha256: requireSha256(parsed.modelSha256, 'modelSha256'),
  });
}

export function loadManagedLaunchConfig(env = process.env) {
  const launch = loadManagedLaunchIdentity(env);
  if (!launch) return null;

  const actualServerSha256 = sha256RegularFileNoFollow(launch.serverPath, 'serverPath');
  if (actualServerSha256 !== launch.serverSha256) {
    fail('MANAGED_ARTIFACT_MISMATCH', `llama-server SHA-256 mismatch for ${launch.serverPath}`);
  }
  const actualModelSha256 = sha256RegularFileNoFollow(launch.modelPath, 'modelPath');
  if (actualModelSha256 !== launch.modelSha256) {
    fail('MANAGED_ARTIFACT_MISMATCH', `GGUF SHA-256 mismatch for ${launch.modelPath}`);
  }

  return launch;
}

function runtimePaths(env) {
  const layout = resolveLayout(env);
  return {
    ...layout,
    runtimeDir: layout.backendRuntimeDir,
    statePath: layout.backendStatePath,
    logPath: layout.backendLogPath,
  };
}

function ensureRuntimeDir(env) {
  const runtime = runtimePaths(env);
  mkdirSync(runtime.runtimeDir, { recursive: true, mode: 0o700 });
  chmodSync(runtime.runtimeDir, 0o700);
  return runtime;
}

function safeChildEnvironment(env) {
  const childEnv = Object.create(null);
  for (const key of SAFE_CHILD_ENV_KEYS) {
    if (typeof env?.[key] === 'string') childEnv[key] = env[key];
  }
  return childEnv;
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readProcStartTicks(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close === -1) return null;
    const fields = raw.slice(close + 2).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function launchArgvSha256(args) {
  return createHash('sha256').update(JSON.stringify(args)).digest('hex');
}

function buildState({ pid, config, launch, args }) {
  return Object.freeze({
    schemaVersion: 1,
    pid,
    procStartTicks: readProcStartTicks(pid),
    backendOrigin: config.backendOrigin,
    backendModel: config.backendModel,
    serverPath: launch.serverPath,
    serverSha256: launch.serverSha256,
    modelPath: launch.modelPath,
    modelSha256: launch.modelSha256,
    startedAt: new Date().toISOString(),
    launchArgvSha256: launchArgvSha256(args),
  });
}

function writeStateAtomic(statePath, state) {
  const temp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temp, statePath);
  chmodSync(statePath, 0o600);
}

function readStatePath(statePath) {
  const text = readRegularFileNoFollow(statePath, MAX_MANAGED_FILE_BYTES, { absentOk: true });
  if (text === null) return null;
  const parsed = parseJsonObject(text, 'managed backend state');
  const legacyShape = exactKeys(parsed, LEGACY_STATE_KEYS);
  const currentShape = exactKeys(parsed, STATE_KEYS);
  if ((!legacyShape && !currentShape) || parsed.schemaVersion !== 1 || !Number.isSafeInteger(parsed.pid)) {
    fail('MANAGED_STATE_INVALID', 'managed backend state file is malformed');
  }
  if (currentShape && !/^[0-9a-f]{64}$/.test(parsed.launchArgvSha256)) {
    fail('MANAGED_STATE_INVALID', 'managed backend state launchArgvSha256 is malformed');
  }
  return parsed;
}

function readState(env) {
  return readStatePath(runtimePaths(env).statePath);
}

function removeState(env) {
  const { statePath } = runtimePaths(env);
  try {
    unlinkSync(statePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function statesEqual(left, right) {
  const keys = Object.keys(left);
  return exactKeys(right, keys) && keys.every((key) => left[key] === right[key]);
}

function restoreClaimedState(claimedPath, statePath) {
  try {
    linkSync(claimedPath, statePath);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  unlinkSync(claimedPath);
}

function removeStateIfMatches(env, expectedState) {
  const { statePath } = runtimePaths(env);
  const claimedPath = `${statePath}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(statePath, claimedPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }

  let claimedState;
  try {
    claimedState = readStatePath(claimedPath);
  } catch (error) {
    restoreClaimedState(claimedPath, statePath);
    throw error;
  }
  if (!statesEqual(claimedState, expectedState)) {
    restoreClaimedState(claimedPath, statePath);
    return false;
  }
  unlinkSync(claimedPath);
  return true;
}

function stateMatchesConfig(state, config, launch = null, args = null) {
  if (!state) return false;
  if (state.backendOrigin !== config.backendOrigin || state.backendModel !== config.backendModel) return false;
  if (
    launch &&
    (state.serverPath !== launch.serverPath ||
      state.serverSha256 !== launch.serverSha256 ||
      state.modelPath !== launch.modelPath ||
      state.modelSha256 !== launch.modelSha256)
  ) {
    return false;
  }
  if (args && state.launchArgvSha256 !== launchArgvSha256(args)) return false;
  return true;
}

/**
 * Linux and Android both expose the procfs identity data this verifier uses.
 * Node reports Termux as process.platform === 'android', so treating Linux as
 * the only procfs-capable platform makes every real Termux-owned process look
 * unverified even when /proc/<pid>/exe and cmdline match exactly.
 */
export function supportsProcOwnershipVerification(platform = process.platform) {
  return platform === 'linux' || platform === 'android';
}

function verifyOwnedProcess(state) {
  if (!state || !isProcessAlive(state.pid)) return false;
  const currentStartTicks = readProcStartTicks(state.pid);
  if (state.procStartTicks !== null && currentStartTicks !== null && state.procStartTicks !== currentStartTicks) {
    return false;
  }

  if (supportsProcOwnershipVerification()) {
    try {
      const exe = realpathSync(`/proc/${state.pid}/exe`);
      if (exe !== state.serverPath) return false;
      const args = readFileSync(`/proc/${state.pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
      if (!args.includes(state.modelPath)) return false;
      if (!args.includes('127.0.0.1')) return false;
      if (!args.includes(state.backendModel)) return false;
    } catch {
      return false;
    }
    return true;
  }

  return false;
}

function parseManagedEndpoint(origin) {
  validateBackendOrigin(origin);
  const url = new URL(origin);
  if (url.hostname !== '127.0.0.1' || !url.port) {
    fail('MANAGED_CONFIG_INVALID', 'managed backendOrigin must contain literal 127.0.0.1 and an explicit port');
  }
  return { host: '127.0.0.1', port: url.port };
}

/** Build the complete launcher-owned llama-server argv for the host platform. */
export function buildManagedLlamaServerArgs(launch, config, endpoint, platform = process.platform) {
  const args = [
    '-m', launch.modelPath,
    '--host', endpoint.host,
    '--port', endpoint.port,
    '-a', config.backendModel,
    '--no-webui',
    '--offline',
  ];

  if (platform === 'android') {
    args.push('-c', '8192', '-np', '1', '--no-warmup');
  }

  return Object.freeze(args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(100);
  }
  return !isProcessAlive(pid);
}

function killOwnedProcessBestEffort(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
}

async function stopRecordedManagedBackend(state, env) {
  if (!isProcessAlive(state.pid)) {
    removeState(env);
    return Object.freeze({ stopped: false, status: 'stale-state-removed' });
  }
  if (!verifyOwnedProcess(state)) {
    fail('BACKEND_OWNERSHIP_UNVERIFIED', 'refusing to signal a process whose managed ownership cannot be verified');
  }

  process.kill(state.pid, 'SIGTERM');
  if (!(await waitForProcessExit(state.pid, BACKEND_STOP_GRACE_MS))) {
    if (!verifyOwnedProcess(state)) {
      fail('BACKEND_OWNERSHIP_UNVERIFIED', 'process identity changed while stopping; refusing SIGKILL');
    }
    process.kill(state.pid, 'SIGKILL');
    if (!(await waitForProcessExit(state.pid, BACKEND_KILL_GRACE_MS))) {
      fail('BACKEND_STOP_FAILED', 'managed llama-server did not terminate after SIGKILL');
    }
  }
  removeState(env);
  return Object.freeze({ stopped: true, status: 'stopped' });
}

export async function ensureBackendReady({
  config,
  env = process.env,
  fetchImpl = fetch,
  spawnImpl = spawn,
  startupTimeoutMs = DEFAULT_BACKEND_STARTUP_TIMEOUT_MS,
} = {}) {
  if (!isPlainObject(config)) fail('MANAGED_CONFIG_INVALID', 'validated local config is required');
  validateBackendOrigin(config.backendOrigin);
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs <= 0 || startupTimeoutMs > MAX_BACKEND_STARTUP_TIMEOUT_MS) {
    fail('MANAGED_CONFIG_INVALID', `startupTimeoutMs must be 1..${MAX_BACKEND_STARTUP_TIMEOUT_MS}`);
  }

  // Preserve fail-closed state validation before the health request, then
  // re-read after asynchronous work before making any reuse/spawn decision.
  readState(env);
  const healthy = await checkBackendHealth(config.backendOrigin, { fetchImpl, timeoutMs: 1_000 });
  if (healthy) {
    let currentState = readState(env);
    while (currentState && !isProcessAlive(currentState.pid)) {
      if (removeStateIfMatches(env, currentState)) {
        return Object.freeze({ ready: true, started: false, mode: 'reused-healthy' });
      }
      currentState = readState(env);
    }
    if (!currentState) {
      return Object.freeze({ ready: true, started: false, mode: 'reused-healthy' });
    }

    const launchIdentity = loadManagedLaunchIdentity(env);
    if (!launchIdentity) {
      fail(
        'MANAGED_STATE_CONFLICT',
        'a healthy managed backend is recorded but the managed launch config is missing; use gemini-local restart',
      );
    }
    const endpoint = parseManagedEndpoint(config.backendOrigin);
    const expectedArgs = buildManagedLlamaServerArgs(launchIdentity, config, endpoint);
    if (!stateMatchesConfig(currentState, config, launchIdentity, expectedArgs)) {
      fail(
        'MANAGED_STATE_CONFLICT',
        'healthy managed backend configuration or launch policy differs from the current launcher; use gemini-local restart',
      );
    }
    return Object.freeze({
      ready: true,
      started: false,
      mode: 'reused-healthy',
      pid: currentState.pid,
    });
  }

  const launch = loadManagedLaunchConfig(env);
  if (!launch) {
    fail(
      'BACKEND_UNHEALTHY',
      `local backend ${config.backendOrigin} is not healthy and no managed launch config is present`,
    );
  }

  const endpoint = parseManagedEndpoint(config.backendOrigin);
  const args = buildManagedLlamaServerArgs(launch, config, endpoint);
  let currentState = readState(env);
  while (currentState) {
    if (isProcessAlive(currentState.pid)) {
      if (!stateMatchesConfig(currentState, config, launch, args)) {
        fail(
          'MANAGED_STATE_CONFLICT',
          'another managed backend process is recorded with different configuration or launch policy; use gemini-local restart',
        );
      }
      fail('MANAGED_BACKEND_UNHEALTHY', 'recorded managed llama-server is alive but failed its health check; use gemini-local restart');
    }
    if (removeStateIfMatches(env, currentState)) break;
    currentState = readState(env);
  }

  const runtime = ensureRuntimeDir(env);
  const logFd = openSync(runtime.logPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND, 0o600);
  chmodSync(runtime.logPath, 0o600);

  let child;
  try {
    child = spawnImpl(launch.serverPath, args, {
      cwd: path.dirname(launch.modelPath),
      env: safeChildEnvironment(env),
      shell: false,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
  } catch {
    closeSync(logFd);
    fail('BACKEND_START_FAILED', 'failed to spawn managed llama-server');
  }

  const spawned = await new Promise((resolve) => {
    let settled = false;
    child.once('spawn', () => {
      if (!settled) {
        settled = true;
        resolve(true);
      }
    });
    child.once('error', () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });
  });
  closeSync(logFd);

  if (!spawned || !Number.isSafeInteger(child.pid)) {
    fail('BACKEND_START_FAILED', 'managed llama-server failed to spawn');
  }

  const state = buildState({ pid: child.pid, config, launch, args });
  try {
    writeStateAtomic(runtime.statePath, state);
  } catch {
    killOwnedProcessBestEffort(child.pid);
    fail('BACKEND_START_FAILED', 'unable to record managed llama-server ownership state');
  }

  child.unref();

  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(child.pid)) {
      removeState(env);
      fail('BACKEND_START_FAILED', `managed llama-server exited before becoming healthy; see ${runtime.logPath}`);
    }
    if (await checkBackendHealth(config.backendOrigin, { fetchImpl, timeoutMs: 1_000 })) {
      return Object.freeze({
        ready: true,
        started: true,
        mode: 'managed-started',
        pid: child.pid,
        logPath: runtime.logPath,
      });
    }
    await sleep(250);
  }

  if (verifyOwnedProcess(state)) killOwnedProcessBestEffort(child.pid);
  removeState(env);
  fail('BACKEND_START_TIMEOUT', `managed llama-server did not become healthy within ${startupTimeoutMs}ms`);
}

export async function getBackendStatus({ config, env = process.env, fetchImpl = fetch } = {}) {
  if (!isPlainObject(config)) fail('MANAGED_CONFIG_INVALID', 'validated local config is required');
  const healthy = await checkBackendHealth(config.backendOrigin, { fetchImpl, timeoutMs: 1_000 });
  let state = null;
  try {
    state = readState(env);
  } catch (error) {
    if (error instanceof ManagedBackendError) {
      return Object.freeze({ status: 'state-invalid', healthy, managed: true, detail: error.message });
    }
    throw error;
  }
  if (!state) {
    return Object.freeze({
      status: healthy ? 'external-or-untracked-healthy' : 'stopped',
      healthy,
      managed: false,
    });
  }
  const alive = isProcessAlive(state.pid);
  if (!alive) {
    return Object.freeze({
      status: 'stale-state',
      healthy,
      managed: true,
      pid: state.pid,
      ownedProcessVerified: false,
    });
  }
  if (!stateMatchesConfig(state, config)) {
    return Object.freeze({
      status: 'state-conflict',
      healthy,
      managed: true,
      pid: state.pid,
      detail: 'recorded managed backend does not match the current protocol config; use gemini-local restart',
    });
  }

  let launchIdentity;
  try {
    launchIdentity = loadManagedLaunchIdentity(env);
  } catch (error) {
    if (!(error instanceof ManagedBackendError)) throw error;
    return Object.freeze({
      status: 'state-conflict',
      healthy,
      managed: true,
      pid: state.pid,
      detail: 'current managed launch config is invalid; use gemini-local restart',
    });
  }
  if (!launchIdentity) {
    return Object.freeze({
      status: 'state-conflict',
      healthy,
      managed: true,
      pid: state.pid,
      detail: 'current managed launch config is missing; use gemini-local restart',
    });
  }

  const endpoint = parseManagedEndpoint(config.backendOrigin);
  const currentPolicyArgs = buildManagedLlamaServerArgs(launchIdentity, config, endpoint);
  if (!stateMatchesConfig(state, config, launchIdentity, currentPolicyArgs)) {
    return Object.freeze({
      status: 'state-conflict',
      healthy,
      managed: true,
      pid: state.pid,
      detail: 'recorded managed backend launch identity or policy differs from the current launcher; use gemini-local restart',
    });
  }

  return Object.freeze({
    status: healthy ? 'managed-running' : 'managed-unhealthy',
    healthy,
    managed: true,
    pid: state.pid,
    ownedProcessVerified: verifyOwnedProcess(state),
  });
}

export async function stopManagedBackend({ config, env = process.env } = {}) {
  if (!isPlainObject(config)) fail('MANAGED_CONFIG_INVALID', 'validated local config is required');
  const state = readState(env);
  if (!state) return Object.freeze({ stopped: false, status: 'not-managed' });
  if (!stateMatchesConfig(state, config)) {
    fail('MANAGED_STATE_CONFLICT', 'recorded managed backend does not match current local config');
  }
  return stopRecordedManagedBackend(state, env);
}

export async function restartManagedBackend({ config, env = process.env, fetchImpl = fetch } = {}) {
  const state = readState(env);
  if (state) await stopRecordedManagedBackend(state, env);
  return ensureBackendReady({ config, env, fetchImpl });
}
