// Feature: aws-byo-deploy, Property 2: Sentinel gap detection names the first missing sequence
//
// `fast-check` is not a dependency of the `frontend` package (it lives in `engine`
// only) and must not be added, so this property is discharged by EXHAUSTIVE
// enumeration over a closed input space rather than by random sampling.
//
// The space is a product of four dimensions, each of which exercises a rule the
// decoder claims to honour:
//
//   size     1..6 sentinel lines, sequences 0..size-1 (a complete line set)
//   ordering ascending | descending | rotated  - arrival order is irrelevant
//   noise    none | interleaved                - non-prefixed lines are ignored
//   content  ascii | unicode                   - chunks are independently UTF-8
//
// 6 x 3 x 2 x 2 = 72 complete line sets. Every one is decoded unmutated, and
// then once per single mutation of the three declared kinds at every sequence
// position:
//
//   removed  the line carrying sequence k is deleted            (size cases)
//   dup      a SECOND line for sequence k with DIFFERING
//            content is inserted, at the front and at the end   (2 x size cases)
//   beyond   the line carrying sequence k is re-tagged with a
//            sequence past the range, max+1 and max+2           (2 x size cases)
//
// so 1 + 5 x size cases per complete line set, and 1332 cases in total. The
// exact count is asserted at the bottom of the enumeration, so shrinking the
// space silently is a test failure rather than a quiet loss of coverage.
//
// Expected outcomes are derived from the FORMAT RULES, never from what the
// decoder happens to return:
//
//   - the expected set is `0..max(seq)`, and the LOWEST absent member is the
//     reported `missingSeq` (Requirement 10.6)
//   - removing the HIGHEST sequence therefore lowers `max` instead of punching
//     a hole: it decodes ok with a truncated payload. The wire format has no
//     terminator line, so this is a property of the format, not a decoder bug
//   - removing the only sentinel line leaves no envelope at all, which is its
//     own error and carries NO `missingSeq`
//   - re-tagging sequence k as max+1 leaves one hole at k; as max+2 it leaves
//     holes at k AND at the old max, and the lower of the two is k
//   - a duplicate with differing content is a conflict, detected while
//     collecting and therefore reported instead of any gap, with no `missingSeq`

import {
  SENTINEL_PREFIX,
  decodeSentinelEnvelope,
  type SentinelDecodeResult,
} from './sentinel-envelope';
// The committed cross-package corpus itself, NOT a copy of it. See the Property 3
// block at the bottom of this file for why the import reaches out of `frontend`.
import sentinelCorpus from '@cloud-aws/sentinel-corpus.json';

/** Largest complete line set in the enumeration. */
const MAX_SIZE = 6;

type Ordering = 'ascending' | 'descending' | 'rotated';
type Noise = 'none' | 'interleaved';
type Content = 'ascii' | 'unicode';

const ORDERINGS: readonly Ordering[] = ['ascending', 'descending', 'rotated'];
const NOISES: readonly Noise[] = ['none', 'interleaved'];
const CONTENTS: readonly Content[] = ['ascii', 'unicode'];

/**
 * Ordinary CLI output. None of these starts with the sentinel prefix, so the
 * decoder must ignore every one of them rather than fail on them. The mention
 * of the prefix mid-line is deliberate: it must not be mistaken for framing.
 */
const NOISE_LINES: readonly string[] = [
  'aws cloudformation: creating change set',
  '',
  'stderr: retrying credential lookup',
  'log line that merely mentions __phorma__: somewhere inside it',
];

/** UTF-8 aware `btoa`, mirroring what the `cloud-aws` encoder emits. */
function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function sentinelLine(seq: number, text: string): string {
  return `${SENTINEL_PREFIX}${seq}:${utf8Base64(text)}`;
}

/** Per-sequence chunk text. Distinct per sequence so a swap cannot pass. */
function chunkText(content: Content, seq: number): string {
  return content === 'ascii' ? `chunk-${seq};` : `chunk-${seq}-\u00e9\u4e2d\u{1f680};`;
}

function orderedSeqs(size: number, ordering: Ordering): number[] {
  const ascending = Array.from({ length: size }, (_, i) => i);
  if (ordering === 'ascending') return ascending;
  if (ordering === 'descending') return [...ascending].reverse();
  return [...ascending.slice(1), ...ascending.slice(0, 1)];
}

interface CompleteSet {
  readonly size: number;
  readonly ordering: Ordering;
  readonly noise: Noise;
  readonly content: Content;
  /** The stream as the reader would see it, sentinel lines plus any noise. */
  readonly lines: readonly string[];
  /** Sentinel line for a sequence, used to locate it inside `lines`. */
  readonly lineFor: (seq: number) => string;
  /** Payload for a contiguous prefix `0..upTo` of the sequences. */
  readonly payloadUpTo: (upTo: number) => string;
  readonly label: string;
}

function buildCompleteSet(
  size: number,
  ordering: Ordering,
  noise: Noise,
  content: Content,
): CompleteSet {
  const lineFor = (seq: number) => sentinelLine(seq, chunkText(content, seq));
  const lines: string[] = [];
  orderedSeqs(size, ordering).forEach((seq, index) => {
    if (noise === 'interleaved') lines.push(NOISE_LINES[index % NOISE_LINES.length]);
    lines.push(lineFor(seq));
  });
  if (noise === 'interleaved') lines.push(NOISE_LINES[size % NOISE_LINES.length]);

  const payloadUpTo = (upTo: number) => {
    let payload = '';
    for (let seq = 0; seq <= upTo; seq++) payload += chunkText(content, seq);
    return payload;
  };

  return {
    size,
    ordering,
    noise,
    content,
    lines,
    lineFor,
    payloadUpTo,
    label: `size=${size} ordering=${ordering} noise=${noise} content=${content}`,
  };
}

const COMPLETE_SETS: readonly CompleteSet[] = (() => {
  const sets: CompleteSet[] = [];
  for (let size = 1; size <= MAX_SIZE; size++) {
    for (const ordering of ORDERINGS) {
      for (const noise of NOISES) {
        for (const content of CONTENTS) sets.push(buildCompleteSet(size, ordering, noise, content));
      }
    }
  }
  return sets;
})();

/** Replace the single occurrence of `line`, or drop it when `replacement` is null. */
function substitute(lines: readonly string[], line: string, replacement: string | null): string[] {
  const index = lines.indexOf(line);
  expect(index).withContext(`line "${line}" present exactly once`).toBeGreaterThan(-1);
  expect(lines.indexOf(line, index + 1))
    .withContext('no second occurrence')
    .toBe(-1);
  const next = [...lines];
  if (replacement === null) next.splice(index, 1);
  else next[index] = replacement;
  return next;
}

/**
 * Cases counted inside the running spec, guarding against silent shrinkage of
 * the enumeration. Reset per spec, because Jasmine may run specs in random
 * order and each spec therefore states its own count.
 */
let casesExercised = 0;

function assertGap(result: SentinelDecodeResult, expectedSeq: number, context: string): void {
  casesExercised++;
  expect(result.ok).withContext(`${context}: decoding must fail`).toBeFalse();
  if (result.ok) return;
  expect(result.missingSeq).withContext(`${context}: lowest missing sequence`).toBe(expectedSeq);
  expect(result.error)
    .withContext(`${context}: error names sequence ${expectedSeq}, got "${result.error}"`)
    .toContain(String(expectedSeq));
}

function assertFailureWithoutGap(
  result: SentinelDecodeResult,
  expectedErrorFragment: string,
  context: string,
): void {
  casesExercised++;
  expect(result.ok).withContext(`${context}: decoding must fail`).toBeFalse();
  if (result.ok) return;
  expect(result.missingSeq).withContext(`${context}: carries no missingSeq`).toBeUndefined();
  expect(result.error)
    .withContext(`${context}: error mentions "${expectedErrorFragment}", got "${result.error}"`)
    .toContain(expectedErrorFragment);
}

function assertPayload(result: SentinelDecodeResult, expected: string, context: string): void {
  casesExercised++;
  expect(result.ok)
    .withContext(`${context}: decoding must succeed, got ${JSON.stringify(result)}`)
    .toBeTrue();
  if (!result.ok) return;
  expect(result.payload).withContext(`${context}: payload`).toBe(expected);
}

/** Sentinel lines across the whole enumeration: 12 combos x sum(1..MAX_SIZE). */
const SENTINEL_LINE_COUNT =
  ORDERINGS.length * NOISES.length * CONTENTS.length * ((MAX_SIZE * (MAX_SIZE + 1)) / 2);

describe('Property 2: Sentinel gap detection names the first missing sequence', () => {
  beforeEach(() => {
    casesExercised = 0;
  });

  it('enumerates 72 complete line sets over size, arrival order, noise and content', () => {
    expect(COMPLETE_SETS.length).toBe(
      MAX_SIZE * ORDERINGS.length * NOISES.length * CONTENTS.length,
    );
    expect(COMPLETE_SETS.length).toBe(72);
    expect(SENTINEL_LINE_COUNT).toBe(252);
  });

  it('every unmutated complete line set decodes to the whole payload', () => {
    for (const set of COMPLETE_SETS) {
      assertPayload(decodeSentinelEnvelope(set.lines), set.payloadUpTo(set.size - 1), set.label);
    }
    expect(casesExercised).toBe(COMPLETE_SETS.length);
  });

  it('one line removed: a hole below the maximum names that hole', () => {
    for (const set of COMPLETE_SETS) {
      for (let k = 0; k < set.size; k++) {
        const lines = substitute(set.lines, set.lineFor(k), null);
        const result = decodeSentinelEnvelope(lines);
        const context = `${set.label} removed seq=${k}`;

        if (k < set.size - 1) {
          // The hole sits below max(seq), so it is the lowest absent member.
          assertGap(result, k, context);
        } else if (set.size > 1) {
          // Removing the highest sequence lowers max(seq) instead of punching a
          // hole: 0..max-1 is still complete, and the payload is truncated.
          assertPayload(result, set.payloadUpTo(set.size - 2), context);
        } else {
          // Nothing framed is left, which is not a gap and carries no missingSeq.
          assertFailureWithoutGap(result, 'no sentinel line', context);
        }
      }
    }
    expect(casesExercised).toBe(SENTINEL_LINE_COUNT);
  });

  it('one sequence duplicated with differing content: the conflict is reported, not a gap', () => {
    for (const set of COMPLETE_SETS) {
      for (let k = 0; k < set.size; k++) {
        const conflicting = sentinelLine(k, `${chunkText(set.content, k)}-other-writer`);
        expect(conflicting).not.toBe(set.lineFor(k));

        for (const at of ['front', 'end'] as const) {
          const lines = at === 'front' ? [conflicting, ...set.lines] : [...set.lines, conflicting];
          assertFailureWithoutGap(
            decodeSentinelEnvelope(lines),
            `sequence ${k} arrived twice`,
            `${set.label} duplicated seq=${k} at=${at}`,
          );
        }
      }
    }
    expect(casesExercised).toBe(2 * SENTINEL_LINE_COUNT);
  });

  it('one sequence replaced by a value beyond the range: the hole it leaves is named', () => {
    for (const set of COMPLETE_SETS) {
      const max = set.size - 1;
      for (let k = 0; k < set.size; k++) {
        for (const offset of [1, 2]) {
          // Re-tagging seq k as max+offset raises max AND leaves k absent. With
          // offset 2 the old max is absent as well, so there are two holes and
          // the lower one, k, is the answer.
          const beyond = max + offset;
          const lines = substitute(
            set.lines,
            set.lineFor(k),
            sentinelLine(beyond, chunkText(set.content, k)),
          );
          assertGap(
            decodeSentinelEnvelope(lines),
            k,
            `${set.label} seq=${k} retagged as ${beyond}`,
          );

          // State the hole shape independently of the decoder: the surviving
          // sequences are `0..max` without k, plus `beyond`, so the absent
          // members of `0..beyond` are k together with `max+1..beyond-1`. At
          // offset 2 that is two holes, which is the case that distinguishes a
          // lowest-first scan from a highest-first one.
          const present = new Set([...Array(set.size).keys()].filter((seq) => seq !== k));
          present.add(beyond);
          const holes = [...Array(beyond + 1).keys()].filter((seq) => !present.has(seq));
          expect(holes.length).withContext(`${set.label} seq=${k}: hole count`).toBe(offset);
          expect(holes[0]).withContext(`${set.label} seq=${k}: lowest hole`).toBe(k);
        }
      }
    }
    expect(casesExercised).toBe(2 * SENTINEL_LINE_COUNT);
  });

  it('covers 1332 enumerated cases in total', () => {
    // 72 unmutated sets plus 5 x size mutations each: sum over size 1..6 of
    // (1 + 5 x size), times the 12 ordering/noise/content combinations.
    let expected = 0;
    for (let size = 1; size <= MAX_SIZE; size++) {
      expected += (1 + 5 * size) * ORDERINGS.length * NOISES.length * CONTENTS.length;
    }
    expect(expected).toBe(COMPLETE_SETS.length + 5 * SENTINEL_LINE_COUNT);
    expect(expected).toBe(1332);
  });
});

// Feature: aws-byo-deploy, Property 3: Cross-package decoder agreement
//
// One wire format, two implementations: `cloud-aws/src/core/sentinel.ts` owns the
// encoder and the webview carries a decoder half it cannot import. This block is
// the only thing standing between that arrangement and silent drift, so it
// replays the COMMITTED output of the canonical encoder through the Studio
// decoder and demands the exact payload back.
//
// HOW THE CORPUS GETS HERE, and why it is not a copy:
//
//   `cloud-aws/scripts/gen-sentinel-corpus.mts` encodes each case through the
//   real `encodeSentinelEnvelope` and writes
//   `cloud-aws/test/fixtures/sentinel-corpus.json`. That file is imported above
//   through the `@cloud-aws/sentinel-corpus.json` tsconfig path alias
//   (`frontend/tsconfig.json`), which points at the fixture itself - the same
//   mechanism `@phorma/engine` already uses to reach out of this package. So the
//   bytes asserted here are the bytes `cloud-aws` committed, byte for byte, and
//   regeneration needs no second step in `frontend`: rerunning the generator
//   changes what this spec reads. A checked-in mirror under `src/` would have
//   given the two packages somewhere to disagree, which is the whole failure
//   mode the property exists to catch.
//
//   The other half of the loop lives in `cloud-aws`: `src/core/sentinel.spec.ts`
//   re-encodes every committed case through the encoder, so a codec change that
//   is not regenerated fails there, and one that IS regenerated but breaks the
//   decoder fails here.
//
// WHAT IS ASSERTED, per case:
//
//   - the corpus `prefix` equals `SENTINEL_PREFIX`, so a prefix change on either
//     side fails rather than quietly reframing the stream
//   - every committed line is well-formed framing with sequences 0..n-1
//   - decoding the committed lines yields the payload the encoder was handed
//   - the same holds under every arrival order and with interleaved CLI noise,
//     because real `run_streamed_command` output carries both
//   - each chunk decodes to text on its own with no U+FFFD, which is the claim
//     that makes the Studio's decode-per-chunk-then-concatenate equal to the
//     encoder's join-bytes-then-decode-once
//   - `chunk-boundary-straddle` is checked for TEETH: its first chunk must be
//     SHORTER than the byte budget and the byte at the budget offset must be a
//     UTF-8 continuation byte, so a blind cutter really would have split a code
//     point there. Without that check the case could pass by accident
//   - for the single-line cases the committed base64 equals what this package
//     produces from the payload, so the base64 and UTF-8 layers agree too

/** Field names come from `gen-sentinel-corpus.mts`; a rename fails to compile. */
interface CorpusCase {
  readonly name: string;
  readonly description: string;
  readonly payload: string;
  readonly lines: readonly string[];
}

interface SentinelCorpus {
  readonly prefix: string;
  readonly chunkBytes: number;
  readonly cases: readonly CorpusCase[];
}

const CORPUS: SentinelCorpus = sentinelCorpus;

/**
 * Every case the generator emits. Named here rather than derived from the file,
 * so dropping a case from the corpus is a failure instead of a smaller run.
 */
const EXPECTED_CASE_NAMES: readonly string[] = [
  'empty',
  'ascii',
  'astral-plane',
  'http-response',
  'multi-chunk',
  'chunk-boundary-straddle',
];

interface ParsedLine {
  readonly seq: number;
  readonly body: string;
}

/** Split framing from payload without using the decoder under test. */
function parseSentinelLine(line: string): ParsedLine | null {
  if (!line.startsWith(SENTINEL_PREFIX)) return null;
  const rest = line.slice(SENTINEL_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon === -1) return null;
  const digits = rest.slice(0, colon);
  if (!/^\d+$/.test(digits)) return null;
  return { seq: Number(digits), body: rest.slice(colon + 1) };
}

/**
 * Byte length of a line's chunk, or -1 when the line is not framing at all.
 *
 * The sentinel value keeps a prefix drift reporting as a failed size assertion
 * rather than as a `TypeError` on a null parse, which names nothing useful.
 */
function chunkByteLength(line: string): number {
  const parsed = parseSentinelLine(line);
  return parsed === null ? -1 : base64Bytes(parsed.body).length;
}

function base64Bytes(body: string): Uint8Array {
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
  return bytes;
}

/** Arrival orders a line-buffered reader can plausibly hand over. */
function arrivalOrders(lines: readonly string[]): ReadonlyMap<string, readonly string[]> {
  const rotated = lines.length > 1 ? [...lines.slice(1), lines[0]] : [...lines];
  return new Map<string, readonly string[]>([
    ['as-emitted', [...lines]],
    ['reversed', [...lines].reverse()],
    ['rotated', rotated],
  ]);
}

/**
 * Payload equality that names WHERE it diverged.
 *
 * The two multi-chunk cases carry 49 kB, so a bare `toBe` reports two walls of
 * `x` and Jasmine truncates whichever end mattered. This reports the length, the
 * first differing index and a short window around it, which is enough to tell a
 * reordered chunk from a corrupted code point at a glance.
 */
function expectPayload(actual: string, expected: string, context: string): void {
  expect(actual.length).withContext(`${context}: payload length`).toBe(expected.length);
  if (actual === expected) return;

  let at = 0;
  while (at < actual.length && at < expected.length && actual[at] === expected[at]) at++;
  const window = (text: string) => JSON.stringify(text.slice(Math.max(0, at - 8), at + 24));
  fail(
    `${context}: payload diverges at index ${at} of ${expected.length}: ` +
      `expected ${window(expected)}, got ${window(actual)}`,
  );
}

/** The same stream with ordinary CLI output woven between every framed line. */
function withNoise(lines: readonly string[]): string[] {
  const noisy: string[] = [];
  lines.forEach((line, index) => {
    noisy.push(NOISE_LINES[index % NOISE_LINES.length]);
    noisy.push(line);
  });
  noisy.push(NOISE_LINES[lines.length % NOISE_LINES.length]);
  return noisy;
}

describe('Property 3: Cross-package decoder agreement', () => {
  it('agrees with the corpus on the sentinel prefix', () => {
    // A prefix change on either side of the wire must land here: the decoder
    // would ignore every line the encoder emitted and report no envelope at all.
    expect(CORPUS.prefix).toBe(SENTINEL_PREFIX);
    expect(CORPUS.chunkBytes).toBeGreaterThan(0);
  });

  it('carries every expected case exactly once', () => {
    expect(CORPUS.cases.map((entry) => entry.name)).toEqual(EXPECTED_CASE_NAMES);
    for (const entry of CORPUS.cases) {
      expect(entry.lines.length).withContext(`${entry.name}: at least one line`).toBeGreaterThan(0);
      expect(entry.description).withContext(`${entry.name}: description`).not.toBe('');
    }
  });

  it('reproduces the committed base64 for every single-line case', () => {
    // The single-line cases pin the base64 and UTF-8 layers directly: this
    // package encodes the payload and must land on the byte string `cloud-aws`
    // committed. `empty`, `ascii`, `astral-plane` and `http-response` qualify.
    const singles = CORPUS.cases.filter((entry) => entry.lines.length === 1);
    expect(singles.length).toBe(4);
    for (const entry of singles) {
      expect(entry.lines[0])
        .withContext(`${entry.name}: committed line equals a Studio-side encode`)
        .toBe(sentinelLine(0, entry.payload));
      expect(parseSentinelLine(entry.lines[0])?.body)
        .withContext(`${entry.name}: committed base64`)
        .toBe(utf8Base64(entry.payload));
    }
  });

  for (const entry of CORPUS.cases) {
    describe(`corpus case "${entry.name}"`, () => {
      it('is framed with well-formed lines numbered 0..n-1', () => {
        const parsed = entry.lines.map((line) => parseSentinelLine(line));
        parsed.forEach((line, index) => {
          expect(line).withContext(`${entry.name}: line ${index} is framing`).not.toBeNull();
          expect(line?.seq).withContext(`${entry.name}: line ${index} sequence`).toBe(index);
        });
      });

      it('decodes to the exact payload the cloud-aws encoder was handed', () => {
        const result = decodeSentinelEnvelope(entry.lines);
        expect(result.ok)
          .withContext(`${entry.name}: ${JSON.stringify(result)}`)
          .toBeTrue();
        if (!result.ok) return;
        expectPayload(result.payload, entry.payload, entry.name);
      });

      it('decodes the same in any arrival order, with and without interleaved noise', () => {
        for (const [order, lines] of arrivalOrders(entry.lines)) {
          for (const [noise, stream] of [
            ['clean', lines],
            ['noisy', withNoise(lines)],
          ] as const) {
            const result = decodeSentinelEnvelope(stream);
            const context = `${entry.name} order=${order} noise=${noise}`;
            expect(result.ok)
              .withContext(`${context}: ${JSON.stringify(result.ok)}`)
              .toBeTrue();
            if (!result.ok) continue;
            expectPayload(result.payload, entry.payload, context);
          }
        }
      });

      it('carries chunks that are each independently valid UTF-8', () => {
        // The encoder's boundary rule is what licenses the Studio to decode each
        // chunk to a string and concatenate the strings. If a code point ever
        // straddled a line, the per-chunk decode would substitute U+FFFD here.
        const decoder = new TextDecoder();
        let rejoined = '';
        entry.lines.forEach((line, index) => {
          const parsed = parseSentinelLine(line);
          expect(parsed).withContext(`${entry.name}: line ${index} is framing`).not.toBeNull();
          if (parsed === null) return;
          const text = decoder.decode(base64Bytes(parsed.body));
          expect(text.includes('\uFFFD'))
            .withContext(`${entry.name}: chunk ${index} decoded without a replacement character`)
            .toBeFalse();
          rejoined += text;
        });
        expectPayload(rejoined, entry.payload, `${entry.name}: chunks concatenated`);
      });
    });
  }

  it('cuts every multi-chunk case inside the byte budget and off a continuation byte', () => {
    const multi = CORPUS.cases.filter((entry) => entry.lines.length > 1);
    expect(multi.map((entry) => entry.name)).toEqual(['multi-chunk', 'chunk-boundary-straddle']);

    for (const entry of multi) {
      const bytes = new TextEncoder().encode(entry.payload);
      const sizes = entry.lines.map((line) => chunkByteLength(line));
      const first = sizes[0];

      // The budget is a ceiling, and the back-off costs at most 3 bytes because a
      // code point is at most 4 bytes long.
      for (const size of sizes) {
        expect(size)
          .withContext(`${entry.name}: chunk within budget`)
          .toBeLessThanOrEqual(CORPUS.chunkBytes);
      }
      expect(first)
        .withContext(`${entry.name}: first chunk fills the budget to within 3 bytes`)
        .toBeGreaterThan(CORPUS.chunkBytes - 4);
      // Every cut lands on a code point start, never on 0b10xxxxxx.
      expect(bytes[first] & 0xc0)
        .withContext(`${entry.name}: byte at the cut starts a code point`)
        .not.toBe(0x80);
      expect(sizes.reduce((sum, size) => sum + size, 0))
        .withContext(`${entry.name}: chunk bytes sum to the payload`)
        .toBe(bytes.length);
    }
  });

  it('proves chunk-boundary-straddle would break a blind cutter', () => {
    // Without this the case is toothless: an encoder that cut blindly at the
    // budget would still produce a corpus, and the decode test would only fail if
    // the split happened to land mid-sequence. Assert that it does.
    const entry = CORPUS.cases.find((item) => item.name === 'chunk-boundary-straddle');
    expect(entry).withContext('chunk-boundary-straddle is present').toBeDefined();
    if (entry === undefined) return;

    const bytes = new TextEncoder().encode(entry.payload);
    const first = chunkByteLength(entry.lines[0]);

    // A blind cut at the budget lands INSIDE a code point here.
    expect(bytes.length).toBeGreaterThan(CORPUS.chunkBytes);
    expect(bytes[CORPUS.chunkBytes] & 0xc0)
      .withContext('the byte at the budget offset is a UTF-8 continuation byte')
      .toBe(0x80);
    // So the encoder must have cut EARLIER than the budget. If this ever equals
    // the budget, the case has stopped exercising the back-off.
    expect(first)
      .withContext('the first chunk is shorter than the byte budget')
      .toBeLessThan(CORPUS.chunkBytes);
    expect(bytes[first] & 0xf8)
      .withContext('the cut lands on the lead byte of the 4-byte code point')
      .toBe(0xf0);

    // And `multi-chunk`, whose payload is pure ASCII, is the control: nothing to
    // back off from, so it cuts exactly at the budget.
    const control = CORPUS.cases.find((item) => item.name === 'multi-chunk');
    expect(chunkByteLength(control?.lines[0] ?? ''))
      .withContext('multi-chunk cuts exactly at the byte budget')
      .toBe(CORPUS.chunkBytes);
  });
});
