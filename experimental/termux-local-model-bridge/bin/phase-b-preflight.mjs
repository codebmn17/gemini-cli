#!/usr/bin/env node

import { resolve } from 'node:path';
import process from 'node:process';

import { runPhaseBPreflight } from '../lib/phase-b-preflight.mjs';

function parseArgs(argv) {
  let workspaceDir = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--workspace') {
      const value = argv[index + 1];
      if (!value) throw new Error('missing workspace');
      workspaceDir = resolve(value);
      index += 1;
      continue;
    }
    throw new Error('unsupported argument');
  }
  return { workspaceDir };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const report = runPhaseBPreflight(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.allowed ? 0 : 2;
} catch {
  process.stderr.write('phase-b-preflight failed closed\n');
  process.exitCode = 1;
}
