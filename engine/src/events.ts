/**
 * RunEvents — the single stream of truth for everything a run does.
 *
 * The studio's run controller consumes these to animate the canvas (glow,
 * edge pulses), fill the console, and build the trace timeline. The cloud
 * runtime relays the exact same events over WebSocket, which is what gives
 * Phorma its local-to-cloud visualization parity.
 */

import type { ModelUsage } from './model.js';
import type { RunSource, SyncSummary } from './run-record.js';

/** One nested workflow frame in a root-to-leaf event scope path. */
export interface RunScope {
  /** Execute Workflow node that opened this frame. */
  nodeId: string;
  workflowId: string;
  workflowName: string;
  /** Deterministic identity of this specific Execute Workflow occurrence. */
  frameId: string;
  /** Top-level workflow is depth 0; its first child is depth 1. */
  depth: number;
}

export type RunNodeState =
  | 'idle'
  | 'queued'
  | 'thinking'
  | 'waiting-approval'
  | 'waiting-event'
  | 'waiting-input'
  | 'done'
  | 'error';

type RunEventPayload =
  | { type: 'run-started'; runId: string; input: string; source?: RunSource; at: number }
  | { type: 'node-started'; runId: string; nodeId: string; nodeName: string; at: number }
  | { type: 'node-token'; runId: string; nodeId: string; token: string }
  | { type: 'node-thinking'; runId: string; nodeId: string; token: string }
  | { type: 'node-usage'; runId: string; nodeId: string; provider: string; model: string; usage: ModelUsage; at: number }
  | { type: 'node-completed'; runId: string; nodeId: string; nodeName: string; output: string; at: number }
  | { type: 'node-failed'; runId: string; nodeId: string; nodeName: string; error: string; at: number }
  // Robustness primitives (EPIC 3): retry attempts, model fallback switches,
  // error-branch routing, and context compression are all first-class trace
  // moments so the canvas/trace explain exactly how a run recovered.
  | { type: 'node-retrying'; runId: string; nodeId: string; nodeName: string; attempt: number; maxAttempts: number; delayMs: number; error: string; at: number }
  | { type: 'node-fallback'; runId: string; nodeId: string; nodeName: string; fromProvider: string; fromModel: string; toProvider: string; toModel: string; error: string; at: number }
  | { type: 'node-error-routed'; runId: string; nodeId: string; nodeName: string; error: string; at: number }
  | { type: 'context-compressed'; runId: string; nodeId: string; beforeTokens: number; afterTokens: number; at: number }
  | { type: 'handoff'; runId: string; connectionId: string; fromNodeId: string; toNodeId: string; payload: string; at: number }
  | { type: 'tool-call'; runId: string; nodeId: string; toolNodeId: string; name: string; arguments: string; at: number }
  | { type: 'tool-result'; runId: string; nodeId: string; toolNodeId: string; name: string; result: string; isError: boolean; at: number }
  | { type: 'approval-required'; runId: string; requestId: string; nodeId: string; message: string; payload: string; at: number }
  | { type: 'approval-resolved'; runId: string; requestId: string; nodeId: string; approved: boolean; at: number }
  // Ask User: the run suspends and surfaces a question to a human, who
  // types a free-text response that is merged into the payload for the
  // downstream agent.
  | { type: 'ask-required'; runId: string; requestId: string; nodeId: string; nodeName: string; question: string; payload: string; at: number }
  | { type: 'ask-resolved'; runId: string; requestId: string; nodeId: string; response: string; at: number }
  // ForEach loop lifecycle: one loop-started, one loop-iteration per item,
  // one loop-completed (with per-item failure summary) per loop execution.
  | { type: 'loop-started'; runId: string; nodeId: string; nodeName: string; total: number; at: number }
  | { type: 'loop-iteration'; runId: string; nodeId: string; index: number; total: number; item: string; at: number }
  | { type: 'loop-completed'; runId: string; nodeId: string; total: number; succeeded: number; failed: number; at: number }
  // Wait-for-Event: the run suspends until an external event with a matching
  // correlation key arrives (webhook, e-sign callback, manual injection).
  | { type: 'wait-started'; runId: string; nodeId: string; nodeName: string; correlationKey: string; message: string; payload: string; at: number }
  | { type: 'wait-resolved'; runId: string; nodeId: string; correlationKey: string; eventPayload: string; at: number }
  // Nested workflow lifecycle. Child interior events carry the full scope
  // path while these events describe the boundary at the current frame.
  | { type: 'subworkflow-started'; runId: string; nodeId: string; nodeName: string; workflowId: string; workflowName: string; depth: number; input: string; at: number }
  | { type: 'subworkflow-completed'; runId: string; nodeId: string; nodeName: string; workflowId: string; workflowName: string; depth: number; output: string; at: number }
  | { type: 'subworkflow-failed'; runId: string; nodeId: string; nodeName: string; workflowId: string; workflowName: string; depth: number; error: string; at: number }
  // Deterministic data path (EPIC P1): every data node's I/O is auditable from
  // the event stream alone. These carry METADATA ONLY — never headers, never
  // SQL parameter values, never secrets. A request or response body appears
  // only when the node opted into body capture AND the Redactor has run.
  // Data-node retries deliberately reuse `node-retrying` above, so the trace
  // panel needs no new rendering path.
  | { type: 'http-request'; runId: string; nodeId: string; nodeName: string;
      method: string; url: string; attempt: number;
      /** Present only with `persistRequestBody`, post-redaction. */
      body?: string; at: number }
  | { type: 'http-response'; runId: string; nodeId: string; status: number;
      durationMs: number; byteCount: number; truncated?: boolean;
      /** Present only with `persistResponseBody`, post-redaction. */
      body?: string;
      /** True when the response came from a fixture, with `durationMs: 0` (P1-13). */
      replayed?: boolean; at: number }
  | { type: 'page-fetched'; runId: string; nodeId: string; page: number;
      items: number; hasMore: boolean; at: number }
  | { type: 'sql-query'; runId: string; nodeId: string; nodeName: string;
      driver: string; /** Statement text; parameter VALUES are never included. */
      statement: string; paramCount: number; at: number }
  | { type: 'sql-result'; runId: string; nodeId: string; rowCount: number;
      durationMs: number; truncated?: boolean;
      /** True when the rows came from a fixture, with `durationMs: 0` (P1-13). */
      replayed?: boolean; at: number }
  | { type: 'state-read'; runId: string; nodeId: string; key: string;
      found: boolean; at: number }
  | { type: 'state-written'; runId: string; nodeId: string; key: string;
      semantics: 'value' | 'delta' | 'watermark'; changed: boolean;
      /** Watermark semantics only: the previous watermark, when one existed. */
      from?: string;
      /** Watermark semantics only: the watermark this write advanced to. */
      to?: string; at: number }
  | { type: 'assert-passed'; runId: string; nodeId: string; nodeName: string;
      checked: number; at: number }
  | { type: 'assert-breached'; runId: string; nodeId: string; nodeName: string;
      assertion: string; message: string; severity: 'error' | 'warn';
      routed: boolean; at: number }
  | { type: 'notify-sent'; runId: string; nodeId: string; channel: string;
      target: string; at: number }
  /** Emitted exactly once, immediately before the terminal event, when a run executed a data node. */
  | { type: 'sync-summary'; runId: string; summary: SyncSummary; at: number }
  | { type: 'run-paused'; runId: string; nodeId?: string; at: number }
  | { type: 'run-resumed'; runId: string; at: number }
  | { type: 'run-completed'; runId: string; output: string; at: number }
  | { type: 'run-failed'; runId: string; error: string; at: number }
  | { type: 'run-stopped'; runId: string; at: number };

/**
 * Every event can identify the nested frame that emitted it. The path is
 * ordered from the top-level Execute Workflow node to the immediate frame.
 */
export type RunEvent = RunEventPayload & { scope?: RunScope[] };

export type RunEventType = RunEvent['type'];

/** Sink the engine emits into. Must never throw. */
export type RunEventSink = (event: RunEvent) => void;
