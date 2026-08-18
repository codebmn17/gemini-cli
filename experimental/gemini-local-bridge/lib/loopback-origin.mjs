/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Loopback backend-origin format: the single literal-`127.0.0.1` shape
 * shared by the C1 adapter's own bind/backend-origin checks and the C2
 * local config's backendOrigin field.
 *
 * Deliberately has no other dependencies (no node:http, nothing stateful) so
 * that anything which only needs to validate or reference this format --
 * doctor.mjs included, by way of local-config.mjs -- never has to pull in
 * llama-cpp-adapter.mjs's actual server/listener code to do so.
 */

export const LOOPBACK_HOST = '127.0.0.1';
const BACKEND_ORIGIN_RE = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/;

export function validateBackendOrigin(origin) {
  if (typeof origin !== 'string') {
    throw new TypeError('backendOrigin must be a string');
  }
  const match = BACKEND_ORIGIN_RE.exec(origin);
  if (!match) {
    throw new Error(
      `backendOrigin must be exactly "http://127.0.0.1:<port>" (loopback-only, http-only, no hostname/path); got: ${JSON.stringify(origin)}`,
    );
  }
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`backendOrigin port out of range: ${port}`);
  }
  return { host: LOOPBACK_HOST, port };
}
