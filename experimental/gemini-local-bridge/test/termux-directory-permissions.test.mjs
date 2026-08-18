/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Regression for the first real Termux install failure: promoted files may be
 * read-only, but their containing directories must remain owner-writable so a
 * non-root user can rename staged payloads, clean failed stages, and reinstall.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const bundleRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const installScript = path.join(bundleRoot, 'install-gemini-local.sh');

function runInstall(home) {
  return spawnSync('bash', [installScript], {
    env: { HOME: home, PATH: process.env.PATH },
    encoding: 'utf8',
  });
}

function modeOf(target) {
  return statSync(target).mode & 0o777;
}

test('vendored container directories stay owner-writable while promoted file modes remain locked', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'gl-termux-perms-home-'));
  try {
    const first = runInstall(home);
    assert.equal(first.status, 0, first.stderr);

    const phaseB = path.join(home, '.local', 'share', 'gemini-local-bridge', 'vendor', 'phase-b');
    for (const relativeDir of ['', 'bin', 'lib']) {
      const mode = modeOf(path.join(phaseB, relativeDir));
      assert.notEqual(
        mode & 0o200,
        0,
        `${relativeDir || 'phase-b'} must remain owner-writable for non-root rename/cleanup/reinstall`,
      );
    }

    assert.equal(modeOf(path.join(phaseB, 'bin', 'phase-b-recorder.mjs')), 0o555);
    assert.equal(modeOf(path.join(phaseB, 'lib', 'phase-b-recorder.mjs')), 0o444);

    const second = runInstall(home);
    assert.equal(second.status, 0, second.stderr);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
