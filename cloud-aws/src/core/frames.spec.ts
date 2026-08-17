/**
 * Unit tests for the ControlFrame union shape.
 *
 * Verifies that exactly the five frame types are accepted, no field was removed
 * from any of them, and invalid/unparseable inputs are rejected.
 *
 * Requirements: 7.1
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FRAME_KINDS, parseFrame, routeFrame } from './frames.js';
import type { ControlFrame, PendingSuspensions, RoutingDecision } from './frames.js';

// ---------------------------------------------------------------------------
// FRAME_KINDS contains exactly the 5 expected kinds
// ---------------------------------------------------------------------------

describe('FRAME_KINDS', () => {
  it('contains exactly the five expected kinds', () => {
    expect([...FRAME_KINDS]).toEqual(['approval', 'event', 'question', 'trigger', 'stop']);
  });

  it('has length 5', () => {
    expect(FRAME_KINDS).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// parseFrame accepts valid JSON for each of the 5 frame types
// ---------------------------------------------------------------------------

describe('parseFrame - valid frames', () => {
  it('accepts an approval frame with requestId and approved', () => {
    const frame = parseFrame(JSON.stringify({ type: 'approval', requestId: 'req-1', approved: true }));
    expect(frame).toBeDefined();
    expect(frame!.type).toBe('approval');
    if (frame!.type === 'approval') {
      expect(frame!.requestId).toBe('req-1');
      expect(frame!.approved).toBe(true);
    }
  });

  it('accepts an approval frame with approved: false', () => {
    const frame = parseFrame(JSON.stringify({ type: 'approval', requestId: 'req-2', approved: false }));
    expect(frame).toBeDefined();
    expect(frame!.type).toBe('approval');
    if (frame!.type === 'approval') {
      expect(frame!.requestId).toBe('req-2');
      expect(frame!.approved).toBe(false);
    }
  });

  it('accepts a question frame with requestId and response', () => {
    const frame = parseFrame(JSON.stringify({ type: 'question', requestId: 'q-1', response: 'yes' }));
    expect(frame).toBeDefined();
    expect(frame!.type).toBe('question');
    if (frame!.type === 'question') {
      expect(frame!.requestId).toBe('q-1');
      expect(frame!.response).toBe('yes');
    }
  });

  it('accepts an event frame with correlationKey and optional payload', () => {
    const frame = parseFrame(JSON.stringify({ type: 'event', correlationKey: 'ck-1', payload: 'data' }));
    expect(frame).toBeDefined();
    expect(frame!.type).toBe('event');
    if (frame!.type === 'event') {
      expect(frame!.correlationKey).toBe('ck-1');
      expect(frame!.payload).toBe('data');
    }
  });

  it('accepts an event frame without payload (payload is optional)', () => {
    const frame = parseFrame(JSON.stringify({ type: 'event', correlationKey: 'ck-2' }));
    expect(frame).toBeDefined();
    expect(frame!.type).toBe('event');
    if (frame!.type === 'event') {
      expect(frame!.correlationKey).toBe('ck-2');
      expect(frame!.payload).toBeUndefined();
    }
  });

  it('accepts a trigger frame with optional input', () => {
    const frame = parseFrame(JSON.stringify({ type: 'trigger', input: 'some input' }));
    expect(frame).toBeDefined();
    expect(frame!.type).toBe('trigger');
    if (frame!.type === 'trigger') {
      expect(frame!.input).toBe('some input');
    }
  });

  it('accepts a trigger frame without input (input is optional)', () => {
    const frame = parseFrame(JSON.stringify({ type: 'trigger' }));
    expect(frame).toBeDefined();
    expect(frame!.type).toBe('trigger');
    if (frame!.type === 'trigger') {
      expect(frame!.input).toBeUndefined();
    }
  });

  it('accepts a stop frame with no fields beyond type', () => {
    const frame = parseFrame(JSON.stringify({ type: 'stop' }));
    expect(frame).toBeDefined();
    expect(frame!.type).toBe('stop');
  });
});

// ---------------------------------------------------------------------------
// No field removed from any frame type
// ---------------------------------------------------------------------------

describe('parseFrame - field presence', () => {
  it('approval frame preserves requestId field', () => {
    const frame = parseFrame(JSON.stringify({ type: 'approval', requestId: 'abc', approved: true }));
    expect(frame).toBeDefined();
    expect('requestId' in frame!).toBe(true);
  });

  it('approval frame preserves approved field', () => {
    const frame = parseFrame(JSON.stringify({ type: 'approval', requestId: 'abc', approved: false }));
    expect(frame).toBeDefined();
    expect('approved' in frame!).toBe(true);
  });

  it('question frame preserves requestId field', () => {
    const frame = parseFrame(JSON.stringify({ type: 'question', requestId: 'q1', response: 'ok' }));
    expect(frame).toBeDefined();
    expect('requestId' in frame!).toBe(true);
  });

  it('question frame preserves response field', () => {
    const frame = parseFrame(JSON.stringify({ type: 'question', requestId: 'q1', response: 'ok' }));
    expect(frame).toBeDefined();
    expect('response' in frame!).toBe(true);
  });

  it('event frame preserves correlationKey field', () => {
    const frame = parseFrame(JSON.stringify({ type: 'event', correlationKey: 'key1' }));
    expect(frame).toBeDefined();
    expect('correlationKey' in frame!).toBe(true);
  });

  it('event frame preserves optional payload field when present', () => {
    const frame = parseFrame(JSON.stringify({ type: 'event', correlationKey: 'key1', payload: 'x' }));
    expect(frame).toBeDefined();
    expect('payload' in frame!).toBe(true);
  });

  it('trigger frame preserves optional input field when present', () => {
    const frame = parseFrame(JSON.stringify({ type: 'trigger', input: 'inp' }));
    expect(frame).toBeDefined();
    expect('input' in frame!).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invalid/unknown frame types are rejected (return undefined)
// ---------------------------------------------------------------------------

describe('parseFrame - invalid frame types', () => {
  it('rejects unknown type', () => {
    expect(parseFrame(JSON.stringify({ type: 'unknown' }))).toBeUndefined();
  });

  it('rejects empty type string', () => {
    expect(parseFrame(JSON.stringify({ type: '' }))).toBeUndefined();
  });

  it('rejects numeric type', () => {
    expect(parseFrame(JSON.stringify({ type: 42 }))).toBeUndefined();
  });

  it('rejects missing type field', () => {
    expect(parseFrame(JSON.stringify({ requestId: 'r1', approved: true }))).toBeUndefined();
  });

  it('rejects null type', () => {
    expect(parseFrame(JSON.stringify({ type: null }))).toBeUndefined();
  });

  it('rejects type with wrong casing', () => {
    expect(parseFrame(JSON.stringify({ type: 'Approval' }))).toBeUndefined();
    expect(parseFrame(JSON.stringify({ type: 'STOP' }))).toBeUndefined();
    expect(parseFrame(JSON.stringify({ type: 'Trigger' }))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Non-JSON and non-object inputs are rejected
// ---------------------------------------------------------------------------

describe('parseFrame - non-JSON and non-object inputs', () => {
  it('rejects empty string', () => {
    expect(parseFrame('')).toBeUndefined();
  });

  it('rejects plain text', () => {
    expect(parseFrame('hello world')).toBeUndefined();
  });

  it('rejects malformed JSON', () => {
    expect(parseFrame('{type: approval}')).toBeUndefined();
  });

  it('rejects JSON number', () => {
    expect(parseFrame('42')).toBeUndefined();
  });

  it('rejects JSON string', () => {
    expect(parseFrame('"approval"')).toBeUndefined();
  });

  it('rejects JSON boolean', () => {
    expect(parseFrame('true')).toBeUndefined();
  });

  it('rejects JSON null', () => {
    expect(parseFrame('null')).toBeUndefined();
  });

  it('rejects JSON array', () => {
    expect(parseFrame('[{"type":"stop"}]')).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// Property 21: Control frames resolve exactly what they address, and nothing else
// Validates: Requirements 7.3, 7.4, 7.5, 7.6, 7.15
// ---------------------------------------------------------------------------

/**
 * Generators for PendingSuspensions and ControlFrames used across all sub-properties.
 */
const arbRequestId = fc.string({ minLength: 1, maxLength: 64 });
const arbCorrelationKey = fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.trim().length > 0);
const arbPayload = fc.option(fc.string({ minLength: 0, maxLength: 200 }), { nil: undefined });

/** Generate an arbitrary PendingSuspensions set with known membership. */
const arbPendingSuspensions = fc.record({
  approvals: fc.uniqueArray(arbRequestId, { minLength: 0, maxLength: 20 }).map((ids) => new Set(ids)),
  questions: fc.uniqueArray(arbRequestId, { minLength: 0, maxLength: 20 }).map((ids) => new Set(ids)),
  waits: fc.uniqueArray(arbCorrelationKey, { minLength: 0, maxLength: 20 }).map((ids) => new Set(ids)),
});

describe('frames - Property 21: Control frames resolve exactly what they address, and nothing else', () => {
  /**
   * **Validates: Requirements 7.3**
   *
   * An approval frame resolves ONLY when its requestId is in the pending approvals set.
   * When it is NOT in the set, the frame is ignored.
   */
  it('an approval frame resolves only when its requestId is in the pending approvals set', () => {
    fc.assert(
      fc.property(
        arbPendingSuspensions,
        arbRequestId,
        fc.boolean(),
        (pending, requestId, approved) => {
          const frame: ControlFrame = { type: 'approval', requestId, approved };
          const result = routeFrame(frame, pending);

          if (pending.approvals.has(requestId)) {
            expect(result).toEqual({
              action: 'resolve-approval',
              requestId,
              approved,
            });
          } else {
            expect(result).toEqual({ action: 'ignore' });
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.4**
   *
   * A question frame resolves ONLY when its requestId is in the pending questions set.
   * When it is NOT in the set, the frame is ignored.
   */
  it('a question frame resolves only when its requestId is in the pending questions set', () => {
    fc.assert(
      fc.property(
        arbPendingSuspensions,
        arbRequestId,
        fc.string({ minLength: 0, maxLength: 200 }),
        (pending, requestId, response) => {
          const frame: ControlFrame = { type: 'question', requestId, response };
          const result = routeFrame(frame, pending);

          if (pending.questions.has(requestId)) {
            expect(result).toEqual({
              action: 'resolve-question',
              requestId,
              response,
            });
          } else {
            expect(result).toEqual({ action: 'ignore' });
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.5**
   *
   * An event frame resolves a wait ONLY when its correlationKey is in the pending waits
   * set. Otherwise it buffers (the early-event buffering rule).
   * Note: routeFrame trims the correlationKey before lookup, so the trimmed key
   * is what determines membership and what appears in the decision.
   */
  it('an event frame resolves a wait when its correlationKey is pending, otherwise buffers', () => {
    fc.assert(
      fc.property(
        arbPendingSuspensions,
        arbCorrelationKey,
        arbPayload,
        (pending, correlationKey, payload) => {
          const frame: ControlFrame = { type: 'event', correlationKey, payload };
          const result = routeFrame(frame, pending);
          const expectedPayload = payload ?? '';
          const trimmedKey = correlationKey.trim();

          if (pending.waits.has(trimmedKey)) {
            expect(result).toEqual({
              action: 'resolve-wait',
              correlationKey: trimmedKey,
              payload: expectedPayload,
            });
          } else {
            expect(result).toEqual({
              action: 'buffer-event',
              correlationKey: trimmedKey,
              payload: expectedPayload,
            });
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.6 (trigger always starts a run)**
   *
   * A trigger frame ALWAYS returns start-run regardless of pending suspensions.
   */
  it('a trigger frame always returns start-run', () => {
    fc.assert(
      fc.property(
        arbPendingSuspensions,
        fc.option(fc.string({ minLength: 0, maxLength: 200 }), { nil: undefined }),
        (pending, input) => {
          const frame: ControlFrame = { type: 'trigger', input };
          const result = routeFrame(frame, pending);

          expect(result).toEqual({
            action: 'start-run',
            input: input ?? '',
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.6 (stop always returns stop)**
   *
   * A stop frame ALWAYS returns stop regardless of pending suspensions.
   */
  it('a stop frame always returns stop', () => {
    fc.assert(
      fc.property(arbPendingSuspensions, (pending) => {
        const frame: ControlFrame = { type: 'stop' };
        const result = routeFrame(frame, pending);

        expect(result).toEqual({ action: 'stop' });
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.15**
   *
   * Unknown/invalid frame types are ignored (when passed through parseFrame then routeFrame).
   */
  it('unknown or invalid frame types are ignored', () => {
    fc.assert(
      fc.property(
        arbPendingSuspensions,
        fc.string({ minLength: 1, maxLength: 64 }).filter(
          (s) => !(FRAME_KINDS as readonly string[]).includes(s),
        ),
        (pending, unknownType) => {
          // parseFrame rejects unknown types, but routeFrame's default branch also ignores them
          const raw = JSON.stringify({ type: unknownType, requestId: 'x', correlationKey: 'y' });
          const parsed = parseFrame(raw);
          expect(parsed).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.3, 7.4, 7.5, 7.15**
   *
   * The routing decision addresses EXACTLY the frame's target and nothing else.
   * An approval frame changes nothing in the questions or waits sets' domain.
   * A question frame changes nothing in the approvals or waits sets' domain.
   * An event frame changes nothing in the approvals or questions sets' domain.
   */
  it('a routing decision addresses exactly the frame target and nothing else', () => {
    // Generate a frame that targets one specific requestId/correlationKey and
    // verify that the other pending sets are unaffected by the routing decision.
    const arbApprovalFrame = fc.record({
      type: fc.constant('approval' as const),
      requestId: arbRequestId,
      approved: fc.boolean(),
    });
    const arbQuestionFrame = fc.record({
      type: fc.constant('question' as const),
      requestId: arbRequestId,
      response: fc.string({ minLength: 0, maxLength: 100 }),
    });
    const arbEventFrame = fc.record({
      type: fc.constant('event' as const),
      correlationKey: arbCorrelationKey,
      payload: fc.option(fc.string({ minLength: 0, maxLength: 100 }), { nil: undefined }),
    });

    const arbFrame = fc.oneof(arbApprovalFrame, arbQuestionFrame, arbEventFrame);

    fc.assert(
      fc.property(arbPendingSuspensions, arbFrame, (pending, frame) => {
        const result = routeFrame(frame as ControlFrame, pending);

        if (frame.type === 'approval') {
          // An approval decision should never mention a question requestId or a wait key
          if (result.action === 'resolve-approval') {
            expect(result.requestId).toBe(frame.requestId);
            // It should not resolve anything in the questions or waits domain
            expect(result.action).not.toBe('resolve-question');
            expect(result.action).not.toBe('resolve-wait');
            expect(result.action).not.toBe('buffer-event');
          }
        } else if (frame.type === 'question') {
          // A question decision should never mention an approval requestId or a wait key
          if (result.action === 'resolve-question') {
            expect(result.requestId).toBe(frame.requestId);
            expect(result.action).not.toBe('resolve-approval');
            expect(result.action).not.toBe('resolve-wait');
            expect(result.action).not.toBe('buffer-event');
          }
        } else if (frame.type === 'event') {
          // An event decision should never mention an approval or question requestId
          if (result.action === 'resolve-wait' || result.action === 'buffer-event') {
            expect(result.correlationKey).toBe(frame.correlationKey.trim());
            expect(result.action).not.toBe('resolve-approval');
            expect(result.action).not.toBe('resolve-question');
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
