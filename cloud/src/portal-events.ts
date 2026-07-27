/**
 * Public event projection (EPIC 9) — the redaction boundary.
 *
 * The studio's monitor receives the raw `RunEvent` stream: node names, prompts,
 * tool arguments, tool results, token counts, costs, and raw error messages.
 * None of that may reach a stranger on a published page. A leak here would
 * publish the owner's system prompts and internal reasoning to the internet.
 *
 * So this module is an ALLOW-LIST, not a filter: every event type is dropped
 * unless it is explicitly projected below, and each projection names the exact
 * fields it copies. Adding a `RunEvent` variant upstream therefore fails
 * closed — the new event is silently withheld until someone deliberately maps
 * it here.
 *
 * Two further rules:
 *  1. **Only the responder streams.** `node-token` is forwarded ONLY for the
 *     designated responding node. A 3-agent chain must not stream all three
 *     agents' text to the visitor.
 *  2. **Errors are generic.** Model errors quote provider payloads and can
 *     contain prompt fragments or key hints, so the visitor sees a fixed
 *     sentence and the owner reads the real error in the studio.
 */

import type { RunEvent } from '@phorma/engine';

/** What the portal page is allowed to know about a run in progress. */
export type PortalEvent =
  /** The run was accepted and has begun. */
  | { type: 'started'; runId: string }
  /** A chunk of the answer. Only ever from the responding node. */
  | { type: 'token'; text: string }
  /** The workflow is asking the visitor something (Ask User node). */
  | { type: 'question'; requestId: string; question: string }
  /** The run is parked awaiting the OWNER's approval. */
  | { type: 'review' }
  /** The owner approved (or rejected) and the run continues. */
  | { type: 'review-resolved'; approved: boolean }
  /** Terminal: the answer. */
  | { type: 'done'; output: string }
  /** Terminal: something went wrong (deliberately vague). */
  | { type: 'error'; message: string }
  /** Terminal: the owner stopped the run. */
  | { type: 'stopped' };

/**
 * The single sentence a visitor sees for ANY failure. Never interpolate the
 * engine's error text into this: it can carry prompt fragments, provider
 * payloads, quota wording aimed at the operator, or key hints.
 */
export const PORTAL_GENERIC_ERROR =
  'Something went wrong handling that. Please try again in a moment.';

/** Options for the projection. */
export interface PortalProjectionOptions {
  /**
   * Node whose tokens the visitor may see. `null` withholds ALL streaming and
   * shows only the final output — the safe reading of an ambiguous graph.
   */
  responderNodeId: string | null;
}

/**
 * Projects one engine event into its public form, or null to withhold it.
 *
 * Deliberately NOT projected (and why):
 *  - `node-started` / `node-completed` / `node-failed` — leak node names and
 *    each node's full output text.
 *  - `node-thinking` — the model's private reasoning.
 *  - `node-usage` — token counts and costs are the owner's business.
 *  - `handoff` — leaks graph topology plus the payload in flight.
 *  - `tool-call` / `tool-result` — arguments and API responses.
 *  - `node-retrying` / `node-fallback` / `node-error-routed` /
 *    `context-compressed` — operational detail carrying error text and model ids.
 *  - `loop-*`, `wait-*`, `subworkflow-*` — internal structure and payloads.
 *  - `run-paused` / `run-resumed` — debugger state; a visitor just waits.
 *  - `approval-required.message` / `.payload` — written for the operator.
 */
export function toPortalEvent(
  event: RunEvent,
  options: PortalProjectionOptions,
): PortalEvent | null {
  // Sub-workflow interiors carry a root-to-leaf `scope` path. A nested node id
  // can equal the responder's id (repeated frames reuse node ids), so the
  // responder check cannot be trusted inside a frame — withhold the whole
  // interior. Terminal `run-*` events are only ever emitted at the root, so
  // the visitor still gets their answer.
  if (event.scope?.length) return null;

  switch (event.type) {
    case 'run-started':
      return { type: 'started', runId: event.runId };

    case 'node-token':
      if (!options.responderNodeId || event.nodeId !== options.responderNodeId) return null;
      return { type: 'token', text: event.token };

    case 'ask-required':
      // The question is authored FOR a human and is the whole point of the
      // node, so it is intentionally published. `payload` is not.
      return { type: 'question', requestId: event.requestId, question: event.question };

    case 'approval-required':
      // The visitor learns only that a human is reviewing — never the
      // operator-facing message or the payload under review.
      return { type: 'review' };

    case 'approval-resolved':
      return { type: 'review-resolved', approved: event.approved };

    case 'run-completed':
      return { type: 'done', output: event.output };

    case 'run-failed':
      return { type: 'error', message: PORTAL_GENERIC_ERROR };

    case 'run-stopped':
      return { type: 'stopped' };

    default:
      // Fail closed: unknown and deliberately-withheld events are dropped.
      return null;
  }
}

/** True for the events that end a portal stream. */
export function isTerminalPortalEvent(event: PortalEvent): boolean {
  return event.type === 'done' || event.type === 'error' || event.type === 'stopped';
}

/** Serializes a public event as one SSE frame. */
export function toSseFrame(event: PortalEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
