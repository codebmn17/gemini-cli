import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyApiKeyHeader,
  createRecorderServer,
  LOCAL_PLACEHOLDER_API_KEY,
  sanitizeJsonShape,
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
          'content-type': 'application/json',
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

test('recorder enforces request body limit without recording payload', async () => {
  const records = [];
  const recorder = createRecorderServer({
    bodyLimitBytes: 8,
    onRecord: (record) => records.push(record),
  });
  const address = await recorder.listen();

  try {
    const response = await fetch(`http://${address.host}:${address.port}/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ too: 'large' }),
    });

    assert.equal(response.status, 413);
    assert.equal(records.length, 0);
  } finally {
    await recorder.close();
  }
});
