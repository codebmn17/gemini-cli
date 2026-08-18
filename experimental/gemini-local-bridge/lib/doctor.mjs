/**
 * @license
 * Copyright 2026 Google LLC
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
    : { allOk: false, fileCount: 0, results: [] };
  checks.push({
    name: 'vendored-artifact-integrity',
    ok: integrity.allOk,
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

  const allStructuralChecksOk = checks.every((c) => c.ok);
  const localInferenceReady = allStructuralChecksOk && adapterInstalled;

  return {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    layout,
    provenance: provenanceReadable
      ? {
          promotedFromCommit: provenance.promotedFromCommit,
          pinnedGeminiCli: provenance.pinnedGeminiCli,
        }
      : null,
    checks,
    localInferenceReady,
    summary: localInferenceReady
      ? 'local inference adapter marker detected; this build still refuses prompts (skeleton stage, no adapter wiring yet)'
      : 'NOT READY: no local inference (llama.cpp) adapter installed. gemini-local refuses all prompts and never falls back to hosted Gemini.',
  };
}

export function formatDoctorReport(report) {
  const lines = [];
  lines.push(`gemini-local doctor — ${report.timestamp}`);
  lines.push(`home: ${report.layout.home}`);
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
