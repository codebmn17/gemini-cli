/**
 * SPDX-License-Identifier: Apache-2.0
 * C4 managed-launch resource-bound regressions.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildManagedLlamaServerArgs,
  ensureBackendReady,
  getBackendStatus,
  loadManagedLaunchConfig,
  ManagedBackendError,
  restartManagedBackend,
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

function tempHome(prefix) {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
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

function writeCurrentState(
  layout,
  { pid, currentConfig, serverPath, serverContent, modelPath, modelContent, launchArgvSha256 },
) {
  writeFileSync(
    layout.backendStatePath,
    JSON.stringify({
      schemaVersion: 1,
      pid,
      procStartTicks: null,
      backendOrigin: currentConfig.backendOrigin,
      backendModel: currentConfig.backendModel,
      serverPath,
      serverSha256: sha256(serverContent),
      modelPath,
      modelSha256: sha256(modelContent),
      startedAt: new Date().toISOString(),
      launchArgvSha256,
    }) + '\n',
  );
}

async function exitedChildPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const spawned = once(child, 'spawn');
  const closed = once(child, 'close');
  await spawned;
  const pid = child.pid;
  await closed;
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error?.code === 'ESRCH',
  );
  return pid;
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
  const home = tempHome('gl-c4-launch-');
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
  const home = tempHome('gl-c4-policy-');
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
  const home = tempHome('gl-c4-model-change-');
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

test('healthy backend removes dead managed state before requiring a missing launch config', async () => {
  const home = tempHome('gl-c4-dead-state-missing-launch-');
  try {
    const layout = resolveLayout({ HOME: home });
    mkdirSync(layout.configDir, { recursive: true });
    mkdirSync(layout.backendRuntimeDir, { recursive: true });

    const serverPath = path.join(home, 'old-llama-server');
    const modelPath = path.join(home, 'old-model.gguf');
    const serverContent = '#!/bin/sh\nexit 0\n';
    const modelContent = 'old-fake-gguf';
    const currentConfig = fullConfig();
    const oldArgs = buildManagedLlamaServerArgs({ modelPath }, currentConfig, endpoint);
    writeCurrentState(layout, {
      pid: await exitedChildPid(),
      currentConfig,
      serverPath,
      serverContent,
      modelPath,
      modelContent,
      launchArgvSha256: argvSha256(oldArgs),
    });

    let spawnCalled = false;
    const result = await ensureBackendReady({
      config: currentConfig,
      env: { HOME: home },
      fetchImpl: async () => healthyResponse(),
      spawnImpl: () => {
        spawnCalled = true;
        throw new Error('must not spawn');
      },
    });

    assert.deepEqual(result, { ready: true, started: false, mode: 'reused-healthy' });
    assert.equal(spawnCalled, false);
    assert.equal(existsSync(layout.backendStatePath), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('healthy backend removes dead managed state before comparing a changed launch identity', async () => {
  const home = tempHome('gl-c4-dead-state-changed-launch-');
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

    const oldArgs = buildManagedLlamaServerArgs({ modelPath: oldModelPath }, currentConfig, endpoint);
    writeCurrentState(layout, {
      pid: await exitedChildPid(),
      currentConfig,
      serverPath,
      serverContent,
      modelPath: oldModelPath,
      modelContent: oldModelContent,
      launchArgvSha256: argvSha256(oldArgs),
    });

    let spawnCalled = false;
    const result = await ensureBackendReady({
      config: currentConfig,
      env: { HOME: home },
      fetchImpl: async () => healthyResponse(),
      spawnImpl: () => {
        spawnCalled = true;
        throw new Error('must not spawn');
      },
    });

    assert.deepEqual(result, { ready: true, started: false, mode: 'reused-healthy' });
    assert.equal(spawnCalled, false);
    assert.equal(existsSync(layout.backendStatePath), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('healthy backend preserves and validates managed state replaced during the health check', async () => {
  const home = tempHome('gl-c4-state-replaced-during-health-');
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

    const currentArgs = buildManagedLlamaServerArgs({ modelPath }, currentConfig, endpoint);
    writeCurrentState(layout, {
      pid: await exitedChildPid(),
      currentConfig,
      serverPath,
      serverContent,
      modelPath,
      modelContent,
      launchArgvSha256: argvSha256(currentArgs),
    });

    let spawnCalled = false;
    const result = await ensureBackendReady({
      config: currentConfig,
      env: { HOME: home },
      fetchImpl: async () => {
        writeCurrentState(layout, {
          pid: process.pid,
          currentConfig,
          serverPath,
          serverContent,
          modelPath,
          modelContent,
          launchArgvSha256: argvSha256(currentArgs),
        });
        return healthyResponse();
      },
      spawnImpl: () => {
        spawnCalled = true;
        throw new Error('must not spawn');
      },
    });

    assert.deepEqual(result, {
      ready: true,
      started: false,
      mode: 'reused-healthy',
      pid: process.pid,
    });
    assert.equal(spawnCalled, false);
    assert.equal(existsSync(layout.backendStatePath), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('healthy backend with live managed state still rejects a missing launch identity', async () => {
  const home = tempHome('gl-c4-live-state-missing-launch-');
  try {
    const layout = resolveLayout({ HOME: home });
    mkdirSync(layout.configDir, { recursive: true });
    mkdirSync(layout.backendRuntimeDir, { recursive: true });

    const serverPath = path.join(home, 'llama-server');
    const modelPath = path.join(home, 'model.gguf');
    const serverContent = '#!/bin/sh\nexit 0\n';
    const modelContent = 'fake-gguf';
    const currentConfig = fullConfig();
    const currentArgs = buildManagedLlamaServerArgs({ modelPath }, currentConfig, endpoint);
    writeCurrentState(layout, {
      pid: process.pid,
      currentConfig,
      serverPath,
      serverContent,
      modelPath,
      modelContent,
      launchArgvSha256: argvSha256(currentArgs),
    });
    const stateBefore = readFileSync(layout.backendStatePath, 'utf8');

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
        String(error.message).includes('missing'),
    );

    assert.equal(spawnCalled, false);
    assert.equal(readFileSync(layout.backendStatePath, 'utf8'), stateBefore);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('healthy managed backend with matching current policy reuses the recorded PID without spawning', async () => {
  const home = tempHome('gl-c4-current-policy-');
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

    const currentArgs = buildManagedLlamaServerArgs({ modelPath }, currentConfig, endpoint);
    writeCurrentState(layout, {
      pid: process.pid,
      currentConfig,
      serverPath,
      serverContent,
      modelPath,
      modelContent,
      launchArgvSha256: argvSha256(currentArgs),
    });

    let spawnCalled = false;
    const result = await ensureBackendReady({
      config: currentConfig,
      env: { HOME: home },
      fetchImpl: async () => healthyResponse(),
      spawnImpl: () => {
        spawnCalled = true;
        throw new Error('must not spawn');
      },
    });

    assert.deepEqual(result, {
      ready: true,
      started: false,
      mode: 'reused-healthy',
      pid: process.pid,
    });
    assert.equal(spawnCalled, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('healthy managed backend with matching identity rejects an incorrect launch policy fingerprint', async () => {
  const home = tempHome('gl-c4-fingerprint-mismatch-');
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

    const currentArgs = buildManagedLlamaServerArgs({ modelPath }, currentConfig, endpoint);
    writeCurrentState(layout, {
      pid: process.pid,
      currentConfig,
      serverPath,
      serverContent,
      modelPath,
      modelContent,
      launchArgvSha256: argvSha256([...currentArgs, '--unexpected-policy-token']),
    });

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

test('status reports conflict when current launch identity selects a different model', async () => {
  const home = tempHome('gl-c4-status-model-change-');
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

    const oldArgs = buildManagedLlamaServerArgs({ modelPath: oldModelPath }, currentConfig, endpoint);
    writeCurrentState(layout, {
      pid: process.pid,
      currentConfig,
      serverPath,
      serverContent,
      modelPath: oldModelPath,
      modelContent: oldModelContent,
      launchArgvSha256: argvSha256(oldArgs),
    });

    const result = await getBackendStatus({
      config: currentConfig,
      env: { HOME: home },
      fetchImpl: async () => healthyResponse(),
    });

    assert.equal(result.status, 'state-conflict');
    assert.equal(result.healthy, true);
    assert.equal(result.managed, true);
    assert.equal(result.pid, process.pid);
    assert.match(result.detail, /restart/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('status reports managed-running for matching current launch identity without artifact rehash', async () => {
  const home = tempHome('gl-c4-status-current-');
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

    const currentArgs = buildManagedLlamaServerArgs({ modelPath }, currentConfig, endpoint);
    writeCurrentState(layout, {
      pid: process.pid,
      currentConfig,
      serverPath,
      serverContent,
      modelPath,
      modelContent,
      launchArgvSha256: argvSha256(currentArgs),
    });
    writeFileSync(modelPath, 'changed-after-managed-start');

    const result = await getBackendStatus({
      config: currentConfig,
      env: { HOME: home },
      fetchImpl: async () => healthyResponse(),
    });

    assert.equal(result.status, 'managed-running');
    assert.equal(result.healthy, true);
    assert.equal(result.managed, true);
    assert.equal(result.pid, process.pid);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('restart refuses to replace a live process whose managed ownership cannot be verified', async () => {
  const home = tempHome('gl-c4-restart-ownership-');
  let probeChild = null;
  let probeClosed = null;
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

    const probeScript = [
      "process.on('SIGTERM', () => process.send({ type: 'signal', signal: 'SIGTERM' }));",
      "process.send({ type: 'ready' });",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    probeChild = spawn(process.execPath, ['-e', probeScript], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    probeClosed = once(probeChild, 'close');
    const readyMessage = once(probeChild, 'message');
    await once(probeChild, 'spawn');
    assert.deepEqual((await readyMessage)[0], { type: 'ready' });
    const probeSignals = [];
    probeChild.on('message', (message) => {
      if (message?.type === 'signal') probeSignals.push(message.signal);
    });

    const currentArgs = buildManagedLlamaServerArgs({ modelPath }, currentConfig, endpoint);
    writeCurrentState(layout, {
      pid: probeChild.pid,
      currentConfig,
      serverPath,
      serverContent,
      modelPath,
      modelContent,
      launchArgvSha256: argvSha256(currentArgs),
    });

    let fetchCalled = false;
    await assert.rejects(
      () => restartManagedBackend({
        config: currentConfig,
        env: { HOME: home },
        fetchImpl: async () => {
          fetchCalled = true;
          return healthyResponse();
        },
      }),
      (error) =>
        error instanceof ManagedBackendError &&
        error.category === 'BACKEND_OWNERSHIP_UNVERIFIED' &&
        String(error.message).includes('refusing to signal'),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fetchCalled, false);
    assert.deepEqual(probeSignals, []);
    assert.doesNotThrow(() => process.kill(probeChild.pid, 0));
    assert.equal(probeChild.exitCode, null);
    assert.equal(probeChild.signalCode, null);
    assert.equal(existsSync(layout.backendStatePath), true);
  } finally {
    if (probeChild) {
      if (probeChild.exitCode === null && probeChild.signalCode === null) probeChild.kill('SIGKILL');
      await probeClosed;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
