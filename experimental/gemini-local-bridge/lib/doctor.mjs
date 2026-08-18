/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * `doctor` (and its `status` alias) perform ONLY local filesystem reads and
 * SHA-256 hashing. This module's own code must never call a process-spawn
 * or network primitive, directly or through a function it invokes — doctor
 * must never spawn a process or make a network/model request. That
 * behavioral invariant is unconditional and unchanged by C2: loadLocalConfig()
 * (from local-config.mjs) is safe to call here because everything it
 * actually calls is filesystem-only (a bounded file read, JSON.parse,
 * validateBackendOrigin's pure string-format check, and
 * resolvePinnedGeminiDistribution's own file stats/reads under geminiRoot)
 * — never a network call or a process spawn. Note this is a behavioral
 * guarantee, not a claim about the module graph: resolvePinnedGeminiDistribution
 * is reused, unmodified, from the accepted vendor/phase-b/lib/phase-b-launch-probe.mjs,
 * whose file also exports (but doctor never calls) spawn-based helpers and
 * imports node:child_process/node:http transitively for its own unrelated
 * purposes — importing a module never executes its code, only calling into
 * it does, and doctor's call graph stays exactly as filesystem-only as
 * before C2. Doctor reports whether a local config is *present and valid*,
 * never whether the backend it names is actually reachable: that is runtime
 * state doctor structurally cannot observe without violating the invariant
 * above, so it is always reported as "not probed by doctor" rather than
 * guessed at.
 */

import fs from 'node:fs';
import { resolveLayout } from './paths.mjs';
import { verifyProvenance } from './integrity.mjs';
import { loadLocalConfig, LocalConfigError } from './local-config.mjs';

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

  // Presence, separate from validity: lets the check/detail text distinguish
  // "nothing configured yet" (expected pre-configuration state) from
  // "something is there but doctor could not validate it" (worth surfacing
  // distinctly, even though — unlike package integrity below — a bad local
  // config is the user's own runtime config, not the installed package, so
  // it is never treated as a structural failure).
  let configPresentOnDisk = false;
  try {
    fs.lstatSync(layout.adapterMarkerPath);
    configPresentOnDisk = true;
  } catch {
    configPresentOnDisk = false;
  }

  let localConfig = null;
  let localConfigError = null;
  try {
    localConfig = loadLocalConfig(layout.adapterMarkerPath);
  } catch (error) {
    if (!(error instanceof LocalConfigError)) throw error;
    localConfigError = error.message;
  }
  const adapterConfigured = localConfig !== null;

  // Not a pass/fail check: an absent or invalid local config is an
  // *expected*, recoverable state at any point before the user finishes
  // setting one up — `ok` reflects that the check itself ran cleanly, not
  // whether a config is present or valid. That is reported via `configured`.
  checks.push({
    name: 'local-config-valid',
    ok: true,
    configured: adapterConfigured,
    expectedAtThisStage: false,
    detail: adapterConfigured
      ? layout.adapterMarkerPath
      : configPresentOnDisk
        ? `local config present but invalid: ${localConfigError}`
        : `not configured: ${layout.adapterMarkerPath}`,
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

  // C2: "ready" means gemini-local has a structurally valid local config and
  // WILL ATTEMPT a real launch for the next prompt — it does NOT mean the
  // backend has been confirmed reachable. Doctor never contacts the backend
  // or launches Gemini (see this module's header comment); actual backend
  // health is only ever checked live, at real prompt time, by
  // lib/local-gemini-runner.mjs's checkBackendHealth(). Before C2 this same
  // field meant only "a marker file is present" while every prompt still
  // unconditionally failed closed regardless — reusing the name for this
  // materially different, more meaningful claim is exactly why
  // schemaVersion below is bumped.
  const localInferenceReady = installState === 'installed-ok' && adapterConfigured;

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
      `READY TO ATTEMPT: host ${localConfig.distribution.root}, backend ${localConfig.backendOrigin}, ` +
      `client model "${localConfig.clientModel}" (Gemini-side only, never renamed to a backend model), ` +
      `backend model "${localConfig.backendModel}". Backend health is not probed by doctor — it is ` +
      'checked live on the next prompt. Hosted-Gemini fallback is permanently disabled.';
  } else {
    summary =
      'NOT READY: package integrity is fine, but no valid local config is present ' +
      (configPresentOnDisk ? `(${localConfigError}). ` : `(${layout.adapterMarkerPath} not found). `) +
      'gemini-local refuses all prompts and never falls back to hosted Gemini.';
  }

  return {
    // Bumped from 2 to 3 for C2: `checks[].name` "llama-cpp-adapter-installed"
    // -> "local-config-valid" (with a `configured` field replacing
    // `installed`), `localInferenceReady` now reflects a validated config
    // rather than mere file presence, and this report gained a `local`
    // section plus `hostedFallback`. See this module's header comment and
    // README.md's C2 section.
    schemaVersion: 3,
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
    // Host/Backend/Configured-model/Backend-health, filesystem-derived only
    // — see this module's header comment for why backendHealth can only
    // ever be this fixed string, never a live probe result.
    local: {
      configured: adapterConfigured,
      host: adapterConfigured ? localConfig.distribution.root : null,
      backend: adapterConfigured ? localConfig.backend : null,
      backendOrigin: adapterConfigured ? localConfig.backendOrigin : null,
      clientModel: adapterConfigured ? localConfig.clientModel : null,
      backendModel: adapterConfigured ? localConfig.backendModel : null,
      backendHealth: 'not probed by doctor',
    },
    hostedFallback: 'disabled',
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
    const suffix = check.name === 'local-config-valid' ? ` configured=${check.configured}` : '';
    lines.push(`  [${mark}] ${check.name}${suffix} ${detail}`);
  }
  lines.push('');
  if (report.local?.configured) {
    lines.push(`Host: ${report.local.host}`);
    lines.push(`Backend: ${report.local.backend} @ ${report.local.backendOrigin}`);
    lines.push(`Configured model: client="${report.local.clientModel}" (Gemini-side only) backend="${report.local.backendModel}"`);
    lines.push(`Backend health: ${report.local.backendHealth}`);
  }
  lines.push(`Hosted fallback: ${report.hostedFallback}`);
  lines.push('');
  lines.push(report.summary);
  return lines.join('\n');
}
