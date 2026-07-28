/**
 * E2E for the eval statistics module — exercises the pure aggregations that
 * back the expanded Evals dialog (per-model comparison matrix footers,
 * per-case footers, suite trends, per-case flakiness, percentiles).
 *
 * Pure data in, pure data out — no engine run, no model, no UI.
 *
 * Run: npx -y tsx engine/test/evals-stats.e2e.mts
 */
import {
  DEFAULT_PASS_LABEL,
  caseAggregates,
  caseFlakiness,
  modelAggregates,
  percentile,
  resultModelLabel,
  suiteCostUsd,
  suiteDurationMs,
  suiteTrend,
} from '../src/index.js';
import type { EvalCaseResult, EvalRunSummary } from '../src/index.js';

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function near(actual: number, expected: number, epsilon = 1e-9): boolean {
  return Math.abs(actual - expected) <= epsilon;
}

function result(overrides: Partial<EvalCaseResult> & { caseId: string }): EvalCaseResult {
  return {
    runId: `run-${overrides.caseId}`,
    status: 'passed',
    output: 'ok',
    durationMs: 100,
    ...overrides,
  };
}

function run(overrides: Partial<EvalRunSummary>): EvalRunSummary {
  return {
    id: 'evalrun-1',
    suiteId: 'suite-1',
    workflowId: 'wf-1',
    suiteName: 'Suite',
    environment: 'local',
    status: 'completed',
    models: [],
    results: [],
    startedAt: 1_000,
    ...overrides,
  };
}

// ── percentile ──────────────────────────────────────────────────────────────
console.log('\npercentile');
check('empty sample is 0', percentile([], 0.5) === 0);
check('single value', percentile([42], 0.95) === 42);
check('median of odd sample', percentile([3, 1, 2], 0.5) === 2);
check('median of even sample interpolates', percentile([1, 2, 3, 4], 0.5) === 2.5);
check('p0 is the minimum', percentile([9, 1, 5], 0) === 1);
check('p100 is the maximum', percentile([9, 1, 5], 1) === 9);
check('p95 interpolates', near(percentile([10, 20, 30, 40, 50], 0.95), 48));
check('clamps p above 1', percentile([1, 2, 3], 5) === 3);
check('clamps p below 0', percentile([1, 2, 3], -5) === 1);
{
  const source = [3, 1, 2];
  percentile(source, 0.5);
  check('does not mutate the input', source.join(',') === '3,1,2');
}

// ── resultModelLabel ───────────────────────────────────────────────────────
console.log('\nresultModelLabel');
check(
  'explicit model wins',
  resultModelLabel(result({ caseId: 'c1', model: 'openai:gpt-4o' })) === 'openai:gpt-4o',
);
check(
  'defaults pass gets the sentinel label',
  resultModelLabel(result({ caseId: 'c1' })) === DEFAULT_PASS_LABEL,
);

// ── modelAggregates ────────────────────────────────────────────────────────
console.log('\nmodelAggregates');
{
  const comparison = run({
    models: ['openai:gpt-4o', 'anthropic:claude'],
    results: [
      result({ caseId: 'c1', model: 'openai:gpt-4o', status: 'passed', score: 1, costUsd: 0.01, durationMs: 100 }),
      result({ caseId: 'c2', model: 'openai:gpt-4o', status: 'failed', score: 0.25, costUsd: 0.02, durationMs: 300 }),
      result({ caseId: 'c3', model: 'openai:gpt-4o', status: 'error', error: 'boom', durationMs: 500 }),
      result({ caseId: 'c1', model: 'anthropic:claude', status: 'passed', score: 0.9, durationMs: 200 }),
      result({ caseId: 'c2', model: 'anthropic:claude', status: 'passed', score: 0.8, durationMs: 400 }),
    ],
  });
  const aggregates = modelAggregates(comparison);
  check('one aggregate per pass', aggregates.length === 2);
  check(
    'columns follow the declared model order',
    aggregates[0].model === 'openai:gpt-4o' && aggregates[1].model === 'anthropic:claude',
  );

  const openai = aggregates[0];
  check('counts passed/failed/errored', openai.passed === 1 && openai.failed === 1 && openai.errored === 1);
  check('total counts every result', openai.total === 3);
  check('pass rate ignores nothing', near(openai.passRate, 1 / 3));
  check('mean score skips unscored results', near(openai.meanScore ?? -1, 0.625));
  check('cost sums reported values only', near(openai.costUsd ?? -1, 0.03));
  check('p50 duration', openai.p50DurationMs === 300);
  check('p95 duration interpolates', near(openai.p95DurationMs, 480));
  check('total duration sums', openai.totalDurationMs === 900);

  const claude = aggregates[1];
  check('perfect pass rate is 1', near(claude.passRate, 1));
  check('null cost when nothing reported one', claude.costUsd === null);
  check('mean score across the pass', near(claude.meanScore ?? -1, 0.85));
}
{
  const defaults = run({
    results: [
      result({ caseId: 'c1', status: 'passed' }),
      result({ caseId: 'c2', status: 'failed' }),
    ],
  });
  const aggregates = modelAggregates(defaults);
  check('defaults-only run yields one pass', aggregates.length === 1);
  check('labelled as the defaults pass', aggregates[0].model === DEFAULT_PASS_LABEL);
  check('pass rate of a half', near(aggregates[0].passRate, 0.5));
}
{
  const declaredButEmpty = run({ models: ['openai:gpt-4o'], results: [] });
  check('a pass with no results is dropped', modelAggregates(declaredButEmpty).length === 0);
}
{
  const undeclared = run({
    models: ['openai:gpt-4o'],
    results: [result({ caseId: 'c1', model: 'gemini:flash' })],
  });
  const aggregates = modelAggregates(undeclared);
  check('undeclared labels are appended, not dropped', aggregates.length === 1);
  check('undeclared label preserved', aggregates[0].model === 'gemini:flash');
}
check('empty run aggregates to nothing', modelAggregates(run({})).length === 0);

// ── caseAggregates ─────────────────────────────────────────────────────────
console.log('\ncaseAggregates');
{
  const matrix = run({
    models: ['a:1', 'b:2'],
    results: [
      result({ caseId: 'c1', model: 'a:1', status: 'passed', score: 1, costUsd: 0.01, durationMs: 100 }),
      result({ caseId: 'c1', model: 'b:2', status: 'failed', score: 0.5, costUsd: 0.03, durationMs: 300 }),
      result({ caseId: 'c2', model: 'a:1', status: 'passed', durationMs: 50 }),
      result({ caseId: 'c2', model: 'b:2', status: 'passed', durationMs: 70 }),
    ],
  });
  const rows = caseAggregates(matrix);
  check('one row per case', rows.length === 2);
  const c1 = rows.find((row) => row.caseId === 'c1');
  check('row spans every pass', c1?.total === 2);
  check('row pass rate', near(c1?.passRate ?? -1, 0.5));
  check('row mean score', near(c1?.meanScore ?? -1, 0.75));
  check('row cost sums both passes', near(c1?.costUsd ?? -1, 0.04));
  check('row p50 duration interpolates', near(c1?.p50DurationMs ?? -1, 200));
  const c2 = rows.find((row) => row.caseId === 'c2');
  check('unscored row reports null mean score', c2?.meanScore === null);
  check('costless row reports null cost', c2?.costUsd === null);
}

// ── suiteTrend ─────────────────────────────────────────────────────────────
console.log('\nsuiteTrend');
{
  const history = [
    run({
      id: 'r2',
      startedAt: 2_000,
      endedAt: 2_500,
      results: [
        result({ caseId: 'c1', status: 'passed', score: 1, costUsd: 0.02 }),
        result({ caseId: 'c2', status: 'passed', score: 1, costUsd: 0.02 }),
      ],
    }),
    run({
      id: 'r1',
      startedAt: 1_000,
      endedAt: 1_200,
      results: [
        result({ caseId: 'c1', status: 'passed', score: 1, costUsd: 0.01 }),
        result({ caseId: 'c2', status: 'failed', score: 0 }),
      ],
    }),
    run({ id: 'r3', startedAt: 3_000, status: 'running', results: [] }),
  ];
  const trend = suiteTrend(history);
  check('sorted oldest first for left-to-right plotting', trend.map((p) => p.runId).join(',') === 'r1,r2,r3');
  check('pass rate per point', near(trend[0].passRate, 0.5) && near(trend[1].passRate, 1));
  check('duration from endedAt', trend[0].durationMs === 200 && trend[1].durationMs === 500);
  check('in-flight run has null duration', trend[2].durationMs === null);
  check('cost sums reported values', near(trend[0].costUsd ?? -1, 0.01));
  check('cost null when none reported', trend[2].costUsd === null);
  check('mean score per point', near(trend[0].meanScore ?? -1, 0.5));
  check('status carried through', trend[2].status === 'running');
  check('empty point has zero pass rate, not NaN', trend[2].passRate === 0);
  check('does not mutate the input order', history[0].id === 'r2');
}
check('empty history trends to nothing', suiteTrend([]).length === 0);

// ── caseFlakiness ──────────────────────────────────────────────────────────
console.log('\ncaseFlakiness');
{
  // stable-pass always passes; flaky passes half the time; broken never
  // passes; erroring always errors.
  const history: EvalRunSummary[] = [1, 2, 3, 4].map((n) =>
    run({
      id: `r${n}`,
      startedAt: n * 1_000,
      results: [
        result({ caseId: 'stable-pass', status: 'passed' }),
        result({ caseId: 'flaky', status: n % 2 === 0 ? 'passed' : 'failed' }),
        result({ caseId: 'broken', status: 'failed' }),
        result({ caseId: 'erroring', status: 'error' }),
      ],
    }),
  );
  const rows = caseFlakiness(history);
  check('one row per case', rows.length === 4);
  check('flaky case ranks first', rows[0].caseId === 'flaky');
  check('flaky instability is maximal', near(rows[0].instability, 1));
  check('flaky observed in every run', rows[0].runs === 4 && rows[0].passed === 2);

  const stable = rows.find((row) => row.caseId === 'stable-pass');
  const broken = rows.find((row) => row.caseId === 'broken');
  check('stable case has zero instability', near(stable?.instability ?? -1, 0));
  check('broken case has zero instability too', near(broken?.instability ?? -1, 0));
  check(
    'broken ranks above stable on the tie-break',
    rows.findIndex((r) => r.caseId === 'broken') < rows.findIndex((r) => r.caseId === 'stable-pass'),
  );
  check('erroring case counted as errored', rows.find((r) => r.caseId === 'erroring')?.errored === 4);
  check('latest status is the newest run', rows[0].latestStatus === 'passed');
}
{
  // A case counts as passed for a run only when EVERY model pass passed it.
  const mixed = run({
    models: ['a:1', 'b:2'],
    results: [
      result({ caseId: 'c1', model: 'a:1', status: 'passed' }),
      result({ caseId: 'c1', model: 'b:2', status: 'failed' }),
    ],
  });
  const rows = caseFlakiness([mixed]);
  check('one observation per run, not per pass', rows[0].runs === 1);
  check('partial pass across models counts as failed', rows[0].failed === 1 && rows[0].passed === 0);
}
{
  const errorWins = run({
    results: [
      result({ caseId: 'c1', status: 'passed' }),
      result({ caseId: 'c1', status: 'error' }),
    ],
  });
  check('an error in any pass makes the run errored', caseFlakiness([errorWins])[0].errored === 1);
}
check('empty history has no flakiness rows', caseFlakiness([]).length === 0);

// ── suiteDurationMs / suiteCostUsd ─────────────────────────────────────────
console.log('\nsuite totals');
check('duration from timestamps', suiteDurationMs(run({ startedAt: 100, endedAt: 450 })) === 350);
check('null duration while running', suiteDurationMs(run({ startedAt: 100 })) === null);
check(
  'cost sums every result',
  near(
    suiteCostUsd(
      run({
        results: [
          result({ caseId: 'c1', costUsd: 0.01 }),
          result({ caseId: 'c2', costUsd: 0.02 }),
          result({ caseId: 'c3' }),
        ],
      }),
    ) ?? -1,
    0.03,
  ),
);
check('null cost when nothing reported one', suiteCostUsd(run({ results: [result({ caseId: 'c1' })] })) === null);

console.log(failures === 0 ? '\nAll eval-stats checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
