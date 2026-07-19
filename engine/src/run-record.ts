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

import type { RunEvent } from './events.js';
import type { ModelUsage } from './model.js';
import type { WorkflowGraph } from './types.js';

/** What initiated a run. `resume` = journal replay after host eviction. */
export type RunSource = 'manual' | 'schedule' | 'webhook' | 'resume';

/** Where the run executed. */
export type RunEnvironment = 'local' | 'cloud';

/** Terminal (or in-flight) status of a recorded run. */
export type RunRecordStatus = 'running' | 'completed' | 'failed' | 'stopped';

/** Cumulative usage across the run (summed from `node-usage` events). */
export interface RunRecordUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
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
}

/** Coalesced replacement for the per-token `node-thinking` stream. */
export interface NodeThinkingTextEvent {
  type: 'node-thinking-text';
  runId: string;
  nodeId: string;
  /** Cumulative reasoning text for this node execution. */
  text: string;
  at: number;
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
  events: RunLogEvent[];
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
]);

/**
 * Creates a stateful recorder for one run. Feed it every emitted
 * {@link RunEvent}; snapshot whenever the host wants to persist.
 */
export function createRunRecorder(meta: RunRecorderMeta): RunRecorder {
  const events: RunLogEvent[] = [];
  /** nodeId → index into `events` of its coalesced output-text entry. */
  const outputIndex = new Map<string, number>();
  /** nodeId → index into `events` of its coalesced thinking-text entry. */
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

  /** Appends cumulative text to a coalesced per-node entry (in place). */
  function coalesce(
    index: Map<string, number>,
    type: 'node-output-text' | 'node-thinking-text',
    nodeId: string,
    token: string,
  ): void {
    const existing = index.get(nodeId);
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
    index.set(nodeId, events.length);
    events.push({ type, runId: meta.runId, nodeId, text: token, at: Date.now() });
  }

  function addUsage(usage: ModelUsage): void {
    summary.usage = {
      inputTokens: summary.usage.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: summary.usage.outputTokens + (usage.outputTokens ?? 0),
      costUsd: summary.usage.costUsd + (usage.costUsd ?? 0),
    };
  }

  function record(event: RunEvent): void {
    switch (event.type) {
      case 'node-token':
        coalesce(outputIndex, 'node-output-text', event.nodeId, event.token);
        return;
      case 'node-thinking':
        coalesce(thinkingIndex, 'node-thinking-text', event.nodeId, event.token);
        return;
      case 'run-started':
        summary.input = event.input;
        summary.startedAt = event.at;
        push(event);
        return;
      case 'node-started':
        // A re-executing node (cycles, loops) starts a fresh text stream.
        outputIndex.delete(event.nodeId);
        thinkingIndex.delete(event.nodeId);
        push(event);
        return;
      case 'node-usage':
        addUsage(event.usage);
        push(event);
        return;
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

  return {
    record,
    snapshot: () => ({
      summary: { ...summary, usage: { ...summary.usage } },
      graph: meta.graph,
      events: [...events],
    }),
    summary: () => ({ ...summary, usage: { ...summary.usage } }),
    get settled() {
      return settled;
    },
  };
}
