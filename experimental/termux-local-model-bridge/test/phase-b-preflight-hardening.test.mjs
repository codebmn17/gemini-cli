import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

import { runPhaseBPreflight } from '../lib/phase-b-preflight.mjs';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'phase-b-preflight-hardening-'));
  const home = path.join(root, 'home');
  const workspace = path.join(home, 'workspace');
  mkdirSync(path.join(home, '.gemini'), { recursive: true });
  mkdirSync(path.join(workspace, '.gemini'), { recursive: true });
  const native = {
    systemSettings: path.join(root, 'native', 'settings.json'),
    systemDefaults: path.join(root, 'native', 'system-defaults.json'),
  };
  return {
    root,
    home,
    workspace,
    native,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runInChild({ workspaceDir, osHome, nativePaths }) {
  const moduleUrl = new URL('../lib/phase-b-preflight.mjs', import.meta.url).href;
  const options = { workspaceDir, environment: {}, osHome, nativePaths };
  const script = [
    `const { runPhaseBPreflight } = await import(${JSON.stringify(moduleUrl)});`,
    `const report = runPhaseBPreflight(${JSON.stringify(options)});`,
    'process.stdout.write(JSON.stringify(report));',
  ].join('\n');

  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      encoding: 'utf8',
      timeout: 2000,
      env: { PATH: process.env.PATH },
    },
  );
}

test('preflight fails closed when user settings enable IDE mode without a port env var', () => {
  const f = fixture();
  try {
    writeFileSync(
      path.join(f.home, '.gemini', 'settings.json'),
      '{"ide":{"enabled":true}}',
    );
    const report = runPhaseBPreflight({
      workspaceDir: f.workspace,
      environment: {},
      osHome: f.home,
      nativePaths: f.native,
    });
    assert.equal(report.allowed, false);
    assert.equal(report.workspaceTrust.status, 'blocked');
    assert.ok(report.blockers.includes('ide-mode-enabled-in-settings'));
    assert.equal(report.selectedEnv.status, 'undetermined');
  } finally {
    f.cleanup();
  }
});

test('explicit trust override preserves pinned trust precedence over IDE mode', () => {
  const f = fixture();
  try {
    writeFileSync(
      path.join(f.home, '.gemini', 'settings.json'),
      '{"ide":{"enabled":true}}',
    );
    const report = runPhaseBPreflight({
      workspaceDir: f.workspace,
      environment: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
      osHome: f.home,
      nativePaths: f.native,
    });
    assert.equal(report.allowed, true);
    assert.equal(report.workspaceTrust.isTrusted, true);
    assert.equal(report.workspaceTrust.source, 'env');
    assert.equal(report.blockers.includes('ide-mode-enabled-in-settings'), false);
  } finally {
    f.cleanup();
  }
});

test(
  'FIFO user settings fail closed without blocking the preflight process',
  { skip: process.platform === 'win32' },
  () => {
    const f = fixture();
    try {
      const fifo = path.join(f.home, '.gemini', 'settings.json');
      execFileSync('mkfifo', [fifo]);
      const result = runInChild({
        workspaceDir: f.workspace,
        osHome: f.home,
        nativePaths: f.native,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      const report = JSON.parse(result.stdout);
      assert.equal(report.allowed, false);
      assert.ok(report.blockers.includes('user-settings-invalid'));
    } finally {
      f.cleanup();
    }
  },
);

test(
  'FIFO selected env fails closed without blocking the preflight process',
  { skip: process.platform === 'win32' },
  () => {
    const f = fixture();
    try {
      writeFileSync(
        path.join(f.home, '.gemini', 'settings.json'),
        '{"security":{"folderTrust":{"enabled":false}}}',
      );
      const fifo = path.join(f.workspace, '.gemini', '.env');
      execFileSync('mkfifo', [fifo]);
      const result = runInChild({
        workspaceDir: f.workspace,
        osHome: f.home,
        nativePaths: f.native,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      const report = JSON.parse(result.stdout);
      assert.equal(report.allowed, false);
      assert.equal(report.selectedEnv.status, 'invalid');
      assert.ok(report.blockers.includes('selected-env-read-error'));
    } finally {
      f.cleanup();
    }
  },
);
