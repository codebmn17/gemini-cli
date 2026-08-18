/**
 * SPDX-License-Identifier: Apache-2.0
 */

import { runDoctor, formatDoctorReport } from './doctor.mjs';
import { attemptRun } from './run.mjs';

export const GEMINI_LOCAL_BRIDGE_VERSION = '0.1.0-skeleton';

// Distinct from FAIL_CLOSED_EXIT_CODE (run.mjs) so a shell can tell "no
// usable local backend/config" apart from "the installed package itself is
// broken".
export const DOCTOR_STRUCTURAL_FAILURE_EXIT_CODE = 4;

const DOCTOR_COMMANDS = new Set(['doctor', '--doctor', 'status', '--status']);
const VERSION_COMMANDS = new Set(['version', '--version', '-v']);
const HELP_COMMANDS = new Set(['help', '--help', '-h']);

function helpText() {
  return [
    'gemini-local — local-model bridge launcher (C2 host-chain stage)',
    '',
    'usage:',
    '  gemini-local doctor [--json]   filesystem/integrity/config diagnostics only (no network)',
    '  gemini-local status [--json]   alias for doctor',
    '  gemini-local version           print bridge version',
    '  gemini-local help              show this message',
    '  gemini-local <plain prompt>    run the pinned Gemini CLI against the configured local backend',
    '',
    'Without a valid local config, or if the local backend/host launch fails,',
    'the command fails closed. gemini-local never falls back to hosted Gemini',
    'and never modifies the real `gemini` executable or globally installed',
    '@google/gemini-cli package.',
    '',
    'Interactive mode, slash commands, and caller-supplied Gemini CLI flags are',
    'not supported in C2.',
  ].join('\n');
}

export async function main(argv, env = process.env, io = { stdout: process.stdout, stderr: process.stderr }) {
  const [command, ...rest] = argv;
  const wantsJson = rest.includes('--json');

  if (command === undefined || HELP_COMMANDS.has(command)) {
    io.stdout.write(helpText() + '\n');
    return 0;
  }

  if (DOCTOR_COMMANDS.has(command)) {
    const report = runDoctor(env);
    io.stdout.write((wantsJson ? JSON.stringify(report, null, 2) : formatDoctorReport(report)) + '\n');
    // Exit code reflects "is the installed package structurally sound",
    // not "is local inference ready". A missing/invalid local config is a
    // recoverable configuration state and still exits 0; a corrupt/unsafe
    // installed payload exits non-zero.
    return report.structuralFailure ? DOCTOR_STRUCTURAL_FAILURE_EXIT_CODE : 0;
  }

  if (VERSION_COMMANDS.has(command)) {
    io.stdout.write(`gemini-local ${GEMINI_LOCAL_BRIDGE_VERSION}\n`);
    return 0;
  }

  const result = await attemptRun(argv, env);
  (result.ok ? io.stdout : io.stderr).write(result.message + '\n');
  return result.exitCode;
}
