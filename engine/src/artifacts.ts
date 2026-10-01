/**
 * Run artifacts: binary content a step produces and later steps attach or
 * upload, addressed by reference so the bytes never pass through a payload, a
 * model prompt or a trace event.
 *
 * This module is the pure half: identity, caps, reference recognition and the
 * base64 codec every host shares. Storage is the host's `ArtifactStore`.
 */

import type { ArtifactRef } from './data-host.js';
import { resolveJsonPath } from './payload.js';
import { fnv1a } from './state.js';

/** Largest single artifact. Fits one Durable Object SQLite row without R2. */
export const ARTIFACT_MAX_BYTES = 1_048_576;

/** Largest total artifact size one run may hold. */
export const RUN_ARTIFACTS_MAX_BYTES = 16_777_216;

/** Most artifacts one run may hold. */
export const RUN_ARTIFACTS_MAX_COUNT = 200;

/** Longest artifact file name after sanitising. */
export const ARTIFACT_NAME_MAX_CHARS = 120;

/** Id shape every host may rely on for keys and URLs. */
export const ARTIFACT_ID_PATTERN = /^art-[0-9a-f]{8}-[0-9a-f]{8}$/;

/**
 * Deterministic artifact id. The run id plus the producing node's execution key
 * identify one node execution, and the name separates several files from one
 * execution, so a re-executed producer overwrites its own artifact.
 */
export function artifactId(runId: string, executionKey: string, name: string): string {
  return `art-${fnv1a(`${runId}|${executionKey}`)}-${fnv1a(name)}`;
}

/**
 * A safe file name: no path separators, control characters or characters that
 * Windows refuses, whitespace collapsed, at most {@link ARTIFACT_NAME_MAX_CHARS}
 * characters, and ending in `.{extension}` exactly once.
 */
export function sanitizeArtifactName(raw: string, extension: string): string {
  const ext = extension.replace(/^\.+/, '').toLowerCase();
  const suffix = ext.length > 0 ? `.${ext}` : '';
  let name = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (suffix && name.toLowerCase().endsWith(suffix)) name = name.slice(0, -suffix.length).trimEnd();
  if (name.length === 0) name = 'document';
  const room = Math.max(1, ARTIFACT_NAME_MAX_CHARS - suffix.length);
  if (name.length > room) name = name.slice(0, room).trimEnd();
  return `${name}${suffix}`;
}

/** True when a value has the exact shape of an {@link ArtifactRef}. */
export function isArtifactRef(value: unknown): value is ArtifactRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    ARTIFACT_ID_PATTERN.test(record['id']) &&
    typeof record['name'] === 'string' &&
    typeof record['mimeType'] === 'string' &&
    typeof record['sizeBytes'] === 'number' &&
    Number.isInteger(record['sizeBytes']) &&
    record['sizeBytes'] >= 0
  );
}

/**
 * The artifact references a list of dotted payload paths resolves to, in path
 * order. A path may hold one reference or an array of them; nulls inside an
 * array are skipped (a loop's skipped items). Anything else is an error naming
 * the path, because a misconfigured attachment must not silently send nothing.
 */
export function collectArtifactRefs(payload: string, paths: readonly string[]): ArtifactRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    parsed = undefined;
  }
  const refs: ArtifactRef[] = [];
  for (const raw of paths) {
    const path = raw.trim();
    if (path.length === 0) continue;
    const value = resolveJsonPath(parsed, path);
    if (value === undefined || value === null) {
      throw new Error(`No file reference at payload path "${path}".`);
    }
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (item === null) continue;
      if (!isArtifactRef(item)) {
        throw new Error(`The value at payload path "${path}" is not a file reference.`);
      }
      refs.push(item);
    }
  }
  return refs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Base64 (RFC 4648), shared by every host so encode and decode agree exactly
// ─────────────────────────────────────────────────────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX: Readonly<Record<string, number>> = Object.fromEntries(
  [...B64].map((char, index) => [char, index]),
);

/** Standard base64 with padding. */
export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += `${B64[(n >> 18) & 63]!}${B64[(n >> 12) & 63]!}==`;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += `${B64[(n >> 18) & 63]!}${B64[(n >> 12) & 63]!}${B64[(n >> 6) & 63]!}=`;
  }
  return out;
}

/** Decodes standard base64, ignoring whitespace. Throws on any other character. */
export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '').replace(/=+$/, '');
  if (clean.length % 4 === 1) throw new Error('Invalid base64 length.');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (const char of clean) {
    const value = B64_INDEX[char];
    if (value === undefined) throw new Error('Invalid base64 character.');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/** UTF-8 bytes of a string. */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
