/**
 * Throwaway E2E for the ForEach + Wait-for-Event engine primitives.
 * Run: npx -y tsx engine-e2e-test.mts
 */
import { startRun, extractItems, interpolatePayload, mergePayloads } from '../src/index.js';
import type { RunEvent, WorkflowGraph } from '../src/index.js';

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── Unit: payload helpers ─────────────────────────────────────────────────────
console.log('payload helpers');
check(
  'interpolatePayload digs into JSON',
  interpolatePayload('key=signed:{{jobId}}', '{"jobId":"J42","x":1}') === 'key=signed:J42',
);
check(
  'interpolatePayload leaves unknown tokens',
  interpolatePayload('{{nope}}', '{"a":1}') === '{{nope}}',
);
check(
  '{{input}} is whole payload',
  interpolatePayload('<{{input}}>', 'hello') === '<hello>',
);
check(
  'extractItems: bare array',
  JSON.stringify(extractItems('[1,2,3]')) === '[1,2,3]',
);
check(
  'extractItems: single array property',
  JSON.stringify(extractItems('{"jobs":[{"id":1}]}')) === '[{"id":1}]',
);
check(
  'extractItems: itemsPath',
  JSON.stringify(extractItems('{"a":{"b":[5]},"c":[9]}', 'a.b')) === '[5]',
);
check(
  'extractItems: embedded array in prose',
  JSON.stringify(extractItems('Here you go:\n```json\n["x","y"]\n```')) === '["x","y"]',
);
check(
  'mergePayloads: object shallow-merge, event wins',
  mergePayloads('{"a":1,"b":2}', '{"b":3}') === '{"a":1,"b":3}',
);
check('mergePayloads: empty event keeps waiting payload', mergePayloads('keep', ' ') === 'keep');

// ── Graph builder helpers ─────────────────────────────────────────────────────
function node(
  id: string,
  kind: string,
  ports: { id: string; name: string; role: 'message-in' | 'message-out' | 'tools' }[],
  data: object = {},
) {
  return { id, name: id, kind, category: 'flow', icon: '', position: { x: 0, y: 0 }, ports, data };
}
function edge(id: string, fromPort: string, toPort: string) {
  return { id, outputId: `${fromPort}-out`, inputId: `${toPort}-in`, kind: 'handoff' as const };
}

// ── E2E 1: trigger → for-each → (body: wait-event → terminal), Done → terminal ─
console.log('\nE2E: for-each + wait-event');
{
  const graph: WorkflowGraph = {
    nodes: [
      node('trig', 'manual-trigger', [{ id: 'trig-start', name: 'Start', role: 'message-out' }]),
      node(
        'loop',
        'for-each',
        [
          { id: 'loop-in', name: 'In', role: 'message-in' },
          { id: 'loop-each', name: 'Each item', role: 'message-out' },
          { id: 'loop-done', name: 'Done', role: 'message-out' },
        ],
        { itemsPath: 'jobs' },
      ),
      node(
        'wait',
        'wait-event',
        [
          { id: 'wait-in', name: 'In', role: 'message-in' },
          { id: 'wait-out', name: 'Resumed', role: 'message-out' },
        ],
        { correlationKey: 'signed:{{jobId}}' },
      ),
    ],
    connections: [
      edge('e1', 'trig-start', 'loop-in'),
      edge('e2', 'loop-each', 'wait-in'),
      // wait-out unconnected → its output is each iteration's terminal result.
      // loop-done unconnected → aggregate JSON is the run's terminal output.
    ],
  };

  const events: RunEvent[] = [];
  const seenKeys: string[] = [];
  const input = JSON.stringify({ jobs: [{ jobId: 'J1' }, { jobId: 'J2' }, { jobId: 'J3' }] });

  const handle = startRun({
    runId: 'e2e-1',
    graph,
    input,
    model: { stream: async function* () { throw new Error('no model needed'); } } as never,
    emit: event => events.push(event),
    requestApproval: async () => true,
    waitForEvent: async (_nodeId, correlationKey) => {
      seenKeys.push(correlationKey);
      return JSON.stringify({ signed: true, key: correlationKey });
    },
  });
  await handle.done;

  const completed = events.find(e => e.type === 'run-completed') as
    | Extract<RunEvent, { type: 'run-completed' }>
    | undefined;
  check('run completed', !!completed, JSON.stringify(events.at(-1)));
  check(
    'correlation keys interpolated per item',
    JSON.stringify(seenKeys) === '["signed:J1","signed:J2","signed:J3"]',
    JSON.stringify(seenKeys),
  );
  const loopStarted = events.filter(e => e.type === 'loop-started');
  const iterations = events.filter(e => e.type === 'loop-iteration');
  const loopCompleted = events.find(e => e.type === 'loop-completed') as
    | Extract<RunEvent, { type: 'loop-completed' }>
    | undefined;
  check('one loop-started', loopStarted.length === 1);
  check('three loop-iterations', iterations.length === 3, String(iterations.length));
  check('loop-completed 3/3', loopCompleted?.succeeded === 3 && loopCompleted.failed === 0);
  const waitEvents = events.filter(e => e.type === 'wait-started');
  check('three wait-started events', waitEvents.length === 3);

  const aggregate = JSON.parse(completed?.output ?? '{}') as {
    results?: { signed?: boolean; jobId?: string }[];
    exceptions?: unknown[];
  };
  check('aggregate has 3 results', aggregate.results?.length === 3, completed?.output);
  check('event payload merged into item payload', aggregate.results?.[0]?.signed === true && aggregate.results?.[0]?.jobId === 'J1', JSON.stringify(aggregate.results?.[0]));
  check('no exceptions', aggregate.exceptions?.length === 0);
}

// ── E2E 2: per-item error isolation ───────────────────────────────────────────
console.log('\nE2E: per-item error isolation');
{
  const graph: WorkflowGraph = {
    nodes: [
      node('trig', 'manual-trigger', [{ id: 'trig-start', name: 'Start', role: 'message-out' }]),
      node('loop', 'for-each', [
        { id: 'loop-in', name: 'In', role: 'message-in' },
        { id: 'loop-each', name: 'Each item', role: 'message-out' },
        { id: 'loop-done', name: 'Done', role: 'message-out' },
      ]),
      node('wait', 'wait-event', [
        { id: 'wait-in', name: 'In', role: 'message-in' },
        { id: 'wait-out', name: 'Resumed', role: 'message-out' },
      ], { correlationKey: 'k:{{id}}' }),
    ],
    connections: [edge('e1', 'trig-start', 'loop-in'), edge('e2', 'loop-each', 'wait-in')],
  };

  const events: RunEvent[] = [];
  const handle = startRun({
    runId: 'e2e-2',
    graph,
    input: '[{"id":"ok1"},{"id":"boom"},{"id":"ok2"}]',
    model: { stream: async function* () { throw new Error('no model'); } } as never,
    emit: event => events.push(event),
    requestApproval: async () => true,
    waitForEvent: async (_n, key) => {
      if (key === 'k:boom') throw new Error('simulated integration failure');
      return `{"done":"${key}"}`;
    },
  });
  await handle.done;

  const completed = events.find(e => e.type === 'run-completed') as
    | Extract<RunEvent, { type: 'run-completed' }>
    | undefined;
  const loopCompleted = events.find(e => e.type === 'loop-completed') as
    | Extract<RunEvent, { type: 'loop-completed' }>
    | undefined;
  check('run still completed', !!completed);
  check('loop 2 succeeded / 1 failed', loopCompleted?.succeeded === 2 && loopCompleted.failed === 1, JSON.stringify(loopCompleted));
  const aggregate = JSON.parse(completed?.output ?? '{}') as {
    exceptions?: { error?: string; index?: number }[];
  };
  check(
    'exception recorded with index + message',
    aggregate.exceptions?.[0]?.index === 1 &&
      (aggregate.exceptions[0].error ?? '').includes('simulated integration failure'),
    JSON.stringify(aggregate.exceptions),
  );
}

// ── E2E 3: wait-event without a host capability fails descriptively ──────────
console.log('\nE2E: missing waitForEvent host');
{
  const graph: WorkflowGraph = {
    nodes: [
      node('trig', 'manual-trigger', [{ id: 'trig-start', name: 'Start', role: 'message-out' }]),
      node('wait', 'wait-event', [
        { id: 'wait-in', name: 'In', role: 'message-in' },
        { id: 'wait-out', name: 'Resumed', role: 'message-out' },
      ]),
    ],
    connections: [edge('e1', 'trig-start', 'wait-in')],
  };
  const events: RunEvent[] = [];
  const handle = startRun({
    runId: 'e2e-3',
    graph,
    input: 'x',
    model: { stream: async function* () { throw new Error('no model'); } } as never,
    emit: event => events.push(event),
    requestApproval: async () => true,
    // no waitForEvent
  });
  await handle.done;
  const failed = events.find(e => e.type === 'run-failed') as
    | Extract<RunEvent, { type: 'run-failed' }>
    | undefined;
  check('run failed descriptively', !!failed && failed.error.includes('cannot deliver events'), failed?.error);
}

// ── E2E 4: execution budget is configurable ───────────────────────────────────
console.log('\nE2E: maxExecutions budget');
{
  const items = JSON.stringify(Array.from({ length: 150 }, (_, i) => ({ id: i })));
  const graph: WorkflowGraph = {
    nodes: [
      node('trig', 'manual-trigger', [{ id: 'trig-start', name: 'Start', role: 'message-out' }]),
      node('loop', 'for-each', [
        { id: 'loop-in', name: 'In', role: 'message-in' },
        { id: 'loop-each', name: 'Each item', role: 'message-out' },
        { id: 'loop-done', name: 'Done', role: 'message-out' },
      ]),
      node('wait', 'wait-event', [
        { id: 'wait-in', name: 'In', role: 'message-in' },
        { id: 'wait-out', name: 'Resumed', role: 'message-out' },
      ], { correlationKey: 'k:{{id}}' }),
    ],
    connections: [edge('e1', 'trig-start', 'loop-in'), edge('e2', 'loop-each', 'wait-in')],
  };
  const events: RunEvent[] = [];
  const handle = startRun({
    runId: 'e2e-4',
    graph,
    input: items,
    maxExecutions: 500,
    model: { stream: async function* () { throw new Error('no model'); } } as never,
    emit: event => events.push(event),
    requestApproval: async () => true,
    waitForEvent: async () => '{}',
  });
  await handle.done;
  const loopCompleted = events.find(e => e.type === 'loop-completed') as
    | Extract<RunEvent, { type: 'loop-completed' }>
    | undefined;
  check('150 items complete under raised budget', loopCompleted?.succeeded === 150, JSON.stringify(loopCompleted));
}

// ── E2E 5: journal replay — resume after "eviction" without repeating waits ──
console.log('\nE2E: journal replay / resume');
{
  const graph: WorkflowGraph = {
    nodes: [
      node('trig', 'manual-trigger', [{ id: 'trig-start', name: 'Start', role: 'message-out' }]),
      node('loop', 'for-each', [
        { id: 'loop-in', name: 'In', role: 'message-in' },
        { id: 'loop-each', name: 'Each item', role: 'message-out' },
        { id: 'loop-done', name: 'Done', role: 'message-out' },
      ]),
      node('wait', 'wait-event', [
        { id: 'wait-in', name: 'In', role: 'message-in' },
        { id: 'wait-out', name: 'Resumed', role: 'message-out' },
      ], { correlationKey: 'sig:{{id}}' }),
    ],
    connections: [edge('e1', 'trig-start', 'loop-in'), edge('e2', 'loop-each', 'wait-in')],
  };
  const input = '[{"id":"A"},{"id":"B"},{"id":"C"}]';

  // Shared durable journal (simulates the DO's SQLite table).
  const store = new Map<string, { output: string; viaPortIds?: string[] }>();
  const journal = {
    lookup: (key: string) => store.get(key),
    record: (key: string, entry: { output: string; viaPortIds?: string[] }) => {
      store.set(key, entry);
    },
  };

  // Attempt 1: deliver only item A's event; item B suspends forever. We
  // then ABANDON the run without settling it — exactly what a Durable
  // Object eviction does to an in-flight promise chain.
  let firstAttemptWaits = 0;
  let bSuspended!: () => void;
  const bSuspendedSignal = new Promise<void>(resolve => (bSuspended = resolve));
  const events1: RunEvent[] = [];
  startRun({
    runId: 'resume-1',
    graph,
    input,
    journal,
    model: { stream: async function* () { throw new Error('no model'); } } as never,
    emit: e => events1.push(e),
    requestApproval: async () => true,
    waitForEvent: async (_n, key) => {
      firstAttemptWaits += 1;
      if (key === 'sig:A') return '{"signed":"A"}';
      bSuspended();
      return new Promise<string>(() => {}); // never resolves — abandoned
    },
  });
  await bSuspendedSignal; // run is now suspended on item B
  check('attempt 1 saw 2 wait registrations (A resolved, B pending)', firstAttemptWaits === 2, String(firstAttemptWaits));
  check('journal recorded completed nodes before eviction', store.size > 0, String(store.size));

  // Attempt 2: same run restarted with the journal. Item A must REPLAY (no
  // new wait), items B and C execute fresh.
  const waitKeys2: string[] = [];
  const events2: RunEvent[] = [];
  const handle2 = startRun({
    runId: 'resume-1',
    graph,
    input,
    journal,
    model: { stream: async function* () { throw new Error('no model'); } } as never,
    emit: e => events2.push(e),
    requestApproval: async () => true,
    waitForEvent: async (_n, key) => {
      waitKeys2.push(key);
      return `{"signed":"${key.slice(4)}"}`;
    },
  });
  await handle2.done;
  const completed2 = events2.find(e => e.type === 'run-completed') as
    | Extract<RunEvent, { type: 'run-completed' }>
    | undefined;
  check('attempt 2 completed', !!completed2);
  check(
    'item A replayed from journal (only B and C waited)',
    JSON.stringify(waitKeys2) === '["sig:B","sig:C"]',
    JSON.stringify(waitKeys2),
  );
  const aggregate2 = JSON.parse(completed2?.output ?? '{}') as { results?: { signed?: string }[]; exceptions?: unknown[] };
  check(
    'aggregate has all 3 results across attempts',
    aggregate2.results?.length === 3 &&
      aggregate2.results[0]?.signed === 'A' &&
      aggregate2.results[2]?.signed === 'C',
    completed2?.output,
  );
  check('no duplicate side effects: attempt 2 registered exactly 2 waits', waitKeys2.length === 2);
}

// ── E2E 6: wait-event timeout — expiry fails the item, loop continues ────────
console.log('\nE2E: wait-event timeout');
{
  const graph: WorkflowGraph = {
    nodes: [
      node('trig', 'manual-trigger', [{ id: 'trig-start', name: 'Start', role: 'message-out' }]),
      node('loop', 'for-each', [
        { id: 'loop-in', name: 'In', role: 'message-in' },
        { id: 'loop-each', name: 'Each item', role: 'message-out' },
        { id: 'loop-done', name: 'Done', role: 'message-out' },
      ]),
      node('wait', 'wait-event', [
        { id: 'wait-in', name: 'In', role: 'message-in' },
        { id: 'wait-out', name: 'Resumed', role: 'message-out' },
      ], { correlationKey: 'k:{{id}}', timeoutHours: 0.0001 }), // ~0.36s
    ],
    connections: [edge('e1', 'trig-start', 'loop-in'), edge('e2', 'loop-each', 'wait-in')],
  };
  const events: RunEvent[] = [];
  const timeoutsSeen: (number | undefined)[] = [];
  const handle = startRun({
    runId: 'e2e-6',
    graph,
    input: '[{"id":"fast"},{"id":"slow"}]',
    model: { stream: async function* () { throw new Error('no model'); } } as never,
    emit: event => events.push(event),
    requestApproval: async () => true,
    waitForEvent: (_n, key, _m, _p, timeoutMs) => {
      timeoutsSeen.push(timeoutMs);
      if (key === 'k:fast') return Promise.resolve('{"ok":true}');
      // "slow" never gets an event — the host enforces the timeout.
      return new Promise<string>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`Timed out waiting for external event "${key}".`)), timeoutMs ?? 60_000);
      });
    },
  });
  await handle.done;
  const completed = events.find(e => e.type === 'run-completed') as
    | Extract<RunEvent, { type: 'run-completed' }>
    | undefined;
  const loopCompleted = events.find(e => e.type === 'loop-completed') as
    | Extract<RunEvent, { type: 'loop-completed' }>
    | undefined;
  check('run completed despite the timeout', !!completed);
  check(
    'timeoutMs derived from timeoutHours reached the host',
    timeoutsSeen.every(value => value === 360),
    JSON.stringify(timeoutsSeen),
  );
  check('1 succeeded / 1 timed out', loopCompleted?.succeeded === 1 && loopCompleted.failed === 1, JSON.stringify(loopCompleted));
  const aggregate = JSON.parse(completed?.output ?? '{}') as { exceptions?: { error?: string }[] };
  check(
    'timeout recorded as an exception',
    (aggregate.exceptions?.[0]?.error ?? '').includes('Timed out'),
    JSON.stringify(aggregate.exceptions),
  );
}

// ── E2E 7: ask-user surfaces a question and merges the response ──────────────
console.log('\nE2E: ask-user');
{
  const graph: WorkflowGraph = {
    nodes: [
      node('trig', 'manual-trigger', [{ id: 'trig-start', name: 'Start', role: 'message-out' }]),
      node(
        'ask',
        'ask-user',
        [
          { id: 'ask-in', name: 'In', role: 'message-in' },
          { id: 'ask-out', name: 'Answered', role: 'message-out' },
        ],
        { question: 'Approve draft for {{customer}}?', responseKey: 'userResponse' },
      ),
    ],
    connections: [edge('e1', 'trig-start', 'ask-in')],
  };

  const events: RunEvent[] = [];
  const seenQuestions: string[] = [];
  const handle = startRun({
    runId: 'e2e-7',
    graph,
    input: JSON.stringify({ customer: 'Acme', draft: 'v1' }),
    model: { stream: async function* () { throw new Error('no model needed'); } } as never,
    emit: event => events.push(event),
    requestApproval: async () => true,
    requestInput: async (_nodeId, question) => {
      seenQuestions.push(question);
      return 'yes, ship it';
    },
    waitForEvent: async () => {
      throw new Error('not used');
    },
  });
  await handle.done;

  const completed = events.find(e => e.type === 'run-completed') as
    | Extract<RunEvent, { type: 'run-completed' }>
    | undefined;
  check('run completed', !!completed, JSON.stringify(events.at(-1)));
  check(
    'question template interpolated against payload',
    seenQuestions[0] === 'Approve draft for Acme?',
    seenQuestions[0],
  );
  const askRequired = events.filter(e => e.type === 'ask-required');
  const askResolved = events.filter(e => e.type === 'ask-resolved');
  check('one ask-required event', askRequired.length === 1);
  check('one ask-resolved event', askResolved.length === 1);
  const output = JSON.parse(completed?.output ?? '{}') as {
    customer?: string;
    draft?: string;
    userResponse?: string;
  };
  check(
    'response merged under responseKey, original fields preserved',
    output.userResponse === 'yes, ship it' && output.customer === 'Acme' && output.draft === 'v1',
    JSON.stringify(output),
  );
}

// ── E2E 8: ask-user with empty question falls back to payload ────────────────
console.log('\nE2E: ask-user empty question falls back to payload');
{
  const graph: WorkflowGraph = {
    nodes: [
      node('trig', 'manual-trigger', [{ id: 'trig-start', name: 'Start', role: 'message-out' }]),
      node(
        'ask',
        'ask-user',
        [
          { id: 'ask-in', name: 'In', role: 'message-in' },
          { id: 'ask-out', name: 'Answered', role: 'message-out' },
        ],
        { responseKey: 'answer' },
      ),
    ],
    connections: [edge('e1', 'trig-start', 'ask-in')],
  };

  const events: RunEvent[] = [];
  let seenQuestion = '';
  const handle = startRun({
    runId: 'e2e-8',
    graph,
    input: 'What size do you want?',
    model: { stream: async function* () { throw new Error('no model needed'); } } as never,
    emit: event => events.push(event),
    requestApproval: async () => true,
    requestInput: async (_nodeId, question) => {
      seenQuestion = question;
      return 'large';
    },
    waitForEvent: async () => {
      throw new Error('not used');
    },
  });
  await handle.done;

  check('empty question falls back to payload', seenQuestion === 'What size do you want?', seenQuestion);
  const completed = events.find(e => e.type === 'run-completed') as
    | Extract<RunEvent, { type: 'run-completed' }>
    | undefined;
  const output = JSON.parse(completed?.output ?? '{}') as { answer?: string };
  check('custom responseKey honored', output.answer === 'large', JSON.stringify(output));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
