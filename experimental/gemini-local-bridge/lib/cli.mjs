/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { runDoctor, formatDoctorReport } from './doctor.mjs';
import { attemptRun } from './run.mjs';

export const GEMINI_LOCAL_BRIDGE_VERSION = '0.1.0-skeleton';

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
    // Exit code reflects "did diagnostics run", not "is local inference
    // ready" — readiness is reported in the output, not the exit code.
    return 0;
  }

  if (VERSION_COMMANDS.has(command)) {
    io.stdout.write(`gemini-local ${GEMINI_LOCAL_BRIDGE_VERSION}\n`);
    return 0;
  }

  const result = attemptRun(argv, env);
  io.stderr.write(result.message + '\n');
  return result.exitCode;
}
