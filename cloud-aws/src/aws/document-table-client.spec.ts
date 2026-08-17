/**
 * Unit tests for the production `DocumentTableClient`.
 *
 * The Check_Pipeline runs with no AWS credentials present and this file is part
 * of it, so the assertion below doubles as the credential-free construction
 * check: importing the module builds no client, and calling the factory
 * resolves no credentials and reaches no network.
 *
 * Behaviour that needs a table behind it is covered against
 * `FakeDocumentTableClient` in `run-table.spec.ts`.
 *
 * Feature: aws-byo-deploy
 * Requirements: 8.3, 8.6
 */

import { describe, expect, it } from 'vitest';

import { createDocumentTableClient } from './document-table-client.js';
import type { DocumentTableClient } from './ports.js';

const PORT_METHODS: (keyof DocumentTableClient)[] = [
  'get',
  'put',
  'update',
  'delete',
  'query',
  'batchWrite',
  'transactWrite',
];

describe('createDocumentTableClient', () => {
  it('exposes exactly the seven DocumentTableClient operations', () => {
    const client = createDocumentTableClient({ region: 'eu-west-1', tableName: 'phorma-runs' });

    for (const method of PORT_METHODS) {
      expect(typeof client[method]).toBe('function');
    }
    expect(Object.keys(client).sort()).toEqual([...PORT_METHODS].sort());
  });

  it('builds an independent client per call', () => {
    const first = createDocumentTableClient({ region: 'eu-west-1', tableName: 'phorma-runs' });
    const second = createDocumentTableClient({ region: 'us-east-1', tableName: 'phorma-runs' });

    expect(second).not.toBe(first);
    expect(second.get).not.toBe(first.get);
  });
});
