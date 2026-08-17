/**
 * Unit tests for the production `MonitorBackend`.
 *
 * The Check_Pipeline runs with no AWS credentials present, so importing this
 * module and calling the factory must construct a client without resolving a
 * credential or reaching the network - the first assertion doubles as that
 * check.
 *
 * The two Run_Table halves of the port run against `FakeDocumentTableClient`,
 * so `listConnections` and `removeConnection` are exercised for real: one
 * partition `Query` with the `conn#` prefix, and a key-scoped `DeleteItem`.
 * `postToConnection` is the one operation that needs a live management API and
 * is covered by `monitor.spec.ts` through the port.
 *
 * Feature: aws-byo-deploy
 * Requirements: 8.1, 8.2, 8.3, 8.7
 */

import { describe, expect, it } from 'vitest';

import { connSk, pk } from '../core/keys.js';
import { FakeDocumentTableClient } from '../test/fake-document-table-client.js';
import { FakeRunTable } from '../test/fake-run-table.js';

import { createMonitorBackend, managementEndpoint } from './monitor-backend.js';
import type { DocumentTableClient, MonitorBackend } from './ports.js';

const TABLE = 'phorma-run-table';
const ENDPOINT = 'wss://abc123.execute-api.eu-west-1.amazonaws.com/live';
const NOW_MS = 1_700_000_000_000;

const PORT_METHODS: (keyof MonitorBackend)[] = [
  'listConnections',
  'postToConnection',
  'removeConnection',
];

function backendOver(table: DocumentTableClient): MonitorBackend {
  return createMonitorBackend({
    region: 'eu-west-1',
    endpoint: ENDPOINT,
    table,
    tableName: TABLE,
    now: () => NOW_MS,
  });
}

function fakeTable(): FakeDocumentTableClient {
  return new FakeDocumentTableClient(new FakeRunTable(), { tableName: TABLE });
}

/**
 * A two-page `Query` responder. `FakeRunTable` only paginates when the caller
 * sets a page size, and the backend deliberately does not, so the multi-page
 * walk needs a table that hands back a `LastEvaluatedKey` on its own.
 * Every other operation is out of scope here and rejects if reached.
 */
function pagingTable(startKeys: unknown[]): DocumentTableClient {
  const unreached = (operation: string) => async (): Promise<never> => {
    throw new Error(`${operation} is not part of this test`);
  };

  return {
    get: unreached('GetItem'),
    put: unreached('PutItem'),
    update: unreached('UpdateItem'),
    delete: unreached('DeleteItem'),
    batchWrite: unreached('BatchWriteItem'),
    transactWrite: unreached('TransactWriteItems'),
    async query(input) {
      startKeys.push(input.ExclusiveStartKey);
      return input.ExclusiveStartKey === undefined
        ? {
            $metadata: {},
            Items: [{ pk: pk('w1'), sk: connSk('c-1'), connectionId: 'c-1' }],
            LastEvaluatedKey: { pk: pk('w1'), sk: connSk('c-1') },
          }
        : {
            $metadata: {},
            Items: [{ pk: pk('w1'), sk: connSk('c-2'), connectionId: 'c-2' }],
          };
    },
  };
}

describe('createMonitorBackend', () => {
  it('exposes exactly the three MonitorBackend operations', () => {
    const backend = backendOver(fakeTable());

    for (const method of PORT_METHODS) {
      expect(typeof backend[method]).toBe('function');
    }
    expect(Object.keys(backend).sort()).toEqual([...PORT_METHODS].sort());
  });

  describe('managementEndpoint', () => {
    it('maps the WebSocket schemes onto their HTTP equivalents', () => {
      expect(managementEndpoint('wss://api.example.com/live')).toBe(
        'https://api.example.com/live',
      );
      expect(managementEndpoint('ws://localhost:3001/live')).toBe('http://localhost:3001/live');
    });

    it('leaves an https endpoint unchanged', () => {
      expect(managementEndpoint('https://api.example.com/live')).toBe(
        'https://api.example.com/live',
      );
    });
  });

  describe('listConnections', () => {
    it('reads the conn# records of one workflow partition and no other', async () => {
      const table = fakeTable();
      table.table.seed({ pk: pk('w1'), sk: connSk('c-1') }, { connectionId: 'c-1' });
      table.table.seed({ pk: pk('w1'), sk: connSk('c-2') }, { connectionId: 'c-2' });
      table.table.seed({ pk: pk('w2'), sk: connSk('c-3') }, { connectionId: 'c-3' });

      const found = await backendOver(table).listConnections('w1');

      expect([...found].sort()).toEqual(['c-1', 'c-2']);
      // One partition read, prefixed to the connection records (Req 8.3, 8.6)
      expect(table.log.map((entry) => entry.operation)).toEqual(['Query']);
      expect(table.log[0].key).toEqual({ pk: pk('w1'), sk: 'conn#' });
    });

    it('ignores every other item type in the same partition', async () => {
      const table = fakeTable();
      table.table.seed({ pk: pk('w1'), sk: 'spec' }, { savedAt: 'now' });
      table.table.seed({ pk: pk('w1'), sk: 'lease' }, { fence: 3 });
      table.table.seed({ pk: pk('w1'), sk: 'run#r1' }, { status: 'running' });
      table.table.seed({ pk: pk('w1'), sk: connSk('c-1') }, { connectionId: 'c-1' });

      expect(await backendOver(table).listConnections('w1')).toEqual(['c-1']);
    });

    it('returns no connection ids for a workflow with none', async () => {
      expect(await backendOver(fakeTable()).listConnections('w-empty')).toEqual([]);
    });

    it('derives the connection id from the sort key when the attribute is absent', async () => {
      const table = fakeTable();
      table.table.seed({ pk: pk('w1'), sk: connSk('c-derived') }, {});

      expect(await backendOver(table).listConnections('w1')).toEqual(['c-derived']);
    });

    it('excludes a connection record whose TTL has already passed', async () => {
      const table = fakeTable();
      const expiredTtl = Math.floor(NOW_MS / 1000) - 1;
      const liveTtl = Math.floor(NOW_MS / 1000) + 7200;
      table.table.seed(
        { pk: pk('w1'), sk: connSk('c-stale') },
        { connectionId: 'c-stale', ttl: expiredTtl },
      );
      table.table.seed(
        { pk: pk('w1'), sk: connSk('c-live') },
        { connectionId: 'c-live', ttl: liveTtl },
      );

      expect(await backendOver(table).listConnections('w1')).toEqual(['c-live']);
    });

    it('walks every page of the partition read', async () => {
      const startKeys: unknown[] = [];
      const paging = pagingTable(startKeys);

      expect(await backendOver(paging).listConnections('w1')).toEqual(['c-1', 'c-2']);
      expect(startKeys).toEqual([undefined, { pk: pk('w1'), sk: connSk('c-1') }]);
    });
  });

  describe('removeConnection', () => {
    it('deletes only that connection record from that workflow partition', async () => {
      const table = fakeTable();
      table.table.seed({ pk: pk('w1'), sk: connSk('c-1') }, { connectionId: 'c-1' });
      table.table.seed({ pk: pk('w1'), sk: connSk('c-2') }, { connectionId: 'c-2' });
      table.table.seed({ pk: pk('w2'), sk: connSk('c-1') }, { connectionId: 'c-1' });

      await backendOver(table).removeConnection('w1', 'c-1');

      expect(table.table.getItem({ pk: pk('w1'), sk: connSk('c-1') })).toBeNull();
      expect(table.table.getItem({ pk: pk('w1'), sk: connSk('c-2') })).not.toBeNull();
      expect(table.table.getItem({ pk: pk('w2'), sk: connSk('c-1') })).not.toBeNull();
    });

    it('resolves when the connection record is already gone', async () => {
      const backend = backendOver(fakeTable());
      await expect(backend.removeConnection('w1', 'c-absent')).resolves.toBeUndefined();
    });
  });
});
