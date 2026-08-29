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
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
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
export const MANAGED_LAUNCH_CLAIM_STALE_MS = MAX_BACKEND_STARTUP_TIMEOUT_MS * 2;

const MANAGED_LAUNCH_CLAIM_FILENAME = 'llama-server-launch-claim';

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
const LAUNCH_CLAIM_KEYS = Object.freeze([
  'schemaVersion',
  'token',
  'ownerPid',
  'ownerProcStartTicks',
  'createdAtMs',
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
    claimPath: path.join(layout.backendRuntimeDir, MANAGED_LAUNCH_CLAIM_FILENAME),
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

function publishJsonExclusive(targetPath, value) {
  const temp = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    linkSync(temp, targetPath);
  } finally {
    unlinkSync(temp);
  }
}

function writeStateAtomic(statePath, state) {
  publishJsonExclusive(statePath, state);
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

function launchClaimRecordName(token) {
  return `owner-${token}.json`;
}

function parseLaunchClaim(text) {
  const parsed = parseJsonObject(text, 'managed launch claim');
  if (
    !exactKeys(parsed, LAUNCH_CLAIM_KEYS) ||
    parsed.schemaVersion !== 1 ||
    !Number.isSafeInteger(parsed.ownerPid) ||
    parsed.ownerPid <= 1 ||
    (parsed.ownerProcStartTicks !== null &&
      (typeof parsed.ownerProcStartTicks !== 'string' || !/^\d+$/.test(parsed.ownerProcStartTicks))) ||
    !Number.isSafeInteger(parsed.createdAtMs) ||
    parsed.createdAtMs <= 0 ||
    typeof parsed.token !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parsed.token)
  ) {
    fail('MANAGED_LAUNCH_CLAIM_INVALID', 'managed launch claim file is malformed');
  }
  return parsed;
}

function readLaunchClaimPath(claimPath, { absentOk = false } = {}) {
  let before;
  try {
    before = lstatSync(claimPath);
  } catch (error) {
    if (absentOk && error?.code === 'ENOENT') return null;
    fail('MANAGED_LAUNCH_CLAIM_INVALID', 'unable to inspect the managed launch claim');
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    fail('MANAGED_LAUNCH_CLAIM_INVALID', 'managed launch claim must be a non-symlink directory');
  }

  let entries;
  try {
    entries = readdirSync(claimPath);
  } catch {
    fail('MANAGED_LAUNCH_CLAIM_INVALID', 'unable to read the managed launch claim');
  }
  if (entries.length !== 1 || !/^owner-[0-9a-f-]+\.json$/.test(entries[0])) {
    fail('MANAGED_LAUNCH_CLAIM_INVALID', 'managed launch claim directory is malformed');
  }
  const text = readRegularFileNoFollow(path.join(claimPath, entries[0]), MAX_MANAGED_FILE_BYTES);
  const claim = parseLaunchClaim(text);
  if (entries[0] !== launchClaimRecordName(claim.token)) {
    fail('MANAGED_LAUNCH_CLAIM_INVALID', 'managed launch claim token does not match its owner record');
  }

  let after;
  try {
    after = lstatSync(claimPath);
  } catch {
    fail('MANAGED_LAUNCH_CLAIM_INVALID', 'managed launch claim changed while being read');
  }
  if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) {
    fail('MANAGED_LAUNCH_CLAIM_INVALID', 'managed launch claim identity changed while being read');
  }
  return Object.freeze({ claim, dev: after.dev, ino: after.ino });
}

function readLaunchClaim(runtime) {
  return readLaunchClaimPath(runtime.claimPath, { absentOk: true })?.claim ?? null;
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

function removeLaunchClaimIfMatches(runtime, expectedClaim) {
  const observed = readLaunchClaimPath(runtime.claimPath, { absentOk: true });
  if (!observed || !statesEqual(observed.claim, expectedClaim)) return false;

  const detachedPath = `${runtime.claimPath}.detached-${expectedClaim.token}-${process.pid}-${randomUUID()}`;
  try {
    renameSync(runtime.claimPath, detachedPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }

  const detached = readLaunchClaimPath(detachedPath);
  if (
    detached.dev !== observed.dev ||
    detached.ino !== observed.ino ||
    !statesEqual(detached.claim, expectedClaim)
  ) {
    fail('MANAGED_LAUNCH_CLAIM_INVALID', 'managed launch claim ownership changed while being detached');
  }

  const recordPath = path.join(detachedPath, launchClaimRecordName(expectedClaim.token));
  try {
    unlinkSync(recordPath);
  } catch (error) {
    // The owned claim is already detached from the public acquisition path.
    // A private cleanup failure cannot affect a successor or invalidate state
    // that was authoritatively published before release.
    return true;
  }
  try {
    rmdirSync(detachedPath);
  } catch {
    // The detached directory is token-specific and no longer participates in
    // launch ownership, so leaving it behind is availability-neutral.
  }
  return true;
}

function launchClaimOwnerPlausiblyAlive(claim) {
  if (!isProcessAlive(claim.ownerPid)) return false;
  if (supportsProcOwnershipVerification() && claim.ownerProcStartTicks !== null) {
    const currentStartTicks = readProcStartTicks(claim.ownerPid);
    if (currentStartTicks !== null && currentStartTicks !== claim.ownerProcStartTicks) return false;
  }
  return true;
}

function publishLaunchClaimExclusive(runtime, claim) {
  const stagingPath = `${runtime.claimPath}.tmp-${process.pid}-${claim.token}`;
  const recordPath = path.join(stagingPath, launchClaimRecordName(claim.token));
  mkdirSync(stagingPath, { mode: 0o700 });
  let published = false;
  try {
    writeFileSync(recordPath, `${JSON.stringify(claim, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(stagingPath, runtime.claimPath);
    published = true;
  } finally {
    if (!published) {
      try {
        unlinkSync(recordPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      try {
        rmdirSync(stagingPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
}

function acquireLaunchClaim(runtime) {
  const claim = Object.freeze({
    schemaVersion: 1,
    token: randomUUID(),
    ownerPid: process.pid,
    ownerProcStartTicks: readProcStartTicks(process.pid),
    createdAtMs: Date.now(),
  });

  while (true) {
    try {
      publishLaunchClaimExclusive(runtime, claim);
      return claim;
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') {
        fail('BACKEND_START_FAILED', 'unable to acquire the managed launch claim');
      }
    }

    let existingClaim;
    try {
      existingClaim = readLaunchClaim(runtime);
    } catch (error) {
      if (error instanceof ManagedBackendError) {
        fail('MANAGED_LAUNCH_CLAIM_INVALID', 'managed launch claim is invalid and cannot be recovered safely');
      }
      throw error;
    }
    if (!existingClaim) continue;

    const ageMs = Date.now() - existingClaim.createdAtMs;
    if (
      ageMs <= MANAGED_LAUNCH_CLAIM_STALE_MS ||
      ageMs < 0 ||
      launchClaimOwnerPlausiblyAlive(existingClaim)
    ) {
      fail('MANAGED_LAUNCH_IN_PROGRESS', 'another managed backend launch is already in progress');
    }
    if (!removeLaunchClaimIfMatches(runtime, existingClaim)) continue;
  }
}

function releaseLaunchClaim(runtime, claim) {
  return removeLaunchClaimIfMatches(runtime, claim);
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
    removeStateIfMatches(env, state);
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
  removeStateIfMatches(env, state);
  return Object.freeze({ stopped: true, status: 'stopped' });
}

function reuseHealthyBackend(config, env, knownLaunchIdentity = null) {
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

  const launchIdentity = knownLaunchIdentity ?? loadManagedLaunchIdentity(env);
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
    return reuseHealthyBackend(config, env);
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
  const runtime = ensureRuntimeDir(env);
  const claim = acquireLaunchClaim(runtime);
  let claimOwned = true;
  let child;
  let state;
  try {
    if (await checkBackendHealth(config.backendOrigin, { fetchImpl, timeoutMs: 1_000 })) {
      return reuseHealthyBackend(config, env, launch);
    }

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

    const logFd = openSync(runtime.logPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND, 0o600);
    chmodSync(runtime.logPath, 0o600);
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

    state = buildState({ pid: child.pid, config, launch, args });
    try {
      writeStateAtomic(runtime.statePath, state);
    } catch {
      killOwnedProcessBestEffort(child.pid);
      fail('BACKEND_START_FAILED', 'unable to record managed llama-server ownership state');
    }

    child.unref();
    const released = releaseLaunchClaim(runtime, claim);
    claimOwned = false;
    if (!released) {
      fail('BACKEND_START_FAILED', 'managed launch claim ownership changed before release');
    }
  } finally {
    if (claimOwned && !releaseLaunchClaim(runtime, claim)) {
      fail('BACKEND_START_FAILED', 'managed launch claim ownership changed before release');
    }
  }

  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(child.pid)) {
      removeStateIfMatches(env, state);
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
  removeStateIfMatches(env, state);
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
