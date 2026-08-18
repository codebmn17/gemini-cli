/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Independent C1 hardening regressions added after review of PR #8.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { createAdapterServer } from '../lib/llama-cpp-adapter.mjs';
import {
  createSseFrameSplitter,
  parseChatCompletionChunk,
} from '../lib/llama-protocol.mjs';

const BACKEND_MODEL = 'local-test-model';

function startFakeBackend(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        server,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function startAdapter(options) {
  return new Promise((resolve, reject) => {
    const server = createAdapterServer(options);
    server.once('error', reject);
    server.listen(0, () => {
      server.off('error', reject);
      const { port, address } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        address,
        server,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function geminiRequest(origin, verb, body, suffix = '') {
  return fetch(`${origin}/v1beta/models/local-client:${verb}${suffix}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const SIMPLE_REQUEST = {
  contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
};

test('createAdapterServer enforces loopback when caller omits host', async () => {
  const backend = await startFakeBackend((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const adapter = await startAdapter({
    backendOrigin: backend.origin,
    backendModel: BACKEND_MODEL,
  });
  try {
    assert.equal(adapter.address, '127.0.0.1');
  } finally {
    await adapter.close();
    await backend.close();
  }
});

test('createAdapterServer rejects an explicit 0.0.0.0 listener', async () => {
  const backend = await startFakeBackend((_req, res) => res.end());
  try {
    const server = createAdapterServer({
      backendOrigin: backend.origin,
      backendModel: BACKEND_MODEL,
    });
    assert.throws(() => server.listen(0, '0.0.0.0'), /only on 127\.0\.0\.1/);
  } finally {
    await backend.close();
  }
});

test('llama.cpp usage-only streaming chunk is valid', () => {
  const parsed = parseChatCompletionChunk(
    JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 7,
        completion_tokens: 3,
        total_tokens: 10,
      },
    }),
  );
  assert.equal(parsed.done, false);
  assert.equal(parsed.usageOnly, true);
  assert.deepEqual(parsed.usage, {
    promptTokens: 7,
    completionTokens: 3,
    totalTokens: 10,
  });
});

test('usage-only chunk after finish does not truncate a valid stream', async () => {
  const backend = await startFakeBackend((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n');
    res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
    res.write('data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const adapter = await startAdapter({
    backendOrigin: backend.origin,
    backendModel: BACKEND_MODEL,
  });
  try {
    const res = await geminiRequest(
      adapter.origin,
      'streamGenerateContent',
      SIMPLE_REQUEST,
      '?alt=sse',
    );
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.match(raw, /"text":"ok"/);
    assert.match(raw, /"finishReason":"STOP"/);
  } finally {
    await adapter.close();
    await backend.close();
  }
});

test('stream backend timeout remains active after response headers arrive', async () => {
  const backend = await startFakeBackend((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
  });
  const adapter = await startAdapter({
    backendOrigin: backend.origin,
    backendModel: BACKEND_MODEL,
    backendTimeoutMs: 150,
  });
  try {
    const started = Date.now();
    const res = await geminiRequest(
      adapter.origin,
      'streamGenerateContent',
      SIMPLE_REQUEST,
      '?alt=sse',
    );
    assert.equal(res.status, 200);
    await res.text();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1500, `stalled stream took too long to terminate: ${elapsed}ms`);
  } finally {
    await adapter.close();
    await backend.close();
  }
});

test('non-stream backend response is bounded before JSON parsing', async () => {
  const backend = await startFakeBackend((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      padding: 'x'.repeat(10_000),
      choices: [{
        message: { role: 'assistant', content: 'should not be reached' },
        finish_reason: 'stop',
      }],
    }));
  });
  const adapter = await startAdapter({
    backendOrigin: backend.origin,
    backendModel: BACKEND_MODEL,
    maxBackendBodyBytes: 1024,
  });
  try {
    const res = await geminiRequest(adapter.origin, 'generateContent', SIMPLE_REQUEST);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.status, 'BACKEND_INVALID_RESPONSE');
  } finally {
    await adapter.close();
    await backend.close();
  }
});

test('unknown Part fields are rejected even when text is present', async () => {
  const backend = await startFakeBackend((_req, res) => res.end());
  const adapter = await startAdapter({
    backendOrigin: backend.origin,
    backendModel: BACKEND_MODEL,
  });
  try {
    const res = await geminiRequest(adapter.origin, 'generateContent', {
      contents: [{
        role: 'user',
        parts: [{ text: 'hello', futureSemanticField: { important: true } }],
      }],
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.status, 'UNSUPPORTED_REQUEST');
  } finally {
    await adapter.close();
    await backend.close();
  }
});

test('unknown generationConfig fields are rejected instead of ignored', async () => {
  const backend = await startFakeBackend((_req, res) => res.end());
  const adapter = await startAdapter({
    backendOrigin: backend.origin,
    backendModel: BACKEND_MODEL,
  });
  try {
    const res = await geminiRequest(adapter.origin, 'generateContent', {
      ...SIMPLE_REQUEST,
      generationConfig: { temperature: 0.5, imaginaryControl: true },
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.status, 'UNSUPPORTED_REQUEST');
  } finally {
    await adapter.close();
    await backend.close();
  }
});

test('streamGenerateContent requires exactly ?alt=sse', async () => {
  const backend = await startFakeBackend((_req, res) => res.end());
  const adapter = await startAdapter({
    backendOrigin: backend.origin,
    backendModel: BACKEND_MODEL,
  });
  try {
    const missing = await geminiRequest(
      adapter.origin,
      'streamGenerateContent',
      SIMPLE_REQUEST,
    );
    assert.equal(missing.status, 404);

    const extra = await geminiRequest(
      adapter.origin,
      'streamGenerateContent',
      SIMPLE_REQUEST,
      '?alt=sse&extra=1',
    );
    assert.equal(extra.status, 404);
  } finally {
    await adapter.close();
    await backend.close();
  }
});

test('SSE splitter chooses earliest delimiter when LF and CRLF frames are mixed', () => {
  const splitter = createSseFrameSplitter();
  const frames = splitter.push(
    'data: {"a":1}\r\n\r\ndata: {"b":2}\n\ndata: {"c":3}\r\n\r\n',
  );
  assert.deepEqual(frames, ['{"a":1}', '{"b":2}', '{"c":3}']);
  splitter.finish();
});
