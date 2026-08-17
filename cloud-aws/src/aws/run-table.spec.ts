/**
 * Property tests for the Run_Table adapter.
 *
 * Property 12: Run history and the usage ledger are upserted, ordered and paginated.
 * Validates: Requirements 4.1, 4.3, 4.4, 4.5, 4.11, 4.14
 *
 * Property 14: Purge is complete, itemised and idempotent, and never touches a secret.
 * Validates: Requirements 4.9, 4.10
 *
 * Property 26: Every Run_Table request names one partition key and never scans.
 * Validates: Requirements 18.3
 *
 * Feature: aws-deployment-target
 *
 * Property 8: Every run-scoped write is fenced.
 * Validates: Requirements 8.4
 *
 * Property 11: Every read is partition-scoped.
 * Validates: Requirements 8.6
 *
 * Property 27: Run history is descending by start time.
 * Validates: Requirements 15.4
 *
 * Feature: aws-byo-deploy
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type {
  GetCommandInput,
  QueryCommandInput,
  TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { RunRecordSummary } from '@phorma/engine';
import { FakeRunTable } from '../test/fake-run-table.js';
import {
  FakeDocumentTableClient,
  type RecordedRequest,
} from '../test/fake-document-table-client.js';
import { RunTableAdapter } from './run-table.js';
import { pk, connSk, leaseSk, gsi1pk, gsi1sk, gsi2pk } from '../core/keys.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** The Run_Table name every command input must name. */
const TABLE_NAME = 'phorma-run-table';

function makeAdapter(table?: FakeRunTable) {
  const t = table ?? new FakeRunTable();
  const client = new FakeDocumentTableClient(t, { tableName: TABLE_NAME });
  return { adapter: new RunTableAdapter(client, TABLE_NAME), table: t, client };
}

function makeRunRecord(runId: string, startedAt: number, status: string = 'completed') {
  return {
    summary: {
      id: runId,
      workflowId: null,
      workflowName: 'test-wf',
      source: 'manual',
      environment: 'cloud',
      status,
      input: '',
      startedAt,
      endedAt: startedAt + 5000,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      nodeCount: 1,
    },
    graph: { nodes: [], connections: [] },
    events: [],
  };
}

function makeUsageEntry(runId: string, nodeId: string, startedAt: number) {
  return {
    runId,
    nodeId,
    startedAt: new Date(startedAt).toISOString(),
    provider: 'anthropic',
    model: 'claude-sonnet',
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.001,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Property 26: Every Run_Table request names one partition key and never scans
// ─────────────────────────────────────────────────────────────────────────────

describe('run-table - Property 26: Every request names one partition key and never scans', () => {
  it('no operation produces a Scan in the request log', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.integer({ min: 1_000_000_000_000, max: 9_000_000_000_000 }),
        async (workflowId, runId, nowMs) => {
          const { adapter, table } = makeAdapter();

          // Perform various operations
          await adapter.write(workflowId, { spec: {} as any, savedAt: new Date(nowMs).toISOString() });
          await adapter.record(workflowId, runId, 'node-1', { output: 'test' });
          await adapter.upsert(workflowId, makeRunRecord(runId, nowMs) as any);
          await adapter.writeEvent(workflowId, runId, 1, { type: 'node-completed' } as any);
          await adapter.writeUsage(workflowId, makeUsageEntry(runId, 'node-1', nowMs) as any);
          await adapter.read(workflowId);
          await adapter.preload(workflowId, runId);
          await adapter.list(workflowId);
          await adapter.listEvents(workflowId, runId);
          await adapter.listUsage(workflowId, new Date(0).toISOString());
          await adapter.acquire(workflowId, 'runner-1', nowMs);

          // Assert no Scan operation exists in the log
          const scanOps = table.log.filter(entry => entry.operation === 'Scan');
          expect(scanOps).toHaveLength(0);

          // Assert every Query names a partition key
          const queryOps = table.log.filter(entry => entry.operation === 'Query');
          for (const op of queryOps) {
            const key = op.key as { pk: string; sk: string };
            expect(key.pk).toBe(pk(workflowId));
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('purge also names one partition key per operation and never scans', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.integer({ min: 1_000_000_000_000, max: 9_000_000_000_000 }),
        async (workflowId, nowMs) => {
          const { adapter, table } = makeAdapter();

          // Seed some data
          await adapter.write(workflowId, { spec: {} as any, savedAt: new Date(nowMs).toISOString() });
          await adapter.record(workflowId, 'run-1', 'node-1', { output: 'test' });
          await adapter.upsert(workflowId, makeRunRecord('run-1', nowMs) as any);

          table.log.length = 0; // Clear log before purge
          await adapter.purge(workflowId);

          // No Scan in purge operations
          const scanOps = table.log.filter(entry => entry.operation === 'Scan');
          expect(scanOps).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 12: Run history and usage ledger are upserted, ordered and paginated
// ─────────────────────────────────────────────────────────────────────────────

describe('run-table - Property 12: Run history and usage ledger are upserted, ordered and paginated', () => {
  it('run history upserts replace existing records', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.integer({ min: 1_000_000_000_000, max: 5_000_000_000_000 }),
        async (workflowId, runId, nowMs) => {
          const { adapter } = makeAdapter();

          // Write an in-flight record
          const base = makeRunRecord(runId, nowMs);
          const record1 = {
            ...base,
            summary: { ...base.summary, status: 'running', endedAt: undefined },
          };
          await adapter.upsert(workflowId, record1 as any);

          // Update to settled
          const record2 = makeRunRecord(runId, nowMs);
          await adapter.upsert(workflowId, record2 as any);

          // Read back - should be the settled version
          const stored = await adapter.get(workflowId, runId);
          expect(stored).not.toBeUndefined();
          expect(stored!.summary.status).toBe('completed');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('usage ledger entries keyed by (workflow, run, node) replace on resume', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.integer({ min: 1_000_000_000_000, max: 5_000_000_000_000 }),
        async (workflowId, runId, nodeId, nowMs) => {
          const { adapter } = makeAdapter();

          // Write initial usage
          const entry1 = { ...makeUsageEntry(runId, nodeId, nowMs), inputTokens: 50 };
          await adapter.writeUsage(workflowId, entry1 as any);

          // Resume writes again with different tokens
          const entry2 = { ...makeUsageEntry(runId, nodeId, nowMs), inputTokens: 200 };
          await adapter.writeUsage(workflowId, entry2 as any);

          // List should have exactly one entry (upsert, not append)
          const result = await adapter.listUsage(workflowId, new Date(0).toISOString());
          const matching = result.items.filter(
            (e: any) => e.runId === runId && e.nodeId === nodeId,
          );
          expect(matching).toHaveLength(1);
          expect((matching[0] as any).inputTokens).toBe(200);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('a skipped run record is served as an ordinary RunRecordSummary (Req 4.14)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.integer({ min: 1_000_000_000_000, max: 5_000_000_000_000 }),
        async (workflowId, runId, nowMs) => {
          const { adapter } = makeAdapter();

          const base = makeRunRecord(runId, nowMs);
          const record = { ...base, summary: { ...base.summary, status: 'skipped' } };
          await adapter.upsert(workflowId, record as any);

          const result = await adapter.list(workflowId);
          expect(result.items.length).toBeGreaterThan(0);
          const found = result.items.find((r) => r.id === runId);
          expect(found).not.toBeUndefined();
          expect(found!.status).toBe('skipped');
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 14: Purge is complete, itemised and idempotent, and never touches a secret
// ─────────────────────────────────────────────────────────────────────────────

describe('run-table - Property 14: Purge is complete, itemised and idempotent, and never touches a secret', () => {
  it('purge removes spec, journal, runs, events, usage, state and lease', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.integer({ min: 1_000_000_000_000, max: 5_000_000_000_000 }),
        async (workflowId, nowMs) => {
          const { adapter, table } = makeAdapter();

          // Seed data in all categories
          await adapter.write(workflowId, { spec: {} as any, savedAt: new Date(nowMs).toISOString() });
          await adapter.record(workflowId, 'run-1', 'node-1', { output: 'x' });
          await adapter.upsert(workflowId, makeRunRecord('run-1', nowMs) as any);
          await adapter.writeEvent(workflowId, 'run-1', 1, { type: 'node-completed' } as any);
          await adapter.writeUsage(workflowId, makeUsageEntry('run-1', 'n1', nowMs) as any);
          // Seed a state entry directly
          table.putItem({
            key: { pk: pk(workflowId), sk: 'state#key1' },
            item: { value: 'v1' },
          });
          // Acquire a lease
          await adapter.acquire(workflowId, 'runner-1', nowMs);

          // Purge
          const counts = await adapter.purge(workflowId);

          // All categories were affected
          expect(counts.spec).toBe(1);
          expect(counts.journal).toBeGreaterThanOrEqual(1);
          expect(counts.runs).toBeGreaterThanOrEqual(1);
          expect(counts.events).toBeGreaterThanOrEqual(1);
          expect(counts.usage).toBeGreaterThanOrEqual(1);
          expect(counts.state).toBeGreaterThanOrEqual(1);
          expect(counts.lease).toBe(1);
          expect(counts.failed).toHaveLength(0);

          // Verify nothing remains (except secrets, if any)
          expect(await adapter.read(workflowId)).toBeUndefined();
          const journal = await adapter.preload(workflowId, 'run-1');
          expect(journal.size).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('purge preserves every Secret_Store entry (conn# items)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.integer({ min: 1_000_000_000_000, max: 5_000_000_000_000 }),
        async (workflowId, connectionId, nowMs) => {
          const { adapter, table } = makeAdapter();

          // Seed a connection (secret) entry
          const connKey = { pk: pk(workflowId), sk: connSk(connectionId) };
          table.seed(connKey, { connectionId, secretsPresent: true });

          // Seed other data
          await adapter.write(workflowId, { spec: {} as any, savedAt: new Date(nowMs).toISOString() });
          await adapter.acquire(workflowId, 'runner-1', nowMs);

          // Purge
          await adapter.purge(workflowId);

          // Connection entry is preserved
          const connItem = table.getItem(connKey);
          expect(connItem).not.toBeNull();
          expect(connItem!['connectionId']).toBe(connectionId);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('a repeat purge answers with zero counts (idempotent)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.integer({ min: 1_000_000_000_000, max: 5_000_000_000_000 }),
        async (workflowId, nowMs) => {
          const { adapter } = makeAdapter();

          // Seed and purge
          await adapter.write(workflowId, { spec: {} as any, savedAt: new Date(nowMs).toISOString() });
          await adapter.acquire(workflowId, 'runner-1', nowMs);
          await adapter.purge(workflowId);

          // Second purge - all zeros
          const counts = await adapter.purge(workflowId);
          expect(counts.spec).toBe(0);
          expect(counts.journal).toBe(0);
          expect(counts.runs).toBe(0);
          expect(counts.events).toBe(0);
          expect(counts.usage).toBe(0);
          expect(counts.state).toBe(0);
          expect(counts.lease).toBe(0);
          expect(counts.failed).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Property 15: compareAndSet has exactly one winner and no effect when it loses
// ─────────────────────────────────────────────────────────────────────────────

describe('run-table - Property 15: compareAndSet has exactly one winner and no effect when it loses', () => {
  it('concurrent callers yield exactly one winner', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.integer({ min: 2, max: 100 }),
        fc.integer({ min: 1_000_000_000_000, max: 5_000_000_000_000 }),
        async (workflowId, key, callerCount, nowMs) => {
          const { adapter } = makeAdapter();
          const store = adapter.createStateStore(workflowId, () => nowMs);

          // All callers try to CAS from undefined to their own value
          const results: boolean[] = [];
          for (let i = 0; i < callerCount; i++) {
            const won = await store.compareAndSet(key, undefined, `value-${i}`);
            results.push(won);
          }

          // Exactly one wins (Req 5.2)
          const winners = results.filter(r => r === true);
          expect(winners).toHaveLength(1);

          // The stored value matches the winner
          const entry = await store.get(key);
          expect(entry).not.toBeUndefined();
          const winnerIndex = results.indexOf(true);
          expect(entry!.value).toBe(`value-${winnerIndex}`);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('a loser does not modify the stored value (Req 5.3)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.integer({ min: 1_000_000_000_000, max: 5_000_000_000_000 }),
        async (workflowId, key, initialValue, loserValue, nowMs) => {
          const { adapter } = makeAdapter();
          const store = adapter.createStateStore(workflowId, () => nowMs);

          // Set initial value
          await store.set(key, initialValue);

          // Loser tries CAS with wrong expected value
          const won = await store.compareAndSet(key, 'wrong-expected', loserValue);
          expect(won).toBe(false);

          // Value is unchanged
          const entry = await store.get(key);
          expect(entry!.value).toBe(initialValue);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 16: The state store honours its bounds, scoping and expiry semantics
// ─────────────────────────────────────────────────────────────────────────────

describe('run-table - Property 16: State store bounds, scoping and expiry semantics', () => {
  it('rejects a value over 32,768 UTF-8 bytes (Req 5.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.integer({ min: 1_000_000_000_000, max: 5_000_000_000_000 }),
        async (workflowId, key, nowMs) => {
          const { adapter } = makeAdapter();
          const store = adapter.createStateStore(workflowId, () => nowMs);

          // A value at exactly 32,769 bytes (over cap)
          const overCapValue = 'a'.repeat(32_769);
          let threw = false;
          try {
            await store.set(key, overCapValue);
          } catch (e) {
            threw = true;
            expect((e as Error).message).toContain(key);
            expect((e as Error).message).toContain('32768');
          }
          expect(threw).toBe(true);

          // The key was not written
          const entry = await store.get(key);
          expect(entry).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('a value at exactly 32,768 bytes is accepted (Req 5.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.integer({ min: 1_000_000_000_000, max: 5_000_000_000_000 }),
        async (workflowId, key, nowMs) => {
          const { adapter } = makeAdapter();
          const store = adapter.createStateStore(workflowId, () => nowMs);

          // Exactly at the cap (ASCII = 1 byte per char)
          const atCapValue = 'a'.repeat(32_768);
          await store.set(key, atCapValue);

          const entry = await store.get(key);
          expect(entry).not.toBeUndefined();
          expect(entry!.value).toBe(atCapValue);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('an expired entry is treated as absent on get (Req 5.6)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.integer({ min: 1_000_000_000_000, max: 5_000_000_000_000 }),
        async (workflowId, key, value, startMs) => {
          const { adapter } = makeAdapter();
          let clock = startMs;
          const store = adapter.createStateStore(workflowId, () => clock);

          // Set with a 10 second TTL
          await store.set(key, value, { ttlSec: 10 });

          // Before expiry, it's present
          const before = await store.get(key);
          expect(before).not.toBeUndefined();
          expect(before!.value).toBe(value);

          // Advance clock past expiry
          clock = startMs + 11_000;
          const after = await store.get(key);
          expect(after).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('list clamps limit to 1-1000 and filters by prefix (Req 5.4)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.integer({ min: 1_000_000_000_000, max: 5_000_000_000_000 }),
        async (workflowId, nowMs) => {
          const { adapter } = makeAdapter();
          const store = adapter.createStateStore(workflowId, () => nowMs);

          // Write keys with different prefixes
          await store.set('alpha:one', 'v1');
          await store.set('alpha:two', 'v2');
          await store.set('beta:one', 'v3');

          // List with prefix 'alpha:' returns only alpha keys
          const alphaEntries = await store.list('alpha:');
          expect(alphaEntries.every(e => e.key.startsWith('alpha:'))).toBe(true);
          expect(alphaEntries.length).toBe(2);

          // List with limit 1 returns at most 1
          const limited = await store.list('alpha:', 1);
          expect(limited.length).toBeLessThanOrEqual(1);

          // List with limit 0 or negative clamps to 1
          const clampedLow = await store.list('alpha:', 0);
          expect(clampedLow.length).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('expired entries are excluded from list (Req 5.9)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.integer({ min: 1_000_000_000_000, max: 5_000_000_000_000 }),
        async (workflowId, startMs) => {
          const { adapter } = makeAdapter();
          let clock = startMs;
          const store = adapter.createStateStore(workflowId, () => clock);

          // Write two entries, one with short TTL
          await store.set('keep', 'v1');
          await store.set('expire', 'v2', { ttlSec: 5 });

          // Before expiry, both present
          const before = await store.list('');
          expect(before.length).toBe(2);

          // Advance clock past the TTL
          clock = startMs + 6_000;
          const after = await store.list('');
          expect(after.length).toBe(1);
          expect(after[0].key).toBe('keep');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('compareAndSet treats an expired entry as absent for the expected comparison', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.integer({ min: 1_000_000_000_000, max: 5_000_000_000_000 }),
        async (workflowId, key, startMs) => {
          const { adapter } = makeAdapter();
          let clock = startMs;
          const store = adapter.createStateStore(workflowId, () => clock);

          // Set with short TTL
          await store.set(key, 'old-value', { ttlSec: 5 });

          // Advance clock past expiry
          clock = startMs + 6_000;

          // CAS with expected=undefined should succeed (entry is treated as absent)
          const won = await store.compareAndSet(key, undefined, 'new-value');
          expect(won).toBe(true);

          const entry = await store.get(key);
          expect(entry!.value).toBe('new-value');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('delete is non-erroring for unknown key', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.integer({ min: 1_000_000_000_000, max: 5_000_000_000_000 }),
        async (workflowId, key, nowMs) => {
          const { adapter } = makeAdapter();
          const store = adapter.createStateStore(workflowId, () => nowMs);

          // Deleting a key that doesn't exist should not throw
          await store.delete(key);
          // And the key should still not exist
          const entry = await store.get(key);
          expect(entry).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 8: Every run-scoped write is fenced
// ─────────────────────────────────────────────────────────────────────────────

// Feature: aws-byo-deploy, Property 8: Every run-scoped write is fenced

/** The recorded operations that change stored items. Reads are excluded. */
const WRITE_OPERATIONS: ReadonlySet<RecordedRequest['operation']> = new Set([
  'PutItem',
  'UpdateItem',
  'DeleteItem',
  'BatchWriteItem',
  'TransactWriteItems',
]);

/**
 * Every run-scoped operation `RunTableAdapter` exposes. The lease protocol
 * (`acquire`, `heartbeat`, `release`) and `purge` are deliberately absent: they
 * are the two documented exceptions to the fencing invariant, pinned by the
 * example test below rather than permitted by the property.
 */
const RUN_SCOPED_OPS = [
  'spec.write',
  'spec.delete',
  'journal.record',
  'journal.deleteRun',
  'journal.deleteOtherRuns',
  'run.upsert',
  'run.deleteAll',
  'event.write',
  'event.deleteAll',
  'usage.write',
  'usage.deleteAll',
  'state.set',
  'state.setWithTtl',
  'state.delete',
  'state.compareAndSet',
] as const;

type RunScopedOp = (typeof RUN_SCOPED_OPS)[number];

interface OpContext {
  adapter: RunTableAdapter;
  store: ReturnType<RunTableAdapter['createStateStore']>;
  workflowId: string;
  runId: string;
  otherRunId: string;
  nowMs: number;
  stateKey: string;
}

async function applyRunScopedOp(op: RunScopedOp, ctx: OpContext): Promise<void> {
  const { adapter, store, workflowId, runId, otherRunId, nowMs, stateKey } = ctx;
  switch (op) {
    case 'spec.write':
      return adapter.write(workflowId, {
        spec: {} as any,
        savedAt: new Date(nowMs).toISOString(),
      });
    case 'spec.delete':
      return adapter.delete(workflowId);
    case 'journal.record':
      return adapter.record(workflowId, runId, `node-${nowMs % 5}`, { output: 'x' } as any);
    case 'journal.deleteRun':
      return adapter.deleteRun(workflowId, runId);
    case 'journal.deleteOtherRuns':
      return adapter.deleteOtherRuns(workflowId, runId);
    case 'run.upsert':
      return adapter.upsert(workflowId, makeRunRecord(otherRunId, nowMs) as any);
    case 'run.deleteAll':
      await adapter.deleteAll(workflowId);
      return;
    case 'event.write':
      return adapter.writeEvent(workflowId, runId, nowMs % 97, { type: 'node-completed' } as any);
    case 'event.deleteAll':
      await adapter.deleteAllEvents(workflowId);
      return;
    case 'usage.write':
      return adapter.writeUsage(
        workflowId,
        makeUsageEntry(runId, `node-${nowMs % 3}`, nowMs) as any,
      );
    case 'usage.deleteAll':
      await adapter.deleteAllUsage(workflowId);
      return;
    case 'state.set':
      return store.set(stateKey, 'value');
    case 'state.setWithTtl':
      return store.set(stateKey, 'value', { ttlSec: 60 });
    case 'state.delete':
      return store.delete(stateKey);
    case 'state.compareAndSet':
      await store.compareAndSet(stateKey, undefined, 'cas-value');
      return;
  }
}

/**
 * Assert one recorded write is a fenced transaction: item 0 is the
 * `ConditionCheck` on `{ pk: 'wf#{workflowId}', sk: 'lease' }` asserting
 * equality with the held fencing token, and every remaining item writes the
 * same partition without touching the lease item.
 */
function assertFencedTransact(request: RecordedRequest, workflowId: string, fence: number): void {
  expect(request.operation, `an unfenced ${request.operation} reached Run_Table`).toBe(
    'TransactWriteItems',
  );

  const items = (request.input as TransactWriteCommandInput).TransactItems ?? [];
  expect(items.length).toBeGreaterThanOrEqual(2);

  const check = items[0].ConditionCheck;
  expect(check, 'item 0 of a fenced transaction is the lease ConditionCheck').toBeDefined();
  expect(check!.Key).toEqual({ pk: pk(workflowId), sk: leaseSk() });

  // Resolve the placeholders rather than matching a rendered string: the check
  // has to compare the `fence` attribute with the held token, by value.
  const names = check!.ExpressionAttributeNames ?? {};
  const values = check!.ExpressionAttributeValues ?? {};
  const match = /^(#\S+) = (:\S+)$/.exec(check!.ConditionExpression ?? '');
  expect(match, `unexpected lease condition '${check!.ConditionExpression}'`).not.toBeNull();
  expect(names[match![1]]).toBe('fence');
  expect(values[match![2]]).toBe(fence);

  for (const item of items.slice(1)) {
    const key = (item.Put?.Item ?? item.Delete?.Key ?? item.Update?.Key) as
      | Record<string, unknown>
      | undefined;
    expect(key, 'a fenced transaction item must be a Put, Delete or Update').toBeDefined();
    expect(key!['pk']).toBe(pk(workflowId));
    expect(key!['sk']).not.toBe(leaseSk());
  }
}

/** An id that cannot collide with the `#` separator of the key scheme. */
const idArb = fc.string({ minLength: 1, maxLength: 16 }).map((raw) => raw.replace(/#/g, '_'));

describe('run-table - Property 8: Every run-scoped write is fenced', () => {
  it('every write recorded while a lease is held is a fenced TransactWriteItems', async () => {
    await fc.assert(
      fc.asyncProperty(
        idArb,
        idArb,
        idArb,
        idArb,
        fc.integer({ min: 1_000_000_000_000, max: 5_000_000_000_000 }),
        fc.integer({ min: 0, max: 30 }),
        fc.array(fc.constantFrom(...RUN_SCOPED_OPS), { minLength: 1, maxLength: 10 }),
        async (workflowId, runId, otherRunId, stateKey, nowMs, extraJournalEntries, ops) => {
          const { adapter, client } = makeAdapter();

          // The lease acquire is a conditional UpdateItem - DynamoDB forces it.
          // Everything recorded after it is a data write that must be fenced.
          const outcome = await adapter.acquire(workflowId, 'runner-1', nowMs);
          expect(outcome.granted).toBe(true);
          const fence = outcome.granted ? outcome.lease.fence : 0;
          const startIndex = client.requests.length;

          const store = adapter.createStateStore(workflowId, () => nowMs);
          const ctx: OpContext = { adapter, store, workflowId, runId, otherRunId, nowMs, stateKey };

          // Seed one item per category so the delete paths have work to do, and
          // enough journal entries to cross the 24-deletes-per-transaction
          // chunk boundary.
          await adapter.write(workflowId, {
            spec: {} as any,
            savedAt: new Date(nowMs).toISOString(),
          });
          for (let i = 0; i < extraJournalEntries; i++) {
            await adapter.record(workflowId, runId, `seed-${i}`, { output: 'x' } as any);
          }
          await adapter.record(workflowId, otherRunId, 'seed', { output: 'x' } as any);
          await adapter.upsert(workflowId, makeRunRecord(runId, nowMs) as any);
          await adapter.writeEvent(workflowId, runId, 1, { type: 'node-completed' } as any);
          await adapter.writeUsage(workflowId, makeUsageEntry(runId, 'node-1', nowMs) as any);
          await store.set(stateKey, 'seed');

          for (const op of ops) {
            await applyRunScopedOp(op, ctx);
          }

          const writes = client.requests
            .slice(startIndex)
            .filter((request) => WRITE_OPERATIONS.has(request.operation));

          // The seeding phase alone writes, so the property is never vacuous.
          expect(writes.length).toBeGreaterThan(0);
          for (const write of writes) {
            assertFencedTransact(write, workflowId, fence);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('the only unfenced writes are the lease protocol and the purge lease delete', async () => {
    const { adapter, client } = makeAdapter();
    const workflowId = 'wf-exceptions';
    const nowMs = 1_700_000_000_000;

    const outcome = await adapter.acquire(workflowId, 'runner-1', nowMs);
    expect(outcome.granted).toBe(true);
    const lease = outcome.granted ? outcome.lease : undefined;
    expect(lease).toBeDefined();

    // The lease protocol: a conditional UpdateItem on the lease item, never a
    // transaction. DynamoDB cannot express it any other way.
    await adapter.heartbeat(lease!, nowMs + 1_000);
    const protocolWrites = client.requests.filter((request) =>
      WRITE_OPERATIONS.has(request.operation),
    );
    expect(protocolWrites.map((request) => request.operation)).toEqual(['UpdateItem', 'UpdateItem']);

    // The purge path: every data delete stays fenced, and the single unfenced
    // write is the lease delete, which a transaction cannot both check and
    // perform on the same item.
    await adapter.write(workflowId, { spec: {} as any, savedAt: new Date(nowMs).toISOString() });
    await adapter.record(workflowId, 'run-1', 'node-1', { output: 'x' } as any);
    client.requests.length = 0;
    await adapter.purge(workflowId);

    const purgeWrites = client.requests.filter((request) =>
      WRITE_OPERATIONS.has(request.operation),
    );
    const unfenced = purgeWrites.filter((request) => request.operation !== 'TransactWriteItems');
    expect(unfenced).toHaveLength(1);
    expect(unfenced[0].operation).toBe('DeleteItem');
    expect((unfenced[0].input as { Key: Record<string, unknown> }).Key).toEqual({
      pk: pk(workflowId),
      sk: leaseSk(),
    });
    for (const write of purgeWrites.filter(
      (request) => request.operation === 'TransactWriteItems',
    )) {
      assertFencedTransact(write, workflowId, lease!.fence);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 11: Every read is partition-scoped
// ─────────────────────────────────────────────────────────────────────────────

// Feature: aws-byo-deploy, Property 11: Every read is partition-scoped

/**
 * Every read path `RunTableAdapter` exposes. `purge.enumerate` is here for its
 * key enumeration: the deletes it performs are Property 8's business, but the
 * `Query` per category that finds the keys is a read like any other.
 */
const READ_OPS = [
  'spec.read',
  'journal.preload',
  'run.list',
  'run.get',
  'event.list',
  'usage.list',
  'state.get',
  'state.list',
  'state.compareAndSet',
  'purge.enumerate',
] as const;

type ReadOp = (typeof READ_OPS)[number];

async function applyReadOp(op: ReadOp, ctx: OpContext): Promise<void> {
  const { adapter, store, workflowId, runId, stateKey } = ctx;
  switch (op) {
    case 'spec.read':
      await adapter.read(workflowId);
      return;
    case 'journal.preload':
      await adapter.preload(workflowId, runId);
      return;
    case 'run.list':
      await adapter.list(workflowId);
      return;
    case 'run.get':
      await adapter.get(workflowId, runId);
      return;
    case 'event.list':
      await adapter.listEvents(workflowId, runId);
      return;
    case 'usage.list':
      await adapter.listUsage(workflowId, new Date(0).toISOString());
      return;
    case 'state.get':
      await store.get(stateKey);
      return;
    case 'state.list':
      await store.list('');
      return;
    case 'state.compareAndSet':
      await store.compareAndSet(stateKey, undefined, 'cas-value');
      return;
    case 'purge.enumerate':
      await adapter.purge(workflowId);
      return;
  }
}

/** The partition key attribute and value a read must fix, per index. */
function partitionKeyOf(
  indexName: string | undefined,
  workflowId: string,
): { attr: string; value: string } {
  switch (indexName) {
    case undefined:
      return { attr: 'pk', value: pk(workflowId) };
    case 'GSI1':
      return { attr: 'gsi1pk', value: gsi1pk(workflowId) };
    case 'GSI2':
      return { attr: 'gsi2pk', value: gsi2pk(workflowId) };
    default:
      throw new Error(`Property 11: unknown index '${indexName}'`);
  }
}

/**
 * The equality terms of a `KeyConditionExpression`, with the `#name` and
 * `:value` placeholders resolved. A `begins_with(...)` term is not an equality
 * term and is deliberately not reported: it narrows the sort key, it cannot
 * name a partition.
 */
function keyEqualityTerms(input: QueryCommandInput): Map<string, unknown> {
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};
  const terms = new Map<string, unknown>();

  for (const clause of (input.KeyConditionExpression ?? '').split(/\bAND\b/)) {
    const match = /^\s*(#?[A-Za-z0-9_.-]+)\s*=\s*(:[A-Za-z0-9_]+)\s*$/.exec(clause);
    if (!match) continue;
    const attr = match[1].startsWith('#') ? names[match[1]] : match[1];
    if (attr === undefined) continue;
    terms.set(attr, values[match[2]]);
  }

  return terms;
}

/**
 * Assert one recorded read addresses a single partition: a `GetItem` names its
 * `pk`, a `Query` fixes the partition key attribute of the table or index it
 * reads with `=` against the workflow's partition value, and nothing else
 * counts as a read at all.
 */
function assertPartitionScopedRead(request: RecordedRequest, workflowId: string): void {
  expect(
    ['GetItem', 'Query'],
    `a ${request.operation} is not a partition-scoped read`,
  ).toContain(request.operation);

  if (request.operation === 'GetItem') {
    const key = (request.input as GetCommandInput).Key as Record<string, unknown> | undefined;
    expect(key, 'a GetItem must carry a Key').toBeDefined();
    expect(key!['pk'], 'a GetItem must name its partition key value').toBe(pk(workflowId));
    return;
  }

  const input = request.input as QueryCommandInput;
  // An unbounded read: without a key condition a Query degenerates into a scan.
  expect(
    input.KeyConditionExpression,
    'a Query without a KeyConditionExpression reads the whole table',
  ).toBeDefined();

  const { attr, value } = partitionKeyOf(input.IndexName, workflowId);
  const terms = keyEqualityTerms(input);
  const where = input.IndexName ?? 'the base table';
  expect(
    terms.has(attr),
    `a Query on ${where} must fix '${attr}' with '=', found '${input.KeyConditionExpression}'`,
  ).toBe(true);
  expect(terms.get(attr), `the '${attr}' value must be the workflow's partition`).toBe(value);
}

describe('run-table - Property 11: Every read is partition-scoped', () => {
  it('every read recorded for any sequence of read operations names one partition', async () => {
    await fc.assert(
      fc.asyncProperty(
        idArb,
        idArb,
        idArb,
        idArb,
        fc.integer({ min: 1_000_000_000_000, max: 5_000_000_000_000 }),
        fc.array(fc.constantFrom(...READ_OPS), { minLength: 1, maxLength: 10 }),
        async (workflowId, runId, otherRunId, stateKey, nowMs, ops) => {
          const { adapter, client, table } = makeAdapter();
          const store = adapter.createStateStore(workflowId, () => nowMs);
          const ctx: OpContext = { adapter, store, workflowId, runId, otherRunId, nowMs, stateKey };

          // Seed one item per category so every read path has something to find.
          await adapter.write(workflowId, {
            spec: {} as any,
            savedAt: new Date(nowMs).toISOString(),
          });
          await adapter.record(workflowId, runId, 'node-1', { output: 'x' } as any);
          await adapter.upsert(workflowId, makeRunRecord(runId, nowMs) as any);
          await adapter.upsert(workflowId, makeRunRecord(otherRunId, nowMs + 1) as any);
          await adapter.writeEvent(workflowId, runId, 1, { type: 'node-completed' } as any);
          await adapter.writeUsage(workflowId, makeUsageEntry(runId, 'node-1', nowMs) as any);
          await store.set(stateKey, 'seed');

          // Only the operations under test are measured: the seeding phase is
          // writes, which Property 8 owns.
          const startIndex = client.requests.length;
          const logIndex = table.log.length;

          for (const op of ops) {
            await applyReadOp(op, ctx);
          }

          const reads = client.requests
            .slice(startIndex)
            .filter((request) => !WRITE_OPERATIONS.has(request.operation));

          // Every op in READ_OPS reads at least once, so this never passes by
          // reading nothing.
          expect(reads.length).toBeGreaterThan(0);
          for (const read of reads) {
            assertPartitionScopedRead(read, workflowId);
          }

          // The fake's own log agrees: no whole-table read reached the table,
          // and every read it recorded named a partition key value.
          for (const entry of table.log.slice(logIndex)) {
            expect(entry.operation, 'a Scan reached Run_Table').not.toBe('Scan');
            if (entry.operation !== 'GetItem' && entry.operation !== 'Query') continue;
            const key = entry.key as { pk: string };
            expect(key.pk.length, 'a read reached Run_Table without a partition key').toBeGreaterThan(
              0,
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('the read paths cover GetItem, a base-table Query and both index Queries', async () => {
    const { adapter, client } = makeAdapter();
    const workflowId = 'wf-reads';
    const runId = 'run-1';
    const nowMs = 1_700_000_000_000;
    const store = adapter.createStateStore(workflowId, () => nowMs);
    const ctx: OpContext = {
      adapter,
      store,
      workflowId,
      runId,
      otherRunId: 'run-2',
      nowMs,
      stateKey: 'k',
    };

    client.requests.length = 0;
    for (const op of READ_OPS) {
      await applyReadOp(op, ctx);
    }

    const reads = client.requests.filter((request) => !WRITE_OPERATIONS.has(request.operation));
    const shapes = new Set(
      reads.map((request) =>
        request.operation === 'Query'
          ? `Query:${(request.input as QueryCommandInput).IndexName ?? 'base'}`
          : request.operation,
      ),
    );

    expect([...shapes].sort()).toEqual(['GetItem', 'Query:GSI1', 'Query:GSI2', 'Query:base']);
    for (const read of reads) {
      assertPartitionScopedRead(read, workflowId);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 27: Run history is descending by start time
// ─────────────────────────────────────────────────────────────────────────────

// Feature: aws-byo-deploy, Property 27: Run history is descending by start time

/** The history page size `RunTableAdapter.list` reads (Req 4.3). */
const HISTORY_PAGE = 100;

/** Enough records to cross the page boundary in a good share of examples. */
const MAX_HISTORY_RECORDS = 250;

/** Start times cluster into this many slots, so collisions are the common case. */
const START_TIME_SLOTS = 24;

const HISTORY_BASE_MS = 1_700_000_000_000;

/**
 * A start time that either lands in a small pool - so a run of records collides
 * repeatedly, which is the interesting half of the ordering - or anywhere in the
 * 13-digit epoch-millisecond range `gsi1sk` zero-pads.
 */
const startedAtArb = fc.oneof(
  {
    weight: 3,
    arbitrary: fc
      .integer({ min: 0, max: START_TIME_SLOTS - 1 })
      .map((slot) => HISTORY_BASE_MS + slot * 1000),
  },
  { weight: 1, arbitrary: fc.integer({ min: 1_000_000_000_000, max: 5_000_000_000_000 }) },
);

/**
 * A run id over `[a-z0-9]`. The alphabet is deliberately narrow: the tie-break
 * on equal start times is a comparison of the run id inside `gsi1sk`, and over
 * plain lowercase alphanumerics that comparison is the same whether it is done
 * by code point or by collation, so the expected order below is unambiguous.
 */
const runIdTokenArb = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
    minLength: 0,
    maxLength: 6,
  })
  .map((chars) => chars.join(''));

/**
 * The generated history: one record per element, with a distinct run id. The
 * index is zero-padded to a fixed width and prefixed, so uniqueness is by
 * construction while the suffix still varies the tie-break comparison.
 */
const historyArb = fc
  .array(fc.record({ token: runIdTokenArb, startedAt: startedAtArb }), {
    minLength: 1,
    maxLength: MAX_HISTORY_RECORDS,
    // Without `size: 'max'` fast-check keeps arrays around a dozen elements and
    // the 100-per-page boundary is never reached, which would leave the
    // cross-page half of the property untested. This puts the median above one
    // page.
    size: 'max',
  })
  .map((rows) =>
    rows.map((row, index) => ({
      runId: `${String(index).padStart(3, '0')}${row.token}`,
      startedAt: row.startedAt,
    })),
  );

/**
 * The order GSI1 defines: descending on `gsi1sk`, which is the zero-padded
 * start time followed by the run id. Derived from `gsi1sk` itself rather than
 * assuming how a tie on start time resolves.
 */
function expectedHistoryOrder(records: readonly { runId: string; startedAt: number }[]): string[] {
  return [...records]
    .sort((a, b) => {
      const left = gsi1sk(a.startedAt, a.runId);
      const right = gsi1sk(b.startedAt, b.runId);
      return left < right ? 1 : left > right ? -1 : 0;
    })
    .map((record) => record.runId);
}

/** Page the history read to exhaustion, returning the concatenated summaries. */
async function readAllHistory(
  adapter: RunTableAdapter,
  workflowId: string,
  expectedCount: number,
): Promise<RunRecordSummary[]> {
  const summaries: RunRecordSummary[] = [];
  const maxPages = Math.ceil(expectedCount / HISTORY_PAGE) + 1;
  let token: string | undefined;
  let pages = 0;

  do {
    const page = await adapter.list(workflowId, token);
    pages++;
    expect(pages, 'the history read did not terminate').toBeLessThanOrEqual(maxPages);
    expect(page.items.length, 'a history page exceeded the page size').toBeLessThanOrEqual(
      HISTORY_PAGE,
    );
    summaries.push(...page.items);
    token = page.continuationToken;
  } while (token !== undefined);

  return summaries;
}

describe('run-table - Property 27: Run history is descending by start time', () => {
  it('paging the history yields every record once, non-increasing by start time', async () => {
    await fc.assert(
      fc.asyncProperty(idArb, historyArb, async (workflowId, records) => {
        const { adapter } = makeAdapter();

        for (const record of records) {
          await adapter.upsert(workflowId, makeRunRecord(record.runId, record.startedAt) as any);
        }

        const summaries = await readAllHistory(adapter, workflowId, records.length);
        const ids = summaries.map((summary) => summary.id);

        // Non-increasing by start time, across every page boundary.
        for (let i = 1; i < summaries.length; i++) {
          expect(
            summaries[i].startedAt as number,
            `run history rose at position ${i}`,
          ).toBeLessThanOrEqual(summaries[i - 1].startedAt as number);
        }

        // Nothing repeated, nothing skipped.
        expect(new Set(ids).size, 'a run record was served twice').toBe(ids.length);
        expect(new Set(ids)).toEqual(new Set(records.map((record) => record.runId)));

        // And the full order is GSI1's own, tie-break included.
        expect(ids).toEqual(expectedHistoryOrder(records));
      }),
      { numRuns: 100 },
    );
  });

  it('a page boundary is actually crossed by a history longer than one page', async () => {
    const { adapter } = makeAdapter();
    const workflowId = 'wf-history';
    const records = Array.from({ length: HISTORY_PAGE * 2 + 7 }, (_, index) => ({
      runId: `run-${String(index).padStart(3, '0')}`,
      // Only three distinct start times, so most neighbours are ties.
      startedAt: HISTORY_BASE_MS + (index % 3) * 1000,
    }));

    for (const record of records) {
      await adapter.upsert(workflowId, makeRunRecord(record.runId, record.startedAt) as any);
    }

    const summaries = await readAllHistory(adapter, workflowId, records.length);
    expect(summaries).toHaveLength(records.length);
    expect(summaries.map((summary) => summary.id)).toEqual(expectedHistoryOrder(records));
  });
});
