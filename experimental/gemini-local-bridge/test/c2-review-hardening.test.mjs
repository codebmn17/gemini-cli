/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Focused regressions for the independent C2 review hardening pass.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  checkBackendHealth,
  runLocalGeminiPrompt,
  LocalRunError,
  MAX_HEALTH_BODY_BYTES,
  MAX_HEALTH_TIMEOUT_MS,
} from '../lib/local-gemini-runner.mjs';
import { main } from '../lib/cli.mjs';

const bundleRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');

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

test('checkBackendHealth rejects a non-loopback origin before invoking fetch', async () => {
  let called = false;
  const healthy = await checkBackendHealth('https://example.com', {
    timeoutMs: 100,
    fetchImpl: async () => {
      called = true;
      throw new Error('must not be called');
    },
  });
  assert.equal(healthy, false);
  assert.equal(called, false);
});

test('checkBackendHealth rejects invalid timeout values before invoking fetch', async () => {
  for (const timeoutMs of [0, -1, Number.NaN, MAX_HEALTH_TIMEOUT_MS + 1]) {
    let called = false;
    const healthy = await checkBackendHealth('http://127.0.0.1:9', {
      timeoutMs,
      fetchImpl: async () => {
        called = true;
        throw new Error('must not be called');
      },
    });
    assert.equal(healthy, false);
    assert.equal(called, false);
  }
});

test('checkBackendHealth rejects an oversized loopback health body without unbounded buffering', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', padding: 'x'.repeat(MAX_HEALTH_BODY_BYTES + 1024) }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await checkBackendHealth(origin), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('runLocalGeminiPrompt secondary config gate blocks an external origin before any fetch', async () => {
  let called = false;
  const forgedConfig = Object.freeze({
    schemaVersion: 1,
    backend: 'llama.cpp',
    backendOrigin: 'https://example.com',
    backendModel: 'qwen-test-backend',
    clientModel: 'local-test-client',
    geminiRoot: '/not/reached',
  });

  await assert.rejects(
    () => runLocalGeminiPrompt({
      config: forgedConfig,
      promptArgv: ['hi'],
      fetchImpl: async () => {
        called = true;
        throw new Error('must not be called');
      },
    }),
    (error) => error instanceof LocalRunError && error.category === 'INVALID_CONFIG',
  );
  assert.equal(called, false);
});

test('local config source uses kernel no-follow/nonblocking open flags after lstat', () => {
  const source = readFileSync(path.join(bundleRoot, 'lib', 'local-config.mjs'), 'utf8');
  assert.match(source, /O_NOFOLLOW/);
  assert.match(source, /O_NONBLOCK/);
  assert.match(source, /openSync\(targetPath,\s*fsConstants\.O_RDONLY \| noFollow \| nonBlock\)/);
});

test('runner refuses to silently continue if SIGKILL still does not terminate the Gemini child', () => {
  const source = readFileSync(path.join(bundleRoot, 'lib', 'local-gemini-runner.mjs'), 'utf8');
  assert.match(source, /CHILD_TERMINATION_FAILED/);
  assert.match(source, /Gemini child did not terminate after SIGKILL/);
});

test('built-in help accurately describes the C2 config-gated prompt path', async () => {
  const s = stringIO();
  const code = await main(['help'], {}, s.io);
  assert.equal(code, 0);
  assert.match(s.stdout, /configured local backend/);
  assert.match(s.stdout, /never falls back to hosted Gemini/);
  assert.doesNotMatch(s.stdout, /anything else.*FAILS CLOSED/i);
  assert.equal(s.stderr, '');
});
