#!/usr/bin/env node
import fs from 'node:fs';
import { runPhaseBLaunchProbe } from '../lib/phase-b-launch-probe.mjs';

const MAX_PREFLIGHT_BYTES = 1024 * 1024;

function usage() {
  return (
    'usage: phase-b-launch-probe --gemini-root <built-pinned-distribution> ' +
    '--preflight-file <path>'
  );
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!['--gemini-root', '--preflight-file'].includes(arg)) {
      throw new Error('invalid arguments');
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw new Error('invalid arguments');
    }
    if (result[arg] !== undefined) throw new Error('invalid arguments');
    result[arg] = argv[index + 1];
    index += 1;
  }
  if (!result['--gemini-root'] || !result['--preflight-file']) {
    throw new Error('invalid arguments');
  }
  return result;
}

function readPreflight(filePath) {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('preflight input must be a regular file');
    if (stat.size > MAX_PREFLIGHT_BYTES) {
      throw new Error('preflight input too large');
    }
    const text = fs.readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_PREFLIGHT_BYTES) {
      throw new Error('preflight input too large');
    }
    return JSON.parse(text);
  } finally {
    fs.closeSync(descriptor);
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  const preflightReport = readPreflight(args['--preflight-file']);
  const report = await runPhaseBLaunchProbe({
    geminiRoot: args['--gemini-root'],
    preflightReport,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  const code =
    typeof error?.code === 'string' ? error.code : 'PHASE_B_LAUNCH_PROBE_FAILED';
  process.stderr.write(`phase-b-launch-probe failed closed: ${code}\n${usage()}\n`);
  process.exitCode = 2;
}
