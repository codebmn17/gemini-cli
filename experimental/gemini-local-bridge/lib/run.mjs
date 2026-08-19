/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Prompt handling. A valid C2 protocol config still gates all inference.
 * Before launching Gemini, the optional managed-backend layer reuses a
 * healthy loopback llama-server or starts the explicitly configured local
 * binary/model. It never downloads/builds anything and never falls back to
 * hosted Gemini.
 */

import { loadLocalConfig, LocalConfigError } from './local-config.mjs';
import { runLocalGeminiPrompt, LocalRunError } from './local-gemini-runner.mjs';
import { ensureBackendReady, ManagedBackendError } from './managed-backend.mjs';
import { resolveLayout } from './paths.mjs';

export const FAIL_CLOSED_EXIT_CODE = 3;
export const LOCAL_RUN_FAILURE_EXIT_CODE = 5;

const NOT_CONFIGURED_MESSAGE =
  'gemini-local: no local inference backend is configured yet.\n' +
  'Refusing to run — gemini-local never falls back to hosted Gemini.\n' +
  'Run "gemini-local doctor" for diagnostics.';

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

export async function attemptRun(args, env = process.env) {
  const layout = resolveLayout(env);

  let config;
  try {
    config = loadLocalConfig(layout.adapterMarkerPath);
  } catch (error) {
    if (!(error instanceof LocalConfigError)) throw error;
    return { ok: false, exitCode: FAIL_CLOSED_EXIT_CODE, message: NOT_CONFIGURED_MESSAGE };
  }

  if (!Array.isArray(args) || args.length === 0 || !args.every(isSafePromptToken)) {
    return { ok: false, exitCode: FAIL_CLOSED_EXIT_CODE, message: notAPromptMessage() };
  }

  try {
    await ensureBackendReady({ config, env });
    const result = await runLocalGeminiPrompt({
      config,
      promptArgv: args,
      parentEnv: env,
    });
    return { ok: true, exitCode: 0, message: result.response };
  } catch (error) {
    if (!(error instanceof LocalRunError) && !(error instanceof ManagedBackendError)) throw error;
    return {
      ok: false,
      exitCode: LOCAL_RUN_FAILURE_EXIT_CODE,
      message:
        `gemini-local: local run failed (${error.category}): ${error.message}\n` +
        'gemini-local never falls back to hosted Gemini.',
    };
  }
}
