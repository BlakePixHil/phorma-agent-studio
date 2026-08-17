/**
 * TTL computation and read-time exclusion for Run_Table items.
 *
 * PURE - no AWS SDK import, no I/O. DynamoDB's TTL system eventually deletes
 * expired items, but removal is best-effort and can lag. The read-time
 * exclusion predicate filters expired items from every read BEFORE DynamoDB
 * removes them, so queries never serve stale data.
 *
 * Requirements: 4.8, 11.5, 11.10
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Milliseconds in one day. */
const MS_PER_DAY = 86_400_000;

/** Default retention period when none is configured. */
const DEFAULT_RETENTION_DAYS = 30;

/** Minimum allowed retention in days. */
const MIN_RETENTION_DAYS = 1;

/** Maximum allowed retention in days. */
const MAX_RETENTION_DAYS = 366;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate and normalise a retention-days value.
 *
 * Accepts 1 to 366 whole integer days. Returns the default of 30 when the
 * input is undefined or null. Throws on any value outside the range or
 * non-integer.
 */
export function validateRetentionDays(days: unknown): number {
  if (days === undefined || days === null) {
    return DEFAULT_RETENTION_DAYS;
  }

  if (typeof days !== 'number') {
    throw new RangeError(
      `retentionDays must be a number, got ${typeof days}.`,
    );
  }

  if (!Number.isInteger(days)) {
    throw new RangeError(
      `retentionDays must be a whole integer, got ${days}.`,
    );
  }

  if (days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
    throw new RangeError(
      `retentionDays must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}, got ${days}.`,
    );
  }

  return days;
}

/**
 * Compute the DynamoDB TTL attribute value (epoch seconds) for an item created
 * at `createdAtMs`. The item expires after `retentionDays` whole days.
 *
 * @param createdAtMs - creation timestamp in milliseconds since epoch
 * @param retentionDays - validated retention period (1-366), defaults to 30
 * @returns epoch seconds when the item expires
 */
export function computeTtl(createdAtMs: number, retentionDays?: number): number {
  const days = retentionDays ?? DEFAULT_RETENTION_DAYS;
  const expiryMs = createdAtMs + days * MS_PER_DAY;
  return Math.floor(expiryMs / 1000);
}

/**
 * Read-time exclusion predicate. Returns true when an item's TTL has passed,
 * meaning the item should be excluded from query results even though DynamoDB
 * may not have removed it yet.
 *
 * Items with no `ttl` attribute are never expired (they have no retention).
 *
 * @param item - an object with an optional `ttl` field (epoch seconds)
 * @param nowMs - current time in milliseconds since epoch
 * @returns true if the item is expired and should be excluded from reads
 */
export function isExpired(item: { ttl?: number }, nowMs: number): boolean {
  if (item.ttl === undefined || item.ttl === null) {
    return false;
  }
  const nowSec = Math.floor(nowMs / 1000);
  return nowSec >= item.ttl;
}
