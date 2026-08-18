#!/usr/bin/env node
/**
 * Host-side, one-time generator for PROVENANCE.json.
 *
 * Not part of the installed payload. Run manually (from the repo root of
 * codebmn17/gemini-cli) whenever vendor/phase-b/ is re-promoted from a new
 * accepted review SHA:
 *
 *   node experimental/gemini-local-bridge/tools/generate-provenance.mjs
 *
 * It recomputes the git blob SHA and SHA-256 content hash for every file
 * under vendor/phase-b/ directly from disk (not from git metadata caches),
 * so PROVENANCE.json always reflects exactly what is on disk in this
 * bundle at generation time.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA_VERSION,
  EXPECTED_PROMOTED_COMMIT,
  EXPECTED_PINNED_GEMINI_VERSION,
  EXPECTED_PINNED_GEMINI_COMMIT,
  EXPECTED_VENDOR_FILES,
  installedModeForGitMode,
} from '../lib/provenance-schema.mjs';

const bundleRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const vendorRoot = path.join(bundleRoot, 'vendor', 'phase-b');

const PROMOTED_FROM_REPO = 'codebmn17/gemini-cli';
const PROMOTED_FROM_COMMIT = EXPECTED_PROMOTED_COMMIT;
const PROMOTED_FROM_BRANCH = 'review/termux-local-model-launch-probe-v1';
const PROMOTED_FROM_ORIGINAL_ROOT = 'experimental/termux-local-model-bridge';
const PINNED_GEMINI_CLI_VERSION = EXPECTED_PINNED_GEMINI_VERSION;
const PINNED_GEMINI_CLI_COMMIT = EXPECTED_PINNED_GEMINI_COMMIT;

function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// Reproduces `git hash-object` for a regular file: sha1("blob "+len+"\0"+content).
function gitBlobShaOf(buffer) {
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, buffer])).digest('hex');
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(vendorRoot)
  .sort()
  .map((absPath) => {
    const buffer = readFileSync(absPath);
    const bundlePath = path.relative(bundleRoot, absPath).split(path.sep).join('/');
    const relFromVendorRoot = path.relative(vendorRoot, absPath).split(path.sep).join('/');
    const mode = statSync(absPath).mode & 0o777;
    const gitMode = mode === 0o755 ? '100755' : '100644';
    return {
      originalPath: `${PROMOTED_FROM_ORIGINAL_ROOT}/${relFromVendorRoot}`,
      bundlePath,
      mode: gitMode,
      installedMode: installedModeForGitMode(gitMode),
      gitBlobSha: gitBlobShaOf(buffer),
      sha256: sha256Of(buffer),
      bytes: buffer.length,
    };
  });

const actualPaths = files.map((f) => f.bundlePath).sort();
const expectedPaths = [...EXPECTED_VENDOR_FILES].sort();
if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
  process.stderr.write(
    'generate-provenance: vendor/phase-b/ on disk does not match ' +
      'lib/provenance-schema.mjs EXPECTED_VENDOR_FILES.\n' +
      `  on disk: ${JSON.stringify(actualPaths)}\n` +
      `  expected: ${JSON.stringify(expectedPaths)}\n` +
      'Update EXPECTED_VENDOR_FILES (a deliberate promotion-set change) or fix vendor/phase-b/.\n',
  );
  process.exit(1);
}

const manifest = {
  schemaVersion: SCHEMA_VERSION,
  bundleName: 'gemini-local-bridge-promotion',
  promotedFromRepo: PROMOTED_FROM_REPO,
  promotedFromCommit: PROMOTED_FROM_COMMIT,
  promotedFromBranch: PROMOTED_FROM_BRANCH,
  promotedFromOriginalRoot: PROMOTED_FROM_ORIGINAL_ROOT,
  pinnedGeminiCli: {
    version: PINNED_GEMINI_CLI_VERSION,
    commit: PINNED_GEMINI_CLI_COMMIT,
  },
  generatedAt: new Date().toISOString(),
  generatedBy: 'host-side automated promotion script (Linux); not a Termux/device build',
  note:
    'Files listed here are byte-for-byte copies of the accepted PR review head. ' +
    'test/ files from the review stack are intentionally excluded from the ' +
    'installable payload (dev/CI-only, not required at runtime).',
  files,
};

const outPath = path.join(bundleRoot, 'PROVENANCE.json');
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(`wrote ${outPath} (${files.length} files)\n`);
