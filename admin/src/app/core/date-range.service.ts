import { Injectable, computed, signal } from '@angular/core';

import type { DateRange } from './models';

/**
 * The SINGLE date range every view binds to (Requirement 10.10).
 *
 * One signal, one source of truth. The header control writes it and each view's
 * `resource()` is keyed on it, so changing the range refetches every bound view
 * with no manual wiring and no fan-out list to keep in sync.
 *
 * The signal is kept VALID at all times: `setRange` rejects anything the
 * Admin_API would answer HTTP 400 for, so a view can never issue a request that
 * is guaranteed to fail. The bounds below are twins of
 * `TELEMETRY_RANGE_DEFAULT_DAYS` and `TELEMETRY_RANGE_MAX_DAYS` in
 * `cloud/src/telemetry-admin.ts`.
 */

/** Inclusive length of the range the dashboard opens on. */
export const DEFAULT_RANGE_DAYS = 30;

/** Maximum inclusive length the Admin_API accepts. */
export const MAX_RANGE_DAYS = 400;

/** The trailing windows the header offers as one-click presets. */
export const RANGE_PRESET_DAYS = [7, 30, 90] as const;

export type RangePresetDays = (typeof RANGE_PRESET_DAYS)[number];

const MS_PER_DAY = 86_400_000;
const METRIC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A real `YYYY-MM-DD` calendar day. The shape test alone is not enough:
 * `2026-02-30` matches it and `Date.parse` rolls it over to March 2, so the
 * round-trip through `Date` is what rejects it.
 */
export function isMetricDay(value: string): boolean {
  if (!METRIC_DAY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && metricDayUtc(parsed) === value;
}

/** The UTC Metric_Day of an instant. UTC, never local time. */
export function metricDayUtc(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The Metric_Day `deltaDays` away from `day`. Negative moves backwards. */
export function shiftMetricDay(day: string, deltaDays: number): string {
  return metricDayUtc(new Date(Date.parse(`${day}T00:00:00Z`) + deltaDays * MS_PER_DAY));
}

/** Inclusive day count of a range, so a single day is 1 and not 0. */
export function inclusiveDays(range: DateRange): number {
  const from = Date.parse(`${range.from}T00:00:00Z`);
  const to = Date.parse(`${range.to}T00:00:00Z`);
  return Math.round((to - from) / MS_PER_DAY) + 1;
}

/**
 * The trailing `days` days ending on `today`, INCLUSIVE - so 30 days spans
 * `today - 29` through `today`, matching the Admin_API default.
 */
export function trailingRange(days: number, today: string): DateRange {
  return { from: shiftMetricDay(today, -(days - 1)), to: today };
}

/** True when the range is one the Admin_API will accept. */
export function isValidRange(range: DateRange): boolean {
  if (!isMetricDay(range.from) || !isMetricDay(range.to)) return false;
  // Both ends are zero-padded fixed-width days, so a lexicographic compare is a
  // chronological one.
  if (range.from > range.to) return false;
  return inclusiveDays(range) <= MAX_RANGE_DAYS;
}

@Injectable({ providedIn: 'root' })
export class DateRangeService {
  private readonly current = signal<DateRange>(trailingRange(DEFAULT_RANGE_DAYS, todayUtc()));

  /** The one range signal. Every view reads this and nothing else. */
  readonly range = this.current.asReadonly();

  readonly from = computed(() => this.current().from);
  readonly to = computed(() => this.current().to);

  /** Inclusive length of the selected range, for the header summary. */
  readonly days = computed(() => inclusiveDays(this.current()));

  /**
   * The preset the selected range corresponds to, or `null` for a hand-picked
   * range. Drives which preset button reads as active.
   */
  readonly activePreset = computed<RangePresetDays | null>(() => {
    const range = this.current();
    if (range.to !== todayUtc()) return null;
    return RANGE_PRESET_DAYS.find((days) => days === inclusiveDays(range)) ?? null;
  });

  /**
   * Replaces the range. Returns false and changes nothing when the range is not
   * one the Admin_API accepts, so a half-typed date in the header control cannot
   * trigger a doomed refetch of every view.
   */
  setRange(range: DateRange): boolean {
    if (!isValidRange(range)) return false;
    const previous = this.current();
    if (previous.from === range.from && previous.to === range.to) return true;
    this.current.set({ from: range.from, to: range.to });
    return true;
  }

  /**
   * Selects the trailing `days` days ending today.
   *
   * Routed through `setRange` so a preset that resolves to the range already
   * selected is a no-op: re-clicking the active preset must not notify the
   * signal, or every view keyed on it refetches identical data for nothing
   * (Requirement 10.10 - a repeat click is not a change). A trailing preset is
   * always a valid range, so a false here would mean `RANGE_PRESET_DAYS` or
   * `MAX_RANGE_DAYS` drifted apart rather than a user input problem; it is
   * surfaced rather than swallowed.
   */
  applyPreset(days: RangePresetDays): boolean {
    return this.setRange(trailingRange(days, todayUtc()));
  }

  /**
   * Back to the range the dashboard opens on. Nothing further is needed here:
   * the no-op guard in `setRange` covers a reset while already reset, since
   * `DEFAULT_RANGE_DAYS` goes through the same path.
   */
  reset(): boolean {
    return this.applyPreset(DEFAULT_RANGE_DAYS);
  }
}

/** Today as a UTC Metric_Day. The store keys on UTC days, so the UI must too. */
export function todayUtc(): string {
  return metricDayUtc(new Date());
}
