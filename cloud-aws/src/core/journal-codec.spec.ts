/**
 * Property tests for the journal entry codec.
 *
 * Property 7: Journal entries round-trip, and an unreadable entry reads as absent.
 * Validates: Requirements 3.7, 3.8
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { encodeJournalEntry, decodeJournalEntry } from './journal-codec.js';

/** Arbitrary valid JournalEntry shapes the engine reads: output + optional viaPortIds. */
const journalEntryArb = fc.record(
  {
    output: fc.string(),
    viaPortIds: fc.array(fc.string(), { minLength: 0, maxLength: 10 }),
  },
  { requiredKeys: ['output'] },
);

describe('journal-codec - Property 7: round-trip and unreadable entries', () => {
  /**
   * **Validates: Requirements 3.7, 3.8**
   *
   * Encode then decode returns the original entry. Only the engine-read
   * fields survive: output (string) and optional viaPortIds (string[]).
   */
  it('round-trip: encode then decode returns the original entry', () => {
    fc.assert(
      fc.property(journalEntryArb, (entry) => {
        const encoded = encodeJournalEntry(entry);
        const decoded = decodeJournalEntry(encoded);

        expect(decoded).toBeDefined();
        expect(decoded!.output).toBe(entry.output);

        if (entry.viaPortIds !== undefined) {
          expect(decoded!.viaPortIds).toEqual(entry.viaPortIds);
        } else {
          expect(decoded!.viaPortIds).toBeUndefined();
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 3.7**
   *
   * Only the engine-read fields survive round-trip. Extra fields in the
   * input object are stripped by encode, so decode never returns them.
   */
  it('only engine-read fields survive: output and optional viaPortIds', () => {
    const entryWithExtrasArb = fc.record({
      output: fc.string(),
      viaPortIds: fc.option(fc.array(fc.string(), { minLength: 0, maxLength: 5 }), { nil: undefined }),
      extraField: fc.string(),
      anotherExtra: fc.integer(),
    });

    fc.assert(
      fc.property(entryWithExtrasArb, (entry) => {
        const encoded = encodeJournalEntry(entry as any);
        const decoded = decodeJournalEntry(encoded);

        expect(decoded).toBeDefined();
        // Only output and viaPortIds survive
        const keys = Object.keys(decoded!);
        for (const key of keys) {
          expect(['output', 'viaPortIds']).toContain(key);
        }
        expect(decoded!.output).toBe(entry.output);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 3.8**
   *
   * Invalid JSON decodes as undefined (absent).
   */
  it('invalid JSON decodes as undefined', () => {
    const invalidJsonArb = fc.oneof(
      fc.string().filter((s) => {
        try { JSON.parse(s); return false; } catch { return true; }
      }),
      fc.constant('{not json'),
      fc.constant(''),
      fc.constant('{'),
      fc.constant('['),
    );

    fc.assert(
      fc.property(invalidJsonArb, (raw) => {
        expect(decodeJournalEntry(raw)).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 3.8**
   *
   * Wrong types for required fields decode as undefined (absent).
   */
  it('wrong types for output decode as undefined', () => {
    const wrongOutputArb = fc.oneof(
      fc.integer().map((n) => JSON.stringify({ output: n })),
      fc.boolean().map((b) => JSON.stringify({ output: b })),
      fc.constant(JSON.stringify({ output: null })),
      fc.constant(JSON.stringify({ output: [] })),
      fc.constant(JSON.stringify({ output: {} })),
    );

    fc.assert(
      fc.property(wrongOutputArb, (raw) => {
        expect(decodeJournalEntry(raw)).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 3.8**
   *
   * Missing output field decodes as undefined (absent).
   */
  it('missing output field decodes as undefined', () => {
    const missingOutputArb = fc.oneof(
      fc.constant(JSON.stringify({})),
      fc.constant(JSON.stringify({ viaPortIds: ['a'] })),
      fc.string().map((s) => JSON.stringify({ notOutput: s })),
    );

    fc.assert(
      fc.property(missingOutputArb, (raw) => {
        expect(decodeJournalEntry(raw)).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 3.8**
   *
   * Invalid viaPortIds (present but not a valid string array) decodes as undefined.
   */
  it('invalid viaPortIds decodes as undefined', () => {
    const invalidViaPortIdsArb = fc.oneof(
      fc.constant(JSON.stringify({ output: 'ok', viaPortIds: 'not-an-array' })),
      fc.constant(JSON.stringify({ output: 'ok', viaPortIds: 42 })),
      fc.constant(JSON.stringify({ output: 'ok', viaPortIds: [1, 2, 3] })),
      fc.constant(JSON.stringify({ output: 'ok', viaPortIds: ['a', 1] })),
      fc.constant(JSON.stringify({ output: 'ok', viaPortIds: {} })),
    );

    fc.assert(
      fc.property(invalidViaPortIdsArb, (raw) => {
        expect(decodeJournalEntry(raw)).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 3.8**
   *
   * Non-string, non-object raw values decode as undefined (absent).
   */
  it('non-string non-object raw values decode as undefined', () => {
    const nonStringArb = fc.oneof(
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.constant(undefined),
      fc.array(fc.integer()),
    );

    fc.assert(
      fc.property(nonStringArb, (raw) => {
        expect(decodeJournalEntry(raw)).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });
});
