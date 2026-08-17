#!/usr/bin/env node

import {
  createRecorderServer,
  DEFAULT_BODY_LIMIT_BYTES,
  DEFAULT_HOST,
} from '../lib/phase-b-recorder.mjs';

function parseInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer`);
  }
  return parsed;
}

function parsePositiveInt(value, label) {
  const parsed = parseInteger(value, label);
  if (parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    port: 0,
    bodyLimitBytes: DEFAULT_BODY_LIMIT_BYTES,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--port requires a value');
      const parsed = parseInteger(value, '--port');
      if (parsed < 0 || parsed > 65535) {
        throw new Error('--port must be an integer between 0 and 65535');
      }
      options.port = parsed;
    } else if (arg === '--body-limit-bytes') {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error('--body-limit-bytes requires a value');
      }
      options.bodyLimitBytes = parsePositiveInt(value, '--body-limit-bytes');
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  process.stdout.write(
    [
      'Phase B sanitized Gemini request recorder',
      '',
      'Usage:',
      '  node bin/phase-b-recorder.mjs [--port <n>] [--body-limit-bytes <n>]',
      '',
      `Binds only to ${DEFAULT_HOST}.`,
      'Outputs one sanitized JSON record per request and never prints raw bodies',
      'or credential/header values.',
      '',
    ].join('\n'),
  );
}

let recorder;

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    process.exitCode = 0;
  } else {
    recorder = createRecorderServer({
      port: options.port,
      bodyLimitBytes: options.bodyLimitBytes,
      onRecord(record) {
        process.stdout.write(`${JSON.stringify(record)}\n`);
      },
    });

    const address = await recorder.listen();
    process.stderr.write(
      `Phase B recorder listening on http://${address.host}:${address.port}\n`,
    );
  }
} catch (error) {
  process.stderr.write(`Phase B recorder failed: ${error.message}\n`);
  process.exitCode = 1;
}

async function shutdown() {
  if (recorder) await recorder.close();
}

process.once('SIGINT', async () => {
  await shutdown();
  process.exit(130);
});

process.once('SIGTERM', async () => {
  await shutdown();
  process.exit(143);
});
