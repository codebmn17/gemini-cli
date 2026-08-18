/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Skeleton-stage prompt handling.
 *
 * There is intentionally no llama.cpp adapter wired up yet. This module
 * must NEVER:
 *   - import node:child_process / spawn anything (including the real
 *     `gemini` binary or the vendored phase-b launch probe);
 *   - import node:net / node:http / node:https or use the fetch API;
 *   - read or forward any caller-supplied prompt text to any process or
 *     network endpoint.
 *
 * Any invocation that is not a recognized diagnostic subcommand
 * (doctor/status/version/help) must fail closed here: refuse, explain why,
 * and exit non-zero. It must never silently fall back to hosted Gemini.
 */

export const FAIL_CLOSED_EXIT_CODE = 3;

export function attemptRun(_args, _env = process.env) {
  return {
    ok: false,
    exitCode: FAIL_CLOSED_EXIT_CODE,
    message:
      'gemini-local: no local inference backend is installed yet (llama.cpp adapter not wired up in this build).\n' +
      'Refusing to run — gemini-local never falls back to hosted Gemini.\n' +
      'Run "gemini-local doctor" for diagnostics.',
  };
}
