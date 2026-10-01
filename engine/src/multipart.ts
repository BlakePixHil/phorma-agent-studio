/**
 * `multipart/form-data` encoding (RFC 7578) for `http-request` uploads (G5).
 *
 * Pure: parts in, bytes out. The boundary is derived from the parts, never from
 * a random source, so the same parts always produce the same body. That keeps a
 * fixture fingerprint and a journal key stable across retries and replays.
 */

import { utf8 } from './artifacts.js';
import { fnv1a } from './state.js';

export type MultipartPart =
  | { kind: 'field'; name: string; value: string }
  | { kind: 'file'; name: string; fileName: string; mimeType: string; bytes: Uint8Array };

export interface EncodedMultipart {
  /** Full header value, boundary included. */
  contentType: string;
  boundary: string;
  bytes: Uint8Array;
}

/** Quotes a header parameter value: `"` and `\` escaped, line breaks replaced. */
function quoteParam(value: string): string {
  return `"${value.replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** True when `needle` occurs anywhere in `haystack`. */
function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  const first = needle[0]!;
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    if (haystack[i] !== first) continue;
    for (let j = 1; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** The content bytes of every part, for the boundary collision check. */
function partBodies(parts: readonly MultipartPart[]): Uint8Array[] {
  return parts.map(part => (part.kind === 'file' ? part.bytes : utf8(part.value)));
}

/**
 * A boundary that occurs in no part. Seeded from part names and sizes, then
 * salted with a counter until it is collision-free; RFC 2046 limits a boundary
 * to 70 characters, and this one is 40.
 */
export function multipartBoundary(parts: readonly MultipartPart[]): string {
  const seed = parts
    .map(part => `${part.kind}:${part.name}:${part.kind === 'file' ? part.bytes.length : part.value.length}`)
    .join('|');
  const bodies = partBodies(parts);
  for (let salt = 0; ; salt += 1) {
    const boundary = `----phorma-${fnv1a(`${seed}#${salt}`)}${fnv1a(`${salt}#${seed}`)}x${salt}`;
    const marker = utf8(`--${boundary}`);
    if (!bodies.some(body => containsBytes(body, marker))) return boundary;
  }
}

/** Encodes the parts as one `multipart/form-data` body. */
export function encodeMultipart(parts: readonly MultipartPart[]): EncodedMultipart {
  const boundary = multipartBoundary(parts);
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    if (part.kind === 'field') {
      chunks.push(
        utf8(
          `--${boundary}\r\nContent-Disposition: form-data; name=${quoteParam(part.name)}\r\n\r\n`,
        ),
        utf8(part.value),
        utf8('\r\n'),
      );
    } else {
      chunks.push(
        utf8(
          `--${boundary}\r\nContent-Disposition: form-data; name=${quoteParam(part.name)}; ` +
            `filename=${quoteParam(part.fileName)}\r\nContent-Type: ${part.mimeType || 'application/octet-stream'}\r\n\r\n`,
        ),
        part.bytes,
        utf8('\r\n'),
      );
    }
  }
  chunks.push(utf8(`--${boundary}--\r\n`));

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { contentType: `multipart/form-data; boundary=${boundary}`, boundary, bytes };
}
