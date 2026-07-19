/**
 * RunEvents — the single stream of truth for everything a run does.
 *
 * The studio's run controller consumes these to animate the canvas (glow,
 * edge pulses), fill the console, and build the trace timeline. The cloud
 * runtime relays the exact same events over WebSocket, which is what gives
 * Phorma its local-to-cloud visualization parity.
 */

import type { ModelUsage } from './model.js';
import type { RunSource } from './run-record.js';

export type RunNodeState =
  | 'idle'
  | 'queued'
  | 'thinking'
  | 'waiting-approval'
  | 'waiting-event'
  | 'done'
  | 'error';

export type RunEvent =
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
  | { type: 'approval-required'; runId: string; nodeId: string; message: string; payload: string; at: number }
  | { type: 'approval-resolved'; runId: string; nodeId: string; approved: boolean; at: number }
  // ForEach loop lifecycle: one loop-started, one loop-iteration per item,
  // one loop-completed (with per-item failure summary) per loop execution.
  | { type: 'loop-started'; runId: string; nodeId: string; nodeName: string; total: number; at: number }
  | { type: 'loop-iteration'; runId: string; nodeId: string; index: number; total: number; item: string; at: number }
  | { type: 'loop-completed'; runId: string; nodeId: string; total: number; succeeded: number; failed: number; at: number }
  // Wait-for-Event: the run suspends until an external event with a matching
  // correlation key arrives (webhook, e-sign callback, manual injection).
  | { type: 'wait-started'; runId: string; nodeId: string; nodeName: string; correlationKey: string; message: string; payload: string; at: number }
  | { type: 'wait-resolved'; runId: string; nodeId: string; correlationKey: string; eventPayload: string; at: number }
  | { type: 'run-paused'; runId: string; nodeId?: string; at: number }
  | { type: 'run-resumed'; runId: string; at: number }
  | { type: 'run-completed'; runId: string; output: string; at: number }
  | { type: 'run-failed'; runId: string; error: string; at: number }
  | { type: 'run-stopped'; runId: string; at: number };

export type RunEventType = RunEvent['type'];

/** Sink the engine emits into. Must never throw. */
export type RunEventSink = (event: RunEvent) => void;
