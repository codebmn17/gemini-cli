import http from 'node:http';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
export const LOCAL_PLACEHOLDER_API_KEY = 'gemini-local-phase-b-placeholder';

const MAX_SHAPE_DEPTH = 8;
const MAX_OBJECT_KEYS = 64;
const MAX_ARRAY_ITEMS = 4;

export function classifyApiKeyHeader(value) {
  if (value === undefined) return 'absent';
  if (value === '') return 'empty';
  if (value === LOCAL_PLACEHOLDER_API_KEY) return 'placeholder-match';
  return 'nonempty-unexpected';
}

export function sanitizeJsonShape(value, depth = 0) {
  if (depth >= MAX_SHAPE_DEPTH) return '<max-depth>';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeJsonShape(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push('<truncated>');
    return items;
  }

  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object': {
      const entries = Object.entries(value);
      const out = {};
      for (const [key, item] of entries.slice(0, MAX_OBJECT_KEYS)) {
        out[key] = sanitizeJsonShape(item, depth + 1);
      }
      if (entries.length > MAX_OBJECT_KEYS) out['<truncated>'] = true;
      return out;
    }
    default:
      return typeof value;
  }
}

export function sanitizeContentType(value) {
  if (typeof value !== 'string') return null;
  const mediaType = value.split(';', 1)[0].trim().toLowerCase();
  if (mediaType === '') return 'present';
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) {
    return 'present';
  }
  return mediaType;
}

export function sanitizeRequest({ method, url, headers, body }) {
  const contentType = headers['content-type'];
  const apiKeyHeader = headers['x-goog-api-key'];
  const authorization = headers.authorization;
  const privilegedUserId = headers['x-gemini-api-privileged-user-id'];

  let bodyShape = 'unparsed';
  if (body.length === 0) {
    bodyShape = 'empty';
  } else if (
    typeof contentType === 'string' &&
    contentType.toLowerCase().includes('application/json')
  ) {
    try {
      bodyShape = sanitizeJsonShape(JSON.parse(body.toString('utf8')));
    } catch {
      bodyShape = 'invalid-json';
    }
  }

  const parsedUrl = new URL(url, 'http://127.0.0.1');
  const alt = parsedUrl.searchParams.get('alt');

  return {
    method,
    path: parsedUrl.pathname,
    query: alt === null ? {} : { alt: alt === 'sse' ? 'sse' : 'present' },
    contentType: sanitizeContentType(contentType),
    bodyBytes: body.length,
    bodyShape,
    auth: {
      authorizationPresent: authorization !== undefined,
      xGoogApiKey: classifyApiKeyHeader(apiKeyHeader),
      privilegedUserIdPresent: privilegedUserId !== undefined,
    },
  };
}

async function readBody(req, limitBytes) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) {
      const error = new Error(`request body exceeds ${limitBytes} bytes`);
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks, total);
}

export function createRecorderServer({
  host = DEFAULT_HOST,
  port = 0,
  bodyLimitBytes = DEFAULT_BODY_LIMIT_BYTES,
  onRecord = () => {},
} = {}) {
  if (host !== DEFAULT_HOST) {
    throw new Error(`Phase B recorder may bind only to ${DEFAULT_HOST}`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('port must be an integer between 0 and 65535');
  }
  if (!Number.isInteger(bodyLimitBytes) || bodyLimitBytes <= 0) {
    throw new Error('bodyLimitBytes must be a positive integer');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const body = await readBody(req, bodyLimitBytes);
      const record = sanitizeRequest({
        method: req.method ?? 'UNKNOWN',
        url: req.url ?? '/',
        headers: req.headers,
        body,
      });
      onRecord(record);

      res.writeHead(503, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'close',
      });
      res.end(
        JSON.stringify({
          error: {
            code: 503,
            message: 'Phase B recorder: deliberate local stop',
            status: 'UNAVAILABLE',
          },
        }),
      );
    } catch (error) {
      const bodyTooLarge = error?.code === 'BODY_TOO_LARGE';
      res.writeHead(bodyTooLarge ? 413 : 500, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'close',
      });
      res.end(
        JSON.stringify({
          error: {
            code: bodyTooLarge ? 413 : 500,
            message: bodyTooLarge
              ? 'Phase B recorder: request body too large'
              : 'Phase B recorder: internal error',
            status: bodyTooLarge ? 'RESOURCE_EXHAUSTED' : 'INTERNAL',
          },
        }),
      );
    }
  });

  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('unexpected recorder address');
      }
      return { host: address.address, port: address.port };
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
