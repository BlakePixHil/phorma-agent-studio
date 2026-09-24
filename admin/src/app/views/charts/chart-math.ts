/**
 * Pure geometry and number maths behind the SVG chart kit. No Angular, no DOM,
 * so every claim the charts rest on is property-testable in isolation.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** One cubic segment of a curve, start point implied by the previous segment. */
export interface CubicSegment {
  readonly from: Point;
  readonly c1: Point;
  readonly c2: Point;
  readonly to: Point;
}

/**
 * Axis ticks from 0 to a rounded top at or above `max`, on a 1/2/2.5/5 step.
 * `integer` keeps count axes free of fractional ticks.
 */
export function niceTicks(max: number, count = 4, integer = true): number[] {
  // Below 1e-9 the magnitude underflows to 0; nothing real is plotted that small.
  const top = Number.isFinite(max) && max > 1e-9 ? max : 0;
  if (top === 0) return [0, 1];
  const raw = top / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const residual = raw / magnitude;
  const nice = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 2.5 ? 2.5 : residual <= 5 ? 5 : 10;
  let step = nice * magnitude;
  if (integer) step = Math.max(1, Math.ceil(step));
  const steps = Math.max(1, Math.ceil(top / step - 1e-9));
  const ticks: number[] = [];
  for (let i = 0; i <= steps; i += 1) ticks.push(Number((i * step).toPrecision(12)));
  return ticks;
}

/**
 * Monotone cubic interpolation (Fritsch-Butland tangents, as d3's curveMonotoneX).
 * Never overshoots: every control point stays inside its segment's y-range, so a
 * count line can never dip below zero or peak above the real maximum.
 */
export function monotoneSegments(points: readonly Point[]): CubicSegment[] {
  const n = points.length;
  if (n < 2) return [];
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx.push(points[i + 1].x - points[i].x);
    slope.push(dx[i] === 0 ? 0 : (points[i + 1].y - points[i].y) / dx[i]);
  }
  const tangent: number[] = new Array(n).fill(0);
  tangent[0] = slope[0];
  tangent[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    const a = slope[i - 1];
    const b = slope[i];
    if (a * b <= 0) {
      tangent[i] = 0;
      continue;
    }
    tangent[i] = (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / a + (dx[i] + 2 * dx[i - 1]) / b);
  }
  const segments: CubicSegment[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const third = dx[i] / 3;
    const from = points[i];
    const to = points[i + 1];
    segments.push({
      from,
      c1: { x: from.x + third, y: from.y + tangent[i] * third },
      c2: { x: to.x - third, y: to.y - tangent[i + 1] * third },
      to,
    });
  }
  return segments;
}

const f = (value: number): string => (Math.round(value * 100) / 100).toString();

/** SVG path for one contiguous run of points. A lone point draws a round-capped dot. */
export function monotonePath(points: readonly Point[]): string {
  if (points.length === 0) return '';
  const [first] = points;
  if (points.length === 1) return `M${f(first.x)},${f(first.y)}l0.01,0`;
  return (
    `M${f(first.x)},${f(first.y)}` +
    monotoneSegments(points)
      .map((s) => `C${f(s.c1.x)},${f(s.c1.y)},${f(s.c2.x)},${f(s.c2.y)},${f(s.to.x)},${f(s.to.y)}`)
      .join('')
  );
}

/** Splits a series on its nulls into contiguous runs of plotted points. */
export function runsOf(
  values: readonly (number | null)[],
  xOf: (index: number) => number,
  yOf: (value: number) => number,
): Point[][] {
  const runs: Point[][] = [];
  let current: Point[] = [];
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      if (current.length > 0) runs.push(current);
      current = [];
      return;
    }
    current.push({ x: xOf(index), y: yOf(value) });
  });
  if (current.length > 0) runs.push(current);
  return runs;
}

/** Line and filled-area paths for a series with gaps. */
export function seriesPaths(
  values: readonly (number | null)[],
  xOf: (index: number) => number,
  yOf: (value: number) => number,
  baseline: number,
): { line: string; area: string } {
  const runs = runsOf(values, xOf, yOf);
  const line = runs.map(monotonePath).join('');
  const area = runs
    .filter((run) => run.length > 1)
    .map((run) => {
      const last = run[run.length - 1];
      return `${monotonePath(run)}L${f(last.x)},${f(baseline)}L${f(run[0].x)},${f(baseline)}Z`;
    })
    .join('');
  return { line, area };
}

export interface Arc {
  readonly start: number;
  readonly end: number;
}

/** Donut arcs in radians, clockwise from 12 o'clock, with a small pad between slices. */
export function donutArcs(values: readonly number[], pad = 0.025): Arc[] {
  const safe = values.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const total = safe.reduce((sum, value) => sum + value, 0);
  const visible = safe.filter((value) => value > 0).length;
  const usablePad = visible > 1 ? pad : 0;
  let cursor = -Math.PI / 2;
  return safe.map((value) => {
    const sweep = total > 0 ? (value / total) * Math.PI * 2 : 0;
    const start = cursor;
    cursor += sweep;
    if (sweep === 0) return { start, end: start };
    const inset = Math.min(usablePad / 2, sweep / 4);
    return { start: start + inset, end: cursor - inset };
  });
}

/** Annular sector path. A full turn is split in two so the arc command can draw it. */
export function arcPath(cx: number, cy: number, outer: number, inner: number, arc: Arc): string {
  const sweep = arc.end - arc.start;
  if (sweep <= 0) return '';
  if (sweep >= Math.PI * 2 - 1e-6) {
    const mid = arc.start + Math.PI;
    return arcPath(cx, cy, outer, inner, { start: arc.start, end: mid }) + arcPath(cx, cy, outer, inner, { start: mid, end: arc.end - 1e-6 });
  }
  const large = sweep > Math.PI ? 1 : 0;
  const p = (r: number, a: number) => `${f(cx + r * Math.cos(a))},${f(cy + r * Math.sin(a))}`;
  return (
    `M${p(outer, arc.start)}A${outer},${outer},0,${large},1,${p(outer, arc.end)}` +
    `L${p(inner, arc.end)}A${inner},${inner},0,${large},0,${p(inner, arc.start)}Z`
  );
}

export type DeltaKind = 'up' | 'down' | 'flat' | 'new';

export interface DeltaReading {
  readonly kind: DeltaKind;
  /** Percent change, or percentage-point change in `points` mode. Null for `new`. */
  readonly amount: number | null;
}

/**
 * Change against the previous period, or null when there is nothing honest to say
 * (no previous reading). A previous zero with a current non-zero is `new`, never
 * an infinite percentage.
 */
export function deltaOf(
  current: number | null,
  previous: number | null | undefined,
  mode: 'percent' | 'points' = 'percent',
): DeltaReading | null {
  if (current === null || previous === null || previous === undefined) return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  let amount: number;
  if (mode === 'points') {
    amount = current - previous;
  } else {
    if (previous === 0) return current === 0 ? { kind: 'flat', amount: 0 } : { kind: 'new', amount: null };
    amount = ((current - previous) / Math.abs(previous)) * 100;
  }
  const threshold = mode === 'points' ? 0.05 : 0.5;
  if (Math.abs(amount) < threshold) return { kind: 'flat', amount: 0 };
  return { kind: amount > 0 ? 'up' : 'down', amount };
}

/** Opacity for a heat cell: square-root ramp so one busy day does not wash out the rest. */
export function heatOpacity(value: number | null, max: number, floor = 0.14): number {
  if (value === null || !Number.isFinite(value) || value <= 0 || max <= 0) return 0;
  return floor + (1 - floor) * Math.sqrt(Math.min(1, value / max));
}

const DAY_MS = 86_400_000;

/** UTC day of week, Monday 0 through Sunday 6. */
export function weekdayIndex(day: string): number {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/**
 * The calendar grid for an inclusive day range: one column per Monday-first week,
 * seven cells each, null for padding days outside the range.
 */
export function weekGrid(from: string, to: string): (string | null)[][] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const weeks: (string | null)[][] = [];
  let week: (string | null)[] = new Array(weekdayIndex(from)).fill(null);
  for (let at = start; at <= end; at += DAY_MS) {
    week.push(new Date(at).toISOString().slice(0, 10));
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length > 0) weeks.push([...week, ...new Array(7 - week.length).fill(null)]);
  return weeks;
}

/** Every UTC day from `from` to `to` inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const days: string[] = [];
  if (!Number.isFinite(start) || !Number.isFinite(end)) return days;
  for (let at = start; at <= end && days.length <= 800; at += DAY_MS) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

/** The day `delta` days from `day`. */
export function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** Share of a total as a percentage, 0 for an empty total. */
export function shareOf(value: number, total: number): number {
  return total > 0 ? (value / total) * 100 : 0;
}
