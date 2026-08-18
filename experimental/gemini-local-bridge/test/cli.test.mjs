/**
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { resolveHome, resolveLayout } from '../lib/paths.mjs';
import { verifyProvenance, sha256File } from '../lib/integrity.mjs';
import { runDoctor, formatDoctorReport } from '../lib/doctor.mjs';
import { attemptRun, FAIL_CLOSED_EXIT_CODE } from '../lib/run.mjs';
import { main, GEMINI_LOCAL_BRIDGE_VERSION } from '../lib/cli.mjs';

const bundleRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');

function makeTempHome() {
  return mkdtempSync(path.join(os.tmpdir(), 'gl-test-home-'));
}

function stringIO() {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write: (chunk) => { out += chunk; return true; } },
      stderr: { write: (chunk) => { err += chunk; return true; } },
    },
    get stdout() { return out; },
    get stderr() { return err; },
  };
}

// Installs the bundle's real payload into `home` by directly copying files
// (mirrors what install-gemini-local.sh does, including applying each
// vendored file's PROVENANCE.json-recorded installedMode), without
// shelling out to the installer, so pure-JS tests stay fast; the shell
// installer itself is exercised end-to-end in test/install.test.mjs.
function stageRealPayload(home) {
  const dataDir = path.join(home, '.local', 'share', 'gemini-local-bridge');
  const configDir = path.join(home, '.config', 'gemini-local-bridge');
  const binDir = path.join(home, '.local', 'bin');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  execFileSync('cp', ['-R', path.join(bundleRoot, 'lib'), path.join(dataDir, 'lib')]);
  execFileSync('cp', ['-R', path.join(bundleRoot, 'vendor'), path.join(dataDir, 'vendor')]);
  execFileSync('cp', [path.join(bundleRoot, 'PROVENANCE.json'), path.join(dataDir, 'PROVENANCE.json')]);
  execFileSync('cp', [path.join(bundleRoot, 'bin', 'gemini-local'), path.join(binDir, 'gemini-local')]);
  chmodSync(path.join(binDir, 'gemini-local'), 0o755);

  const manifest = JSON.parse(readFileSync(path.join(dataDir, 'PROVENANCE.json'), 'utf8'));
  for (const file of manifest.files) {
    chmodSync(path.join(dataDir, file.bundlePath), parseInt(file.installedMode, 8));
  }
  return { dataDir, configDir, binDir };
}

// --- paths.mjs -------------------------------------------------------

test('resolveHome reads env.HOME, never a hardcoded Android/Termux path', () => {
  const home = resolveHome({ HOME: '/some/fake/home' });
  assert.equal(home, '/some/fake/home');
});

test('resolveHome falls back to os.homedir() when env.HOME is unset', () => {
  // os.homedir() reads the real process/OS user database, not the fake env
  // object passed in, so this cannot be forced to fail portably in a unit
  // test — it only documents the documented fallback behavior.
  assert.equal(resolveHome({}), os.homedir());
});

test('resolveHome rejects an empty-string HOME rather than treating it as set', () => {
  assert.equal(resolveHome({ HOME: '' }), os.homedir());
});

test('resolveLayout derives all paths fresh from HOME, no baked-in state', () => {
  const layout = resolveLayout({ HOME: '/x' });
  assert.equal(layout.binDir, '/x/.local/bin');
  assert.equal(layout.dataDir, '/x/.local/share/gemini-local-bridge');
  assert.equal(layout.configDir, '/x/.config/gemini-local-bridge');
  assert.equal(layout.launcherPath, '/x/.local/bin/gemini-local');
  // Regression guard: nothing here should ever mention a Termux/Android path.
  for (const value of Object.values(layout)) {
    assert.ok(!String(value).includes('/data/data/com.termux'));
  }
});

// --- integrity.mjs -----------------------------------------------------

test('verifyProvenance passes for an untampered install', () => {
  const home = makeTempHome();
  try {
    const { dataDir } = stageRealPayload(home);
    const provenance = JSON.parse(readFileSync(path.join(dataDir, 'PROVENANCE.json'), 'utf8'));
    const result = verifyProvenance(dataDir, provenance);
    assert.equal(result.allOk, true);
    assert.ok(result.fileCount >= 10);
    assert.ok(result.results.every((r) => r.status === 'ok'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('verifyProvenance detects a same-size content tamper as hash-mismatch (isolated from size/mode)', () => {
  const home = makeTempHome();
  try {
    const { dataDir } = stageRealPayload(home);
    const target = path.join(dataDir, 'vendor', 'phase-b', 'lib', 'phase-b-launch-probe.mjs');
    const before = sha256File(target);
    const buffer = readFileSync(target);
    // Flip one byte in place: same length (no size-mismatch), same mode
    // (restored below), only the content hash changes.
    buffer[0] = buffer[0] ^ 0xff;
    chmodSync(target, 0o644);
    writeFileSync(target, buffer);
    chmodSync(target, 0o444);
    const provenance = JSON.parse(readFileSync(path.join(dataDir, 'PROVENANCE.json'), 'utf8'));
    const result = verifyProvenance(dataDir, provenance);
    assert.equal(result.allOk, false);
    const failure = result.results.find((r) => r.bundlePath === 'vendor/phase-b/lib/phase-b-launch-probe.mjs');
    assert.equal(failure.status, 'hash-mismatch');
    assert.equal(failure.expected, before);
    assert.notEqual(failure.actual, before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('verifyProvenance detects an appended-content tamper as size-mismatch', () => {
  const home = makeTempHome();
  try {
    const { dataDir } = stageRealPayload(home);
    const target = path.join(dataDir, 'vendor', 'phase-b', 'lib', 'phase-b-launch-probe.mjs');
    const originalSize = readFileSync(target).length;
    chmodSync(target, 0o644);
    writeFileSync(target, readFileSync(target, 'utf8') + '\n// tampered\n');
    chmodSync(target, 0o444);
    const provenance = JSON.parse(readFileSync(path.join(dataDir, 'PROVENANCE.json'), 'utf8'));
    const result = verifyProvenance(dataDir, provenance);
    assert.equal(result.allOk, false);
    const failure = result.results.find((r) => r.bundlePath === 'vendor/phase-b/lib/phase-b-launch-probe.mjs');
    assert.equal(failure.status, 'size-mismatch');
    assert.equal(failure.expected, originalSize);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('verifyProvenance detects a mode-mismatch even when content is untouched', () => {
  const home = makeTempHome();
  try {
    const { dataDir } = stageRealPayload(home);
    const target = path.join(dataDir, 'vendor', 'phase-b', 'bin', 'phase-b-launch-probe.mjs');
    chmodSync(target, 0o644); // accepted mode is 100755 -> installedMode 0555; this is wrong
    const provenance = JSON.parse(readFileSync(path.join(dataDir, 'PROVENANCE.json'), 'utf8'));
    const result = verifyProvenance(dataDir, provenance);
    assert.equal(result.allOk, false);
    const failure = result.results.find((r) => r.bundlePath === 'vendor/phase-b/bin/phase-b-launch-probe.mjs');
    assert.equal(failure.status, 'mode-mismatch');
    assert.equal(failure.expected, '0555');
    assert.equal(failure.actual, '0644');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('verifyProvenance rejects a bundlePath that escapes vendor/phase-b/ via ../ without touching the filesystem', () => {
  const home = makeTempHome();
  try {
    const { dataDir } = stageRealPayload(home);
    const provenance = JSON.parse(readFileSync(path.join(dataDir, 'PROVENANCE.json'), 'utf8'));
    provenance.files[0] = { ...provenance.files[0], bundlePath: '../../../etc/passwd' };
    const result = verifyProvenance(dataDir, provenance);
    assert.equal(result.allOk, false);
    const failure = result.results.find((r) => r.bundlePath === '../../../etc/passwd');
    assert.equal(failure.status, 'unsafe-path');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('verifyProvenance rejects an absolute bundlePath', () => {
  const home = makeTempHome();
  try {
    const { dataDir } = stageRealPayload(home);
    const provenance = JSON.parse(readFileSync(path.join(dataDir, 'PROVENANCE.json'), 'utf8'));
    provenance.files[0] = { ...provenance.files[0], bundlePath: '/etc/passwd' };
    const result = verifyProvenance(dataDir, provenance);
    assert.equal(result.allOk, false);
    assert.equal(result.results.find((r) => r.bundlePath === '/etc/passwd').status, 'unsafe-path');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('verifyProvenance rejects a duplicate bundlePath entry', () => {
  const home = makeTempHome();
  try {
    const { dataDir } = stageRealPayload(home);
    const provenance = JSON.parse(readFileSync(path.join(dataDir, 'PROVENANCE.json'), 'utf8'));
    provenance.files.push({ ...provenance.files[0] });
    const result = verifyProvenance(dataDir, provenance);
    assert.equal(result.allOk, false);
    assert.equal(result.fileSet.ok, false);
    assert.deepEqual(result.fileSet.duplicates, [provenance.files[0].bundlePath]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('verifyProvenance rejects a manifest missing an expected file', () => {
  const home = makeTempHome();
  try {
    const { dataDir } = stageRealPayload(home);
    const provenance = JSON.parse(readFileSync(path.join(dataDir, 'PROVENANCE.json'), 'utf8'));
    const removed = provenance.files.pop();
    const result = verifyProvenance(dataDir, provenance);
    assert.equal(result.allOk, false);
    assert.equal(result.fileSet.ok, false);
    assert.ok(result.fileSet.missing.includes(removed.bundlePath));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('verifyProvenance rejects a manifest with an extra, unexpected file entry', () => {
  const home = makeTempHome();
  try {
    const { dataDir } = stageRealPayload(home);
    const provenance = JSON.parse(readFileSync(path.join(dataDir, 'PROVENANCE.json'), 'utf8'));
    provenance.files.push({
      ...provenance.files[0],
      bundlePath: 'vendor/phase-b/lib/not-a-real-promoted-file.mjs',
    });
    const result = verifyProvenance(dataDir, provenance);
    assert.equal(result.allOk, false);
    assert.equal(result.fileSet.ok, false);
    assert.ok(result.fileSet.extra.includes('vendor/phase-b/lib/not-a-real-promoted-file.mjs'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('verifyProvenance rejects a manifest with the wrong promoted commit', () => {
  const home = makeTempHome();
  try {
    const { dataDir } = stageRealPayload(home);
    const provenance = JSON.parse(readFileSync(path.join(dataDir, 'PROVENANCE.json'), 'utf8'));
    provenance.promotedFromCommit = '0000000000000000000000000000000000000000';
    const result = verifyProvenance(dataDir, provenance);
    assert.equal(result.allOk, false);
    assert.equal(result.identity.ok, false);
    assert.ok(result.identity.mismatches.some((m) => m.field === 'promotedFromCommit'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('verifyProvenance rejects a manifest with the wrong pinned Gemini identity', () => {
  const home = makeTempHome();
  try {
    const { dataDir } = stageRealPayload(home);
    const provenance = JSON.parse(readFileSync(path.join(dataDir, 'PROVENANCE.json'), 'utf8'));
    provenance.pinnedGeminiCli = { version: '9.9.9', commit: 'deadbeef' };
    const result = verifyProvenance(dataDir, provenance);
    assert.equal(result.allOk, false);
    assert.equal(result.identity.ok, false);
    const fields = result.identity.mismatches.map((m) => m.field);
    assert.ok(fields.includes('pinnedGeminiCli.version'));
    assert.ok(fields.includes('pinnedGeminiCli.commit'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('verifyProvenance reports a missing file as missing, not a crash', () => {
  const home = makeTempHome();
  try {
    const { dataDir } = stageRealPayload(home);
    rmSync(path.join(dataDir, 'vendor', 'phase-b', 'lib', 'phase-b-recorder.mjs'));
    const provenance = JSON.parse(readFileSync(path.join(dataDir, 'PROVENANCE.json'), 'utf8'));
    const result = verifyProvenance(dataDir, provenance);
    assert.equal(result.allOk, false);
    const failure = result.results.find((r) => r.bundlePath === 'vendor/phase-b/lib/phase-b-recorder.mjs');
    assert.equal(failure.status, 'missing');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- doctor.mjs ----------------------------------------------------------

test('doctor on a completely uninstalled HOME reports not-installed (not a structural failure)', () => {
  const home = makeTempHome();
  try {
    const report = runDoctor({ HOME: home });
    assert.equal(report.localInferenceReady, false);
    assert.equal(report.installState, 'not-installed');
    // Nothing has been installed yet — this is a normal pre-install state,
    // not corruption, so it must not be reported as a structural failure.
    assert.equal(report.structuralFailure, false);
    assert.equal(report.checks.find((c) => c.name === 'data-dir-exists').ok, false);
    // Adapter-absence must not itself read as a failed check (it's expected).
    const adapterCheck = report.checks.find((c) => c.name === 'llama-cpp-adapter-installed');
    assert.equal(adapterCheck.ok, true);
    assert.equal(adapterCheck.installed, false);
    assert.match(formatDoctorReport(report), /NOT INSTALLED/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctor on a corrupt install (tampered payload) reports structuralFailure=true', () => {
  const home = makeTempHome();
  try {
    const { dataDir } = stageRealPayload(home);
    const target = path.join(dataDir, 'vendor', 'phase-b', 'lib', 'phase-b-recorder.mjs');
    chmodSync(target, 0o644);
    writeFileSync(target, readFileSync(target, 'utf8') + '\n// tampered\n');
    chmodSync(target, 0o444);
    const report = runDoctor({ HOME: home });
    assert.equal(report.installState, 'installed-corrupt');
    assert.equal(report.structuralFailure, true);
    assert.match(formatDoctorReport(report), /STRUCTURAL FAILURE/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('cli main(): doctor exits 0 for a healthy skeleton (adapter absent) but non-zero for a corrupt install', async () => {
  const healthyHome = makeTempHome();
  const corruptHome = makeTempHome();
  try {
    stageRealPayload(healthyHome);
    const s1 = stringIO();
    const healthyCode = await main(['doctor'], { HOME: healthyHome }, s1.io);
    assert.equal(healthyCode, 0);

    const { dataDir } = stageRealPayload(corruptHome);
    rmSync(path.join(dataDir, 'vendor', 'phase-b', 'lib', 'phase-b-recorder.mjs'));
    const s2 = stringIO();
    const corruptCode = await main(['doctor'], { HOME: corruptHome }, s2.io);
    assert.notEqual(corruptCode, 0);
  } finally {
    rmSync(healthyHome, { recursive: true, force: true });
    rmSync(corruptHome, { recursive: true, force: true });
  }
});

test('doctor on a freshly staged install reports OK structural checks and NOT READY (no adapter yet)', () => {
  const home = makeTempHome();
  try {
    stageRealPayload(home);
    const report = runDoctor({ HOME: home });
    assert.equal(report.checks.find((c) => c.name === 'vendored-artifact-integrity').ok, true);
    assert.equal(report.checks.find((c) => c.name === 'launcher-installed').ok, true);
    assert.equal(report.localInferenceReady, false);
    assert.equal(report.provenance.promotedFromCommit, 'e9c5ad7f382be3144daf71b7f477db1a183955da');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctor becomes localInferenceReady only once BOTH integrity holds AND an adapter marker exists', () => {
  const home = makeTempHome();
  try {
    const { configDir } = stageRealPayload(home);
    writeFileSync(path.join(configDir, 'llama-cpp-adapter.json'), '{"placeholder":true}\n');
    const report = runDoctor({ HOME: home });
    assert.equal(report.localInferenceReady, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctor never touches fetch: poisoning it still lets doctor complete normally', async () => {
  // node:child_process exports are frozen ESM bindings and cannot be
  // monkey-patched from a test; the "doctor never imports it" guarantee is
  // covered instead by the static source-grep regression test below.
  const home = makeTempHome();
  try {
    stageRealPayload(home);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('doctor must never perform a network request'); };
    try {
      const report = runDoctor({ HOME: home });
      assert.equal(report.checks.find((c) => c.name === 'vendored-artifact-integrity').ok, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- run.mjs (fail-closed) ------------------------------------------------

test('attemptRun always fails closed with a clear message, regardless of args', () => {
  for (const args of [[], ['hello'], ['--yolo'], ['tell me a secret']]) {
    const result = attemptRun(args, {});
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, FAIL_CLOSED_EXIT_CODE);
    assert.match(result.message, /never falls back to hosted Gemini/);
  }
});

test('doctor.mjs and run.mjs source never actually import/call network or process-spawn primitives (static regression guard)', () => {
  // Matches real usage (import/require/dynamic-import statements, or a
  // direct fetch(...) call) rather than a bare substring, so the modules'
  // own explanatory doc comments (which legitimately name these forbidden
  // primitives in prose) don't trip this guard.
  const forbiddenPatterns = [
    /from\s+['"]node:(child_process|net|http|https)['"]/,
    /require\(\s*['"]node:(child_process|net|http|https)['"]\s*\)/,
    /import\(\s*['"]node:(child_process|net|http|https)['"]\s*\)/,
    /\bfetch\s*\(/,
    /phase-b-launch-probe/,
  ];
  const doctorSrc = readFileSync(path.join(bundleRoot, 'lib', 'doctor.mjs'), 'utf8');
  const runSrc = readFileSync(path.join(bundleRoot, 'lib', 'run.mjs'), 'utf8');
  for (const [label, src] of [['doctor.mjs', doctorSrc], ['run.mjs', runSrc]]) {
    for (const pattern of forbiddenPatterns) {
      assert.ok(!pattern.test(src), `expected ${label} not to match ${pattern}`);
    }
  }
});

// --- cli.mjs (dispatch) ---------------------------------------------------

test('cli main(): no args prints help and exits 0', async () => {
  const s = stringIO();
  const code = await main([], { HOME: '/x' }, s.io);
  assert.equal(code, 0);
  assert.match(s.stdout, /usage:/);
});

test('cli main(): version prints the bridge version and exits 0, no network', async () => {
  const s = stringIO();
  const code = await main(['version'], { HOME: '/x' }, s.io);
  assert.equal(code, 0);
  assert.match(s.stdout, new RegExp(GEMINI_LOCAL_BRIDGE_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('cli main(): doctor/status/--doctor/--status all route to the same diagnostic and exit 0', async () => {
  const home = makeTempHome();
  try {
    for (const command of ['doctor', 'status', '--doctor', '--status']) {
      const s = stringIO();
      const code = await main([command], { HOME: home }, s.io);
      assert.equal(code, 0);
      assert.match(s.stdout, /gemini-local doctor/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('cli main(): any unrecognized command fails closed with exit 3 and touches only stderr', async () => {
  const s = stringIO();
  const code = await main(['what is the capital of France'], { HOME: '/x' }, s.io);
  assert.equal(code, FAIL_CLOSED_EXIT_CODE);
  assert.equal(s.stdout, '');
  assert.match(s.stderr, /never falls back to hosted Gemini/);
});

test('cli.mjs command-set regression guard: the fail-closed branch is the only reachable default', () => {
  const src = readFileSync(path.join(bundleRoot, 'lib', 'cli.mjs'), 'utf8');
  assert.ok(src.includes('attemptRun'));
  assert.ok(!src.includes('phase-b-launch-probe'));
  assert.ok(!src.includes("import('node:child_process')"));
});
