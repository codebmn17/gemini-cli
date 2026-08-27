/**
 * SPDX-License-Identifier: Apache-2.0
 * C4 managed-launch resource-bound regressions.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildManagedLlamaServerArgs,
  ensureBackendReady,
  loadManagedLaunchConfig,
  ManagedBackendError,
} from '../lib/managed-backend.mjs';
import { resolveLayout } from '../lib/paths.mjs';

const launch = Object.freeze({
  modelPath: '/models/qwen3.5-q6_k.gguf',
});
const config = Object.freeze({
  backendModel: 'qwen3.5-4b-uncensored-q6k',
});
const endpoint = Object.freeze({
  host: '127.0.0.1',
  port: '8090',
});
const acceptedPreC4Args = Object.freeze([
  '-m', '/models/qwen3.5-q6_k.gguf',
  '--host', '127.0.0.1',
  '--port', '8090',
  '-a', 'qwen3.5-4b-uncensored-q6k',
  '--no-webui',
  '--offline',
]);

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function argvSha256(args) {
  return sha256(JSON.stringify(args));
}

function healthyResponse() {
  return new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fullConfig() {
  return Object.freeze({
    backendOrigin: 'http://127.0.0.1:8090',
    backendModel: 'qwen3.5-4b-uncensored-q6k',
  });
}

function writeLaunchConfig(layout, { serverPath, serverContent, modelPath, modelContent }) {
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

test('Android managed argv adds only the proven mobile-safe resource bounds', () => {
  const args = buildManagedLlamaServerArgs(launch, config, endpoint, 'android');

  assert.deepEqual(args, [
    ...acceptedPreC4Args,
    '-c', '8192',
    '-np', '1',
    '--no-warmup',
  ]);
  assert.equal(args.filter((arg) => arg === '-c').length, 1);
  assert.equal(args.filter((arg) => arg === '-np').length, 1);
  assert.equal(args.filter((arg) => arg === '--no-warmup').length, 1);
  assert.equal(args.includes('--host'), true);
  assert.equal(args.includes('127.0.0.1'), true);
  assert.equal(args.includes('--offline'), true);
  assert.equal(args.includes('--no-webui'), true);
  assert.equal(args.includes('--reasoning'), false);
  assert.equal(args.includes('off'), false);
});

test('Linux and other non-Android managed argv remain at the accepted pre-C4 form', () => {
  assert.deepEqual(buildManagedLlamaServerArgs(launch, config, endpoint, 'linux'), acceptedPreC4Args);
  assert.deepEqual(buildManagedLlamaServerArgs(launch, config, endpoint, 'darwin'), acceptedPreC4Args);
});

test('managed resource bounds are launcher-owned and cannot be supplied through launch config', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'gl-c4-launch-'));
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
    writeFileSync(
      layout.backendLaunchConfigPath,
      JSON.stringify({
        schemaVersion: 1,
        serverPath,
        serverSha256: sha256(serverContent),
        modelPath,
        modelSha256: sha256(modelContent),
        serverArgs: ['--reasoning', 'off'],
      }) + '\n',
    );

    assert.throws(
      () => loadManagedLaunchConfig({ HOME: home }),
      (error) => error instanceof ManagedBackendError && error.category === 'MANAGED_CONFIG_INVALID',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('healthy managed backend with legacy state is not reused across a launcher-policy change', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'gl-c4-policy-'));
  try {
    const layout = resolveLayout({ HOME: home });
    mkdirSync(layout.configDir, { recursive: true });
    mkdirSync(layout.backendRuntimeDir, { recursive: true });

    const serverPath = path.join(home, 'llama-server');
    const modelPath = path.join(home, 'model.gguf');
    const serverContent = '#!/bin/sh\nexit 0\n';
    const modelContent = 'fake-gguf';
    const currentConfig = fullConfig();
    writeFileSync(serverPath, serverContent);
    chmodSync(serverPath, 0o755);
    writeFileSync(modelPath, modelContent);
    writeLaunchConfig(layout, { serverPath, serverContent, modelPath, modelContent });

    writeFileSync(
      layout.backendStatePath,
      JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        procStartTicks: null,
        backendOrigin: currentConfig.backendOrigin,
        backendModel: currentConfig.backendModel,
        serverPath,
        serverSha256: sha256(serverContent),
        modelPath,
        modelSha256: sha256(modelContent),
        startedAt: new Date().toISOString(),
      }) + '\n',
    );

    let spawnCalled = false;
    await assert.rejects(
      () => ensureBackendReady({
        config: currentConfig,
        env: { HOME: home },
        fetchImpl: async () => healthyResponse(),
        spawnImpl: () => {
          spawnCalled = true;
          throw new Error('must not spawn');
        },
      }),
      (error) =>
        error instanceof ManagedBackendError &&
        error.category === 'MANAGED_STATE_CONFLICT' &&
        String(error.message).includes('launch policy'),
    );
    assert.equal(spawnCalled, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('healthy managed backend is not reused after the pinned launch model changes', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'gl-c4-model-change-'));
  try {
    const layout = resolveLayout({ HOME: home });
    mkdirSync(layout.configDir, { recursive: true });
    mkdirSync(layout.backendRuntimeDir, { recursive: true });

    const serverPath = path.join(home, 'llama-server');
    const oldModelPath = path.join(home, 'old-model.gguf');
    const newModelPath = path.join(home, 'new-model.gguf');
    const serverContent = '#!/bin/sh\nexit 0\n';
    const oldModelContent = 'old-fake-gguf';
    const newModelContent = 'new-fake-gguf';
    const currentConfig = fullConfig();

    writeFileSync(serverPath, serverContent);
    chmodSync(serverPath, 0o755);
    writeFileSync(oldModelPath, oldModelContent);
    writeFileSync(newModelPath, newModelContent);
    writeLaunchConfig(layout, {
      serverPath,
      serverContent,
      modelPath: newModelPath,
      modelContent: newModelContent,
    });

    const oldArgs = buildManagedLlamaServerArgs(
      { modelPath: oldModelPath },
      currentConfig,
      { host: '127.0.0.1', port: '8090' },
    );
    writeFileSync(
      layout.backendStatePath,
      JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        procStartTicks: null,
        backendOrigin: currentConfig.backendOrigin,
        backendModel: currentConfig.backendModel,
        serverPath,
        serverSha256: sha256(serverContent),
        modelPath: oldModelPath,
        modelSha256: sha256(oldModelContent),
        startedAt: new Date().toISOString(),
        launchArgvSha256: argvSha256(oldArgs),
      }) + '\n',
    );

    await assert.rejects(
      () => ensureBackendReady({
        config: currentConfig,
        env: { HOME: home },
        fetchImpl: async () => healthyResponse(),
        spawnImpl: () => {
          throw new Error('must not spawn');
        },
      }),
      (error) => error instanceof ManagedBackendError && error.category === 'MANAGED_STATE_CONFLICT',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
