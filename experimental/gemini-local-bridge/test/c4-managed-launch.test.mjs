/**
 * SPDX-License-Identifier: Apache-2.0
 * C4 managed-launch resource-bound regressions.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildManagedLlamaServerArgs,
  ensureBackendReady,
  getBackendStatus,
  loadManagedLaunchConfig,
  MANAGED_LAUNCH_CLAIM_STALE_MS,
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

function unhealthyResponse() {
  return new Response(JSON.stringify({ status: 'loading' }), {
    status: 503,
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

function createManagedFixture(prefix) {
  const home = tempHome(prefix);
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

  return Object.freeze({
    home,
    layout,
    serverPath,
    modelPath,
    serverContent,
    modelContent,
    currentConfig,
    currentArgs: buildManagedLlamaServerArgs({ modelPath }, currentConfig, endpoint),
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function concurrentLaunchHealthGate() {
  const bothInitialChecksEntered = deferred();
  const releaseInitialChecks = deferred();
  const postClaimCheckEntered = deferred();
  const releasePostClaimCheck = deferred();
  let initialChecks = 0;
  let postInitialChecks = 0;

  return Object.freeze({
    bothInitialChecksEntered: bothInitialChecksEntered.promise,
    releaseInitialChecks: releaseInitialChecks.resolve,
    postClaimCheckEntered: postClaimCheckEntered.promise,
    releasePostClaimCheck: releasePostClaimCheck.resolve,
    fetchImpl: async () => {
      if (initialChecks < 2) {
        initialChecks += 1;
        if (initialChecks === 2) bothInitialChecksEntered.resolve();
        await releaseInitialChecks.promise;
        return unhealthyResponse();
      }
      postInitialChecks += 1;
      if (postInitialChecks === 1) {
        postClaimCheckEntered.resolve();
        await releasePostClaimCheck.promise;
        return unhealthyResponse();
      }
      return healthyResponse();
    },
  });
}

function fakeSpawnedChild(pid = process.pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = () => {};
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

function launchClaimPath(layout) {
  return path.join(layout.backendRuntimeDir, 'llama-server-launch-claim');
}

function readLaunchClaimText(layout) {
  const claimPath = launchClaimPath(layout);
  const entries = readdirSync(claimPath);
  assert.equal(entries.length, 1);
  return readFileSync(path.join(claimPath, entries[0]), 'utf8');
}

function writeLaunchClaim(layout, {
  token = '11111111-1111-4111-8111-111111111111',
  ownerPid = process.pid,
  ownerProcStartTicks = null,
  createdAtMs = Date.now(),
} = {}) {
  const claimPath = launchClaimPath(layout);
  mkdirSync(claimPath, { mode: 0o700 });
  writeFileSync(
    path.join(claimPath, `owner-${token}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      token,
      ownerPid,
      ownerProcStartTicks,
      createdAtMs,
    }, null, 2)}\n`,
    { mode: 0o600 },
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

test('unhealthy path re-reads managed state written during the health check before spawning', async () => {
  const home = tempHome('gl-c4-unhealthy-state-created-');
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
    let spawnCalled = false;
    await assert.rejects(
      () => ensureBackendReady({
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
          return unhealthyResponse();
        },
        spawnImpl: () => {
          spawnCalled = true;
          throw new Error('must not spawn');
        },
      }),
      (error) => error instanceof ManagedBackendError && error.category === 'MANAGED_BACKEND_UNHEALTHY',
    );

    assert.equal(spawnCalled, false);
    assert.equal(JSON.parse(readFileSync(layout.backendStatePath, 'utf8')).pid, process.pid);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('unhealthy path does not delete live managed state that replaces a dead snapshot', async () => {
  const home = tempHome('gl-c4-unhealthy-state-replaced-');
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
    await assert.rejects(
      () => ensureBackendReady({
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
          return unhealthyResponse();
        },
        spawnImpl: () => {
          spawnCalled = true;
          throw new Error('must not spawn');
        },
      }),
      (error) => error instanceof ManagedBackendError && error.category === 'MANAGED_BACKEND_UNHEALTHY',
    );

    assert.equal(spawnCalled, false);
    assert.equal(JSON.parse(readFileSync(layout.backendStatePath, 'utf8')).pid, process.pid);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('claim winner reuses a backend that becomes healthy before spawn', async () => {
  const fixture = createManagedFixture('gl-c4-healthy-after-claim-');
  try {
    let healthCalls = 0;
    let spawnCalled = false;
    const result = await ensureBackendReady({
      config: fixture.currentConfig,
      env: { HOME: fixture.home },
      fetchImpl: async () => {
        healthCalls += 1;
        return healthCalls === 1 ? unhealthyResponse() : healthyResponse();
      },
      spawnImpl: () => {
        spawnCalled = true;
        throw new Error('must not spawn');
      },
    });

    assert.deepEqual(result, { ready: true, started: false, mode: 'reused-healthy' });
    assert.equal(spawnCalled, false);
    assert.equal(existsSync(launchClaimPath(fixture.layout)), false);
    assert.equal(existsSync(fixture.layout.backendStatePath), false);
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('exclusive launch ownership permits only one concurrent unhealthy caller to spawn', async () => {
  const fixture = createManagedFixture('gl-c4-concurrent-launch-');
  try {
    const gate = concurrentLaunchHealthGate();
    let spawnCalls = 0;
    const options = {
      config: fixture.currentConfig,
      env: { HOME: fixture.home },
      fetchImpl: gate.fetchImpl,
      spawnImpl: () => {
        spawnCalls += 1;
        return fakeSpawnedChild();
      },
      startupTimeoutMs: 5_000,
    };

    const calls = [ensureBackendReady(options), ensureBackendReady(options)];
    await gate.bothInitialChecksEntered;
    gate.releaseInitialChecks();
    await gate.postClaimCheckEntered;
    gate.releasePostClaimCheck();
    const results = await Promise.allSettled(calls);

    assert.equal(spawnCalls, 1);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    const rejection = results.find((result) => result.status === 'rejected').reason;
    assert.equal(rejection instanceof ManagedBackendError, true);
    assert.equal(rejection.category, 'MANAGED_LAUNCH_IN_PROGRESS');
    assert.equal(JSON.parse(readFileSync(fixture.layout.backendStatePath, 'utf8')).pid, process.pid);
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('concurrent dead-state cleanup still permits only one managed launch', async () => {
  const fixture = createManagedFixture('gl-c4-concurrent-dead-state-');
  try {
    writeCurrentState(fixture.layout, {
      pid: await exitedChildPid(),
      currentConfig: fixture.currentConfig,
      serverPath: fixture.serverPath,
      serverContent: fixture.serverContent,
      modelPath: fixture.modelPath,
      modelContent: fixture.modelContent,
      launchArgvSha256: argvSha256(fixture.currentArgs),
    });

    const gate = concurrentLaunchHealthGate();
    let spawnCalls = 0;
    const options = {
      config: fixture.currentConfig,
      env: { HOME: fixture.home },
      fetchImpl: gate.fetchImpl,
      spawnImpl: () => {
        spawnCalls += 1;
        return fakeSpawnedChild();
      },
      startupTimeoutMs: 5_000,
    };

    const calls = [ensureBackendReady(options), ensureBackendReady(options)];
    await gate.bothInitialChecksEntered;
    gate.releaseInitialChecks();
    await gate.postClaimCheckEntered;
    gate.releasePostClaimCheck();
    const results = await Promise.allSettled(calls);

    assert.equal(spawnCalls, 1);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejection = results.find((result) => result.status === 'rejected').reason;
    assert.equal(rejection instanceof ManagedBackendError, true);
    assert.equal(rejection.category, 'MANAGED_LAUNCH_IN_PROGRESS');
    assert.equal(JSON.parse(readFileSync(fixture.layout.backendStatePath, 'utf8')).pid, process.pid);
    assert.equal(existsSync(launchClaimPath(fixture.layout)), false);
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('a live process claim cannot be stolen or unlinked regardless of claim age', async () => {
  const fixture = createManagedFixture('gl-c4-live-launch-claim-');
  try {
    writeLaunchClaim(fixture.layout);
    const claimBefore = readLaunchClaimText(fixture.layout);
    let spawnCalled = false;

    await assert.rejects(
      () => ensureBackendReady({
        config: fixture.currentConfig,
        env: { HOME: fixture.home },
        fetchImpl: async () => unhealthyResponse(),
        spawnImpl: () => {
          spawnCalled = true;
          throw new Error('must not spawn');
        },
      }),
      (error) => error instanceof ManagedBackendError && error.category === 'MANAGED_LAUNCH_IN_PROGRESS',
    );

    assert.equal(spawnCalled, false);
    assert.equal(readLaunchClaimText(fixture.layout), claimBefore);
    assert.equal(existsSync(fixture.layout.backendStatePath), false);

    rmSync(launchClaimPath(fixture.layout), { recursive: true });
    writeLaunchClaim(fixture.layout, {
      createdAtMs: Date.now() - MANAGED_LAUNCH_CLAIM_STALE_MS - 60_000,
    });
    const oldLiveClaim = readLaunchClaimText(fixture.layout);
    await assert.rejects(
      () => ensureBackendReady({
        config: fixture.currentConfig,
        env: { HOME: fixture.home },
        fetchImpl: async () => unhealthyResponse(),
        spawnImpl: () => {
          spawnCalled = true;
          throw new Error('must not spawn');
        },
      }),
      (error) => error instanceof ManagedBackendError && error.category === 'MANAGED_LAUNCH_IN_PROGRESS',
    );
    assert.equal(spawnCalled, false);
    assert.equal(readLaunchClaimText(fixture.layout), oldLiveClaim);
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('a fresh claim from a dead launcher is not recovered before the abandonment window', async () => {
  const fixture = createManagedFixture('gl-c4-fresh-dead-launch-claim-');
  try {
    writeLaunchClaim(fixture.layout, { ownerPid: await exitedChildPid() });
    const claimBefore = readLaunchClaimText(fixture.layout);
    let spawnCalled = false;

    await assert.rejects(
      () => ensureBackendReady({
        config: fixture.currentConfig,
        env: { HOME: fixture.home },
        fetchImpl: async () => unhealthyResponse(),
        spawnImpl: () => {
          spawnCalled = true;
          throw new Error('must not spawn');
        },
      }),
      (error) => error instanceof ManagedBackendError && error.category === 'MANAGED_LAUNCH_IN_PROGRESS',
    );

    assert.equal(spawnCalled, false);
    assert.equal(readLaunchClaimText(fixture.layout), claimBefore);
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('a provably abandoned launch claim is recovered before managed startup', async () => {
  const fixture = createManagedFixture('gl-c4-abandoned-launch-claim-');
  try {
    writeLaunchClaim(fixture.layout, {
      ownerPid: await exitedChildPid(),
      createdAtMs: Date.now() - MANAGED_LAUNCH_CLAIM_STALE_MS - 60_000,
    });
    let healthCalls = 0;
    let spawnCalls = 0;

    const result = await ensureBackendReady({
      config: fixture.currentConfig,
      env: { HOME: fixture.home },
      fetchImpl: async () => {
        healthCalls += 1;
        return healthCalls <= 2 ? unhealthyResponse() : healthyResponse();
      },
      spawnImpl: () => {
        spawnCalls += 1;
        return fakeSpawnedChild();
      },
      startupTimeoutMs: 5_000,
    });

    assert.equal(result.mode, 'managed-started');
    assert.equal(spawnCalls, 1);
    assert.equal(existsSync(launchClaimPath(fixture.layout)), false);
    assert.equal(JSON.parse(readFileSync(fixture.layout.backendStatePath, 'utf8')).pid, process.pid);
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('spawn failure releases the owned launch claim and permits a later launch', async () => {
  const fixture = createManagedFixture('gl-c4-spawn-claim-cleanup-');
  try {
    await assert.rejects(
      () => ensureBackendReady({
        config: fixture.currentConfig,
        env: { HOME: fixture.home },
        fetchImpl: async () => unhealthyResponse(),
        spawnImpl: () => {
          throw new Error('synthetic spawn failure');
        },
      }),
      (error) => error instanceof ManagedBackendError && error.category === 'BACKEND_START_FAILED',
    );
    assert.equal(existsSync(launchClaimPath(fixture.layout)), false);
    assert.equal(existsSync(fixture.layout.backendStatePath), false);

    await assert.rejects(
      () => ensureBackendReady({
        config: fixture.currentConfig,
        env: { HOME: fixture.home },
        fetchImpl: async () => unhealthyResponse(),
        spawnImpl: () => {
          const child = new EventEmitter();
          child.pid = process.pid;
          child.unref = () => {};
          queueMicrotask(() => child.emit('error', new Error('synthetic asynchronous spawn failure')));
          return child;
        },
      }),
      (error) => error instanceof ManagedBackendError && error.category === 'BACKEND_START_FAILED',
    );
    assert.equal(existsSync(launchClaimPath(fixture.layout)), false);
    assert.equal(existsSync(fixture.layout.backendStatePath), false);

    let healthCalls = 0;
    const result = await ensureBackendReady({
      config: fixture.currentConfig,
      env: { HOME: fixture.home },
      fetchImpl: async () => {
        healthCalls += 1;
        return healthCalls <= 2 ? unhealthyResponse() : healthyResponse();
      },
      spawnImpl: () => fakeSpawnedChild(),
      startupTimeoutMs: 5_000,
    });
    assert.equal(result.mode, 'managed-started');
    assert.equal(existsSync(launchClaimPath(fixture.layout)), false);
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('state publication failure preserves authoritative state and releases the launch claim', async () => {
  const fixture = createManagedFixture('gl-c4-publication-claim-cleanup-');
  try {
    const deadChildPid = await exitedChildPid();
    let authoritativeState = null;

    await assert.rejects(
      () => ensureBackendReady({
        config: fixture.currentConfig,
        env: { HOME: fixture.home },
        fetchImpl: async () => unhealthyResponse(),
        spawnImpl: () => {
          writeCurrentState(fixture.layout, {
            pid: process.pid,
            currentConfig: fixture.currentConfig,
            serverPath: fixture.serverPath,
            serverContent: fixture.serverContent,
            modelPath: fixture.modelPath,
            modelContent: fixture.modelContent,
            launchArgvSha256: argvSha256(fixture.currentArgs),
          });
          authoritativeState = readFileSync(fixture.layout.backendStatePath, 'utf8');
          return fakeSpawnedChild(deadChildPid);
        },
      }),
      (error) => error instanceof ManagedBackendError && error.category === 'BACKEND_START_FAILED',
    );

    assert.equal(readFileSync(fixture.layout.backendStatePath, 'utf8'), authoritativeState);
    assert.equal(existsSync(launchClaimPath(fixture.layout)), false);
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('claim release cannot unlink a replacement claim with a different token', async () => {
  const fixture = createManagedFixture('gl-c4-token-safe-release-');
  try {
    const successorToken = '22222222-2222-4222-8222-222222222222';
    let successorClaim = null;

    await assert.rejects(
      () => ensureBackendReady({
        config: fixture.currentConfig,
        env: { HOME: fixture.home },
        fetchImpl: async () => unhealthyResponse(),
        spawnImpl: () => {
          rmSync(launchClaimPath(fixture.layout), { recursive: true });
          writeLaunchClaim(fixture.layout, { token: successorToken });
          successorClaim = readLaunchClaimText(fixture.layout);
          return fakeSpawnedChild();
        },
      }),
      (error) => error instanceof ManagedBackendError && error.category === 'BACKEND_START_FAILED',
    );

    assert.equal(readLaunchClaimText(fixture.layout), successorClaim);
    assert.equal(JSON.parse(successorClaim).token, successorToken);
    assert.equal(existsSync(fixture.layout.backendStatePath), true);
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('startup timeout leaves neither the published state nor a stale launch claim', async () => {
  const fixture = createManagedFixture('gl-c4-timeout-claim-cleanup-');
  try {
    await assert.rejects(
      () => ensureBackendReady({
        config: fixture.currentConfig,
        env: { HOME: fixture.home },
        fetchImpl: async () => unhealthyResponse(),
        spawnImpl: () => fakeSpawnedChild(),
        startupTimeoutMs: 1,
      }),
      (error) => error instanceof ManagedBackendError && error.category === 'BACKEND_START_TIMEOUT',
    );

    assert.equal(existsSync(launchClaimPath(fixture.layout)), false);
    assert.equal(existsSync(fixture.layout.backendStatePath), false);
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
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

test('status reports stale state before requiring a missing launch identity', async () => {
  const home = tempHome('gl-c4-status-dead-missing-launch-');
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
    const deadPid = await exitedChildPid();
    writeCurrentState(layout, {
      pid: deadPid,
      currentConfig,
      serverPath,
      serverContent,
      modelPath,
      modelContent,
      launchArgvSha256: argvSha256(oldArgs),
    });

    const result = await getBackendStatus({
      config: currentConfig,
      env: { HOME: home },
      fetchImpl: async () => healthyResponse(),
    });

    assert.deepEqual(result, {
      status: 'stale-state',
      healthy: true,
      managed: true,
      pid: deadPid,
      ownedProcessVerified: false,
    });
    assert.equal(existsSync(layout.backendStatePath), true);
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
