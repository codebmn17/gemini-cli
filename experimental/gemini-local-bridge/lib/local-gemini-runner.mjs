/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * C2: the real host-side chain. Ties together an already-validated local
 * config (lib/local-config.mjs), the accepted Phase-B isolation primitives
 * (vendor/phase-b/ -- read-only, never modified), and the C1 adapter
 * (lib/llama-cpp-adapter.mjs) to actually launch the pinned Gemini CLI
 * against a local backend and return its response.
 *
 * This module is NOT `runPhaseBLaunchProbe()` and deliberately does not
 * call it. That probe is a bounded routing PROOF: fixed harmless prompt,
 * kills the child the instant the adapter/recorder sees the first request,
 * and reports only that one sanitized record -- exactly right for
 * independently proving PR #6's routing claim, wrong for a product runner
 * that needs the child to run to completion and return a real answer. What
 * IS reused here, unmodified, is every already-reviewed primitive the
 * probe itself composes: runPhaseBPreflight, resolvePinnedGeminiDistribution,
 * buildLaunchContract, materializePhaseBRuntime/verifyPhaseBRuntime,
 * verifyNoPinnedGeminiEnvSource, reverifyPinnedEntrypoint, and
 * cleanupPhaseBRuntime -- in the same order the probe uses them. Only the
 * probe's own top-level orchestration (first-request-then-kill,
 * `buildLaunchEnvironment`, bounded-capture/termination helpers -- none of
 * which are exported) is reimplemented, because that orchestration itself,
 * not the isolation it sits on top of, is what needs to differ for C2.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';

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
export const DEFAULT_RUN_TIMEOUT_MS = 30_000;
export const MAX_RUN_TIMEOUT_MS = 120_000;
const TERMINATION_GRACE_MS = 2_000;
const MAX_CAPTURE_BYTES = 1_000_000;
const CLIENT_MODEL_RE = /^local(-[a-zA-Z0-9._-]+|\/[a-zA-Z0-9._/-]+)?$/;

// Pinned Gemini CLI 0.55.1 flags (packages/cli/src/config/config.ts):
// --model/-m (string), --prompt/-p (string, headless trigger),
// --output-format/-o (choices: text|json|stream-json). The launcher owns
// all three; no caller-supplied flag is ever forwarded (see
// isSafePromptToken below and cli.mjs's own leading-"-" rejection).
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
  return (
    typeof value === 'string' &&
    CLIENT_MODEL_RE.test(value) &&
    !value.endsWith('flash')
  );
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
        try {
          await reader.cancel();
        } catch {
          // The response is already being rejected as unhealthy.
        }
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

/**
 * GET <backendOrigin>/health, per the pinned llama.cpp server contract
 * (ggml-org/llama.cpp commit 0021a77de0a8966059dc94548fb3b96654e0bb12,
 * tools/server/server.cpp + server-context.cpp): literal-loopback only,
 * 200 + {"status":"ok"} means ready; a loading/error response or anything
 * malformed is unhealthy. The response body is byte-bounded before JSON
 * parsing so even a broken local process cannot make this pre-launch probe
 * buffer unbounded data. Never throws -- callers decide what "not healthy"
 * means for them.
 */
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

/**
 * Mirrors vendor/phase-b/lib/phase-b-launch-probe.mjs's private (not
 * exported) `buildLaunchEnvironment()` exactly -- same two lines, same
 * pinned-source rationale (see that file's own comments beside them). Not
 * a vendor-file edit: the vendored file is immutable, so the two-line
 * augmentation it performs internally is reproduced here instead.
 */
function buildLocalLaunchEnvironment(runtime) {
  const childEnvironment = Object.create(null);
  Object.assign(childEnvironment, runtime.childEnvironment);
  childEnvironment.GEMINI_CLI_NO_RELAUNCH = 'true';
  childEnvironment.GEMINI_EXP = '';
  return childEnvironment;
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
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
  }
  let result = await raceWithTimeout(exitPromise, TERMINATION_GRACE_MS);
  if (result !== null) return result;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  result = await raceWithTimeout(exitPromise, TERMINATION_GRACE_MS);
  if (result === null) {
    fail(
      'CHILD_TERMINATION_FAILED',
      'Gemini child did not terminate after SIGKILL',
    );
  }
  return result;
}

/**
 * The launcher owns all Gemini CLI arguments (see module doc comment and
 * cli.mjs). A prompt token starting with "-" could otherwise be
 * shell-word-split into something that looks like a yargs flag once
 * joined; reject that shape here too as a second, independent gate below
 * cli.mjs's own leading-"-" rejection, rather than relying on only one
 * layer to hold.
 */
function isSafePromptToken(token) {
  return typeof token === 'string' && token.length > 0 && !token.startsWith('-');
}

/**
 * Runs the real C2 chain once: preflight -> backend health -> verify
 * pinned Gemini distribution -> start the C1 adapter -> materialize/verify
 * an isolated Phase-B runtime pointed at that adapter -> reverify the
 * entrypoint immediately before spawn -> spawn pinned Gemini headlessly
 * with a launcher-owned argv -> parse its JSON output -> clean up
 * everything on every path (success, any failure, timeout).
 *
 * `config` is expected to be the normalized object returned by
 * local-config.mjs. Critical network/model-identity invariants are checked
 * again here as a second boundary so direct callers cannot turn this exported
 * runner into an arbitrary-network or Gemini-model-rebranding path.
 */
export async function runLocalGeminiPrompt({
  config,
  promptArgv,
  parentEnv = process.env,
  tempParent = os.tmpdir(),
  runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
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
  if (!isPositiveSafeInteger(healthTimeoutMs, MAX_HEALTH_TIMEOUT_MS)) {
    fail('INVALID_CONFIG', `healthTimeoutMs must be a positive integer <= ${MAX_HEALTH_TIMEOUT_MS}`);
  }
  if (typeof fetchImpl !== 'function') {
    fail('INVALID_CONFIG', 'fetchImpl must be a function');
  }
  const prompt = promptArgv.join(' ');

  const preflightReport = runPhaseBPreflight({ environment: parentEnv });
  if (!preflightReport.allowed) {
    fail('PREFLIGHT_BLOCKED', `local preflight blocked: ${preflightReport.blockers.join(', ')}`);
  }

  // Checked before touching the adapter/runtime/Gemini distribution at all:
  // an unhealthy backend means there is nothing useful to isolate a runtime
  // or spawn a child for. This is a direct check of the real backend
  // origin, independent of the (not-yet-started) C1 adapter.
  const healthy = await checkBackendHealth(config.backendOrigin, {
    fetchImpl,
    timeoutMs: healthTimeoutMs,
  });
  if (!healthy) {
    fail('BACKEND_UNHEALTHY', 'local backend failed its /health check; refusing to launch Gemini');
  }

  // Freshly re-derived rather than reusing config-validation-time state, so
  // a geminiRoot that changed on disk between config load and this call is
  // still caught before any spawn.
  const distribution = resolvePinnedGeminiDistribution(config.geminiRoot);

  let adapter;
  let runtime;
  let child;
  let exitPromise;

  try {
    adapter = createAdapterServer({
      backendOrigin: config.backendOrigin,
      backendModel: config.backendModel,
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
    // Layered on top of the shared contract the same way buildLaunchContract
    // itself layers its own two probe-specific tweaks (enableAutoUpdate,
    // folderTrust) onto the cloned base -- new C2-only code, not a
    // vendor/phase-b edit. contract.isolatedSettings.tools.allowed=[] (set by
    // buildLaunchContract) only controls which tools skip the confirmation
    // dialog (settingsSchema.ts's "Tools" > "Allowed Tools" description); it
    // does not stop pinned Client.startChat()/setTools()
    // (packages/core/src/core/client.ts) from unconditionally sending
    // `tools: [{ functionDeclarations: toolRegistry.getFunctionDeclarations() }]`
    // on every request, headless prompts included. tools.core is the actual
    // registration allowlist (config.ts's createToolRegistry()/maybeRegister():
    // an empty coreTools array disables every built-in tool, since
    // `[].some(...)` is always false), and coreTools has no CLI-flag
    // equivalent -- only settings.tools.core reaches it (config.ts:
    // `coreTools: settings.tools?.core || undefined`). Forcing it empty here
    // is what makes toolRegistry.getFunctionDeclarations() actually empty, so
    // the wrapper the CLI sends is the harmless
    // `tools: [{ functionDeclarations: [] }]` shape
    // gemini-protocol.mjs's isHarmlessEmptyToolsWrapper() accepts -- C2 must
    // still never grant the child any real tool, so this is not optional.
    contract.isolatedSettings.tools = {
      ...contract.isolatedSettings.tools,
      core: [],
    };
    runtime = materializePhaseBRuntime({ contract, parentEnv, tempParent });

    // Last state checks before the real process spawn -- same order as the
    // accepted probe.
    verifyPhaseBRuntime(runtime);
    verifyNoPinnedGeminiEnvSource(runtime);
    reverifyPinnedEntrypoint(distribution);

    const childEnvironment = buildLocalLaunchEnvironment(runtime);
    const launcherArgs = Object.freeze([
      distribution.entrypoint,
      '--model',
      config.clientModel,
      '--prompt',
      prompt,
      '--output-format',
      OUTPUT_FORMAT,
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
    if (outcome.kind === 'spawn-error') {
      fail('CHILD_SPAWN_FAILED', 'Gemini child failed to spawn');
    }

    const stdout = stdoutSnapshot();
    const stderr = stderrSnapshot();

    if (outcome.code !== 0) {
      // Opt-in only, off by default: prints the (already bounded) child
      // output to this process's own stderr -- never sent anywhere, never
      // written to a file. LocalRunError itself intentionally carries no
      // child output, since callers must treat every failure category the
      // same fail-closed way regardless of what the real Gemini CLI printed;
      // this is strictly a local troubleshooting aid for a human running
      // gemini-local directly.
      if (process.env.GEMINI_LOCAL_RUNNER_DEBUG === '1') {
        console.error('[runner-debug] stdout:', stdout.text);
        console.error('[runner-debug] stderr:', stderr.text);
      }
      fail(
        'CHILD_NONZERO_EXIT',
        `Gemini child exited with code ${outcome.code}${outcome.signal ? ` (signal ${outcome.signal})` : ''}`,
      );
    }

    // packages/core/src/output/json-formatter.ts's JsonFormatter.format():
    // JSON.stringify({session_id?, response?, stats?, error?, warnings?}).
    let parsed;
    try {
      parsed = JSON.parse(stdout.text);
    } catch {
      fail('CHILD_OUTPUT_INVALID', 'Gemini child did not produce valid JSON output');
    }
    if (!isPlainObject(parsed)) {
      fail('CHILD_OUTPUT_INVALID', 'Gemini child JSON output was not an object');
    }
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
      try {
        await terminateChild(child, exitPromise);
      } catch {
        // Preserve whatever the primary result/error already is.
      }
    }
    if (adapter) {
      try {
        await new Promise((resolve) => adapter.close(() => resolve()));
      } catch {
        // Best-effort; runtime cleanup below must still run.
      }
    }
    if (runtime) {
      try {
        cleanupPhaseBRuntime(runtime);
      } catch {
        // Preserve the primary fail-closed result where one already exists.
      }
    }
  }
}
