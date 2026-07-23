/**
 * Persistent run records — the shared history model for EPIC 1.
 *
 * A {@link RunRecord} is what survives after a run ends: a JSON-safe summary
 * (for run lists) plus a coalesced event log (for rebuilding the trace and
 * node states on the canvas). Both the studio (IndexedDB) and the cloud
 * runtime (Durable Object SQLite) build records through the same
 * {@link createRunRecorder} helper, keeping local and cloud history
 * byte-identical in shape.
 *
 * Coalescing: `node-token` / `node-thinking` events dominate a run's event
 * stream (one per streamed token). The recorder folds them into a single
 * cumulative `node-output-text` / `node-thinking-text` entry per node,
 * updated in place, so stored logs stay proportional to node executions —
 * not token counts.
 *
 * Pure TypeScript, zero framework dependencies — same rules as the rest of
 * the engine package.
 */

import type { RunEvent, RunScope } from './events.js';
import type { ModelUsage } from './model.js';
import { withEstimatedCost, type CostEstimator } from './pricing.js';
import type { EmbeddedWorkflow, WorkflowGraph } from './types.js';

/**
 * What initiated a run. `resume` = journal replay after host eviction.
 * `eval` = a test case executed by an eval suite run.
 */
export type RunSource = 'manual' | 'schedule' | 'webhook' | 'resume' | 'eval';

/** Where the run executed. */
export type RunEnvironment = 'local' | 'cloud';

/** Terminal (or in-flight) status of a recorded run. */
export type RunRecordStatus = 'running' | 'completed' | 'failed' | 'stopped';

/** One usage rollup bucket (per node or per model). */
export interface RunUsageBucket {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** True when any summed sample's cost was estimated (or unpriceable). */
  estimated: boolean;
}

/** Cumulative usage across the run (summed from `node-usage` events). */
export interface RunRecordUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /**
   * USD portion billed to Phorma Cloud plan credits (provider
   * `phorma-cloud`). UIs must render this share as credits, never dollars.
   */
  phormaCloudCostUsd?: number;
  /** True when any portion of `costUsd` is a pricing-table estimate. */
  estimated?: boolean;
  /** Scope-aware node identity -> rollup. Top-level keys remain plain node ids. */
  byNode?: Record<string, RunUsageBucket>;
  /** `provider:model` key -> rollup. */
  byModel?: Record<string, RunUsageBucket>;
}

/**
 * The list-view projection of a run — everything a run-history row needs
 * without loading the event log or graph snapshot.
 */
export interface RunRecordSummary {
  /** The runId (`run-…` local, `cloudrun-…` cloud). */
  id: string;
  /** Library workflow id, or null for unsaved drafts. */
  workflowId: string | null;
  workflowName: string;
  source: RunSource;
  environment: RunEnvironment;
  status: RunRecordStatus;
  input: string;
  /** Final output — present once completed. */
  output?: string;
  /** Failure message — present once failed. */
  error?: string;
  /** Epoch ms. */
  startedAt: number;
  /** Epoch ms — absent while running. */
  endedAt?: number;
  usage: RunRecordUsage;
  /** Node count of the graph snapshot (cheap list-row context). */
  nodeCount: number;
  /** True when the event log was capped or payloads were clipped. */
  truncated?: boolean;
}

/** Coalesced replacement for the per-token `node-token` stream. */
export interface NodeOutputTextEvent {
  type: 'node-output-text';
  runId: string;
  nodeId: string;
  /** Cumulative streamed output text for this node execution. */
  text: string;
  at: number;
  /** Nested frame path, when emitted inside a sub-workflow. */
  scope?: RunScope[];
}

/** Coalesced replacement for the per-token `node-thinking` stream. */
export interface NodeThinkingTextEvent {
  type: 'node-thinking-text';
  runId: string;
  nodeId: string;
  /** Cumulative reasoning text for this node execution. */
  text: string;
  at: number;
  /** Nested frame path, when emitted inside a sub-workflow. */
  scope?: RunScope[];
}

/**
 * One entry in a persisted run log: every {@link RunEvent} except the
 * per-token stream events, which are folded into cumulative text entries.
 */
export type RunLogEvent =
  | Exclude<RunEvent, { type: 'node-token' } | { type: 'node-thinking' }>
  | NodeOutputTextEvent
  | NodeThinkingTextEvent;

/** The full persisted record: summary + graph snapshot + event log. */
export interface RunRecord {
  summary: RunRecordSummary;
  /** The graph as it was when the run started (users edit canvases). */
  graph: WorkflowGraph;
  /** Flat by-value registry captured with the root graph, when available. */
  subWorkflows?: Record<string, EmbeddedWorkflow>;
  events: RunLogEvent[];
}

/** Versioned payload stored in legacy graph-only persistence columns. */
export interface RunSnapshotEnvelope {
  format: 'phorma-run-snapshot';
  version: 1;
  graph: WorkflowGraph;
  subWorkflows?: Record<string, EmbeddedWorkflow>;
}

export interface RunSnapshot {
  graph: WorkflowGraph;
  subWorkflows?: Record<string, EmbeddedWorkflow>;
}

/** Encodes a portable run snapshot for a graph-only persistence column. */
export function encodeRunSnapshot(
  graph: WorkflowGraph,
  subWorkflows?: Record<string, EmbeddedWorkflow>,
): string {
  const envelope: RunSnapshotEnvelope = {
    format: 'phorma-run-snapshot',
    version: 1,
    graph,
    subWorkflows,
  };
  return JSON.stringify(envelope);
}

/**
 * Parses the versioned envelope and historical rows containing a raw graph.
 * Throws for malformed values so persistence callers can skip corrupt rows.
 */
export function decodeRunSnapshot(value: string | unknown): RunSnapshot {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid run snapshot.');

  const candidate = parsed as Partial<RunSnapshotEnvelope> & Partial<WorkflowGraph>;
  if (candidate.format === 'phorma-run-snapshot') {
    if (candidate.version !== 1 || !isWorkflowGraph(candidate.graph)) {
      throw new Error('Unsupported run snapshot envelope.');
    }
    if (
      candidate.subWorkflows !== undefined &&
      (!candidate.subWorkflows ||
        typeof candidate.subWorkflows !== 'object' ||
        Array.isArray(candidate.subWorkflows))
    ) {
      throw new Error('Invalid embedded workflow registry.');
    }
    return {
      graph: candidate.graph,
      subWorkflows: candidate.subWorkflows,
    };
  }
  if (isWorkflowGraph(parsed)) return { graph: parsed };
  throw new Error('Invalid run snapshot graph.');
}

function isWorkflowGraph(value: unknown): value is WorkflowGraph {
  if (!value || typeof value !== 'object') return false;
  const graph = value as Partial<WorkflowGraph>;
  return Array.isArray(graph.nodes) && Array.isArray(graph.connections);
}

/**
 * One usage-ledger row (EPIC 2): a compact per-run usage record persisted
 * SEPARATELY from run history so cost analytics survive run pruning. The
 * studio stores these in IndexedDB for local runs; the cloud runtime stores
 * them in DO SQLite and serves them via `GET /usage`.
 */
export interface UsageLedgerEntry {
  runId: string;
  workflowId: string | null;
  workflowName: string;
  source: RunSource;
  status: RunRecordStatus;
  environment: RunEnvironment;
  startedAt: number;
  endedAt?: number;
  usage: RunRecordUsage;
}

/** Projects a settled run's summary into its usage-ledger row. */
export function usageLedgerEntryOf(summary: RunRecordSummary): UsageLedgerEntry {
  return {
    runId: summary.id,
    workflowId: summary.workflowId,
    workflowName: summary.workflowName,
    source: summary.source,
    status: summary.status,
    environment: summary.environment,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    usage: summary.usage,
  };
}

/** Identity/context the host knows before the first event arrives. */
export interface RunRecorderMeta {
  runId: string;
  workflowId: string | null;
  workflowName: string;
  source: RunSource;
  environment: RunEnvironment;
  /** Graph snapshot taken at start (the recorder does not clone it). */
  graph: WorkflowGraph;
  /** Registry snapshot captured at start (the recorder does not clone it). */
  subWorkflows?: Record<string, EmbeddedWorkflow>;
  /**
   * Optional pricing hook: estimates USD for usage samples whose provider
   * didn't report cost (see pricing.ts). Reported costs always win.
   */
  estimateCost?: CostEstimator;
}

export interface RunRecorder {
  /** Feed every {@link RunEvent} the run emits, in order. */
  record(event: RunEvent): void;
  /** Current record — safe to persist at any point (in-flight or settled). */
  snapshot(): RunRecord;
  /** Current summary only (cheap — no event copy). */
  summary(): RunRecordSummary;
  /** True once a terminal event (completed/failed/stopped) was recorded. */
  readonly settled: boolean;
}

/** Max stored bytes per event payload field (outputs, tool results, …). */
const MAX_PAYLOAD_CHARS = 64 * 1024;
/** Max stored log entries per run (token streams don't count — coalesced). */
const MAX_LOG_EVENTS = 2000;
const TRUNCATION_MARKER = '\n… [truncated for run history]';

/** Deep-copies a rollup map (buckets are flat objects). */
function structuredCloneBuckets(
  buckets: Record<string, RunUsageBucket>,
): Record<string, RunUsageBucket> {
  return Object.fromEntries(Object.entries(buckets).map(([key, bucket]) => [key, { ...bucket }]));
}

function clip(text: string): { text: string; clipped: boolean } {
  if (text.length <= MAX_PAYLOAD_CHARS) return { text, clipped: false };
  return { text: text.slice(0, MAX_PAYLOAD_CHARS) + TRUNCATION_MARKER, clipped: true };
}

/** Terminal events are always recorded, even past the log cap. */
const ALWAYS_RECORD = new Set<RunLogEvent['type']>([
  'run-completed',
  'run-failed',
  'run-stopped',
  'node-completed',
  'node-failed',
  'subworkflow-completed',
  'subworkflow-failed',
]);

/**
 * Creates a stateful recorder for one run. Feed it every emitted
 * {@link RunEvent}; snapshot whenever the host wants to persist.
 */
export function createRunRecorder(meta: RunRecorderMeta): RunRecorder {
  const events: RunLogEvent[] = [];
  /** scoped node key -> index into `events` of its coalesced output entry. */
  const outputIndex = new Map<string, number>();
  /** scoped node key -> index into `events` of its coalesced thinking entry. */
  const thinkingIndex = new Map<string, number>();

  const summary: RunRecordSummary = {
    id: meta.runId,
    workflowId: meta.workflowId,
    workflowName: meta.workflowName,
    source: meta.source,
    environment: meta.environment,
    status: 'running',
    input: '',
    startedAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    nodeCount: meta.graph.nodes.length,
  };

  let settled = false;

  function markTruncated(): void {
    summary.truncated = true;
  }

  function push(event: RunLogEvent): void {
    if (events.length >= MAX_LOG_EVENTS && !ALWAYS_RECORD.has(event.type)) {
      markTruncated();
      return;
    }
    events.push(event);
  }

  /** Distinguishes identical node ids used by different nested frames. */
  function scopedNodeKey(nodeId: string, scope?: RunScope[]): string {
    if (!scope?.length) return nodeId;
    return `${scope[scope.length - 1].frameId}/${nodeId}`;
  }

  /** Appends cumulative text to a coalesced per-node entry (in place). */
  function coalesce(
    index: Map<string, number>,
    type: 'node-output-text' | 'node-thinking-text',
    nodeId: string,
    token: string,
    scope?: RunScope[],
  ): void {
    const key = scopedNodeKey(nodeId, scope);
    const existing = index.get(key);
    if (existing !== undefined) {
      const entry = events[existing] as NodeOutputTextEvent | NodeThinkingTextEvent;
      if (entry.text.length >= MAX_PAYLOAD_CHARS) {
        markTruncated();
        return;
      }
      entry.text += token;
      return;
    }
    if (events.length >= MAX_LOG_EVENTS) {
      markTruncated();
      return;
    }
    index.set(key, events.length);
    events.push({ type, runId: meta.runId, nodeId, text: token, at: Date.now(), scope });
  }

  function addToBucket(
    buckets: Record<string, RunUsageBucket>,
    key: string,
    provider: string,
    model: string,
    usage: ModelUsage,
  ): void {
    const bucket = (buckets[key] ??= {
      provider,
      model,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      estimated: false,
    });
    bucket.provider = provider;
    bucket.model = model;
    bucket.inputTokens += usage.inputTokens ?? 0;
    bucket.outputTokens += usage.outputTokens ?? 0;
    bucket.costUsd += usage.costUsd ?? 0;
    if (usage.costSource !== 'reported') bucket.estimated = true;
  }

  function addUsage(
    nodeId: string,
    scope: RunScope[] | undefined,
    provider: string,
    model: string,
    raw: ModelUsage,
  ): void {
    const usage = withEstimatedCost(raw, provider, model, meta.estimateCost);
    const current = summary.usage;
    current.inputTokens += usage.inputTokens ?? 0;
    current.outputTokens += usage.outputTokens ?? 0;
    current.costUsd += usage.costUsd ?? 0;
    if (provider === 'phorma-cloud') {
      current.phormaCloudCostUsd = (current.phormaCloudCostUsd ?? 0) + (usage.costUsd ?? 0);
    }
    if (usage.costSource !== 'reported') current.estimated = true;
    addToBucket((current.byNode ??= {}), scopedNodeKey(nodeId, scope), provider, model, usage);
    addToBucket((current.byModel ??= {}), `${provider}:${model}`, provider, model, usage);
  }

  function record(event: RunEvent): void {
    switch (event.type) {
      case 'node-token':
        coalesce(outputIndex, 'node-output-text', event.nodeId, event.token, event.scope);
        return;
      case 'node-thinking':
        coalesce(thinkingIndex, 'node-thinking-text', event.nodeId, event.token, event.scope);
        return;
      case 'run-started':
        summary.input = event.input;
        summary.startedAt = event.at;
        push(event);
        return;
      case 'node-started':
        // A re-executing node (cycles, loops) starts a fresh text stream.
        outputIndex.delete(scopedNodeKey(event.nodeId, event.scope));
        thinkingIndex.delete(scopedNodeKey(event.nodeId, event.scope));
        push(event);
        return;
      case 'node-usage': {
        addUsage(event.nodeId, event.scope, event.provider, event.model ?? '', event.usage);
        const usage = withEstimatedCost(event.usage, event.provider, event.model ?? '', meta.estimateCost);
        push(usage === event.usage ? event : { ...event, usage });
        return;
      }
      case 'node-completed': {
        const { text, clipped } = clip(event.output);
        if (clipped) markTruncated();
        push({ ...event, output: text });
        return;
      }
      case 'handoff': {
        const { text, clipped } = clip(event.payload);
        if (clipped) markTruncated();
        push({ ...event, payload: text });
        return;
      }
      case 'tool-call': {
        const { text, clipped } = clip(event.arguments);
        if (clipped) markTruncated();
        push({ ...event, arguments: text });
        return;
      }
      case 'tool-result': {
        const { text, clipped } = clip(event.result);
        if (clipped) markTruncated();
        push({ ...event, result: text });
        return;
      }
      case 'subworkflow-started': {
        const { text, clipped } = clip(event.input);
        if (clipped) markTruncated();
        push({ ...event, input: text });
        return;
      }
      case 'subworkflow-completed': {
        const { text, clipped } = clip(event.output);
        if (clipped) markTruncated();
        push({ ...event, output: text });
        return;
      }
      case 'run-completed': {
        const { text, clipped } = clip(event.output);
        if (clipped) markTruncated();
        summary.status = 'completed';
        summary.output = text;
        summary.endedAt = event.at;
        settled = true;
        push({ ...event, output: text });
        return;
      }
      case 'run-failed':
        summary.status = 'failed';
        summary.error = event.error;
        summary.endedAt = event.at;
        settled = true;
        push(event);
        return;
      case 'run-stopped':
        summary.status = 'stopped';
        summary.endedAt = event.at;
        settled = true;
        push(event);
        return;
      default:
        push(event);
    }
  }

  function cloneUsage(usage: RunRecordUsage): RunRecordUsage {
    return {
      ...usage,
      byNode: usage.byNode ? structuredCloneBuckets(usage.byNode) : undefined,
      byModel: usage.byModel ? structuredCloneBuckets(usage.byModel) : undefined,
    };
  }

  return {
    record,
    snapshot: () => ({
      summary: { ...summary, usage: cloneUsage(summary.usage) },
      graph: meta.graph,
      subWorkflows: meta.subWorkflows,
      events: [...events],
    }),
    summary: () => ({ ...summary, usage: cloneUsage(summary.usage) }),
    get settled() {
      return settled;
    },
  };
}
