/**
 * Property tests for the Execution_Lease decision layer.
 *
 * Property 1: Lease grant is exclusive and fencing tokens strictly increase.
 * Validates: Requirements 2.1, 2.2, 2.10, 2.14
 *
 * Property 2: Every Runner write is fenced, and a Zombie_Runner changes nothing.
 * Validates: Requirements 2.5, 2.6, 2.15
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FakeRunTable, ConditionalCheckFailedError, TransactionCancelledError } from '../test/fake-run-table.js';
import { acquireWrite, fencedWrite, HEARTBEAT_MS, LEASE_TTL_MS, expiryFor, heartbeatWrite } from './lease.js';
import type { LeaseItem } from './lease.js';
import type { HeldLease } from './host-contract.js';
import { pk, leaseSk } from './keys.js';

describe('lease - Property 2: Every Runner write is fenced, and a Zombie_Runner changes nothing', () => {
  /**
   * **Validates: Requirements 2.5, 2.6, 2.15**
   *
   * A runner that holds the lease can write fenced items successfully
   * (the fence in the TransactWriteItems condition matches the stored lease).
   */
  it('a lease holder can write fenced items successfully', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.integer({ min: 1_000_000_000_000, max: 9_000_000_000_000 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 128 }),
        (workflowId, runnerId, nowMs, dataKey, dataValue) => {
          const table = new FakeRunTable();

          // Acquire the lease
          const write = acquireWrite(workflowId, runnerId, nowMs);
          table.updateItem(write.request);

          // Read back the stored lease to build the HeldLease
          const stored = table.getItem({ pk: pk(workflowId), sk: leaseSk() }) as unknown as LeaseItem;
          expect(stored).not.toBeNull();
          const heldLease = {
            workflowId,
            runnerId,
            fence: stored.fence,
            expiresAtMs: stored.expiresAtMs,
          };

          // Perform a fenced data write
          const dataItemKey = { pk: pk(workflowId), sk: `data#${dataKey}` };
          const dataItem = { payload: dataValue, timestamp: nowMs };
          const txWrite = fencedWrite(heldLease, { key: dataItemKey, item: dataItem });

          // Should succeed without throwing
          table.transactWrite(txWrite.request);

          // Verify the data item was persisted
          const persisted = table.getItem(dataItemKey);
          expect(persisted).not.toBeNull();
          expect(persisted!['payload']).toBe(dataValue);
          expect(persisted!['timestamp']).toBe(nowMs);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 2.5, 2.6, 2.15**
   *
   * A zombie runner (one whose fence doesn't match the stored lease because
   * another runner has acquired the lease) cannot write. The TransactWriteItems
   * fails and the stored data item is unchanged. No retry is attempted.
   */
  it('a zombie runner cannot write - transaction fails and data is unchanged', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.integer({ min: 1_000_000_000_000, max: 9_000_000_000_000 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 128 }),
        fc.string({ minLength: 1, maxLength: 128 }),
        (workflowId, nowMs, dataKey, originalValue, zombieValue) => {
          const table = new FakeRunTable();

          // Runner A acquires the lease
          const writeA = acquireWrite(workflowId, 'runner-A', nowMs);
          table.updateItem(writeA.request);

          const storedAfterA = table.getItem({
            pk: pk(workflowId),
            sk: leaseSk(),
          }) as unknown as LeaseItem;
          const leaseA = {
            workflowId,
            runnerId: 'runner-A',
            fence: storedAfterA.fence,
            expiresAtMs: storedAfterA.expiresAtMs,
          };

          // Runner A writes a data item successfully (setting up initial state)
          const dataItemKey = { pk: pk(workflowId), sk: `data#${dataKey}` };
          const originalItem = { payload: originalValue, writtenBy: 'runner-A' };
          const txWriteA = fencedWrite(leaseA, { key: dataItemKey, item: originalItem });
          table.transactWrite(txWriteA.request);

          // Simulate a takeover: Runner B acquires the lease after expiry
          const takeoverMs = nowMs + 70_000; // well past the 60s TTL
          const writeB = acquireWrite(workflowId, 'runner-B', takeoverMs);
          table.updateItem(writeB.request);

          const storedAfterB = table.getItem({
            pk: pk(workflowId),
            sk: leaseSk(),
          }) as unknown as LeaseItem;
          // Runner B's fence is strictly higher than Runner A's
          expect(storedAfterB.fence).toBeGreaterThan(leaseA.fence);

          // Runner A is now a zombie. Attempt a fenced write with the OLD lease.
          const zombieItem = { payload: zombieValue, writtenBy: 'zombie-A' };
          const zombieWrite = fencedWrite(leaseA, { key: dataItemKey, item: zombieItem });

          // The write must fail (Req 2.6: a zombie's write is rejected)
          let threw = false;
          try {
            table.transactWrite(zombieWrite.request);
          } catch (e) {
            threw = true;
            // Should be a TransactionCancelledError due to condition check on the lease
            expect((e as { code?: string }).code).toBe('TransactionCanceledException');
          }
          expect(threw).toBe(true);

          // The stored data item is UNCHANGED (Req 2.6: leaves stored item unchanged)
          const afterZombie = table.getItem(dataItemKey);
          expect(afterZombie).not.toBeNull();
          expect(afterZombie!['payload']).toBe(originalValue);
          expect(afterZombie!['writtenBy']).toBe('runner-A');

          // No retry was attempted - the request log shows exactly ONE
          // TransactWriteItems call from the zombie (the one that failed)
          const zombieTransactLogs = table.log.filter(
            (entry) =>
              entry.operation === 'TransactWriteItems' &&
              table.log.indexOf(entry) > 2, // after A's acquire + A's write + B's acquire
          );
          expect(zombieTransactLogs).toHaveLength(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 2.5, 2.6, 2.15**
   *
   * After a zombie's write fails, no additional writes are attempted on its
   * behalf. We verify by checking that the request log contains only the
   * single failed TransactWriteItems and no subsequent operations from the zombie.
   */
  it('after a zombie write failure, no retry or subsequent write is attempted', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.integer({ min: 1_000_000_000_000, max: 9_000_000_000_000 }),
        fc.array(fc.string({ minLength: 1, maxLength: 32 }), { minLength: 1, maxLength: 10 }),
        (workflowId, nowMs, dataKeys) => {
          const table = new FakeRunTable();

          // Runner A acquires
          const writeA = acquireWrite(workflowId, 'runner-A', nowMs);
          table.updateItem(writeA.request);
          const storedA = table.getItem({ pk: pk(workflowId), sk: leaseSk() }) as unknown as LeaseItem;
          const leaseA = {
            workflowId,
            runnerId: 'runner-A',
            fence: storedA.fence,
            expiresAtMs: storedA.expiresAtMs,
          };

          // Runner B takes over
          const takeoverMs = nowMs + 70_000;
          const writeB = acquireWrite(workflowId, 'runner-B', takeoverMs);
          table.updateItem(writeB.request);

          // Snapshot the log length before zombie attempts
          const logLenBefore = table.log.length;

          // Zombie (Runner A) attempts multiple fenced writes - each must fail independently
          // and the test asserts that the code does NOT retry on failure
          for (const key of dataKeys) {
            const dataItemKey = { pk: pk(workflowId), sk: `data#${key}` };
            const zombieItem = { payload: 'zombie-data' };
            const zombieWrite = fencedWrite(leaseA, { key: dataItemKey, item: zombieItem });

            let threw = false;
            try {
              table.transactWrite(zombieWrite.request);
            } catch {
              threw = true;
            }
            expect(threw).toBe(true);

            // Each failed write leaves no data behind
            const stored = table.getItem(dataItemKey);
            expect(stored).toBeNull();
          }

          // The log after the zombie attempts shows exactly one TransactWriteItems per key
          // (no retries were injected by the lease logic itself)
          const zombieLogs = table.log.slice(logLenBefore);
          const transactOps = zombieLogs.filter((e) => e.operation === 'TransactWriteItems');
          expect(transactOps).toHaveLength(dataKeys.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('lease - Property 1: Lease grant is exclusive and fencing tokens strictly increase', () => {
  /**
   * **Validates: Requirements 2.1, 2.2, 2.10, 2.14**
   *
   * Simulate 2 to 100 concurrent Runners trying to acquire a lease for the same
   * workflow id at the same instant. Assert exactly one Runner wins (exclusivity)
   * and the fencing token strictly increases on each acquisition.
   */
  it('exactly one Runner wins when multiple Runners contend concurrently for the same workflow id', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.integer({ min: 2, max: 100 }),
        fc.integer({ min: 1_000_000_000_000, max: 9_000_000_000_000 }),
        (workflowId, runnerCount, nowMs) => {
          const table = new FakeRunTable();

          // Generate distinct runner ids
          const runners = Array.from({ length: runnerCount }, (_, i) => `runner-${i}`);

          // All runners attempt to acquire the lease at the same instant
          const results: Array<{ runnerId: string; won: boolean; fence?: number }> = [];

          for (const runnerId of runners) {
            const write = acquireWrite(workflowId, runnerId, nowMs);
            try {
              table.updateItem(write.request);
              // Read the stored fence after the successful write
              const stored = table.getItem({ pk: pk(workflowId), sk: leaseSk() }) as unknown as LeaseItem | null;
              results.push({ runnerId, won: true, fence: stored?.fence });
            } catch (e) {
              if (e instanceof ConditionalCheckFailedError) {
                results.push({ runnerId, won: false });
              } else {
                throw e;
              }
            }
          }

          // Exactly one Runner wins (exclusivity - Req 2.1, 2.10, 2.14)
          const winners = results.filter((r) => r.won);
          expect(winners).toHaveLength(1);

          // The rest all fail with a condition failure
          const losers = results.filter((r) => !r.won);
          expect(losers).toHaveLength(runnerCount - 1);

          // The winning fence token is 1 (first acquisition on a fresh table)
          expect(winners[0].fence).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('fencing tokens strictly increase on each successive acquisition', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.integer({ min: 2, max: 50 }),
        fc.integer({ min: 1_000_000_000_000, max: 9_000_000_000_000 }),
        (workflowId, acquisitionCount, startMs) => {
          const table = new FakeRunTable();
          const fences: number[] = [];

          for (let i = 0; i < acquisitionCount; i++) {
            // Each acquisition uses a different runner and a time after the
            // previous lease has expired (simulating sequential takeovers)
            const runnerId = `runner-${i}`;
            // First acquisition at startMs, each subsequent one at a time
            // when the previous lease has expired (nowMs > previous expiresAtMs)
            const nowMs = startMs + i * 70_000; // 70s apart, well past the 60s TTL

            const write = acquireWrite(workflowId, runnerId, nowMs);
            table.updateItem(write.request);

            const stored = table.getItem({ pk: pk(workflowId), sk: leaseSk() }) as unknown as LeaseItem | null;
            expect(stored).not.toBeNull();
            fences.push(stored!.fence);
          }

          // Fencing tokens must strictly increase (Req 2.2)
          for (let i = 1; i < fences.length; i++) {
            expect(fences[i]).toBeGreaterThan(fences[i - 1]);
          }

          // Each token equals its 1-based index (fence starts at 1, increments by 1)
          for (let i = 0; i < fences.length; i++) {
            expect(fences[i]).toBe(i + 1);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('concurrent acquisition fails when unexpired lease is held', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.integer({ min: 2, max: 100 }),
        fc.integer({ min: 1_000_000_000_000, max: 9_000_000_000_000 }),
        (workflowId, lateRunnerCount, nowMs) => {
          const table = new FakeRunTable();

          // First runner acquires successfully
          const firstWrite = acquireWrite(workflowId, 'first-runner', nowMs);
          table.updateItem(firstWrite.request);

          const storedAfterFirst = table.getItem({
            pk: pk(workflowId),
            sk: leaseSk(),
          }) as unknown as LeaseItem | null;
          expect(storedAfterFirst).not.toBeNull();
          expect(storedAfterFirst!.fence).toBe(1);

          // Other runners try to acquire at the same time (lease not expired)
          let conditionFailures = 0;
          for (let i = 0; i < lateRunnerCount; i++) {
            const write = acquireWrite(workflowId, `late-runner-${i}`, nowMs);
            try {
              table.updateItem(write.request);
            } catch (e) {
              if (e instanceof ConditionalCheckFailedError) {
                conditionFailures++;
              } else {
                throw e;
              }
            }
          }

          // Every late runner must fail (Req 2.10, 2.14)
          expect(conditionFailures).toBe(lateRunnerCount);

          // The stored fence is unchanged - still the first runner's
          const storedAfterContention = table.getItem({
            pk: pk(workflowId),
            sk: leaseSk(),
          }) as unknown as LeaseItem | null;
          expect(storedAfterContention!.fence).toBe(1);
          expect(storedAfterContention!.runnerId).toBe('first-runner');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('at most one lease per workflow id regardless of runner count (Req 2.10)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.integer({ min: 2, max: 100 }),
        fc.integer({ min: 1_000_000_000_000, max: 9_000_000_000_000 }),
        (workflowId, runnerCount, nowMs) => {
          const table = new FakeRunTable();
          const runners = Array.from({ length: runnerCount }, (_, i) => `runner-${i}`);

          // All attempt concurrently
          let winCount = 0;
          for (const runnerId of runners) {
            const write = acquireWrite(workflowId, runnerId, nowMs);
            try {
              table.updateItem(write.request);
              winCount++;
            } catch {
              // condition failure
            }
          }

          // Exactly one holder at any given time
          expect(winCount).toBe(1);

          // Stored item shows exactly one lease
          const stored = table.getItem({ pk: pk(workflowId), sk: leaseSk() }) as unknown as LeaseItem | null;
          expect(stored).not.toBeNull();
          expect(stored!.fence).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Property 3: Lease expiry stays inside its bounds across the whole lifecycle
// ---------------------------------------------------------------------------

describe('lease - Property 3: Lease expiry stays inside its bounds across the whole lifecycle', () => {
  /**
   * **Validates: Requirements 2.3, 2.4, 2.9, 2.11**
   *
   * For any clock value nowMs, expiryFor(nowMs) is always nowMs + LEASE_TTL_MS (60s).
   */
  it('expiryFor(nowMs) equals nowMs + LEASE_TTL_MS for any clock value', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER - LEASE_TTL_MS }),
        (nowMs) => {
          expect(expiryFor(nowMs)).toBe(nowMs + LEASE_TTL_MS);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 2.9**
   *
   * The expiry is at least 3 * HEARTBEAT_MS (30s) after now.
   */
  it('expiry is at least 3 * HEARTBEAT_MS after now', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER - LEASE_TTL_MS }),
        (nowMs) => {
          const expiry = expiryFor(nowMs);
          expect(expiry - nowMs).toBeGreaterThanOrEqual(3 * HEARTBEAT_MS);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 2.9**
   *
   * The expiry is at most 300s after now.
   */
  it('expiry is at most 300 seconds after now', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER - LEASE_TTL_MS }),
        (nowMs) => {
          const expiry = expiryFor(nowMs);
          expect(expiry - nowMs).toBeLessThanOrEqual(300_000);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 2.11**
   *
   * During indefinite suspension (arbitrary time passing without heartbeat),
   * the stored expiry doesn't change - only a new heartbeat advances it.
   */
  it('stored expiry is unchanged by time passing without a heartbeat; only heartbeat advances it', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.integer({ min: 1_000_000_000_000, max: 5_000_000_000_000 }),
        fc.integer({ min: 1, max: 1_000_000_000 }),
        (workflowId, acquireMs, suspensionMs) => {
          const table = new FakeRunTable();

          // Acquire the lease
          const write = acquireWrite(workflowId, 'runner-1', acquireMs);
          table.updateItem(write.request);

          const storedAfterAcquire = table.getItem({
            pk: pk(workflowId),
            sk: leaseSk(),
          }) as unknown as LeaseItem | null;
          expect(storedAfterAcquire).not.toBeNull();

          const expiryAfterAcquire = storedAfterAcquire!.expiresAtMs;

          // Time passes without any heartbeat (indefinite suspension).
          // The stored expiry should remain unchanged.
          const afterSuspension = table.getItem({
            pk: pk(workflowId),
            sk: leaseSk(),
          }) as unknown as LeaseItem | null;
          expect(afterSuspension!.expiresAtMs).toBe(expiryAfterAcquire);

          // Now a heartbeat occurs after the suspension
          const heartbeatMs = acquireMs + suspensionMs;
          const lease: HeldLease = {
            workflowId,
            runnerId: 'runner-1',
            fence: storedAfterAcquire!.fence,
            expiresAtMs: storedAfterAcquire!.expiresAtMs,
          };

          const hbWrite = heartbeatWrite(lease, heartbeatMs);
          table.updateItem(hbWrite.request);

          const storedAfterHeartbeat = table.getItem({
            pk: pk(workflowId),
            sk: leaseSk(),
          }) as unknown as LeaseItem | null;

          // Heartbeat advances the expiry to heartbeatMs + LEASE_TTL_MS
          expect(storedAfterHeartbeat!.expiresAtMs).toBe(heartbeatMs + LEASE_TTL_MS);
          // The new expiry is different from the original (unless suspension was exactly 0)
          if (suspensionMs > 0) {
            expect(storedAfterHeartbeat!.expiresAtMs).not.toBe(expiryAfterAcquire);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 2.3, 2.9**
   *
   * Heartbeat expiry also stays within bounds: at least 3 * HEARTBEAT_MS and at most 300s after now.
   */
  it('heartbeat-written expiry stays within bounds for arbitrary clock values', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.integer({ min: 1_000_000_000_000, max: 5_000_000_000_000 }),
        fc.integer({ min: 1, max: 1_000_000_000 }),
        (workflowId, acquireMs, elapsedMs) => {
          const table = new FakeRunTable();

          // Acquire
          const write = acquireWrite(workflowId, 'runner-1', acquireMs);
          table.updateItem(write.request);

          const stored = table.getItem({
            pk: pk(workflowId),
            sk: leaseSk(),
          }) as unknown as LeaseItem | null;

          const lease: HeldLease = {
            workflowId,
            runnerId: 'runner-1',
            fence: stored!.fence,
            expiresAtMs: stored!.expiresAtMs,
          };

          // Heartbeat at some arbitrary later time
          const heartbeatMs = acquireMs + elapsedMs;
          const hbWrite = heartbeatWrite(lease, heartbeatMs);
          table.updateItem(hbWrite.request);

          const afterHb = table.getItem({
            pk: pk(workflowId),
            sk: leaseSk(),
          }) as unknown as LeaseItem | null;

          const newExpiry = afterHb!.expiresAtMs;
          // At least 3 * HEARTBEAT_MS after the heartbeat time
          expect(newExpiry - heartbeatMs).toBeGreaterThanOrEqual(3 * HEARTBEAT_MS);
          // At most 300s after the heartbeat time
          expect(newExpiry - heartbeatMs).toBeLessThanOrEqual(300_000);
        },
      ),
      { numRuns: 100 },
    );
  });
});
