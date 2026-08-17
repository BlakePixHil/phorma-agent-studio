/**
 * Sentinel_Envelope codec - the wire format between the Phorma_AWS_CLI and the
 * Studio.
 *
 * PURE - no AWS SDK import, no I/O, no `node:` import. This is the canonical
 * implementation: `cli/request.ts`, `cli/monitor-url.ts`, `cli/deploy.ts` and
 * `cli/outputs.ts` all encode through it, and the Studio carries a decoder half
 * with the same exported shape in
 * `frontend/src/app/core/deploy/sentinel-envelope.ts`. Drift between the two is
 * caught by the committed corpus at `cloud-aws/test/fixtures/sentinel-corpus.json`.
 *
 * Line framing, one line per chunk:
 *
 *     __phorma__:{seq}:{base64}
 *
 * Requirements: 10.4, 10.5, 10.6
 */

/** The line prefix that marks a line as envelope framing rather than operator output. */
export const SENTINEL_PREFIX = '__phorma__:';

/**
 * Maximum bytes of payload per line, a BYTE budget not a character count. The
 * chunker measures the UTF-8 encoding, so a multi-byte character can never
 * straddle a line boundary and corrupt the decode.
 */
export const SENTINEL_CHUNK_BYTES = 48 * 1024;

/**
 * The three payloads a verb can carry back. The envelope itself is
 * kind-agnostic - it moves a string - so this union exists to keep the six
 * verbs and the Studio agreeing on what that string parses to.
 */
export type SentinelPayload =
  /** `request`: an HTTP response, whatever its status (Req 10.4). */
  | {
      kind: 'http-response';
      status: number;
      headers: Readonly<Record<string, string>>;
      body: string;
    }
  /** `monitor-url`: the presigned WebSocket `$connect` URL. */
  | { kind: 'monitor-url'; url: string }
  /** `deploy` and `outputs`: the stack's two endpoint outputs, either possibly absent. */
  | { kind: 'deploy-outputs'; triggerApiUrl?: string; monitorApiUrl?: string };

/**
 * Decoding either yields the exact payload the encoder was handed, or names why
 * it could not. `missingSeq` is present only for the gap case, because that is
 * the number Requirement 10.6 makes the reader report.
 */
export type SentinelDecodeResult =
  | { ok: true; payload: string }
  | { ok: false; error: string; missingSeq?: number };

/**
 * Frame a payload as base64 chunks of its UTF-8 encoding, sequence `0..n-1`.
 *
 * ALWAYS emits at least one line, including for the empty payload. A zero-line
 * envelope is indistinguishable from "the verb printed nothing", which is a
 * different failure and deserves a different message.
 */
export function encodeSentinelEnvelope(payload: string | SentinelPayload): string[] {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const bytes = new TextEncoder().encode(text);
  const lines: string[] = [];
  let seq = 0;
  let offset = 0;
  do {
    const end = chunkEnd(bytes, offset);
    lines.push(`${SENTINEL_PREFIX}${seq}:${bytesToBase64(bytes.subarray(offset, end))}`);
    offset = end;
    seq++;
  } while (offset < bytes.length);
  return lines;
}

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
 * The expected set is `0..max(seq)`; the lowest absent member is reported as
 * `missingSeq` (Req 10.6). Chunks are base64-decoded individually and their
 * BYTES concatenated before a single UTF-8 decode, so a character split across
 * a chunk boundary still round-trips.
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
      return { ok: false, error: `Sentinel envelope malformed: "${line}" carries no sequence number` };
    }
    const seq = Number(digits);
    if (!Number.isSafeInteger(seq)) {
      return { ok: false, error: `Sentinel envelope malformed: sequence "${digits}" is out of range` };
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

  const decoded: Uint8Array[] = [];
  let total = 0;
  for (let seq = 0; seq <= maxSeq; seq++) {
    const bytes = base64ToBytes(chunks.get(seq)!);
    if (bytes === undefined) {
      return { ok: false, error: `Sentinel envelope malformed: sequence ${seq} is not valid base64` };
    }
    decoded.push(bytes);
    total += bytes.length;
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const bytes of decoded) {
    joined.set(bytes, offset);
    offset += bytes.length;
  }
  return { ok: true, payload: new TextDecoder().decode(joined) };
}

/**
 * End offset of the chunk starting at `start`: at most `SENTINEL_CHUNK_BYTES`
 * bytes, backed off so the cut never lands inside a UTF-8 sequence. A code
 * point is at most 4 bytes, so the back-off costs at most 3 bytes and the chunk
 * can never come back empty.
 */
function chunkEnd(bytes: Uint8Array, start: number): number {
  const limit = start + SENTINEL_CHUNK_BYTES;
  if (limit >= bytes.length) return bytes.length;
  let end = limit;
  // 0b10xxxxxx is a continuation byte, so it is never a code point boundary.
  while (end > start + 1 && (bytes[end]! & 0xc0) === 0x80) end--;
  return end;
}

/** Bytes to base64 through `btoa`, which is latin1-only, hence the byte-wise string. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Base64 to bytes, `undefined` when the chunk is not decodable. */
function base64ToBytes(chunk: string): Uint8Array | undefined {
  let binary: string;
  try {
    binary = atob(chunk);
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
  return bytes;
}
