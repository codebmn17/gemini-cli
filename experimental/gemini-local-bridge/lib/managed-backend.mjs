/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Optional managed llama.cpp lifecycle for gemini-local.
 *
 * The accepted C2 six-key local config remains unchanged. A separate,
 * filesystem-only launch config opts a backend into process ownership:
 *
 *   ~/.config/gemini-local-bridge/llama-cpp-launch.json
 *   {
 *     "schemaVersion": 1,
 *     "serverPath": "/absolute/path/to/llama-server",
 *     "modelPath": "/absolute/path/to/model.gguf"
 *   }
 *
 * If the configured backend is already healthy, gemini-local reuses it and
 * never starts a duplicate. If it is unhealthy and this launch config is
 * present, gemini-local starts the configured binary/model loopback-only,
 * waits for /health, records narrowly-scoped ownership state, and leaves the
 * server alive for subsequent prompts. No Android-boot persistence is added.
 */

import { spawn } from 'node:child_process';
import {
  constants as fsConstants,
  accessSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
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

const LAUNCH_KEYS = Object.freeze(['schemaVersion', 'serverPath', 'modelPath']);
const STATE_KEYS = Object.freeze([
  'schemaVersion',
  'pid',
  'procStartTicks',
  'backendOrigin',
  'backendModel',
  'serverPath',
  'modelPath',
  'startedAt',
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

export function loadManagedLaunchConfig(env = process.env) {
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
  const serverPath = requireAbsoluteRegularFile(parsed.serverPath, 'serverPath', { executable: true });
  const modelPath = requireAbsoluteRegularFile(parsed.modelPath, 'modelPath');
  return Object.freeze({ schemaVersion: parsed.schemaVersion, serverPath, modelPath });
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
    // /proc/<pid>/stat field 22 is starttime; fields[] begins at field 3.
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function buildState({ pid, config, launch }) {
  return Object.freeze({
    schemaVersion: 1,
    pid,
    procStartTicks: readProcStartTicks(pid),
    backendOrigin: config.backendOrigin,
    backendModel: config.backendModel,
    serverPath: launch.serverPath,
    modelPath: launch.modelPath,
    startedAt: new Date().toISOString(),
  });
}

function writeStateAtomic(statePath, state) {
  const temp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temp, statePath);
  chmodSync(statePath, 0o600);
}

function readState(env) {
  const { statePath } = runtimePaths(env);
  const text = readRegularFileNoFollow(statePath, MAX_MANAGED_FILE_BYTES, { absentOk: true });
  if (text === null) return null;
  const parsed = parseJsonObject(text, 'managed backend state');
  if (!exactKeys(parsed, STATE_KEYS) || parsed.schemaVersion !== 1 || !Number.isSafeInteger(parsed.pid)) {
    fail('MANAGED_STATE_INVALID', 'managed backend state file is malformed');
  }
  return parsed;
}

function removeState(env) {
  const { statePath } = runtimePaths(env);
  try {
    unlinkSync(statePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function stateMatchesConfig(state, config, launch = null) {
  if (!state) return false;
  if (state.backendOrigin !== config.backendOrigin || state.backendModel !== config.backendModel) return false;
  if (launch && (state.serverPath !== launch.serverPath || state.modelPath !== launch.modelPath)) return false;
  return true;
}

function verifyOwnedProcess(state) {
  if (!state || !isProcessAlive(state.pid)) return false;
  const currentStartTicks = readProcStartTicks(state.pid);
  if (state.procStartTicks !== null && currentStartTicks !== null && state.procStartTicks !== currentStartTicks) {
    return false;
  }

  if (process.platform === 'linux') {
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

  // Without /proc we cannot rule out PID reuse strongly enough to send a
  // destructive signal. Reuse/status still work, but stop/restart refuse.
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

  if (await checkBackendHealth(config.backendOrigin, { fetchImpl, timeoutMs: 1_000 })) {
    return Object.freeze({ ready: true, started: false, mode: 'reused-healthy' });
  }

  const launch = loadManagedLaunchConfig(env);
  if (!launch) {
    fail(
      'BACKEND_UNHEALTHY',
      `local backend ${config.backendOrigin} is not healthy and no managed launch config is present`,
    );
  }

  const existingState = readState(env);
  if (existingState) {
    if (!stateMatchesConfig(existingState, config, launch)) {
      if (isProcessAlive(existingState.pid)) {
        fail('MANAGED_STATE_CONFLICT', 'another managed backend process is recorded with different configuration');
      }
      removeState(env);
    } else if (isProcessAlive(existingState.pid)) {
      fail('MANAGED_BACKEND_UNHEALTHY', 'recorded managed llama-server is alive but failed its health check; use gemini-local restart');
    } else {
      removeState(env);
    }
  }

  const endpoint = parseManagedEndpoint(config.backendOrigin);
  const runtime = ensureRuntimeDir(env);
  const logFd = openSync(runtime.logPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND, 0o600);
  chmodSync(runtime.logPath, 0o600);

  const args = Object.freeze([
    '-m', launch.modelPath,
    '--host', endpoint.host,
    '--port', endpoint.port,
    '-a', config.backendModel,
    '--no-webui',
    '--offline',
  ]);

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

  const state = buildState({ pid: child.pid, config, launch });
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
  if (!stateMatchesConfig(state, config)) {
    return Object.freeze({ status: 'state-conflict', healthy, managed: true, pid: state.pid });
  }
  const alive = isProcessAlive(state.pid);
  return Object.freeze({
    status: alive ? (healthy ? 'managed-running' : 'managed-unhealthy') : 'stale-state',
    healthy,
    managed: true,
    pid: state.pid,
    ownedProcessVerified: alive ? verifyOwnedProcess(state) : false,
  });
}

export async function stopManagedBackend({ config, env = process.env } = {}) {
  if (!isPlainObject(config)) fail('MANAGED_CONFIG_INVALID', 'validated local config is required');
  const state = readState(env);
  if (!state) return Object.freeze({ stopped: false, status: 'not-managed' });
  if (!stateMatchesConfig(state, config)) {
    fail('MANAGED_STATE_CONFLICT', 'recorded managed backend does not match current local config');
  }
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

export async function restartManagedBackend({ config, env = process.env, fetchImpl = fetch } = {}) {
  const state = readState(env);
  if (state) await stopManagedBackend({ config, env });
  return ensureBackendReady({ config, env, fetchImpl });
}
