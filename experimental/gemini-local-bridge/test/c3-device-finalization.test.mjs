/**
 * SPDX-License-Identifier: Apache-2.0
 * Regressions derived from the first real Termux C3 device run.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  runLocalGeminiPrompt,
  LocalRunError,
  DEFAULT_RUN_TIMEOUT_MS,
  DEFAULT_ADAPTER_BACKEND_TIMEOUT_MS,
} from '../lib/local-gemini-runner.mjs';
import {
  ensureBackendReady,
  loadManagedLaunchConfig,
  ManagedBackendError,
} from '../lib/managed-backend.mjs';
import { resolveLayout } from '../lib/paths.mjs';

function tempHome(prefix = 'gl-c3-final-') {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function minimalConfig(backendOrigin = 'http://127.0.0.1:9') {
  return Object.freeze({
    schemaVersion: 1,
    backend: 'llama.cpp',
    backendOrigin,
    backendModel: 'qwen-test-backend',
    clientModel: 'local-test-client',
    geminiRoot: '/not-reached-by-these-tests',
  });
}

function unhealthyResponse() {
  return new Response(JSON.stringify({ status: 'loading' }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
}

function healthyResponse() {
  return new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function writeLaunchConfig(layout, { serverPath, modelPath, serverContent, modelContent }) {
  writeFileSync(
    layout.backendLaunchConfigPath,
    JSON.stringify({
      schemaVersion: 1,
      serverPath,
      serverSha256: sha256(serverContent),
      modelPath,
      modelSha256: sha256(modelContent),
    }) + '\n',
  );
}

test('device-found IDE setting in caller HOME no longer blocks isolated local preflight', async () => {
  const home = tempHome();
  try {
    mkdirSync(path.join(home, '.gemini'), { recursive: true });
    writeFileSync(
      path.join(home, '.gemini', 'settings.json'),
      JSON.stringify({ ide: { enabled: true } }) + '\n',
    );

    let fetchCalled = false;
    await assert.rejects(
      () => runLocalGeminiPrompt({
        config: minimalConfig(),
        promptArgv: ['hello'],
        parentEnv: { HOME: home },
        tempParent: home,
        fetchImpl: async () => {
          fetchCalled = true;
          return unhealthyResponse();
        },
      }),
      (error) =>
        error instanceof LocalRunError &&
        error.category === 'BACKEND_UNHEALTHY' &&
        !String(error.message).includes('ide-mode-enabled-in-settings'),
    );
    assert.equal(fetchCalled, true, 'isolated preflight must advance to the backend health gate');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('isolated preflight still blocks real inherited proxy state before any backend fetch', async () => {
  const home = tempHome();
  try {
    let fetchCalled = false;
    await assert.rejects(
      () => runLocalGeminiPrompt({
        config: minimalConfig(),
        promptArgv: ['hello'],
        parentEnv: { HOME: home, HTTPS_PROXY: 'http://127.0.0.1:9999' },
        tempParent: home,
        fetchImpl: async () => {
          fetchCalled = true;
          return healthyResponse();
        },
      }),
      (error) =>
        error instanceof LocalRunError &&
        error.category === 'PREFLIGHT_BLOCKED' &&
        String(error.message).includes('inherited-proxy-present'),
    );
    assert.equal(fetchCalled, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('mobile local inference defaults are bounded but no longer the old 30-second cliff', () => {
  assert.ok(DEFAULT_RUN_TIMEOUT_MS >= 5 * 60_000);
  assert.ok(DEFAULT_ADAPTER_BACKEND_TIMEOUT_MS >= 4 * 60_000);
  assert.ok(DEFAULT_ADAPTER_BACKEND_TIMEOUT_MS < DEFAULT_RUN_TIMEOUT_MS);
});

test('managed launch config is explicit, hash-pinned, absolute, regular-file-only, and no-follow', () => {
  const home = tempHome();
  try {
    const layout = resolveLayout({ HOME: home });
    mkdirSync(layout.configDir, { recursive: true });
    const serverPath = path.join(home, 'llama-server');
    const modelPath = path.join(home, 'model.gguf');
    const serverContent = '#!/bin/sh\nexit 0\n';
    const modelContent = 'fake-gguf';
    writeFileSync(serverPath, serverContent);
    chmodSync(serverPath, 0o755);
    writeFileSync(modelPath, modelContent);

    writeLaunchConfig(layout, { serverPath, modelPath, serverContent, modelContent });
    const config = loadManagedLaunchConfig({ HOME: home });
    assert.equal(config.serverPath, serverPath);
    assert.equal(config.modelPath, modelPath);
    assert.equal(config.serverSha256, sha256(serverContent));
    assert.equal(config.modelSha256, sha256(modelContent));

    writeFileSync(modelPath, 'tampered-gguf');
    assert.throws(
      () => loadManagedLaunchConfig({ HOME: home }),
      (error) => error instanceof ManagedBackendError && error.category === 'MANAGED_ARTIFACT_MISMATCH',
    );

    writeFileSync(modelPath, modelContent);
    rmSync(layout.backendLaunchConfigPath);
    const realConfig = path.join(home, 'launch-real.json');
    writeFileSync(
      realConfig,
      JSON.stringify({
        schemaVersion: 1,
        serverPath,
        serverSha256: sha256(serverContent),
        modelPath,
        modelSha256: sha256(modelContent),
      }) + '\n',
    );
    symlinkSync(realConfig, layout.backendLaunchConfigPath);
    assert.throws(
      () => loadManagedLaunchConfig({ HOME: home }),
      (error) => error instanceof ManagedBackendError && error.category === 'MANAGED_CONFIG_INVALID',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('ensureBackendReady reuses an already-healthy backend without launch config or spawn', async () => {
  const home = tempHome();
  try {
    let spawnCalled = false;
    const result = await ensureBackendReady({
      config: minimalConfig('http://127.0.0.1:8080'),
      env: { HOME: home },
      fetchImpl: async () => healthyResponse(),
      spawnImpl: () => {
        spawnCalled = true;
        throw new Error('must not spawn');
      },
    });
    assert.equal(result.ready, true);
    assert.equal(result.started, false);
    assert.equal(result.mode, 'reused-healthy');
    assert.equal(spawnCalled, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('ensureBackendReady starts only the hash-pinned loopback llama-server with owned argv', async () => {
  const home = tempHome();
  try {
    const layout = resolveLayout({ HOME: home });
    mkdirSync(layout.configDir, { recursive: true });
    const serverPath = path.join(home, 'llama-server');
    const modelPath = path.join(home, 'model.gguf');
    const serverContent = '#!/bin/sh\nexit 0\n';
    const modelContent = 'fake-gguf';
    writeFileSync(serverPath, serverContent);
    chmodSync(serverPath, 0o755);
    writeFileSync(modelPath, modelContent);
    writeLaunchConfig(layout, { serverPath, modelPath, serverContent, modelContent });

    let healthCalls = 0;
    let captured = null;
    const fakeChild = new EventEmitter();
    fakeChild.pid = process.pid;
    fakeChild.unref = () => {};

    const result = await ensureBackendReady({
      config: minimalConfig('http://127.0.0.1:8090'),
      env: { HOME: home, PATH: process.env.PATH ?? '' },
      fetchImpl: async () => {
        healthCalls += 1;
        return healthCalls === 1 ? unhealthyResponse() : healthyResponse();
      },
      spawnImpl: (file, args, options) => {
        captured = { file, args, options };
        queueMicrotask(() => fakeChild.emit('spawn'));
        return fakeChild;
      },
      startupTimeoutMs: 5_000,
    });

    assert.equal(result.started, true);
    assert.equal(captured.file, serverPath);
    assert.equal(captured.options.shell, false);
    assert.equal(captured.options.detached, true);
    assert.deepEqual(captured.args, [
      '-m', modelPath,
      '--host', '127.0.0.1',
      '--port', '8090',
      '-a', 'qwen-test-backend',
      '--no-webui',
      '--offline',
    ]);
    assert.equal('GEMINI_API_KEY' in captured.options.env, false);
    assert.equal('HTTPS_PROXY' in captured.options.env, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
