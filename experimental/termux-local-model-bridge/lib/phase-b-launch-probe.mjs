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

function readRegularFileNoFollow(filePath, maxBytes, label) {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | noFollow,
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
  });
}

function buildLaunchContract(preflightReport, recorderOrigin) {
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateChild(child, exitPromise) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
  }

  let result = await Promise.race([
    exitPromise,
    delay(TERMINATION_GRACE_MS).then(() => null),
  ]);
  if (result !== null) return result;

  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  result = await Promise.race([
    exitPromise,
    delay(TERMINATION_GRACE_MS).then(() => null),
  ]);
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

    // This is the last state check before the first real process spawn.
    verifyPhaseBRuntime(runtime);

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

    const timeoutPromise = delay(timeoutMs).then(() => ({ kind: 'timeout' }));
    const firstOutcome = await Promise.race([
      firstRecordPromise,
      exitPromise,
      timeoutPromise,
    ]);

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
