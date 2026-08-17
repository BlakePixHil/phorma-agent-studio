import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CONNECTION_ID_PATTERN,
  CONNECTION_SECRET_PREFIX,
  assertConnectionId,
  authSecretKeyNames,
  awsSecretName,
  connectionSecretName,
  isConnectionId,
  workerSecretName,
} from './connections.js';

/**
 * Connection identity and secret naming (Requirements 2.11, 3.1, 3.5).
 *
 * These three helpers are the only place a connection id turns into something a
 * host will look up, so they are the last line of defence before a secret read:
 * a malformed id must be rejected BEFORE any store is touched, and every name a
 * host derives must land in the namespace that host accepts.
 */

/** The shape `CloudService.putWorkerSecret` (and `wrangler secret`) requires. */
const WORKER_SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

describe('connectionSecretName', () => {
  it('prefixes the desktop keychain namespace and joins id and key with colons', () => {
    expect(connectionSecretName('conn-stripe', 'apiKey')).toBe('conn:conn-stripe:apiKey');
  });

  it('always begins with CONNECTION_SECRET_PREFIX', () => {
    expect(CONNECTION_SECRET_PREFIX).toBe('conn:');
    for (const key of ['apiKey', 'client_secret', 'password']) {
      expect(connectionSecretName('conn-a', key).startsWith(CONNECTION_SECRET_PREFIX)).toBe(true);
    }
  });

  it('keeps id and key verbatim so a read reassembles the same entry name', () => {
    expect(connectionSecretName('conn-Warehouse_01', 'refresh-token')).toBe(
      'conn:conn-Warehouse_01:refresh-token',
    );
  });

  it('distinguishes two keys of the same connection and two connections sharing a key', () => {
    expect(connectionSecretName('conn-a', 'user')).not.toBe(connectionSecretName('conn-a', 'pass'));
    expect(connectionSecretName('conn-a', 'user')).not.toBe(connectionSecretName('conn-b', 'user'));
  });
});

describe('workerSecretName', () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['conn-stripe', 'apiKey', 'CONN_CONN_STRIPE_APIKEY'],
    ['conn-a1', 'client_secret', 'CONN_CONN_A1_CLIENT_SECRET'],
    ['conn-my-db', 'refresh-token', 'CONN_CONN_MY_DB_REFRESH_TOKEN'],
    ['conn-Mixed_Case', 'Token.Value', 'CONN_CONN_MIXED_CASE_TOKEN_VALUE'],
  ];

  for (const [connectionId, secretKey, expected] of cases) {
    it(`normalises ${connectionId} / ${secretKey} to ${expected}`, () => {
      expect(workerSecretName(connectionId, secretKey)).toBe(expected);
    });
  }

  it('matches ^[A-Z][A-Z0-9_]*$ for every id and key, including hostile characters', () => {
    const ids = ['conn-a', 'conn-my-db', 'conn-Mixed_Case', 'conn-99', 'conn-a.b c/d:e'];
    const keys = ['apiKey', 'client secret', 'a.b-c', 'ключ', '$$$', ''];
    for (const id of ids) {
      for (const key of keys) {
        const name = workerSecretName(id, key);
        expect(name, `${id} / ${key} -> ${name}`).toMatch(WORKER_SECRET_NAME_PATTERN);
      }
    }
  });

  it('is deterministic and collision-free across distinct keys', () => {
    expect(workerSecretName('conn-a', 'apiKey')).toBe(workerSecretName('conn-a', 'apiKey'));
    expect(workerSecretName('conn-a', 'user')).not.toBe(workerSecretName('conn-a', 'pass'));
  });
});

describe('isConnectionId', () => {
  it('accepts ids matching the declared pattern', () => {
    for (const id of ['conn-a', 'conn-A9', 'conn-my_db-1', `conn-${'x'.repeat(64)}`]) {
      expect(isConnectionId(id), id).toBe(true);
      expect(CONNECTION_ID_PATTERN.test(id), id).toBe(true);
    }
  });

  it('rejects empty, unprefixed, overlong and illegally charactered ids', () => {
    const rejected = [
      '',
      'conn-',
      'stripe',
      'CONN-a',
      'conn_a',
      ' conn-a',
      'conn-a ',
      'conn-a\n',
      'conn-a.b',
      'conn-a:b',
      'conn-a/b',
      `conn-${'x'.repeat(65)}`,
    ];
    for (const id of rejected) {
      expect(isConnectionId(id), JSON.stringify(id)).toBe(false);
    }
  });

  it('rejects non-string values', () => {
    for (const value of [undefined, null, 42, true, {}, [], Symbol('conn-a')]) {
      expect(isConnectionId(value)).toBe(false);
    }
  });
});

describe('assertConnectionId', () => {
  it('returns the narrowed id when valid', () => {
    expect(assertConnectionId('conn-stripe')).toBe('conn-stripe');
  });

  it('throws a message naming the rejected string value', () => {
    expect(() => assertConnectionId('nope')).toThrowError(/Invalid connection id "nope"/);
  });

  it('throws a message naming a rejected non-string value', () => {
    expect(() => assertConnectionId(undefined)).toThrowError(/Invalid connection id undefined/);
    expect(() => assertConnectionId(null)).toThrowError(/Invalid connection id null/);
  });

  it('reports the expected pattern so the caller can correct the id', () => {
    expect(() => assertConnectionId('')).toThrowError(
      new RegExp(CONNECTION_ID_PATTERN.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });
});

/**
 * `authSecretKeyNames` (Requirement 2.2 support).
 *
 * `ConnectionAuth` holds POINTERS, never values, which is why a mode can need
 * one, two or three names. Authoring surfaces declare those names on the
 * connection automatically; before that, an operator had to type the same name
 * into both the auth field and the secret list, and a mismatch resolved to
 * nothing at run time with no visible cause.
 */
describe('authSecretKeyNames', () => {
  it('returns nothing for unauthenticated and undefined descriptors', () => {
    expect(authSecretKeyNames({ mode: 'none' })).toEqual([]);
    expect(authSecretKeyNames(undefined)).toEqual([]);
  });

  it('returns the single pointer of the one-secret modes', () => {
    expect(authSecretKeyNames({ mode: 'bearer', secretKey: 'apiKey' })).toEqual(['apiKey']);
    expect(
      authSecretKeyNames({ mode: 'header', header: 'X-Api-Key', secretKey: 'apiKey' }),
    ).toEqual(['apiKey']);
    expect(authSecretKeyNames({ mode: 'query', param: 'api_key', secretKey: 'apiKey' })).toEqual([
      'apiKey',
    ]);
  });

  it('returns every pointer of the multi-secret modes, in declaration order', () => {
    expect(
      authSecretKeyNames({ mode: 'basic', userSecretKey: 'user', passwordSecretKey: 'pass' }),
    ).toEqual(['user', 'pass']);
    expect(
      authSecretKeyNames({
        mode: 'oauth2-refresh',
        tokenUrl: 'https://auth.example.com/token',
        clientIdSecretKey: 'clientId',
        clientSecretKey: 'clientSecret',
        refreshTokenSecretKey: 'refreshToken',
      }),
    ).toEqual(['clientId', 'clientSecret', 'refreshToken']);
    expect(
      authSecretKeyNames({
        mode: 'aws-sigv4',
        service: 'execute-api',
        region: 'us-east-1',
        accessKeySecretKey: 'accessKeyId',
        secretKeySecretKey: 'secretAccessKey',
      }),
    ).toEqual(['accessKeyId', 'secretAccessKey']);
  });

  it('trims, drops blanks and de-duplicates, so a half-filled form declares nothing empty', () => {
    expect(
      authSecretKeyNames({ mode: 'basic', userSecretKey: '  creds ', passwordSecretKey: 'creds' }),
    ).toEqual(['creds']);
    expect(authSecretKeyNames({ mode: 'bearer', secretKey: '   ' })).toEqual([]);
  });

  it('produces names a host can turn into a store entry', () => {
    for (const name of authSecretKeyNames({
      mode: 'basic',
      userSecretKey: 'user',
      passwordSecretKey: 'pass',
    })) {
      expect(workerSecretName('conn-a', name)).toMatch(WORKER_SECRET_NAME_PATTERN);
    }
  });
});

/**
 * Property 19: Secret entry names are deterministic, injective and bounded
 *
 * `awsSecretName` derives the Secrets Manager entry name for one connection
 * field under the IaC-owned prefix. The three properties that matter:
 *
 * 1. Determinism: same inputs always produce the same output.
 * 2. Injectivity: distinct (connectionId, secretKey) pairs produce distinct names.
 * 3. Bounded: result is at most 512 characters.
 *
 * Generators include pairs whose characters could be mistaken for the `/`
 * separator, so collisions from forged path segments are tested directly.
 *
 * **Validates: Requirements 8.2**
 */

// ─────────────────────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────────────────────

/** Valid connection ids matching `^conn-[A-Za-z0-9_-]{1,64}$`. */
const connectionIdArb: fc.Arbitrary<string> = fc
  .stringMatching(/^[A-Za-z0-9_-]{1,64}$/)
  .filter((s) => s.length >= 1)
  .map((s) => `conn-${s}`);

/**
 * Secret keys that include the separator `/` and other characters that could
 * cause confusion with the path structure.
 */
const secretKeyArb: fc.Arbitrary<string> = fc.oneof(
  // Plain alphanumeric keys
  fc.stringMatching(/^[a-zA-Z0-9_.\-]{1,80}$/),
  // Keys containing the `/` separator to test injectivity under forging attempts
  fc.stringMatching(/^[a-zA-Z0-9_.\-\/]{1,40}$/).map((s) => `${s}/conn/${s}`),
  // Keys that look like path segments: `conn/{id}/{rest}`
  fc.tuple(
    fc.stringMatching(/^[A-Za-z0-9_-]{1,20}$/),
    fc.stringMatching(/^[a-z0-9]{1,20}$/),
  ).map(([fakeId, rest]) => `conn-${fakeId}/${rest}`),
  // Keys with only separators and special characters
  fc.stringMatching(/^[/_+=.@\-]{1,40}$/),
);

/** Short IaC prefix, realistic range. */
const prefixArb: fc.Arbitrary<string> = fc.stringMatching(/^[a-z0-9\-]{1,30}$/).filter(
  (s) => s.length >= 1,
);

// ─────────────────────────────────────────────────────────────────────────────
// Property tests
// ─────────────────────────────────────────────────────────────────────────────

describe('awsSecretName — Property 19', () => {
  it('is deterministic: same inputs always produce the same output', () => {
    fc.assert(
      fc.property(prefixArb, connectionIdArb, secretKeyArb, (prefix, connectionId, secretKey) => {
        const first = awsSecretName(prefix, connectionId, secretKey);
        const second = awsSecretName(prefix, connectionId, secretKey);
        expect(first).toBe(second);
      }),
      { numRuns: 200 },
    );
  });

  it('is injective: distinct (connectionId, secretKey) pairs produce distinct names', () => {
    fc.assert(
      fc.property(
        prefixArb,
        connectionIdArb,
        secretKeyArb,
        connectionIdArb,
        secretKeyArb,
        (prefix, id1, key1, id2, key2) => {
          // Skip when the pairs are actually the same
          if (id1 === id2 && key1 === key2) return;
          const name1 = awsSecretName(prefix, id1, key1);
          const name2 = awsSecretName(prefix, id2, key2);
          expect(name1).not.toBe(name2);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('is bounded: result is at most 512 characters', () => {
    fc.assert(
      fc.property(prefixArb, connectionIdArb, secretKeyArb, (prefix, connectionId, secretKey) => {
        const name = awsSecretName(prefix, connectionId, secretKey);
        expect(name.length).toBeLessThanOrEqual(512);
      }),
      { numRuns: 200 },
    );
  });

  it('keeps the `/` separator out of the normalised secret key segment', () => {
    fc.assert(
      fc.property(prefixArb, connectionIdArb, secretKeyArb, (prefix, connectionId, secretKey) => {
        const name = awsSecretName(prefix, connectionId, secretKey);
        // Shape: {prefix}/conn/{connectionId}/{normalisedSecretKey}
        // Split on `/` and verify the normalised key (everything after the 3rd `/`) contains no `/`
        const parts = name.split('/');
        // prefix, 'conn', connectionId, normalisedSecretKey...
        // The first part is the prefix, then 'conn', then connectionId, then the rest is the key
        expect(parts.length).toBe(4);
        expect(parts[1]).toBe('conn');
        expect(parts[2]).toBe(connectionId);
        // The normalised key is the 4th part and must not contain `/`
        expect(parts[3]).not.toContain('/');
      }),
      { numRuns: 200 },
    );
  });
});
