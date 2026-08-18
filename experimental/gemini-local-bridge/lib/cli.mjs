/**
 * SPDX-License-Identifier: Apache-2.0
 */

import { runDoctor, formatDoctorReport } from './doctor.mjs';
import { attemptRun } from './run.mjs';

export const GEMINI_LOCAL_BRIDGE_VERSION = '0.1.0-skeleton';

// Distinct from FAIL_CLOSED_EXIT_CODE (run.mjs) so a shell can tell "no
// local backend yet" apart from "the installed package itself is broken".
export const DOCTOR_STRUCTURAL_FAILURE_EXIT_CODE = 4;

const DOCTOR_COMMANDS = new Set(['doctor', '--doctor', 'status', '--status']);
const VERSION_COMMANDS = new Set(['version', '--version', '-v']);
const HELP_COMMANDS = new Set(['help', '--help', '-h']);

function helpText() {
  return [
    'gemini-local — Termux/local-model bridge launcher (skeleton stage)',
    '',
    'usage:',
    '  gemini-local doctor [--json]   run diagnostics only (no inference, no network)',
    '  gemini-local status [--json]   alias for doctor',
    '  gemini-local version           print bridge + promoted-provenance version info',
    '  gemini-local help              show this message',
    '  gemini-local <anything else>   FAILS CLOSED: no local backend installed yet',
    '',
    'gemini-local never falls back to hosted Gemini and never modifies the',
    'real `gemini` executable or the globally installed @google/gemini-cli package.',
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
    // not "is local inference ready" — the llama.cpp adapter being absent
    // is an expected skeleton-stage state and still exits 0. A corrupt or
    // unsafe installation (missing/extra/duplicate promoted file, identity
    // mismatch, hash/mode/size mismatch, unsafe path) exits non-zero so a
    // calling shell script can distinguish "not ready yet" from "broken".
    return report.structuralFailure ? DOCTOR_STRUCTURAL_FAILURE_EXIT_CODE : 0;
  }

  if (VERSION_COMMANDS.has(command)) {
    io.stdout.write(`gemini-local ${GEMINI_LOCAL_BRIDGE_VERSION}\n`);
    return 0;
  }

  const result = attemptRun(argv, env);
  io.stderr.write(result.message + '\n');
  return result.exitCode;
}
