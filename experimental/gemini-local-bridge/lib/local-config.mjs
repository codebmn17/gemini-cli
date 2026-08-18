/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * C2 local adapter configuration: the single file that turns gemini-local
 * from "always fails closed" into "launches the real pinned Gemini CLI
 * against a local backend". validateLocalConfig()/loadLocalConfig() never
 * make a network call or spawn a process themselves; they only delegate to
 * two other accepted, equally filesystem-only primitives (backendOrigin ->
 * loopback-origin.mjs's pure string-format validator; geminiRoot -> the
 * accepted, unmodified Phase-B pinned-distribution verifier, which only
 * stats/reads files under geminiRoot). That vendor verifier's own file
 * imports node:child_process/node:http transitively for unrelated helpers
 * this module never calls — importing a module never executes its code, so
 * that import has no bearing on what loading or calling into this file
 * actually does.
 *
 * Schema (schemaVersion 1) — exactly these six keys, nothing else:
 *   schemaVersion: 1
 *   backend:       "llama.cpp"                    (only supported value)
 *   backendOrigin: "http://127.0.0.1:<port>"       (C1 loopback-only form)
 *   backendModel:  "<actual local model id>"       (sent to the backend)
 *   clientModel:   "local" | "local-*" | "local/*" (sent to Gemini CLI;
 *                                                    structurally cannot be
 *                                                    a Gemini-branded name)
 *   geminiRoot:    "/path/to/verified/@google/gemini-cli/root"
 *
 * No credential field exists in this schema, and the exact-key-set check
 * rejects anything not listed above — there is nowhere to put one even by
 * accident.
 */

import { lstatSync, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { validateBackendOrigin } from './loopback-origin.mjs';
import { resolvePinnedGeminiDistribution } from '../vendor/phase-b/lib/phase-b-launch-probe.mjs';

export const LOCAL_CONFIG_SCHEMA_VERSION = 1;
export const SUPPORTED_BACKEND = 'llama.cpp';
export const MAX_CONFIG_BYTES = 8192;

const REQUIRED_KEYS = Object.freeze([
  'schemaVersion',
  'backend',
  'backendOrigin',
  'backendModel',
  'clientModel',
  'geminiRoot',
]);

const CLIENT_MODEL_RE = /^local(-[a-zA-Z0-9._-]+|\/[a-zA-Z0-9._/-]+)?$/;

export class LocalConfigError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'LocalConfigError';
  }
}

function fail(reason) {
  throw new LocalConfigError(reason);
}

/**
 * Reads a config file with the same no-follow, bounded, single-descriptor
 * discipline used elsewhere in this bundle (see phase-b-launch-probe.mjs's
 * manifest read and integrity.mjs's lstat-first pattern): lstat first so a
 * symlink is rejected before anything opens it, then read through one held
 * file descriptor so the file that gets stat-checked is exactly the file
 * that gets read.
 */
function readRegularFileNoFollow(targetPath, maxBytes) {
  let lstat;
  try {
    lstat = lstatSync(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`local config not found: ${targetPath}`);
    fail(`unable to stat local config: ${targetPath}`);
  }
  if (lstat.isSymbolicLink()) {
    fail(`local config must not be a symlink: ${targetPath}`);
  }
  if (!lstat.isFile()) {
    fail(`local config must be a regular file: ${targetPath}`);
  }
  if (lstat.size > maxBytes) {
    fail(`local config exceeds bounded size limit (${lstat.size} > ${maxBytes} bytes)`);
  }

  const fd = openSync(targetPath, 'r');
  try {
    const openStat = fstatSync(fd);
    if (openStat.isSymbolicLink() || !openStat.isFile()) {
      fail('local config changed type between lstat and open');
    }
    if (openStat.dev !== lstat.dev || openStat.ino !== lstat.ino) {
      fail('local config identity changed between lstat and open');
    }
    if (openStat.size > maxBytes) {
      fail(`local config exceeds bounded size limit (${openStat.size} > ${maxBytes} bytes)`);
    }
    const buffer = Buffer.alloc(openStat.size);
    let readTotal = 0;
    while (readTotal < buffer.length) {
      const bytesRead = readSync(fd, buffer, readTotal, buffer.length - readTotal, readTotal);
      if (bytesRead === 0) break;
      readTotal += bytesRead;
    }
    return buffer.subarray(0, readTotal).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`local config field "${field}" must be a non-empty string`);
  }
  return value;
}

/**
 * Validates an already-parsed config object. Exported separately from the
 * file loader so tests can exercise schema validation without touching the
 * filesystem, and so the loader and any future config source share exactly
 * one validation path.
 */
export function validateLocalConfig(parsed) {
  if (!isPlainObject(parsed)) {
    fail('local config must be a JSON object');
  }

  const keys = Object.keys(parsed);
  for (const key of keys) {
    if (!REQUIRED_KEYS.includes(key)) {
      fail(`local config contains an unknown field: "${key}"`);
    }
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in parsed)) {
      fail(`local config is missing required field: "${key}"`);
    }
  }

  if (parsed.schemaVersion !== LOCAL_CONFIG_SCHEMA_VERSION) {
    fail(`local config schemaVersion must be ${LOCAL_CONFIG_SCHEMA_VERSION}, got: ${JSON.stringify(parsed.schemaVersion)}`);
  }
  if (parsed.backend !== SUPPORTED_BACKEND) {
    fail(`local config backend must be "${SUPPORTED_BACKEND}", got: ${JSON.stringify(parsed.backend)}`);
  }

  requireNonEmptyString(parsed.backendOrigin, 'backendOrigin');
  try {
    validateBackendOrigin(parsed.backendOrigin);
  } catch (error) {
    fail(`local config backendOrigin is invalid: ${error?.message ?? error}`);
  }

  requireNonEmptyString(parsed.backendModel, 'backendModel');

  requireNonEmptyString(parsed.clientModel, 'clientModel');
  if (!CLIENT_MODEL_RE.test(parsed.clientModel)) {
    fail(
      `local config clientModel must be a neutral local identifier ("local", "local-<id>", or "local/<id>"), not a Gemini-branded model name: ${JSON.stringify(parsed.clientModel)}`,
    );
  }
  // Pinned Gemini CLI 0.55.1's own resolveModel()/isFlashModel() special-
  // cases ANY string ending in "flash" (packages/core/src/config/models.ts):
  // `model.endsWith('flash')` -- and can silently remap it to a real
  // Gemini-branded flash model name when the CLI's internal
  // useGemini3_5Flash state is true. A "local-"-prefixed value already
  // rules out every literal reserved alias/constant, but a value like
  // "local-flash" would still trip that suffix check inside Gemini CLI
  // itself. Reject it here so a neutral-looking clientModel can never be
  // silently rebranded downstream, regardless of that internal flag state.
  if (parsed.clientModel.endsWith('flash')) {
    fail(
      `local config clientModel must not end in "flash" (pinned Gemini CLI's own model resolution treats any such string as flash-family and may rebrand it): ${JSON.stringify(parsed.clientModel)}`,
    );
  }

  requireNonEmptyString(parsed.geminiRoot, 'geminiRoot');
  let distribution;
  try {
    distribution = resolvePinnedGeminiDistribution(parsed.geminiRoot);
  } catch (error) {
    fail(`local config geminiRoot failed pinned-distribution verification: ${error?.message ?? error}`);
  }

  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    backend: parsed.backend,
    backendOrigin: parsed.backendOrigin,
    backendModel: parsed.backendModel,
    clientModel: parsed.clientModel,
    geminiRoot: parsed.geminiRoot,
    distribution,
  });
}

/** Loads and validates the local config from disk. Throws LocalConfigError on any problem — callers must treat that as "no valid local configuration", never as a reason to fall back to hosted Gemini. */
export function loadLocalConfig(configPath) {
  const text = readRegularFileNoFollow(configPath, MAX_CONFIG_BYTES);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`local config is not valid JSON: ${configPath}`);
  }
  return validateLocalConfig(parsed);
}
