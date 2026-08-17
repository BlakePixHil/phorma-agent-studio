/**
 * Property tests for the Sentinel_Envelope codec.
 *
 * Property 1: Sentinel envelope round trip.
 * Validates: Requirements 10.4, 10.5
 *
 * The codec is the wire format between the Phorma_AWS_CLI and the Studio, and the
 * Studio carries an independent decoder half. Two things are therefore pinned
 * here: the round trip through THIS implementation, and the per-chunk decode
 * agreement the Studio half depends on (each chunk is independently valid UTF-8,
 * so a decoder that decodes per chunk and concatenates STRINGS lands on the same
 * payload as this one, which concatenates BYTES and decodes once). The committed
 * corpus at `test/fixtures/sentinel-corpus.json` carries that contract across the
 * package boundary; the last describe block re-encodes it so it cannot drift.
 */

// Feature: aws-byo-deploy, Property 1: Sentinel envelope round trip

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  SENTINEL_CHUNK_BYTES,
  SENTINEL_PREFIX,
  decodeSentinelEnvelope,
  encodeSentinelEnvelope,
  type SentinelPayload,
} from './sentinel.js';
import corpus from '../../test/fixtures/sentinel-corpus.json';

/** Sequence numbers as the lines actually carry them, prefix asserted on the way through. */
function sequenceNumbers(lines: readonly string[]): readonly number[] {
  return lines.map((line) => {
    expect(line.startsWith(SENTINEL_PREFIX)).toBe(true);
    const rest = line.slice(SENTINEL_PREFIX.length);
    const colon = rest.indexOf(':');
    expect(colon).toBeGreaterThan(0);
    return Number(rest.slice(0, colon));
  });
}

/** The base64 body of a line, i.e. everything after `prefix{seq}:`. */
function chunkBody(line: string): string {
  const rest = line.slice(SENTINEL_PREFIX.length);
  return rest.slice(rest.indexOf(':') + 1);
}

function base64ToBytes(chunk: string): Uint8Array {
  const binary = atob(chunk);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * All three clauses of Property 1 plus the per-chunk independence the Studio
 * decoder relies on.
 */
function assertRoundTrip(payload: string, lines: readonly string[]): void {
  // Clause 3: at least one line, always.
  expect(lines.length).toBeGreaterThanOrEqual(1);

  // Clause 2: the sequence numbers are the contiguous range 0..n-1.
  expect(sequenceNumbers(lines)).toEqual(lines.map((_line, index) => index));

  // Clause 1: decoding yields EXACTLY the payload that was encoded.
  const decoded = decodeSentinelEnvelope(lines);
  if (!decoded.ok) throw new Error(`decode failed: ${decoded.error}`);
  expect(decoded.payload).toBe(payload);

  // Per-chunk independence: every chunk is valid base64 whose bytes are valid
  // UTF-8 on their own, within the byte budget, and decoding per chunk and
  // joining the strings reproduces the payload too.
  let perChunk = '';
  for (const line of lines) {
    const bytes = base64ToBytes(chunkBody(line));
    expect(bytes.length).toBeLessThanOrEqual(SENTINEL_CHUNK_BYTES);
    perChunk += new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  expect(perChunk).toBe(payload);
}

/** Short payloads that have historically broken hand-rolled framing. */
const hostileStringArb = fc.oneof(
  { weight: 3, arbitrary: fc.string({ unit: 'binary', maxLength: 200 }) },
  { weight: 2, arbitrary: fc.string({ unit: 'grapheme', maxLength: 120 }) },
  { weight: 1, arbitrary: fc.string({ unit: 'binary-ascii', maxLength: 200 }) },
  { weight: 1, arbitrary: fc.constant('') },
  // Text that looks like framing must survive as ordinary payload text.
  {
    weight: 1,
    arbitrary: fc
      .integer({ min: 0, max: 9 })
      .map((seq) => `${SENTINEL_PREFIX}${seq}:bm90LWFuLWVudmVsb3Bl`),
  },
  // Line discipline: LF, CRLF, lone CR and trailing/leading whitespace, which the
  // decoder trims per line and so must never be load-bearing inside a payload.
  {
    weight: 2,
    arbitrary: fc
      .array(fc.string({ unit: 'grapheme', maxLength: 20 }), { minLength: 1, maxLength: 6 })
      .chain((parts) =>
        fc
          .constantFrom('\n', '\r\n', '\r', ' \n ', '\t')
          .map((separator) => parts.join(separator)),
      ),
  },
  // Astral plane, ZWJ sequences, combining marks and the last legal code point.
  {
    weight: 2,
    arbitrary: fc
      .array(
        fc.constantFrom(
          '\u{1F642}',
          '\u{1D11E}',
          '\u{10FFFF}',
          '\u{1F469}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}',
          'cafe\u0301',
          '\u2603',
          '\u672B\u5C3E',
          '\u0000',
        ),
        { minLength: 1, maxLength: 40 },
      )
      .map((parts) => parts.join('')),
  },
);

/**
 * Payloads engineered to land on and around a chunk boundary: `lead` ASCII bytes
 * put a multi-byte pivot character exactly at, just before or just after byte
 * `k * SENTINEL_CHUNK_BYTES`, which is where the continuation-byte back-off in
 * the chunker is load-bearing. The 8-byte pad after the pivot keeps every
 * generated payload past the boundary (`lead` is at most 4 bytes short of it),
 * so these are always multi-chunk. Capped at two boundaries so 100 runs stay
 * quick.
 */
const chunkBoundaryPayloadArb = fc
  .record({
    boundaries: fc.integer({ min: 1, max: 2 }),
    shift: fc.integer({ min: 0, max: 4 }),
    pivot: fc.constantFrom('a', '\u00e9', '\u2603', '\u{1F642}'),
    tail: fc.string({ unit: 'binary', maxLength: 8 }),
  })
  .map(({ boundaries, shift, pivot, tail }) => {
    const lead = boundaries * SENTINEL_CHUNK_BYTES - shift;
    return 'x'.repeat(lead) + pivot + 'yyyyyyyy' + tail;
  });

/** The three payload kinds the six verbs carry back. */
const sentinelPayloadArb: fc.Arbitrary<SentinelPayload> = fc.oneof(
  fc.record({
    kind: fc.constant('http-response' as const),
    status: fc.integer({ min: 100, max: 599 }),
    headers: fc.dictionary(
      fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 24 }),
      fc.string({ unit: 'binary', maxLength: 64 }),
      { maxKeys: 6 },
    ),
    body: fc.string({ unit: 'binary', maxLength: 400 }),
  }),
  fc.record({
    kind: fc.constant('monitor-url' as const),
    url: fc.webUrl().map((url) => `${url}?X-Amz-Signature=${'a'.repeat(64)}`),
  }),
  fc.record(
    {
      kind: fc.constant('deploy-outputs' as const),
      triggerApiUrl: fc.webUrl(),
      monitorApiUrl: fc.webUrl(),
    },
    { requiredKeys: ['kind'] },
  ),
);

describe('sentinel - Property 1: Sentinel envelope round trip', () => {
  /**
   * **Validates: Requirements 10.4, 10.5**
   *
   * For any payload string, decoding the lines the encoder produced yields
   * exactly that payload, the sequence numbers are `0..n-1`, and at least one
   * line is emitted.
   */
  it('round-trips hostile payload strings exactly', () => {
    fc.assert(
      fc.property(hostileStringArb, (payload) => {
        assertRoundTrip(payload, encodeSentinelEnvelope(payload));
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 10.4, 10.5**
   *
   * The same three clauses where the chunker actually has to work: payloads
   * whose byte length lands on and adjacent to a chunk boundary, with a
   * multi-byte character sitting across the cut.
   */
  it('round-trips payloads that straddle chunk boundaries', () => {
    fc.assert(
      fc.property(chunkBoundaryPayloadArb, (payload) => {
        const lines = encodeSentinelEnvelope(payload);
        expect(lines.length).toBeGreaterThan(1);
        assertRoundTrip(payload, lines);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 10.4, 10.5**
   *
   * A `SentinelPayload` object round-trips through its JSON encoding, so the
   * caller gets back the same status, headers and body it sent.
   */
  it('round-trips SentinelPayload objects through their JSON encoding', () => {
    fc.assert(
      fc.property(sentinelPayloadArb, (payload) => {
        const lines = encodeSentinelEnvelope(payload);
        assertRoundTrip(JSON.stringify(payload), lines);
        const decoded = decodeSentinelEnvelope(lines);
        if (!decoded.ok) throw new Error(`decode failed: ${decoded.error}`);
        expect(JSON.parse(decoded.payload)).toEqual(payload);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 10.4, 10.5**
   *
   * The empty payload is the clause-3 witness: one line, and that line is
   * exactly the prefix with sequence 0 and an empty body.
   */
  it('emits exactly one empty-bodied line for the empty payload', () => {
    const lines = encodeSentinelEnvelope('');
    expect(lines).toEqual([`${SENTINEL_PREFIX}0:`]);
    expect(decodeSentinelEnvelope(lines)).toEqual({ ok: true, payload: '' });
  });

  /**
   * The round trip is byte-faithful, not UTF-16-faithful: a lone surrogate has
   * no UTF-8 encoding, so `TextEncoder` substitutes U+FFFD and it cannot come
   * back. Pinned so the generators above stay honest about their input space.
   */
  it('replaces a lone surrogate rather than round-tripping it', () => {
    const decoded = decodeSentinelEnvelope(encodeSentinelEnvelope('a\uD800b'));
    if (!decoded.ok) throw new Error(`decode failed: ${decoded.error}`);
    expect(decoded.payload).toBe('a\uFFFDb');
  });
});

describe('sentinel - cross-package corpus fixture', () => {
  const cases = corpus.cases;

  it('pins the framing constants the Studio half hard-codes', () => {
    expect(corpus.prefix).toBe(SENTINEL_PREFIX);
    expect(corpus.chunkBytes).toBe(SENTINEL_CHUNK_BYTES);
  });

  it('covers the empty, ASCII, astral-plane and multi-chunk cases', () => {
    const names = cases.map((entry) => entry.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'empty',
        'ascii',
        'astral-plane',
        'multi-chunk',
        'chunk-boundary-straddle',
      ]),
    );
    const multiChunk = cases.find((entry) => entry.name === 'multi-chunk')!;
    expect(multiChunk.lines.length).toBeGreaterThan(1);

    // The straddle case only earns its keep if a multi-byte character really
    // does span the byte offset a naive chunker would cut at.
    const straddle = cases.find((entry) => entry.name === 'chunk-boundary-straddle')!;
    const bytes = new TextEncoder().encode(straddle.payload);
    expect((bytes[SENTINEL_CHUNK_BYTES]! & 0xc0) === 0x80).toBe(true);
    expect(straddle.lines.length).toBeGreaterThan(1);
  });

  /**
   * Drift guard. Regenerate deliberately with
   * `cd cloud-aws; node_modules/.bin/tsx scripts/gen-sentinel-corpus.mts`.
   */
  it.each(corpus.cases.map((entry) => [entry.name, entry] as const))(
    'case %s matches the encoder and round-trips',
    (_name, entry) => {
      expect(encodeSentinelEnvelope(entry.payload)).toEqual(entry.lines);
      assertRoundTrip(entry.payload, entry.lines);
    },
  );
});
