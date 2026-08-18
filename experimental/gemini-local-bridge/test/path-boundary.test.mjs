/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Focused regressions for the product install/uninstall pathname boundary.
 * These are host-side Linux tests only; Termux/Android remains a separate
 * real-device acceptance gate.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
const termuxDoc = path.join(bundleRoot, 'docs', 'TERMUX.md');

function makeTempHome() {
  return mkdtempSync(path.join(os.tmpdir(), 'gl-boundary-home-'));
}

function makeDecoy() {
  return mkdtempSync(path.join(os.tmpdir(), 'gl-boundary-decoy-'));
}

function runScript(scriptPath, args, home) {
  return spawnSync('bash', [scriptPath, ...args], {
    env: { HOME: home, PATH: process.env.PATH },
    encoding: 'utf8',
  });
}

function assertRefusedAsSymlink(result) {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink/);
}

test('install refuses an ancestor symlink at ~/.local and does not write through it', () => {
  const home = makeTempHome();
  const decoy = makeDecoy();
  try {
    symlinkSync(decoy, path.join(home, '.local'));
    const result = runScript(installScript, [], home);
    assertRefusedAsSymlink(result);
    assert.equal(existsSync(path.join(decoy, 'bin')), false);
    assert.equal(existsSync(path.join(decoy, 'share')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  }
});

test('install refuses an ancestor symlink at ~/.local/share and does not write through it', () => {
  const home = makeTempHome();
  const decoy = makeDecoy();
  try {
    mkdirSync(path.join(home, '.local'), { recursive: true });
    symlinkSync(decoy, path.join(home, '.local', 'share'));
    const result = runScript(installScript, [], home);
    assertRefusedAsSymlink(result);
    assert.equal(existsSync(path.join(decoy, 'gemini-local-bridge')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  }
});

test('install refuses an ancestor symlink at ~/.config and does not write through it', () => {
  const home = makeTempHome();
  const decoy = makeDecoy();
  try {
    symlinkSync(decoy, path.join(home, '.config'));
    const result = runScript(installScript, [], home);
    assertRefusedAsSymlink(result);
    assert.equal(existsSync(path.join(decoy, 'gemini-local-bridge')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  }
});

test('uninstall refuses an ancestor symlink at ~/.local without deleting through it', () => {
  const home = makeTempHome();
  const decoy = makeDecoy();
  try {
    mkdirSync(path.join(decoy, 'bin'), { recursive: true });
    writeFileSync(path.join(decoy, 'bin', 'gemini-local'), 'keep\n');
    symlinkSync(decoy, path.join(home, '.local'));
    const result = runScript(uninstallScript, [], home);
    assertRefusedAsSymlink(result);
    assert.equal(readFileSync(path.join(decoy, 'bin', 'gemini-local'), 'utf8'), 'keep\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  }
});

test('uninstall preflights ~/.local/share ancestor before deleting a valid launcher', () => {
  const home = makeTempHome();
  const decoy = makeDecoy();
  try {
    mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(path.join(home, '.local', 'bin', 'gemini-local'), 'keep launcher\n');
    symlinkSync(decoy, path.join(home, '.local', 'share'));
    const result = runScript(uninstallScript, [], home);
    assertRefusedAsSymlink(result);
    assert.equal(existsSync(path.join(home, '.local', 'bin', 'gemini-local')), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  }
});

test('uninstall preflights an unsafe DATA_DIR before deleting a valid launcher', () => {
  const home = makeTempHome();
  const decoy = makeDecoy();
  try {
    mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    mkdirSync(path.join(home, '.local', 'share'), { recursive: true });
    writeFileSync(path.join(home, '.local', 'bin', 'gemini-local'), 'keep launcher\n');
    writeFileSync(path.join(decoy, 'keep.txt'), 'keep data\n');
    symlinkSync(decoy, path.join(home, '.local', 'share', 'gemini-local-bridge'));
    const result = runScript(uninstallScript, [], home);
    assertRefusedAsSymlink(result);
    assert.equal(existsSync(path.join(home, '.local', 'bin', 'gemini-local')), true);
    assert.equal(existsSync(path.join(decoy, 'keep.txt')), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  }
});

test('uninstall --purge preflights ~/.config before deleting launcher or data', () => {
  const home = makeTempHome();
  const decoy = makeDecoy();
  try {
    mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    mkdirSync(path.join(home, '.local', 'share', 'gemini-local-bridge'), { recursive: true });
    writeFileSync(path.join(home, '.local', 'bin', 'gemini-local'), 'keep launcher\n');
    writeFileSync(path.join(home, '.local', 'share', 'gemini-local-bridge', 'keep.txt'), 'keep data\n');
    writeFileSync(path.join(decoy, 'keep-config.txt'), 'keep config\n');
    symlinkSync(decoy, path.join(home, '.config'));

    const result = runScript(uninstallScript, ['--purge'], home);
    assertRefusedAsSymlink(result);
    assert.equal(existsSync(path.join(home, '.local', 'bin', 'gemini-local')), true);
    assert.equal(existsSync(path.join(home, '.local', 'share', 'gemini-local-bridge', 'keep.txt')), true);
    assert.equal(existsSync(path.join(decoy, 'keep-config.txt')), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  }
});

test('Termux instructions require an out-of-band exact transport SHA and no movable branch checkout', () => {
  const doc = readFileSync(termuxDoc, 'utf8');
  assert.match(doc, /TRANSPORT_SHA=/);
  assert.match(doc, /git checkout --detach "\$TRANSPORT_SHA"/);
  assert.match(doc, /git rev-parse HEAD/);
  assert.doesNotMatch(doc, /git checkout claude\/termux-bridge-plan-review-ziqde5/);
});
