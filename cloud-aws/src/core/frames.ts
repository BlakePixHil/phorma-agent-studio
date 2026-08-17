/**
 * ControlFrame parsing and routing decisions.
 *
 * PURE - no AWS SDK import, no I/O, no state mutation. Accepts a parsed frame
 * and a set of pending suspensions, and returns one routing decision.
 *
 * The ControlFrame union is defined once in `cloud/src/workflow-agent.ts` and
 * reused unchanged. This module accepts exactly `approval`, `event`, `question`,
 * `trigger` and `stop` - adding no kind and removing no field.
 *
 * Requirements: 7.1, 7.3, 7.4, 7.5, 7.6, 7.15
 */

// ---------------------------------------------------------------------------
// ControlFrame union (mirrors cloud/src/workflow-agent.ts exactly)
// ---------------------------------------------------------------------------

export type ControlFrame =
  | { type: 'approval'; requestId: string; approved: boolean }
  | { type: 'event'; correlationKey: string; payload?: string }
  | { type: 'question'; requestId: string; response: string }
  | { type: 'trigger'; input?: string }
  | { type: 'stop' };

/** The five accepted frame kinds. */
export const FRAME_KINDS = ['approval', 'event', 'question', 'trigger', 'stop'] as const;
export type FrameKind = (typeof FRAME_KINDS)[number];

// ---------------------------------------------------------------------------
// Routing decisions
// ---------------------------------------------------------------------------

export type RoutingDecision =
  | { action: 'resolve-approval'; requestId: string; approved: boolean }
  | { action: 'resolve-question'; requestId: string; response: string }
  | { action: 'resolve-wait'; correlationKey: string; payload: string }
  | { action: 'buffer-event'; correlationKey: string; payload: string }
  | { action: 'start-run'; input: string }
  | { action: 'stop' }
  | { action: 'ignore' };

// ---------------------------------------------------------------------------
// Pending suspension context (read-only, never mutated here)
// ---------------------------------------------------------------------------

/** What the Runner currently has pending - passed in, never mutated. */
export interface PendingSuspensions {
  /** Set of approval requestIds currently awaiting resolution. */
  approvals: ReadonlySet<string>;
  /** Set of question requestIds currently awaiting resolution. */
  questions: ReadonlySet<string>;
  /** Set of correlationKeys currently being waited on. */
  waits: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Route a frame
// ---------------------------------------------------------------------------

/**
 * Given a parsed ControlFrame and the current pending suspensions, return one
 * routing decision. Touches no state.
 *
 * - `approval` -> `resolve-approval` when the requestId is pending, else `ignore`
 * - `question` -> `resolve-question` when the requestId is pending, else `ignore`
 * - `event` -> `resolve-wait` when a waiter is registered for the correlationKey,
 *              else `buffer-event` (the early-event buffering rule of Req 7.5)
 * - `trigger` -> `start-run`
 * - `stop` -> `stop`
 * - anything else -> `ignore`
 */
export function routeFrame(frame: ControlFrame, pending: PendingSuspensions): RoutingDecision {
  switch (frame.type) {
    case 'approval': {
      if (pending.approvals.has(frame.requestId)) {
        return { action: 'resolve-approval', requestId: frame.requestId, approved: frame.approved };
      }
      return { action: 'ignore' };
    }

    case 'question': {
      if (pending.questions.has(frame.requestId)) {
        return { action: 'resolve-question', requestId: frame.requestId, response: frame.response };
      }
      return { action: 'ignore' };
    }

    case 'event': {
      const key = frame.correlationKey?.trim();
      if (!key) {
        return { action: 'ignore' };
      }
      const payload = frame.payload ?? '';
      if (pending.waits.has(key)) {
        return { action: 'resolve-wait', correlationKey: key, payload };
      }
      return { action: 'buffer-event', correlationKey: key, payload };
    }

    case 'trigger': {
      return { action: 'start-run', input: frame.input ?? '' };
    }

    case 'stop': {
      return { action: 'stop' };
    }

    default:
      return { action: 'ignore' };
  }
}

// ---------------------------------------------------------------------------
// Parse helper
// ---------------------------------------------------------------------------

/**
 * Attempt to parse a raw string as a ControlFrame. Returns undefined if it does
 * not parse or does not carry a known `type` (Req 7.15: ignore unparseable).
 */
export function parseFrame(raw: string): ControlFrame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== 'string') return undefined;
  if (!(FRAME_KINDS as readonly string[]).includes(type)) return undefined;
  return obj as unknown as ControlFrame;
}
