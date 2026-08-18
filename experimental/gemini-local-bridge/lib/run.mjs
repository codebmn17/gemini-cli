/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Prompt handling.
 *
 * As of C2, this module may launch the real chain -- but only when a valid
 * local config (lib/local-config.mjs) is already present on disk, and only
 * for a narrow plain-text prompt. Everything else must keep failing exactly
 * the way the pre-C2 skeleton did:
 *   - no valid local config -> the same fixed fail-closed message/exit code
 *     as before, regardless of what the caller's argv looks like;
 *   - caller argv containing anything shaped like a flag (leading "-") is
 *     rejected before a config is even consulted for launch purposes -- see
 *     isSafePromptToken. gemini-local owns every argument the real Gemini
 *     CLI child receives (lib/local-gemini-runner.mjs builds that argv
 *     itself); nothing from the caller's argv is ever forwarded as a
 *     separate argv entry to that child, but rejecting flag-shaped input
 *     here first avoids the confusing UX of a caller's intended flag
 *     silently becoming literal prompt text, and is the primary gate the
 *     runner's own isSafePromptToken re-checks as a second, independent
 *     layer;
 *   - interactive mode and slash commands are not supported: an empty
 *     prompt fails closed rather than starting a REPL;
 *   - any failure while actually running the local chain (backend
 *     unhealthy, distribution mismatch, child timeout/crash/bad output,
 *     etc.) fails locally with a plain category/message -- never a fallback
 *     to hosted Gemini, ever.
 */

import { loadLocalConfig, LocalConfigError } from './local-config.mjs';
import { runLocalGeminiPrompt, LocalRunError } from './local-gemini-runner.mjs';
import { resolveLayout } from './paths.mjs';

export const FAIL_CLOSED_EXIT_CODE = 3;
// Distinct from FAIL_CLOSED_EXIT_CODE (no config, or rejected argv -- neither
// ever reaches the real Gemini CLI) so a caller can tell "gemini-local
// refused to try" apart from "gemini-local tried and the local run failed".
export const LOCAL_RUN_FAILURE_EXIT_CODE = 5;

const NOT_CONFIGURED_MESSAGE =
  'gemini-local: no local inference backend is configured yet.\n' +
  'Refusing to run — gemini-local never falls back to hosted Gemini.\n' +
  'Run "gemini-local doctor" for diagnostics.';

/**
 * Mirrors local-gemini-runner.mjs's own isSafePromptToken exactly (see that
 * module's doc comment for why the check is deliberately duplicated rather
 * than shared): a prompt token starting with "-" is rejected here, first.
 */
function isSafePromptToken(token) {
  return typeof token === 'string' && token.length > 0 && !token.startsWith('-');
}

function notAPromptMessage() {
  return (
    'gemini-local: expected a plain-text prompt, e.g. gemini-local "hello".\n' +
    'Arguments starting with "-" are not accepted here — gemini-local owns all\n' +
    'Gemini CLI arguments itself. Interactive mode and slash commands are not\n' +
    'supported yet.'
  );
}

/**
 * `args` is the caller's full argv (cli.mjs only calls this once the first
 * token has already failed to match doctor/status/version/help, so every
 * element here is intended as prompt text, never a subcommand).
 */
export async function attemptRun(args, env = process.env) {
  const layout = resolveLayout(env);

  let config;
  try {
    config = loadLocalConfig(layout.adapterMarkerPath);
  } catch (error) {
    if (!(error instanceof LocalConfigError)) throw error;
    return {
      ok: false,
      exitCode: FAIL_CLOSED_EXIT_CODE,
      message: NOT_CONFIGURED_MESSAGE,
    };
  }

  if (!Array.isArray(args) || args.length === 0 || !args.every(isSafePromptToken)) {
    return {
      ok: false,
      exitCode: FAIL_CLOSED_EXIT_CODE,
      message: notAPromptMessage(),
    };
  }

  try {
    const result = await runLocalGeminiPrompt({
      config,
      promptArgv: args,
      parentEnv: env,
    });
    return { ok: true, exitCode: 0, message: result.response };
  } catch (error) {
    if (!(error instanceof LocalRunError)) throw error;
    return {
      ok: false,
      exitCode: LOCAL_RUN_FAILURE_EXIT_CODE,
      message:
        `gemini-local: local run failed (${error.category}): ${error.message}\n` +
        'gemini-local never falls back to hosted Gemini.',
    };
  }
}
