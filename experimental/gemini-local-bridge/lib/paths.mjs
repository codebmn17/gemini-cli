/**
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';

export const BRIDGE_NAME = 'gemini-local-bridge';

/**
 * Resolves HOME strictly at call time from the current process environment
 * (falling back to os.homedir()). Never hardcode Android/Termux package
 * paths here — the same installed payload must work on Linux/macOS/Termux.
 */
export function resolveHome(env = process.env) {
  const fromEnv = typeof env.HOME === 'string' && env.HOME.length > 0 ? env.HOME : undefined;
  const home = fromEnv ?? os.homedir();
  if (typeof home !== 'string' || home.length === 0) {
    throw new Error('gemini-local: unable to resolve HOME directory');
  }
  return home;
}

/** Resolves all product-owned paths fresh on every invocation. */
export function resolveLayout(env = process.env) {
  const home = resolveHome(env);
  const binDir = path.join(home, '.local', 'bin');
  const dataDir = path.join(home, '.local', 'share', BRIDGE_NAME);
  const configDir = path.join(home, '.config', BRIDGE_NAME);
  const backendRuntimeDir = path.join(dataDir, 'runtime');
  return {
    home,
    binDir,
    launcherPath: path.join(binDir, 'gemini-local'),
    dataDir,
    configDir,
    provenancePath: path.join(dataDir, 'PROVENANCE.json'),
    vendorDir: path.join(dataDir, 'vendor', 'phase-b'),
    // C2 protocol/identity config. Filename is retained for compatibility.
    adapterMarkerPath: path.join(configDir, 'llama-cpp-adapter.json'),
    // Optional process-ownership config. Its presence authorizes gemini-local
    // to start the configured local llama-server/model when the loopback
    // backend is not already healthy. It never authorizes downloads/builds.
    backendLaunchConfigPath: path.join(configDir, 'llama-cpp-launch.json'),
    backendRuntimeDir,
    backendStatePath: path.join(backendRuntimeDir, 'llama-server-state.json'),
    backendLogPath: path.join(backendRuntimeDir, 'llama-server.log'),
  };
}
