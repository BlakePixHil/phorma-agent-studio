/**
 * E2E scenario: Zombie fencing - steal the lease mid-run, every subsequent
 * write refused, exactly one run-failed.
 *
 * Drives the real `runner.ts` against fake adapters.
 * Simulates another runner stealing the lease (advancing the fence) while a
 * run is suspended at a wait-event node. Asserts:
 *   - Exactly one `run-failed` event is produced over Monitor_API naming lease loss
 *   - Every subsequent write by the zombie runner is refused (no emit after lease loss)
 *   - The zombie runner makes no model call (inert after lease loss)
 *
 * tsx hazard: the zombie runner's process would be killed in production.
 * In this test the run remains suspended (stop() alone cannot resolve a pending
 * waitForEvent promise). We abandon the run and synchronise on a side-channel
 * promise rather than awaiting the run itself.
 *
 * Run: npx -y tsx cloud-aws/test/zombie-fencing.e2e.mts
 *
 * Requirements: 3.6, 2.6, 2.15
 * Feature: aws-deployment-target
 */
import assert from 'node:assert/strict';

import type { RunEvent, JournalEntry, WorkflowGraph } from '@phorma/engine';
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
} from '../src/server/runner.js';
import { executeRun } from '../src/server/runner.js';
import type {
  LeaseStore,
  JournalStore,
  RunEventStore,
  RunHistoryStore,
  UsageLedgerStore,
  MonitorGateway,
  SpecStore,
  HeldLease,
  LeaseOutcome,
} from '../src/core/host-contract.js';
import { LEASE_TTL_MS } from '../src/core/lease.js';

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  \u2713 ${name}`);
  else {
    failures += 1;
    console.error(`  \u2717 ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function node(
  id: string,
  kind: string,
  ports: { id: string; name: string; role: 'message-in' | 'message-out' | 'tools' }[],
  data: object = {},
) {
  return { id, name: id, kind, category: 'flow', icon: '', position: { x: 0, y: 0 }, ports, data };
}
function edge(id: string, fromPort: string, toPort: string) {
  return { id, outputId: `${fromPort}-out`, inputId: `${toPort}-in`, kind: 'handoff' as const };
}

// Graph: trigger -> wait-event -> agent
// The run suspends at wait-event. While suspended, we steal the lease.
// The agent node should NOT execute because the zombie is inert after lease loss.
const graph: WorkflowGraph = {
  nodes: [
    node('trig', 'manual-trigger', [
      { id: 'trig-start', name: 'Start', role: 'message-out' },
    ]),
    node('wait', 'wait-event', [
      { id: 'wait-in', name: 'In', role: 'message-in' },
      { id: 'wait-out', name: 'Out', role: 'message-out' },
    ], { correlationKey: 'zombie-key', message: 'Waiting for external event' }),
    node('agent', 'agent', [
      { id: 'agent-in', name: 'In', role: 'message-in' },
      { id: 'agent-out', name: 'Out', role: 'message-out' },
    ], { provider: 'openai', model: 'gpt-4', prompt: 'Do work' }),
  ],
  connections: [
    edge('e1', 'trig-start', 'wait-in'),
    edge('e2', 'wait-out', 'agent-in'),
  ],
};

// ---------------------------------------------------------------------------
// Fake infrastructure
// ---------------------------------------------------------------------------

class FakeClock implements Clock {
  current = 1_000_000;
  now(): number { return this.current; }
  advance(ms: number): void { this.current += ms; }
}

class FakeTimers implements TimerControl {
  private handles = new Map<number, { fn: () => void; interval: boolean; ms: number }>();
  private nextId = 1;

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.handles.set(id, { fn, interval: false, ms });
    return id;
  }
  clearTimeout(handle: unknown): void { this.handles.delete(handle as number); }
  setInterval(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.handles.set(id, { fn, interval: true, ms });
    return id;
  }
  clearInterval(handle: unknown): void { this.handles.delete(handle as number); }

  /** Fire all interval handlers once (simulates a tick). */
  async tickIntervals(): Promise<void> {
    for (const [, entry] of this.handles) {
      if (entry.interval) await entry.fn();
    }
  }
}

/**
 * A lease store where the lease can be "stolen" mid-run. After steal,
 * heartbeats fail (fence mismatch), triggering zombie detection.
 */
class StealableLeaseStore implements LeaseStore {
  private currentFence = 0;
  stolen = false;

  async acquire(workflowId: string, runnerId: string, nowMs: number): Promise<LeaseOutcome> {
    this.currentFence++;
    return {
      granted: true,
      lease: {
        workflowId,
        runnerId,
        fence: this.currentFence,
        expiresAtMs: nowMs + LEASE_TTL_MS,
      },
    };
  }

  async heartbeat(lease: HeldLease, _nowMs: number): Promise<boolean> {
    // After steal, the original runner's fence is lower than currentFence
    if (this.stolen && lease.fence < this.currentFence) {
      return false;
    }
    return lease.fence === this.currentFence;
  }

  async release(lease: HeldLease, _nowMs: number): Promise<boolean> {
    return lease.fence === this.currentFence;
  }

  /** Simulate another runner stealing the lease. */
  stealLease(): void {
    this.currentFence++;
    this.stolen = true;
  }
}

class FakeJournalStore implements JournalStore {
  async preload(): Promise<Map<string, JournalEntry>> { return new Map(); }
  async record(): Promise<void> {}
  async deleteRun(): Promise<void> {}
  async deleteOtherRuns(): Promise<void> {}
}

class FakeEventStore implements RunEventStore {
  events: RunEvent[] = [];
  writeCount = 0;
  writesAfterSteal = 0;
  stealHappened = false;

  async write(_wf: string, _run: string, _seq: number, event: RunEvent): Promise<void> {
    if (this.stealHappened) this.writesAfterSteal++;
    this.writeCount++;
    this.events.push(event);
  }
  async list() { return { items: this.events }; }
  async deleteAll() { return this.events.length; }
}

class FakeMonitor implements MonitorGateway {
  pushed: RunEvent[] = [];
  async push(_wf: string, event: RunEvent): Promise<void> {
    this.pushed.push(event);
  }
}

class FakeTelemetry implements RunnerTelemetry {
  logs: Array<{ level: string; message: string }> = [];
  setRunId() {}
  clearRunId() {}
  async log(level: string, message: string) { this.logs.push({ level, message }); }
  async publishRunOutcome() {}
  async publishRunDuration() {}
  async publishLeaseTakeover() {}
}

class FakeRunRecord implements RunRecordWriter {
  records: any[] = [];
  async writeInFlight(_wf: string, record: any) { this.records.push(record); }
  async writeSettled(_wf: string, record: any) { this.records.push(record); }
}

class FakeResumeTracker implements ResumeTracker {
  private counts = new Map<string, number>();
  async getReplacementCount(wf: string, runId: string): Promise<number> {
    return this.counts.get(`${wf}:${runId}`) ?? 0;
  }
  async incrementReplacementCount(wf: string, runId: string): Promise<number> {
    const key = `${wf}:${runId}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return count;
  }
}

class FakeSpecStore implements SpecStore {
  async read() { return undefined; }
  async write() {}
  async delete() {}
}

class FakeUsageLedger implements UsageLedgerStore {
  async write() {}
  async list() { return { items: [] }; }
  async deleteAll() { return 0; }
}

class FakeRunHistory implements RunHistoryStore {
  async upsert() {}
  async list() { return { items: [] }; }
  async get() { return undefined; }
  async deleteAll() { return 0; }
}

// ---------------------------------------------------------------------------
// Utility: poll for a condition with timeout
// ---------------------------------------------------------------------------
async function waitForCondition(
  predicate: () => boolean,
  intervalMs: number,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      console.error(`  [timeout] waiting for: ${description}`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// Scenario: Steal lease mid-run, every write refused, one run-failed
// ---------------------------------------------------------------------------
console.log('Scenario: Zombie fencing - steal lease mid-run');

async function runScenario(): Promise<void> {
  const workflowId = 'wf-zombie-test';
  const runId = 'run-zombie-001';
  const runnerId = 'runner-A';

  const clock = new FakeClock();
  const timers = new FakeTimers();
  const leaseStore = new StealableLeaseStore();
  const journalStore = new FakeJournalStore();
  const eventStore = new FakeEventStore();
  const monitor = new FakeMonitor();
  const telemetry = new FakeTelemetry();

  // Track model calls - should NOT happen for the agent node after lease steal
  let modelCallCount = 0;
  const modelFactory: ModelClientFactory = {
    async create() {
      return {
        async generate() {
          modelCallCount++;
          return { text: 'model-response', usage: { inputTokens: 10, outputTokens: 5 } };
        },
        async *stream() {
          modelCallCount++;
          yield { text: 'model-response', usage: { inputTokens: 10, outputTokens: 5 } };
        },
      } as any;
    },
  };

  // Frame inbox that does nothing (no frames delivered)
  const frameInbox: FrameInbox = {
    async drain() { return []; },
  };

  const deps: RunnerDeps = {
    config: { workflowId, runnerId },
    clock,
    timers,
    lease: leaseStore,
    journal: journalStore,
    events: eventStore,
    history: new FakeRunHistory(),
    usage: new FakeUsageLedger(),
    spec: new FakeSpecStore(),
    monitor,
    frameInbox,
    modelFactory,
    dataHostFactory: { async create() { return {}; } },
    telemetry,
    runRecord: new FakeRunRecord(),
    resumeTracker: new FakeResumeTracker(),
  };

  const trigger: TriggerInput = {
    runId,
    input: 'zombie test input',
    source: 'manual',
    graph,
  };

  // ─── Start the run (do NOT await - tsx hazard) ─────────────────────────
  // The run will proceed through trigger -> wait-event (suspends).
  // Per the engine steering: "Stop on a run suspended in waitForEvent does
  // nothing by itself; the host must resolve the pending resolver so execution
  // re-enters the gate and throws RunStoppedError."
  //
  // In production the zombie process is killed. Here we abandon the unsettled
  // run and synchronise on a side-channel promise - the tsx hazard pattern.
  const runPromise = executeRun(deps, trigger);

  // Wait for the run to reach the wait-event suspension point.
  await waitForCondition(
    () => monitor.pushed.some((e: any) => e.type === 'wait-started'),
    10,
    2000,
    'wait for run to reach wait-event node',
  );

  check('run reached wait-event (wait-started event emitted)',
    monitor.pushed.some((e: any) => e.type === 'wait-started'));

  // Mark the steal point in the event store
  eventStore.stealHappened = true;

  // ─── Steal the lease (another runner takes over - Req 2.15) ────────────
  leaseStore.stealLease();
  check('lease stolen (fence advanced by another runner)', leaseStore.stolen === true);

  // ─── Trigger heartbeat tick - zombie detection (Req 2.6, 2.15) ─────────
  // The heartbeat interval fires, sees fence mismatch, sets leaseLost=true,
  // calls handle.stop(), pushes run-failed over Monitor_API, attempts no
  // further Run_Table write.
  await timers.tickIntervals();

  // Give async callbacks time to settle
  await new Promise(resolve => setTimeout(resolve, 50));

  // ─── Assert: exactly one run-failed over Monitor_API (Req 2.6) ─────────
  const runFailedEvents = monitor.pushed.filter((e: any) => e.type === 'run-failed');
  check('exactly one run-failed event on monitor',
    runFailedEvents.length === 1,
    `got ${runFailedEvents.length}`);

  if (runFailedEvents.length > 0) {
    const failEvent = runFailedEvents[0] as any;
    check('run-failed event names lease loss as cause',
      typeof failEvent.error === 'string' && failEvent.error.includes('lease loss'),
      `got error: ${failEvent.error}`);
  }

  // ─── Assert: no model call (zombie is inert - Req 2.6) ────────────────
  // The agent node comes after wait-event. Since the run suspended at
  // wait-event before the lease was stolen, and the zombie makes no further
  // progress, the model should never have been called.
  check('no model call (zombie runner is inert)',
    modelCallCount === 0,
    `got ${modelCallCount} model calls`);

  // ─── Assert: no Run_Table event writes after lease loss (Req 2.6) ──────
  // The emit function returns early when leaseLost=true, so no events
  // should be written to the event store after the steal.
  check('no event store writes after lease loss',
    eventStore.writesAfterSteal === 0,
    `got ${eventStore.writesAfterSteal} writes after steal`);

  // ─── Assert: telemetry logged the lease loss ───────────────────────────
  const leaseLossLogs = telemetry.logs.filter(l => l.message.includes('lease loss'));
  check('telemetry logged lease loss', leaseLossLogs.length >= 1,
    `got ${leaseLossLogs.length} lease-loss log entries`);

  // ─── Abandon the unsettled run (tsx hazard pattern) ────────────────────
  // The run is stuck at the unresolved waitForEvent promise. In production
  // the process is killed and Req 3.6 handles restart. We let the process
  // exit normally - Node's event loop will drain after our assertions.
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------
await runScenario();

if (failures > 0) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('\nALL PASS');
