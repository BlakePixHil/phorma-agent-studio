/**
 * Unit tests and property tests for the run event persistence pipeline.
 *
 * Validates the fixed pipeline order and its edge cases:
 * - Sequence stamping
 * - Payload-persistence stripping
 * - Redactor application and failure handling
 * - 300 KB UTF-8 truncation
 *
 * Property 9: Run events are contiguously sequenced and read back in emission order.
 * Validates: Requirements 4.2
 *
 * Property 11: An over-cap event payload is truncated and flagged; an over-cap
 * journal entry fails the run.
 * Validates: Requirements 3.10, 4.7
 *
 * Requirements: 4.2, 4.6, 4.7, 11.6, 11.11
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { RunEvent } from '@phorma/engine';
import { processEvent, utf8ByteLength } from './events.js';
import { encodeJournalEntry, checkJournalEntryCap } from './journal-codec.js';
import { payloadStraddling300KB } from '../test/generators.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    type: 'node-completed',
    runId: 'run-1',
    nodeId: 'node-1',
    nodeName: 'Test Node',
    output: 'hello world',
    at: 1000,
    ...overrides,
  } as RunEvent;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Sequence stamping
// ─────────────────────────────────────────────────────────────────────────────

describe('events pipeline - sequence stamping', () => {
  it('stamps the provided sequence number on the output', () => {
    const result = processEvent({
      event: makeEvent(),
      sequence: 42,
      persistPayload: true,
    });
    expect(result.sequence).toBe(42);
  });

  it('preserves event identity fields', () => {
    const event = makeEvent({ type: 'node-completed', runId: 'run-abc', nodeId: 'node-xyz' });
    const result = processEvent({ event, sequence: 1, persistPayload: true });
    expect(result.event.type).toBe('node-completed');
    expect((result.event as any).runId).toBe('run-abc');
    expect((result.event as any).nodeId).toBe('node-xyz');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Payload persistence
// ─────────────────────────────────────────────────────────────────────────────

describe('events pipeline - payload persistence', () => {
  it('preserves payload when persistPayload is true', () => {
    const result = processEvent({
      event: makeEvent({ output: 'important data' } as any),
      sequence: 1,
      persistPayload: true,
    });
    expect((result.event as any).output).toBe('important data');
  });

  it('strips payload fields when persistPayload is false', () => {
    const result = processEvent({
      event: makeEvent({ output: 'secret data' } as any),
      sequence: 1,
      persistPayload: false,
    });
    expect((result.event as any).output).toBe('[not persisted]');
  });

  it('preserves identity fields even when persistPayload is false', () => {
    const result = processEvent({
      event: makeEvent(),
      sequence: 1,
      persistPayload: false,
    });
    expect(result.event.type).toBe('node-completed');
    expect((result.event as any).runId).toBe('run-1');
    expect((result.event as any).nodeId).toBe('node-1');
  });

  it('preserves numeric/boolean fields when persistPayload is false', () => {
    const result = processEvent({
      event: makeEvent({ at: 999 } as any),
      sequence: 1,
      persistPayload: false,
    });
    expect((result.event as any).at).toBe(999);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: Redaction
// ─────────────────────────────────────────────────────────────────────────────

describe('events pipeline - redaction', () => {
  it('applies the redact function to payload fields', () => {
    const result = processEvent({
      event: makeEvent({ output: 'my-secret-password' } as any),
      sequence: 1,
      persistPayload: true,
      redact: (v) => v.replace('secret', '***'),
    });
    expect((result.event as any).output).toBe('my-***-password');
  });

  it('does not redact identity fields', () => {
    const result = processEvent({
      event: makeEvent(),
      sequence: 1,
      persistPayload: true,
      redact: () => 'REDACTED',
    });
    // Identity fields must be preserved verbatim
    expect(result.event.type).toBe('node-completed');
    expect((result.event as any).runId).toBe('run-1');
    expect((result.event as any).nodeId).toBe('node-1');
  });

  it('marks event as withheld when redactor throws', () => {
    const result = processEvent({
      event: makeEvent({ output: 'data' } as any),
      sequence: 1,
      persistPayload: true,
      redact: () => { throw new Error('redactor failure'); },
    });
    expect(result.withheld).toBe(true);
    expect((result.event as any).output).toBe('[withheld]');
  });

  it('withheld event still has identity fields', () => {
    const result = processEvent({
      event: makeEvent(),
      sequence: 1,
      persistPayload: true,
      redact: () => { throw new Error('boom'); },
    });
    expect(result.event.type).toBe('node-completed');
    expect((result.event as any).runId).toBe('run-1');
    expect((result.event as any).nodeId).toBe('node-1');
  });

  it('skips redaction when no redactor is provided', () => {
    const result = processEvent({
      event: makeEvent({ output: 'unchanged' } as any),
      sequence: 1,
      persistPayload: true,
    });
    expect((result.event as any).output).toBe('unchanged');
    expect(result.withheld).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 + 5: Measurement and truncation
// ─────────────────────────────────────────────────────────────────────────────

describe('events pipeline - truncation', () => {
  it('does not truncate when event fits within 300 KB', () => {
    const result = processEvent({
      event: makeEvent({ output: 'small' } as any),
      sequence: 1,
      persistPayload: true,
    });
    expect(result.truncated).toBe(false);
    expect((result.event as any).output).toBe('small');
  });

  it('truncates payload fields when total exceeds 300 KB', () => {
    const bigPayload = 'x'.repeat(400 * 1024);
    const result = processEvent({
      event: makeEvent({ output: bigPayload } as any),
      sequence: 1,
      persistPayload: true,
    });
    expect(result.truncated).toBe(true);
    // The output must be shorter than the original
    expect((result.event as any).output.length).toBeLessThan(bigPayload.length);
    // And the whole serialized event should fit within 300 KB
    const serialized = JSON.stringify(result.event);
    expect(utf8ByteLength(serialized)).toBeLessThanOrEqual(300 * 1024);
  });

  it('flags truncated but does not modify identity fields', () => {
    const bigPayload = 'A'.repeat(400 * 1024);
    const result = processEvent({
      event: makeEvent({ output: bigPayload } as any),
      sequence: 1,
      persistPayload: true,
    });
    expect(result.truncated).toBe(true);
    expect(result.event.type).toBe('node-completed');
    expect((result.event as any).runId).toBe('run-1');
    expect((result.event as any).nodeId).toBe('node-1');
  });

  it('handles multi-byte characters in truncation', () => {
    // Astral plane characters (4 bytes each in UTF-8)
    const bigPayload = '\u{1F600}'.repeat(100 * 1024);
    const result = processEvent({
      event: makeEvent({ output: bigPayload } as any),
      sequence: 1,
      persistPayload: true,
    });
    expect(result.truncated).toBe(true);
    // Must not produce broken surrogate pairs
    const output = (result.event as any).output;
    for (let i = 0; i < output.length; i++) {
      const code = output.charCodeAt(i);
      // High surrogate must be followed by low surrogate
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = output.charCodeAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xdc00);
        expect(next).toBeLessThanOrEqual(0xdfff);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline order verification
// ─────────────────────────────────────────────────────────────────────────────

describe('events pipeline - order', () => {
  it('redaction happens before measurement (redacted content counts toward cap)', () => {
    // A payload that is under 300 KB raw, but the redactor expands it over cap.
    const payload = 'a'.repeat(200 * 1024);
    const result = processEvent({
      event: makeEvent({ output: payload } as any),
      sequence: 1,
      persistPayload: true,
      // Redactor doubles each character
      redact: (v) => v.split('').map(c => c + c).join(''),
    });
    // After redaction, the payload is ~400 KB which exceeds the cap.
    expect(result.truncated).toBe(true);
  });

  it('payload-persistence stripping happens before redaction', () => {
    // If persistPayload is false, the redactor should never see real payload.
    let redactCalled = false;
    const result = processEvent({
      event: makeEvent({ output: 'secret' } as any),
      sequence: 1,
      persistPayload: false,
      redact: (v) => { redactCalled = true; return v; },
    });
    // The redactor IS called on the stripped marker, but the payload is gone.
    expect((result.event as any).output).not.toBe('secret');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// utf8ByteLength
// ─────────────────────────────────────────────────────────────────────────────

describe('utf8ByteLength', () => {
  it('counts ASCII as 1 byte per char', () => {
    expect(utf8ByteLength('hello')).toBe(5);
  });

  it('counts 2-byte characters correctly', () => {
    // Latin characters with diacritics (U+00C0-U+00FF)
    expect(utf8ByteLength('\u00E9')).toBe(2); // e with accent
  });

  it('counts 3-byte characters correctly', () => {
    // CJK characters
    expect(utf8ByteLength('\u4E16')).toBe(3); // Chinese character
  });

  it('counts 4-byte characters (astral plane) correctly', () => {
    expect(utf8ByteLength('\u{1F600}')).toBe(4); // Emoji
  });

  it('counts mixed content correctly', () => {
    const mixed = 'A\u00E9\u4E16\u{1F600}'; // 1 + 2 + 3 + 4 = 10
    expect(utf8ByteLength(mixed)).toBe(10);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Property 9: Run events are contiguously sequenced and read back in emission order
// ─────────────────────────────────────────────────────────────────────────────

describe('events pipeline - Property 9: Run events are contiguously sequenced and read back in emission order', () => {
  /**
   * **Validates: Requirements 4.2**
   *
   * Emit a sequence of events with sequence numbers 1..N and verify:
   * - Each output carries the sequence number it was given
   * - When sorted by the zero-padded sort key derived from the sequence, the
   *   order matches the emission order with no gaps
   */
  it('sequence numbers from 1 increase by exactly 1 with no gaps', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        fc.array(
          fc.string({ minLength: 1, maxLength: 64 }),
          { minLength: 1, maxLength: 50 },
        ),
        (startSeq, payloads) => {
          const outputs = payloads.map((payload, i) => {
            const seq = startSeq + i;
            return processEvent({
              event: makeEvent({ output: payload } as any),
              sequence: seq,
              persistPayload: true,
            });
          });

          // Each output carries the sequence it was given
          for (let i = 0; i < outputs.length; i++) {
            expect(outputs[i].sequence).toBe(startSeq + i);
          }

          // Sequences are contiguous (increase by exactly 1)
          for (let i = 1; i < outputs.length; i++) {
            expect(outputs[i].sequence - outputs[i - 1].sequence).toBe(1);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.2**
   *
   * When events are processed and then sorted by a zero-padded 12-digit
   * sequence key (simulating the sort key in Run_Table), the order matches
   * the original emission order without requiring an in-memory sort.
   */
  it('sorting by zero-padded sequence key preserves emission order', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            payload: fc.string({ minLength: 0, maxLength: 128 }),
            persistPayload: fc.boolean(),
          }),
          { minLength: 1, maxLength: 100 },
        ),
        (inputs) => {
          // Process events with contiguous sequence numbers from 1
          const processed = inputs.map((input, i) =>
            processEvent({
              event: makeEvent({ output: input.payload } as any),
              sequence: i + 1,
              persistPayload: input.persistPayload,
            }),
          );

          // Derive the sort key as the zero-padded 12-digit sequence
          const withSortKeys = processed.map(output => ({
            output,
            sortKey: `event#${String(output.sequence).padStart(12, '0')}`,
          }));

          // Shuffle and re-sort by sort key (simulating DynamoDB ascending read)
          const shuffled = [...withSortKeys].sort(() => Math.random() - 0.5);
          const sorted = shuffled.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

          // After sorting, the emission order is restored
          for (let i = 0; i < sorted.length; i++) {
            expect(sorted[i].output.sequence).toBe(i + 1);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.2**
   *
   * Sequence numbers start at 1 and there is no zero or negative sequence.
   */
  it('the first sequence number of a run is always positive', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        (seq) => {
          const output = processEvent({
            event: makeEvent(),
            sequence: seq,
            persistPayload: true,
          });
          expect(output.sequence).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 11: An over-cap event payload is truncated and flagged;
//              an over-cap journal entry fails the run
// ─────────────────────────────────────────────────────────────────────────────

describe('events pipeline - Property 11: Over-cap event truncated and flagged; over-cap journal fails', () => {
  /**
   * **Validates: Requirements 4.7**
   *
   * An event whose serialized form exceeds 300 KB is truncated and flagged.
   * After truncation, the serialized event fits within 300 KB.
   * Redaction happens BEFORE measurement, so the test applies a redactor
   * that preserves length to verify the truncation path.
   *
   * Uses a multiplier-based generator to avoid fast-check shrinking stack overflow
   * on very large strings.
   */
  it('an over-cap event is truncated, flagged, and fits within 300 KB after processing', () => {
    // Multiplier generates strings of various sizes around 300 KB without
    // producing a shrinkable Arbitrary of 300K individual characters.
    const sizeArb = fc.oneof(
      fc.constant(300 * 1024 - 64),  // just under
      fc.constant(300 * 1024 - 1),   // one byte under
      fc.constant(300 * 1024),       // exactly at
      fc.constant(300 * 1024 + 1),   // one byte over
      fc.constant(300 * 1024 + 64),  // just over
      fc.constant(400 * 1024),       // well over
    );

    fc.assert(
      fc.property(sizeArb, (size) => {
        const payload = 'a'.repeat(size);
        const result = processEvent({
          event: makeEvent({ output: payload } as any),
          sequence: 1,
          persistPayload: true,
          redact: (v) => v, // identity redactor - no change
        });

        const serialized = JSON.stringify(result.event);
        const totalBytes = utf8ByteLength(serialized);

        // If the original event was over cap, it must be truncated and flagged
        const originalBytes = utf8ByteLength(JSON.stringify(makeEvent({ output: payload } as any)));
        if (originalBytes > 300 * 1024) {
          expect(result.truncated).toBe(true);
        }

        // Whether truncated or not, the final event is always <= 300 KB
        expect(totalBytes).toBeLessThanOrEqual(300 * 1024);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 3.10**
   *
   * An over-cap journal entry returns 'over-cap' from checkJournalEntryCap,
   * signalling a run failure. The journal codec refuses to truncate.
   */
  it('an over-cap journal entry is detected as over-cap (run failure decision)', () => {
    fc.assert(
      fc.property(
        payloadStraddling300KB(),
        (payload) => {
          const entry = { output: payload };
          const encoded = encodeJournalEntry(entry);
          const byteLength = utf8ByteLength(encoded);
          const decision = checkJournalEntryCap(encoded);

          if (byteLength > 300 * 1024) {
            expect(decision).toBe('over-cap');
          } else {
            expect(decision).toBe('ok');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.7, 3.10**
   *
   * Redaction happens BEFORE measurement. If a redactor expands a payload that
   * was under 300 KB to over 300 KB, the event is truncated (not the journal
   * entry - that would have been written before redaction has an effect on it).
   *
   * Uses a fixed-size base string to avoid stack overflow in fast-check shrinking.
   */
  it('redaction happens before measurement: a redactor expanding payload triggers truncation', () => {
    // Use sizes that, when doubled, will exceed 300 KB
    const sizeArb = fc.integer({ min: 155 * 1024, max: 160 * 1024 });

    fc.assert(
      fc.property(sizeArb, (size) => {
        const payload = 'a'.repeat(size);
        const result = processEvent({
          event: makeEvent({ output: payload } as any),
          sequence: 1,
          persistPayload: true,
          // Redactor doubles each character, pushing over 300 KB
          redact: (v) => v + v,
        });

        // After the doubling redactor, the payload exceeds 300 KB,
        // so the event must be truncated
        expect(result.truncated).toBe(true);

        // And the final event fits within 300 KB
        const serialized = JSON.stringify(result.event);
        expect(utf8ByteLength(serialized)).toBeLessThanOrEqual(300 * 1024);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.7**
   *
   * A truncated event preserves its identity fields unchanged.
   */
  it('a truncated event preserves identity fields unchanged', () => {
    fc.assert(
      fc.property(
        payloadStraddling300KB(),
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.string({ minLength: 1, maxLength: 64 }),
        (payload, runId, nodeId) => {
          const event = makeEvent({ output: payload, runId, nodeId } as any);
          const result = processEvent({
            event,
            sequence: 42,
            persistPayload: true,
          });

          // Identity fields are always preserved, even on truncation
          expect((result.event as any).runId).toBe(runId);
          expect((result.event as any).nodeId).toBe(nodeId);
          expect(result.event.type).toBe('node-completed');
        },
      ),
      { numRuns: 100 },
    );
  });
});
