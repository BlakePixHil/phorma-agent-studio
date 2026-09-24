import type { DateRange, TrendDay } from '../core/models';
import { OTHER_GROUP_LABEL } from '../core/models';
import { daysBetween } from './charts/chart-math';

export type TrendMetric = 'installs' | 'sessions' | 'runs';

/**
 * A trend response laid onto every calendar day of `range`, so the x-axis is
 * time and not "days that happened to report". A day the Worker folded into
 * `other` (below the reporting floor) is a null gap, never a zero.
 */
export function alignDays(
  range: DateRange,
  days: readonly TrendDay[],
): { labels: string[]; byMetric: Record<TrendMetric, (number | null)[]> } {
  const labels = daysBetween(range.from, range.to);
  const byDay = new Map(days.filter((d) => d.label !== OTHER_GROUP_LABEL).map((d) => [d.label, d]));
  const pick = (metric: TrendMetric) => labels.map((day) => byDay.get(day)?.[metric] ?? null);
  return {
    labels,
    byMetric: { installs: pick('installs'), sessions: pick('sessions'), runs: pick('runs') },
  };
}

/** Sum of a series, nulls skipped. */
export function sumOf(values: readonly (number | null)[]): number {
  return values.reduce<number>((sum, v) => sum + (v ?? 0), 0);
}

/** Mean over the reported (non-null) points, or null if none. */
export function meanOf(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0) / present.length;
}

/** Index of the highest point, or -1. */
export function peakIndex(values: readonly (number | null)[]): number {
  let best = -1;
  let peak = -Infinity;
  values.forEach((v, i) => {
    if (v !== null && v > peak) {
      peak = v;
      best = i;
    }
  });
  return best;
}
