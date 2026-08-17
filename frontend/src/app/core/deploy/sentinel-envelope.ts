/**
 * Sentinel_Envelope decoder - the Studio half of the wire format between the
 * Phorma_AWS_CLI and this webview.
 *
 * A leaf module with pure functions: no `inject`, no Angular decorator, no DOM
 * beyond `atob`. `AwsRequestService` reads it; nothing here reads a service.
 *
 * The webview cannot import from `cloud-aws/`, so this is a SECOND
 * implementation of one format. `cloud-aws/src/core/sentinel.ts` is canonical
 * and owns the encoder; the names, the prefix and the reassembly rules below
 * must mirror it exactly. Drift is caught by the committed corpus at
 * `cloud-aws/test/fixtures/sentinel-corpus.json`, which the spec beside this
 * file replays through `decodeSentinelEnvelope`.
 *
 * Line framing, one line per chunk:
 *
 *     __phorma__:{seq}:{base64}
 *
 * Requirements: 10.5, 10.6, 11.3
 */

/** The line prefix that marks a line as envelope framing rather than operator output. */
export const SENTINEL_PREFIX = '__phorma__:';

/**
 * Decoding either yields the exact payload the encoder was handed, or names why
 * it could not. `missingSeq` is present only for the gap case, because that is
 * the number Requirement 10.6 makes the reader report.
 */
export type SentinelDecodeResult =
  { ok: true; payload: string } | { ok: false; error: string; missingSeq?: number };

/**
 * Reassemble an envelope from a stream of lines.
 *
 * Order of arrival is irrelevant: lines are collected into a map keyed by
 * sequence, so interleaved stderr, a reordered pipe or a line-buffered reader
 * all decode the same. Lines without the prefix are ordinary CLI output and are
 * IGNORED, not errors.
 *
 * A duplicate sequence carrying identical content is benign (a stream read
 * twice) and is dropped. A duplicate carrying DIFFERENT content is an error:
 * two writers or interleaved envelopes, and there is no way to pick a winner.
 *
 * The expected set is `0..max(seq)`; the LOWEST absent member is reported as
 * `missingSeq` (Req 10.6), so a set with holes at 2 and 5 reports 2.
 */
export function decodeSentinelEnvelope(lines: readonly string[]): SentinelDecodeResult {
  const chunks = new Map<number, string>();
  let maxSeq = -1;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith(SENTINEL_PREFIX)) continue;

    const rest = line.slice(SENTINEL_PREFIX.length);
    const colon = rest.indexOf(':');
    const digits = colon === -1 ? '' : rest.slice(0, colon);
    if (!/^\d+$/.test(digits)) {
      return {
        ok: false,
        error: `Sentinel envelope malformed: "${line}" carries no sequence number`,
      };
    }
    const seq = Number(digits);
    if (!Number.isSafeInteger(seq)) {
      return {
        ok: false,
        error: `Sentinel envelope malformed: sequence "${digits}" is out of range`,
      };
    }

    const chunk = rest.slice(colon + 1);
    const existing = chunks.get(seq);
    if (existing !== undefined) {
      if (existing === chunk) continue;
      return {
        ok: false,
        error: `Sentinel envelope conflict: sequence ${seq} arrived twice with differing content`,
      };
    }
    chunks.set(seq, chunk);
    if (seq > maxSeq) maxSeq = seq;
  }

  if (maxSeq === -1) {
    return { ok: false, error: 'Sentinel envelope missing: the command produced no sentinel line' };
  }

  for (let seq = 0; seq <= maxSeq; seq++) {
    if (!chunks.has(seq)) {
      return {
        ok: false,
        error: `Sentinel envelope incomplete: sequence ${seq} is missing`,
        missingSeq: seq,
      };
    }
  }

  // INVARIANT, do not "optimize" this away: every chunk is independently valid
  // UTF-8, because the encoder's chunker measures a BYTE budget and backs the
  // cut off any continuation byte, so a code point never straddles a line. That
  // is what makes decode-per-chunk-then-join-strings equal to
  // join-bytes-then-decode-once, which is what `cloud-aws/src/core/sentinel.ts`
  // does. Break the encoder's boundary rule and this loop starts producing
  // U+FFFD instead of the payload.
  let payload = '';
  for (let seq = 0; seq <= maxSeq; seq++) {
    const text = base64ToUtf8(chunks.get(seq)!);
    if (text === undefined) {
      return {
        ok: false,
        error: `Sentinel envelope malformed: sequence ${seq} is not valid base64`,
      };
    }
    payload += text;
  }
  return { ok: true, payload };
}

/**
 * One base64 chunk to text, `undefined` when the chunk is not decodable.
 *
 * `atob` yields latin1, one character per byte, so the bytes are lifted back
 * out character by character and run through a real UTF-8 decode.
 */
function base64ToUtf8(chunk: string): string | undefined {
  let binary: string;
  try {
    binary = atob(chunk);
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
  return new TextDecoder().decode(bytes);
}
