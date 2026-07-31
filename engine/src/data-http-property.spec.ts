import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ConnectionAuth, ResolvedConnection } from './connections.js';
import type { DataRequest, DataResponse } from './data-host.js';
import {
  applyConnectionAuth,
  buildDataRequest,
  encodeOnce,
  joinUrl,
  registerConnectionSecrets,
} from './data-http.js';
import { createRedactor, MIN_SECRET_LEN } from './redact.js';
import type { HttpRequestNodeData, WorkflowNode } from './types.js';

/**
 * Property 8: Host-applied auth always wins and secrets never enter the spec
 * (design §5.1.1).
 *
 * 40. **Auth precedence.** ∀ node with user headers `H` and connection auth `A`:
 *     the built request's auth header equals `A`'s, regardless of `H`.
 * 41. **No secret in the spec path.** ∀ node data `d`: no secret value is
 *     reachable from `d`; the request only gains secrets via
 *     `applyConnectionAuth`.
 * 42. **URL joining.** ∀ base `b`, ∀ relative path `p`: the result has exactly
 *     one `/` between them and parses as an absolute http(s) URL.
 * 43. **Encoding stability.** ∀ query value `v`: `v` is percent-encoded exactly
 *     once (decoding the built URL's parameter returns `v`).
 * 44. **Body validity.** ∀ `bodyMode: 'json'` template that renders to invalid
 *     JSON: construction throws before any `dataFetch` call.
 *
 * **Validates: Requirements 8.3, 8.4, 8.5, 8.6, 8.7**
 *
 * Scoping notes, following the requirement text rather than narrowing the claims:
 *
 * - Secret values are drawn from an `sk_<hex>` domain and node-data values from a
 *   disjoint fixed pool, so "no secret is reachable from node data" is a real
 *   check rather than a coincidence of two random alphabets.
 * - Claim 40 covers the modes that produce a request. `aws-sigv4` is generated
 *   too: its contract is to THROW rather than emit an unsigned request, so the
 *   property asserts the throw instead of a header.
 * - Claim 43 decodes with `decodeURIComponent`, the exact inverse of
 *   percent-encoding. `URLSearchParams` additionally applies form decoding (`+`
 *   becomes a space), so it is cross-checked only for encodings free of `+`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

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

const headerOf = (request: DataRequest, name: string): string | undefined =>
  Object.entries(request.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

const HEX = '0123456789abcdef'.split('');

/** A resolved secret value: >= MIN_SECRET_LEN, and unreachable from node data. */
const secretArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...HEX), { minLength: 12, maxLength: 24 })
  .map((chars) => `sk_${chars.join('')}`);

/** Where a connection's credential is expected to land. */
type Applied =
  | { readonly kind: 'header'; readonly name: string; readonly value: string }
  | { readonly kind: 'query'; readonly param: string; readonly value: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'throws'; readonly message: RegExp };

interface AuthFixture {
  readonly auth: ConnectionAuth;
  readonly secrets: Record<string, string>;
  readonly applied: Applied;
}

const AUTH_HEADER_NAMES = ['X-Api-Key', 'x-token', 'Authorization', 'X-Custom-Auth'] as const;
const AUTH_PARAM_NAMES = ['api_key', 'token', 'key'] as const;

const base64 = (value: string): string => btoa(value);

const authFixtureArb: fc.Arbitrary<AuthFixture> = fc.oneof(
  fc.constant<AuthFixture>({ auth: { mode: 'none' }, secrets: {}, applied: { kind: 'none' } }),
  secretArb.map<AuthFixture>((token) => ({
    auth: { mode: 'bearer', secretKey: 'token' },
    secrets: { token },
    applied: { kind: 'header', name: 'Authorization', value: `Bearer ${token}` },
  })),
  fc.tuple(secretArb, secretArb).map<AuthFixture>(([user, pass]) => ({
    auth: { mode: 'basic', userSecretKey: 'user', passwordSecretKey: 'pass' },
    secrets: { user, pass },
    applied: { kind: 'header', name: 'Authorization', value: `Basic ${base64(`${user}:${pass}`)}` },
  })),
  fc
    .tuple(secretArb, fc.constantFrom(...AUTH_HEADER_NAMES), fc.option(fc.constantFrom('k_', 'Token '), { nil: undefined }))
    .map<AuthFixture>(([key, header, prefix]) => ({
      auth: { mode: 'header', header, secretKey: 'key', ...(prefix === undefined ? {} : { prefix }) },
      secrets: { key },
      applied: { kind: 'header', name: header, value: `${prefix ?? ''}${key}` },
    })),
  fc.tuple(secretArb, fc.constantFrom(...AUTH_PARAM_NAMES)).map<AuthFixture>(([key, param]) => ({
    auth: { mode: 'query', param, secretKey: 'key' },
    secrets: { key },
    applied: { kind: 'query', param, value: key },
  })),
  fc.tuple(secretArb, secretArb, secretArb).map<AuthFixture>(([accessToken, clientId, clientSecret]) => ({
    auth: {
      mode: 'oauth2-client-credentials',
      tokenUrl: 'https://id.example.com/token',
      clientIdSecretKey: 'clientId',
      clientSecretKey: 'clientSecret',
    },
    secrets: { accessToken, clientId, clientSecret },
    applied: { kind: 'header', name: 'Authorization', value: `Bearer ${accessToken}` },
  })),
  fc
    .tuple(secretArb, secretArb, secretArb, secretArb)
    .map<AuthFixture>(([accessToken, clientId, clientSecret, refreshToken]) => ({
      auth: {
        mode: 'oauth2-refresh',
        tokenUrl: 'https://id.example.com/token',
        clientIdSecretKey: 'clientId',
        clientSecretKey: 'clientSecret',
        refreshTokenSecretKey: 'refreshToken',
      },
      secrets: { accessToken, clientId, clientSecret, refreshToken },
      applied: { kind: 'header', name: 'Authorization', value: `Bearer ${accessToken}` },
    })),
  fc.tuple(secretArb, secretArb).map<AuthFixture>(([accessKey, secretKey]) => ({
    auth: {
      mode: 'aws-sigv4',
      service: 's3',
      region: 'eu-west-1',
      accessKeySecretKey: 'accessKey',
      secretKeySecretKey: 'secretKey',
    },
    secrets: { accessKey, secretKey },
    applied: { kind: 'throws', message: /SigV4/ },
  })),
);

function resolved(fixture: AuthFixture, config: Record<string, string> = {}): ResolvedConnection {
  return { id: 'conn-acme', type: 'http', config, secrets: fixture.secrets, auth: fixture.auth, allowWrites: false };
}

/** Node-data values: a fixed pool, disjoint from the `sk_<hex>` secret domain. */
const USER_VALUES = [
  '',
  'user-value',
  'Bearer user-token',
  'not a secret',
  '{{name}}',
  '{{input}}',
  '{{missing}}',
] as const;

/**
 * Markers used ONLY for a forged auth entry, so "the forged value is gone" can be
 * asserted over the whole request: no ordinary generated value can produce them.
 */
const FORGED_HEADER = 'FORGED-HEADER-CREDENTIAL';
const FORGED_QUERY = 'FORGED-QUERY-CREDENTIAL';

const USER_HEADER_NAMES = [
  'Accept',
  'Content-Type',
  'Authorization',
  'authorization',
  'AUTHORIZATION',
  'X-Api-Key',
  'x-api-key',
  'x-token',
  'X-Custom-Auth',
] as const;

const USER_QUERY_KEYS = ['q', 'api_key', 'token', 'key', 'page'] as const;

const ABSOLUTE_URLS = [
  'https://api.example.com/things',
  'https://api.example.com/things?fixed=1',
  'https://api.example.com/things?api_key=user-supplied',
  'http://api.example.com/v1/things',
] as const;

const nodeDataArb: fc.Arbitrary<Partial<HttpRequestNodeData>> = fc.record(
  {
    method: fc.constantFrom<HttpRequestNodeData['method']>('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'),
    url: fc.constantFrom(...ABSOLUTE_URLS),
    headers: fc.array(fc.record({ key: fc.constantFrom(...USER_HEADER_NAMES), value: fc.constantFrom(...USER_VALUES) }), {
      maxLength: 4,
    }),
    query: fc.array(fc.record({ key: fc.constantFrom(...USER_QUERY_KEYS), value: fc.constantFrom(...USER_VALUES) }), {
      maxLength: 3,
    }),
    idempotencyKey: fc.constantFrom('', ' idem-{{id}} '),
  },
  { requiredKeys: ['method', 'url'] },
);

const payloadArb: fc.Arbitrary<string> = fc.constantFrom(
  '',
  '{}',
  '{"id":"42","name":"ada"}',
  '{"id":7,"name":"grace"}',
  'not json at all',
);

/** One generated case: an auth fixture plus node data that tries to forge it. */
const caseArb = authFixtureArb.chain((fixture) =>
  fc.record({
    fixture: fc.constant(fixture),
    data: nodeDataArb,
    payload: payloadArb,
    forge: fc.boolean(),
    forgeCase: fc.constantFrom<'exact' | 'lower' | 'upper'>('exact', 'lower', 'upper'),
  }),
);

/** Adds a user header / query entry aimed squarely at the connection's channel. */
function forgeNode(
  data: Partial<HttpRequestNodeData>,
  applied: Applied,
  forge: boolean,
  forgeCase: 'exact' | 'lower' | 'upper',
): WorkflowNode {
  if (!forge || applied.kind === 'none' || applied.kind === 'throws') return httpNode(data);
  const cased = (name: string): string =>
    forgeCase === 'lower' ? name.toLowerCase() : forgeCase === 'upper' ? name.toUpperCase() : name;

  if (applied.kind === 'header') {
    return httpNode({
      ...data,
      headers: [...(data.headers ?? []), { key: cased(applied.name), value: `Bearer ${FORGED_HEADER}` }],
    });
  }
  return httpNode({ ...data, query: [...(data.query ?? []), { key: applied.param, value: FORGED_QUERY }] });
}

// ─────────────────────────────────────────────────────────────────────────────
// Claim 40: auth precedence
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 8 — claim 40: host-applied auth always wins', () => {
  it('carries the connection credential on the auth channel whatever the user headers say', () => {
    fc.assert(
      fc.property(caseArb, ({ fixture, data, payload, forge, forgeCase }) => {
        const node = forgeNode(data, fixture.applied, forge, forgeCase);
        const conn = resolved(fixture);
        const applied = fixture.applied;

        if (applied.kind === 'throws') {
          expect(() => buildDataRequest(node, payload, conn)).toThrow(applied.message);
          return;
        }

        const request = buildDataRequest(node, payload, conn);
        const serialised = JSON.stringify(request);

        if (applied.kind === 'header') {
          const matching = Object.keys(request.headers).filter(
            (key) => key.toLowerCase() === applied.name.toLowerCase(),
          );
          // Exactly one entry, under the connection's own casing, with its value.
          expect(matching).toEqual([applied.name]);
          expect(request.headers[applied.name]).toBe(applied.value);
          if (applied.name.toLowerCase() !== 'authorization') {
            expect(headerOf(request, 'authorization')).toBeUndefined();
          }
        } else if (applied.kind === 'query') {
          expect(new URL(request.url).searchParams.getAll(applied.param)).toEqual([applied.value]);
          expect(headerOf(request, 'authorization')).toBeUndefined();
        } else {
          // `none`: a user Authorization header is dropped unconditionally.
          expect(headerOf(request, 'authorization')).toBeUndefined();
        }

        // No forged credential survives anywhere in the request.
        expect(serialised).not.toContain(FORGED_HEADER);
        expect(serialised).not.toContain(FORGED_QUERY);
      }),
      { numRuns: 400 },
    );
  });

  it('drops a user Authorization header even when there is no connection at all', () => {
    fc.assert(
      fc.property(nodeDataArb, payloadArb, (data, payload) => {
        const node = httpNode({
          ...data,
          headers: [...(data.headers ?? []), { key: 'Authorization', value: `Bearer ${FORGED_HEADER}` }],
        });
        const request = buildDataRequest(node, payload);
        expect(headerOf(request, 'authorization')).toBeUndefined();
        expect(JSON.stringify(request)).not.toContain(FORGED_HEADER);
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 41: no secret in the spec path
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 8 — claim 41: secrets enter only through applyConnectionAuth', () => {
  it('keeps every secret out of node data and out of the pre-auth request', () => {
    fc.assert(
      fc.property(caseArb, ({ fixture, data, payload, forge, forgeCase }) => {
        const node = forgeNode(data, fixture.applied, forge, forgeCase);
        const conn = resolved(fixture);
        const secrets = Object.values(fixture.secrets);
        const nodeData = JSON.stringify(node.data);

        for (const secret of secrets) {
          expect(secret.length).toBeGreaterThanOrEqual(MIN_SECRET_LEN);
          expect(nodeData).not.toContain(secret);
        }

        // Built with no connection: nothing in the spec path can produce a secret.
        const bare = buildDataRequest(node, payload);
        for (const secret of secrets) expect(JSON.stringify(bare)).not.toContain(secret);

        if (fixture.applied.kind === 'throws') {
          expect(() => applyConnectionAuth(bare, conn)).toThrow(fixture.applied.message);
          return;
        }

        // The full build differs from the bare build only by applyConnectionAuth.
        const request = buildDataRequest(node, payload, conn);
        expect(applyConnectionAuth(bare, conn)).toEqual(request);

        // Secrets appear only on the auth channel, nowhere else.
        const withoutAuth = stripAuthChannel(request, fixture.applied);
        for (const secret of secrets) expect(JSON.stringify(withoutAuth)).not.toContain(secret);

        // And a redactor seeded from the connection removes them from a trace.
        const redactor = createRedactor();
        registerConnectionSecrets(redactor, conn);
        const scrubbed = redactor.scrub(JSON.stringify(request));
        for (const secret of secrets) expect(scrubbed).not.toContain(secret);
      }),
      { numRuns: 400 },
    );
  });
});

/** Removes the header or query parameter the connection owns. */
function stripAuthChannel(request: DataRequest, applied: Applied): DataRequest {
  if (applied.kind === 'header') {
    const headers = Object.fromEntries(
      Object.entries(request.headers).filter(([key]) => key.toLowerCase() !== applied.name.toLowerCase()),
    );
    return { ...request, headers };
  }
  if (applied.kind === 'query') {
    const url = new URL(request.url);
    url.searchParams.delete(applied.param);
    return { ...request, url: url.toString() };
  }
  return request;
}

// ─────────────────────────────────────────────────────────────────────────────
// Claim 42: URL joining
// ─────────────────────────────────────────────────────────────────────────────

const SEGMENTS = ['v1', 'v2', 'users', 'a-b', 'x_y', '7'] as const;

const baseUrlArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('http', 'https'),
    fc.constantFrom('api.example.com', 'svc.internal.example.com:8443'),
    fc.array(fc.constantFrom(...SEGMENTS), { maxLength: 3 }),
    fc.nat({ max: 3 }),
    fc.constantFrom('', '?x=1', '#frag'),
  )
  .map(([scheme, host, segments, slashes, suffix]) => {
    const path = segments.length > 0 ? `/${segments.join('/')}` : '';
    return `${scheme}://${host}${path}${'/'.repeat(slashes)}${suffix}`;
  });

const relativePathArb: fc.Arbitrary<string> = fc
  .tuple(fc.nat({ max: 3 }), fc.array(fc.constantFrom(...SEGMENTS), { maxLength: 3 }))
  .map(([slashes, segments]) => `${'/'.repeat(slashes)}${segments.join('/')}`);

/**
 * A node `url`: non-empty, with at most one leading `/`. A `//`-prefixed value is
 * excluded on purpose — it is protocol-relative, and the implementation rejects it
 * as such rather than joining it (see the unit suite). Multi-slash collapsing is
 * covered by the `joinUrl` property above.
 */
const relativeNodeUrlArb: fc.Arbitrary<string> = fc
  .tuple(fc.boolean(), fc.array(fc.constantFrom(...SEGMENTS), { minLength: 1, maxLength: 3 }))
  .map(([leadingSlash, segments]) => `${leadingSlash ? '/' : ''}${segments.join('/')}`);

describe('Property 8 — claim 42: base and path join with exactly one slash', () => {
  it('produces an absolute http(s) url with a single separator', () => {
    fc.assert(
      fc.property(baseUrlArb, relativePathArb, (base, path) => {
        const coreBase = (base.split('#')[0]?.split('?')[0] ?? base).replace(/\/+$/, '');
        const corePath = path.replace(/^\/+/, '');
        const joined = joinUrl(base, path);

        const parsed = new URL(joined);
        expect(['http:', 'https:']).toContain(parsed.protocol);
        expect(joined).toBe(corePath.length > 0 ? `${coreBase}/${corePath}` : `${coreBase}/`);
        // Exactly one slash at the junction, and none doubled anywhere after the scheme.
        expect(joined.slice(parsed.protocol.length + 2)).not.toContain('//');
        // A query or fragment on the base does not survive a relative path.
        expect(parsed.search).toBe('');
        expect(parsed.hash).toBe('');
      }),
    );
  });

  it('joins a relative node url onto the connection base url', () => {
    fc.assert(
      fc.property(baseUrlArb, relativeNodeUrlArb, (base, relative) => {
        const conn = resolved(
          { auth: { mode: 'none' }, secrets: {}, applied: { kind: 'none' } },
          { baseUrl: base },
        );
        const request = buildDataRequest(httpNode({ url: relative }), '', conn);
        expect(request.url).toBe(joinUrl(base, relative));
        const parsed = new URL(request.url);
        expect(['http:', 'https:']).toContain(parsed.protocol);
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 43: encoding stability
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query values that carry no pre-existing `%XX` escape. `encodeOnce` deliberately
 * preserves an already-encoded sequence (Requirement 8.4), so for those inputs
 * decoding returns the DECODED form rather than the literal text — that
 * behaviour is covered by the unit suite, not by this round-trip claim.
 */
const queryValueArb: fc.Arbitrary<string> = fc
  .oneof(
    { weight: 3, arbitrary: fc.string({ maxLength: 24 }) },
    { weight: 2, arbitrary: fc.string({ unit: 'grapheme', maxLength: 12 }) },
    {
      weight: 2,
      arbitrary: fc.constantFrom('', 'a b&c', '=', '%', '100% sure', 'a+b', 'x/y?z', '#hash', 'ümlaut', 'a,b;c'),
    },
  )
  .filter((value) => !/%[0-9A-Fa-f]{2}/.test(value));

const queryEntriesArb = fc.array(
  fc.record({ key: fc.constantFrom('q', 'filter', 'ids', 'page'), value: queryValueArb }),
  { minLength: 1, maxLength: 4 },
);

describe('Property 8 — claim 43: each query value is percent-encoded exactly once', () => {
  it('round-trips every value and keeps the configured order', () => {
    fc.assert(
      fc.property(queryEntriesArb, (entries) => {
        const node = httpNode({ url: 'https://api.example.com/search', query: [...entries] });
        const request = buildDataRequest(node, '');

        // Byte-identical for identical node data (Requirement 8.4).
        expect(buildDataRequest(node, '').url).toBe(request.url);

        const query = request.url.slice(request.url.indexOf('?') + 1);
        const pairs = query.split('&');
        expect(pairs).toHaveLength(entries.length);

        entries.forEach((entry, index) => {
          const pair = pairs[index] as string;
          const separator = pair.indexOf('=');
          const rawKey = pair.slice(0, separator);
          const rawValue = pair.slice(separator + 1);

          expect(rawKey).toBe(entry.key);
          expect(decodeURIComponent(rawValue)).toBe(entry.value);
          // Encoding once more changes nothing: the value was encoded exactly once.
          expect(encodeOnce(encodeOnce(entry.value))).toBe(encodeOnce(entry.value));
          // Delimiters never leak into a value.
          expect(rawValue).not.toContain('&');
          expect(rawValue).not.toContain('=');
          expect(rawValue).not.toContain('#');
          if (!rawValue.includes('+')) {
            expect(new URL(request.url).searchParams.getAll(entry.key)).toContain(entry.value);
          }
        });
      }),
      { numRuns: 400 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 44: body validity before any I/O
// ─────────────────────────────────────────────────────────────────────────────

interface FetchSpy {
  calls: number;
  fetch: (request: DataRequest) => Promise<DataResponse>;
}

function fetchSpy(): FetchSpy {
  const spy: FetchSpy = {
    calls: 0,
    fetch: async (request) => {
      spy.calls += 1;
      return { status: 200, headers: {}, body: request.body ?? '', byteCount: 0, durationMs: 0 };
    },
  };
  return spy;
}

/** Construct-then-dispatch, the order the executor uses. */
function attempt(node: WorkflowNode, payload: string, spy: FetchSpy): DataRequest {
  const request = buildDataRequest(node, payload);
  void spy.fetch(request);
  return request;
}

const parses = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

const invalidJsonArb: fc.Arbitrary<string> = fc
  .oneof(
    { weight: 3, arbitrary: fc.constantFrom('', '{"a":', '[1,', '{', '}', 'undefined', "{'a':1}", '{"a":1,}', 'NaN') },
    { weight: 2, arbitrary: fc.string({ maxLength: 16 }) },
  )
  .filter((text) => !parses(text));

const WORDS = ['abc', 'ada', 'grace', 'hello world'] as const;

describe('Property 8 — claim 44: an invalid json body fails before any fetch', () => {
  it('throws for every template that does not render to JSON', () => {
    fc.assert(
      fc.property(invalidJsonArb, payloadArb, (body, payload) => {
        const spy = fetchSpy();
        const node = httpNode({ method: 'POST', bodyMode: 'json', body });
        expect(() => attempt(node, payload, spy)).toThrow(/valid JSON/);
        expect(spy.calls).toBe(0);
      }),
    );
  });

  it('throws when interpolation is what breaks the JSON', () => {
    fc.assert(
      fc.property(fc.constantFrom(...WORDS), (word) => {
        const spy = fetchSpy();
        const node = httpNode({ method: 'POST', bodyMode: 'json', body: '{"v":{{name}}}' });
        expect(() => attempt(node, JSON.stringify({ name: word }), spy)).toThrow(/valid JSON/);
        expect(spy.calls).toBe(0);
      }),
    );
  });

  it('dispatches a rendered body that does parse', () => {
    fc.assert(
      fc.property(fc.constantFrom(...WORDS), fc.integer({ min: -1000, max: 1000 }), (word, amount) => {
        const spy = fetchSpy();
        const payload = JSON.stringify({ name: word, amount });
        const node = httpNode({ method: 'POST', bodyMode: 'json', body: '{"v":{{input}}}' });
        const request = attempt(node, payload, spy);
        expect(spy.calls).toBe(1);
        expect(request.body).toBe(`{"v":${payload}}`);
        expect(headerOf(request, 'content-type')).toBe('application/json');
        expect(parses(request.body as string)).toBe(true);
      }),
    );
  });
});
