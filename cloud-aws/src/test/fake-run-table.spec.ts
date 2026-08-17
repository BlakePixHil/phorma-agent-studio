/**
 * FakeRunTable unit tests - verifies the in-memory DynamoDB simulator.
 *
 * Feature: aws-deployment-target
 * Requirements: 18.3, 2.13
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeRunTable,
  ConditionalCheckFailedError,
  TransactionCancelledError,
  type ConditionNode,
} from './fake-run-table';

describe('FakeRunTable', () => {
  let table: FakeRunTable;

  beforeEach(() => {
    table = new FakeRunTable();
  });

  // -------------------------------------------------------------------------
  // PutItem
  // -------------------------------------------------------------------------

  describe('PutItem', () => {
    it('stores an item and retrieves it by key', () => {
      const key = { pk: 'wf#w1', sk: 'lease' };
      table.putItem({ key, item: { data: 'hello' } });
      const got = table.getItem(key);
      expect(got).toMatchObject({ pk: 'wf#w1', sk: 'lease', data: 'hello' });
    });

    it('overwrites an existing item', () => {
      const key = { pk: 'wf#w1', sk: 'spec' };
      table.putItem({ key, item: { v: 1 } });
      table.putItem({ key, item: { v: 2 } });
      expect(table.getItem(key)).toMatchObject({ v: 2 });
    });

    it('succeeds with attribute_not_exists when item is absent', () => {
      const key = { pk: 'wf#w1', sk: 'lease' };
      const condition: ConditionNode = { type: 'attribute_not_exists', path: 'pk' };
      table.putItem({ key, item: { fence: 1 }, condition });
      expect(table.getItem(key)).toMatchObject({ fence: 1 });
    });

    it('fails with attribute_not_exists when item exists', () => {
      const key = { pk: 'wf#w1', sk: 'lease' };
      table.putItem({ key, item: { fence: 1 } });
      const condition: ConditionNode = { type: 'attribute_not_exists', path: 'pk' };
      expect(() => table.putItem({ key, item: { fence: 2 }, condition })).toThrow(
        ConditionalCheckFailedError,
      );
      // Original item unchanged
      expect(table.getItem(key)).toMatchObject({ fence: 1 });
    });

    it('supports comparison conditions on stored attributes', () => {
      const key = { pk: 'wf#w1', sk: 'lease' };
      table.putItem({ key, item: { expiresAtMs: 1000 } });

      // Condition: expiresAtMs <= 2000 (should succeed)
      const passCondition: ConditionNode = {
        type: 'compare',
        op: '<=',
        left: { type: 'path', path: 'expiresAtMs' },
        right: { type: 'literal', value: 2000 },
      };
      table.putItem({ key, item: { expiresAtMs: 3000 }, condition: passCondition });
      expect(table.getItem(key)).toMatchObject({ expiresAtMs: 3000 });

      // Condition: expiresAtMs <= 2000 (should fail since now 3000)
      expect(() =>
        table.putItem({ key, item: { expiresAtMs: 4000 }, condition: passCondition }),
      ).toThrow(ConditionalCheckFailedError);
    });

    it('supports OR conditions (attribute_not_exists OR comparison)', () => {
      const key = { pk: 'wf#w1', sk: 'lease' };
      // Lease acquire condition: no item exists OR expiry has passed
      const acquireCondition: ConditionNode = {
        type: 'or',
        children: [
          { type: 'attribute_not_exists', path: 'pk' },
          {
            type: 'compare',
            op: '<=',
            left: { type: 'path', path: 'expiresAtMs' },
            right: { type: 'literal', value: 5000 },
          },
        ],
      };

      // First write: succeeds because attribute_not_exists
      table.putItem({ key, item: { expiresAtMs: 10000, fence: 1 }, condition: acquireCondition });
      expect(table.getItem(key)).toMatchObject({ fence: 1 });

      // Second write: fails because item exists AND expiry > 5000
      expect(() =>
        table.putItem({ key, item: { expiresAtMs: 20000, fence: 2 }, condition: acquireCondition }),
      ).toThrow(ConditionalCheckFailedError);
    });
  });

  // -------------------------------------------------------------------------
  // UpdateItem
  // -------------------------------------------------------------------------

  describe('UpdateItem', () => {
    it('creates a new item with SET expressions when absent', () => {
      const key = { pk: 'wf#w1', sk: 'lease' };
      table.updateItem({
        key,
        set: [
          { path: 'expiresAtMs', value: { type: 'literal', value: 60000 } },
          { path: 'runnerId', value: { type: 'literal', value: 'r1' } },
        ],
      });
      expect(table.getItem(key)).toMatchObject({ expiresAtMs: 60000, runnerId: 'r1' });
    });

    it('updates an existing item with SET expressions', () => {
      const key = { pk: 'wf#w1', sk: 'lease' };
      table.seed(key, { fence: 1, expiresAtMs: 5000 });
      table.updateItem({
        key,
        set: [{ path: 'expiresAtMs', value: { type: 'literal', value: 60000 } }],
      });
      expect(table.getItem(key)).toMatchObject({ fence: 1, expiresAtMs: 60000 });
    });

    it('supports if_not_exists in SET expressions', () => {
      const key = { pk: 'wf#w1', sk: 'lease' };
      // First time: fence not set, so if_not_exists(fence, 0) returns 0
      table.updateItem({
        key,
        set: [
          {
            path: 'fence',
            value: { type: 'if_not_exists', path: 'fence', fallback: { type: 'literal', value: 0 } },
          },
        ],
      });
      expect(table.getItem(key)).toMatchObject({ fence: 0 });

      // Second time: fence exists as 0, so if_not_exists returns 0 (existing)
      table.updateItem({
        key,
        set: [
          {
            path: 'fence',
            value: { type: 'if_not_exists', path: 'fence', fallback: { type: 'literal', value: 99 } },
          },
        ],
      });
      expect(table.getItem(key)).toMatchObject({ fence: 0 });
    });

    it('supports ADD expressions for numeric increment', () => {
      const key = { pk: 'wf#w1', sk: 'lease' };
      table.seed(key, { fence: 3 });
      table.updateItem({
        key,
        add: [{ path: 'fence', value: { type: 'literal', value: 1 } }],
      });
      expect(table.getItem(key)).toMatchObject({ fence: 4 });
    });

    it('ADD on missing field initializes to the value', () => {
      const key = { pk: 'wf#w1', sk: 'lease' };
      table.updateItem({
        key,
        add: [{ path: 'fence', value: { type: 'literal', value: 1 } }],
      });
      expect(table.getItem(key)).toMatchObject({ fence: 1 });
    });

    it('fails with a condition expression when the condition is not met', () => {
      const key = { pk: 'wf#w1', sk: 'lease' };
      table.seed(key, { fence: 5 });

      // Condition: fence = 3 (should fail because stored is 5)
      const condition: ConditionNode = {
        type: 'compare',
        op: '=',
        left: { type: 'path', path: 'fence' },
        right: { type: 'literal', value: 3 },
      };

      expect(() =>
        table.updateItem({
          key,
          condition,
          set: [{ path: 'expiresAtMs', value: { type: 'literal', value: 99000 } }],
        }),
      ).toThrow(ConditionalCheckFailedError);
      // Item unchanged
      expect(table.getItem(key)).toMatchObject({ fence: 5 });
      expect(table.getItem(key)).not.toHaveProperty('expiresAtMs');
    });

    it('passes with a condition expression when the condition is met', () => {
      const key = { pk: 'wf#w1', sk: 'lease' };
      table.seed(key, { fence: 5 });

      const condition: ConditionNode = {
        type: 'compare',
        op: '=',
        left: { type: 'path', path: 'fence' },
        right: { type: 'literal', value: 5 },
      };

      table.updateItem({
        key,
        condition,
        set: [{ path: 'expiresAtMs', value: { type: 'literal', value: 99000 } }],
      });
      expect(table.getItem(key)).toMatchObject({ fence: 5, expiresAtMs: 99000 });
    });
  });

  // -------------------------------------------------------------------------
  // TransactWriteItems
  // -------------------------------------------------------------------------

  describe('TransactWriteItems', () => {
    it('applies all writes atomically when all conditions pass', () => {
      const leaseKey = { pk: 'wf#w1', sk: 'lease' };
      const eventKey = { pk: 'wf#w1', sk: 'event#000000000001' };
      table.seed(leaseKey, { fence: 2 });

      table.transactWrite({
        items: [
          {
            type: 'conditionCheck',
            conditionCheck: {
              key: leaseKey,
              condition: {
                type: 'compare',
                op: '=',
                left: { type: 'path', path: 'fence' },
                right: { type: 'literal', value: 2 },
              },
            },
          },
          {
            type: 'put',
            put: { key: eventKey, item: { seq: 1, data: 'node-start' } },
          },
        ],
      });

      expect(table.getItem(eventKey)).toMatchObject({ seq: 1, data: 'node-start' });
    });

    it('applies no writes when any condition fails (all-or-nothing)', () => {
      const leaseKey = { pk: 'wf#w1', sk: 'lease' };
      const eventKey = { pk: 'wf#w1', sk: 'event#000000000001' };
      table.seed(leaseKey, { fence: 2 });

      expect(() =>
        table.transactWrite({
          items: [
            {
              type: 'conditionCheck',
              conditionCheck: {
                key: leaseKey,
                condition: {
                  type: 'compare',
                  op: '=',
                  left: { type: 'path', path: 'fence' },
                  right: { type: 'literal', value: 999 }, // Wrong fence
                },
              },
            },
            {
              type: 'put',
              put: { key: eventKey, item: { seq: 1, data: 'node-start' } },
            },
          ],
        }),
      ).toThrow(TransactionCancelledError);

      // The event was not written
      expect(table.getItem(eventKey)).toBeNull();
    });

    it('supports update within a transaction', () => {
      const leaseKey = { pk: 'wf#w1', sk: 'lease' };
      table.seed(leaseKey, { fence: 1, expiresAtMs: 5000 });

      table.transactWrite({
        items: [
          {
            type: 'update',
            update: {
              key: leaseKey,
              condition: {
                type: 'compare',
                op: '=',
                left: { type: 'path', path: 'fence' },
                right: { type: 'literal', value: 1 },
              },
              set: [{ path: 'expiresAtMs', value: { type: 'literal', value: 60000 } }],
            },
          },
        ],
      });

      expect(table.getItem(leaseKey)).toMatchObject({ fence: 1, expiresAtMs: 60000 });
    });

    it('supports delete within a transaction', () => {
      const key = { pk: 'wf#w1', sk: 'journal#key1' };
      table.seed(key, { output: 'result' });

      table.transactWrite({
        items: [{ type: 'delete', delete: { key } }],
      });

      expect(table.getItem(key)).toBeNull();
    });

    it('provides per-item failure reasons in TransactionCancelledError', () => {
      const key1 = { pk: 'wf#w1', sk: 'item1' };
      const key2 = { pk: 'wf#w1', sk: 'item2' };
      table.seed(key1, { val: 'a' });

      try {
        table.transactWrite({
          items: [
            {
              type: 'conditionCheck',
              conditionCheck: {
                key: key1,
                condition: {
                  type: 'compare',
                  op: '=',
                  left: { type: 'path', path: 'val' },
                  right: { type: 'literal', value: 'WRONG' },
                },
              },
            },
            {
              type: 'put',
              put: { key: key2, item: { val: 'b' } },
            },
          ],
        });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TransactionCancelledError);
        const err = e as TransactionCancelledError;
        expect(err.reasons[0]).toMatchObject({ code: 'ConditionalCheckFailed' });
        expect(err.reasons[1]).toBeUndefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  describe('Query', () => {
    it('returns items matching the partition key', () => {
      table.seed({ pk: 'wf#w1', sk: 'event#001' }, { seq: 1 });
      table.seed({ pk: 'wf#w1', sk: 'event#002' }, { seq: 2 });
      table.seed({ pk: 'wf#w2', sk: 'event#001' }, { seq: 1 });

      const result = table.query({ pk: 'wf#w1' });
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({ sk: 'event#001' });
      expect(result.items[1]).toMatchObject({ sk: 'event#002' });
    });

    it('filters by sort key prefix', () => {
      table.seed({ pk: 'wf#w1', sk: 'event#001' }, { seq: 1 });
      table.seed({ pk: 'wf#w1', sk: 'journal#key1' }, { out: 'x' });
      table.seed({ pk: 'wf#w1', sk: 'event#002' }, { seq: 2 });

      const result = table.query({ pk: 'wf#w1', skPrefix: 'event#' });
      expect(result.items).toHaveLength(2);
      expect(result.items.every((i) => (i.sk as string).startsWith('event#'))).toBe(true);
    });

    it('respects page size and returns a continuation token', () => {
      table.seed({ pk: 'wf#w1', sk: 'event#001' }, { seq: 1 });
      table.seed({ pk: 'wf#w1', sk: 'event#002' }, { seq: 2 });
      table.seed({ pk: 'wf#w1', sk: 'event#003' }, { seq: 3 });

      const page1 = table.query({ pk: 'wf#w1', skPrefix: 'event#', pageSize: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.lastKey).toBeDefined();
      expect(page1.items[0]).toMatchObject({ seq: 1 });
      expect(page1.items[1]).toMatchObject({ seq: 2 });

      const page2 = table.query({
        pk: 'wf#w1',
        skPrefix: 'event#',
        pageSize: 2,
        startKey: page1.lastKey,
      });
      expect(page2.items).toHaveLength(1);
      expect(page2.lastKey).toBeUndefined();
      expect(page2.items[0]).toMatchObject({ seq: 3 });
    });

    it('supports descending order', () => {
      table.seed({ pk: 'wf#w1', sk: 'run#001' }, { id: 1 });
      table.seed({ pk: 'wf#w1', sk: 'run#002' }, { id: 2 });
      table.seed({ pk: 'wf#w1', sk: 'run#003' }, { id: 3 });

      const result = table.query({
        pk: 'wf#w1',
        skPrefix: 'run#',
        scanIndexForward: false,
      });
      expect(result.items[0]).toMatchObject({ sk: 'run#003' });
      expect(result.items[2]).toMatchObject({ sk: 'run#001' });
    });

    it('returns empty when partition does not exist', () => {
      const result = table.query({ pk: 'wf#nonexistent' });
      expect(result.items).toHaveLength(0);
      expect(result.lastKey).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // BatchWriteItem
  // -------------------------------------------------------------------------

  describe('BatchWriteItem', () => {
    it('puts multiple items in one call', () => {
      table.batchWrite({
        puts: [
          { key: { pk: 'wf#w1', sk: 'event#001' }, item: { seq: 1 } },
          { key: { pk: 'wf#w1', sk: 'event#002' }, item: { seq: 2 } },
        ],
      });

      expect(table.getItem({ pk: 'wf#w1', sk: 'event#001' })).toMatchObject({ seq: 1 });
      expect(table.getItem({ pk: 'wf#w1', sk: 'event#002' })).toMatchObject({ seq: 2 });
    });

    it('deletes multiple items in one call', () => {
      table.seed({ pk: 'wf#w1', sk: 'journal#a' }, { out: 'x' });
      table.seed({ pk: 'wf#w1', sk: 'journal#b' }, { out: 'y' });

      table.batchWrite({
        deletes: [
          { pk: 'wf#w1', sk: 'journal#a' },
          { pk: 'wf#w1', sk: 'journal#b' },
        ],
      });

      expect(table.getItem({ pk: 'wf#w1', sk: 'journal#a' })).toBeNull();
      expect(table.getItem({ pk: 'wf#w1', sk: 'journal#b' })).toBeNull();
    });

    it('supports mixed puts and deletes', () => {
      table.seed({ pk: 'wf#w1', sk: 'old' }, { data: 'stale' });

      table.batchWrite({
        puts: [{ key: { pk: 'wf#w1', sk: 'new' }, item: { data: 'fresh' } }],
        deletes: [{ pk: 'wf#w1', sk: 'old' }],
      });

      expect(table.getItem({ pk: 'wf#w1', sk: 'old' })).toBeNull();
      expect(table.getItem({ pk: 'wf#w1', sk: 'new' })).toMatchObject({ data: 'fresh' });
    });
  });

  // -------------------------------------------------------------------------
  // Failure injection
  // -------------------------------------------------------------------------

  describe('failure injection', () => {
    it('throws before the operation mutates state', () => {
      const key = { pk: 'wf#w1', sk: 'data' };
      table.seed(key, { val: 'original' });

      table.setFailureInjector(() => {
        throw new Error('throttled');
      });

      expect(() => table.putItem({ key, item: { val: 'new' } })).toThrow('throttled');
      // Item unchanged
      expect(table.getItem(key)).toMatchObject({ val: 'original' });
    });

    it('can target specific operations', () => {
      table.setFailureInjector((op) => {
        if (op === 'UpdateItem') throw new Error('update blocked');
      });

      const key = { pk: 'wf#w1', sk: 'x' };
      // PutItem works
      table.putItem({ key, item: { v: 1 } });
      expect(table.getItem(key)).toMatchObject({ v: 1 });

      // UpdateItem fails
      expect(() =>
        table.updateItem({ key, set: [{ path: 'v', value: { type: 'literal', value: 2 } }] }),
      ).toThrow('update blocked');
    });

    it('can target specific keys', () => {
      table.setFailureInjector((_op, k) => {
        const key = Array.isArray(k) ? k[0] : k;
        if (key.sk === 'protected') throw new Error('denied');
      });

      table.putItem({ key: { pk: 'wf#w1', sk: 'allowed' }, item: { v: 1 } });
      expect(() =>
        table.putItem({ key: { pk: 'wf#w1', sk: 'protected' }, item: { v: 2 } }),
      ).toThrow('denied');
    });
  });

  // -------------------------------------------------------------------------
  // Request log
  // -------------------------------------------------------------------------

  describe('request log', () => {
    it('records every operation with key and condition', () => {
      const key = { pk: 'wf#w1', sk: 'lease' };
      const condition: ConditionNode = { type: 'attribute_not_exists', path: 'pk' };
      table.putItem({ key, item: { fence: 1 }, condition });

      expect(table.log).toHaveLength(1);
      expect(table.log[0].operation).toBe('PutItem');
      expect(table.log[0].key).toEqual(key);
      expect(table.log[0].condition).toBe('attribute_not_exists(pk)');
    });

    it('records query operations', () => {
      table.query({ pk: 'wf#w1', skPrefix: 'event#' });
      expect(table.log[0].operation).toBe('Query');
      expect(table.log[0].key).toEqual({ pk: 'wf#w1', sk: 'event#' });
    });

    it('records TransactWriteItems with all keys', () => {
      const leaseKey = { pk: 'wf#w1', sk: 'lease' };
      const eventKey = { pk: 'wf#w1', sk: 'event#001' };
      table.seed(leaseKey, { fence: 1 });

      table.transactWrite({
        items: [
          {
            type: 'conditionCheck',
            conditionCheck: {
              key: leaseKey,
              condition: {
                type: 'compare',
                op: '=',
                left: { type: 'path', path: 'fence' },
                right: { type: 'literal', value: 1 },
              },
            },
          },
          {
            type: 'put',
            put: { key: eventKey, item: { seq: 1 } },
          },
        ],
      });

      expect(table.log[0].operation).toBe('TransactWriteItems');
      expect(table.log[0].key).toEqual([leaseKey, eventKey]);
    });

    it('records failed operations too', () => {
      const key = { pk: 'wf#w1', sk: 'lease' };
      table.seed(key, { fence: 5 });

      try {
        table.putItem({
          key,
          item: { fence: 6 },
          condition: { type: 'attribute_not_exists', path: 'pk' },
        });
      } catch {
        // expected
      }

      expect(table.log).toHaveLength(1);
      expect(table.log[0].operation).toBe('PutItem');
    });

    it('can assert that all operations use a single partition key (no scan)', () => {
      table.putItem({ key: { pk: 'wf#w1', sk: 'lease' }, item: { fence: 1 } });
      table.query({ pk: 'wf#w1', skPrefix: 'event#' });
      table.batchWrite({
        puts: [{ key: { pk: 'wf#w1', sk: 'run#001' }, item: { id: 1 } }],
      });

      // Every logged key names a partition key
      for (const entry of table.log) {
        const keys = Array.isArray(entry.key) ? entry.key : [entry.key];
        for (const k of keys) {
          expect(k.pk).toBeTruthy();
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // DeleteItem
  // -------------------------------------------------------------------------

  describe('DeleteItem', () => {
    it('removes an existing item', () => {
      const key = { pk: 'wf#w1', sk: 'data' };
      table.seed(key, { val: 'x' });
      table.deleteItem(key);
      expect(table.getItem(key)).toBeNull();
    });

    it('no-ops on a missing item', () => {
      table.deleteItem({ pk: 'wf#w1', sk: 'nonexistent' });
      // No error thrown
    });

    it('supports condition expression', () => {
      const key = { pk: 'wf#w1', sk: 'lease' };
      table.seed(key, { fence: 3 });

      expect(() =>
        table.deleteItem(key, {
          type: 'compare',
          op: '=',
          left: { type: 'path', path: 'fence' },
          right: { type: 'literal', value: 99 },
        }),
      ).toThrow(ConditionalCheckFailedError);

      // Item still there
      expect(table.getItem(key)).toMatchObject({ fence: 3 });
    });
  });

  // -------------------------------------------------------------------------
  // Lease acquisition simulation (integration-style)
  // -------------------------------------------------------------------------

  describe('lease acquisition simulation', () => {
    it('simulates the lease acquire-heartbeat-release cycle', () => {
      const leaseKey = { pk: 'wf#w1', sk: 'lease' };

      // Acquire: attribute_not_exists(pk) OR expiresAtMs <= now
      const now = Date.now();
      const acquireCondition: ConditionNode = {
        type: 'or',
        children: [
          { type: 'attribute_not_exists', path: 'pk' },
          {
            type: 'compare',
            op: '<=',
            left: { type: 'path', path: 'expiresAtMs' },
            right: { type: 'literal', value: now },
          },
        ],
      };

      // Use UpdateItem with SET fence = if_not_exists(fence, 0) + ADD fence 1
      // Simplified: we set fence via if_not_exists + add
      table.updateItem({
        key: leaseKey,
        condition: acquireCondition,
        set: [
          { path: 'expiresAtMs', value: { type: 'literal', value: now + 60000 } },
          { path: 'runnerId', value: { type: 'literal', value: 'runner-1' } },
          {
            path: 'fence',
            value: { type: 'if_not_exists', path: 'fence', fallback: { type: 'literal', value: 0 } },
          },
        ],
        add: [{ path: 'fence', value: { type: 'literal', value: 1 } }],
      });

      const lease = table.getItem(leaseKey)!;
      expect(lease.fence).toBe(1);
      expect(lease.runnerId).toBe('runner-1');

      // Heartbeat: condition fence = mine
      const heartbeatCondition: ConditionNode = {
        type: 'compare',
        op: '=',
        left: { type: 'path', path: 'fence' },
        right: { type: 'literal', value: 1 },
      };
      table.updateItem({
        key: leaseKey,
        condition: heartbeatCondition,
        set: [{ path: 'expiresAtMs', value: { type: 'literal', value: now + 70000 } }],
      });
      expect(table.getItem(leaseKey)).toMatchObject({ expiresAtMs: now + 70000 });

      // Second runner tries to acquire (should fail - lease not expired)
      const acquireCondition2: ConditionNode = {
        type: 'or',
        children: [
          { type: 'attribute_not_exists', path: 'pk' },
          {
            type: 'compare',
            op: '<=',
            left: { type: 'path', path: 'expiresAtMs' },
            right: { type: 'literal', value: now + 5000 }, // still within expiry
          },
        ],
      };
      expect(() =>
        table.updateItem({
          key: leaseKey,
          condition: acquireCondition2,
          set: [
            { path: 'expiresAtMs', value: { type: 'literal', value: now + 120000 } },
            { path: 'runnerId', value: { type: 'literal', value: 'runner-2' } },
          ],
        }),
      ).toThrow(ConditionalCheckFailedError);

      // Release: set expiry to now, keep fence
      table.updateItem({
        key: leaseKey,
        condition: heartbeatCondition,
        set: [{ path: 'expiresAtMs', value: { type: 'literal', value: now } }],
      });
      expect(table.getItem(leaseKey)).toMatchObject({ fence: 1, expiresAtMs: now });

      // Now runner-2 can acquire (expiry has passed)
      const acquireAfterRelease: ConditionNode = {
        type: 'or',
        children: [
          { type: 'attribute_not_exists', path: 'pk' },
          {
            type: 'compare',
            op: '<=',
            left: { type: 'path', path: 'expiresAtMs' },
            right: { type: 'literal', value: now + 1000 },
          },
        ],
      };
      table.updateItem({
        key: leaseKey,
        condition: acquireAfterRelease,
        set: [
          { path: 'expiresAtMs', value: { type: 'literal', value: now + 120000 } },
          { path: 'runnerId', value: { type: 'literal', value: 'runner-2' } },
        ],
        add: [{ path: 'fence', value: { type: 'literal', value: 1 } }],
      });
      expect(table.getItem(leaseKey)).toMatchObject({ fence: 2, runnerId: 'runner-2' });
    });

    it('records the lease write as the first operation', () => {
      const leaseKey = { pk: 'wf#w1', sk: 'lease' };
      const acquireCondition: ConditionNode = {
        type: 'or',
        children: [
          { type: 'attribute_not_exists', path: 'pk' },
          {
            type: 'compare',
            op: '<=',
            left: { type: 'path', path: 'expiresAtMs' },
            right: { type: 'literal', value: Date.now() },
          },
        ],
      };

      table.updateItem({
        key: leaseKey,
        condition: acquireCondition,
        set: [{ path: 'fence', value: { type: 'literal', value: 1 } }],
      });

      // The lease write is the first logged operation
      expect(table.log[0].operation).toBe('UpdateItem');
      expect(table.log[0].key).toEqual(leaseKey);
      expect(table.log[0].condition).toContain('attribute_not_exists');
    });
  });
});
