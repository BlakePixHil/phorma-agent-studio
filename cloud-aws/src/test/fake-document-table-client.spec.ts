/**
 * FakeDocumentTableClient unit tests.
 *
 * The fixture is only useful if a real `@aws-sdk/lib-dynamodb` command input
 * produced by `aws/table-ops-compile.ts` executes with the same semantics
 * `FakeRunTable` gives the pure shapes. These tests drive the production
 * compile path end to end - `lease.ts` decides, `table-ops-compile.ts` compiles,
 * the fixture decodes - and check the recorded request log survives.
 *
 * Feature: aws-byo-deploy
 * Requirements: 8.2, 8.6
 */

import { describe, expect, it } from 'vitest';

import { compileTransact, compileUpdate } from '../aws/table-ops-compile.js';
import { acquireWrite, fencedWrite, heartbeatWrite } from '../core/lease.js';
import { eventSk, gsi1pk, gsi1sk, leaseSk, pk, runSk, specSk } from '../core/keys.js';
import type { HeldLease } from '../core/host-contract.js';

import { FakeDocumentTableClient } from './fake-document-table-client.js';
import { FakeRunTable } from './fake-run-table.js';

const TABLE = 'phorma-run-table';
const WORKFLOW = 'w1';

function client(): FakeDocumentTableClient {
  return new FakeDocumentTableClient(new FakeRunTable(), { tableName: TABLE });
}

describe('FakeDocumentTableClient', () => {
  describe('GetItem', () => {
    it('returns a stored item and records the read with its partition key', async () => {
      const table = client();
      table.table.seed({ pk: pk(WORKFLOW), sk: specSk() }, { savedAt: 'now' });

      const found = await table.get({
        TableName: TABLE,
        Key: { pk: pk(WORKFLOW), sk: specSk() },
      });

      expect(found.Item?.['savedAt']).toBe('now');
      expect(table.log).toEqual([
        { operation: 'GetItem', key: { pk: pk(WORKFLOW), sk: specSk() } },
      ]);
    });

    it('returns no item for an absent key', async () => {
      const table = client();
      const missing = await table.get({ TableName: TABLE, Key: { pk: 'wf#none', sk: 'spec' } });
      expect(missing.Item).toBeUndefined();
    });

    it('rejects a command naming another table', async () => {
      const table = client();
      await expect(
        table.get({ TableName: 'other', Key: { pk: pk(WORKFLOW), sk: specSk() } }),
      ).rejects.toThrow(/expected table/);
    });
  });

  describe('PutItem', () => {
    it('honours a compiled attribute_not_exists condition', async () => {
      const table = client();
      const input = {
        TableName: TABLE,
        Item: { pk: pk(WORKFLOW), sk: specSk(), savedAt: 'first' },
        ConditionExpression: 'attribute_not_exists(#n0)',
        ExpressionAttributeNames: { '#n0': 'pk' },
      };

      await table.put(input);
      await expect(table.put(input)).rejects.toThrow(/conditional request failed/i);
      expect(table.table.getItem({ pk: pk(WORKFLOW), sk: specSk() })?.['savedAt']).toBe('first');
    });
  });

  describe('UpdateItem', () => {
    it('executes a compiled lease acquire, then refuses a live lease', async () => {
      const table = client();
      const nowMs = 1_700_000_000_000;

      const acquired = await table.update({
        ...compileUpdate(TABLE, acquireWrite(WORKFLOW, 'runner-a', nowMs).request),
        ReturnValues: 'ALL_NEW',
      });

      expect(acquired.Attributes?.['fence']).toBe(1);
      expect(acquired.Attributes?.['runnerId']).toBe('runner-a');
      expect(acquired.Attributes?.['expiresAtMs']).toBe(nowMs + 60_000);

      await expect(
        table.update(compileUpdate(TABLE, acquireWrite(WORKFLOW, 'runner-b', nowMs).request)),
      ).rejects.toThrow(/conditional request failed/i);
    });

    it('rejects a heartbeat carrying a stale fencing token', async () => {
      const table = client();
      const nowMs = 1_700_000_000_000;
      await table.update(compileUpdate(TABLE, acquireWrite(WORKFLOW, 'runner-a', nowMs).request));

      const stale: HeldLease = {
        workflowId: WORKFLOW,
        runnerId: 'runner-a',
        fence: 7,
        expiresAtMs: nowMs + 60_000,
      };
      await expect(
        table.update(compileUpdate(TABLE, heartbeatWrite(stale, nowMs + 1_000).request)),
      ).rejects.toThrow(/conditional request failed/i);
    });
  });

  describe('TransactWriteItems', () => {
    const nowMs = 1_700_000_000_000;

    async function withLease(): Promise<{ table: FakeDocumentTableClient; lease: HeldLease }> {
      const table = client();
      await table.update(compileUpdate(TABLE, acquireWrite(WORKFLOW, 'runner-a', nowMs).request));
      return {
        table,
        lease: {
          workflowId: WORKFLOW,
          runnerId: 'runner-a',
          fence: 1,
          expiresAtMs: nowMs + 60_000,
        },
      };
    }

    it('applies a fenced write and records the lease ConditionCheck first', async () => {
      const { table, lease } = await withLease();
      const dataKey = { pk: pk(WORKFLOW), sk: eventSk('r1', 0) };

      await table.transactWrite(
        compileTransact(TABLE, fencedWrite(lease, { key: dataKey, item: { seq: 0 } }).request),
      );

      expect(table.table.getItem(dataKey)?.['seq']).toBe(0);

      const recorded = table.log.filter((entry) => entry.operation === 'TransactWriteItems');
      expect(recorded).toHaveLength(1);
      expect(recorded[0].key).toEqual([{ pk: pk(WORKFLOW), sk: leaseSk() }, dataKey]);
      expect(recorded[0].condition).toBe('fence = 1');

      const input = table.requests.at(-1)!.input as {
        TransactItems: { ConditionCheck?: { Key: Record<string, unknown> } }[];
      };
      expect(input.TransactItems[0].ConditionCheck?.Key).toEqual({
        pk: pk(WORKFLOW),
        sk: leaseSk(),
      });
    });

    it('writes nothing when the fencing token no longer matches', async () => {
      const { table, lease } = await withLease();
      const zombie: HeldLease = { ...lease, fence: lease.fence - 1 };
      const dataKey = { pk: pk(WORKFLOW), sk: eventSk('r1', 1) };

      await expect(
        table.transactWrite(
          compileTransact(TABLE, fencedWrite(zombie, { key: dataKey, item: { seq: 1 } }).request),
        ),
      ).rejects.toThrow(/Transaction cancelled/i);
      expect(table.table.getItem(dataKey)).toBeNull();
    });
  });

  describe('Query', () => {
    it('pages a partition by sort key prefix', async () => {
      const table = client();
      for (let seq = 0; seq < 3; seq++) {
        table.table.seed({ pk: pk(WORKFLOW), sk: eventSk('r1', seq) }, { seq });
      }
      table.table.seed({ pk: pk(WORKFLOW), sk: eventSk('r2', 0) }, { seq: 0 });

      const first = await table.query({
        TableName: TABLE,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
        ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
        ExpressionAttributeValues: { ':pk': pk(WORKFLOW), ':prefix': 'event#r1#' },
        Limit: 2,
      });

      expect(first.Items?.map((item) => item['seq'])).toEqual([0, 1]);
      expect(first.LastEvaluatedKey).toBeDefined();

      const second = await table.query({
        TableName: TABLE,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
        ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
        ExpressionAttributeValues: { ':pk': pk(WORKFLOW), ':prefix': 'event#r1#' },
        Limit: 2,
        ExclusiveStartKey: first.LastEvaluatedKey,
      });

      expect(second.Items?.map((item) => item['seq'])).toEqual([2]);
      expect(second.LastEvaluatedKey).toBeUndefined();
    });

    it('serves a GSI1 query descending by index sort key', async () => {
      const table = client();
      const runs = [
        { id: 'r1', startedAt: 1_000 },
        { id: 'r2', startedAt: 3_000 },
        { id: 'r3', startedAt: 2_000 },
      ];
      for (const run of runs) {
        table.table.seed(
          { pk: pk(WORKFLOW), sk: runSk(run.id) },
          {
            summary: { id: run.id },
            gsi1pk: gsi1pk(WORKFLOW),
            gsi1sk: gsi1sk(run.startedAt, run.id),
          },
        );
      }
      // A decoy in the same base partition that the index must not return.
      table.table.seed({ pk: pk(WORKFLOW), sk: specSk() }, { savedAt: 'now' });

      const page = await table.query({
        TableName: TABLE,
        IndexName: 'GSI1',
        KeyConditionExpression: '#gpk = :gpk',
        ExpressionAttributeNames: { '#gpk': 'gsi1pk' },
        ExpressionAttributeValues: { ':gpk': gsi1pk(WORKFLOW) },
        ScanIndexForward: false,
        Limit: 2,
      });

      expect(
        page.Items?.map((item) => (item['summary'] as { id: string }).id),
      ).toEqual(['r2', 'r3']);
      expect(page.LastEvaluatedKey?.['gsi1sk']).toBe(gsi1sk(2_000, 'r3'));

      const rest = await table.query({
        TableName: TABLE,
        IndexName: 'GSI1',
        KeyConditionExpression: '#gpk = :gpk',
        ExpressionAttributeNames: { '#gpk': 'gsi1pk' },
        ExpressionAttributeValues: { ':gpk': gsi1pk(WORKFLOW) },
        ScanIndexForward: false,
        Limit: 2,
        ExclusiveStartKey: page.LastEvaluatedKey,
      });

      expect(rest.Items?.map((item) => (item['summary'] as { id: string }).id)).toEqual(['r1']);
    });

    it('refuses a key condition that does not fix the partition key', async () => {
      const table = client();
      await expect(
        table.query({
          TableName: TABLE,
          KeyConditionExpression: 'begins_with(#sk, :prefix)',
          ExpressionAttributeNames: { '#sk': 'sk' },
          ExpressionAttributeValues: { ':prefix': 'event#' },
        }),
      ).rejects.toThrow(/must fix 'pk'/);
    });
  });

  describe('BatchWriteItem', () => {
    it('applies puts and deletes in one request', async () => {
      const table = client();
      table.table.seed({ pk: pk(WORKFLOW), sk: eventSk('r1', 0) }, { seq: 0 });

      await table.batchWrite({
        RequestItems: {
          [TABLE]: [
            { PutRequest: { Item: { pk: pk(WORKFLOW), sk: eventSk('r1', 1), seq: 1 } } },
            { DeleteRequest: { Key: { pk: pk(WORKFLOW), sk: eventSk('r1', 0) } } },
          ],
        },
      });

      expect(table.table.getItem({ pk: pk(WORKFLOW), sk: eventSk('r1', 0) })).toBeNull();
      expect(table.table.getItem({ pk: pk(WORKFLOW), sk: eventSk('r1', 1) })?.['seq']).toBe(1);
    });
  });

  describe('the recorded request log', () => {
    it('names only partition-scoped operations, never a whole-table read', async () => {
      const table = client();
      const nowMs = 1_700_000_000_000;
      await table.update(compileUpdate(TABLE, acquireWrite(WORKFLOW, 'runner-a', nowMs).request));
      await table.get({ TableName: TABLE, Key: { pk: pk(WORKFLOW), sk: leaseSk() } });
      await table.query({
        TableName: TABLE,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'pk' },
        ExpressionAttributeValues: { ':pk': pk(WORKFLOW) },
      });

      expect(table.log.map((entry) => entry.operation)).toEqual([
        'UpdateItem',
        'GetItem',
        'Query',
      ]);
      for (const entry of table.log) {
        const keys = Array.isArray(entry.key) ? entry.key : [entry.key];
        for (const key of keys) expect(key.pk).toBe(pk(WORKFLOW));
      }
      expect(table.requests.map((entry) => entry.operation)).toEqual([
        'UpdateItem',
        'GetItem',
        'Query',
      ]);
    });
  });
});
