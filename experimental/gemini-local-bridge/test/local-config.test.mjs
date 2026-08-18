/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * C2: lib/local-config.mjs schema/validation coverage. Pure filesystem
 * work only -- no network, no process spawn, no real pinned Gemini CLI
 * build needed (see writeFakeGeminiDistribution below).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  validateLocalConfig,
  loadLocalConfig,
  LocalConfigError,
  LOCAL_CONFIG_SCHEMA_VERSION,
  SUPPORTED_BACKEND,
  MAX_CONFIG_BYTES,
} from '../lib/local-config.mjs';
import { PINNED_GEMINI_CLI_VERSION } from '../vendor/phase-b/lib/phase-b-auth-routing.mjs';

const EXPECTED_PACKAGE_NAME = '@google/gemini-cli';
const EXPECTED_BIN_RELATIVE_PATH = 'bundle/gemini.js';

function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'gl-local-config-test-'));
}

// See test/cli.test.mjs's identical helper for why this is a fake, minimal
// stand-in (manifest-valid, content-irrelevant) rather than the real
// multi-hundred-MB pinned Gemini CLI build.
function writeFakeGeminiDistribution(root, overrides = {}) {
  mkdirSync(path.join(root, 'bundle'), { recursive: true });
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: overrides.name ?? EXPECTED_PACKAGE_NAME,
      version: overrides.version ?? PINNED_GEMINI_CLI_VERSION,
      bin: { gemini: overrides.binPath ?? EXPECTED_BIN_RELATIVE_PATH },
    }) + '\n',
  );
  if (overrides.skipEntrypoint) return root;
  writeFileSync(path.join(root, 'bundle', 'gemini.js'), '#!/usr/bin/env node\n// fake, never executed\n');
  return root;
}

function validConfig(overrides = {}) {
  return {
    schemaVersion: LOCAL_CONFIG_SCHEMA_VERSION,
    backend: SUPPORTED_BACKEND,
    backendOrigin: 'http://127.0.0.1:8080',
    backendModel: 'qwen-test-backend',
    clientModel: 'local-test-client',
    geminiRoot: overrides.geminiRoot,
    ...overrides,
  };
}

// --- validateLocalConfig: shape/schema ------------------------------------

test('validateLocalConfig accepts a fully valid config and derives distribution', () => {
  const dir = makeTempDir();
  try {
    const geminiRoot = writeFakeGeminiDistribution(path.join(dir, 'gemini-root'));
    const result = validateLocalConfig(validConfig({ geminiRoot }));
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.backend, 'llama.cpp');
    assert.equal(result.backendOrigin, 'http://127.0.0.1:8080');
    assert.equal(result.backendModel, 'qwen-test-backend');
    assert.equal(result.clientModel, 'local-test-client');
    assert.equal(result.geminiRoot, geminiRoot);
    assert.equal(result.distribution.root, geminiRoot);
    assert.equal(result.distribution.entrypoint, path.join(geminiRoot, 'bundle', 'gemini.js'));
    assert.ok(Object.isFrozen(result));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateLocalConfig rejects a non-object', () => {
  assert.throws(() => validateLocalConfig(null), LocalConfigError);
  assert.throws(() => validateLocalConfig('nope'), LocalConfigError);
  assert.throws(() => validateLocalConfig([1, 2, 3]), LocalConfigError);
});

test('validateLocalConfig rejects an unknown extra field', () => {
  const dir = makeTempDir();
  try {
    const geminiRoot = writeFakeGeminiDistribution(path.join(dir, 'gemini-root'));
    assert.throws(
      () => validateLocalConfig({ ...validConfig({ geminiRoot }), extra: 'nope' }),
      /unknown field/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateLocalConfig rejects a config missing any one required key', () => {
  const dir = makeTempDir();
  try {
    const geminiRoot = writeFakeGeminiDistribution(path.join(dir, 'gemini-root'));
    const base = validConfig({ geminiRoot });
    for (const key of Object.keys(base)) {
      const partial = { ...base };
      delete partial[key];
      assert.throws(
        () => validateLocalConfig(partial),
        new RegExp(`missing required field: "${key}"`),
        `expected rejection for missing "${key}"`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateLocalConfig rejects the wrong schemaVersion', () => {
  const dir = makeTempDir();
  try {
    const geminiRoot = writeFakeGeminiDistribution(path.join(dir, 'gemini-root'));
    assert.throws(() => validateLocalConfig(validConfig({ geminiRoot, schemaVersion: 2 })), /schemaVersion/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateLocalConfig rejects any backend value other than "llama.cpp"', () => {
  const dir = makeTempDir();
  try {
    const geminiRoot = writeFakeGeminiDistribution(path.join(dir, 'gemini-root'));
    for (const backend of ['ollama', 'openai', '', 'LLAMA.CPP']) {
      assert.throws(() => validateLocalConfig(validConfig({ geminiRoot, backend })), /backend must be/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- backendOrigin: reuses the C1 loopback validator ----------------------

test('validateLocalConfig rejects non-loopback backendOrigin values', () => {
  const dir = makeTempDir();
  try {
    const geminiRoot = writeFakeGeminiDistribution(path.join(dir, 'gemini-root'));
    const badOrigins = [
      'http://0.0.0.0:8080',
      'http://localhost:8080',
      'https://127.0.0.1:8080',
      'http://127.0.0.1:8080/',
      'http://127.0.0.1:8080/v1',
      'http://[::1]:8080',
      'http://127.0.0.1',
      'not-a-url',
      '',
    ];
    for (const backendOrigin of badOrigins) {
      assert.throws(
        () => validateLocalConfig(validConfig({ geminiRoot, backendOrigin })),
        /backendOrigin/,
        `expected rejection for backendOrigin ${JSON.stringify(backendOrigin)}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateLocalConfig rejects an empty backendModel', () => {
  const dir = makeTempDir();
  try {
    const geminiRoot = writeFakeGeminiDistribution(path.join(dir, 'gemini-root'));
    assert.throws(() => validateLocalConfig(validConfig({ geminiRoot, backendModel: '' })), /backendModel/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- clientModel: must be structurally incapable of Gemini-branding ------

test('validateLocalConfig rejects Gemini-branded or arbitrary clientModel values', () => {
  const dir = makeTempDir();
  try {
    const geminiRoot = writeFakeGeminiDistribution(path.join(dir, 'gemini-root'));
    const badClientModels = [
      '',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'models/gemini-2.5-pro',
      'auto',
      'gemini-3-pro-preview',
      'localx', // must not silently accept a prefix-only coincidence
      'not-local-at-all',
    ];
    for (const clientModel of badClientModels) {
      assert.throws(
        () => validateLocalConfig(validConfig({ geminiRoot, clientModel })),
        /clientModel/,
        `expected rejection for clientModel ${JSON.stringify(clientModel)}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateLocalConfig rejects a "local-"-prefixed clientModel that still ends in "flash"', () => {
  // Regression test for the adversarially-discovered case: pinned Gemini
  // CLI's own model resolution (isFlashModel()/resolveModel() in
  // packages/core/src/config/models.ts) treats ANY string ending in "flash"
  // as flash-family and may rebrand it internally, regardless of a
  // "local-" prefix that would otherwise look neutral.
  const dir = makeTempDir();
  try {
    const geminiRoot = writeFakeGeminiDistribution(path.join(dir, 'gemini-root'));
    for (const clientModel of ['local-flash', 'local/flash', 'local-my-flash']) {
      assert.throws(
        () => validateLocalConfig(validConfig({ geminiRoot, clientModel })),
        /must not end in "flash"/,
        `expected rejection for clientModel ${JSON.stringify(clientModel)}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateLocalConfig accepts the documented neutral clientModel shapes', () => {
  const dir = makeTempDir();
  try {
    const geminiRoot = writeFakeGeminiDistribution(path.join(dir, 'gemini-root'));
    for (const clientModel of ['local', 'local-test-client', 'local/qwen', 'local-a.b_c-9']) {
      const result = validateLocalConfig(validConfig({ geminiRoot, clientModel }));
      assert.equal(result.clientModel, clientModel);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- geminiRoot: reuses the accepted Phase-B pinned-distribution verifier -

test('validateLocalConfig rejects geminiRoot with the wrong package name', () => {
  const dir = makeTempDir();
  try {
    const geminiRoot = writeFakeGeminiDistribution(path.join(dir, 'gemini-root'), { name: 'not-gemini-cli' });
    assert.throws(
      () => validateLocalConfig(validConfig({ geminiRoot })),
      /pinned-distribution verification/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateLocalConfig rejects geminiRoot with the wrong pinned version', () => {
  const dir = makeTempDir();
  try {
    const geminiRoot = writeFakeGeminiDistribution(path.join(dir, 'gemini-root'), { version: '9.9.9' });
    assert.throws(
      () => validateLocalConfig(validConfig({ geminiRoot })),
      /pinned-distribution verification/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateLocalConfig rejects geminiRoot with a missing entrypoint file', () => {
  const dir = makeTempDir();
  try {
    const geminiRoot = writeFakeGeminiDistribution(path.join(dir, 'gemini-root'), { skipEntrypoint: true });
    assert.throws(
      () => validateLocalConfig(validConfig({ geminiRoot })),
      /pinned-distribution verification/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateLocalConfig rejects geminiRoot whose entrypoint is a symlink', () => {
  const dir = makeTempDir();
  try {
    const geminiRoot = writeFakeGeminiDistribution(path.join(dir, 'gemini-root'), { skipEntrypoint: true });
    const realTarget = path.join(dir, 'elsewhere.js');
    writeFileSync(realTarget, '// elsewhere\n');
    symlinkSync(realTarget, path.join(geminiRoot, 'bundle', 'gemini.js'));
    assert.throws(
      () => validateLocalConfig(validConfig({ geminiRoot })),
      /pinned-distribution verification/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- loadLocalConfig: bounded, no-follow, isolated filesystem reads ------

test('loadLocalConfig reports a clear not-found error for a missing file, distinct from an invalid one', () => {
  const dir = makeTempDir();
  try {
    assert.throws(
      () => loadLocalConfig(path.join(dir, 'does-not-exist.json')),
      /not found/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadLocalConfig refuses to follow a symlinked config file', () => {
  const dir = makeTempDir();
  try {
    const geminiRoot = writeFakeGeminiDistribution(path.join(dir, 'gemini-root'));
    const realConfig = path.join(dir, 'real-config.json');
    writeFileSync(realConfig, JSON.stringify(validConfig({ geminiRoot })) + '\n');
    const configLink = path.join(dir, 'config-link.json');
    symlinkSync(realConfig, configLink);
    assert.throws(() => loadLocalConfig(configLink), /must not be a symlink/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadLocalConfig rejects a config file over the bounded size limit', () => {
  const dir = makeTempDir();
  try {
    const configPath = path.join(dir, 'llama-cpp-adapter.json');
    const oversized = '{"padding":"' + 'x'.repeat(MAX_CONFIG_BYTES) + '"}';
    writeFileSync(configPath, oversized);
    assert.throws(() => loadLocalConfig(configPath), /exceeds bounded size limit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadLocalConfig rejects malformed JSON', () => {
  const dir = makeTempDir();
  try {
    const configPath = path.join(dir, 'llama-cpp-adapter.json');
    writeFileSync(configPath, '{ this is not json');
    assert.throws(() => loadLocalConfig(configPath), /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadLocalConfig rejects a directory at the config path', () => {
  const dir = makeTempDir();
  try {
    const configPath = path.join(dir, 'llama-cpp-adapter.json');
    mkdirSync(configPath);
    assert.throws(() => loadLocalConfig(configPath), /regular file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadLocalConfig round-trips a real file on disk end to end, using only a temp isolated path', () => {
  const dir = makeTempDir();
  try {
    const geminiRoot = writeFakeGeminiDistribution(path.join(dir, 'gemini-root'));
    const configPath = path.join(dir, 'llama-cpp-adapter.json');
    writeFileSync(configPath, JSON.stringify(validConfig({ geminiRoot })) + '\n');
    const result = loadLocalConfig(configPath);
    assert.equal(result.clientModel, 'local-test-client');
    assert.equal(result.backendModel, 'qwen-test-backend');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
