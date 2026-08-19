/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Real local host-side chain:
 *   verified Gemini CLI -> isolated Phase-B runtime -> C1 adapter -> loopback backend.
 *
 * Device validation exposed two product facts that host mocks could not:
 * (1) the caller's normal ~/.gemini IDE settings must not influence this
 * fully isolated local child, and (2) 30 seconds is not a realistic bounded
 * inference window for mobile models once Gemini's system context is included.
 * This runner therefore creates a private preflight home/workspace internally
 * and gives the product-created adapter its own longer, still-bounded backend
 * deadline. Accepted vendor/phase-b files remain byte-immutable.
 */

import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runPhaseBPreflight } from '../vendor/phase-b/lib/phase-b-preflight.mjs';
import {
  resolvePinnedGeminiDistribution,
  reverifyPinnedEntrypoint,
  buildLaunchContract,
  verifyNoPinnedGeminiEnvSource,
} from '../vendor/phase-b/lib/phase-b-launch-probe.mjs';
import {
  materializePhaseBRuntime,
  verifyPhaseBRuntime,
  cleanupPhaseBRuntime,
} from '../vendor/phase-b/lib/phase-b-runtime.mjs';
import { createAdapterServer } from './llama-cpp-adapter.mjs';
import { validateBackendOrigin } from './loopback-origin.mjs';
import {
  LOCAL_CONFIG_SCHEMA_VERSION,
  SUPPORTED_BACKEND,
} from './local-config.mjs';

export const DEFAULT_HEALTH_TIMEOUT_MS = 3_000;
export const MAX_HEALTH_TIMEOUT_MS = 30_000;
export const MAX_HEALTH_BODY_BYTES = 64 * 1024;

// A local model may legitimately spend minutes ingesting Gemini's several-
// thousand-token host context on mobile hardware. Keep the operation bounded,
// but stop treating hosted-API latency as the local-inference budget.
export const DEFAULT_RUN_TIMEOUT_MS = 10 * 60_000;
export const MAX_RUN_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_ADAPTER_BACKEND_TIMEOUT_MS = 9 * 60_000;
export const MAX_ADAPTER_BACKEND_TIMEOUT_MS = 29 * 60_000;

const TERMINATION_GRACE_MS = 2_000;
const MAX_CAPTURE_BYTES = 1_000_000;
const CLIENT_MODEL_RE = /^local(-[a-zA-Z0-9._-]+|\/[a-zA-Z0-9._/-]+)?$/;
const OUTPUT_FORMAT = 'json';

export class LocalRunError extends Error {
  constructor(category, message) {
    super(message);
    this.name = 'LocalRunError';
    this.category = category;
  }
}

function fail(category, message) {
  throw new LocalRunError(category, message);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value, max) {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}

function isSafeClientModel(value) {
  return typeof value === 'string' && CLIENT_MODEL_RE.test(value) && !value.endsWith('flash');
}

async function readBoundedJsonResponse(response, maxBytes) {
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength !== null && contentLength !== undefined) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) return null;
  }
  const reader = response.body?.getReader?.();
  if (!reader) return null;
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        return null;
      }
      chunks.push(chunk);
    }
  } catch {
    return null;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

/** Loopback-only, byte-bounded llama.cpp /health probe. Never throws. */
export async function checkBackendHealth(
  backendOrigin,
  { fetchImpl = fetch, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS } = {},
) {
  try {
    validateBackendOrigin(backendOrigin);
  } catch {
    return false;
  }
  if (!isPositiveSafeInteger(timeoutMs, MAX_HEALTH_TIMEOUT_MS)) return false;
  if (typeof fetchImpl !== 'function') return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${backendOrigin}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const json = await readBoundedJsonResponse(res, MAX_HEALTH_BODY_BYTES);
    return isPlainObject(json) && json.status === 'ok';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function buildLocalLaunchEnvironment(runtime) {
  const childEnvironment = Object.create(null);
  Object.assign(childEnvironment, runtime.childEnvironment);
  childEnvironment.GEMINI_CLI_NO_RELAUNCH = 'true';
  childEnvironment.GEMINI_EXP = '';
  return childEnvironment;
}

/**
 * Construct the parent context that gemini-local itself owns. Real caller
 * credentials/proxies/system-policy variables remain present for the accepted
 * preflight to inspect. Caller IDE/trust controls and caller ~/.gemini state do
 * not participate because the eventual Gemini child receives neither.
 */
function buildIsolatedParentEnvironment(parentEnv, preflightRoot) {
  const environment = Object.create(null);
  Object.assign(environment, parentEnv);
  environment.GEMINI_CLI_HOME = preflightRoot;
  delete environment.GEMINI_CLI_IDE_SERVER_PORT;
  delete environment.GEMINI_CLI_TRUST_WORKSPACE;
  delete environment.GEMINI_CLI_TRUSTED_FOLDERS_PATH;
  return environment;
}

function createBoundedCapture(stream) {
  const chunks = [];
  let totalBytes = 0;
  let capturedBytes = 0;
  let truncated = false;
  stream.on('data', (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (capturedBytes < MAX_CAPTURE_BYTES) {
      const take = Math.min(buf.length, MAX_CAPTURE_BYTES - capturedBytes);
      chunks.push(buf.subarray(0, take));
      capturedBytes += take;
    }
    if (totalBytes > MAX_CAPTURE_BYTES) truncated = true;
  });
  return () => ({
    text: Buffer.concat(chunks).toString('utf8'),
    totalBytes,
    capturedBytes,
    truncated,
  });
}

async function raceWithTimeout(promise, timeoutMs) {
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

async function terminateChild(child, exitPromise) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  let result = await raceWithTimeout(exitPromise, TERMINATION_GRACE_MS);
  if (result !== null) return result;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  result = await raceWithTimeout(exitPromise, TERMINATION_GRACE_MS);
  if (result === null) {
    fail('CHILD_TERMINATION_FAILED', 'Gemini child did not terminate after SIGKILL');
  }
  return result;
}

function isSafePromptToken(token) {
  return typeof token === 'string' && token.length > 0 && !token.startsWith('-');
}

export async function runLocalGeminiPrompt({
  config,
  promptArgv,
  parentEnv = process.env,
  tempParent = os.tmpdir(),
  runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  backendTimeoutMs = DEFAULT_ADAPTER_BACKEND_TIMEOUT_MS,
  healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  if (!isPlainObject(config) || typeof config.geminiRoot !== 'string' || config.geminiRoot.length === 0) {
    fail('INVALID_CONFIG', 'runLocalGeminiPrompt requires an already-validated local config');
  }
  if (
    config.schemaVersion !== LOCAL_CONFIG_SCHEMA_VERSION ||
    config.backend !== SUPPORTED_BACKEND ||
    typeof config.backendModel !== 'string' ||
    config.backendModel.length === 0 ||
    !isSafeClientModel(config.clientModel)
  ) {
    fail('INVALID_CONFIG', 'local config failed the runner secondary invariant check');
  }
  try {
    validateBackendOrigin(config.backendOrigin);
  } catch {
    fail('INVALID_CONFIG', 'local config backendOrigin is not literal loopback');
  }
  if (!Array.isArray(promptArgv) || promptArgv.length === 0 || !promptArgv.every(isSafePromptToken)) {
    fail(
      'UNSUPPORTED_ARGV',
      'prompt must be one or more non-flag argv tokens; the launcher owns all Gemini CLI arguments and forwards no caller flags',
    );
  }
  if (!isPositiveSafeInteger(runTimeoutMs, MAX_RUN_TIMEOUT_MS)) {
    fail('INVALID_CONFIG', `runTimeoutMs must be a positive integer <= ${MAX_RUN_TIMEOUT_MS}`);
  }
  if (!isPositiveSafeInteger(backendTimeoutMs, MAX_ADAPTER_BACKEND_TIMEOUT_MS)) {
    fail('INVALID_CONFIG', `backendTimeoutMs must be a positive integer <= ${MAX_ADAPTER_BACKEND_TIMEOUT_MS}`);
  }
  if (!isPositiveSafeInteger(healthTimeoutMs, MAX_HEALTH_TIMEOUT_MS)) {
    fail('INVALID_CONFIG', `healthTimeoutMs must be a positive integer <= ${MAX_HEALTH_TIMEOUT_MS}`);
  }
  if (typeof fetchImpl !== 'function') fail('INVALID_CONFIG', 'fetchImpl must be a function');

  const prompt = promptArgv.join(' ');
  let preflightRoot;
  let effectiveParentEnv;
  let adapter;
  let runtime;
  let child;
  let exitPromise;

  try {
    preflightRoot = mkdtempSync(path.join(tempParent, 'gemini-local-preflight-'));
    chmodSync(preflightRoot, 0o700);
    effectiveParentEnv = buildIsolatedParentEnvironment(parentEnv, preflightRoot);

    const preflightReport = runPhaseBPreflight({
      workspaceDir: preflightRoot,
      environment: effectiveParentEnv,
      osHome: preflightRoot,
    });
    if (!preflightReport.allowed) {
      fail('PREFLIGHT_BLOCKED', `local preflight blocked: ${preflightReport.blockers.join(', ')}`);
    }

    const healthy = await checkBackendHealth(config.backendOrigin, {
      fetchImpl,
      timeoutMs: healthTimeoutMs,
    });
    if (!healthy) {
      fail('BACKEND_UNHEALTHY', 'local backend failed its /health check; refusing to launch Gemini');
    }

    const distribution = resolvePinnedGeminiDistribution(config.geminiRoot);

    adapter = createAdapterServer({
      backendOrigin: config.backendOrigin,
      backendModel: config.backendModel,
      backendTimeoutMs,
      fetchImpl,
    });
    const adapterOrigin = await new Promise((resolve, reject) => {
      adapter.once('error', reject);
      adapter.listen(0, '127.0.0.1', () => {
        const { port } = adapter.address();
        resolve(`http://127.0.0.1:${port}`);
      });
    });

    const contract = buildLaunchContract(preflightReport, adapterOrigin);
    // An empty core list prevents every built-in Gemini tool from being
    // registered. The harmless empty wrapper the pinned client still emits is
    // accepted by C1; real function declarations remain rejected there.
    contract.isolatedSettings.tools = {
      ...contract.isolatedSettings.tools,
      core: [],
    };

    runtime = materializePhaseBRuntime({
      contract,
      parentEnv: effectiveParentEnv,
      tempParent,
    });
    verifyPhaseBRuntime(runtime);
    verifyNoPinnedGeminiEnvSource(runtime);
    reverifyPinnedEntrypoint(distribution);

    const childEnvironment = buildLocalLaunchEnvironment(runtime);
    const launcherArgs = Object.freeze([
      distribution.entrypoint,
      '--model', config.clientModel,
      '--prompt', prompt,
      '--output-format', OUTPUT_FORMAT,
    ]);

    child = spawn(process.execPath, launcherArgs, {
      cwd: runtime.workingDirectory,
      env: childEnvironment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdoutSnapshot = createBoundedCapture(child.stdout);
    const stderrSnapshot = createBoundedCapture(child.stderr);

    exitPromise = new Promise((resolve) => {
      let settled = false;
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        resolve({ kind: 'spawn-error', error });
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        resolve({ kind: 'exit', code, signal });
      });
    });

    const outcome = await raceWithTimeout(exitPromise, runTimeoutMs);
    if (outcome === null) {
      await terminateChild(child, exitPromise);
      fail('CHILD_TIMEOUT', 'Gemini child timed out before completing');
    }
    if (outcome.kind === 'spawn-error') fail('CHILD_SPAWN_FAILED', 'Gemini child failed to spawn');

    const stdout = stdoutSnapshot();
    const stderr = stderrSnapshot();

    if (outcome.code !== 0) {
      if (process.env.GEMINI_LOCAL_RUNNER_DEBUG === '1') {
        console.error('[runner-debug] stdout:', stdout.text);
        console.error('[runner-debug] stderr:', stderr.text);
      }
      fail(
        'CHILD_NONZERO_EXIT',
        `Gemini child exited with code ${outcome.code}${outcome.signal ? ` (signal ${outcome.signal})` : ''}`,
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(stdout.text);
    } catch {
      fail('CHILD_OUTPUT_INVALID', 'Gemini child did not produce valid JSON output');
    }
    if (!isPlainObject(parsed)) fail('CHILD_OUTPUT_INVALID', 'Gemini child JSON output was not an object');
    if (parsed.error) {
      fail('CHILD_OUTPUT_ERROR', `Gemini child reported an error: ${parsed.error?.message ?? 'unknown'}`);
    }
    if (typeof parsed.response !== 'string') {
      fail('CHILD_OUTPUT_INVALID', 'Gemini child JSON output is missing a string "response" field');
    }

    return Object.freeze({
      response: parsed.response,
      clientModel: config.clientModel,
      backendModel: config.backendModel,
      child: Object.freeze({
        exitCode: outcome.code,
        signal: outcome.signal,
        stdoutBytes: stdout.totalBytes,
        stderrBytes: stderr.totalBytes,
      }),
    });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null && exitPromise) {
      try { await terminateChild(child, exitPromise); } catch {}
    }
    if (adapter) {
      try { await new Promise((resolve) => adapter.close(() => resolve())); } catch {}
    }
    if (runtime) {
      try { cleanupPhaseBRuntime(runtime); } catch {}
    }
    if (preflightRoot) {
      try { rmSync(preflightRoot, { recursive: true, force: true }); } catch {}
    }
  }
}
