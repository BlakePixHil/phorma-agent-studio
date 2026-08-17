/**
 * Pure AWS error classification.
 *
 * This module is PURE: it inspects an unknown thrown value and answers a
 * question about it. No I/O, no AWS SDK import - which is what lets both
 * `src/aws/` production clients and the test fakes share one classifier
 * instead of production code importing an exception class from a fixture.
 *
 * `classify` is re-exported here so every error-classification decision has a
 * single import site, while its implementation stays beside the lease logic it
 * was written for.
 *
 * Feature: aws-byo-deploy
 * Requirements: 8.7, 8.10, 13.1
 */

export { classify } from './lease.js';

/** The API Gateway Management API error name for a connection that has gone away. */
const GONE_ERROR_NAME = 'GoneException';

/** The HTTP status API Gateway answers for a stale connection id. */
const GONE_HTTP_STATUS = 410;

/**
 * Read the first string-valued error-name field present on an error object.
 *
 * SDK errors carry the shape name on `name`; a raw protocol error may carry it
 * on `__type` as a fully-qualified shape id (`com.amazonaws...#GoneException`)
 * or on `code` / `Code`.
 */
function errorNames(error: Record<string, unknown>): string[] {
  const candidates = [error['name'], error['__type'], error['code'], error['Code']];
  return candidates.filter((value): value is string => typeof value === 'string');
}

/** Read the HTTP status an error reports, from the SDK metadata or a bare field. */
function httpStatusOf(error: Record<string, unknown>): number | undefined {
  const metadata = error['$metadata'] as Record<string, unknown> | undefined;
  const status = metadata?.['httpStatusCode'] ?? error['statusCode'] ?? error['status'];
  return typeof status === 'number' ? status : undefined;
}

/**
 * Whether a thrown value means the target WebSocket connection is gone.
 *
 * Matches `name === 'GoneException'` (in any of the fields an SDK or protocol
 * error may carry it) or an HTTP status of 410. Total: any value, including
 * `null`, `undefined` and primitives, yields a boolean (Req 8.7).
 */
export function isGoneError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;

  const record = error as Record<string, unknown>;

  for (const name of errorNames(record)) {
    if (name === GONE_ERROR_NAME || name.endsWith(`#${GONE_ERROR_NAME}`)) return true;
  }

  return httpStatusOf(record) === GONE_HTTP_STATUS;
}
