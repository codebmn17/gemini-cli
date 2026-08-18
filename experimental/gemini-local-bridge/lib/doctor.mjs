/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * `doctor` (and its `status` alias) perform ONLY local filesystem reads and
 * SHA-256 hashing. This module must never import node:child_process,
 * node:net, node:http(s), or the vendored phase-b launch probe — doctor
 * must never spawn a process or make a network/model request.
 */

import fs from 'node:fs';
import { resolveLayout } from './paths.mjs';
import { verifyProvenance } from './integrity.mjs';

// Checks whose failure means the installed package itself is missing,
// incomplete, or does not match its own manifest — as opposed to the
// llama.cpp adapter simply not being installed yet, which is an expected,
// non-failing skeleton-stage state (see FIX 6 in the packaging-hardening
// pass this module was written for).
const PACKAGE_INTEGRITY_CHECK_NAMES = Object.freeze([
  'data-dir-exists',
  'vendor-dir-exists',
  'launcher-installed',
  'provenance-manifest-readable',
  'provenance-identity-matches-expected',
  'provenance-file-set-matches-expected',
  'vendored-artifact-integrity',
]);

function checkDirExists(name, dir) {
  let ok = false;
  try {
    ok = fs.statSync(dir).isDirectory();
  } catch {
    ok = false;
  }
  return { name, ok, detail: dir };
}

export function runDoctor(env = process.env) {
  const layout = resolveLayout(env);
  const checks = [];

  checks.push(checkDirExists('bin-dir-exists', layout.binDir));
  checks.push(checkDirExists('data-dir-exists', layout.dataDir));
  checks.push(checkDirExists('config-dir-exists', layout.configDir));
  checks.push(checkDirExists('vendor-dir-exists', layout.vendorDir));

  let launcherInstalled = false;
  try {
    launcherInstalled = fs.statSync(layout.launcherPath).isFile();
  } catch {
    launcherInstalled = false;
  }
  checks.push({ name: 'launcher-installed', ok: launcherInstalled, detail: layout.launcherPath });

  let provenance;
  let provenanceReadable = false;
  try {
    provenance = JSON.parse(fs.readFileSync(layout.provenancePath, 'utf8'));
    provenanceReadable = true;
  } catch (error) {
    provenanceReadable = false;
    checks.push({
      name: 'provenance-manifest-readable',
      ok: false,
      detail: error?.code ?? String(error?.message ?? error),
    });
  }
  if (provenanceReadable) {
    checks.push({ name: 'provenance-manifest-readable', ok: true, detail: layout.provenancePath });
  }

  const integrity = provenanceReadable
    ? verifyProvenance(layout.dataDir, provenance)
    : { allOk: false, fileCount: 0, identity: { ok: false, mismatches: [] }, fileSet: { ok: false, missing: [], extra: [], duplicates: [] }, results: [] };

  const perFileOk = integrity.results.length > 0 && integrity.results.every((r) => r.status === 'ok');
  checks.push({
    name: 'provenance-identity-matches-expected',
    ok: integrity.identity.ok,
    detail: integrity.identity.ok ? 'promoted commit / pinned Gemini identity match' : integrity.identity.mismatches,
  });
  checks.push({
    name: 'provenance-file-set-matches-expected',
    ok: integrity.fileSet.ok,
    detail: integrity.fileSet.ok
      ? `exactly ${integrity.fileCount} expected files declared`
      : { missing: integrity.fileSet.missing, extra: integrity.fileSet.extra, duplicates: integrity.fileSet.duplicates },
  });
  checks.push({
    name: 'vendored-artifact-integrity',
    ok: perFileOk,
    detail: { fileCount: integrity.fileCount, failures: integrity.results.filter((r) => r.status !== 'ok') },
  });

  let adapterInstalled = false;
  try {
    adapterInstalled = fs.statSync(layout.adapterMarkerPath).isFile();
  } catch {
    adapterInstalled = false;
  }
  // Not a pass/fail check: the adapter is *expected* to be absent at this
  // skeleton stage, so `ok` reflects that the check itself ran cleanly, not
  // whether the adapter is present. Presence is reported via `installed`.
  checks.push({
    name: 'llama-cpp-adapter-installed',
    ok: true,
    installed: adapterInstalled,
    expectedAtThisStage: false,
    detail: layout.adapterMarkerPath,
  });

  checks.push({ name: 'node-runtime', ok: true, detail: process.version });

  // Distinguish "nothing has been installed yet" (a normal, expected
  // pre-install state) from "something is installed but it is wrong" (a
  // real corruption/tamper/partial-install problem). Only the latter is a
  // structural failure that should make `doctor` exit non-zero.
  const anyInstallArtifactPresent =
    checks.find((c) => c.name === 'data-dir-exists').ok || launcherInstalled;

  let installState;
  let structuralFailure;
  if (!anyInstallArtifactPresent) {
    installState = 'not-installed';
    structuralFailure = false;
  } else {
    const packageIntegrityOk = PACKAGE_INTEGRITY_CHECK_NAMES.every(
      (name) => checks.find((c) => c.name === name)?.ok === true,
    );
    installState = packageIntegrityOk ? 'installed-ok' : 'installed-corrupt';
    structuralFailure = !packageIntegrityOk;
  }

  const localInferenceReady = installState === 'installed-ok' && adapterInstalled;

  let summary;
  if (installState === 'not-installed') {
    summary = 'NOT INSTALLED: run install-gemini-local.sh first. No corruption — nothing is here yet.';
  } else if (installState === 'installed-corrupt') {
    summary =
      'STRUCTURAL FAILURE: an installed gemini-local-bridge payload does not match its own ' +
      'promotion manifest (missing/extra/duplicate file, identity mismatch, hash/mode/size ' +
      'mismatch, or unsafe path). Re-run install-gemini-local.sh; if this recurs, stop and report it.';
  } else if (localInferenceReady) {
    summary =
      'local inference adapter marker detected; this build still refuses prompts (skeleton stage, no adapter wiring yet)';
  } else {
    summary =
      'NOT READY: package integrity is fine, but no local inference (llama.cpp) adapter is installed. ' +
      'gemini-local refuses all prompts and never falls back to hosted Gemini.';
  }

  return {
    schemaVersion: 2,
    timestamp: new Date().toISOString(),
    layout,
    provenance: provenanceReadable
      ? {
          promotedFromCommit: provenance.promotedFromCommit,
          pinnedGeminiCli: provenance.pinnedGeminiCli,
        }
      : null,
    checks,
    installState,
    structuralFailure,
    localInferenceReady,
    summary,
  };
}

export function formatDoctorReport(report) {
  const lines = [];
  lines.push(`gemini-local doctor — ${report.timestamp}`);
  lines.push(`home: ${report.layout.home}`);
  lines.push(`installState: ${report.installState}`);
  for (const check of report.checks) {
    const mark = check.ok ? 'OK  ' : 'FAIL';
    const detail = typeof check.detail === 'string' ? check.detail : JSON.stringify(check.detail);
    const suffix = check.name === 'llama-cpp-adapter-installed' ? ` installed=${check.installed}` : '';
    lines.push(`  [${mark}] ${check.name}${suffix} ${detail}`);
  }
  lines.push('');
  lines.push(report.summary);
  return lines.join('\n');
}
