/**
 * RunEvents — the single stream of truth for everything a run does.
 *
 * The studio's run controller consumes these to animate the canvas (glow,
 * edge pulses), fill the console, and build the trace timeline. The cloud
 * runtime relays the exact same events over WebSocket, which is what gives
 * Phorma its local-to-cloud visualization parity.
 */

export type RunNodeState =
  | 'idle'
  | 'queued'
  | 'thinking'
  | 'waiting-approval'
  | 'done'
  | 'error';

export type RunEvent =
  | { type: 'run-started'; runId: string; input: string; at: number }
  | { type: 'node-started'; runId: string; nodeId: string; nodeName: string; at: number }
  | { type: 'node-token'; runId: string; nodeId: string; token: string }
  | { type: 'node-completed'; runId: string; nodeId: string; nodeName: string; output: string; at: number }
  | { type: 'node-failed'; runId: string; nodeId: string; nodeName: string; error: string; at: number }
  | { type: 'handoff'; runId: string; connectionId: string; fromNodeId: string; toNodeId: string; payload: string; at: number }
  | { type: 'tool-call'; runId: string; nodeId: string; toolNodeId: string; name: string; arguments: string; at: number }
  | { type: 'tool-result'; runId: string; nodeId: string; toolNodeId: string; name: string; result: string; isError: boolean; at: number }
  | { type: 'approval-required'; runId: string; nodeId: string; message: string; payload: string; at: number }
  | { type: 'approval-resolved'; runId: string; nodeId: string; approved: boolean; at: number }
  | { type: 'run-paused'; runId: string; nodeId?: string; at: number }
  | { type: 'run-resumed'; runId: string; at: number }
  | { type: 'run-completed'; runId: string; output: string; at: number }
  | { type: 'run-failed'; runId: string; error: string; at: number }
  | { type: 'run-stopped'; runId: string; at: number };

export type RunEventType = RunEvent['type'];

/** Sink the engine emits into. Must never throw. */
export type RunEventSink = (event: RunEvent) => void;
