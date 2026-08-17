import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classifyEnvSource,
  evaluateTrustRules,
  findSelectedEnvFile,
  getNativeSystemPaths,
  runPhaseBPreflight,
  scanDotenvKeys,
  stripJsonComments,
} from '../lib/phase-b-preflight.mjs';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'phase-b-preflight-'));
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

test('native Linux policy paths match pinned Gemini 0.55.1 defaults', () => {
  assert.deepEqual(getNativeSystemPaths('linux'), {
    systemSettings: '/etc/gemini-cli/settings.json',
    systemDefaults: '/etc/gemini-cli/system-defaults.json',
  });
});

test('native Windows policy paths use Windows path semantics even under injected tests', () => {
  assert.deepEqual(getNativeSystemPaths('win32'), {
    systemSettings: 'C:\\ProgramData\\gemini-cli\\settings.json',
    systemDefaults: 'C:\\ProgramData\\gemini-cli\\system-defaults.json',
  });
});

test('JSON comment stripping preserves comment markers inside strings', () => {
  const parsed = JSON.parse(
    stripJsonComments(`{
      // outer comment
      "url": "https://example.test/a//b/*still-string*/",
      /* block comment */
      "enabled": true
    }`),
  );
  assert.deepEqual(parsed, {
    url: 'https://example.test/a//b/*still-string*/',
    enabled: true,
  });
});

test('trust rules use longest match and TRUST_PARENT semantics', () => {
  const f = fixture();
  try {
    const parentRule = path.join(f.home, 'projects', 'anchor');
    const denied = path.join(f.home, 'projects', 'private');
    mkdirSync(f.workspace, { recursive: true });
    const rules = {
      [parentRule]: 'TRUST_PARENT',
      [denied]: 'DO_NOT_TRUST',
    };
    assert.equal(
      evaluateTrustRules(path.join(f.home, 'projects', 'other'), rules),
      true,
    );
    assert.equal(evaluateTrustRules(path.join(denied, 'child'), rules), false);
  } finally {
    f.cleanup();
  }
});

test('trusted env selection prefers workspace .gemini/.env over generic .env', () => {
  const f = fixture();
  try {
    const geminiEnv = path.join(f.workspace, '.gemini', '.env');
    writeFileSync(geminiEnv, 'GEMINI_API_KEY=secret\n');
    writeFileSync(path.join(f.workspace, '.env'), 'GOOGLE_API_KEY=other\n');
    assert.equal(
      findSelectedEnvFile(f.workspace, {
        homeDir: f.home,
        isTrusted: true,
        ignoreLocalEnv: false,
      }),
      geminiEnv,
    );
    assert.equal(classifyEnvSource(geminiEnv, f.home), 'workspace-gemini-env');
  } finally {
    f.cleanup();
  }
});

test('untrusted selection ignores workspace .gemini/.env', () => {
  const f = fixture();
  try {
    writeFileSync(
      path.join(f.workspace, '.gemini', '.env'),
      'GEMINI_API_KEY=secret\n',
    );
    const generic = path.join(f.workspace, '.env');
    writeFileSync(generic, 'GOOGLE_API_KEY=other\n');
    assert.equal(
      findSelectedEnvFile(f.workspace, {
        homeDir: f.home,
        isTrusted: false,
        ignoreLocalEnv: false,
      }),
      generic,
    );
  } finally {
    f.cleanup();
  }
});

test('ignoreLocalEnv skips project generic .env but still permits home .env', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.workspace, '.env'), 'GEMINI_API_KEY=project\n');
    const homeEnv = path.join(f.home, '.env');
    writeFileSync(homeEnv, 'GEMINI_API_KEY=home\n');
    assert.equal(
      findSelectedEnvFile(f.workspace, {
        homeDir: f.home,
        isTrusted: false,
        ignoreLocalEnv: true,
      }),
      homeEnv,
    );
  } finally {
    f.cleanup();
  }
});

test('dotenv key scanner ignores key-like lines inside quoted multiline values', () => {
  const keys = scanDotenvKeys(
    [
      'GEMINI_API_KEY="first line',
      'HTTP_PROXY=not-a-real-assignment',
      'last line"',
      'export GOOGLE_API_KEY=actual',
      'NO_PROXY: localhost',
    ].join('\n'),
  );
  assert.deepEqual([...keys], ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'NO_PROXY']);
});

test('preflight reports only presence and never serializes env values or selected env path', () => {
  const f = fixture();
  try {
    writeFileSync(
      path.join(f.home, '.gemini', 'settings.json'),
      '{"security":{"folderTrust":{"enabled":false}}}',
    );
    const selected = path.join(f.workspace, '.gemini', '.env');
    writeFileSync(
      selected,
      'GEMINI_API_KEY=selected-secret-value\nGOOGLE_CLOUD_PROJECT=private-project\n',
    );
    const report = runPhaseBPreflight({
      workspaceDir: f.workspace,
      environment: {
        GEMINI_API_KEY: 'shell-secret-value',
      },
      osHome: f.home,
      nativePaths: f.native,
    });
    assert.equal(report.allowed, true);
    assert.equal(report.workspaceTrust.isTrusted, true);
    assert.equal(report.workspaceTrust.source, 'folder-trust-disabled');
    assert.equal(report.selectedEnv.source, 'workspace-gemini-env');
    assert.equal(report.selectedEnv.sensitive.GEMINI_API_KEY, true);
    assert.equal(report.selectedEnv.sensitive.GOOGLE_CLOUD_PROJECT, true);
    assert.equal(report.inherited.sensitive.GEMINI_API_KEY, true);

    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes('selected-secret-value'), false);
    assert.equal(serialized.includes('shell-secret-value'), false);
    assert.equal(serialized.includes('private-project'), false);
    assert.equal(serialized.includes(selected), false);
    assert.equal(serialized.includes(f.workspace), false);
  } finally {
    f.cleanup();
  }
});

test('preflight fails closed on inherited proxy without exposing its value', () => {
  const f = fixture();
  try {
    const report = runPhaseBPreflight({
      workspaceDir: f.workspace,
      environment: { HTTPS_PROXY: 'http://proxy-secret.example:8080' },
      osHome: f.home,
      nativePaths: f.native,
    });
    assert.equal(report.allowed, false);
    assert.ok(report.blockers.includes('inherited-proxy-present'));
    assert.equal(report.inherited.proxy.HTTPS_PROXY, true);
    assert.equal(JSON.stringify(report).includes('proxy-secret.example'), false);
  } finally {
    f.cleanup();
  }
});

test('preflight fails closed on native policy and settings-path override', () => {
  const f = fixture();
  try {
    mkdirSync(path.dirname(f.native.systemSettings), { recursive: true });
    writeFileSync(
      f.native.systemSettings,
      '{"security":{"folderTrust":{"enabled":false}}}',
    );
    const report = runPhaseBPreflight({
      workspaceDir: f.workspace,
      environment: {
        GEMINI_CLI_SYSTEM_DEFAULTS_PATH: '/secret/custom-defaults.json',
      },
      osHome: f.home,
      nativePaths: f.native,
    });
    assert.equal(report.allowed, false);
    assert.ok(report.blockers.includes('native-system-settings-present'));
    assert.ok(report.blockers.includes('system-defaults-override-present'));
    assert.equal(report.selectedEnv.status, 'undetermined');
    assert.equal(
      JSON.stringify(report).includes('/secret/custom-defaults.json'),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test('preflight honors the pinned trust-workspace env override without exposing its value', () => {
  const f = fixture();
  try {
    const report = runPhaseBPreflight({
      workspaceDir: f.workspace,
      environment: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
      osHome: f.home,
      nativePaths: f.native,
    });
    assert.equal(report.workspaceTrust.isTrusted, true);
    assert.equal(report.workspaceTrust.source, 'env');
    assert.equal(report.inherited.control.GEMINI_CLI_TRUST_WORKSPACE, true);
    assert.equal(
      JSON.stringify(report).includes('"GEMINI_CLI_TRUST_WORKSPACE":"true"'),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test('preflight blocks proxy keys found only in the selected env file', () => {
  const f = fixture();
  try {
    writeFileSync(
      path.join(f.home, '.gemini', 'settings.json'),
      '{"security":{"folderTrust":{"enabled":false}}}',
    );
    writeFileSync(
      path.join(f.workspace, '.gemini', '.env'),
      'HTTPS_PROXY=http://selected-proxy-secret.example:8080\n',
    );
    const report = runPhaseBPreflight({
      workspaceDir: f.workspace,
      environment: {},
      osHome: f.home,
      nativePaths: f.native,
    });
    assert.equal(report.allowed, false);
    assert.ok(report.blockers.includes('selected-env-proxy-present'));
    assert.equal(report.selectedEnv.proxy.HTTPS_PROXY, true);
    assert.equal(
      JSON.stringify(report).includes('selected-proxy-secret.example'),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test('preflight fails closed on invalid user settings and invalid trusted folders', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.home, '.gemini', 'settings.json'), '{bad json');
    let report = runPhaseBPreflight({
      workspaceDir: f.workspace,
      environment: {},
      osHome: f.home,
      nativePaths: f.native,
    });
    assert.ok(report.blockers.includes('user-settings-invalid'));

    writeFileSync(path.join(f.home, '.gemini', 'settings.json'), '{}');
    writeFileSync(
      path.join(f.home, '.gemini', 'trustedFolders.json'),
      JSON.stringify({ [f.workspace]: 'MAYBE_TRUST' }),
    );
    report = runPhaseBPreflight({
      workspaceDir: f.workspace,
      environment: {},
      osHome: f.home,
      nativePaths: f.native,
    });
    assert.ok(report.blockers.includes('trusted-folders-invalid'));
  } finally {
    f.cleanup();
  }
});

test('workspace ignoreLocalEnv participates only when the workspace is trusted', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.home, '.gemini', 'settings.json'), '{}');
    writeFileSync(
      path.join(f.workspace, '.gemini', 'settings.json'),
      '{"advanced":{"ignoreLocalEnv":true}}',
    );
    writeFileSync(path.join(f.workspace, '.env'), 'GEMINI_API_KEY=project\n');
    writeFileSync(path.join(f.home, '.env'), 'GEMINI_API_KEY=home\n');

    let report = runPhaseBPreflight({
      workspaceDir: f.workspace,
      environment: {},
      osHome: f.home,
      nativePaths: f.native,
    });
    assert.equal(report.workspaceTrust.isTrusted, false);
    assert.equal(report.ignoreLocalEnv.value, false);
    assert.equal(report.selectedEnv.source, 'generic-env');

    writeFileSync(
      path.join(f.home, '.gemini', 'trustedFolders.json'),
      JSON.stringify({ [f.workspace]: 'TRUST_FOLDER' }),
    );
    report = runPhaseBPreflight({
      workspaceDir: f.workspace,
      environment: {},
      osHome: f.home,
      nativePaths: f.native,
    });
    assert.equal(report.workspaceTrust.isTrusted, true);
    assert.equal(report.ignoreLocalEnv.value, true);
    assert.equal(report.selectedEnv.source, 'home-env');
  } finally {
    f.cleanup();
  }
});

test('CLI emits a safe report and uses exit 2 for a blocked proxy environment', () => {
  const f = fixture();
  try {
    const cliPath = fileURLToPath(
      new URL('../bin/phase-b-preflight.mjs', import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      [cliPath, '--workspace', f.workspace],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          GEMINI_CLI_HOME: f.home,
          HTTPS_PROXY: 'http://cli-secret-proxy.example:9999',
        },
      },
    );
    assert.equal(result.status, 2);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout);
    assert.ok(report.blockers.includes('inherited-proxy-present'));
    assert.equal(result.stdout.includes('cli-secret-proxy.example'), false);
    assert.equal(result.stdout.includes(f.home), false);
    assert.equal(result.stdout.includes(f.workspace), false);
  } finally {
    f.cleanup();
  }
});
