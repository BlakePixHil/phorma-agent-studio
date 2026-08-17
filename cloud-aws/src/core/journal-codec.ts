/**
 * Journal entry codec for the AWS Host_Adapter.
 *
 * Pure logic - no AWS SDK, no I/O. Encodes and decodes the engine's
 * `JournalEntry` shape (`output` + optional `viaPortIds`), enforces the
 * 300 KB cap, and treats unparseable entries as absent rather than failing.
 *
 * Requirements: 3.7, 3.8, 3.10
 */

import type { JournalEntry } from '@phorma/engine';

/** 300 KB in bytes - the maximum serialized journal entry size. */
const JOURNAL_ENTRY_CAP_BYTES = 300 * 1024;

/**
 * Serialize a `JournalEntry` to its JSON representation. Only the fields the
 * engine reads are included: `output` and optional `viaPortIds`.
 */
export function encodeJournalEntry(entry: JournalEntry): string {
  const payload: Record<string, unknown> = { output: entry.output };
  if (entry.viaPortIds !== undefined) {
    payload.viaPortIds = entry.viaPortIds;
  }
  return JSON.stringify(payload);
}

/**
 * Attempt to decode a raw value into a `JournalEntry`. Returns `undefined` if
 * parsing fails for any reason (Req 3.8: treat as absent, execute the node
 * normally and overwrite).
 */
export function decodeJournalEntry(raw: unknown): JournalEntry | undefined {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.output !== 'string') {
      return undefined;
    }
    const entry: JournalEntry = { output: obj.output };
    if (Array.isArray(obj.viaPortIds) && obj.viaPortIds.every((v: unknown) => typeof v === 'string')) {
      entry.viaPortIds = obj.viaPortIds as string[];
    } else if (obj.viaPortIds !== undefined) {
      // viaPortIds present but not a valid string array - treat whole entry as absent
      return undefined;
    }
    return entry;
  } catch {
    return undefined;
  }
}

/**
 * Check whether a serialized journal entry exceeds the 300 KB cap.
 * If over-cap, the run fails (Req 3.10: refuse to truncate).
 */
export function checkJournalEntryCap(serialized: string): 'ok' | 'over-cap' {
  return utf8ByteLength(serialized) > JOURNAL_ENTRY_CAP_BYTES ? 'over-cap' : 'ok';
}

/** Count UTF-8 byte length of a string without relying on TextEncoder (no DOM lib). */
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
