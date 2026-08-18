/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * C2: lib/local-gemini-runner.mjs orchestration, plus lib/run.mjs's/
 * lib/cli.mjs's dispatch once a valid local config exists.
 *
 * Two tiers, deliberately:
 *  - The fast/deterministic tests below use a tiny fake "Gemini CLI"
 *    stand-in script (writeFakeGeminiCli) that satisfies
 *    resolvePinnedGeminiDistribution's manifest/entrypoint checks but is
 *    NOT the real pinned build -- it only needs to behave like *a* real
 *    Gemini CLI child process (spawned via node, reads the launcher-owned
 *    argv, talks to GOOGLE_GEMINI_BASE_URL, prints JsonFormatter-shaped
 *    stdout) closely enough to exercise the runner's OWN orchestration:
 *    health-check gating, cleanup on every path, timeout/kill handling,
 *    output parsing, and the clientModel/backendModel identity boundary.
 *    This mirrors how test/llama-cpp-adapter.test.mjs already tests
 *    against a fake loopback llama.cpp server rather than a real one, and
 *    keeps this file's default run fast and independent of any
 *    session-specific build artifact.
 *  - Exactly one test, clearly marked, uses the real pinned Gemini CLI
 *    0.55.1 build, gated behind the GEMINI_LOCAL_TEST_PINNED_GEMINI_ROOT
 *    environment variable -- see that test for why the real ~150MB+ build
 *    cannot itself be committed to this repository and so must be supplied
 *    out of band. Without that variable set, it SKIPS itself with a clear
 *    reason rather than being silently absent or fabricating a pass.
 *
 * Every test here uses a fresh temp HOME/tempParent -- never the real
 * developer machine's ~/.config or ~/.local.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { validateLocalConfig } from '../lib/local-config.mjs';
import {
  runLocalGeminiPrompt,
  checkBackendHealth,
  LocalRunError,
  DEFAULT_RUN_TIMEOUT_MS,
  MAX_RUN_TIMEOUT_MS,
} from '../lib/local-gemini-runner.mjs';
import { attemptRun, FAIL_CLOSED_EXIT_CODE, LOCAL_RUN_FAILURE_EXIT_CODE } from '../lib/run.mjs';
import { main } from '../lib/cli.mjs';
import { PINNED_GEMINI_CLI_VERSION } from '../vendor/phase-b/lib/phase-b-auth-routing.mjs';
import { PROXY_ENV_KEYS } from '../vendor/phase-b/lib/phase-b-preflight.mjs';

const EXPECTED_PACKAGE_NAME = '@google/gemini-cli';
const EXPECTED_BIN_RELATIVE_PATH = 'bundle/gemini.js';
const CANARY_API_KEY = 'CANARY-REAL-SECRET-MUST-NEVER-REACH-BACKEND';

// This sandbox's ambient shell routes outbound HTTPS through a
// pre-configured agent proxy (HTTPS_PROXY/https_proxy/etc are set for
// every process here); that is a property of this dev/CI container, not of
// a real Termux/plain-Linux target device. runPhaseBPreflight() correctly
// refuses to proceed at all when it sees proxy env vars in the *parent*
// shell (see PROXY_ENV_KEYS / 'inherited-proxy-present' in
// vendor/phase-b/lib/phase-b-preflight.mjs) -- it does not trust that later
// masking is sufficient and wants a demonstrably clean parent shell, which
// is the correct, un-weakened behavior. Every test below runs against a
// synthetic parentEnv that represents that target "clean shell" scenario by
// stripping exactly the vendor-defined PROXY_ENV_KEYS (imported, not
// duplicated) from a copy of process.env. Nothing in vendor/phase-b is
// modified or bypassed -- the same check still runs against this env and
// would still correctly block if any of those keys were left in.
function cleanParentEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of PROXY_ENV_KEYS) delete env[key];
  return { ...env, ...overrides };
}

function makeTempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

// See test/cli.test.mjs's identical helper for why this is a fake,
// manifest-valid stand-in rather than the real pinned Gemini CLI build.
function writeFakeGeminiDistribution(root) {
  mkdirSync(path.join(root, 'bundle'), { recursive: true });
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: EXPECTED_PACKAGE_NAME,
      version: PINNED_GEMINI_CLI_VERSION,
      bin: { gemini: EXPECTED_BIN_RELATIVE_PATH },
      type: 'module',
    }) + '\n',
  );
  return root;
}

// A minimal stand-in "Gemini CLI" process. In 'proxy' mode (the default) it
// makes a REAL Gemini-shaped HTTP request to whatever GOOGLE_GEMINI_BASE_URL
// Phase-B isolation configured for it -- exactly the one thing this file's
// fake distribution cannot itself prove (that the *real* CLI's actual wire
// format round-trips) -- and translates the result back into
// JsonFormatter's stdout shape, so every test below still exercises the
// real C1 adapter and real Phase-B env isolation, just not the real CLI
// binary. Other modes simulate specific child-process failure shapes.
const FAKE_GEMINI_CLI_SOURCE = `
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}
const model = argValue('--model');
const prompt = argValue('--prompt');
const mode = process.env.FAKE_GEMINI_MODE || 'proxy';

function printJson(obj) {
  process.stdout.write(JSON.stringify(obj));
}

async function main() {
  if (mode === 'hang') {
    setInterval(() => {}, 1_000_000);
    return;
  }
  if (mode === 'crash') {
    process.exitCode = 7;
    return;
  }
  if (mode === 'badjson') {
    process.stdout.write('not json at all');
    return;
  }
  if (mode === 'noresponse') {
    printJson({ session_id: 'fake' });
    return;
  }

  const baseUrl = process.env.GOOGLE_GEMINI_BASE_URL;
  const apiKey = process.env.GEMINI_API_KEY;
  if (process.env.FAKE_GEMINI_DEBUG_FILE) {
    const fs = await import('node:fs');
    fs.writeFileSync(process.env.FAKE_GEMINI_DEBUG_FILE, JSON.stringify({ baseUrl, apiKey }));
  }
  try {
    const res = await fetch(baseUrl + '/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey || '' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
    });
    const json = await res.json();
    if (!res.ok || json.error) {
      printJson({
        session_id: 'fake',
        error: { type: 'Error', message: JSON.stringify(json.error || { httpStatus: res.status }), code: res.status },
      });
      return;
    }
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    printJson({
      session_id: 'fake',
      response: text,
      debugModelVersion: json.modelVersion,
      debugBaseUrl: baseUrl,
      debugApiKey: apiKey,
    });
  } catch (error) {
    printJson({ session_id: 'fake', error: { type: 'Error', message: String((error && error.message) || error), code: 0 } });
  }
}

main();
`;

function writeFakeGeminiCli(root) {
  writeFakeGeminiDistribution(root);
  writeFileSync(path.join(root, 'bundle', 'gemini.js'), FAKE_GEMINI_CLI_SOURCE);
  return root;
}

const FIXED_REPLY = 'C2_FAKE_CLI_OK';

// A minimal loopback llama.cpp-compatible backend. Records every request it
// receives (method, url, headers, body) so tests can assert on exactly what
// the C1 adapter forwarded -- and, just as importantly, what it did NOT.
function startFakeBackend({ replyText = FIXED_REPLY, healthy = true, chatError = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: { ...req.headers } };
      requests.push(record);
      if (req.method === 'GET' && req.url === '/health') {
        if (!healthy) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 503, message: 'loading' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          body = null;
        }
        record.body = body;
        if (chatError || !body) {
          res.writeHead(200, { 'content-type': 'application/json' });
          // Deliberately missing choices[] -- BACKEND_INVALID_RESPONSE.
          res.end(JSON.stringify({}));
          return;
        }
        if (body.stream === true) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: replyText }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: replyText }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  return {
    requests,
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function buildConfig({ geminiRoot, backendOrigin, backendModel = 'qwen-test-backend', clientModel = 'local-test-client' }) {
  return validateLocalConfig({
    schemaVersion: 1,
    backend: 'llama.cpp',
    backendOrigin,
    backendModel,
    clientModel,
    geminiRoot,
  });
}

// --- checkBackendHealth ----------------------------------------------------

test('checkBackendHealth returns true only for a real 200 {status:"ok"} response', async () => {
  const backend = startFakeBackend({ healthy: true });
  const origin = await backend.listen();
  try {
    assert.equal(await checkBackendHealth(origin), true);
  } finally {
    await backend.close();
  }
});

test('checkBackendHealth returns false for a 503 loading response, never throws', async () => {
  const backend = startFakeBackend({ healthy: false });
  const origin = await backend.listen();
  try {
    assert.equal(await checkBackendHealth(origin), false);
  } finally {
    await backend.close();
  }
});

test('checkBackendHealth returns false, never throws, when nothing is listening', async () => {
  assert.equal(await checkBackendHealth('http://127.0.0.1:1'), false);
});

test('checkBackendHealth respects a bounded timeout against a stalled backend', async () => {
  const server = http.createServer(() => {
    /* never respond */
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const started = Date.now();
    const healthy = await checkBackendHealth(origin, { timeoutMs: 200 });
    assert.equal(healthy, false);
    assert.ok(Date.now() - started < 5000, 'health check must not hang indefinitely');
  } finally {
    server.close();
  }
});

// --- runLocalGeminiPrompt: argv/timeout input validation -------------------

test('runLocalGeminiPrompt rejects promptArgv tokens shaped like flags', async () => {
  const dir = makeTempDir('gl-c2-argv-');
  try {
    const geminiRoot = writeFakeGeminiCli(path.join(dir, 'gemini-root'));
    const config = buildConfig({ geminiRoot, backendOrigin: 'http://127.0.0.1:9' });
    await assert.rejects(
      () => runLocalGeminiPrompt({ config, promptArgv: ['--model', 'evil'], parentEnv: cleanParentEnv() }),
      (error) => error instanceof LocalRunError && error.category === 'UNSUPPORTED_ARGV',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLocalGeminiPrompt rejects an empty promptArgv', async () => {
  const dir = makeTempDir('gl-c2-empty-');
  try {
    const geminiRoot = writeFakeGeminiCli(path.join(dir, 'gemini-root'));
    const config = buildConfig({ geminiRoot, backendOrigin: 'http://127.0.0.1:9' });
    await assert.rejects(
      () => runLocalGeminiPrompt({ config, promptArgv: [], parentEnv: cleanParentEnv() }),
      (error) => error instanceof LocalRunError && error.category === 'UNSUPPORTED_ARGV',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLocalGeminiPrompt rejects a runTimeoutMs above MAX_RUN_TIMEOUT_MS', async () => {
  const dir = makeTempDir('gl-c2-timeoutbound-');
  try {
    const geminiRoot = writeFakeGeminiCli(path.join(dir, 'gemini-root'));
    const config = buildConfig({ geminiRoot, backendOrigin: 'http://127.0.0.1:9' });
    await assert.rejects(
      () =>
        runLocalGeminiPrompt({
          config,
          promptArgv: ['hi'],
          parentEnv: cleanParentEnv(),
          runTimeoutMs: MAX_RUN_TIMEOUT_MS + 1,
        }),
      (error) => error instanceof LocalRunError && error.category === 'INVALID_CONFIG',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- runLocalGeminiPrompt: backend health gates the launch -----------------

test('runLocalGeminiPrompt refuses to launch Gemini when the backend is unhealthy, and never spawns a child', async () => {
  const dir = makeTempDir('gl-c2-unhealthy-');
  try {
    const geminiRoot = writeFakeGeminiCli(path.join(dir, 'gemini-root'));
    const backend = startFakeBackend({ healthy: false });
    const origin = await backend.listen();
    try {
      const config = buildConfig({ geminiRoot, backendOrigin: origin });
      await assert.rejects(
        () => runLocalGeminiPrompt({ config, promptArgv: ['hi'], parentEnv: cleanParentEnv() }),
        (error) => error instanceof LocalRunError && error.category === 'BACKEND_UNHEALTHY',
      );
      // Only the /health probe should have reached the backend -- a healthy
      // check is the gate that decides whether anything else may happen.
      assert.ok(backend.requests.every((r) => r.url === '/health'));
    } finally {
      await backend.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- runLocalGeminiPrompt: the real success path, identity boundary --------

test('runLocalGeminiPrompt succeeds end to end and keeps clientModel/backendModel strictly separate', async () => {
  const dir = makeTempDir('gl-c2-success-');
  const tempParent = makeTempDir('gl-c2-success-runtime-');
  try {
    const geminiRoot = writeFakeGeminiCli(path.join(dir, 'gemini-root'));
    const backend = startFakeBackend({ replyText: FIXED_REPLY });
    const origin = await backend.listen();
    try {
      const config = buildConfig({
        geminiRoot,
        backendOrigin: origin,
        backendModel: 'qwen-test-backend',
        clientModel: 'local-test-client',
      });
      const result = await runLocalGeminiPrompt({
        config,
        promptArgv: ['Reply', 'with', 'exactly', `${FIXED_REPLY}.`],
        parentEnv: cleanParentEnv(),
        tempParent,
      });
      assert.equal(result.response, FIXED_REPLY);
      assert.equal(result.clientModel, 'local-test-client');
      assert.equal(result.backendModel, 'qwen-test-backend');
      assert.equal(result.child.exitCode, 0);

      const chatRequest = backend.requests.find((r) => r.url === '/v1/chat/completions');
      assert.ok(chatRequest, 'expected the fake backend to have received a chat-completions request');
      // The backend must see the BACKEND model identity, never the
      // Gemini-side clientModel string, anywhere in the request it received.
      assert.equal(chatRequest.body.model, 'qwen-test-backend');
      assert.ok(!JSON.stringify(chatRequest.body).includes('local-test-client'));
      // No Gemini-side credential/auth header ever reaches the backend.
      assert.equal(chatRequest.headers['x-goog-api-key'], undefined);
      assert.equal(chatRequest.headers.authorization, undefined);

      // Cleanup: no Phase-B runtime directory should remain under our
      // private tempParent once the call has returned.
      assert.deepEqual(readdirSync(tempParent), []);
    } finally {
      await backend.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tempParent, { recursive: true, force: true });
  }
});

test('runLocalGeminiPrompt never forwards a real parent-environment credential to the backend, and the child sees only the Phase-B placeholder', async () => {
  const dir = makeTempDir('gl-c2-canary-');
  try {
    const geminiRoot = writeFakeGeminiCli(path.join(dir, 'gemini-root'));
    const backend = startFakeBackend({ replyText: FIXED_REPLY });
    const origin = await backend.listen();
    const debugFile = path.join(dir, 'debug.json');
    try {
      const config = buildConfig({ geminiRoot, backendOrigin: origin });
      const result = await runLocalGeminiPrompt({
        config,
        promptArgv: ['hi'],
        // Simulates the real user's actual Gemini API key sitting in their
        // shell -- Phase-B's isolated runtime must mask this to its own
        // fixed placeholder before the child ever sees it.
        parentEnv: cleanParentEnv({ GEMINI_API_KEY: CANARY_API_KEY, FAKE_GEMINI_DEBUG_FILE: debugFile }),
      });
      assert.equal(result.response, FIXED_REPLY);
      assert.ok(!JSON.stringify(backend.requests).includes(CANARY_API_KEY));

      // Direct, positive check (not just "the canary wasn't seen"): the
      // fake CLI stand-in writes the API key value it actually received in
      // its own environment to a side channel outside its JSON stdout
      // contract, proving Phase-B's fixed placeholder -- not the real
      // canary -- is what reached the child process itself.
      const debugText = readFileSync(debugFile, 'utf8');
      const debug = JSON.parse(debugText);
      assert.notEqual(debug.apiKey, CANARY_API_KEY);
      assert.equal(typeof debug.apiKey, 'string');
      assert.ok(debug.apiKey.length > 0);
    } finally {
      await backend.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- runLocalGeminiPrompt: child-process failure shapes ---------------------

test('runLocalGeminiPrompt reports CHILD_TIMEOUT and still terminates a hung child within the grace window', async () => {
  const dir = makeTempDir('gl-c2-hang-');
  try {
    const geminiRoot = writeFakeGeminiCli(path.join(dir, 'gemini-root'));
    const backend = startFakeBackend();
    const origin = await backend.listen();
    try {
      const config = buildConfig({ geminiRoot, backendOrigin: origin });
      const started = Date.now();
      await assert.rejects(
        () =>
          runLocalGeminiPrompt({
            config,
            promptArgv: ['hi'],
            parentEnv: cleanParentEnv({ FAKE_GEMINI_MODE: 'hang' }),
            runTimeoutMs: 500,
          }),
        (error) => error instanceof LocalRunError && error.category === 'CHILD_TIMEOUT',
      );
      assert.ok(Date.now() - started < 10_000, 'timeout+termination must not itself hang the test');
    } finally {
      await backend.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLocalGeminiPrompt reports CHILD_NONZERO_EXIT for a crashing child', async () => {
  const dir = makeTempDir('gl-c2-crash-');
  try {
    const geminiRoot = writeFakeGeminiCli(path.join(dir, 'gemini-root'));
    const backend = startFakeBackend();
    const origin = await backend.listen();
    try {
      const config = buildConfig({ geminiRoot, backendOrigin: origin });
      await assert.rejects(
        () =>
          runLocalGeminiPrompt({
            config,
            promptArgv: ['hi'],
            parentEnv: cleanParentEnv({ FAKE_GEMINI_MODE: 'crash' }),
          }),
        (error) => error instanceof LocalRunError && error.category === 'CHILD_NONZERO_EXIT',
      );
    } finally {
      await backend.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLocalGeminiPrompt reports CHILD_OUTPUT_INVALID for non-JSON stdout', async () => {
  const dir = makeTempDir('gl-c2-badjson-');
  try {
    const geminiRoot = writeFakeGeminiCli(path.join(dir, 'gemini-root'));
    const backend = startFakeBackend();
    const origin = await backend.listen();
    try {
      const config = buildConfig({ geminiRoot, backendOrigin: origin });
      await assert.rejects(
        () =>
          runLocalGeminiPrompt({
            config,
            promptArgv: ['hi'],
            parentEnv: cleanParentEnv({ FAKE_GEMINI_MODE: 'badjson' }),
          }),
        (error) => error instanceof LocalRunError && error.category === 'CHILD_OUTPUT_INVALID',
      );
    } finally {
      await backend.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLocalGeminiPrompt reports CHILD_OUTPUT_INVALID for valid JSON missing a string response field', async () => {
  const dir = makeTempDir('gl-c2-noresponse-');
  try {
    const geminiRoot = writeFakeGeminiCli(path.join(dir, 'gemini-root'));
    const backend = startFakeBackend();
    const origin = await backend.listen();
    try {
      const config = buildConfig({ geminiRoot, backendOrigin: origin });
      await assert.rejects(
        () =>
          runLocalGeminiPrompt({
            config,
            promptArgv: ['hi'],
            parentEnv: cleanParentEnv({ FAKE_GEMINI_MODE: 'noresponse' }),
          }),
        (error) => error instanceof LocalRunError && error.category === 'CHILD_OUTPUT_INVALID',
      );
    } finally {
      await backend.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLocalGeminiPrompt reports CHILD_OUTPUT_ERROR when the adapter itself reports an error', async () => {
  const dir = makeTempDir('gl-c2-adaptererror-');
  try {
    const geminiRoot = writeFakeGeminiCli(path.join(dir, 'gemini-root'));
    const backend = startFakeBackend({ chatError: true });
    const origin = await backend.listen();
    try {
      const config = buildConfig({ geminiRoot, backendOrigin: origin });
      await assert.rejects(
        () => runLocalGeminiPrompt({ config, promptArgv: ['hi'], parentEnv: cleanParentEnv() }),
        (error) => error instanceof LocalRunError && error.category === 'CHILD_OUTPUT_ERROR',
      );
    } finally {
      await backend.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLocalGeminiPrompt cleans up the Phase-B runtime directory on every failure path, not just success', async () => {
  const dir = makeTempDir('gl-c2-cleanup-');
  const tempParent = makeTempDir('gl-c2-cleanup-runtime-');
  try {
    const geminiRoot = writeFakeGeminiCli(path.join(dir, 'gemini-root'));
    const backend = startFakeBackend();
    const origin = await backend.listen();
    try {
      const config = buildConfig({ geminiRoot, backendOrigin: origin });
      for (const mode of ['crash', 'badjson', 'noresponse']) {
        await assert.rejects(() =>
          runLocalGeminiPrompt({
            config,
            promptArgv: ['hi'],
            parentEnv: cleanParentEnv({ FAKE_GEMINI_MODE: mode }),
            tempParent,
          }),
        );
      }
      assert.deepEqual(readdirSync(tempParent), [], 'expected no leftover runtime directories after any failure mode');
    } finally {
      await backend.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tempParent, { recursive: true, force: true });
  }
});

// --- run.mjs / cli.mjs dispatch once a valid config exists -----------------

function stringIO() {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write: (chunk) => { out += chunk; return true; } },
      stderr: { write: (chunk) => { err += chunk; return true; } },
    },
    get stdout() { return out; },
    get stderr() { return err; },
  };
}

function writeConfigFile(home, { backendOrigin, geminiRoot, backendModel = 'qwen-test-backend', clientModel = 'local-test-client' }) {
  const configDir = path.join(home, '.config', 'gemini-local-bridge');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, 'llama-cpp-adapter.json'),
    JSON.stringify({ schemaVersion: 1, backend: 'llama.cpp', backendOrigin, backendModel, clientModel, geminiRoot }) + '\n',
  );
}

test('attemptRun rejects flag-shaped argv before ever attempting a launch, even with a valid config', async () => {
  const home = makeTempDir('gl-c2-cli-flagargv-');
  try {
    const geminiRoot = writeFakeGeminiCli(path.join(home, 'gemini-root'));
    const backend = startFakeBackend();
    const origin = await backend.listen();
    try {
      writeConfigFile(home, { backendOrigin: origin, geminiRoot });
      const result = await attemptRun(['--model', 'gemini-2.5-pro'], cleanParentEnv({ HOME: home }));
      assert.equal(result.ok, false);
      assert.equal(result.exitCode, FAIL_CLOSED_EXIT_CODE);
      assert.match(result.message, /not accepted here/);
      assert.deepEqual(backend.requests, [], 'a rejected-argv call must never even reach the backend');
    } finally {
      await backend.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('attemptRun fails closed on empty argv with a valid config (interactive mode not supported yet)', async () => {
  const home = makeTempDir('gl-c2-cli-empty-');
  try {
    const geminiRoot = writeFakeGeminiCli(path.join(home, 'gemini-root'));
    writeConfigFile(home, { backendOrigin: 'http://127.0.0.1:9', geminiRoot });
    const result = await attemptRun([], cleanParentEnv({ HOME: home }));
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, FAIL_CLOSED_EXIT_CODE);
    assert.match(result.message, /Interactive mode and slash commands are not/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('attemptRun maps a real run failure to LOCAL_RUN_FAILURE_EXIT_CODE, never falling back to hosted Gemini', async () => {
  const home = makeTempDir('gl-c2-cli-runfail-');
  try {
    const geminiRoot = writeFakeGeminiCli(path.join(home, 'gemini-root'));
    writeConfigFile(home, { backendOrigin: 'http://127.0.0.1:1', geminiRoot });
    const result = await attemptRun(['hi'], cleanParentEnv({ HOME: home }));
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, LOCAL_RUN_FAILURE_EXIT_CODE);
    assert.match(result.message, /BACKEND_UNHEALTHY/);
    assert.match(result.message, /never falls back to hosted Gemini/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('cli.mjs main() runs a real prompt end to end once a valid config exists, and only then', async () => {
  const home = makeTempDir('gl-c2-cli-e2e-');
  try {
    const geminiRoot = writeFakeGeminiCli(path.join(home, 'gemini-root'));
    const backend = startFakeBackend({ replyText: FIXED_REPLY });
    const origin = await backend.listen();
    try {
      writeConfigFile(home, { backendOrigin: origin, geminiRoot });
      const s = stringIO();
      const code = await main(
        ['Reply', 'with', 'exactly', `${FIXED_REPLY}.`],
        cleanParentEnv({ HOME: home }),
        s.io,
      );
      assert.equal(code, 0);
      assert.equal(s.stdout.trim(), FIXED_REPLY);
      assert.equal(s.stderr, '');
    } finally {
      await backend.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- The mandatory real-pinned-Gemini-CLI integration test -----------------

// The real @google/gemini-cli 0.55.1 build is a large, freshly-built
// artifact (git worktree + npm workspace build), not something this
// repository can commit or that a generic CI checkout will have on disk.
// This test is the one place in this file (and, per the C2 task's own
// requirement, the one place in this whole slice) that must NOT substitute
// a mock for it. Point GEMINI_LOCAL_TEST_PINNED_GEMINI_ROOT at a verified
// checkout+build of https://github.com/google-gemini/gemini-cli at commit
// 41327e407da58aa01c409ef6685b7b5d379f295e (package.json version 0.55.1) to
// run it for real; without that variable set, this test SKIPS itself with a
// clear reason instead of silently passing or hanging CI. It was run for
// real, and passed, during this feature's own development -- see the C2
// final report for that evidence; it is not re-asserted here.
const REAL_GEMINI_ROOT = process.env.GEMINI_LOCAL_TEST_PINNED_GEMINI_ROOT;

test(
  'REAL pinned Gemini CLI 0.55.1 completes a prompt through the real C1 adapter to a fake backend',
  { skip: !REAL_GEMINI_ROOT && 'set GEMINI_LOCAL_TEST_PINNED_GEMINI_ROOT to a real, built pinned Gemini CLI 0.55.1 checkout to run this test' },
  async () => {
    const backend = startFakeBackend({ replyText: FIXED_REPLY });
    const origin = await backend.listen();
    try {
      const config = buildConfig({
        geminiRoot: REAL_GEMINI_ROOT,
        backendOrigin: origin,
        backendModel: 'qwen-test-backend',
        clientModel: 'local-test-client',
      });
      const result = await runLocalGeminiPrompt({
        config,
        promptArgv: ['Reply', 'with', 'exactly', `${FIXED_REPLY}.`],
        parentEnv: cleanParentEnv(),
        runTimeoutMs: 60_000,
      });
      assert.equal(result.response, FIXED_REPLY);
      assert.equal(result.clientModel, 'local-test-client');
      assert.equal(result.backendModel, 'qwen-test-backend');
      assert.equal(result.child.exitCode, 0);

      const chatRequest = backend.requests.find((r) => r.url === '/v1/chat/completions');
      assert.ok(chatRequest, 'the real Gemini CLI must have reached the fake backend through the real adapter');
      assert.equal(chatRequest.body.model, 'qwen-test-backend');
      assert.ok(!JSON.stringify(chatRequest.body).includes('local-test-client'));
      assert.equal(chatRequest.headers['x-goog-api-key'], undefined);
      assert.equal(chatRequest.headers.authorization, undefined);
      assert.ok(backend.requests.some((r) => r.url === '/health'));
    } finally {
      await backend.close();
    }
  },
);
