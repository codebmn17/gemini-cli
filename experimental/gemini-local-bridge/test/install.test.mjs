/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * End-to-end tests for install-gemini-local.sh / uninstall-gemini-local.sh
 * against a throwaway fake $HOME on this Linux host. These prove host-side
 * (Linux) behavior only — see docs/TERMUX.md for what remains unverified
 * until run on an actual Termux/Android device.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const bundleRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const installScript = path.join(bundleRoot, 'install-gemini-local.sh');
const uninstallScript = path.join(bundleRoot, 'uninstall-gemini-local.sh');

function makeTempHome() {
  return mkdtempSync(path.join(os.tmpdir(), 'gl-install-test-home-'));
}

function runScript(scriptPath, args, home) {
  return spawnSync('bash', [scriptPath, ...args], {
    env: { HOME: home, PATH: process.env.PATH },
    encoding: 'utf8',
  });
}

function runLauncher(home, args) {
  return spawnSync(path.join(home, '.local', 'bin', 'gemini-local'), args, {
    env: { HOME: home, PATH: process.env.PATH },
    encoding: 'utf8',
  });
}

test('install-gemini-local.sh creates the three target directories and the launcher', () => {
  const home = makeTempHome();
  try {
    const result = runScript(installScript, [], home);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(statSync(path.join(home, '.local', 'bin', 'gemini-local')).isFile());
    assert.ok(statSync(path.join(home, '.local', 'share', 'gemini-local-bridge')).isDirectory());
    assert.ok(statSync(path.join(home, '.config', 'gemini-local-bridge')).isDirectory());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installed vendored payload is read-only (immutable promoted artifacts)', () => {
  const home = makeTempHome();
  try {
    runScript(installScript, [], home);
    const target = path.join(
      home,
      '.local',
      'share',
      'gemini-local-bridge',
      'vendor',
      'phase-b',
      'lib',
      'phase-b-launch-probe.mjs',
    );
    const mode = statSync(target).mode & 0o777;
    assert.equal(mode, 0o444);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installed launcher: doctor reports clean integrity and correct provenance commit', () => {
  const home = makeTempHome();
  try {
    runScript(installScript, [], home);
    const result = runLauncher(home, ['doctor', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.checks.find((c) => c.name === 'vendored-artifact-integrity').ok, true);
    assert.equal(report.provenance.promotedFromCommit, 'e9c5ad7f382be3144daf71b7f477db1a183955da');
    assert.equal(report.localInferenceReady, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installed launcher: an arbitrary prompt fails closed (non-zero exit, no hosted-Gemini fallback wording)', () => {
  const home = makeTempHome();
  try {
    runScript(installScript, [], home);
    const result = runLauncher(home, ['summarize the news for me']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /never falls back to hosted Gemini/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('reinstall is idempotent and restores a tampered vendored file', () => {
  const home = makeTempHome();
  try {
    runScript(installScript, [], home);
    const target = path.join(
      home,
      '.local',
      'share',
      'gemini-local-bridge',
      'vendor',
      'phase-b',
      'lib',
      'phase-b-launch-probe.mjs',
    );
    // Simulate tampering (chmod back to writable first, like an attacker would).
    spawnSync('chmod', ['u+w', target]);
    writeFileSync(target, readFileSync(target, 'utf8') + '\n// tampered\n');

    const badDoctor = JSON.parse(runLauncher(home, ['doctor', '--json']).stdout);
    assert.equal(badDoctor.checks.find((c) => c.name === 'vendored-artifact-integrity').ok, false);

    const reinstall = runScript(installScript, [], home);
    assert.equal(reinstall.status, 0, reinstall.stderr);

    const goodDoctor = JSON.parse(runLauncher(home, ['doctor', '--json']).stdout);
    assert.equal(goodDoctor.checks.find((c) => c.name === 'vendored-artifact-integrity').ok, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall (default) removes launcher + data dir but preserves an existing config dir', () => {
  const home = makeTempHome();
  try {
    runScript(installScript, [], home);
    const configDir = path.join(home, '.config', 'gemini-local-bridge');
    const marker = path.join(configDir, 'user-marker.json');
    writeFileSync(marker, '{"kept":true}\n');

    const result = runScript(uninstallScript, [], home);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(home, '.local', 'bin', 'gemini-local')), false);
    assert.equal(existsSync(path.join(home, '.local', 'share', 'gemini-local-bridge')), false);
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall --purge also removes the config dir', () => {
  const home = makeTempHome();
  try {
    runScript(installScript, [], home);
    const result = runScript(uninstallScript, ['--purge'], home);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(home, '.config', 'gemini-local-bridge')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall on a HOME with nothing installed is a clean no-op, not an error', () => {
  const home = makeTempHome();
  try {
    const result = runScript(uninstallScript, [], home);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /not present, skipping/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installer refuses to run with HOME unset or HOME="/"', () => {
  const unset = spawnSync('bash', [installScript], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.notEqual(unset.status, 0);

  const rootHome = spawnSync('bash', [installScript], {
    env: { HOME: '/', PATH: process.env.PATH },
    encoding: 'utf8',
  });
  assert.notEqual(rootHome.status, 0);
});

test('static regression guard: installer/uninstaller never reference npm, a hardcoded Termux path, or the real gemini binary', () => {
  const installSrc = readFileSync(installScript, 'utf8');
  const uninstallSrc = readFileSync(uninstallScript, 'utf8');
  for (const src of [installSrc, uninstallSrc]) {
    for (const forbidden of ['npm install', 'npm i ', '/data/data/com.termux', 'lib/node_modules/@google/gemini-cli']) {
      assert.ok(!src.includes(forbidden), `expected "${forbidden}" to be absent`);
    }
  }
});
