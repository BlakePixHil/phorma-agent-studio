import type { GroupRow } from '../core/models';
import { isOk, type AdminResult } from '../core/telemetry-api.service';

/**
 * The small amount of logic every view shares, in one place so the five views
 * cannot drift apart on it.
 *
 * Each view owns an Angular `resource()` whose loader calls one
 * `TelemetryApiService` method. A resource reports a failure through
 * `error()`, so the loader has to THROW rather than hand back a result object -
 * `unwrapAdminResult` is that translation, and it is the only one.
 */

/**
 * Copy for the two auth outcomes. The shell owns both surfaces (sign-in for
 * `no-session`, not-authorized for `forbidden`), so a view only ever shows these
 * for the instant before it is swapped out. Static strings: neither names an
 * allowlist detail (Requirement 10.4).
 */
export const SESSION_ENDED_REASON = 'Your session ended. Sign in again.';
export const NOT_AUTHORIZED_REASON = 'This account cannot view telemetry.';

/**
 * The value of a successful Admin_API call, or a throw carrying display copy.
 *
 * Throwing is what puts the view into its failed state with a retry control
 * (Requirement 10.12); returning is what puts it into loaded or empty.
 */
export function unwrapAdminResult<T>(result: AdminResult<T>): T {
  if (isOk(result)) return result.value;
  if (result.kind === 'forbidden') throw new Error(NOT_AUTHORIZED_REASON);
  if (result.kind === 'no-session') throw new Error(SESSION_ENDED_REASON);
  throw new Error(result.reason);
}

/**
 * One numeric metric of a group row.
 *
 * `GroupRow` carries an index signature of `string | number` because the Worker
 * sums whatever numeric metrics a row happens to have when it folds a group, so
 * a template cannot assume `row['runs']` is a number. Anything non-numeric reads
 * as 0 rather than rendering `undefined`.
 */
export function metricOf(row: GroupRow, key: string): number {
  const value = row[key];
  return typeof value === 'number' ? value : 0;
}

/**
 * Group rows ordered by reach, biggest first, with the label as the tie break so
 * the order is stable across refetches. Copies rather than sorting in place: the
 * argument is a resource value and mutating it would be a write to loaded state.
 */
export function byInstallsDesc(rows: readonly GroupRow[]): GroupRow[] {
  return [...rows].sort((a, b) => b.installs - a.installs || a.label.localeCompare(b.label));
}
