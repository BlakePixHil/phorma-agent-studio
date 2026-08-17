/**
 * Property test for the contended trigger path.
 *
 * Property 5: A contended trigger starts no run and records exactly one skip.
 * Validates: Requirements 2.7, 4.16, 6.4, 7.8
 *
 * When a trigger fires but the Execution_Lease is already held by another
 * Runner, the trigger route:
 * - Does NOT start a run (lease acquisition fails)
 * - Writes exactly one unfenced skip record carrying the workflow id, trigger
 *   source and the holding Fencing_Token
 * - Produces zero usage ledger entries for the skipped run id
 *
 * The test covers all four trigger sources: schedule fire, webhook, manual
 * call and monitor trigger frame.
 *
 * Property 9: The losing Runner writes exactly one unfenced record.
 * Validates: Requirements 8.5, 15.6
 *
 * Property 5 models the contention path; Property 9 drives the real
 * `handleTrigger` handler over the `DocumentTableClient` port and asserts on the
 * verbatim command inputs it sends - exactly one write, and that write is an
 * unfenced `PutItem`.
 *
 * Feature: aws-deployment-target, aws-byo-deploy
 * Requirements: 2.7, 4.16, 6.4, 7.8, 8.5, 15.6
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { PutCommandInput } from '@aws-sdk/lib-dynamodb';
import { FakeRunTable } from '../test/fake-run-table.js';
import { FakeDocumentTableClient, type RecordedRequest } from '../test/fake-document-table-client.js';
import { RunTableAdapter } from '../aws/run-table.js';
import { pk, leaseSk, skipSk, usageSk } from '../core/keys.js';
import { acquireWrite, LEASE_TTL_MS } from '../core/lease.js';
import { handleTrigger, type RouteResult, type TriggerRouteDeps } from './trigger-routes.js';

// ---------------------------------------------------------------------------
// Trigger sources the property must cover (Req 2.7, 6.4, 7.8)
// ---------------------------------------------------------------------------

/** The four trigger source types that can fire against an occupied workflow. */
const TRIGGER_SOURCES = ['schedule', 'webhook', 'manual', 'monitor'] as const;
type TriggerSource = (typeof TRIGGER_SOURCES)[number];

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

function workflowIdArb(): fc.Arbitrary<string> {
  return fc.string({ minLength: 4, maxLength: 32 }).filter(s => /^[A-Za-z0-9_-]+$/.test(s));
}

function runIdArb(): fc.Arbitrary<string> {
  return fc.string({ minLength: 4, maxLength: 32 }).filter(s => /^[A-Za-z0-9_-]+$/.test(s));
}

function runnerIdArb(): fc.Arbitrary<string> {
  return fc.string({ minLength: 2, maxLength: 16 }).filter(s => /^[A-Za-z0-9_-]+$/.test(s));
}

function triggerSourceArb(): fc.Arbitrary<TriggerSource> {
  return fc.constantFrom(...TRIGGER_SOURCES);
}

function timestampArb(): fc.Arbitrary<number> {
  return fc.integer({ min: 1_700_000_000_000, max: 2_000_000_000_000 });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The Run_Table name every command input must name. */
const TABLE_NAME = 'phorma-run-table';

/** The Run_Table adapter over the DocumentTableClient port. */
function makeAdapter(table: FakeRunTable): RunTableAdapter {
  return new RunTableAdapter(
    new FakeDocumentTableClient(table, { tableName: TABLE_NAME }),
    TABLE_NAME,
  );
}

/**
 * Seed the FakeRunTable with an unexpired lease for the given workflow,
 * simulating a Runner that is currently executing a run.
 */
function seedHeldLease(
  table: FakeRunTable,
  workflowId: string,
  holdingRunnerId: string,
  holdingFence: number,
  nowMs: number,
): void {
  table.seed(
    { pk: pk(workflowId), sk: leaseSk() },
    {
      pk: pk(workflowId),
      sk: leaseSk(),
      fence: holdingFence,
      expiresAtMs: nowMs + LEASE_TTL_MS, // unexpired
      runnerId: holdingRunnerId,
      workflowId,
    },
  );
}

/**
 * Simulate what the trigger route does on lease contention:
 * write one unfenced skip record. The skip record is NOT fenced because the
 * triggering Runner does not hold the lease - it is the one exception to
 * the fenced-write rule (Req 2.5).
 */
function writeSkipRecord(
  table: FakeRunTable,
  workflowId: string,
  runId: string,
  source: TriggerSource,
  holdingFence: number,
  atMs: number,
): void {
  table.putItem({
    key: { pk: pk(workflowId), sk: skipSk(atMs, runId) },
    item: {
      pk: pk(workflowId),
      sk: skipSk(atMs, runId),
      workflowId,
      runId,
      source,
      holdingFence,
      skippedAt: new Date(atMs).toISOString(),
    },
  });
}

/**
 * Count skip records for a workflow by querying items with the `skip#` prefix.
 */
function countSkipRecords(table: FakeRunTable, workflowId: string): number {
  const result = table.query({ pk: pk(workflowId), skPrefix: 'skip#', pageSize: 1000 });
  return result.items.length;
}

/**
 * Count usage ledger entries for a specific run id within a workflow.
 */
function countUsageLedgerEntries(table: FakeRunTable, workflowId: string, runId: string): number {
  const result = table.query({ pk: pk(workflowId), skPrefix: `usage#${runId}#`, pageSize: 1000 });
  return result.items.length;
}

// ---------------------------------------------------------------------------
// Property 5: A contended trigger starts no run and records exactly one skip
// ---------------------------------------------------------------------------

describe('trigger-routes - Property 5: A contended trigger starts no run and records exactly one skip', () => {
  /**
   * **Validates: Requirements 2.7, 4.16, 6.4, 7.8**
   *
   * For any trigger source and any unexpired Execution_Lease:
   * 1. The lease acquisition fails (trigger does not start a run)
   * 2. Exactly one skip record is written (unfenced)
   * 3. Zero usage ledger entries exist for the skipped run id
   */
  it('a contended trigger writes one skip, starts no run, and produces zero usage entries', async () => {
    await fc.assert(
      fc.asyncProperty(
        workflowIdArb(),
        runIdArb(),
        runnerIdArb(), // the contending runner
        runnerIdArb(), // the runner already holding the lease
        triggerSourceArb(),
        timestampArb(),
        fc.integer({ min: 1, max: 1000 }), // holdingFence
        async (workflowId, contendingRunId, contendingRunnerId, holdingRunnerId, source, nowMs, holdingFence) => {
          // Ensure the contending runner differs from the holding runner
          fc.pre(contendingRunnerId !== holdingRunnerId);

          const table = new FakeRunTable();

          // Seed an unexpired lease held by another runner
          seedHeldLease(table, workflowId, holdingRunnerId, holdingFence, nowMs);

          const adapter = makeAdapter(table);

          // ── Trigger fires: attempt lease acquisition ────────────────────
          const leaseResult = await adapter.acquire(workflowId, contendingRunnerId, nowMs);

          // Assertion 1: lease NOT granted (run does not start)
          expect(leaseResult.granted).toBe(false);
          if (!leaseResult.granted) {
            expect(leaseResult.holdingFence).toBe(holdingFence);
          }

          // ── Trigger route writes one unfenced skip record ───────────────
          writeSkipRecord(table, workflowId, contendingRunId, source, holdingFence, nowMs);

          // Assertion 2: exactly one skip record exists
          const skipCount = countSkipRecords(table, workflowId);
          expect(skipCount).toBe(1);

          // Verify the skip record carries correct fields
          const skipResult = table.query({ pk: pk(workflowId), skPrefix: 'skip#', pageSize: 10 });
          const skipItem = skipResult.items[0];
          expect(skipItem['workflowId']).toBe(workflowId);
          expect(skipItem['runId']).toBe(contendingRunId);
          expect(skipItem['source']).toBe(source);
          expect(skipItem['holdingFence']).toBe(holdingFence);

          // Assertion 3: zero usage ledger entries for the skipped run (Req 4.16)
          const usageCount = countUsageLedgerEntries(table, workflowId, contendingRunId);
          expect(usageCount).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('contention across all four trigger sources produces zero usage and one skip each', async () => {
    await fc.assert(
      fc.asyncProperty(
        workflowIdArb(),
        fc.array(runIdArb(), { minLength: 4, maxLength: 4 }),
        runnerIdArb(),
        runnerIdArb(),
        timestampArb(),
        fc.integer({ min: 1, max: 1000 }),
        async (workflowId, runIds, contendingRunnerId, holdingRunnerId, nowMs, holdingFence) => {
          fc.pre(contendingRunnerId !== holdingRunnerId);
          // Ensure all run ids are distinct
          fc.pre(new Set(runIds).size === 4);

          const table = new FakeRunTable();
          seedHeldLease(table, workflowId, holdingRunnerId, holdingFence, nowMs);
          const adapter = makeAdapter(table);

          // Fire all four trigger sources, each with its own run id
          for (let i = 0; i < TRIGGER_SOURCES.length; i++) {
            const source = TRIGGER_SOURCES[i];
            const runId = runIds[i];

            const leaseResult = await adapter.acquire(workflowId, contendingRunnerId, nowMs + i);
            expect(leaseResult.granted).toBe(false);

            writeSkipRecord(table, workflowId, runId, source, holdingFence, nowMs + i);

            // Zero usage for each skipped run
            const usageCount = countUsageLedgerEntries(table, workflowId, runId);
            expect(usageCount).toBe(0);
          }

          // Four skip records total (one per trigger source)
          const totalSkips = countSkipRecords(table, workflowId);
          expect(totalSkips).toBe(4);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9: The losing Runner writes exactly one unfenced record
//
// Property 5 above models the contention path; this one drives the real route
// handler, so the assertions are about what `handleTrigger` actually sends to
// the Run_Table port.
//
// Feature: aws-byo-deploy, Property 9: The losing Runner writes exactly one unfenced record
// Requirements: 8.5, 15.6
// ---------------------------------------------------------------------------

/** Every recorded operation that can mutate Run_Table. */
const WRITE_OPERATIONS = new Set<RecordedRequest['operation']>([
  'PutItem',
  'UpdateItem',
  'DeleteItem',
  'BatchWriteItem',
  'TransactWriteItems',
]);

/** The `{ pk, sk }` a recorded single-item command addresses. */
function addressOf(request: RecordedRequest): { pk?: unknown; sk?: unknown } {
  const input = request.input as Record<string, unknown>;
  const target = (input['Item'] ?? input['Key']) as Record<string, unknown> | undefined;
  return { pk: target?.['pk'], sk: target?.['sk'] };
}

/**
 * Every recorded write EXCEPT the lease conditional write itself.
 *
 * The acquire is a conditional `UpdateItem` on the lease item that stores
 * nothing when it loses, so it is not one of the run's writes. Everything else
 * a losing Runner sends counts, which is what makes "exactly one" measurable
 * rather than "the skip record is present".
 */
function runWritesOf(client: FakeDocumentTableClient): RecordedRequest[] {
  return client.requests.filter(
    request =>
      WRITE_OPERATIONS.has(request.operation) &&
      !(request.operation === 'UpdateItem' && addressOf(request).sk === leaseSk()),
  );
}

/** A port that must never be reached on the contention path. */
function unusedPort<T>(label: string): T {
  return new Proxy(
    {},
    {
      get(_target, property) {
        return () => {
          throw new Error(`${label}.${String(property)} must not be called on a contended trigger`);
        };
      },
    },
  ) as unknown as T;
}

/** One Runner contending for a workflow: its own client, its own clock. */
interface ContendingRunner {
  runnerId: string;
  nowMs: number;
  client: FakeDocumentTableClient;
  deps: TriggerRouteDeps;
}

/**
 * Build a Runner over a SHARED `FakeRunTable`. Each Runner gets its own
 * `FakeDocumentTableClient`, so `client.requests` attributes every Run_Table
 * operation to the Runner that issued it while both still contend for the same
 * stored lease item.
 */
function makeRunner(table: FakeRunTable, runnerId: string, nowMs: number): ContendingRunner {
  const client = new FakeDocumentTableClient(table, { tableName: TABLE_NAME });
  const adapter = new RunTableAdapter(client, TABLE_NAME);

  const deps: TriggerRouteDeps = {
    specStore: unusedPort('specStore'),
    leaseStore: adapter,
    runHistory: unusedPort('runHistory'),
    runEvents: unusedPort('runEvents'),
    usageLedger: unusedPort('usageLedger'),
    scheduleStore: unusedPort('scheduleStore'),
    secrets: unusedPort('secrets'),
    table: client,
    tableName: TABLE_NAME,
    purge: () => {
      throw new Error('purge must not be called on a contended trigger');
    },
    connections: new Map(),
    runnerId,
    now: () => nowMs,
  };

  return { runnerId, nowMs, client, deps };
}

/**
 * The whole of Property 9 for one losing Runner: exactly one write, that write
 * is the unfenced skip record, the response is 409, and nothing follows it.
 */
function assertLoser(
  loser: ContendingRunner,
  result: RouteResult,
  expected: { workflowId: string; runId: string; source: string; holdingFence: number },
): void {
  // 4. The response status is 409 (Req 2.7, 15.6)
  expect(result.status).toBe(409);
  const body = result.body as Record<string, unknown>;
  expect(body['workflowId']).toBe(expected.workflowId);
  expect(body['runId']).toBe(expected.runId);
  expect(body['source']).toBe(expected.source);
  expect(body['holdingFence']).toBe(expected.holdingFence);

  // 2. EXACTLY ONE write, counted over the recorded command inputs
  const writes = runWritesOf(loser.client);
  expect(writes.length).toBe(1);

  // 3. That write is the unfenced skip record: a bare PutItem, no condition,
  //    and never a fenced TransactWriteItems (Req 8.5)
  const write = writes[0];
  expect(write.operation).toBe('PutItem');
  const input = write.input as PutCommandInput;
  expect(input.TableName).toBe(TABLE_NAME);
  expect(input.ConditionExpression).toBeUndefined();
  expect(loser.client.requests.some(r => r.operation === 'TransactWriteItems')).toBe(false);

  const item = input.Item as Record<string, unknown>;
  expect(item['pk']).toBe(pk(expected.workflowId));
  expect(item['sk']).toBe(skipSk(loser.nowMs, loser.runnerId));
  expect(item['workflowId']).toBe(expected.workflowId);
  expect(item['runId']).toBe(expected.runId);
  expect(item['source']).toBe(expected.source);
  expect(item['runnerId']).toBe(loser.runnerId);
  expect(item['holdingFence']).toBe(expected.holdingFence);
  expect(item['triggeredAtMs']).toBe(loser.nowMs);

  // 5. No further Run_Table operation for that run - the skip record is last
  expect(loser.client.requests[loser.client.requests.length - 1]).toBe(write);
}

/** A clock skew that leaves the winner's lease unexpired, biased to include 0. */
function skewArb(): fc.Arbitrary<number> {
  return fc.oneof(
    fc.constant(0),
    fc.integer({ min: 0, max: LEASE_TTL_MS - 1 }),
  );
}

describe('trigger-routes - Property 9: The losing Runner writes exactly one unfenced record', () => {
  /**
   * **Validates: Requirements 8.5, 15.6**
   *
   * For ANY interleaving of two Runners contending for one workflow - either
   * call order, any runner ids, any workflow id, any trigger sources, and any
   * clock values inside one lease term including the same millisecond:
   *
   * 1. Exactly one Runner is granted the lease, exactly one loses.
   * 2. The loser writes exactly one Run_Table item.
   * 3. That item is the unfenced skip record.
   * 4. The loser's response status is 409.
   * 5. The loser performs no further Run_Table write for that run.
   */
  it('the loser writes exactly one unfenced skip record and answers 409, for any interleaving', async () => {
    await fc.assert(
      fc.asyncProperty(
        workflowIdArb(),
        runnerIdArb(),
        runnerIdArb(),
        runIdArb(),
        runIdArb(),
        triggerSourceArb(),
        triggerSourceArb(),
        timestampArb(),
        skewArb(),
        fc.boolean(), // which Runner calls first
        async (
          workflowId,
          runnerA,
          runnerB,
          runIdA,
          runIdB,
          sourceA,
          sourceB,
          baseMs,
          skew,
          aFirst,
        ) => {
          fc.pre(runnerA !== runnerB);

          const table = new FakeRunTable();

          // The interleaving: who calls first, and at which clock value
          const firstRunner = makeRunner(table, aFirst ? runnerA : runnerB, baseMs);
          const secondRunner = makeRunner(table, aFirst ? runnerB : runnerA, baseMs + skew);
          const firstReq = {
            workflowId,
            runId: aFirst ? runIdA : runIdB,
            source: aFirst ? sourceA : sourceB,
          };
          const secondReq = {
            workflowId,
            runId: aFirst ? runIdB : runIdA,
            source: aFirst ? sourceB : sourceA,
          };

          const firstResult = await handleTrigger(firstRunner.deps, firstReq);
          const secondResult = await handleTrigger(secondRunner.deps, secondReq);

          // 1. Exactly one winner, exactly one loser
          expect(firstResult.status).toBe(202);
          expect(secondResult.status).toBe(409);

          const winnerLease = (firstResult.body as { lease: { fence: number } }).lease;
          expect(winnerLease.fence).toBe(1);

          // 2-5. The loser's single unfenced write
          assertLoser(secondRunner, secondResult, { ...secondReq, holdingFence: 1 });

          // The winner made no run-scoped write on this route either, so the
          // partition holds exactly the lease item and one skip record.
          expect(runWritesOf(firstRunner.client).length).toBe(0);
          const stored = table.query({ pk: pk(workflowId), pageSize: 100 });
          expect(stored.items.map(item => item['sk'])).toEqual([
            leaseSk(),
            skipSk(secondRunner.nowMs, secondRunner.runnerId),
          ]);
          expect(countSkipRecords(table, workflowId)).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 8.5, 15.6**
   *
   * The skip sort key is `skip#{triggeredAtMs}#{runnerId}`, so two Runners
   * losing at the SAME millisecond are the collision case: each must still end
   * up with exactly one item of its own rather than overwriting the other.
   */
  it('two Runners losing at the same clock value each write exactly one distinct skip record', async () => {
    await fc.assert(
      fc.asyncProperty(
        workflowIdArb(),
        runnerIdArb(),
        runnerIdArb(),
        runnerIdArb(),
        runIdArb(),
        runIdArb(),
        triggerSourceArb(),
        triggerSourceArb(),
        timestampArb(),
        fc.integer({ min: 1, max: 1000 }),
        async (
          workflowId,
          holdingRunnerId,
          loserA,
          loserB,
          runIdA,
          runIdB,
          sourceA,
          sourceB,
          nowMs,
          holdingFence,
        ) => {
          fc.pre(new Set([holdingRunnerId, loserA, loserB]).size === 3);

          const table = new FakeRunTable();
          seedHeldLease(table, workflowId, holdingRunnerId, holdingFence, nowMs);

          // Both contenders read the same clock
          const first = makeRunner(table, loserA, nowMs);
          const second = makeRunner(table, loserB, nowMs);
          const firstReq = { workflowId, runId: runIdA, source: sourceA };
          const secondReq = { workflowId, runId: runIdB, source: sourceB };

          const firstResult = await handleTrigger(first.deps, firstReq);
          const secondResult = await handleTrigger(second.deps, secondReq);

          assertLoser(first, firstResult, { ...firstReq, holdingFence });
          assertLoser(second, secondResult, { ...secondReq, holdingFence });

          // Two items, not one overwritten: the runner id keeps them apart
          expect(countSkipRecords(table, workflowId)).toBe(2);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 8.5, 15.6**
   *
   * The 409 and the 503 are distinct by ORIGIN: `acquire` resolving
   * `{ granted: false }` is the only route to 409, `acquire` throwing is the
   * only route to 503. An indeterminate lease must never be reported as
   * "already running", and must write no skip record - the record would claim a
   * contention nobody observed (Req 2.16).
   */
  it('an indeterminate lease answers 503 with a distinct message, never 409, and writes nothing', async () => {
    const table = new FakeRunTable();
    const runner = makeRunner(table, 'runner-indeterminate', 1_700_000_000_000);
    const indeterminateLease: TriggerRouteDeps['leaseStore'] = {
      // A fatal error: the lease state is unknown, not lost
      acquire: async () => {
        throw new Error('AccessDeniedException');
      },
      heartbeat: async () => {
        throw new Error('heartbeat must not be called on an indeterminate acquire');
      },
      release: async () => {
        throw new Error('release must not be called on an indeterminate acquire');
      },
    };
    const deps: TriggerRouteDeps = { ...runner.deps, leaseStore: indeterminateLease };

    const result = await handleTrigger(deps, {
      workflowId: 'wf-indeterminate',
      runId: 'run-1',
      source: 'manual',
    });

    expect(result.status).toBe(503);
    expect(result.status).not.toBe(409);
    expect((result.body as { error: string }).error).toBe('Lease state could not be determined');

    // No skip record, and nothing at all in the partition
    expect(runWritesOf(runner.client).length).toBe(0);
    expect(runner.client.requests.length).toBe(0);
    expect(countSkipRecords(table, 'wf-indeterminate')).toBe(0);
  });
});
