/**
 * Shared fast-check arbitraries for the cloud-aws property test suites.
 *
 * These generators deliberately include the edge cases the design's testing
 * strategy classifies as EDGE_CASE, so they are covered by the surrounding
 * property rather than by extra tests:
 *
 * - Payload sizes straddling 300 KB and 64 KB
 * - State values straddling 32,768 UTF-8 bytes with astral-plane characters
 * - `ttlSec` values that are zero, negative, fractional and out of range
 * - Retention days of 0, 367 and 30.5
 * - Blank and invalid cron expressions
 * - 51 schedule-trigger nodes (exceeds the 50 cap)
 * - 0 and 32 secret keys
 *
 * This module imports nothing but `fast-check` and engine types. It adds no
 * runtime dependency to the cloud-aws package.
 */

import fc from 'fast-check';
import type { WorkflowNode } from '@phorma/engine';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** The 300 KB cap for run event payloads and journal entries (Req 3.10, 4.7). */
const CAP_300KB = 300 * 1024;

/** The 64 KB cap for Secret_Store write values (Req 8.15). */
const CAP_64KB = 64 * 1024;

/** The 32,768 UTF-8 byte cap for workflow state values (Req 5.5). */
const STATE_VALUE_BYTE_CAP = 32_768;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Count UTF-8 byte length of a string (no DOM dependency). */
function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.codePointAt(i)!;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else { bytes += 4; i++; } // skip the surrogate pair trail
  }
  return bytes;
}

/**
 * Generate a string of approximately `targetBytes` UTF-8 bytes using a mix of
 * ASCII and optional astral-plane characters. Astral-plane characters are 4
 * bytes in UTF-8, so they make byte/character-count mismatches likely.
 */
function stringOfApproxBytes(targetBytes: number, includeAstral: boolean): fc.Arbitrary<string> {
  return fc.integer({ min: -16, max: 16 }).chain(offset => {
    const desiredBytes = Math.max(0, targetBytes + offset);
    if (!includeAstral) {
      // Pure ASCII: 1 byte per character.
      return fc.string({ minLength: desiredBytes, maxLength: desiredBytes });
    }
    // Mix of ASCII (1 byte) and astral-plane (4 bytes each).
    // Target roughly `desiredBytes` by picking a mix.
    const astralCount = Math.floor(desiredBytes / 8); // ~half astral chars
    const asciiCount = Math.max(0, desiredBytes - astralCount * 4);
    return fc
      .tuple(
        fc.string({ minLength: asciiCount, maxLength: asciiCount }),
        fc.array(
          // Astral-plane characters: U+10000 to U+10FFFF
          fc.integer({ min: 0x10000, max: 0x10ffff }).map(cp => String.fromCodePoint(cp)),
          { minLength: astralCount, maxLength: astralCount },
        ),
      )
      .map(([ascii, astralChars]) => {
        // Interleave ASCII and astral characters
        const parts: string[] = [];
        let ai = 0;
        let si = 0;
        while (ai < ascii.length || si < astralChars.length) {
          if (ai < ascii.length) parts.push(ascii[ai++]);
          if (si < astralChars.length) parts.push(astralChars[si++]);
        }
        return parts.join('');
      });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Payload sizes straddling 300 KB
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates string payloads near the 300 KB boundary (both under and over).
 * Used by Property 11 (over-cap event truncation and over-cap journal failure).
 */
export function payloadStraddling300KB(): fc.Arbitrary<string> {
  return fc.oneof(
    // Just under 300 KB
    stringOfApproxBytes(CAP_300KB - 32, false),
    stringOfApproxBytes(CAP_300KB - 1, false),
    // Exactly at 300 KB
    stringOfApproxBytes(CAP_300KB, false),
    // Just over 300 KB
    stringOfApproxBytes(CAP_300KB + 1, false),
    stringOfApproxBytes(CAP_300KB + 32, false),
    stringOfApproxBytes(CAP_300KB + 1024, false),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Payload sizes straddling 64 KB
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates string payloads near the 64 KB boundary (Secret_Store write cap).
 * Used by Property 20 (connection resolution) and the Secret_Store write path.
 */
export function payloadStraddling64KB(): fc.Arbitrary<string> {
  return fc.oneof(
    // Just under 64 KB
    stringOfApproxBytes(CAP_64KB - 32, false),
    stringOfApproxBytes(CAP_64KB - 1, false),
    // Exactly at 64 KB
    stringOfApproxBytes(CAP_64KB, false),
    // Just over 64 KB
    stringOfApproxBytes(CAP_64KB + 1, false),
    stringOfApproxBytes(CAP_64KB + 32, false),
    stringOfApproxBytes(CAP_64KB + 1024, false),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. State values straddling 32,768 UTF-8 bytes with astral-plane characters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates strings near the 32,768 UTF-8 byte boundary, deliberately including
 * astral-plane characters (U+10000 to U+10FFFF) that are 4 bytes in UTF-8, so
 * the byte count diverges from the character count.
 *
 * Used by Property 16 (state store bounds, scoping and expiry).
 */
export function stateValueStraddling32768(): fc.Arbitrary<string> {
  return fc.oneof(
    // Just under the cap
    stringOfApproxBytes(STATE_VALUE_BYTE_CAP - 16, true),
    stringOfApproxBytes(STATE_VALUE_BYTE_CAP - 4, true),
    stringOfApproxBytes(STATE_VALUE_BYTE_CAP - 1, true),
    // At the cap
    stringOfApproxBytes(STATE_VALUE_BYTE_CAP, true),
    // Just over the cap
    stringOfApproxBytes(STATE_VALUE_BYTE_CAP + 1, true),
    stringOfApproxBytes(STATE_VALUE_BYTE_CAP + 4, true),
    stringOfApproxBytes(STATE_VALUE_BYTE_CAP + 16, true),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. ttlSec edge values
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates `ttlSec` values that exercise the edges: zero, negative, fractional
 * and out of range (very large). The state store must reject or handle each
 * correctly.
 *
 * Used by Property 16 (state store bounds, scoping and expiry).
 */
export function ttlSecEdge(): fc.Arbitrary<number> {
  return fc.oneof(
    // Zero
    fc.constant(0),
    // Negative values
    fc.constant(-1),
    fc.constant(-0.5),
    fc.integer({ min: -1_000_000, max: -1 }),
    // Fractional values
    fc.constant(0.5),
    fc.constant(1.5),
    fc.constant(30.7),
    fc.double({ min: 0.01, max: 1000, noNaN: true, noDefaultInfinity: true }),
    // Out of range (very large)
    fc.constant(Number.MAX_SAFE_INTEGER),
    fc.constant(2_147_483_648), // exceeds 32-bit signed int
    fc.constant(31_536_001), // just over 1 year in seconds
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Retention days edge values
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates retention day values that exercise the edges: 0 (below minimum),
 * 367 (above maximum of 366), 30.5 (fractional), and valid values within
 * the 1-366 range.
 *
 * Used by Property 13 (retention excludes expired items from reads).
 */
export function retentionDaysEdge(): fc.Arbitrary<number> {
  return fc.oneof(
    // Invalid: zero (below minimum of 1)
    fc.constant(0),
    // Invalid: above maximum of 366
    fc.constant(367),
    fc.constant(1000),
    // Invalid: fractional
    fc.constant(30.5),
    fc.constant(1.5),
    fc.constant(365.9),
    // Valid range: 1 to 366 whole days
    fc.constant(1),
    fc.constant(30),
    fc.constant(366),
    fc.integer({ min: 1, max: 366 }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Cron expression edge values
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates cron expressions exercising blanks, untranslatable expressions and
 * translatable ones, in both the five-field Unix and six-field AWS dialects.
 *
 * Classification here is deliberately NOT restated: a consumer asks
 * `core/cron.ts translateCron` whether a given case is usable. An earlier
 * version of this generator labelled plain five-field Unix expressions as "valid
 * cron" and the consuming property checked them against a copied Unix validator,
 * so the whole suite agreed on a classification AWS itself rejected. The
 * expressions below are the inputs; the translator is the only oracle.
 *
 * Used by Property 17 (deployed schedule set) and Property 18 (schedule push
 * atomicity).
 */
export function cronExpressionEdge(): fc.Arbitrary<string> {
  return fc.oneof(
    // Blank expressions (skipped rather than scheduled)
    fc.constant(''),
    fc.constant('   '),
    fc.constant('\t'),
    // Untranslatable expressions
    fc.constant('not a cron'),
    fc.constant('* * *'), // too few fields
    fc.constant('60 * * * *'), // minute out of range
    fc.constant('* 25 * * *'), // hour out of range
    fc.constant('* * 32 * *'), // day out of range
    fc.constant('* * * 13 *'), // month out of range
    fc.constant('* * * * 8'), // day of week out of range
    fc.constant('*/0 * * * *'), // zero step
    fc.constant('@invalid'), // unknown shorthand
    fc.constant('0 0 1 * 1'), // both day fields constrained - AWS accepts one
    fc.constant('0 0 ? * ? *'), // both day fields deferring - matches nothing
    fc.constant('cron(0 12 * * ? *)'), // already wrapped
    fc.constant('0 0 * * 6-0'), // Unix range wrapping past Sunday
    // Translatable, five-field Unix
    fc.constant('0 * * * *'), // every hour
    fc.constant('*/5 * * * *'), // every 5 minutes
    fc.constant('0 0 * * *'), // daily at midnight
    fc.constant('0 0 * * 1'), // every Monday
    fc.constant('0 0 * * 0'), // every Sunday, Unix numbering
    fc.constant('0 0 1 * *'), // first of month
    fc.constant('30 2 * * 1-5'), // weekdays at 2:30
    // Translatable, six-field AWS. These were rejected outright before, because
    // the old validator ran parseInt('?') and got NaN.
    fc.constant('0 12 * * ? *'),
    fc.constant('0 0 ? * 2 *'),
    fc.constant('15 10 ? * 6L 2022-2023'),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Schedule-trigger nodes (51 nodes, exceeding the 50 cap)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a minimal schedule-trigger `WorkflowNode` with a given cron.
 */
function makeScheduleTriggerNode(index: number, cron: string): WorkflowNode {
  const id = `sched-node-${index}`;
  return {
    id,
    name: `Schedule ${index}`,
    kind: 'schedule-trigger',
    category: 'trigger',
    icon: 'ti ti-clock-play',
    position: { x: 0, y: index * 100 },
    ports: [
      { id: `${id}-out`, name: 'Out', role: 'message-out' },
    ],
    data: { cron },
  };
}

/**
 * Generates an array of exactly 51 schedule-trigger nodes, each with a
 * translatable cron expression. This exceeds the 50-node cap (Req 6.1) and is
 * used to verify that validation rejects the push before any schedule is
 * created.
 *
 * Every cron here must TRANSLATE, or the test would be proving the cron
 * rejection rather than the cap.
 *
 * Used by Property 18 (schedule push atomicity).
 */
export function scheduleTriggerNodes51(): fc.Arbitrary<WorkflowNode[]> {
  return fc.constant(
    Array.from({ length: 51 }, (_, i) => makeScheduleTriggerNode(i, `${i % 60} * * * *`)),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Secret key count edges (0 and 32)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates an array of secret key names with either 0 or 32 entries. 32 is
 * the maximum supported by the connection resolution path (Req 8.1).
 *
 * Used by Property 20 (connection resolution).
 */
export function secretKeyCountEdge(): fc.Arbitrary<string[]> {
  return fc.oneof(
    // Zero secret keys
    fc.constant([] as string[]),
    // Exactly 32 secret keys (the maximum)
    fc.constant(Array.from({ length: 32 }, (_, i) => `secret-key-${i}`)),
    // 32 keys with varied naming to exercise the normalisation path
    fc.array(
      fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
      { minLength: 32, maxLength: 32 },
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience re-exports for direct use in property tests
// ─────────────────────────────────────────────────────────────────────────────

export { utf8ByteLength, CAP_300KB, CAP_64KB, STATE_VALUE_BYTE_CAP };
