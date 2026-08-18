/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';

export const BRIDGE_NAME = 'gemini-local-bridge';

/**
 * Resolves HOME strictly at call time from the current process environment
 * (falling back to os.homedir()). Never hardcode Android/Termux package
 * paths (e.g. /data/data/com.termux/files/home) here — this must keep
 * working unmodified on plain Linux, macOS, and Termux alike.
 */
export function resolveHome(env = process.env) {
  const fromEnv = typeof env.HOME === 'string' && env.HOME.length > 0 ? env.HOME : undefined;
  const home = fromEnv ?? os.homedir();
  if (typeof home !== 'string' || home.length === 0) {
    throw new Error('gemini-local: unable to resolve HOME directory');
  }
  return home;
}

/**
 * Layout is derived fresh from the environment on every call. Nothing here
 * is baked in at install time; the installed launcher recomputes this on
 * every invocation.
 */
export function resolveLayout(env = process.env) {
  const home = resolveHome(env);
  const binDir = path.join(home, '.local', 'bin');
  const dataDir = path.join(home, '.local', 'share', BRIDGE_NAME);
  const configDir = path.join(home, '.config', BRIDGE_NAME);
  return {
    home,
    binDir,
    launcherPath: path.join(binDir, 'gemini-local'),
    dataDir,
    configDir,
    provenancePath: path.join(dataDir, 'PROVENANCE.json'),
    vendorDir: path.join(dataDir, 'vendor', 'phase-b'),
    adapterMarkerPath: path.join(configDir, 'llama-cpp-adapter.json'),
  };
}
