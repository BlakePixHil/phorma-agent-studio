/**
 * RunEvents — the single stream of truth for everything a run does.
 *
 * The studio's run controller consumes these to animate the canvas (glow,
 * edge pulses), fill the console, and build the trace timeline. The cloud
 * runtime relays the exact same events over WebSocket, which is what gives
 * Phorma its local-to-cloud visualization parity.
 */

import type { DecisionAnswer, DecisionPurpose } from './decisions.js';
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

/**
 * Stable machine token explaining WHY a failure event fired, when the failure
 * came from somewhere that issues tokens (stripe-billing requirement 19). The
 * only issuer today is the hosted entitlement gate, whose five
 * `HostedInferenceRefusalCode` values (`no_subscription`,
 * `subscription_past_due`, `runs_exhausted`, `credits_exhausted`,
 * `no_runtime_key`) are an append-only wire contract in `cloud/src/tenants.ts`.
 * Undefined on every other failure, and undefined for a hosted refusal relayed
 * by a worker that predates the field - which is exactly why consumers keep
 * their prose regex as a fallback (requirement 20).
 *
 * DELIBERATELY `string` AND NOT THAT UNION, for three reasons:
 *
 *  - The engine has zero dependencies on `cloud/` or the studio, so it cannot
 *    import the union, and RESTATING it here would create a third copy of a
 *    contract that only means anything server-side. `TIERS` is the authority for
 *    tiers for the same reason the gate is the authority for its own codes.
 *  - This is a FORWARD-COMPATIBLE wire field. A deployed worker is routinely a
 *    different version than the studio reading it, and the token set is
 *    append-only, so a studio built today must be able to CARRY a token added to
 *    the worker tomorrow. A closed union would make that value unrepresentable
 *    and the only way to move it would be a studio release - the opposite of
 *    what an append-only contract is for.
 *  - Nothing in the engine reads it. It is transported, never interpreted, and a
 *    union buys no safety at a layer that only forwards. Narrowing belongs where
 *    the branch is, in the studio consumers, which must handle an unrecognised
 *    token anyway - the fallback path they already have.
 */
export type RunFailureCode = string;

/**
 * Who settled a human-in-the-loop gate, when the HOST knows and chose to say.
 *
 * Supplied by the host, never by the engine: `requestApproval`, `requestInput`
 * and `waitForEvent` are promises, and a promise carries a value rather than an
 * identity. The cloud host knows the authenticated caller that settled a gate and
 * stamps it onto the resolved event on its way out
 * (multi-organisation Requirement 10.5), which is what puts the acting member in
 * the run record without a table of its own. The local host leaves it absent -
 * there is exactly one person at the machine.
 *
 * An OPAQUE string for the same three reasons {@link RunFailureCode} is: the
 * engine cannot import an identity contract it has no dependency on, a deployed
 * worker is routinely a different version than the studio reading it, and nothing
 * in the engine reads this - it is transported, never interpreted.
 */
export type RunGateActor = string;

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
  | { type: 'node-failed'; runId: string; nodeId: string; nodeName: string; error: string;
      /** See {@link RunFailureCode}. */
      code?: RunFailureCode; at: number }
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
  | { type: 'approval-required'; runId: string; requestId: string; nodeId: string; message: string; payload: string;
      /**
       * Present when System One auto-resolve ran but landed in the uncertain
       * band: its P(safe to approve), shown to the human deciding.
       */
      decisionProbability?: number; at: number }
  | { type: 'approval-resolved'; runId: string; requestId: string; nodeId: string; approved: boolean;
      /** See {@link RunGateActor}. */
      actor?: RunGateActor; at: number }
  // Ask User: the run suspends and surfaces a question to a human, who
  // types a free-text response that is merged into the payload for the
  // downstream agent.
  | { type: 'ask-required'; runId: string; requestId: string; nodeId: string; nodeName: string; question: string; payload: string; at: number }
  | { type: 'ask-resolved'; runId: string; requestId: string; nodeId: string; response: string;
      /** See {@link RunGateActor}. */
      actor?: RunGateActor; at: number }
  // ForEach loop lifecycle: one loop-started, one loop-iteration per item,
  // one loop-completed (with per-item failure summary) per loop execution.
  | { type: 'loop-started'; runId: string; nodeId: string; nodeName: string; total: number; at: number }
  | { type: 'loop-iteration'; runId: string; nodeId: string; index: number; total: number; item: string; at: number }
  | { type: 'loop-completed'; runId: string; nodeId: string; total: number; succeeded: number; failed: number; at: number }
  // Wait-for-Event: the run suspends until an external event with a matching
  // correlation key arrives (webhook, e-sign callback, manual injection).
  | { type: 'wait-started'; runId: string; nodeId: string; nodeName: string; correlationKey: string; message: string; payload: string; at: number }
  | { type: 'wait-resolved'; runId: string; nodeId: string; correlationKey: string; eventPayload: string;
      /** See {@link RunGateActor}. */
      actor?: RunGateActor; at: number }
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
  // System One (TypeSafe Jev): one event per decision call, carrying the typed
  // answers so the canvas can label edges with probabilities and the trace can
  // explain WHY a branch was taken. Never carries the state that was evaluated.
  | { type: 'decision'; runId: string; nodeId: string; nodeName: string;
      purpose: DecisionPurpose;
      /** Versioned model that answered (empty for a fallback). */
      model: string;
      answers: Record<string, DecisionAnswer>;
      /** Out-port the decision routed through, for routing purposes. */
      selectedPortId?: string;
      /**
       * Why the decision was NOT made by the model: `no-transport` (host has no
       * decision client, so a keyword fallback ran) or `low-confidence` (the
       * answer fell under the node's threshold and routed to its unsure path).
       */
      fallback?: 'no-transport' | 'low-confidence' | 'error';
      durationMs: number;
      /** True when served from a fixture, with `durationMs: 0`. */
      replayed?: boolean; at: number }
  /** Emitted exactly once, immediately before the terminal event, when a run executed a data node. */
  | { type: 'sync-summary'; runId: string; summary: SyncSummary; at: number }
  | { type: 'run-paused'; runId: string; nodeId?: string; at: number }
  | { type: 'run-resumed'; runId: string; at: number }
  | { type: 'run-completed'; runId: string; output: string; at: number }
  | { type: 'run-failed'; runId: string; error: string;
      /** See {@link RunFailureCode}. */
      code?: RunFailureCode; at: number }
  | { type: 'run-stopped'; runId: string; at: number };

/**
 * Every event can identify the nested frame that emitted it. The path is
 * ordered from the top-level Execute Workflow node to the immediate frame.
 */
export type RunEvent = RunEventPayload & { scope?: RunScope[] };

export type RunEventType = RunEvent['type'];

/** Sink the engine emits into. Must never throw. */
export type RunEventSink = (event: RunEvent) => void;
