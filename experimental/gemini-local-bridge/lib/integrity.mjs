/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Deliberately fs-only: no network, no child_process. Used by `doctor` to
// prove the installed vendored payload has not been tampered with since
// promotion.
export function sha256File(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

/**
 * Recomputes SHA-256 for every file the provenance manifest lists (resolved
 * relative to dataDir, since bundlePath is bundle-root-relative) and
 * compares against the recorded value. Never trusts the manifest's byte
 * count or hash alone as a substitute for reading the real installed file.
 */
export function verifyProvenance(dataDir, provenance) {
  const files = Array.isArray(provenance?.files) ? provenance.files : [];
  const results = files.map((file) => {
    const absPath = path.join(dataDir, file.bundlePath);
    try {
      const actual = sha256File(absPath);
      if (actual === file.sha256) {
        return { bundlePath: file.bundlePath, status: 'ok' };
      }
      return {
        bundlePath: file.bundlePath,
        status: 'hash-mismatch',
        expected: file.sha256,
        actual,
      };
    } catch (error) {
      return {
        bundlePath: file.bundlePath,
        status: error?.code === 'ENOENT' ? 'missing' : 'error',
        detail: error?.code ?? String(error?.message ?? error),
      };
    }
  });
  return {
    allOk: results.length > 0 && results.every((r) => r.status === 'ok'),
    fileCount: results.length,
    results,
  };
}
