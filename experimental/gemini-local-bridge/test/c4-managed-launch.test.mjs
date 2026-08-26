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
