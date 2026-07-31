/**
 * Unit tests for `http-request` request construction (design §5.1.1, §5.1.2).
 *
 * Table-driven examples for url joining, query encoding, auth precedence, body
 * validation, the idempotency-key cap and result selection. The property tests
 * for the same surface live in task 12.2.
 */

import { describe, expect, it } from 'vitest';
import type { ConnectionAuth, ResolvedConnection } from './connections.js';
import {
  applyConnectionAuth,
  buildDataRequest,
  encodeOnce,
  joinUrl,
  registerConnectionSecrets,
  selectResult,
} from './data-http.js';
import { createRedactor } from './redact.js';
import type { HttpRequestNodeData, WorkflowNode } from './types.js';

function httpNode(data: Partial<HttpRequestNodeData>): WorkflowNode {
  return {
    id: 'node-1',
    name: 'Call API',
    kind: 'http-request',
    category: 'flow',
    icon: 'ti ti-api',
    position: { x: 0, y: 0 },
    ports: [],
    data: { method: 'GET', url: 'https://api.example.com/things', ...data } as HttpRequestNodeData,
  };
}

function connection(
  auth: ConnectionAuth,
  secrets: Record<string, string>,
  config: Record<string, string> = {},
): ResolvedConnection {
  return { id: 'conn-acme', type: 'http', config, secrets, auth, allowWrites: false };
}

const header = (request: { headers: Record<string, string> }, name: string): string | undefined =>
  Object.entries(request.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

describe('joinUrl', () => {
  const cases: [string, string, string][] = [
    ['https://api.example.com', 'users', 'https://api.example.com/users'],
    ['https://api.example.com/', '/users', 'https://api.example.com/users'],
    ['https://api.example.com/v1///', '///users', 'https://api.example.com/v1/users'],
    ['https://api.example.com/v1?x=1', 'users', 'https://api.example.com/v1/users'],
  ];

  it.each(cases)('joins %s + %s with exactly one slash', (base, path, expected) => {
    expect(joinUrl(base, path)).toBe(expected);
  });
});

describe('buildDataRequest url handling', () => {
  it('joins a relative url onto the connection base url', () => {
    const conn = connection({ mode: 'none' }, {}, { baseUrl: 'https://api.example.com/v1/' });
    const request = buildDataRequest(httpNode({ url: '/users/{{id}}' }), '{"id":"42"}', conn);
    expect(request.url).toBe('https://api.example.com/v1/users/42');
  });

  it('rejects a relative url with no base url before any I/O', () => {
    expect(() => buildDataRequest(httpNode({ url: 'users' }), '')).toThrow(/relative/);
  });

  it.each([['', /empty/], ['ftp://files.example.com/x', /http or https/], ['//api.example.com/x', /http or https/]])(
    'rejects url %s',
    (url, message) => {
      expect(() => buildDataRequest(httpNode({ url: url as string }), '')).toThrow(message as RegExp);
    },
  );

  it('encodes each query value exactly once and keeps configured order', () => {
    const request = buildDataRequest(
      httpNode({
        url: 'https://api.example.com/search',
        query: [
          { key: 'q', value: 'a b&c' },
          { key: 'pre', value: 'already%20encoded' },
        ],
      }),
      '',
    );
    expect(request.url).toBe('https://api.example.com/search?q=a%20b%26c&pre=already%20encoded');
    const params = new URL(request.url).searchParams;
    expect(params.get('q')).toBe('a b&c');
    expect(params.get('pre')).toBe('already encoded');
  });

  it('appends to an existing query string with a single separator', () => {
    const request = buildDataRequest(
      httpNode({ url: 'https://api.example.com/x?fixed=1', query: [{ key: 'page', value: '2' }] }),
      '',
    );
    expect(request.url).toBe('https://api.example.com/x?fixed=1&page=2');
  });

  it('encodeOnce leaves an existing percent sequence untouched', () => {
    expect(encodeOnce('%41 b')).toBe('%41%20b');
  });
});

describe('buildDataRequest auth precedence', () => {
  it('overrides a user Authorization header with the connection bearer token', () => {
    const conn = connection({ mode: 'bearer', secretKey: 'token' }, { token: 'real-secret-value' });
    const request = buildDataRequest(
      httpNode({ headers: [{ key: 'authorization', value: 'Bearer user-supplied' }] }),
      '',
      conn,
    );
    expect(header(request, 'authorization')).toBe('Bearer real-secret-value');
    expect(JSON.stringify(request.headers)).not.toContain('user-supplied');
  });

  it('drops a user Authorization header when there is no connection', () => {
    const request = buildDataRequest(httpNode({ headers: [{ key: 'Authorization', value: 'Bearer nope' }] }), '');
    expect(header(request, 'authorization')).toBeUndefined();
  });

  it('applies basic auth as a single base64 credential', () => {
    const conn = connection(
      { mode: 'basic', userSecretKey: 'user', passwordSecretKey: 'pass' },
      { user: 'alice', pass: 'wonderland-secret' },
    );
    const request = applyConnectionAuth({ url: 'https://x.test/', method: 'GET', headers: {} }, conn);
    expect(header(request, 'authorization')).toBe(`Basic ${btoa('alice:wonderland-secret')}`);
  });

  it('applies header auth with its prefix and wins over a same-name user header', () => {
    const conn = connection({ mode: 'header', header: 'X-Api-Key', secretKey: 'key', prefix: 'k_' }, { key: 'abc12345' });
    const request = buildDataRequest(httpNode({ headers: [{ key: 'x-api-key', value: 'user' }] }), '', conn);
    expect(header(request, 'x-api-key')).toBe('k_abc12345');
    expect(Object.keys(request.headers).filter((k) => k.toLowerCase() === 'x-api-key')).toHaveLength(1);
  });

  it('applies query auth, replacing a user-supplied parameter of the same name', () => {
    const conn = connection({ mode: 'query', param: 'api_key', secretKey: 'key' }, { key: 'sekrit-value' });
    const request = buildDataRequest(
      httpNode({ url: 'https://api.example.com/x', query: [{ key: 'api_key', value: 'user-value' }] }),
      '',
      conn,
    );
    expect(new URL(request.url).searchParams.getAll('api_key')).toEqual(['sekrit-value']);
  });

  it('uses the host-injected access token for oauth2 modes', () => {
    const conn = connection(
      { mode: 'oauth2-refresh', tokenUrl: 'https://id.test/token', clientIdSecretKey: 'ci', clientSecretKey: 'cs', refreshTokenSecretKey: 'rt' },
      { accessToken: 'live-access-token', ci: 'id', cs: 'secretvalue', rt: 'refreshtoken' },
    );
    const request = buildDataRequest(httpNode({}), '', conn);
    expect(header(request, 'authorization')).toBe('Bearer live-access-token');
  });

  it('fails rather than sending an unsigned SigV4 request', () => {
    const conn = connection(
      { mode: 'aws-sigv4', service: 's3', region: 'eu-west-1', accessKeySecretKey: 'ak', secretKeySecretKey: 'sk' },
      { ak: 'AKIAEXAMPLE', sk: 'secretsecret' },
    );
    expect(() => buildDataRequest(httpNode({}), '', conn)).toThrow(/SigV4/);
  });

  it('fails when a declared secret is missing rather than sending an empty credential', () => {
    const conn = connection({ mode: 'bearer', secretKey: 'token' }, {});
    expect(() => buildDataRequest(httpNode({}), '', conn)).toThrow(/missing the secret value "token"/);
  });
});

describe('buildDataRequest body, idempotency and timeouts', () => {
  it('throws before any I/O when a json body template renders invalid JSON', () => {
    expect(() => buildDataRequest(httpNode({ method: 'POST', bodyMode: 'json', body: '{"a":' }), '')).toThrow(
      /valid JSON/,
    );
  });

  it('interpolates a json body and sets the json content type', () => {
    const request = buildDataRequest(
      httpNode({ method: 'POST', bodyMode: 'json', body: '{"name":"{{who}}"}' }),
      '{"who":"ada"}',
    );
    expect(request.body).toBe('{"name":"ada"}');
    expect(header(request, 'content-type')).toBe('application/json');
  });

  it('sends no body for bodyMode none', () => {
    expect(buildDataRequest(httpNode({ bodyMode: 'none', body: 'ignored' }), '').body).toBeUndefined();
  });

  it('trims the idempotency key and omits it past 255 characters', () => {
    const short = buildDataRequest(httpNode({ idempotencyKey: '  key-{{id}}  ' }), '{"id":"7"}');
    expect(header(short, 'idempotency-key')).toBe('key-7');

    const long = buildDataRequest(httpNode({ idempotencyKey: 'x'.repeat(256) }), '');
    expect(header(long, 'idempotency-key')).toBeUndefined();
  });

  it('resolves the per-attempt timeout, defaulting outside 1-300 seconds', () => {
    expect(buildDataRequest(httpNode({ timeoutSec: 5 }), '').timeoutMs).toBe(5000);
    expect(buildDataRequest(httpNode({ timeoutSec: 0 }), '').timeoutMs).toBe(30_000);
    expect(buildDataRequest(httpNode({ timeoutSec: 900 }), '').timeoutMs).toBe(30_000);
  });

  it('leaves an unresolvable token verbatim', () => {
    const request = buildDataRequest(httpNode({ url: 'https://api.example.com/{{missing}}' }), '{}');
    expect(request.url).toBe('https://api.example.com/{{missing}}');
  });
});

describe('selectResult', () => {
  it('returns the whole parsed response when no resultPath is set', () => {
    expect(selectResult({ method: 'GET', url: '' }, { a: 1 }, '')).toBe('{"a":1}');
  });

  it('selects a nested path and treats a resolved null as present', () => {
    const data: HttpRequestNodeData = { method: 'GET', url: '', resultPath: 'data.items.0' };
    expect(selectResult(data, { data: { items: [null] } }, '')).toBe('null');
  });

  it('fails naming the path when it resolves to no value', () => {
    const data: HttpRequestNodeData = { method: 'GET', url: '', resultPath: 'data.missing' };
    expect(() => selectResult(data, { data: {} }, '')).toThrow('Response has no value at "data.missing".');
  });

  it('shallow-merges under resultKey, preserving other payload fields', () => {
    const data: HttpRequestNodeData = { method: 'GET', url: '', resultKey: 'rows' };
    const merged = JSON.parse(selectResult(data, [1, 2], '{"runId":"r1","rows":"old"}')) as Record<string, unknown>;
    expect(merged).toEqual({ runId: 'r1', rows: [1, 2] });
  });
});

describe('registerConnectionSecrets', () => {
  it('registers every secret with the redactor before a request is built', () => {
    const redactor = createRedactor();
    const conn = connection({ mode: 'bearer', secretKey: 'token' }, { token: 'super-secret-token' });
    registerConnectionSecrets(redactor, conn);
    const request = buildDataRequest(httpNode({}), '', conn);
    expect(redactor.scrub(JSON.stringify(request.headers))).not.toContain('super-secret-token');
  });
});
