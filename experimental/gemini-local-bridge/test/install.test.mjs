/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * End-to-end tests for install-gemini-local.sh / uninstall-gemini-local.sh
 * against a throwaway fake $HOME on this Linux host. These prove host-side
 * (Linux) behavior only — see docs/TERMUX.md for what remains unverified
 * until run on an actual Termux/Android device.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

test('every promoted file gets its exact PROVENANCE.json-declared installedMode: bin/*.mjs stay executable (0555), lib/*.mjs + package.json become 0444', () => {
  const home = makeTempHome();
  try {
    runScript(installScript, [], home);
    const dataDir = path.join(home, '.local', 'share', 'gemini-local-bridge');
    const provenance = JSON.parse(readFileSync(path.join(dataDir, 'PROVENANCE.json'), 'utf8'));
    assert.ok(provenance.files.length >= 10);
    let sawExecutable = false;
    let sawNonExecutable = false;
    for (const file of provenance.files) {
      const rawMode = statSync(path.join(dataDir, file.bundlePath)).mode & 0o777;
      const actualMode = '0' + rawMode.toString(8).padStart(3, '0');
      const expected = file.installedMode;
      assert.equal(actualMode, expected, `${file.bundlePath}: expected mode ${expected}, got ${actualMode}`);
      if (file.mode === '100755') {
        assert.equal(expected, '0555');
        sawExecutable = true;
      } else if (file.mode === '100644') {
        assert.equal(expected, '0444');
        sawNonExecutable = true;
      }
    }
    // Sanity: the promoted set actually contains both kinds, so this test
    // would fail loudly (not vacuously pass) if the mapping regressed.
    assert.ok(sawExecutable, 'expected at least one 100755 -> 0555 promoted file');
    assert.ok(sawNonExecutable, 'expected at least one 100644 -> 0444 promoted file');
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

// --- FIX 3: fail closed on symlink/unexpected objects at install targets --

test('install-gemini-local.sh refuses when the data dir target is a symlink, and never writes through it', () => {
  const home = makeTempHome();
  const decoyTarget = makeTempHome(); // a directory outside HOME entirely
  try {
    mkdirSync(path.join(home, '.local', 'share'), { recursive: true });
    symlinkSync(decoyTarget, path.join(home, '.local', 'share', 'gemini-local-bridge'));

    const result = runScript(installScript, [], home);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlink/);

    // The installer must not have traversed the symlink and written the
    // payload into decoyTarget.
    assert.equal(existsSync(path.join(decoyTarget, 'lib')), false);
    assert.equal(existsSync(path.join(decoyTarget, 'vendor')), false);
    // The symlink itself must be untouched (still a symlink, still pointing
    // at decoyTarget) — not silently replaced.
    const linkPath = path.join(home, '.local', 'share', 'gemini-local-bridge');
    assert.ok(lstatSync(linkPath).isSymbolicLink());
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(decoyTarget, { recursive: true, force: true });
  }
});

test('install-gemini-local.sh refuses when the launcher path already exists as a symlink to another file', () => {
  const home = makeTempHome();
  const decoyFile = path.join(makeTempHome(), 'decoy-binary');
  writeFileSync(decoyFile, '#!/bin/sh\necho not-gemini-local\n');
  try {
    mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    symlinkSync(decoyFile, path.join(home, '.local', 'bin', 'gemini-local'));

    const result = runScript(installScript, [], home);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlink/);
    // The decoy file's content must be untouched — not overwritten through the symlink.
    assert.match(readFileSync(decoyFile, 'utf8'), /not-gemini-local/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(path.dirname(decoyFile), { recursive: true, force: true });
  }
});

test('install-gemini-local.sh refuses when the config dir target exists as a plain file instead of a directory', () => {
  const home = makeTempHome();
  try {
    mkdirSync(path.join(home, '.config'), { recursive: true });
    writeFileSync(path.join(home, '.config', 'gemini-local-bridge'), 'not a directory\n');

    const result = runScript(installScript, [], home);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a directory/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install-gemini-local.sh still supports idempotent reinstall over a normal (non-symlink) prior install', () => {
  const home = makeTempHome();
  try {
    const first = runScript(installScript, [], home);
    assert.equal(first.status, 0, first.stderr);
    const second = runScript(installScript, [], home);
    assert.equal(second.status, 0, second.stderr);
    assert.ok(statSync(path.join(home, '.local', 'bin', 'gemini-local')).isFile());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall-gemini-local.sh refuses when the data dir target is a symlink, and never deletes through it', () => {
  const home = makeTempHome();
  const decoyTarget = makeTempHome();
  writeFileSync(path.join(decoyTarget, 'do-not-delete-me.txt'), 'important\n');
  try {
    mkdirSync(path.join(home, '.local', 'share'), { recursive: true });
    symlinkSync(decoyTarget, path.join(home, '.local', 'share', 'gemini-local-bridge'));

    const result = runScript(uninstallScript, [], home);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlink/);
    // decoyTarget's contents must survive untouched.
    assert.equal(existsSync(path.join(decoyTarget, 'do-not-delete-me.txt')), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(decoyTarget, { recursive: true, force: true });
  }
});

test('uninstall-gemini-local.sh refuses on a broken symlink at the launcher path instead of silently treating it as absent', () => {
  const home = makeTempHome();
  try {
    mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    symlinkSync(
      path.join(home, '.local', 'bin', 'this-target-does-not-exist'),
      path.join(home, '.local', 'bin', 'gemini-local'),
    );

    const result = runScript(uninstallScript, [], home);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlink/);
    assert.doesNotMatch(result.stdout, /not present, skipping/);
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
