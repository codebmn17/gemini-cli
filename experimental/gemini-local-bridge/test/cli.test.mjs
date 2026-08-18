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
import { PINNED_GEMINI_CLI_VERSION } from '../vendor/phase-b/lib/phase-b-auth-routing.mjs';

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

// A minimal directory shaped exactly enough to satisfy
// resolvePinnedGeminiDistribution's manifest/entrypoint checks (real package
// name, real pinned version, a real non-symlink bin/gemini.js file at the
// declared relative path) -- content of gemini.js is irrelevant here, since
// these doctor/local-config tests never spawn it. Deliberately NOT the real
// multi-hundred-MB pinned Gemini CLI build: that only exists in a
// session-specific scratchpad location, never committed to this repo, so it
// cannot be what a committed test depends on.
function writeFakeGeminiDistribution(root) {
  mkdirSync(path.join(root, 'bundle'), { recursive: true });
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: '@google/gemini-cli',
      version: PINNED_GEMINI_CLI_VERSION,
      bin: { gemini: 'bundle/gemini.js' },
    }) + '\n',
  );
  writeFileSync(
    path.join(root, 'bundle', 'gemini.js'),
    '#!/usr/bin/env node\n// fake distribution for doctor/local-config tests only -- never executed.\n',
  );
  return root;
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
    // Config-absence must not itself read as a failed check (it's expected).
    const configCheck = report.checks.find((c) => c.name === 'local-config-valid');
    assert.equal(configCheck.ok, true);
    assert.equal(configCheck.configured, false);
    assert.equal(report.local.configured, false);
    assert.equal(report.hostedFallback, 'disabled');
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

// Before C2, ANY file at the config path -- even this placeholder -- made
// localInferenceReady true, while every prompt still unconditionally failed
// closed regardless of that file's content (see the old README/C1 section).
// C2 promotes this same path to a real, schema-validated config
// (lib/local-config.mjs), so localInferenceReady now means "this config
// parses and would be used for a real launch attempt" -- a file that
// doesn't match the schema must read as present-but-invalid, not ready.
test('doctor becomes localInferenceReady only once BOTH integrity holds AND the local config is schema-valid', () => {
  const home = makeTempHome();
  try {
    const { configDir } = stageRealPayload(home);
    const configPath = path.join(configDir, 'llama-cpp-adapter.json');
    const geminiRoot = path.join(home, 'fake-gemini-root');
    writeFakeGeminiDistribution(geminiRoot);

    writeFileSync(configPath, '{"placeholder":true}\n');
    let report = runDoctor({ HOME: home });
    assert.equal(report.localInferenceReady, false);
    assert.equal(report.local.configured, false);
    const invalidCheck = report.checks.find((c) => c.name === 'local-config-valid');
    assert.equal(invalidCheck.configured, false);
    assert.match(invalidCheck.detail, /present but invalid/);
    // Still not a structural (package-integrity) failure -- it's the
    // user's own runtime config that's wrong, not the installed bundle.
    assert.equal(report.structuralFailure, false);

    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        backend: 'llama.cpp',
        backendOrigin: 'http://127.0.0.1:8080',
        backendModel: 'qwen-test-backend',
        clientModel: 'local-test-client',
        geminiRoot,
      }) + '\n',
    );
    report = runDoctor({ HOME: home });
    assert.equal(report.localInferenceReady, true);
    assert.equal(report.local.configured, true);
    assert.equal(report.local.host, geminiRoot);
    assert.equal(report.local.backend, 'llama.cpp');
    assert.equal(report.local.backendOrigin, 'http://127.0.0.1:8080');
    // Gemini-side and backend-side model identities are reported distinctly
    // and must never collapse into a single "model" field.
    assert.equal(report.local.clientModel, 'local-test-client');
    assert.equal(report.local.backendModel, 'qwen-test-backend');
    // Doctor is filesystem-only: it must never claim to know backend
    // reachability, only that a valid config exists.
    assert.equal(report.local.backendHealth, 'not probed by doctor');
    assert.equal(report.hostedFallback, 'disabled');
    assert.match(formatDoctorReport(report), /Backend health: not probed by doctor/);
    assert.match(formatDoctorReport(report), /Hosted fallback: disabled/);
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

// As of C2, attemptRun consults lib/local-config.mjs's loadLocalConfig() to
// decide whether a real launch is even possible, so it needs a resolvable
// (and here, isolated) HOME rather than `{}` -- `{}` would fall through to
// the real developer/CI-runner home directory via os.homedir() and could
// pick up a real config. Using a fresh temp HOME with nothing installed
// under it guarantees loadLocalConfig() sees "not found" every time,
// exercising exactly the no-config fail-closed path this test covers.
// attemptRun is async as of C2 (a real launch attempt awaits the runner).
test('attemptRun always fails closed with a clear message when no local config exists, regardless of args', async () => {
  const home = makeTempHome();
  try {
    for (const args of [[], ['hello'], ['--yolo'], ['tell me a secret']]) {
      const result = await attemptRun(args, { HOME: home });
      assert.equal(result.ok, false);
      assert.equal(result.exitCode, FAIL_CLOSED_EXIT_CODE);
      assert.match(result.message, /never falls back to hosted Gemini/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctor.mjs source never itself imports/calls network or process-spawn primitives (static regression guard)', () => {
  // Matches real usage (import/require/dynamic-import statements, or a
  // direct fetch(...) call) rather than a bare substring, so the module's
  // own explanatory doc comments (which legitimately name these forbidden
  // primitives, and this vendor filename, in prose) don't trip this guard.
  // Unlike run.mjs (see the next test), doctor.mjs's own code is still
  // unconditionally forbidden from calling any of these directly or
  // through a function it invokes -- see doctor.mjs's header comment. This
  // is a behavioral guarantee about doctor.mjs's call graph, not a claim
  // that its *module* graph is free of these imports: as of C2, doctor.mjs
  // imports local-config.mjs, which reuses the accepted, unmodified
  // vendor/phase-b/lib/phase-b-launch-probe.mjs's resolvePinnedGeminiDistribution
  // -- that vendor file itself imports node:child_process/node:http for its
  // own unrelated exports doctor never calls. What this guard checks is
  // narrower and still meaningful: doctor.mjs's own source never reaches
  // around local-config.mjs to import from that vendor file directly.
  const forbiddenPatterns = [
    /from\s+['"]node:(child_process|net|http|https)['"]/,
    /require\(\s*['"]node:(child_process|net|http|https)['"]\s*\)/,
    /import\(\s*['"]node:(child_process|net|http|https)['"]\s*\)/,
    /\bfetch\s*\(/,
    /from\s+['"][^'"]*phase-b-launch-probe(?:\.mjs)?['"]/,
    /require\(\s*['"][^'"]*phase-b-launch-probe(?:\.mjs)?['"]\s*\)/,
    /import\(\s*['"][^'"]*phase-b-launch-probe(?:\.mjs)?['"]\s*\)/,
  ];
  const doctorSrc = readFileSync(path.join(bundleRoot, 'lib', 'doctor.mjs'), 'utf8');
  for (const pattern of forbiddenPatterns) {
    assert.ok(!pattern.test(doctorSrc), `expected doctor.mjs not to match ${pattern}`);
  }
});

// Before C2, run.mjs had the same absolute "never touches network/process"
// invariant as doctor.mjs. As of C2 that invariant is deliberately no longer
// true of the bundle as a whole -- run.mjs may now, through
// lib/local-gemini-runner.mjs, perform a bounded backend health check and
// spawn the real pinned Gemini CLI once a valid local config exists. What
// still holds, and is what this guard now checks, is layering: run.mjs's
// *own* source never reaches for these primitives directly -- it only ever
// delegates to local-config.mjs/local-gemini-runner.mjs, which own the
// preflight/isolation/bounding logic those primitives require. This is an
// architectural guard against a future edit accidentally duplicating (and
// likely under-hardening) that logic ad hoc inside run.mjs, not a claim
// that run.mjs's capabilities are unchanged from before C2.
test('run.mjs source never directly imports network or process-spawn primitives itself (static layering guard)', () => {
  const directPrimitivePatterns = [
    /from\s+['"]node:(child_process|net|http|https)['"]/,
    /require\(\s*['"]node:(child_process|net|http|https)['"]\s*\)/,
    /import\(\s*['"]node:(child_process|net|http|https)['"]\s*\)/,
    /\bfetch\s*\(/,
  ];
  const runSrc = readFileSync(path.join(bundleRoot, 'lib', 'run.mjs'), 'utf8');
  for (const pattern of directPrimitivePatterns) {
    assert.ok(!pattern.test(runSrc), `expected run.mjs not to match ${pattern}`);
  }
  // run.mjs must still go through the runner rather than reaching around it
  // to call the bounded routing-proof probe directly.
  assert.ok(
    !/runPhaseBLaunchProbe/.test(runSrc),
    'expected run.mjs not to reference runPhaseBLaunchProbe directly',
  );
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
