/**
 * Run event persistence pipeline for AWS_Host.
 *
 * Pure logic - no AWS SDK, no I/O. Processes a single RunEvent through a fixed
 * pipeline whose ORDER is load bearing for correctness:
 *
 *   1. Stamp the per-run sequence number
 *   2. Apply the node's payload-persistence setting (strip payload fields)
 *   3. Apply the Redactor to every string payload field
 *   4. Measure UTF-8 byte length of the serialized event
 *   5. If over 300 KB, truncate payload fields to fit and flag as truncated
 *   6. Return the processed event
 *
 * Redaction before measurement is deliberate: measuring first would let a
 * redacted payload land under the cap and a raw one over it, making truncation
 * depend on secret length.
 *
 * Requirements: 4.2, 4.6, 4.7, 11.6, 11.11
 */

import type { RunEvent } from '@phorma/engine';

// ─────────────────────────────────────────────────────────────────────────────
// Public interface
// ─────────────────────────────────────────────────────────────────────────────

export interface EventPipelineInput {
  event: RunEvent;
  sequence: number;
  persistPayload: boolean;
  redact?: (value: string) => string;
}

export interface EventPipelineOutput {
  event: RunEvent;
  sequence: number;
  truncated: boolean;
  withheld: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** 300 KB in bytes - the maximum event payload size (Req 4.7). */
const EVENT_PAYLOAD_CAP_BYTES = 300 * 1024;

/** Marker written when payload is withheld due to a Redactor failure (Req 11.11). */
const WITHHELD_MARKER = '[withheld]';

/** Marker written when payload-persistence is off for this node (Req 11.6). */
const NOT_PERSISTED_MARKER = '[not persisted]';

/**
 * Fields that are identity/metadata and must never be stripped, redacted or
 * truncated. Every other string field is a "payload field".
 */
const IDENTITY_FIELDS = new Set([
  'type',
  'runId',
  'nodeId',
  'requestId',
  'correlationKey',
  'toolNodeId',
  'connectionId',
  'fromNodeId',
  'toNodeId',
  'workflowId',
  'frameId',
]);

/**
 * Non-string fields that carry numeric or boolean data and should never be
 * treated as payload.
 */
const NON_PAYLOAD_FIELDS = new Set([
  'at',
  'scope',
  'status',
  'durationMs',
  'byteCount',
  'attempt',
  'maxAttempts',
  'delayMs',
  'beforeTokens',
  'afterTokens',
  'total',
  'index',
  'items',
  'hasMore',
  'paramCount',
  'rowCount',
  'found',
  'changed',
  'approved',
  'isError',
  'truncated',
  'replayed',
  'routed',
  'succeeded',
  'failed',
  'checked',
  'depth',
  'usage',
  'summary',
  'page',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process a single RunEvent through the persistence pipeline.
 *
 * The pipeline is PURE: it returns a new event object and never mutates the
 * input. The fixed order is what the property tests depend on.
 */
export function processEvent(input: EventPipelineInput): EventPipelineOutput {
  const { event, sequence, persistPayload, redact } = input;

  // Step 1: stamp sequence number. We work on a shallow copy.
  let processed: Record<string, unknown> = { ...event };

  // Step 2: apply payload-persistence setting.
  // If persistence is off, blank every payload field.
  if (!persistPayload) {
    processed = stripPayloadFields(processed);
  }

  // Step 3: apply the Redactor to every string payload field.
  let withheld = false;
  if (redact) {
    try {
      processed = redactPayloadFields(processed, redact);
    } catch {
      // Redactor failure: persist with no payload, marked as withheld (Req 11.11).
      processed = stripPayloadFields(processed, WITHHELD_MARKER);
      withheld = true;
    }
  }

  // Step 4 + 5: measure UTF-8 bytes and truncate if over 300 KB.
  let truncated = false;
  const serialized = JSON.stringify(processed);
  const totalBytes = utf8ByteLength(serialized);

  if (totalBytes > EVENT_PAYLOAD_CAP_BYTES) {
    processed = truncatePayloadFields(processed, EVENT_PAYLOAD_CAP_BYTES);
    truncated = true;
  }

  return {
    event: processed as unknown as RunEvent,
    sequence,
    truncated,
    withheld,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** True when a field key is a string payload field on an event record. */
function isPayloadField(key: string, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (IDENTITY_FIELDS.has(key)) return false;
  if (NON_PAYLOAD_FIELDS.has(key)) return false;
  return true;
}

/**
 * Strip all payload fields, replacing them with a marker.
 */
function stripPayloadFields(
  record: Record<string, unknown>,
  marker: string = NOT_PERSISTED_MARKER,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (isPayloadField(key, value)) {
      result[key] = marker;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Apply the redact function to every string payload field.
 * Throws if the redact function throws (caller handles as withheld).
 */
function redactPayloadFields(
  record: Record<string, unknown>,
  redact: (value: string) => string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (isPayloadField(key, value)) {
      result[key] = redact(value as string);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Truncate payload fields so the total serialized event fits within the byte
 * cap. Strategy: find all payload fields, measure the overhead from
 * non-payload, and distribute the remaining budget across payload fields
 * proportionally, then truncate each to its share.
 */
function truncatePayloadFields(
  record: Record<string, unknown>,
  capBytes: number,
): Record<string, unknown> {
  // Identify payload fields and their current byte sizes.
  const payloadKeys: string[] = [];
  const payloadSizes: number[] = [];
  let nonPayloadBytes = 0;

  // Build a version with empty payload fields to measure the structural overhead.
  const skeleton: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (isPayloadField(key, value)) {
      payloadKeys.push(key);
      payloadSizes.push(utf8ByteLength(value as string));
      skeleton[key] = '';
    } else {
      skeleton[key] = value;
    }
  }

  // The structural overhead is everything except the payload content itself.
  nonPayloadBytes = utf8ByteLength(JSON.stringify(skeleton));

  // Budget available for all payload fields combined (in bytes).
  const budget = Math.max(0, capBytes - nonPayloadBytes);

  if (payloadKeys.length === 0) {
    // No payload fields to truncate - return as-is (shouldn't normally happen).
    return record;
  }

  // Total payload bytes.
  const totalPayload = payloadSizes.reduce((sum, s) => sum + s, 0);

  // Distribute budget proportionally to each field's current size.
  const result: Record<string, unknown> = { ...record };
  for (let i = 0; i < payloadKeys.length; i++) {
    const key = payloadKeys[i];
    const value = record[key] as string;
    const fieldBudget =
      totalPayload > 0 ? Math.floor((payloadSizes[i] / totalPayload) * budget) : 0;
    result[key] = truncateUtf8(value, fieldBudget);
  }
  return result;
}

/**
 * Truncate a string to fit within `maxBytes` of UTF-8 encoding. Cuts at a
 * code-point boundary to avoid producing broken UTF-8.
 */
function truncateUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.codePointAt(i)!;
    let charBytes: number;
    if (code <= 0x7f) charBytes = 1;
    else if (code <= 0x7ff) charBytes = 2;
    else if (code <= 0xffff) charBytes = 3;
    else { charBytes = 4; }
    if (bytes + charBytes > maxBytes) return s.slice(0, i);
    bytes += charBytes;
    // Skip trail surrogate for astral characters.
    if (code > 0xffff) i++;
  }
  return s;
}

/** Count UTF-8 byte length of a string. */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.codePointAt(i)!;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else { bytes += 4; i++; }
  }
  return bytes;
}
