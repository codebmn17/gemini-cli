/**
 * SPDX-License-Identifier: Apache-2.0
 */

import { runDoctor, formatDoctorReport } from './doctor.mjs';
import { attemptRun, LOCAL_RUN_FAILURE_EXIT_CODE } from './run.mjs';
import { loadLocalConfig, LocalConfigError } from './local-config.mjs';
import {
  getBackendStatus,
  stopManagedBackend,
  restartManagedBackend,
  ManagedBackendError,
} from './managed-backend.mjs';
import { resolveLayout } from './paths.mjs';

export const GEMINI_LOCAL_BRIDGE_VERSION = '0.2.0-local';
export const DOCTOR_STRUCTURAL_FAILURE_EXIT_CODE = 4;

const DOCTOR_COMMANDS = new Set(['doctor', '--doctor']);
const STATUS_COMMANDS = new Set(['status', '--status']);
const VERSION_COMMANDS = new Set(['version', '--version', '-v']);
const HELP_COMMANDS = new Set(['help', '--help', '-h']);

function helpText() {
  return [
    'gemini-local — local-model bridge launcher',
    '',
    'usage:',
    '  gemini-local doctor [--json]   filesystem/integrity/config diagnostics only (no network)',
    '  gemini-local status [--json]   doctor diagnostics plus live backend/ownership status',
    '  gemini-local stop              stop only a verified gemini-local-owned llama-server',
    '  gemini-local restart           restart the configured managed llama-server',
    '  gemini-local version           print bridge version',
    '  gemini-local help              show this message',
    '  gemini-local <plain prompt>    run the pinned Gemini CLI against the configured local backend/model',
    '',
    'If the backend is already healthy it is reused. If it is down and a valid',
    'llama-cpp-launch.json is present, gemini-local starts that exact local',
    'llama-server/model automatically and waits for it to become healthy.',
    'No model is downloaded or built automatically.',
    '',
    'Every failure stays local: gemini-local never falls back to hosted Gemini',
    'and never modifies the real `gemini` executable or global Gemini package.',
    'Interactive mode, slash commands, and caller-supplied Gemini CLI flags are',
    'not supported yet.',
  ].join('\n');
}

function loadConfigForRuntimeCommand(env) {
  const layout = resolveLayout(env);
  try {
    return loadLocalConfig(layout.adapterMarkerPath);
  } catch (error) {
    if (!(error instanceof LocalConfigError)) throw error;
    return null;
  }
}

function formatBackendStatus(status) {
  const parts = [
    `Backend status: ${status.status}`,
    `Healthy: ${status.healthy ? 'yes' : 'no'}`,
    `Managed: ${status.managed ? 'yes' : 'no'}`,
  ];
  if (status.pid) parts.push(`PID: ${status.pid}`);
  if (status.ownedProcessVerified !== undefined) {
    parts.push(`Owned process verified: ${status.ownedProcessVerified ? 'yes' : 'no'}`);
  }
  if (status.detail) parts.push(`Detail: ${status.detail}`);
  return parts.join('\n');
}

export async function main(
  argv,
  env = process.env,
  io = { stdout: process.stdout, stderr: process.stderr },
) {
  const [command, ...rest] = argv;
  const wantsJson = rest.includes('--json');

  if (command === undefined || HELP_COMMANDS.has(command)) {
    io.stdout.write(helpText() + '\n');
    return 0;
  }

  if (DOCTOR_COMMANDS.has(command)) {
    const report = runDoctor(env);
    io.stdout.write((wantsJson ? JSON.stringify(report, null, 2) : formatDoctorReport(report)) + '\n');
    return report.structuralFailure ? DOCTOR_STRUCTURAL_FAILURE_EXIT_CODE : 0;
  }

  if (VERSION_COMMANDS.has(command)) {
    io.stdout.write(`gemini-local ${GEMINI_LOCAL_BRIDGE_VERSION}\n`);
    return 0;
  }

  if (STATUS_COMMANDS.has(command)) {
    const report = runDoctor(env);
    const config = loadConfigForRuntimeCommand(env);
    let backend = { status: 'not-configured', healthy: false, managed: false };
    if (config) {
      try {
        backend = await getBackendStatus({ config, env });
      } catch (error) {
        if (!(error instanceof ManagedBackendError)) throw error;
        backend = {
          status: 'status-error',
          healthy: false,
          managed: true,
          detail: `${error.category}: ${error.message}`,
        };
      }
    }
    if (wantsJson) {
      io.stdout.write(JSON.stringify({ doctor: report, backend }, null, 2) + '\n');
    } else {
      io.stdout.write(formatDoctorReport(report) + '\n\n' + formatBackendStatus(backend) + '\n');
    }
    return report.structuralFailure ? DOCTOR_STRUCTURAL_FAILURE_EXIT_CODE : 0;
  }

  if (command === 'stop' || command === 'restart') {
    if (rest.length !== 0) {
      io.stderr.write(`gemini-local ${command}: no additional arguments are accepted\n`);
      return LOCAL_RUN_FAILURE_EXIT_CODE;
    }
    const config = loadConfigForRuntimeCommand(env);
    if (!config) {
      io.stderr.write(`gemini-local ${command}: no valid local config is present\n`);
      return LOCAL_RUN_FAILURE_EXIT_CODE;
    }
    try {
      if (command === 'stop') {
        const result = await stopManagedBackend({ config, env });
        io.stdout.write(`Backend ${result.status}.\n`);
      } else {
        const result = await restartManagedBackend({ config, env });
        io.stdout.write(`Backend ${result.mode}.\n`);
      }
      return 0;
    } catch (error) {
      if (!(error instanceof ManagedBackendError)) throw error;
      io.stderr.write(`gemini-local ${command} failed (${error.category}): ${error.message}\n`);
      return LOCAL_RUN_FAILURE_EXIT_CODE;
    }
  }

  const result = await attemptRun(argv, env);
  (result.ok ? io.stdout : io.stderr).write(result.message + '\n');
  return result.exitCode;
}
