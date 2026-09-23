/**
 * Runner: one run's lifecycle on AWS_Host.
 *
 * Orchestrates the full lifecycle of a single workflow run:
 * 1. Acquire the Execution_Lease as the first Run_Table operation (Req 2.13)
 * 2. Preload journal entries for the run id (Req 3.3)
 * 3. Compose RunOptions (capabilities = AWS_CAPABILITIES, absent capabilities
 *    omit RunOptions members) (Req 1.5, 1.6)
 * 4. Start the engine with startRun
 * 5. Fan events to Run_Table (processEvent pipeline) and Monitor_API (push)
 * 6. Drain frame inbox on 1s tick (Req 7.3-7.6)
 * 7. Heartbeat on 10s tick (Req 2.3, 2.11)
 * 8. On settle: release lease, delete journal (Req 2.4, 3.4)
 * 9. On lease loss: stop within one heartbeat, no further writes,
 *    report run-failed naming lease loss (Req 2.6)
 * 10. Resume: same run id + trigger input, bounded at 3 replacements (Req 3.6, 3.11)
 *
 * PURE enough for property testing - all dependencies are interfaces.
 *
 * Feature: aws-deployment-target
 * Requirements: 1.5, 1.6, 2.6, 2.11, 3.6, 3.9, 3.11, 18.5
 */

import type {
  RunEvent,
  RunHandle,
  RunOptions,
  JournalEntry,
  RunJournal,
} from '@phorma/engine';
import { AWS_CAPABILITIES, startRun } from '@phorma/engine';

import type {
  ConnectionStore,
  HeldLease,
  JournalStore,
  LeaseOutcome,
  LeaseStore,
  MonitorGateway,
  RunEventStore,
  RunHistoryStore,
  SpecStore,
  UsageLedgerStore,
  WorkflowStateStore,
} from '../core/host-contract.js';

import { HEARTBEAT_MS } from '../core/lease.js';
import type { ControlFrame, PendingSuspensions, RoutingDecision } from '../core/frames.js';
import { routeFrame, parseFrame } from '../core/frames.js';
import type { EventPipelineOutput } from '../core/events.js';
import { processEvent } from '../core/events.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Frame inbox drain interval in milliseconds. */
const FRAME_DRAIN_INTERVAL_MS = 1_000;

/** Maximum replacements (restarts) per run id (Req 3.11). */
const MAX_REPLACEMENTS_PER_RUN = 3;

// ---------------------------------------------------------------------------
// Injectable dependency interfaces
// ---------------------------------------------------------------------------

/**
 * Clock interface for testability - avoids coupling to Date.now().
 */
export interface Clock {
  now(): number;
}

/**
 * Timer interface - allows property tests to control time progression.
 */
export interface TimerControl {
  /** Schedule a callback to fire after `ms` milliseconds. Returns a handle. */
  setTimeout(fn: () => void, ms: number): unknown;
  /** Cancel a scheduled timer. */
  clearTimeout(handle: unknown): void;
  /** Schedule a repeating callback. Returns a handle. */
  setInterval(fn: () => void, ms: number): unknown;
  /** Cancel a repeating timer. */
  clearInterval(handle: unknown): void;
}

/**
 * Frame inbox - the queue of inbound ControlFrames written by Monitor_API
 * integration into Run_Table, drained by the Runner on a 1s tick.
 */
export interface FrameInbox {
  /** Drain all pending frames, returning them in arrival order. Empties the queue. */
  drain(workflowId: string): Promise<ControlFrame[]>;
}

/**
 * Model client factory - produces a ModelClient for the run.
 * Separated so the runner does not know about provider key resolution.
 */
export interface ModelClientFactory {
  create(workflowId: string): Promise<import('@phorma/engine').ModelClient>;
}

/**
 * Data host factory - produces dataFetch, sql, state, fixtures, connections, redact.
 * Each member may be absent when the capability is not supported.
 */
export interface DataHostFactory {
  create(workflowId: string, redact: (v: string) => string): Promise<DataHosts>;
}

/** The data-path host capabilities resolved for a run. */
export interface DataHosts {
  connections?: ConnectionStore;
  dataFetch?: import('@phorma/engine').DataFetcher;
  sql?: import('@phorma/engine').SqlHost;
  state?: WorkflowStateStore;
  fixtures?: import('@phorma/engine').FixtureStore;
  redact?: (value: string) => string;
  /**
   * System One (TypeSafe Jev). Built from the `typesafe` provider key when one
   * is in Secret_Store; absent otherwise, and the engine then falls back
   * (Router) or fails naming the capability (every other System One step).
   */
  decisions?: import('@phorma/engine').DecisionClient;
}

/**
 * Telemetry sink for the runner.
 */
export interface RunnerTelemetry {
  setRunId(runId: string): void;
  clearRunId(): void;
  log(level: 'info' | 'warn' | 'error' | 'debug', message: string, extra?: Record<string, unknown>): Promise<void>;
  publishRunOutcome(outcome: string): Promise<void>;
  publishRunDuration(durationMs: number): Promise<void>;
  publishLeaseTakeover(supersededFence: number, newFence: number): Promise<void>;
}

/**
 * Run record persistence - writes and updates the RunRecord in Run_Table.
 */
export interface RunRecordWriter {
  /** Write an in-flight run record. */
  writeInFlight(workflowId: string, record: InFlightRunRecord): Promise<void>;
  /** Update the run record with the settled outcome. */
  writeSettled(workflowId: string, record: SettledRunRecord): Promise<void>;
}

/** In-flight run record shape. */
export interface InFlightRunRecord {
  runId: string;
  workflowId: string;
  source: import('@phorma/engine').RunSource;
  input: string;
  startedAt: number;
  graph: import('@phorma/engine').WorkflowGraph;
}

/** Settled run record shape. */
export interface SettledRunRecord {
  runId: string;
  workflowId: string;
  outcome: 'completed' | 'failed' | 'stopped';
  endedAt: number;
  error?: string;
}

/**
 * Resume state tracker - records replacement count per run id.
 */
export interface ResumeTracker {
  /** Get the number of times this run id has been replaced (restarted). */
  getReplacementCount(workflowId: string, runId: string): Promise<number>;
  /** Increment the replacement count. Returns the new count. */
  incrementReplacementCount(workflowId: string, runId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Runner configuration
// ---------------------------------------------------------------------------

export interface RunnerConfig {
  workflowId: string;
  runnerId: string;
}

// ---------------------------------------------------------------------------
// Runner dependencies (all injectable)
// ---------------------------------------------------------------------------

export interface RunnerDeps {
  config: RunnerConfig;
  clock: Clock;
  timers: TimerControl;
  lease: LeaseStore;
  journal: JournalStore;
  events: RunEventStore;
  history: RunHistoryStore;
  usage: UsageLedgerStore;
  spec: SpecStore;
  monitor: MonitorGateway;
  frameInbox: FrameInbox;
  modelFactory: ModelClientFactory;
  dataHostFactory: DataHostFactory;
  telemetry: RunnerTelemetry;
  runRecord: RunRecordWriter;
  resumeTracker: ResumeTracker;
}

// ---------------------------------------------------------------------------
// Trigger input
// ---------------------------------------------------------------------------

export interface TriggerInput {
  runId: string;
  input: string;
  source: import('@phorma/engine').RunSource;
  graph: import('@phorma/engine').WorkflowGraph;
  subWorkflows?: Record<string, import('@phorma/engine').EmbeddedWorkflow>;
  maxSubWorkflowDepth?: number;
  runTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Run outcome
// ---------------------------------------------------------------------------

/** The engine's root-level terminal event, as the runner records it. */
type TerminalEvent =
  | { type: 'run-completed' }
  | { type: 'run-failed'; error: string }
  | { type: 'run-stopped' };

export type RunOutcome =
  | { status: 'completed' }
  | { status: 'failed'; error: string }
  | { status: 'stopped' }
  | { status: 'skipped'; reason: string };

// ---------------------------------------------------------------------------
// Runner implementation
// ---------------------------------------------------------------------------

/**
 * Execute one run lifecycle.
 *
 * Returns the run outcome. The caller (trigger-routes) uses this to formulate
 * the HTTP response.
 */
export async function executeRun(
  deps: RunnerDeps,
  trigger: TriggerInput,
): Promise<RunOutcome> {
  const { config, clock, timers, lease, journal, monitor, telemetry } = deps;
  const { workflowId, runnerId } = config;

  // ─── Step 1: Acquire lease (first Run_Table operation - Req 2.13) ───────
  const leaseResult = await acquireLease(deps);
  if (!leaseResult.granted) {
    return { status: 'skipped', reason: `lease held by fence ${leaseResult.holdingFence}` };
  }

  const heldLease = leaseResult.lease;
  telemetry.setRunId(trigger.runId);

  // ─── Step 2: Check resume bounds (Req 3.11) ────────────────────────────
  const replacementCount = await deps.resumeTracker.getReplacementCount(workflowId, trigger.runId);
  if (replacementCount >= MAX_REPLACEMENTS_PER_RUN) {
    // Too many restarts - fail the run (Req 3.11)
    await telemetry.log('error', 'run exceeded maximum replacements', {
      runId: trigger.runId,
      replacements: replacementCount,
      max: MAX_REPLACEMENTS_PER_RUN,
    });
    await releaseLease(deps, heldLease);
    await journal.deleteRun(workflowId, trigger.runId);
    telemetry.clearRunId();
    return {
      status: 'failed',
      error: `run ${trigger.runId} exceeded ${MAX_REPLACEMENTS_PER_RUN} replacements without settling`,
    };
  }

  // ─── Step 3: Preload journal (Req 3.3) ─────────────────────────────────
  const journalMap = await journal.preload(workflowId, trigger.runId);
  const isResume = journalMap.size > 0;

  // If not a resume, clean up old journal entries (Req 3.5)
  if (!isResume) {
    await journal.deleteOtherRuns(workflowId, trigger.runId);
  }

  // ─── Step 4: Compose RunOptions (Req 1.5, 1.6) ─────────────────────────
  const model = await deps.modelFactory.create(workflowId);

  // Resolve data hosts - absent capabilities leave members absent (Req 1.6)
  const dataHosts = await deps.dataHostFactory.create(
    workflowId,
    (v: string) => v, // placeholder redactor, replaced below
  );

  const runJournal = createRunJournal(deps, workflowId, trigger.runId, journalMap);

  // ─── State: event pipeline, heartbeat, frame drain ─────────────────────
  let eventSequence = 0;
  let leaseLost = false;
  let stopped = false;
  let runHandle: RunHandle | undefined;
  /**
   * The engine's terminal event. `RunHandle.done` resolves for a failed or
   * stopped run too (the engine reports those as events, not rejections), so
   * the outcome must come from here or every failure would settle `completed`.
   */
  let terminal: TerminalEvent | null = null;
  const settledTerminal = (): TerminalEvent | null => terminal;

  // Pending suspensions for frame routing
  const pendingApprovals = new Set<string>();
  const pendingQuestions = new Set<string>();
  const pendingWaits = new Set<string>();
  const pendingSuspensions: PendingSuspensions = {
    approvals: pendingApprovals,
    questions: pendingQuestions,
    waits: pendingWaits,
  };

  // Suspension resolvers
  const approvalResolvers = new Map<string, (approved: boolean) => void>();
  const questionResolvers = new Map<string, (response: string) => void>();
  const waitResolvers = new Map<string, (payload: string) => void>();

  // Buffered early events (Req 7.5)
  const earlyEvents = new Map<string, string>();

  // Write in-flight run record (Req 4.1)
  await deps.runRecord.writeInFlight(workflowId, {
    runId: trigger.runId,
    workflowId,
    source: isResume ? 'resume' : trigger.source,
    input: trigger.input,
    startedAt: clock.now(),
    graph: trigger.graph,
  });

  // ─── Event emission handler ────────────────────────────────────────────
  const emit = async (event: RunEvent): Promise<void> => {
    if (leaseLost) return; // Req 2.6: no further write after lease loss

    // Root-level terminal events only; a sub-workflow frame never settles the run.
    if (!event.scope?.length) {
      if (event.type === 'run-completed') terminal = { type: 'run-completed' };
      else if (event.type === 'run-failed') terminal = { type: 'run-failed', error: event.error };
      else if (event.type === 'run-stopped') terminal = { type: 'run-stopped' };
    }

    eventSequence += 1;

    // Process through the event pipeline (Req 4.2, 4.6, 4.7)
    const pipelineResult: EventPipelineOutput = processEvent({
      event,
      sequence: eventSequence,
      persistPayload: true, // AWS_Host always persists payloads
      redact: dataHosts.redact,
    });

    // Fan to Run_Table (Req 1.3)
    await deps.events.write(workflowId, trigger.runId, pipelineResult.sequence, pipelineResult.event);

    // Fan to Monitor_API (Req 7.2)
    await monitor.push(workflowId, pipelineResult.event);

    // Track usage events for the usage ledger
    if (event.type === 'node-usage') {
      // Record model spend with real provider name,
      // BYO cost field only, Phorma Cloud cost field absent (Req 18.5)
      await deps.usage.write(workflowId, {
        runId: trigger.runId,
        workflowId,
        workflowName: '',
        source: isResume ? 'resume' : trigger.source,
        status: 'running',
        environment: 'cloud',
        startedAt: clock.now(),
        usage: {
          inputTokens: event.usage.inputTokens ?? 0,
          outputTokens: event.usage.outputTokens ?? 0,
          costUsd: event.usage.costUsd ?? 0,
          // phormaCloudCostUsd is intentionally absent (Req 18.5: BYO)
        },
      });
    }
  };

  // ─── Compose RunOptions ────────────────────────────────────────────────
  // capabilities is always AWS_CAPABILITIES (Req 1.5)
  // Absent capabilities leave RunOptions members absent (Req 1.6)
  const runOptions: RunOptions = {
    runId: trigger.runId,
    graph: trigger.graph,
    input: trigger.input,
    source: isResume ? 'resume' : trigger.source,
    workflowId,
    capabilities: AWS_CAPABILITIES,
    model,
    journal: runJournal,
    emit,
    subWorkflows: trigger.subWorkflows,
    maxSubWorkflowDepth: trigger.maxSubWorkflowDepth,
    runTimeoutMs: trigger.runTimeoutMs,
    // Max executions: increase for batch workflows
    maxExecutions: hasBatchNode(trigger.graph) ? 2000 : undefined,

    // Data-path capabilities - absent when AWS_CAPABILITIES declares them absent
    // AWS_CAPABILITIES has: cron, durableState, fixtures, privateNetworkEgress (true)
    // and stdioMcp, mcpOAuth (false)
    // Since AWS_CAPABILITIES declares durableState: true, state is provided.
    // Since AWS_CAPABILITIES declares fixtures: true, fixtures is provided.
    // Since stdioMcp: false and mcpOAuth: false, the corresponding tool host
    // features are absent (handled by the tool host factory, not RunOptions).
    connections: dataHosts.connections,
    dataFetch: dataHosts.dataFetch,
    sql: dataHosts.sql,
    state: dataHosts.state,
    fixtures: dataHosts.fixtures,
    redact: dataHosts.redact,
    decisions: dataHosts.decisions,

    // Suspension handlers
    requestApproval: (nodeId, message, payload, requestId) => {
      return new Promise<boolean>((resolve) => {
        pendingApprovals.add(requestId);
        approvalResolvers.set(requestId, (approved) => {
          pendingApprovals.delete(requestId);
          approvalResolvers.delete(requestId);
          resolve(approved);
        });
      });
    },

    requestInput: (nodeId, question, payload, requestId) => {
      return new Promise<string>((resolve) => {
        pendingQuestions.add(requestId);
        questionResolvers.set(requestId, (response) => {
          pendingQuestions.delete(requestId);
          questionResolvers.delete(requestId);
          resolve(response);
        });
      });
    },

    waitForEvent: (nodeId, correlationKey, message, payload, timeoutMs) => {
      // Check early events first (Req 7.5)
      const buffered = earlyEvents.get(correlationKey);
      if (buffered !== undefined) {
        earlyEvents.delete(correlationKey);
        return Promise.resolve(buffered);
      }

      return new Promise<string>((resolve) => {
        pendingWaits.add(correlationKey);
        waitResolvers.set(correlationKey, (eventPayload) => {
          pendingWaits.delete(correlationKey);
          waitResolvers.delete(correlationKey);
          resolve(eventPayload);
        });
      });
    },
  };

  // ─── Step 5: Start the engine ──────────────────────────────────────────
  runHandle = startRun(runOptions);

  const startMs = clock.now();

  // ─── Step 6: Heartbeat on 10s tick (Req 2.3, 2.11) ────────────────────
  const heartbeatHandle = timers.setInterval(async () => {
    if (leaseLost || stopped) return;

    const success = await lease.heartbeat(heldLease, clock.now());
    if (!success) {
      // Lease lost! (Req 2.6)
      leaseLost = true;
      await handleLeaseLoss(deps, trigger, runHandle!, monitor);
    }
  }, HEARTBEAT_MS);

  // ─── Step 7: Drain frame inbox on 1s tick (Req 7.3-7.6) ───────────────
  const frameDrainHandle = timers.setInterval(async () => {
    if (leaseLost || stopped) return;

    const frames = await deps.frameInbox.drain(workflowId);
    for (const frame of frames) {
      const decision = routeFrame(frame, pendingSuspensions);
      applyDecision(decision, {
        approvalResolvers,
        questionResolvers,
        waitResolvers,
        earlyEvents,
        runHandle: runHandle!,
        onStop: () => { stopped = true; },
      });
    }
  }, FRAME_DRAIN_INTERVAL_MS);

  // ─── Step 8: Await engine settlement ───────────────────────────────────
  let outcome: RunOutcome;
  try {
    await runHandle.done;
    const settled = settledTerminal();
    if (leaseLost) outcome = { status: 'failed', error: 'lease loss' };
    else if (settled?.type === 'run-failed') outcome = { status: 'failed', error: settled.error };
    else if (settled?.type === 'run-stopped' || stopped) outcome = { status: 'stopped' };
    else outcome = { status: 'completed' };
  } catch (err: unknown) {
    if (leaseLost) {
      outcome = { status: 'failed', error: 'lease loss' };
    } else if (stopped) {
      outcome = { status: 'stopped' };
    } else {
      const message = err instanceof Error ? err.message : String(err);
      outcome = { status: 'failed', error: message };
    }
  } finally {
    // ─── Cleanup: stop timers ────────────────────────────────────────────
    timers.clearInterval(heartbeatHandle);
    timers.clearInterval(frameDrainHandle);
  }

  // ─── Step 9: Settle ────────────────────────────────────────────────────
  if (!leaseLost) {
    const endMs = clock.now();

    // Write settled run record
    await deps.runRecord.writeSettled(workflowId, {
      runId: trigger.runId,
      workflowId,
      outcome: outcome.status,
      endedAt: endMs,
      error: outcome.status === 'failed' ? outcome.error : undefined,
    });

    // Publish telemetry
    await telemetry.publishRunOutcome(outcome.status);
    await telemetry.publishRunDuration(endMs - startMs);

    // Release lease (Req 2.4)
    await releaseLease(deps, heldLease);

    // Delete journal on settle (Req 3.4)
    await journal.deleteRun(workflowId, trigger.runId);
  }

  telemetry.clearRunId();
  return outcome;
}

// ---------------------------------------------------------------------------
// Lease acquisition
// ---------------------------------------------------------------------------

async function acquireLease(deps: RunnerDeps): Promise<LeaseOutcome> {
  const { config, clock, lease } = deps;
  return lease.acquire(config.workflowId, config.runnerId, clock.now());
}

// ---------------------------------------------------------------------------
// Lease release
// ---------------------------------------------------------------------------

async function releaseLease(deps: RunnerDeps, heldLease: HeldLease): Promise<void> {
  const { clock, lease, telemetry } = deps;
  const success = await lease.release(heldLease, clock.now());
  if (!success) {
    await telemetry.log('warn', 'lease release failed - fence mismatch', {
      fence: heldLease.fence,
    });
  }
}

// ---------------------------------------------------------------------------
// Lease loss handler (Req 2.6)
// ---------------------------------------------------------------------------

async function handleLeaseLoss(
  deps: RunnerDeps,
  trigger: TriggerInput,
  handle: RunHandle,
  monitor: MonitorGateway,
): Promise<void> {
  const { config, telemetry } = deps;

  // Stop node bodies within one heartbeat (Req 2.6)
  handle.stop();

  // Report run-failed naming lease loss over Monitor_API (Req 2.6)
  const failEvent: RunEvent = {
    type: 'run-failed',
    runId: trigger.runId,
    error: 'lease loss: another runner acquired the execution lease',
    at: deps.clock.now(),
  } as RunEvent;

  // Attempt no further Run_Table write (Req 2.6) - push only to Monitor
  await monitor.push(config.workflowId, failEvent);

  await telemetry.log('error', 'run terminated due to lease loss', {
    runId: trigger.runId,
    workflowId: config.workflowId,
  });
}

// ---------------------------------------------------------------------------
// Resume entry point (Req 3.6)
// ---------------------------------------------------------------------------

/**
 * Restart an interrupted run with the same run id and trigger input.
 * Bounded at MAX_REPLACEMENTS_PER_RUN replacements per run id (Req 3.11).
 *
 * Returns undefined when the maximum is exceeded (caller should record failure).
 */
export async function resumeRun(
  deps: RunnerDeps,
  trigger: TriggerInput,
): Promise<RunOutcome> {
  const count = await deps.resumeTracker.incrementReplacementCount(
    deps.config.workflowId,
    trigger.runId,
  );

  if (count > MAX_REPLACEMENTS_PER_RUN) {
    // Req 3.11: no further restart
    await deps.journal.deleteRun(deps.config.workflowId, trigger.runId);
    return {
      status: 'failed',
      error: `run ${trigger.runId} exceeded ${MAX_REPLACEMENTS_PER_RUN} replacements without settling`,
    };
  }

  // Restart with the same run id and input (Req 3.6)
  return executeRun(deps, trigger);
}

// ---------------------------------------------------------------------------
// Run journal adapter (wraps JournalStore for engine's synchronous lookup)
// ---------------------------------------------------------------------------

function createRunJournal(
  deps: RunnerDeps,
  workflowId: string,
  runId: string,
  preloaded: Map<string, JournalEntry>,
): RunJournal {
  return {
    lookup(key: string): JournalEntry | undefined {
      return preloaded.get(key);
    },
    async record(key: string, entry: JournalEntry): Promise<void> {
      // Durable write - resolves only after Run_Table acknowledges (Req 3.2)
      await deps.journal.record(workflowId, runId, key, entry);
      // Keep the in-memory map current for same-run re-reads
      preloaded.set(key, entry);
    },
  };
}

// ---------------------------------------------------------------------------
// Frame routing decision applicator
// ---------------------------------------------------------------------------

interface FrameApplyContext {
  approvalResolvers: Map<string, (approved: boolean) => void>;
  questionResolvers: Map<string, (response: string) => void>;
  waitResolvers: Map<string, (payload: string) => void>;
  earlyEvents: Map<string, string>;
  runHandle: RunHandle;
  onStop: () => void;
}

function applyDecision(decision: RoutingDecision, ctx: FrameApplyContext): void {
  switch (decision.action) {
    case 'resolve-approval': {
      const resolver = ctx.approvalResolvers.get(decision.requestId);
      if (resolver) resolver(decision.approved);
      break;
    }
    case 'resolve-question': {
      const resolver = ctx.questionResolvers.get(decision.requestId);
      if (resolver) resolver(decision.response);
      break;
    }
    case 'resolve-wait': {
      const resolver = ctx.waitResolvers.get(decision.correlationKey);
      if (resolver) resolver(decision.payload);
      break;
    }
    case 'buffer-event': {
      // Early event buffering (Req 7.5)
      ctx.earlyEvents.set(decision.correlationKey, decision.payload);
      break;
    }
    case 'start-run': {
      // A trigger frame during an active run is ignored - the lease prevents
      // concurrent runs. The trigger route handles contention at acquisition.
      break;
    }
    case 'stop': {
      ctx.runHandle.stop();
      ctx.onStop();
      break;
    }
    case 'ignore':
      break;
  }
}

// ---------------------------------------------------------------------------
// Batch node detection (for maxExecutions)
// ---------------------------------------------------------------------------

function hasBatchNode(graph: import('@phorma/engine').WorkflowGraph): boolean {
  if (!graph || !graph.nodes) return false;
  return graph.nodes.some(
    (node: { data?: { kind?: string } }) => node.data?.kind === 'for-each',
  );
}
