import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classifyApiKeyHeader,
  createRecorderServer,
  LOCAL_PLACEHOLDER_API_KEY,
  sanitizeContentType,
  sanitizeJsonShape,
  sanitizeRequest,
} from '../lib/phase-b-recorder.mjs';

test('classifyApiKeyHeader never returns header values', () => {
  assert.equal(classifyApiKeyHeader(undefined), 'absent');
  assert.equal(classifyApiKeyHeader(''), 'empty');
  assert.equal(
    classifyApiKeyHeader(LOCAL_PLACEHOLDER_API_KEY),
    'placeholder-match',
  );
  assert.equal(classifyApiKeyHeader('real-secret-value'), 'nonempty-unexpected');
});

test('sanitizeJsonShape preserves structure without values', () => {
  assert.deepEqual(
    sanitizeJsonShape({
      model: 'gemini-test',
      contents: [{ role: 'user', parts: [{ text: 'private prompt' }] }],
      generationConfig: { temperature: 0.25, candidateCount: 1 },
      enabled: true,
      optional: null,
    }),
    {
      model: 'string',
      contents: [
        {
          role: 'string',
          parts: [{ text: 'string' }],
        },
      ],
      generationConfig: { temperature: 'number', candidateCount: 'number' },
      enabled: 'boolean',
      optional: 'null',
    },
  );
});

test('sanitizeJsonShape enforces depth, array, and object-key truncation', () => {
  const tooManyKeys = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [`key${index}`, index]),
  );
  const deep = { level: {} };
  let cursor = deep.level;
  for (let index = 0; index < 8; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }

  const shape = sanitizeJsonShape({
    array: [1, 2, 3, 4, 5],
    object: tooManyKeys,
    deep,
  });

  assert.deepEqual(shape.array, [
    'number',
    'number',
    'number',
    'number',
    '<truncated>',
  ]);
  assert.equal(Object.keys(shape.object).length, 65);
  assert.equal(shape.object['<truncated>'], true);
  assert.equal(JSON.stringify(shape.deep).includes('<max-depth>'), true);
});

test('sanitizeContentType drops parameters and arbitrary malformed values', () => {
  assert.equal(
    sanitizeContentType('Application/JSON; charset=utf-8; secret=never-log-me'),
    'application/json',
  );
  assert.equal(sanitizeContentType('not a media type; secret=value'), 'present');
  assert.equal(sanitizeContentType(undefined), null);
});

test('sanitizeRequest drops arbitrary query values and handles invalid JSON', () => {
  const record = sanitizeRequest({
    method: 'POST',
    url: '/v1beta/models/test:generateContent?alt=custom&token=never-log-query',
    headers: { 'content-type': 'application/json; secret=never-log-header' },
    body: Buffer.from('{not valid json'),
  });

  assert.deepEqual(record.query, { alt: 'present' });
  assert.equal(record.contentType, 'application/json');
  assert.equal(record.bodyShape, 'invalid-json');
  assert.deepEqual(record.auth, {
    authorizationPresent: false,
    xGoogApiKey: 'absent',
    privilegedUserIdPresent: false,
  });

  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes('never-log-query'), false);
  assert.equal(serialized.includes('never-log-header'), false);
});

test('recorder binds to loopback and emits only sanitized request facts', async () => {
  const records = [];
  const recorder = createRecorderServer({
    onRecord: (record) => records.push(record),
  });
  const address = await recorder.listen();

  try {
    assert.equal(address.host, '127.0.0.1');

    const requestBody = JSON.stringify({
      contents: [{ parts: [{ text: 'private prompt' }] }],
    });

    const response = await fetch(
      `http://${address.host}:${address.port}/v1beta/models/test:generateContent?alt=sse&token=never-log-query`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8; secret=never-log-header',
          authorization: 'Bearer never-log-me',
          'x-goog-api-key': 'real-secret-value',
          'x-gemini-api-privileged-user-id': 'stable-install-id',
        },
        body: requestBody,
      },
    );

    assert.equal(response.status, 503);
    assert.equal(records.length, 1);

    assert.deepEqual(records[0], {
      method: 'POST',
      path: '/v1beta/models/test:generateContent',
      query: { alt: 'sse' },
      contentType: 'application/json',
      bodyBytes: Buffer.byteLength(requestBody),
      bodyShape: {
        contents: [{ parts: [{ text: 'string' }] }],
      },
      auth: {
        authorizationPresent: true,
        xGoogApiKey: 'nonempty-unexpected',
        privilegedUserIdPresent: true,
      },
    });

    const serialized = JSON.stringify(records[0]);
    assert.equal(serialized.includes('never-log-me'), false);
    assert.equal(serialized.includes('real-secret-value'), false);
    assert.equal(serialized.includes('stable-install-id'), false);
    assert.equal(serialized.includes('private prompt'), false);
    assert.equal(serialized.includes('never-log-query'), false);
    assert.equal(serialized.includes('never-log-header'), false);
  } finally {
    await recorder.close();
  }
});

test('recorder rejects non-loopback binding', () => {
  assert.throws(
    () => createRecorderServer({ host: '0.0.0.0' }),
    /may bind only to 127\.0\.0\.1/,
  );
});

test('recorder accepts exact body limit and rejects the next byte', async () => {
  const records = [];
  const recorder = createRecorderServer({
    bodyLimitBytes: 8,
    onRecord: (record) => records.push(record),
  });
  const address = await recorder.listen();

  try {
    const exactResponse = await fetch(
      `http://${address.host}:${address.port}/probe`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.alloc(8, 0x61),
      },
    );
    assert.equal(exactResponse.status, 503);
    assert.equal(records.length, 1);
    assert.equal(records[0].bodyBytes, 8);

    const oversizedResponse = await fetch(
      `http://${address.host}:${address.port}/probe`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.alloc(9, 0x62),
      },
    );
    assert.equal(oversizedResponse.status, 413);
    assert.equal(records.length, 1);
  } finally {
    await recorder.close();
  }
});

test('recorder CLI rejects non-decimal numeric arguments', () => {
  const cliPath = fileURLToPath(
    new URL('../bin/phase-b-recorder.mjs', import.meta.url),
  );
  for (const args of [
    ['--port', '123abc'],
    ['--port', ''],
    ['--port', '0x10'],
    ['--body-limit-bytes', '8junk'],
    ['--body-limit-bytes', '1e3'],
  ]) {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /must be a decimal integer/);
  }
});
