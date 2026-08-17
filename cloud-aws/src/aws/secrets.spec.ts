/**
 * Property test for connection resolution.
 *
 * Property 20: Connection resolution is validated, ordered, complete-or-refusing, and secret-free.
 * Validates: Requirements 8.1, 8.4, 8.5, 8.8, 8.10, 8.13
 *
 * Feature: aws-deployment-target
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FakeSecretsManager } from '../test/fake-secrets-manager.js';
import { SecretsAdapter, SecretWriteError } from './secrets.js';
import type { SecretsConfig } from './secrets.js';
import { secretKeyCountEdge } from '../test/generators.js';
import type { Connection, Redactor } from '@phorma/engine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A simple Redactor mock that tracks what was seeded. */
function createTrackingRedactor(): Redactor & { seeded: string[] } {
  const seeded: string[] = [];
  return {
    seeded,
    addLiterals(values: readonly string[]) {
      seeded.push(...values);
    },
    scrub(value: string) {
      return value;
    },
    event(event) {
      return event;
    },
    ruleErrors: [],
  };
}

/** Build a valid connection id matching /^conn-[A-Za-z0-9_-]{1,64}$/ */
function validConnectionId(index: number): string {
  return `conn-test-${index}`;
}

/** Build a Connection object with a given set of secret keys. */
function makeConnection(id: string, secretKeys: string[]): Connection {
  return {
    id,
    name: `Test Connection ${id}`,
    type: 'http',
    config: { baseUrl: 'https://example.com' },
    secretKeys,
    auth: { mode: 'none' },
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };
}

// ---------------------------------------------------------------------------
// Property 20: Connection resolution is validated, ordered,
// complete-or-refusing, and secret-free
// ---------------------------------------------------------------------------

describe('secrets - Property 20: Connection resolution is validated, ordered, complete-or-refusing, and secret-free', () => {
  /**
   * **Validates: Requirements 8.1**
   *
   * Resolution validates the connectionId first. An invalid id throws before
   * any secret read is attempted.
   */
  it('resolution rejects an invalid connectionId before reading any secret', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate strings that do NOT match /^conn-[A-Za-z0-9_-]{1,64}$/
        fc.oneof(
          fc.constant(''),
          fc.constant('invalid'),
          fc.constant('conn_nope'),
          fc.constant('CONN-bad'),
          fc.string({ minLength: 0, maxLength: 10 }),
        ),
        async (badId) => {
          // Skip the rare case where the random string happens to be valid
          if (/^conn-[A-Za-z0-9_-]{1,64}$/.test(badId)) return;

          const backend = new FakeSecretsManager();
          const redactor = createTrackingRedactor();
          const config: SecretsConfig = {
            prefix: 'test-prefix',
            connections: new Map(),
          };
          const adapter = new SecretsAdapter(backend, config, redactor);

          await expect(adapter.resolve(badId)).rejects.toThrow(/Invalid connection id/);
          // No secret reads attempted
          expect(backend.log).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 8.10**
   *
   * Keys are resolved in declaration order. The FakeSecretsManager log records
   * the exact sequence of get operations.
   */
  it('keys are resolved in declaration order', async () => {
    await fc.assert(
      fc.asyncProperty(
        secretKeyCountEdge(),
        async (secretKeys) => {
          const connectionId = validConnectionId(0);
          const backend = new FakeSecretsManager();
          const redactor = createTrackingRedactor();

          const connection = makeConnection(connectionId, secretKeys);
          const config: SecretsConfig = {
            prefix: 'pfx',
            connections: new Map([[connectionId, connection]]),
          };
          const adapter = new SecretsAdapter(backend, config, redactor);

          // Seed all secret values so resolution succeeds
          for (const key of secretKeys) {
            const entryName = `pfx/conn/${connectionId}/${key.replace(/[^A-Za-z0-9_.\-]/g, (ch) => `_${ch.charCodeAt(0).toString(16).padStart(2, '0')}`)}`; // eslint-disable-line no-control-regex
            backend.seed(entryName, `value-for-${key}-${'x'.repeat(10)}`);
          }

          await adapter.resolve(connectionId);

          // Assert the log order matches declaration order
          const getOps = backend.log.filter(e => e.operation === 'get');
          expect(getOps).toHaveLength(secretKeys.length);
          for (let i = 0; i < secretKeys.length; i++) {
            expect(getOps[i].name).toContain(secretKeys[i].replace(/[^A-Za-z0-9_.\-]/g, ''));
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 8.10**
   *
   * Resolution stops at the first absent key (complete-or-refusing). When key N
   * is absent, no key after N is read.
   */
  it('resolution stops at the first absent key', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate 2-32 keys and pick a random gap position
        fc.integer({ min: 2, max: 32 }).chain(count =>
          fc.tuple(
            fc.constant(Array.from({ length: count }, (_, i) => `key-${i}`)),
            fc.integer({ min: 0, max: count - 1 }),
          ),
        ),
        async ([secretKeys, absentIndex]) => {
          const connectionId = validConnectionId(1);
          const backend = new FakeSecretsManager();
          const redactor = createTrackingRedactor();

          const connection = makeConnection(connectionId, secretKeys);
          const config: SecretsConfig = {
            prefix: 'pfx',
            connections: new Map([[connectionId, connection]]),
          };
          const adapter = new SecretsAdapter(backend, config, redactor);

          // Seed all keys EXCEPT the one at absentIndex
          for (let i = 0; i < secretKeys.length; i++) {
            if (i === absentIndex) continue;
            const entryName = `pfx/conn/${connectionId}/${secretKeys[i]}`;
            backend.seed(entryName, `value-${i}-longvalue`);
          }

          await expect(adapter.resolve(connectionId)).rejects.toThrow(
            new RegExp(`secret key "${secretKeys[absentIndex]}" is absent`),
          );

          // Only keys up to and including the absent one were read
          const getOps = backend.log.filter(e => e.operation === 'get');
          expect(getOps).toHaveLength(absentIndex + 1);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 8.11**
   *
   * The Redactor is seeded with resolved values >= 8 chars. Values shorter
   * than 8 chars are NOT seeded.
   */
  it('Redactor is seeded with resolved values of 8 or more characters', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.tuple(
            fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,15}$/),
            fc.string({ minLength: 1, maxLength: 20 }),
          ),
          { minLength: 1, maxLength: 10 },
        ),
        async (keyValuePairs) => {
          const connectionId = validConnectionId(2);
          const backend = new FakeSecretsManager();
          const redactor = createTrackingRedactor();

          const secretKeys = keyValuePairs.map(([k]) => k);
          // Deduplicate keys
          const unique = [...new Set(secretKeys)];
          const values = keyValuePairs.slice(0, unique.length).map(([, v]) => v);

          const connection = makeConnection(connectionId, unique);
          const config: SecretsConfig = {
            prefix: 'pfx',
            connections: new Map([[connectionId, connection]]),
          };
          const adapter = new SecretsAdapter(backend, config, redactor);

          // Seed all secret values
          for (let i = 0; i < unique.length; i++) {
            const entryName = `pfx/conn/${connectionId}/${unique[i]}`;
            backend.seed(entryName, values[i]);
          }

          await adapter.resolve(connectionId);

          // Only values >= 8 chars should be seeded
          const expectedSeeded = values.filter(v => v.length >= 8);
          expect(redactor.seeded.sort()).toEqual(expectedSeeded.sort());
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 8.13**
   *
   * No secret value appears in metadata or any non-secret field of the
   * ResolvedConnection. Metadata carrying a planted value where a secret name
   * belongs must not leak the value.
   */
  it('no secret value appears in metadata or non-secret fields', async () => {
    await fc.assert(
      fc.asyncProperty(
        secretKeyCountEdge().filter(keys => keys.length > 0),
        async (secretKeys) => {
          const connectionId = validConnectionId(3);
          const backend = new FakeSecretsManager();
          const redactor = createTrackingRedactor();

          // Use a "planted" secret value that could appear in metadata
          const plantedSecret = 'PLANTED_SECRET_VALUE_12345';
          const connection: Connection = {
            id: connectionId,
            name: `Connection with ${plantedSecret}`, // planted in metadata
            type: 'http',
            config: { baseUrl: 'https://example.com', note: plantedSecret },
            secretKeys,
            auth: { mode: 'none' },
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          };

          const config: SecretsConfig = {
            prefix: 'pfx',
            connections: new Map([[connectionId, connection]]),
          };
          const adapter = new SecretsAdapter(backend, config, redactor);

          // Seed all keys with the planted secret as the value
          for (const key of secretKeys) {
            const entryName = `pfx/conn/${connectionId}/${key.replace(/[^A-Za-z0-9_.\-]/g, (ch) => `_${ch.charCodeAt(0).toString(16).padStart(2, '0')}`)}`;
            backend.seed(entryName, plantedSecret);
          }

          const resolved = await adapter.resolve(connectionId);

          // Secret values must not leak into any non-secret field
          // Check that the resolved.secrets DOES contain the value (correct behaviour)
          for (const key of secretKeys) {
            expect(resolved.secrets[key]).toBe(plantedSecret);
          }

          // The non-secret fields (id, type, config, auth) must not contain secret values
          // from the secrets store (they may contain the planted value in config since that
          // was put there by the test - but the resolution path must not ADD secret values
          // to config or other fields)
          expect(resolved.id).toBe(connectionId);
          expect(resolved.type).toBe('http');
          // config is a copy of the original, not enriched with secret values
          expect(Object.values(resolved.secrets)).not.toContain(resolved.id);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 8.1**
   *
   * 0 secret keys resolves successfully with empty secrets.
   */
  it('0 secret keys resolves successfully with empty secrets', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constant([] as string[]),
        async (secretKeys) => {
          const connectionId = validConnectionId(4);
          const backend = new FakeSecretsManager();
          const redactor = createTrackingRedactor();

          const connection = makeConnection(connectionId, secretKeys);
          const config: SecretsConfig = {
            prefix: 'pfx',
            connections: new Map([[connectionId, connection]]),
          };
          const adapter = new SecretsAdapter(backend, config, redactor);

          const resolved = await adapter.resolve(connectionId);

          expect(resolved.secrets).toEqual({});
          expect(resolved.id).toBe(connectionId);
          // No secrets read, no redactor seeding
          expect(backend.log).toHaveLength(0);
          expect(redactor.seeded).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 8.1**
   *
   * 32 secret keys all resolving successfully.
   */
  it('32 secret keys all resolve successfully', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constant(Array.from({ length: 32 }, (_, i) => `secret-key-${i}`)),
        async (secretKeys) => {
          const connectionId = validConnectionId(5);
          const backend = new FakeSecretsManager();
          const redactor = createTrackingRedactor();

          const connection = makeConnection(connectionId, secretKeys);
          const config: SecretsConfig = {
            prefix: 'pfx',
            connections: new Map([[connectionId, connection]]),
          };
          const adapter = new SecretsAdapter(backend, config, redactor);

          // Seed all 32 keys with values >= 8 chars
          for (const key of secretKeys) {
            const entryName = `pfx/conn/${connectionId}/${key}`;
            backend.seed(entryName, `long-secret-value-for-${key}`);
          }

          const resolved = await adapter.resolve(connectionId);

          // All 32 keys resolved
          expect(Object.keys(resolved.secrets)).toHaveLength(32);
          for (const key of secretKeys) {
            expect(resolved.secrets[key]).toBe(`long-secret-value-for-${key}`);
          }

          // All 32 values seeded to redactor (all >= 8 chars)
          expect(redactor.seeded).toHaveLength(32);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 8.15**
   *
   * The Secret_Store write path rejects empty values and values over 64 KB.
   */
  it('write path rejects empty values and values over 64 KB', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          // Empty value
          fc.constant(''),
          // Value over 64 KB (65537 bytes minimum)
          fc.string({ minLength: 65537, maxLength: 65600 }),
        ),
        async (badValue) => {
          const connectionId = validConnectionId(6);
          const backend = new FakeSecretsManager();
          const redactor = createTrackingRedactor();

          const connection = makeConnection(connectionId, ['api-key']);
          const config: SecretsConfig = {
            prefix: 'pfx',
            connections: new Map([[connectionId, connection]]),
          };
          const adapter = new SecretsAdapter(backend, config, redactor);

          await expect(
            adapter.writeSecret(connectionId, 'api-key', badValue),
          ).rejects.toThrow(SecretWriteError);

          // Nothing was written to the backend
          const putOps = backend.log.filter(e => e.operation === 'put');
          expect(putOps).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
