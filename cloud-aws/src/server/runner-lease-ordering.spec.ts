/**
 * Property test for lease-write ordering across all trigger sources.
 *
 * Property 6: The lease write is the first Run_Table operation of every trigger.
 * Validates: Requirements 2.13, 7.7
 *
 * For any trigger source (schedule fire, webhook, manual call, monitor trigger
 * frame), the first Run_Table request the Host_Adapter issues is the
 * Execution_Lease conditional write, and whether the run starts is decided
 * from that write's outcome alone with no preceding read.
 *
 * Feature: aws-deployment-target
 * Requirements: 2.13, 7.7
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { RunSource, WorkflowGraph, WorkflowNode, WorkflowConnection } from '@phorma/engine';
import { FakeRunTable } from '../test/fake-run-table.js';
import { FakeDocumentTableClient } from '../test/fake-document-table-client.js';
import { RunTableAdapter } from '../aws/run-table.js';
import { executeRun } from './runner.js';
import type {
  RunnerDeps,
  TriggerInput,
  Clock,
  TimerControl,
  FrameInbox,
  ModelClientFactory,
  DataHostFactory,
  RunnerTelemetry,
  RunRecordWriter,
  ResumeTracker,
} from './runner.js';
import type { MonitorGateway } from '../core/host-contract.js';
import { leaseSk } from '../core/keys.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The four trigger sources covered by Property 6.
 * 'schedule' = schedule fire, 'webhook' = webhook, 'manual' = manual call,
 * 'portal' = monitor trigger frame (initiated through the Monitor WebSocket API).
 */
const TRIGGER_SOURCES: RunSource[] = ['schedule', 'webhook', 'manual', 'portal'];

/** The Run_Table name every command input must name. */
const TABLE_NAME = 'phorma-run-table';

/** Build a minimal workflow graph with one manual-trigger node. */
function minimalGraph(): WorkflowGraph {
  const trigger: WorkflowNode = {
    id: 'trigger',
    name: 'Trigger',
    kind: 'manual-trigger',
    category: 'trigger',
    icon: '',
    position: { x: 0, y: 0 },
    ports: [{ id: 'trigger-out', name: 'Start', role: 'message-out' }],
    data: {},
  };
  return { nodes: [trigger], connections: [] };
}

/** Create a no-op monitor gateway. */
function noopMonitor(): MonitorGateway {
  return {
    push: async () => {},
    addConnection: () => {},
    removeConnection: () => {},
    connections: () => [],
  } as unknown as MonitorGateway;
}

/** Create a no-op telemetry sink. */
function noopTelemetry(): RunnerTelemetry {
  return {
    setRunId: () => {},
    clearRunId: () => {},
    log: async () => {},
    publishRunOutcome: async () => {},
    publishRunDuration: async () => {},
    publishLeaseTakeover: async () => {},
  };
}

/** Create a no-op run record writer. */
function noopRunRecord(): RunRecordWriter {
  return {
    writeInFlight: async () => {},
    writeSettled: async () => {},
  };
}

/** Create a resume tracker that always reports 0 replacements. */
function noopResumeTracker(): ResumeTracker {
  return {
    getReplacementCount: async () => 0,
    incrementReplacementCount: async () => 1,
  };
}

/** Create a clock that returns the given time. */
function fixedClock(nowMs: number): Clock {
  return { now: () => nowMs };
}

/** Create a timer control that fires immediately (for fast testing). */
function immediateTimers(): TimerControl {
  return {
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  };
}

/** Create a frame inbox that always returns an empty array. */
function emptyFrameInbox(): FrameInbox {
  return {
    drain: async () => [],
  };
}

/** Create a model factory that produces a model client ending the run quickly. */
function quickModelFactory(): ModelClientFactory {
  return {
    create: async () => ({
      stream: async function* () {
        yield { type: 'text', text: 'done' };
      },
    } as any),
  };
}

/** Create a data host factory that returns empty hosts. */
function emptyDataHostFactory(): DataHostFactory {
  return {
    create: async () => ({}),
  };
}

/**
 * Build RunnerDeps backed by a FakeRunTable. The lease, journal, events,
 * history, usage and spec stores all go through the same RunTableAdapter,
 * so every Run_Table operation is captured in `table.log`.
 */
function buildDeps(
  table: FakeRunTable,
  workflowId: string,
  runnerId: string,
  nowMs: number,
): RunnerDeps {
  const adapter = new RunTableAdapter(
    new FakeDocumentTableClient(table, { tableName: TABLE_NAME }),
    TABLE_NAME,
  );

  return {
    config: { workflowId, runnerId },
    clock: fixedClock(nowMs),
    timers: immediateTimers(),
    lease: adapter,
    journal: adapter,
    events: adapter.eventStore,
    history: adapter,
    usage: adapter.usageStore,
    spec: adapter,
    monitor: noopMonitor(),
    frameInbox: emptyFrameInbox(),
    modelFactory: quickModelFactory(),
    dataHostFactory: emptyDataHostFactory(),
    telemetry: noopTelemetry(),
    runRecord: noopRunRecord(),
    resumeTracker: noopResumeTracker(),
  };
}

// ---------------------------------------------------------------------------
// Property 6: The lease write is the first Run_Table operation of every trigger
// ---------------------------------------------------------------------------

describe('runner - Property 6: The lease write is the first Run_Table operation of every trigger', () => {
  /**
   * **Validates: Requirements 2.13, 7.7**
   *
   * For any workflow id, runner id, clock value and trigger source, the first
   * entry in the FakeRunTable request log after invoking executeRun is the
   * lease conditional write (an updateItem on the lease sort key with the
   * acquire condition). No read or other write precedes it.
   */
  it('the first recorded Run_Table operation for every trigger source is the lease acquire', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 32 }).filter(s => /\S/.test(s)),
        fc.string({ minLength: 1, maxLength: 32 }).filter(s => /\S/.test(s)),
        fc.string({ minLength: 1, maxLength: 32 }).filter(s => /\S/.test(s)),
        fc.integer({ min: 1_000_000_000_000, max: 9_000_000_000_000 }),
        fc.constantFrom(...TRIGGER_SOURCES),
        async (workflowId, runnerId, runId, nowMs, source) => {
          const table = new FakeRunTable();
          const deps = buildDeps(table, workflowId, runnerId, nowMs);

          const trigger: TriggerInput = {
            runId,
            input: 'test',
            source,
            graph: minimalGraph(),
          };

          // Execute the run - may complete or skip (if lease already held)
          await executeRun(deps, trigger);

          // The log must have at least one entry
          expect(table.log.length).toBeGreaterThan(0);

          // The first operation must be on the lease sort key
          const firstEntry = table.log[0];
          expect(firstEntry.operation).toBe('UpdateItem');

          // The key must be the lease key for this workflow
          const key = firstEntry.key as { pk: string; sk: string };
          expect(key.pk).toBe(`wf#${workflowId}`);
          expect(key.sk).toBe(leaseSk());

          // The condition must be the acquire condition (attribute_not_exists OR expiry check)
          expect(firstEntry.condition).toBeDefined();
          expect(firstEntry.condition).toContain('attribute_not_exists');
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 2.13, 7.7**
   *
   * When the lease is already held by another runner, the first (and only
   * meaningful) Run_Table operation is still the lease conditional write.
   * The run is decided from that single write's outcome - no preceding read.
   */
  it('a contended trigger still starts with the lease acquire as the first operation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 32 }).filter(s => /\S/.test(s)),
        fc.string({ minLength: 1, maxLength: 32 }).filter(s => /\S/.test(s)),
        fc.string({ minLength: 1, maxLength: 32 }).filter(s => /\S/.test(s)),
        fc.integer({ min: 1_000_000_000_000, max: 9_000_000_000_000 }),
        fc.constantFrom(...TRIGGER_SOURCES),
        async (workflowId, runnerId, runId, nowMs, source) => {
          const table = new FakeRunTable();

          // Seed the table with a lease that is currently held (not expired).
          // The lease expires far in the future relative to the contender's clock.
          const leaseKey = { pk: `wf#${workflowId}`, sk: leaseSk() };
          table.seed(leaseKey, {
            pk: leaseKey.pk,
            sk: leaseKey.sk,
            fence: 5,
            expiresAtMs: nowMs + 60_000, // valid for 60 more seconds
            runnerId: 'holder-runner',
            workflowId,
          });

          // Clear the log so we only observe the contender's operations
          table.log.length = 0;

          // Attempt a trigger with the contender - the lease is held
          const contenderDeps = buildDeps(table, workflowId, runnerId, nowMs);
          const trigger: TriggerInput = {
            runId,
            input: 'test',
            source,
            graph: minimalGraph(),
          };

          const outcome = await executeRun(contenderDeps, trigger);

          // The outcome should be 'skipped' since the lease is held
          expect(outcome.status).toBe('skipped');

          // The first operation must still be the lease acquire attempt
          expect(table.log.length).toBeGreaterThan(0);
          const firstEntry = table.log[0];
          expect(firstEntry.operation).toBe('UpdateItem');

          const key = firstEntry.key as { pk: string; sk: string };
          expect(key.pk).toBe(`wf#${workflowId}`);
          expect(key.sk).toBe(leaseSk());
          expect(firstEntry.condition).toBeDefined();
          expect(firstEntry.condition).toContain('attribute_not_exists');
        },
      ),
      { numRuns: 100 },
    );
  });
});
