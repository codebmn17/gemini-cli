import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  AUTH_CANDIDATES,
  PINNED_GEMINI_CLI_COMMIT,
  PINNED_GEMINI_CLI_VERSION,
  buildAuthRoutingContract,
} from './phase-b-auth-routing.mjs';
import { createRecorderServer } from './phase-b-recorder.mjs';
import {
  cleanupPhaseBRuntime,
  materializePhaseBRuntime,
  verifyPhaseBRuntime,
} from './phase-b-runtime.mjs';
import {
  CONTROL_ENV_KEYS,
  PROXY_ENV_KEYS,
  SENSITIVE_ENV_KEYS,
  presenceMap,
} from './phase-b-preflight.mjs';

export const PHASE_B_LAUNCH_PROBE_SCHEMA_VERSION = 1;
export const HARMLESS_PROBE_PROMPT =
  'Reply with exactly PHASE_B_LOCAL_PROBE.';
export const DEFAULT_LAUNCH_TIMEOUT_MS = 15_000;
export const MAX_LAUNCH_TIMEOUT_MS = 30_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_CAPTURE_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 1000;
const EXPECTED_PACKAGE_NAME = '@google/gemini-cli';
const EXPECTED_BIN_RELATIVE_PATH = 'bundle/gemini.js';

function fail(message, code = 'PHASE_B_LAUNCH_PROBE_BLOCKED') {
  const error = new Error(message);
  error.code = code;
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

function requireExactOptions(value) {
  if (!isPlainObject(value)) fail('launch probe options must be a plain object');
  const allowed = new Set([
    'geminiRoot',
    'preflightReport',
    'parentEnv',
    'tempParent',
    'timeoutMs',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`unknown launch probe option: ${key}`);
  }
  if (typeof value.geminiRoot !== 'string' || value.geminiRoot.length === 0) {
    fail('geminiRoot must be a non-empty path');
  }
  return value;
}

function requireTimeoutMs(value) {
  if (
    !Number.isInteger(value) ||
    value < 100 ||
    value > MAX_LAUNCH_TIMEOUT_MS
  ) {
    fail(
      `timeoutMs must be an integer from 100 through ${MAX_LAUNCH_TIMEOUT_MS}`,
    );
  }
  return value;
}

// A preflight report only proves the environment it was generated from was
// safe; it says nothing about the environment the launch actually runs in
// unless the two are the same snapshot. Reusing phase-b-preflight.mjs's own
// exported key lists and presenceMap() (not duplicating them, so this can't
// silently drift from what the preflight itself checks) to require that every
// sensitive/proxy/control variable's *presence* is unchanged between the two.
// This is intentionally a presence check, not a value check: the preflight
// report itself never carries the actual values (only booleans), so this
// cannot compare or leak values either, and it stays a narrow, bounded
// addition rather than a general environment-attestation system.
function requireConsistentPreflightEnvironment(preflightReport, parentEnv) {
  const inherited = preflightReport?.inherited;
  if (!isPlainObject(inherited)) {
    fail('preflight report is missing the inherited-environment snapshot');
  }
  const groups = [
    ['sensitive', SENSITIVE_ENV_KEYS],
    ['proxy', PROXY_ENV_KEYS],
    ['control', CONTROL_ENV_KEYS],
  ];
  for (const [group, keys] of groups) {
    const expected = inherited[group];
    if (!isPlainObject(expected)) {
      fail(`preflight report inherited.${group} is missing or invalid`);
    }
    const current = presenceMap(parentEnv, keys);
    for (const key of keys) {
      if (expected[key] !== current[key]) {
        fail(
          'current environment no longer matches the environment the preflight report was generated from',
        );
      }
    }
  }
}

function readRegularFileNoFollow(filePath, maxBytes, label) {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  // O_NONBLOCK: opening a FIFO for O_RDONLY alone blocks until a writer
  // opens the other end, hanging this call (and the whole probe) forever if
  // geminiRoot's package.json is replaced with a FIFO. Non-blocking open has
  // no effect on reads from a genuine regular file, and the isFile() check
  // right below still rejects a FIFO immediately once opened. Matches the
  // O_NONBLOCK pattern already used by this same file's bin/ CLI wrapper.
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | noFollow,
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) fail(`${label} must be a regular file`);
    if (stat.size > maxBytes) fail(`${label} is too large`);
    const text = fs.readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      fail(`${label} is too large`);
    }
    return text;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function resolvePinnedGeminiDistribution(geminiRoot) {
  if (typeof geminiRoot !== 'string' || geminiRoot.length === 0) {
    fail('geminiRoot must be a non-empty path');
  }

  const requestedRoot = path.resolve(geminiRoot);
  const requestedStat = fs.lstatSync(requestedRoot);
  if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) {
    fail('geminiRoot must be a real directory');
  }
  const realRoot = fs.realpathSync(requestedRoot);
  if (realRoot !== requestedRoot) {
    fail('geminiRoot must not contain symlink path components');
  }

  const manifestPath = path.join(realRoot, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(
      readRegularFileNoFollow(
        manifestPath,
        MAX_MANIFEST_BYTES,
        'Gemini package manifest',
      ),
    );
  } catch (error) {
    if (error?.code === 'PHASE_B_LAUNCH_PROBE_BLOCKED') throw error;
    fail('Gemini package manifest is invalid JSON');
  }

  if (!isPlainObject(manifest)) fail('Gemini package manifest is invalid');
  if (manifest.name !== EXPECTED_PACKAGE_NAME) {
    fail('Gemini package name does not match pinned distribution');
  }
  if (manifest.version !== PINNED_GEMINI_CLI_VERSION) {
    fail('Gemini package version does not match pinned distribution');
  }
  if (
    !isPlainObject(manifest.bin) ||
    manifest.bin.gemini !== EXPECTED_BIN_RELATIVE_PATH
  ) {
    fail('Gemini package bin entry does not match pinned distribution');
  }

  const entrypoint = path.join(realRoot, EXPECTED_BIN_RELATIVE_PATH);
  const relative = path.relative(realRoot, entrypoint);
  if (
    relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    fail('Gemini entrypoint escapes distribution root');
  }
  const entryStat = fs.lstatSync(entrypoint);
  if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
    fail('Gemini entrypoint must be a regular non-symlink file');
  }
  if (fs.realpathSync(entrypoint) !== entrypoint) {
    fail('Gemini entrypoint must not traverse symlink path components');
  }

  return Object.freeze({
    root: realRoot,
    entrypoint,
    entrypointIdentity: Object.freeze({
      dev: entryStat.dev,
      ino: entryStat.ino,
    }),
  });
}

// child_process.spawn() takes the executable as a path string re-resolved by
// the OS at spawn time, not a held descriptor -- Node has no exec-by-fd
// primitive, so the window between resolvePinnedGeminiDistribution's checks
// and the actual spawn() call below can be narrowed but not eliminated by
// this API. Re-checking the entrypoint's identity as the very last thing
// before spawn (after the recorder/runtime setup that would otherwise sit
// inside the exposed window) keeps that window to a handful of synchronous
// statements.
export function reverifyPinnedEntrypoint(distribution) {
  const stat = fs.lstatSync(distribution.entrypoint);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail('Gemini entrypoint changed before spawn');
  }
  if (
    stat.dev !== distribution.entrypointIdentity.dev ||
    stat.ino !== distribution.entrypointIdentity.ino
  ) {
    fail('Gemini entrypoint identity changed before spawn');
  }
}

export function buildLaunchContract(preflightReport, recorderOrigin) {
  const contract = structuredClone(
    buildAuthRoutingContract({
      candidate: AUTH_CANDIDATES.USE_GEMINI,
      recorderUrl: recorderOrigin,
      preflightReport,
    }),
  );

  // Pinned v0.55.1 gates extension/update network checks on this setting.
  // This launch-only clone deliberately does not alter accepted PR #4/#5.
  contract.isolatedSettings.general.enableAutoUpdate = false;

  // Pinned userStartupWarnings.ts's folderTrustCheck throws a fatal
  // FatalUntrustedWorkspaceError for any headless (--prompt) invocation in an
  // untrusted folder -- which this isolated, freshly created cwd always is,
  // by design, since nothing ever writes a trustedFolders rule for it. Pinned
  // isFolderTrustEnabled() short-circuits that check (and checkPathTrust's
  // "folder-trust-disabled" branch, used everywhere else trust is consulted)
  // to isTrusted=true the moment security.folderTrust.enabled is false, with
  // no dependency on GEMINI_CLI_TRUST_WORKSPACE or --skip-trust -- both of
  // which remain untouched here and stay on the forbidden/masked lists.
  // This is deliberately narrower than either broad bypass: it only ever
  // flips the *trust conclusion* for this one throwaway directory, not an
  // env var or argv flag a future launcher path could accidentally forward
  // elsewhere. Safe specifically because the cwd this trust conclusion
  // applies to is always empty (verified immediately before spawn) and the
  // isolated GEMINI_CLI_HOME has no pre-existing state either, so there is no
  // real user/workspace settings content for the now-open workspace-merge
  // gate to actually admit; and because every trust-gated behavior this
  // contract cares about (approval mode, tools.allowed, IDE mode, workspace
  // policy loading) is already independently pinned above and does not rely
  // on the untrusted-folder fallback to reach its safe value.
  contract.isolatedSettings.security.folderTrust = { enabled: false };
  return contract;
}

function buildLaunchEnvironment(runtime) {
  const childEnvironment = Object.create(null);
  Object.assign(childEnvironment, runtime.childEnvironment);

  // Pinned packages/cli/index.ts skips its parent/child relaunch when this is
  // exactly "true", leaving one directly managed Node process for this probe.
  childEnvironment.GEMINI_CLI_NO_RELAUNCH = 'true';

  // Pinned getExperiments() reads GEMINI_EXP before deciding there is no
  // CodeAssist server. Prevent an inherited path from injecting experiment
  // flags or reading unrelated user state during the bounded launch.
  childEnvironment.GEMINI_EXP = '';

  return childEnvironment;
}

function createBoundedCapture(stream) {
  let totalBytes = 0;
  let capturedBytes = 0;
  let truncated = false;

  stream.on('data', (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    totalBytes += bytes;
    if (capturedBytes < MAX_CAPTURE_BYTES) {
      capturedBytes += Math.min(bytes, MAX_CAPTURE_BYTES - capturedBytes);
    }
    if (totalBytes > MAX_CAPTURE_BYTES) truncated = true;
  });

  return () =>
    Object.freeze({
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
    fail('Gemini child did not terminate after SIGKILL');
  }
  return result;
}

function validateRecorderProof(record) {
  if (!isPlainObject(record)) fail('recorder did not return a valid record');
  if (record.method !== 'POST') fail('Gemini request was not POST');
  if (
    typeof record.path !== 'string' ||
    !record.path.includes('/models/') ||
    !(
      record.path.endsWith(':generateContent') ||
      record.path.endsWith(':streamGenerateContent')
    )
  ) {
    fail('Gemini request did not target a generate-content model route');
  }
  if (record.contentType !== 'application/json') {
    fail('Gemini request was not JSON');
  }
  if (!Number.isInteger(record.bodyBytes) || record.bodyBytes <= 0) {
    fail('Gemini request body was empty');
  }
  if (!isPlainObject(record.auth)) fail('Gemini request auth record is invalid');
  if (record.auth.xGoogApiKey !== 'placeholder-match') {
    fail('Gemini request did not use the local placeholder x-goog-api-key');
  }
  if (record.auth.authorizationPresent !== false) {
    fail('Gemini request unexpectedly contained Authorization');
  }
  if (record.auth.privilegedUserIdPresent !== false) {
    fail('Gemini request unexpectedly contained privileged user id');
  }
  return true;
}

export async function runPhaseBLaunchProbe(options) {
  const normalized = requireExactOptions(options);
  const {
    geminiRoot,
    preflightReport,
    parentEnv = process.env,
    tempParent = os.tmpdir(),
    timeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
  } = normalized;
  requireTimeoutMs(timeoutMs);
  requireConsistentPreflightEnvironment(preflightReport, parentEnv);

  const distribution = resolvePinnedGeminiDistribution(geminiRoot);

  let runtime;
  let recorder;
  let child;
  let firstRecord;
  let firstRecordResolve;
  let recorderRecordCount = 0;
  let exitPromise;

  const firstRecordPromise = new Promise((resolve) => {
    firstRecordResolve = resolve;
  });

  try {
    recorder = createRecorderServer({
      host: '127.0.0.1',
      port: 0,
      onRecord(record) {
        recorderRecordCount += 1;
        if (firstRecord === undefined) {
          firstRecord = record;
          firstRecordResolve({ kind: 'record', record });
          if (
            child &&
            child.exitCode === null &&
            child.signalCode === null
          ) {
            child.kill('SIGTERM');
          }
        }
      },
    });
    const address = await recorder.listen();
    const recorderOrigin = `http://127.0.0.1:${address.port}`;

    const contract = buildLaunchContract(preflightReport, recorderOrigin);
    runtime = materializePhaseBRuntime({
      contract,
      parentEnv,
      tempParent,
    });

    // These are the last state checks before the first real process spawn.
    verifyPhaseBRuntime(runtime);
    reverifyPinnedEntrypoint(distribution);

    const childEnvironment = buildLaunchEnvironment(runtime);
    const launcherArgs = Object.freeze([
      distribution.entrypoint,
      '--prompt',
      HARMLESS_PROBE_PROMPT,
      '--output-format',
      'json',
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

    let launchTimeout;
    const timeoutPromise = new Promise((resolve) => {
      launchTimeout = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    });
    let firstOutcome;
    try {
      firstOutcome = await Promise.race([
        firstRecordPromise,
        exitPromise,
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(launchTimeout);
    }

    if (firstOutcome.kind === 'spawn-error') {
      fail('Gemini child failed to spawn');
    }
    if (firstOutcome.kind === 'exit') {
      fail('Gemini child exited before reaching the local recorder');
    }
    if (firstOutcome.kind === 'timeout') {
      await terminateChild(child, exitPromise);
      fail('Gemini child timed out before reaching the local recorder');
    }

    validateRecorderProof(firstOutcome.record);
    const exit = await terminateChild(child, exitPromise);

    return Object.freeze({
      schemaVersion: PHASE_B_LAUNCH_PROBE_SCHEMA_VERSION,
      pinnedGeminiCliVersion: PINNED_GEMINI_CLI_VERSION,
      pinnedGeminiCliCommit: PINNED_GEMINI_CLI_COMMIT,
      candidate: AUTH_CANDIDATES.USE_GEMINI,
      success: true,
      recorderOrigin,
      recorderRecordCount,
      request: firstOutcome.record,
      child: Object.freeze({
        outcome: exit.kind,
        exitCode: exit.kind === 'exit' ? exit.code : null,
        signal: exit.kind === 'exit' ? exit.signal : null,
        stdout: stdoutSnapshot(),
        stderr: stderrSnapshot(),
      }),
      launch: Object.freeze({
        executable: 'current-node',
        entrypoint: EXPECTED_BIN_RELATIVE_PATH,
        forwardedCallerArgs: false,
        prompt: 'fixed-harmless-probe',
        outputFormat: 'json',
        noRelaunch: true,
        autoUpdateDisabled: true,
      }),
    });
  } finally {
    if (
      child &&
      child.exitCode === null &&
      child.signalCode === null &&
      exitPromise
    ) {
      try {
        await terminateChild(child, exitPromise);
      } catch {
        // Preserve the primary fail-closed result where one already exists.
      }
    }
    if (recorder) {
      try {
        await recorder.close();
      } catch {
        // Runtime cleanup below must still run.
      }
    }
    if (runtime) {
      cleanupPhaseBRuntime(runtime);
    }
  }
}
