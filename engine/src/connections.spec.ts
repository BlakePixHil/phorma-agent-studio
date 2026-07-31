import { describe, expect, it } from 'vitest';
import {
  CONNECTION_ID_PATTERN,
  CONNECTION_SECRET_PREFIX,
  assertConnectionId,
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
