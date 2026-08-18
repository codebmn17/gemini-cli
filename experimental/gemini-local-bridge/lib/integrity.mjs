/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Installed-manifest/content integrity checking for the promoted vendor/
 * payload.
 *
 * Scope and limits: this detects accidental corruption, a partial/failed
 * install, or a same-user filesystem change to the *vendored payload*
 * relative to the manifest shipped alongside it in this bundle. It is NOT
 * a security boundary against a co-located attacker who can rewrite both
 * this verifier and PROVENANCE.json together — such an attacker could
 * simply patch this file (or the manifest) to agree with whatever they
 * planted. Call this installed-manifest/content integrity checking, not
 * tamper-proofing.
 */

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  VENDOR_ROOT_PREFIX,
  EXPECTED_VENDOR_FILES,
  EXPECTED_PROMOTED_COMMIT,
  EXPECTED_PINNED_GEMINI_VERSION,
  EXPECTED_PINNED_GEMINI_COMMIT,
} from './provenance-schema.mjs';

const SHA256_HEX = /^[0-9a-f]{64}$/i;
const INSTALLED_MODE_STRING = /^0[0-7]{3}$/;

export function sha256File(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

/**
 * A bundlePath is safe only if it is a non-empty, relative, already-
 * normalized (no redundant `.`/`..`/separator components) POSIX-style path
 * that stays contained under VENDOR_ROOT_PREFIX. Rejects absolute paths,
 * `..` escapes, and backslashes (never a legitimate separator in a
 * manifest produced by this bundle's own tooling, and a potential
 * separator-confusion vector on other platforms).
 */
export function isSafeBundlePath(bundlePath) {
  if (typeof bundlePath !== 'string' || bundlePath.length === 0) return false;
  if (bundlePath.includes('\\')) return false;
  if (path.posix.isAbsolute(bundlePath)) return false;
  const normalized = path.posix.normalize(bundlePath);
  if (normalized !== bundlePath) return false;
  if (normalized.split('/').includes('..')) return false;
  if (!normalized.startsWith(VENDOR_ROOT_PREFIX)) return false;
  return true;
}

/**
 * Validates the manifest's declared file list against the exact expected
 * promoted set — not "does every listed file check out", but "is this the
 * complete, correct list in the first place". Catches a manifest that
 * silently dropped a file (so it would never even be checked) or added an
 * untracked extra entry, in addition to internal duplicate bundlePaths.
 */
function validateFileSet(files) {
  const counts = new Map();
  for (const file of files) {
    const p = file?.bundlePath;
    if (typeof p !== 'string') continue;
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const duplicates = [...counts.entries()].filter(([, n]) => n > 1).map(([p]) => p);
  const declared = new Set(counts.keys());
  const expected = new Set(EXPECTED_VENDOR_FILES);
  const missing = EXPECTED_VENDOR_FILES.filter((p) => !declared.has(p));
  const extra = [...declared].filter((p) => !expected.has(p));
  return {
    ok: duplicates.length === 0 && missing.length === 0 && extra.length === 0,
    missing,
    extra,
    duplicates,
  };
}

/** Validates the manifest's own fixed identity fields against this product's expected values. */
function validateIdentity(provenance) {
  const mismatches = [];
  const checks = [
    ['promotedFromCommit', provenance?.promotedFromCommit, EXPECTED_PROMOTED_COMMIT],
    ['pinnedGeminiCli.version', provenance?.pinnedGeminiCli?.version, EXPECTED_PINNED_GEMINI_VERSION],
    ['pinnedGeminiCli.commit', provenance?.pinnedGeminiCli?.commit, EXPECTED_PINNED_GEMINI_COMMIT],
  ];
  for (const [field, actual, expected] of checks) {
    if (actual !== expected) {
      mismatches.push({ field, expected, actual });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

function verifyFile(dataDir, file) {
  const bundlePath = file?.bundlePath;
  if (!isSafeBundlePath(bundlePath)) {
    return { bundlePath: typeof bundlePath === 'string' ? bundlePath : '(invalid)', status: 'unsafe-path' };
  }

  if (
    typeof file.sha256 !== 'string' ||
    !SHA256_HEX.test(file.sha256) ||
    typeof file.bytes !== 'number' ||
    !Number.isInteger(file.bytes) ||
    file.bytes < 0 ||
    typeof file.installedMode !== 'string' ||
    !INSTALLED_MODE_STRING.test(file.installedMode)
  ) {
    return { bundlePath, status: 'malformed-manifest-entry' };
  }

  const absPath = path.join(dataDir, bundlePath);

  let stat;
  try {
    // lstat, not stat: a vendored file that has been replaced by a symlink
    // must be reported, never followed.
    stat = lstatSync(absPath);
  } catch (error) {
    return {
      bundlePath,
      status: error?.code === 'ENOENT' ? 'missing' : 'error',
      detail: error?.code ?? String(error?.message ?? error),
    };
  }

  if (!stat.isFile()) {
    return { bundlePath, status: 'not-a-regular-file' };
  }

  const actualMode = '0' + (stat.mode & 0o777).toString(8).padStart(3, '0');
  if (actualMode !== file.installedMode) {
    return { bundlePath, status: 'mode-mismatch', expected: file.installedMode, actual: actualMode };
  }

  if (stat.size !== file.bytes) {
    return { bundlePath, status: 'size-mismatch', expected: file.bytes, actual: stat.size };
  }

  let actualSha256;
  try {
    actualSha256 = sha256File(absPath);
  } catch (error) {
    return { bundlePath, status: 'error', detail: error?.code ?? String(error?.message ?? error) };
  }
  if (actualSha256 !== file.sha256) {
    return { bundlePath, status: 'hash-mismatch', expected: file.sha256, actual: actualSha256 };
  }

  return { bundlePath, status: 'ok' };
}

/**
 * Installed-manifest/content integrity check (see module doc comment for
 * what this does and does not protect against). Verifies, in order:
 *  1. the manifest's own fixed identity fields (promoted commit, pinned
 *     Gemini CLI version/commit) match this product's expected values;
 *  2. the manifest's file list is exactly the expected promoted set — no
 *     missing entries, no extras, no duplicate bundlePaths;
 *  3. every listed bundlePath is safely contained under vendor/phase-b/
 *     (a path failing this is never touched on the filesystem);
 *  4. the corresponding installed object exists, is a regular file (not a
 *     symlink/FIFO/directory/etc.), and matches the manifest's recorded
 *     mode, size, and SHA-256 content hash.
 */
export function verifyProvenance(dataDir, provenance) {
  const files = Array.isArray(provenance?.files) ? provenance.files : [];
  const identity = validateIdentity(provenance);
  const fileSet = validateFileSet(files);
  const results = files.map((file) => verifyFile(dataDir, file));
  const allOk = identity.ok && fileSet.ok && results.every((r) => r.status === 'ok');
  return {
    allOk,
    fileCount: results.length,
    identity,
    fileSet,
    results,
  };
}
