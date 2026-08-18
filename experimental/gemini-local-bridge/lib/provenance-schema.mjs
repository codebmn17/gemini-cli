/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Single source of truth for the promoted-bundle's expected shape, shared
 * by tools/generate-provenance.mjs (which writes PROVENANCE.json) and
 * lib/integrity.mjs (which verifies an installed copy against it). Keeping
 * both in one place avoids the generator and the verifier silently
 * drifting apart.
 */

export const SCHEMA_VERSION = 2;

export const VENDOR_ROOT_PREFIX = 'vendor/phase-b/';

export const EXPECTED_PROMOTED_COMMIT = 'e9c5ad7f382be3144daf71b7f477db1a183955da';
export const EXPECTED_PINNED_GEMINI_VERSION = '0.55.1';
export const EXPECTED_PINNED_GEMINI_COMMIT = '41327e407da58aa01c409ef6685b7b5d379f295e';

// The exact set of files this bundle promotes. verifyProvenance() checks the
// installed manifest's file list against this set exactly (no fewer, no
// more, no duplicates) rather than trusting whatever list the manifest on
// disk happens to contain.
export const EXPECTED_VENDOR_FILES = Object.freeze([
  'vendor/phase-b/bin/phase-b-auth-routing.mjs',
  'vendor/phase-b/bin/phase-b-launch-probe.mjs',
  'vendor/phase-b/bin/phase-b-preflight.mjs',
  'vendor/phase-b/bin/phase-b-recorder.mjs',
  'vendor/phase-b/lib/phase-b-auth-routing.mjs',
  'vendor/phase-b/lib/phase-b-launch-probe.mjs',
  'vendor/phase-b/lib/phase-b-preflight.mjs',
  'vendor/phase-b/lib/phase-b-recorder.mjs',
  'vendor/phase-b/lib/phase-b-runtime.mjs',
  'vendor/phase-b/package.json',
]);

// Accepted (git) mode -> expected installed filesystem mode. Read-only in
// both cases, but the executable bit distinction the accepted commit
// recorded (100755 for the bin/ launchers vs 100644 for lib/package.json)
// is preserved rather than collapsed to a single blanket mode.
const INSTALLED_MODE_BY_GIT_MODE = Object.freeze({
  '100755': '0555',
  '100644': '0444',
});

export function installedModeForGitMode(gitMode) {
  const installed = INSTALLED_MODE_BY_GIT_MODE[gitMode];
  if (!installed) {
    throw new Error(`provenance-schema: unrecognized accepted git mode "${gitMode}"`);
  }
  return installed;
}
