/**
 * E2E for the evals model (EPIC 4) — exercises the pure scoring logic
 * (exact / contains / llm-judge with tolerant verdict parsing and judge
 * failure modes) and drives a REAL engine run per eval case with a scripted
 * model, verifying `source: 'eval'` is stamped end to end and outputs score
 * correctly.
 *
 * Run: npx -y tsx evals.e2e.mts
 */
import {
  createRunRecorder,
  evalModelLabel,
  evalPassCounts,
  parseJudgeVerdict,
  scoreOutput,
  startRun,
} from '../src/index.js';
import type {
  EvalCase,
  EvalJudgeOptions,
  EvalRunSummary,
  ModelChunk,
  ModelRequest,
  WorkflowGraph,
} from '../src/index.js';

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function evalCase(overrides: Partial<EvalCase>): EvalCase {
  return {
    id: 'case-1',
    name: 'Case',
    input: 'What is 2+2?',
    expected: '4',
    matcher: 'exact',
    ...overrides,
  };
}

function textJudge(reply: string): EvalJudgeOptions {
  return {
    client: {
      async *stream(_request: ModelRequest): AsyncIterable<ModelChunk> {
        yield { type: 'text', text: reply };
      },
    },
    judge: { provider: 'openai', model: 'judge-scripted' },
  };
}

console.log('E2E: deterministic matchers');
{
  const exact = evalCase({ matcher: 'exact', expected: ' 4 ' });
  check('exact pass trims both sides', (await scoreOutput(exact, '4\n')).pass);
  const exactFail = await scoreOutput(evalCase({ matcher: 'exact' }), 'four');
  check('exact fail', !exactFail.pass && exactFail.score === 0);
  check('exact fail carries reasoning', !!exactFail.reasoning);

  const contains = evalCase({ matcher: 'contains', expected: 'Answer: 4' });
  check(
    'contains is case-insensitive',
    (await scoreOutput(contains, 'the ANSWER: 4 indeed')).pass,
  );
  check('contains fail', !(await scoreOutput(contains, 'nope')).pass);
  const containsPass = await scoreOutput(contains, 'answer: 4');
  check('contains pass scores 1', containsPass.score === 1 && containsPass.reasoning === undefined);
}

console.log('E2E: judge verdict parsing');
{
  const clean = parseJudgeVerdict('{"pass": true, "score": 0.9, "reasoning": "good"}');
  check('clean JSON parses', clean?.pass === true && clean.score === 0.9 && clean.reasoning === 'good');

  const fenced = parseJudgeVerdict(
    'Here you go:\n```json\n{"pass": false, "score": 0.2, "reasoning": "missing detail"}\n```\nHope that helps!',
  );
  check('fenced JSON with prose parses', fenced?.pass === false && fenced.score === 0.2);

  const nested = parseJudgeVerdict('{"pass": true, "score": 1, "reasoning": "has {braces} inside"}');
  check('balanced-brace walk survives nested braces', nested?.pass === true);

  check('missing pass field rejected', parseJudgeVerdict('{"score": 1}') === null);
  check('no JSON rejected', parseJudgeVerdict('definitely passes!') === null);
  check('malformed JSON rejected', parseJudgeVerdict('{"pass": tru') === null);

  const clamped = parseJudgeVerdict('{"pass": true, "score": 42}');
  check('score clamped to 0..1', clamped?.score === 1);
  const defaulted = parseJudgeVerdict('{"pass": false}');
  check('score defaults from pass', defaulted?.score === 0);
}

console.log('E2E: llm-judge scoring');
{
  const judged = await scoreOutput(
    evalCase({ matcher: 'llm-judge', judgeCriteria: 'Must mention four.' }),
    'The answer is four (4).',
    textJudge('{"pass": true, "score": 0.95, "reasoning": "mentions four"}'),
  );
  check('judge pass verdict', judged.pass && judged.score === 0.95);

  let missingJudge = '';
  try {
    await scoreOutput(evalCase({ matcher: 'llm-judge' }), 'x');
  } catch (error) {
    missingJudge = (error as Error).message;
  }
  check('llm-judge without judge model rejects', /judge model/.test(missingJudge));

  let unparseable = '';
  try {
    await scoreOutput(evalCase({ matcher: 'llm-judge' }), 'x', textJudge('I refuse to answer in JSON.'));
  } catch (error) {
    unparseable = (error as Error).message;
  }
  check('unparseable verdict rejects', /unparseable/.test(unparseable));

  let thrown = '';
  try {
    await scoreOutput(evalCase({ matcher: 'llm-judge' }), 'x', {
      client: {
        // eslint-disable-next-line require-yield
        async *stream(): AsyncIterable<ModelChunk> {
          throw new Error('judge provider down');
        },
      },
      judge: { provider: 'openai', model: 'judge-scripted' },
    });
  } catch (error) {
    thrown = (error as Error).message;
  }
  check('judge stream error propagates', /judge provider down/.test(thrown));
}

console.log('E2E: mini suite over real engine runs (source: eval)');
{
  const graph: WorkflowGraph = {
    nodes: [
      {
        id: 'trig',
        name: 'TRIG',
        kind: 'manual-trigger',
        category: 'trigger',
        icon: 'ti ti-player-play',
        position: { x: 0, y: 0 },
        ports: [{ id: 'trig-out-p', name: 'Out', role: 'message-out' }],
        data: {},
      },
      {
        id: 'a1',
        name: 'A1',
        kind: 'agent',
        category: 'agent',
        icon: 'ti ti-robot',
        position: { x: 200, y: 0 },
        ports: [{ id: 'a1-in-p', name: 'In', role: 'message-in' }],
        data: { prompt: 'Answer: {{input}}', provider: 'openai', model: 'scripted' },
      },
    ],
    connections: [
      { id: 'c1', outputId: 'trig-out-p-out', inputId: 'a1-in-p-in', kind: 'handoff' },
    ],
  };

  // Scripted workflow model: echoes a canned answer per input.
  const answers: Record<string, string> = {
    'What is 2+2?': '4',
    'Capital of France?': 'The capital of France is Paris.',
  };
  const model = {
    async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
      const question = request.messages
        .map(message => ('content' in message ? message.content : ''))
        .join(' ');
      const hit = Object.keys(answers).find(key => question.includes(key));
      yield { type: 'text', text: hit ? answers[hit] : 'unknown' };
    },
  };

  const cases: EvalCase[] = [
    evalCase({ id: 'c-exact', name: 'Exact', input: 'What is 2+2?', expected: '4', matcher: 'exact' }),
    evalCase({
      id: 'c-contains',
      name: 'Contains',
      input: 'Capital of France?',
      expected: 'paris',
      matcher: 'contains',
    }),
    evalCase({
      id: 'c-judge',
      name: 'Judge',
      input: 'Capital of France?',
      expected: 'Paris',
      matcher: 'llm-judge',
    }),
    evalCase({ id: 'c-fail', name: 'Fail', input: 'What is 2+2?', expected: '5', matcher: 'exact' }),
  ];

  const run: EvalRunSummary = {
    id: 'evalrun-1',
    suiteId: 'suite-1',
    workflowId: 'wf-test',
    suiteName: 'Suite',
    environment: 'local',
    status: 'running',
    models: [],
    results: [],
    startedAt: Date.now(),
  };

  for (const testCase of cases) {
    const runId = `run-eval-${testCase.id}`;
    const recorder = createRunRecorder({
      runId,
      workflowId: 'wf-test',
      workflowName: 'Eval Target',
      source: 'eval',
      environment: 'local',
      graph: structuredClone(graph),
    });
    const startedAt = Date.now();
    const handle = startRun({
      runId,
      graph: structuredClone(graph),
      input: testCase.input,
      source: 'eval',
      model: model as never,
      emit: event => recorder.record(event),
      requestApproval: async () => true,
    });
    await handle.done;
    const summary = recorder.summary();
    const output = summary.output ?? '';
    const score = await scoreOutput(
      testCase,
      output,
      testCase.matcher === 'llm-judge'
        ? textJudge('{"pass": true, "score": 1, "reasoning": "correct"}')
        : undefined,
    );
    run.results.push({
      caseId: testCase.id,
      runId,
      status: score.pass ? 'passed' : 'failed',
      output,
      score: score.score,
      judgeReasoning: score.reasoning,
      durationMs: Date.now() - startedAt,
    });

    if (testCase.id === 'c-exact') {
      const record = recorder.snapshot();
      check(
        'run-started stamped source eval',
        (record.events[0] as { source?: string }).source === 'eval',
      );
      check('summary source is eval', summary.source === 'eval');
      check('run completed', summary.status === 'completed');
    }
  }
  run.status = 'completed';
  run.endedAt = Date.now();

  const byId = new Map(run.results.map(result => [result.caseId, result]));
  check('exact case passed', byId.get('c-exact')?.status === 'passed');
  check('contains case passed', byId.get('c-contains')?.status === 'passed');
  check('judge case passed with score', byId.get('c-judge')?.score === 1);
  check('judge reasoning captured', byId.get('c-judge')?.judgeReasoning === 'correct');
  check('mismatched case failed', byId.get('c-fail')?.status === 'failed');
  check('every result links a runId', run.results.every(result => result.runId.startsWith('run-eval-')));
  const counts = evalPassCounts(run);
  check('pass counts 3/4', counts.passed === 3 && counts.total === 4);
  check(
    'model label helper',
    evalModelLabel({ provider: 'anthropic', model: 'claude-sonnet-5' }) === 'anthropic:claude-sonnet-5',
  );
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
