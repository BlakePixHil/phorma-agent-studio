/**
 * System One decisions: the shared transport contract plus the three graph-walk
 * consumers that ship first - Router Decide mode, Approval Gate auto-resolve
 * and the Decide node. Every engine assertion runs a real `startRun`.
 */

import { describe, expect, it } from 'vitest';

import {
  CLOUDFLARE_CAPABILITIES,
  TAURI_DESKTOP_CAPABILITIES,
  inspectAgainstCapabilities,
  validateAgainstCapabilities,
} from './capabilities.js';
import type { HostCapabilities } from './data-host.js';
import { DataTransportError, HttpStatusError } from './data-host.js';
import {
  DECISION_API_HOST,
  FetchDecisionClient,
  buildDecisionQuestions,
  compactDecisionAnswers,
  decisionCostUsd,
  decisionResultFromHttp,
  mergeDecisionAnswers,
  nodeUsesDecisions,
  payloadToState,
  uniqueOptionLabels,
  validateDecisionRequest,
  type DecisionClient,
} from './decisions.js';
import { startRun, type RunOptions } from './engine.js';
import type { RunEvent } from './events.js';
import { createDecisionFixtureSession, decisionRequestFingerprint } from './fixtures.js';
import { decideRetry } from './retry.js';
import {
  FakeDecisionClient,
  MemoryFixtureStore,
  NEVER_CALLED_MODEL,
  choice,
  noul,
} from './test/fake-host.js';
import type { WorkflowConnection, WorkflowGraph, WorkflowNode, WorkflowPort } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

function port(id: string, role: WorkflowPort['role'], name = id): WorkflowPort {
  return { id, name, role };
}

/** Wires `fromPort` (an out-port id) to the `-in` port of node `toNode`. */
function handoff(id: string, fromPort: string, toNode: string): WorkflowConnection {
  return { id, outputId: `${fromPort}-out`, inputId: `${toNode}-in-in`, kind: 'handoff' };
}

function trigger(): WorkflowNode {
  return {
    id: 'trigger',
    name: 'Manual',
    kind: 'manual-trigger',
    category: 'trigger',
    icon: 'ti ti-player-play',
    position: { x: 0, y: 0 },
    ports: [port('trigger-out', 'message-out')],
    data: {},
  };
}

function sink(id: string): WorkflowNode {
  return {
    id,
    name: id,
    // A pass-through flow node: completes with its input, no host needed.
    kind: 'parallel',
    category: 'flow',
    icon: 'ti ti-square',
    position: { x: 0, y: 0 },
    ports: [port(`${id}-in`, 'message-in'), port(`${id}-out`, 'message-out')],
    data: {},
  };
}

function routerGraph(data: object, routes = ['Billing', 'Technical', 'Not sure']): WorkflowGraph {
  const router: WorkflowNode = {
    id: 'router',
    name: 'Router',
    kind: 'router',
    category: 'flow',
    icon: 'ti ti-arrows-split-2',
    position: { x: 0, y: 0 },
    ports: [
      port('router-in', 'message-in', 'In'),
      ...routes.map((name, index) => port(`router-r${index}`, 'message-out', name)),
    ],
    data,
  };
  const sinks = routes.map((_, index) => sink(`s${index}`));
  return {
    nodes: [trigger(), router, ...sinks],
    connections: [
      handoff('c0', 'trigger-out', 'router'),
      ...routes.map((_, index) => handoff(`cr${index}`, `router-r${index}`, `s${index}`)),
    ],
  };
}

function singleNodeGraph(node: WorkflowNode): WorkflowGraph {
  return {
    nodes: [trigger(), node, sink('after')],
    connections: [handoff('c0', 'trigger-out', node.id), handoff('c1', `${node.id}-out`, 'after')],
  };
}

async function run(
  graph: WorkflowGraph,
  input: string,
  extra: Partial<RunOptions> = {},
): Promise<{ events: RunEvent[]; approvals: number }> {
  const events: RunEvent[] = [];
  let approvals = 0;
  const handle = startRun({
    runId: 'run-decisions',
    graph,
    input,
    workflowId: 'wf-decisions',
    model: NEVER_CALLED_MODEL,
    emit: event => events.push(event),
    requestApproval: async () => {
      approvals++;
      return true;
    },
    requestInput: async () => '',
    ...extra,
  });
  await handle.done;
  return { events, approvals };
}

const ofType = <T extends RunEvent['type']>(events: RunEvent[], type: T) =>
  events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);

const completedIds = (events: RunEvent[]): string[] =>
  ofType(events, 'node-completed').map(event => event.nodeId);

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('decision request validation', () => {
  const base = { model: 'jev-latest', state: 'hello' };

  it('accepts a well-formed mixed request', () => {
    expect(
      validateDecisionRequest({
        ...base,
        questions: {
          urgent: { type: 'noul', instructions: 'Is it urgent?' },
          team: { type: 'choice', instructions: 'Which team?', criteria: { a: null, b: 'B work' } },
          mood: { type: 'score', instructions: 'Mood?', criteria: ['calm', 'angry'] },
        },
      }),
    ).toBeNull();
  });

  it('rejects the documented API limits before any call', () => {
    const many = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null]));
    expect(
      validateDecisionRequest({ ...base, questions: { q: { type: 'choice', instructions: 'x', criteria: many } } }),
    ).toContain('limit is 255');
    expect(
      validateDecisionRequest({ ...base, questions: { q: { type: 'score', instructions: 'x', criteria: ['only'] } } }),
    ).toContain('between 2 and 10');
    expect(validateDecisionRequest({ ...base, questions: {} })).toContain('No questions');
    expect(validateDecisionRequest({ ...base, state: '   ', questions: { q: { type: 'noul', instructions: 'x' } } })).toContain('empty');
    expect(
      validateDecisionRequest({ ...base, questions: { '1bad': { type: 'noul', instructions: 'x' } } }),
    ).toContain('must start with a letter');
  });
});

describe('payloadToState', () => {
  it('uses the parsed JSON document, narrowed by a state path', () => {
    const payload = JSON.stringify({ ticket: { message: 'refund please' }, noise: 'x'.repeat(50) });
    expect(payloadToState(payload)).toEqual(JSON.parse(payload));
    expect(payloadToState(payload, 'ticket.message')).toBe('refund please');
    expect(payloadToState(payload, '$.ticket')).toEqual({ message: 'refund please' });
  });

  it('keeps plain text and never sends an empty state', () => {
    expect(payloadToState('plain words')).toBe('plain words');
    expect(payloadToState('')).toBe('(no input provided)');
    expect(payloadToState('{"a":1}', 'missing.path')).toEqual({ a: 1 });
  });
});

describe('answer shaping', () => {
  it('compacts nouls to numbers and keeps choice/score detail', () => {
    const compact = compactDecisionAnswers({
      refund: noul(0.93),
      topic: choice('billing', { billing: 0.9, other: 0.1 }, 0.8),
    });
    expect(compact['refund']).toBe(0.93);
    expect(compact['topic']).toEqual({ choice: 'billing', confidence: 0.8, probabilities: { billing: 0.9, other: 0.1 } });
  });

  it('merges into JSON objects and wraps anything else under input', () => {
    expect(JSON.parse(mergeDecisionAnswers('{"a":1}', 'decisions', { x: noul(0.2) }))).toEqual({
      a: 1,
      decisions: { x: 0.2 },
    });
    expect(JSON.parse(mergeDecisionAnswers('free text', 'd', { x: noul(1) }))).toEqual({ input: 'free text', d: { x: 1 } });
  });

  it('dedupes option labels deterministically', () => {
    expect(uniqueOptionLabels(['A', 'a', '', 'B'], i => `Route ${i + 1}`)).toEqual(['A', 'a (2)', 'Route 3', 'B']);
  });

  it('builds wire questions from authored specs and rejects duplicate ids', () => {
    const built = buildDecisionQuestions([
      { id: 'urgent', type: 'noul', instructions: 'Urgent?', yes: 'Time-sensitive' },
      { id: 'team', type: 'choice', instructions: 'Team?', options: [{ label: 'Billing' }, { label: 'Tech', description: 'Bugs' }] },
      { id: 'mood', type: 'score', instructions: 'Mood?', levels: ['Calm', 'Angry'] },
    ]);
    expect('questions' in built && built.questions).toEqual({
      urgent: { type: 'noul', instructions: 'Urgent?', criteria: { true: 'Time-sensitive' } },
      team: { type: 'choice', instructions: 'Team?', criteria: { Billing: null, Tech: 'Bugs' } },
      mood: { type: 'score', instructions: 'Mood?', criteria: ['Calm', 'Angry'] },
    });
    expect(buildDecisionQuestions([{ id: 'a', type: 'noul', instructions: 'x' }, { id: 'a', type: 'noul', instructions: 'y' }])).toEqual({
      error: 'Question id "a" is used twice.',
    });
  });

  it('prices input tokens only', () => {
    expect(decisionCostUsd({ inputTokens: 1_000_000, outputTokens: 999 })).toBeCloseTo(0.042, 10);
  });
});

describe('HTTP result classification', () => {
  it('parses a documented response and requires every asked id', () => {
    const body = JSON.stringify({
      model: 'jev-1.13.0',
      answers: { is_urgent: { type: 'noul', noul: 0.95 } },
      usage: { input_tokens: 296, output_tokens: 20 },
    });
    expect(decisionResultFromHttp(200, {}, body, ['is_urgent'])).toEqual({
      model: 'jev-1.13.0',
      answers: { is_urgent: { type: 'noul', noul: 0.95 } },
      usage: { inputTokens: 296, outputTokens: 20 },
    });
    expect(() => decisionResultFromHttp(200, {}, body, ['missing'])).toThrow('no answer for "missing"');
  });

  it('raises a retry-classifiable status error carrying lower-cased headers', () => {
    let caught: unknown;
    try {
      decisionResultFromHttp(429, { 'Retry-After': '2' }, '{"error":"slow down"}');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpStatusError);
    expect((caught as HttpStatusError).headers['retry-after']).toBe('2');
    const decision = decideRetry({
      error: caught,
      attempt: 1,
      policy: { idempotent: true },
      nowMs: 0,
      random: () => 0.5,
    });
    expect(decision).toEqual({ retry: true, delayMs: 2000, reason: 'retry-after' });
  });

  it('treats 529 overloaded as transient', () => {
    const error = new HttpStatusError(529, {}, '');
    expect(decideRetry({ error, attempt: 1, policy: { idempotent: true }, nowMs: 0, random: () => 0 }).retry).toBe(true);
  });

  it('names the key problem on 401 without echoing it', () => {
    expect(() => decisionResultFromHttp(401, {}, '')).toThrow(/TypeSafe API key/);
  });
});

describe('FetchDecisionClient', () => {
  it('posts the request with a bearer key and parses the answer', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = new FetchDecisionClient(async () => 'ts-key-123', {
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(
          JSON.stringify({ model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.4 } }, usage: {} }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    const result = await client.evaluate({ model: 'jev-latest', state: 's', questions: { q: { type: 'noul', instructions: 'q?' } } });
    expect(result.answers['q']).toEqual({ type: 'noul', noul: 0.4 });
    expect(seen[0]?.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((seen[0]?.init.headers as Record<string, string>)['authorization']).toBe('Bearer ts-key-123');
  });

  it('fails clearly without a key and classifies network failure as transport', async () => {
    await expect(
      new FetchDecisionClient(async () => null).evaluate({ model: 'm', state: 's', questions: {} }),
    ).rejects.toThrow('No TypeSafe API key');
    const offline = new FetchDecisionClient(async () => 'k', {
      fetch: (async () => {
        throw new TypeError('network down');
      }) as unknown as typeof fetch,
    });
    await expect(
      offline.evaluate({ model: 'm', state: 's', questions: { q: { type: 'noul', instructions: 'q' } } }),
    ).rejects.toBeInstanceOf(DataTransportError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Router Decide mode
// ─────────────────────────────────────────────────────────────────────────────

describe('router decide mode', () => {
  const decideData = {
    mode: 'decide',
    instructions: 'Which team should handle this ticket?',
    routeCriteria: { 'router-r0': 'Charges and refunds' },
    unsurePortId: 'router-r2',
    minConfidence: 0.6,
  };

  it('routes on a confident Choice keyed by port name and labels the edge', async () => {
    const client = new FakeDecisionClient([
      { route: choice('Technical', { Billing: 0.05, Technical: 0.95 }, 0.9) },
    ]);
    const { events } = await run(routerGraph(decideData), 'The API returns 500 on every call', { decisions: client });

    expect(completedIds(events)).toContain('s1');
    expect(completedIds(events)).not.toContain('s0');
    expect(completedIds(events)).not.toContain('s2');

    // The unsure port is never offered as an option, and descriptions ride along.
    const question = client.requests[0]?.questions['route'];
    expect(question).toEqual({
      type: 'choice',
      instructions: 'Which team should handle this ticket?',
      criteria: { Billing: 'Charges and refunds', Technical: null },
    });

    const [decision] = ofType(events, 'decision');
    expect(decision).toMatchObject({ purpose: 'route', selectedPortId: 'router-r1', model: 'jev-1.13.0' });
    expect(decision?.fallback).toBeUndefined();

    const [usage] = ofType(events, 'node-usage');
    expect(usage).toMatchObject({ provider: 'typesafe', model: 'jev-1.13.0' });
    expect(usage?.usage.costUsd).toBeCloseTo(0.000042, 10);
  });

  it('takes the unsure port below the confidence threshold', async () => {
    const client = new FakeDecisionClient([{ route: choice('Billing', { Billing: 0.55, Technical: 0.45 }, 0.1) }]);
    const { events } = await run(routerGraph(decideData), 'hmm', { decisions: client });
    expect(completedIds(events)).toContain('s2');
    expect(ofType(events, 'decision')[0]).toMatchObject({ selectedPortId: 'router-r2', fallback: 'low-confidence' });
  });

  it('falls back to keyword routing, loudly, when the host has no decision client', async () => {
    const { events } = await run(routerGraph(decideData), 'this is about Billing');
    expect(completedIds(events)).toContain('s0');
    expect(ofType(events, 'decision')[0]).toMatchObject({ fallback: 'no-transport', selectedPortId: 'router-r0' });
  });

  it('leaves keyword mode byte-identical to the historical behaviour', async () => {
    const { events } = await run(routerGraph({ instructions: '' }), 'please route to technical');
    expect(completedIds(events)).toContain('s1');
    expect(ofType(events, 'decision')).toEqual([]);
  });

  it('retries a 429 through the shared classifier', async () => {
    const client = new FakeDecisionClient([
      new HttpStatusError(429, { 'retry-after': '0' }, ''),
      { route: choice('Billing', { Billing: 1, Technical: 0 }, 1) },
    ]);
    const { events } = await run(routerGraph(decideData), 'refund', { decisions: client });
    expect(client.calls).toBe(2);
    expect(ofType(events, 'node-retrying')).toHaveLength(1);
    expect(completedIds(events)).toContain('s0');
  });

  it('narrows the state with a state path', async () => {
    const client = new FakeDecisionClient([{ route: choice('Billing', { Billing: 1, Technical: 0 }, 1) }]);
    await run(
      routerGraph({ ...decideData, statePath: 'ticket.body' }),
      JSON.stringify({ ticket: { body: 'charged twice' }, audit: { huge: true } }),
      { decisions: client },
    );
    expect(client.requests[0]?.state).toBe('charged twice');
  });

  it('records then replays a decision fixture without calling the model', async () => {
    const store = new MemoryFixtureStore();
    const data = { ...decideData, fixtures: 'replay-or-record' };
    const first = new FakeDecisionClient([{ route: choice('Technical', { Billing: 0, Technical: 1 }, 1) }]);
    await run(routerGraph(data), 'bug', { decisions: first, fixtures: store });
    expect(store.writes).toBe(1);

    const second = new FakeDecisionClient([]);
    const { events } = await run(routerGraph(data), 'bug', { decisions: second, fixtures: store });
    expect(second.calls).toBe(0);
    expect(completedIds(events)).toContain('s1');
    expect(ofType(events, 'decision')[0]).toMatchObject({ replayed: true, durationMs: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Approval Gate auto-resolve
// ─────────────────────────────────────────────────────────────────────────────

function gateGraph(autoResolve: object): WorkflowGraph {
  const gate: WorkflowNode = {
    id: 'gate',
    name: 'Approval',
    kind: 'approval-gate',
    category: 'flow',
    icon: 'ti ti-user-check',
    position: { x: 0, y: 0 },
    ports: [port('gate-in', 'message-in'), port('gate-ok', 'message-out', 'Approved'), port('gate-no', 'message-out', 'Rejected')],
    data: { message: 'Send this reply?', autoResolve },
  };
  return {
    nodes: [trigger(), gate, sink('approved'), sink('rejected')],
    connections: [
      handoff('c0', 'trigger-out', 'gate'),
      handoff('c1', 'gate-ok', 'approved'),
      handoff('c2', 'gate-no', 'rejected'),
    ],
  };
}

describe('approval gate auto-resolve', () => {
  const auto = { enabled: true, question: 'Is this reply safe to send?', approveAt: 0.9, rejectAt: 0.1 };

  it('approves a confident yes without prompting a human', async () => {
    const { events, approvals } = await run(gateGraph(auto), 'Thanks!', {
      decisions: new FakeDecisionClient([{ approve: noul(0.97) }]),
    });
    expect(approvals).toBe(0);
    expect(ofType(events, 'approval-required')).toEqual([]);
    expect(ofType(events, 'approval-resolved')[0]).toMatchObject({ approved: true, actor: 'system-one' });
    expect(completedIds(events)).toContain('approved');
  });

  it('rejects a confident no without prompting a human', async () => {
    const { events, approvals } = await run(gateGraph(auto), 'rude', {
      decisions: new FakeDecisionClient([{ approve: noul(0.02) }]),
    });
    expect(approvals).toBe(0);
    expect(completedIds(events)).toContain('rejected');
  });

  it('asks a human in the uncertain band and shows them the probability', async () => {
    const { events, approvals } = await run(gateGraph(auto), 'unsure', {
      decisions: new FakeDecisionClient([{ approve: noul(0.5) }]),
    });
    expect(approvals).toBe(1);
    expect(ofType(events, 'approval-required')[0]?.decisionProbability).toBe(0.5);
    expect(ofType(events, 'approval-resolved')[0]?.actor).toBeUndefined();
  });

  it('fails naming the missing capability when enabled on a host without decisions', async () => {
    const { events } = await run(gateGraph(auto), 'x');
    expect(ofType(events, 'run-failed')[0]?.error).toContain('"decisions" capability');
  });

  it('never asks System One when auto-resolve is off', async () => {
    const client = new FakeDecisionClient([]);
    const { approvals } = await run(gateGraph({ enabled: false }), 'x', { decisions: client });
    expect(client.calls).toBe(0);
    expect(approvals).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Decide node
// ─────────────────────────────────────────────────────────────────────────────

function decideNode(data: object, withErrorPort = false): WorkflowNode {
  return {
    id: 'decide',
    name: 'Decide',
    kind: 'decide',
    category: 'flow',
    icon: 'ti ti-scale',
    position: { x: 0, y: 0 },
    ports: [
      port('decide-in', 'message-in'),
      port('decide-out', 'message-out'),
      ...(withErrorPort ? [port('decide-err', 'message-out', 'On error')] : []),
    ],
    data: withErrorPort ? { ...data, errorPortId: 'decide-err' } : data,
  };
}

describe('decide node', () => {
  const questions = [
    { id: 'refund', type: 'noul', instructions: 'Does the customer request a refund?' },
    {
      id: 'topic',
      type: 'choice',
      instructions: 'Which team?',
      options: [{ label: 'billing' }, { label: 'technical' }],
    },
  ];

  it('asks every question in one call and merges compact answers into the payload', async () => {
    const client = new FakeDecisionClient([
      { refund: noul(0.91), topic: choice('billing', { billing: 0.8, technical: 0.2 }, 0.7) },
    ]);
    const { events } = await run(singleNodeGraph(decideNode({ questions })), '{"id":"T-1","text":"charged twice"}', {
      decisions: client,
    });
    expect(client.calls).toBe(1);
    const output = ofType(events, 'node-completed').find(event => event.nodeId === 'decide')?.output ?? '';
    expect(JSON.parse(output)).toEqual({
      id: 'T-1',
      text: 'charged twice',
      decisions: {
        refund: 0.91,
        topic: { choice: 'billing', confidence: 0.7, probabilities: { billing: 0.8, technical: 0.2 } },
      },
    });
    expect(ofType(events, 'decision')[0]).toMatchObject({ purpose: 'decide' });
  });

  it('honours a custom result key', async () => {
    const client = new FakeDecisionClient([{ refund: noul(0.1), topic: choice('technical', { billing: 0, technical: 1 }, 1) }]);
    const { events } = await run(singleNodeGraph(decideNode({ questions, resultKey: 'triage' })), 'x', { decisions: client });
    const output = ofType(events, 'node-completed').find(event => event.nodeId === 'decide')?.output ?? '';
    expect(JSON.parse(output)).toMatchObject({ input: 'x', triage: { refund: 0.1 } });
  });

  it('routes a failure through a wired On error port', async () => {
    const node = decideNode({ questions, retry: { disabled: true } }, true);
    const graph: WorkflowGraph = {
      nodes: [trigger(), node, sink('after'), sink('handler')],
      connections: [
        handoff('c0', 'trigger-out', 'decide'),
        handoff('c1', 'decide-out', 'after'),
        handoff('c2', 'decide-err', 'handler'),
      ],
    };
    const { events } = await run(graph, 'x', {
      decisions: new FakeDecisionClient([new HttpStatusError(422, {}, '{"detail":"bad"}')]),
    });
    expect(completedIds(events)).toContain('handler');
    expect(completedIds(events)).not.toContain('after');
    expect(ofType(events, 'run-failed')).toEqual([]);
  });

  it('fails with an authoring message before any call when a question is malformed', async () => {
    const client = new FakeDecisionClient([]);
    const { events } = await run(
      singleNodeGraph(decideNode({ questions: [{ id: 'c', type: 'choice', instructions: 'x', options: [{ label: 'only' }] }] })),
      'x',
      { decisions: client },
    );
    expect(client.calls).toBe(0);
    expect(ofType(events, 'run-failed')[0]?.error).toContain('needs at least two options');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures + capabilities
// ─────────────────────────────────────────────────────────────────────────────

describe('decision fixtures', () => {
  it('fingerprints model, state and questions, and round-trips answers', async () => {
    const request = { model: 'jev-1.13.0', state: 'a', questions: { q: { type: 'noul' as const, instructions: 'x' } } };
    expect(decisionRequestFingerprint(request)).toBe(decisionRequestFingerprint({ ...request }));
    expect(decisionRequestFingerprint(request)).not.toBe(decisionRequestFingerprint({ ...request, model: 'jev-latest' }));

    const store = new MemoryFixtureStore();
    const options = {
      mode: 'replay-or-record',
      nodeId: 'n',
      payload: 'p',
      occurrence: 0,
      requestFingerprint: decisionRequestFingerprint(request),
      store,
    };
    const session = createDecisionFixtureSession(options);
    expect(await session.read()).toBeUndefined();
    await session.write({ model: 'jev-1.13.0', answers: { q: noul(0.3) }, usage: { inputTokens: 5, outputTokens: 1 } });
    const replay = await createDecisionFixtureSession(options).read();
    expect(replay?.value.answers['q']).toEqual(noul(0.3));
  });
});

describe('capabilities and egress', () => {
  const decideSpec = { graph: singleNodeGraph(decideNode({ questions: [] })) };
  const noDecisions: HostCapabilities = {
    ...CLOUDFLARE_CAPABILITIES,
    features: { ...CLOUDFLARE_CAPABILITIES.features, decisions: false },
  };

  it('declares the decision host in egress for any System One step', () => {
    expect(inspectAgainstCapabilities(decideSpec, TAURI_DESKTOP_CAPABILITIES, []).egressHosts).toContain(DECISION_API_HOST);
    expect(
      inspectAgainstCapabilities({ graph: routerGraph({ mode: 'decide' }) }, TAURI_DESKTOP_CAPABILITIES, []).egressHosts,
    ).toContain(DECISION_API_HOST);
    expect(
      inspectAgainstCapabilities({ graph: routerGraph({ mode: 'keyword' }) }, TAURI_DESKTOP_CAPABILITIES, []).egressHosts,
    ).not.toContain(DECISION_API_HOST);
  });

  it('errors for a Decide node but only warns for a Decide-mode router on a host without decisions', () => {
    const decideFindings = validateAgainstCapabilities(decideSpec, noDecisions, []);
    expect(decideFindings.some(f => f.severity === 'error' && f.message.includes('System One'))).toBe(true);
    const routerFindings = validateAgainstCapabilities({ graph: routerGraph({ mode: 'decide' }) }, noDecisions, []);
    expect(routerFindings.filter(f => f.message.includes('System One')).map(f => f.severity)).toEqual(['warning']);
  });

  it('detects every decision-using configuration', () => {
    expect(nodeUsesDecisions({ kind: 'agent', data: { verify: { enabled: true } } })).toBe(true);
    expect(nodeUsesDecisions({ kind: 'agent', data: { preselect: { enabled: true } } })).toBe(true);
    expect(nodeUsesDecisions({ kind: 'approval-gate', data: { autoResolve: { enabled: true } } })).toBe(true);
    expect(nodeUsesDecisions({ kind: 'portal-trigger', data: { guardrails: { input: { enabled: true } } } })).toBe(true);
    expect(nodeUsesDecisions({ kind: 'agent', data: { verify: { enabled: false } } })).toBe(false);
  });
});

// A typed reference so the DecisionClient contract stays assignable from the fake.
const _contract: DecisionClient = new FakeDecisionClient();
void _contract;
