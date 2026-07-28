/**
 * Eval statistics - pure aggregation over {@link EvalRunSummary} history.
 *
 * The engine already owns the eval data model and the scoring logic; these
 * derivations (per-model comparison aggregates, suite trends, per-case
 * flakiness) live here for the same reasons: no framework dependencies, and
 * one implementation shared by the studio UI and any future cloud reporter.
 *
 * Everything here is a pure function over data the host already persists -
 * nothing new needs to be recorded.
 */

import { evalPassCounts, type EvalCaseResult, type EvalRunSummary } from './evals.js';

/** Label used for the implicit "host defaults" pass (no model override). */
export const DEFAULT_PASS_LABEL = 'Defaults';

/** Aggregate outcome of one comparison pass (one model) within a suite run. */
export interface EvalModelAggregate {
  /** `provider:model`, or {@link DEFAULT_PASS_LABEL} for the defaults pass. */
  model: string;
  passed: number;
  failed: number;
  errored: number;
  total: number;
  /** Passed / total, 0..1. NaN is never produced - empty passes report 0. */
  passRate: number;
  /** Mean of the reported `score` values; null when none were scored. */
  meanScore: number | null;
  /** Sum of `costUsd` across the pass; null when nothing reported a cost. */
  costUsd: number | null;
  /** Median case duration in milliseconds. */
  p50DurationMs: number;
  /** 95th-percentile case duration in milliseconds. */
  p95DurationMs: number;
  totalDurationMs: number;
}

/** Aggregate outcome of one case across every comparison pass in a run. */
export interface EvalCaseAggregate {
  caseId: string;
  passed: number;
  total: number;
  passRate: number;
  meanScore: number | null;
  costUsd: number | null;
  p50DurationMs: number;
}

/** One point in a suite's pass-rate/cost trend (one suite run). */
export interface EvalTrendPoint {
  runId: string;
  startedAt: number;
  /** Suite wall-clock duration; null while the run is still in flight. */
  durationMs: number | null;
  passed: number;
  total: number;
  passRate: number;
  meanScore: number | null;
  costUsd: number | null;
  status: EvalRunSummary['status'];
}

/** How reliably one case passes across a suite's run history. */
export interface EvalCaseFlakiness {
  caseId: string;
  /** Distinct suite runs in which this case produced at least one result. */
  runs: number;
  passed: number;
  failed: number;
  errored: number;
  passRate: number;
  /**
   * 0 = perfectly stable (always passes or always fails), 1 = maximally
   * flaky (passes exactly half the time). Computed as `2 * min(p, 1 - p)` so
   * ranking by this value surfaces genuinely unstable cases rather than
   * consistently broken ones.
   */
  instability: number;
  /** Most recent status observed, newest run first. */
  latestStatus: EvalCaseResult['status'] | null;
}

/**
 * Linear-interpolated percentile of a numeric sample.
 *
 * `p` is a fraction (0.5 = median). Returns 0 for an empty sample so callers
 * can render a number without null checks. Does not mutate the input.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const clamped = Math.min(Math.max(p, 0), 1);
  const position = clamped * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** The pass label a result belongs to (defaults pass when unset). */
export function resultModelLabel(result: EvalCaseResult): string {
  return result.model ?? DEFAULT_PASS_LABEL;
}

/**
 * Per-model aggregates for one suite run, in the run's declared model order
 * (unknown labels, including the defaults pass, are appended).
 */
export function modelAggregates(run: EvalRunSummary): EvalModelAggregate[] {
  const groups = new Map<string, EvalCaseResult[]>();
  for (const result of run.results) {
    const label = resultModelLabel(result);
    const bucket = groups.get(label);
    if (bucket) bucket.push(result);
    else groups.set(label, [result]);
  }

  // Declared comparison order first, so the matrix columns stay stable across
  // runs even when a pass produced no results.
  const ordered = [...run.models.filter((label) => groups.has(label))];
  for (const label of groups.keys()) if (!ordered.includes(label)) ordered.push(label);

  return ordered.map((model) => summarizeResults(model, groups.get(model) ?? []));
}

function summarizeResults(model: string, results: readonly EvalCaseResult[]): EvalModelAggregate {
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const errored = results.filter((r) => r.status === 'error').length;
  const durations = results.map((r) => r.durationMs);
  return {
    model,
    passed,
    failed,
    errored,
    total: results.length,
    passRate: results.length > 0 ? passed / results.length : 0,
    meanScore: meanOf(results.map((r) => r.score)),
    costUsd: sumOf(results.map((r) => r.costUsd)),
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    totalDurationMs: durations.reduce((total, value) => total + value, 0),
  };
}

/** Per-case aggregates for one suite run (a matrix row footer). */
export function caseAggregates(run: EvalRunSummary): EvalCaseAggregate[] {
  const groups = new Map<string, EvalCaseResult[]>();
  for (const result of run.results) {
    const bucket = groups.get(result.caseId);
    if (bucket) bucket.push(result);
    else groups.set(result.caseId, [result]);
  }
  return [...groups].map(([caseId, results]) => {
    const passed = results.filter((r) => r.status === 'passed').length;
    return {
      caseId,
      passed,
      total: results.length,
      passRate: results.length > 0 ? passed / results.length : 0,
      meanScore: meanOf(results.map((r) => r.score)),
      costUsd: sumOf(results.map((r) => r.costUsd)),
      p50DurationMs: percentile(
        results.map((r) => r.durationMs),
        0.5,
      ),
    };
  });
}

/**
 * Pass-rate / score / cost trend across a suite's run history, oldest first
 * so it plots left to right.
 */
export function suiteTrend(runs: readonly EvalRunSummary[]): EvalTrendPoint[] {
  return [...runs]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((run) => {
      const { passed, total } = evalPassCounts(run);
      return {
        runId: run.id,
        startedAt: run.startedAt,
        durationMs: run.endedAt ? run.endedAt - run.startedAt : null,
        passed,
        total,
        passRate: total > 0 ? passed / total : 0,
        meanScore: meanOf(run.results.map((r) => r.score)),
        costUsd: sumOf(run.results.map((r) => r.costUsd)),
        status: run.status,
      };
    });
}

/**
 * Per-case stability across a suite's run history, most unstable first (ties
 * broken by lowest pass rate, so consistently broken cases still rank above
 * consistently passing ones).
 *
 * A case contributes at most one observation per run: with a comparison
 * matrix, the case counts as passed for that run only when every model pass
 * passed it, which is the stricter, more useful reading of "did this case hold".
 */
export function caseFlakiness(runs: readonly EvalRunSummary[]): EvalCaseFlakiness[] {
  interface Tally {
    runs: number;
    passed: number;
    failed: number;
    errored: number;
    latestAt: number;
    latestStatus: EvalCaseResult['status'] | null;
  }
  const tallies = new Map<string, Tally>();

  for (const run of runs) {
    const perCase = new Map<string, EvalCaseResult[]>();
    for (const result of run.results) {
      const bucket = perCase.get(result.caseId);
      if (bucket) bucket.push(result);
      else perCase.set(result.caseId, [result]);
    }

    for (const [caseId, results] of perCase) {
      const tally = tallies.get(caseId) ?? {
        runs: 0,
        passed: 0,
        failed: 0,
        errored: 0,
        latestAt: -1,
        latestStatus: null,
      };
      const status: EvalCaseResult['status'] = results.some((r) => r.status === 'error')
        ? 'error'
        : results.every((r) => r.status === 'passed')
          ? 'passed'
          : 'failed';
      tally.runs += 1;
      if (status === 'passed') tally.passed += 1;
      else if (status === 'failed') tally.failed += 1;
      else tally.errored += 1;
      if (run.startedAt >= tally.latestAt) {
        tally.latestAt = run.startedAt;
        tally.latestStatus = status;
      }
      tallies.set(caseId, tally);
    }
  }

  return [...tallies]
    .map(([caseId, tally]) => {
      const passRate = tally.runs > 0 ? tally.passed / tally.runs : 0;
      return {
        caseId,
        runs: tally.runs,
        passed: tally.passed,
        failed: tally.failed,
        errored: tally.errored,
        passRate,
        instability: 2 * Math.min(passRate, 1 - passRate),
        latestStatus: tally.latestStatus,
      };
    })
    .sort((a, b) => b.instability - a.instability || a.passRate - b.passRate);
}

/** Total wall-clock duration of a suite run; null while still running. */
export function suiteDurationMs(run: EvalRunSummary): number | null {
  return run.endedAt ? run.endedAt - run.startedAt : null;
}

/** Total reported cost across a suite run; null when nothing reported one. */
export function suiteCostUsd(run: EvalRunSummary): number | null {
  return sumOf(run.results.map((r) => r.costUsd));
}

/** Mean of the defined values, or null when none are defined. */
function meanOf(values: readonly (number | undefined)[]): number | null {
  const defined = values.filter((value): value is number => typeof value === 'number');
  if (defined.length === 0) return null;
  return defined.reduce((total, value) => total + value, 0) / defined.length;
}

/** Sum of the defined values, or null when none are defined. */
function sumOf(values: readonly (number | undefined)[]): number | null {
  const defined = values.filter((value): value is number => typeof value === 'number');
  if (defined.length === 0) return null;
  return defined.reduce((total, value) => total + value, 0);
}
