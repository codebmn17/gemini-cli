#!/usr/bin/env node
import fs from 'node:fs';
import {
  AUTH_CANDIDATES,
  buildAuthRoutingContract,
} from '../lib/phase-b-auth-routing.mjs';

const MAX_PREFLIGHT_BYTES = 1024 * 1024;

function usage() {
  return (
    'usage: phase-b-auth-routing --candidate <use-gemini|gateway> ' +
    '--recorder-url <http://127.0.0.1:PORT> --preflight-file <path>'
  );
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!['--candidate', '--recorder-url', '--preflight-file'].includes(arg)) {
      throw new Error('invalid arguments');
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw new Error('invalid arguments');
    }
    if (result[arg] !== undefined) throw new Error('invalid arguments');
    result[arg] = argv[index + 1];
    index += 1;
  }
  if (
    !result['--candidate'] ||
    !result['--recorder-url'] ||
    !result['--preflight-file']
  ) {
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
  const candidate = args['--candidate'];
  if (!Object.values(AUTH_CANDIDATES).includes(candidate)) {
    throw new Error('invalid candidate');
  }
  const preflightReport = readPreflight(args['--preflight-file']);
  const contract = buildAuthRoutingContract({
    candidate,
    recorderUrl: args['--recorder-url'],
    preflightReport,
  });
  process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`);
} catch {
  process.stderr.write(`phase-b-auth-routing failed closed\n${usage()}\n`);
  process.exitCode = 2;
}
