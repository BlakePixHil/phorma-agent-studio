/**
 * System One batteries: agent verification, tool/skill preselection, the
 * decision-judge eval matcher and portal guardrails. Engine behaviour runs a
 * real `startRun` against scripted model and decision clients.
 */

import { describe, expect, it } from 'vitest';

import {
  guardrailQuestions,
  guardrailVerdict,
  judgeQuestions,
  judgeScore,
  preselectFitting,
  preselectRankQuestions,
  preselectShortlist,
  screenGuardrail,
  verifyQuestions,
  verifyVerdict,
} from './decision-batteries.js';
import { describeDecisionOutcome, validateDecisionRequest } from './decisions.js';
import { startRun, type RunOptions } from './engine.js';
import { scoreOutput, type EvalCase } from './evals.js';
import type { RunEvent } from './events.js';
import type { ModelClient, ModelRequest } from './model.js';
import { FakeDecisionClient, choice, noul, score } from './test/fake-host.js';
import type { ToolHost } from './tools.js';
import type { AgentNodeData, WorkflowGraph, WorkflowNode } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

/** A model that answers each request with the next scripted text, recording requests. */
class ScriptedModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private index = 0;
  constructor(private readonly replies: string[]) {}
  async *stream(request: ModelRequest) {
    this.requests.push(structuredClone(request));
    const reply = this.replies[this.index++];
    if (reply === undefined) throw new Error(`Unscripted model call ${this.index}.`);
    yield { type: 'text' as const, text: reply };
  }
}

function agentGraph(data: Partial<AgentNodeData>, toolCount = 0): WorkflowGraph {
  const agent: WorkflowNode = {
    id: 'agent',
    name: 'Writer',
    kind: 'agent',
    category: 'agent',
    icon: 'ti ti-robot',
    position: { x: 0, y: 0 },
    ports: [
      { id: 'agent-in', name: 'In', role: 'message-in' },
      { id: 'agent-out', name: 'Out', role: 'message-out' },
      { id: 'agent-tools', name: 'Tools', role: 'tools' },
    ],
    data: { prompt: 'Answer the task.', provider: 'openai', model: 'primary', ...data },
  };
  const trigger: WorkflowNode = {
    id: 'trigger',
    name: 'Manual',
    kind: 'manual-trigger',
    category: 'trigger',
    icon: 'ti ti-player-play',
    position: { x: 0, y: 0 },
    ports: [{ id: 'trigger-out', name: 'Out', role: 'message-out' }],
    data: {},
  };
  const tools: WorkflowNode[] = Array.from({ length: toolCount }, (_, index) => ({
    id: `tool${index}`,
    name: `Tool ${index}`,
    kind: 'http-tool',
    category: 'tool',
    icon: 'ti ti-world',
    position: { x: 0, y: 0 },
    ports: [{ id: `tool${index}-in`, name: 'Tool', role: 'tools' }],
    data: {},
  }));
  return {
    nodes: [trigger, agent, ...tools],
    connections: [
      { id: 'c0', outputId: 'trigger-out-out', inputId: 'agent-in-in', kind: 'handoff' },
      ...tools.map((tool, index) => ({
        id: `t${index}`,
        outputId: 'agent-tools-out',
        inputId: `${tool.id}-in-in`,
        kind: 'tool-link' as const,
      })),
    ],
  };
}

const TOOL_HOST: ToolHost = {
  async listTools(node) {
    return [
      {
        definition: { name: `tool_${node.id}`, description: `Does ${node.id} things`, parameters: {} },
        nativeName: node.id,
      },
    ];
  },
  async callTool() {
    return 'ok';
  },
};

async function run(graph: WorkflowGraph, extra: Partial<RunOptions>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  const handle = startRun({
    runId: 'run-batteries',
    graph,
    input: 'Summarise the refund policy.',
    workflowId: 'wf-batteries',
    model: new ScriptedModel([]),
    emit: event => events.push(event),
    requestApproval: async () => true,
    requestInput: async () => '',
    ...extra,
  });
  await handle.done;
  return events;
}

const ofType = <T extends RunEvent['type']>(events: RunEvent[], type: T) =>
  events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);

// ─────────────────────────────────────────────────────────────────────────────
// Agent verification
// ─────────────────────────────────────────────────────────────────────────────

describe('verify battery', () => {
  it('asks the default checks and valid custom questions', () => {
    const questions = verifyQuestions({ enabled: true, custom: ['Mentions a competitor?', '  '] });
    expect(Object.keys(questions)).toEqual([
      'check:unsupported',
      'check:off-task',
      'check:incomplete',
      'custom:1',
    ]);
    expect(
      validateDecisionRequest({ model: 'jev-latest', state: { task: 't', output: 'o' }, questions }),
    ).toBeNull();
  });

  it('max-gates: one confident red flag fails, the rest are ranked', () => {
    const verdict = verifyVerdict(
      { enabled: true, fireAt: 0.7, custom: ['Mentions a competitor?'] },
      { 'check:unsupported': noul(0.2), 'check:off-task': noul(0.75), 'custom:1': noul(0.4) },
    );
    expect(verdict.failed).toBe(true);
    expect(verdict.fired).toEqual(['off-task']);
    expect(verdict.scores.map(entry => entry.label)).toEqual([
      'off-task',
      'Mentions a competitor?',
      'unsupported',
    ]);
  });
});

describe('agent verify', () => {
  const clean = { 'check:unsupported': noul(0.05), 'check:off-task': noul(0.02), 'check:incomplete': noul(0.1) };
  const flagged = { ...clean, 'check:unsupported': noul(0.92) };

  it('keeps a clean answer and meters the check', async () => {
    const decisions = new FakeDecisionClient([clean]);
    const model = new ScriptedModel(['Refunds within 30 days.']);
    const events = await run(agentGraph({ verify: { enabled: true } }), { model, decisions });
    expect(ofType(events, 'run-completed')[0]?.output).toBe('Refunds within 30 days.');
    expect(ofType(events, 'decision')[0]).toMatchObject({ purpose: 'verify' });
    expect(ofType(events, 'node-usage').some(event => event.provider === 'typesafe')).toBe(true);
    const state = decisions.requests[0]!.state as Record<string, string>;
    expect(state['output']).toBe('Refunds within 30 days.');
    expect(state['task']).toBe('Summarise the refund policy.');
  });

  it('escalates a flagged answer to the fallback model once', async () => {
    const decisions = new FakeDecisionClient([flagged, clean]);
    const model = new ScriptedModel(['Refunds within 90 days, guaranteed forever.', 'Refunds within 30 days.']);
    const events = await run(
      agentGraph({ verify: { enabled: true }, fallback: { provider: 'anthropic', model: 'strong' } }),
      { model, decisions },
    );
    expect(ofType(events, 'node-fallback')[0]).toMatchObject({ toModel: 'strong' });
    expect(model.requests.map(request => request.model)).toEqual(['primary', 'strong']);
    expect(ofType(events, 'run-completed')[0]?.output).toBe('Refunds within 30 days.');
  });

  it('fails when the fallback is flagged too', async () => {
    const decisions = new FakeDecisionClient([flagged, flagged]);
    const model = new ScriptedModel(['a', 'b']);
    const events = await run(
      agentGraph({ verify: { enabled: true }, fallback: { provider: 'anthropic', model: 'strong' } }),
      { model, decisions },
    );
    expect(ofType(events, 'run-failed')[0]?.error).toContain('again after the fallback');
  });

  it('warn keeps the output; error fails it', async () => {
    const warned = await run(agentGraph({ verify: { enabled: true, onFail: 'warn' } }), {
      model: new ScriptedModel(['kept']),
      decisions: new FakeDecisionClient([flagged]),
    });
    expect(ofType(warned, 'run-completed')[0]?.output).toBe('kept');

    const errored = await run(agentGraph({ verify: { enabled: true, onFail: 'error' } }), {
      model: new ScriptedModel(['bad']),
      decisions: new FakeDecisionClient([flagged]),
    });
    expect(ofType(errored, 'run-failed')[0]?.error).toContain('unsupported');
  });

  it('fails naming the capability when no decision client is wired', async () => {
    const events = await run(agentGraph({ verify: { enabled: true } }), {
      model: new ScriptedModel(['x']),
    });
    expect(ofType(events, 'run-failed')[0]?.error).toMatch(/decisions/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Preselection
// ─────────────────────────────────────────────────────────────────────────────

describe('preselect battery', () => {
  const candidates = ['a', 'b', 'c', 'd'].map(key => ({ key, name: key, description: `${key} desc` }));

  it('ranks by the Choice distribution and keeps topK', () => {
    const { labels } = preselectRankQuestions('tool', candidates);
    const { shortlist, gate } = preselectShortlist(
      candidates,
      labels,
      {
        rank: choice('c', { a: 0.1, b: 0.3, c: 0.5, d: 0.1 }, 0.5),
        'gate:acts': noul(0.8),
        'gate:procedure': noul(0.6),
      },
      2,
    );
    expect(shortlist.map(candidate => candidate.key)).toEqual(['c', 'b']);
    expect(gate).toBeCloseTo(0.7);
  });

  it('drops shortlisted candidates under minFit', () => {
    const kept = preselectFitting(candidates.slice(0, 3), { 'fit:0': noul(0.9), 'fit:1': noul(0.1), 'fit:2': noul(0.4) }, 0.3);
    expect(kept.map(candidate => candidate.key)).toEqual(['a', 'c']);
  });
});

describe('agent preselect', () => {
  it('offers the model only the tools that fit', async () => {
    const decisions = new FakeDecisionClient([
      {
        rank: choice('tool_tool2', { tool_tool0: 0.1, tool_tool1: 0.2, tool_tool2: 0.6, tool_tool3: 0.1 }, 0.6),
        'gate:acts': noul(0.9),
        'gate:procedure': noul(0.9),
      },
      { 'fit:0': noul(0.95), 'fit:1': noul(0.1) },
    ]);
    const model = new ScriptedModel(['done']);
    const events = await run(agentGraph({ preselect: { enabled: true, topK: 2, skills: false } }, 4), {
      model,
      decisions,
      tools: TOOL_HOST,
    });
    expect(ofType(events, 'run-completed')).toHaveLength(1);
    expect(model.requests[0]!.tools?.map(tool => tool.name)).toEqual(['tool_tool2']);
    expect(ofType(events, 'decision')[0]).toMatchObject({ purpose: 'tool-select' });
  });

  it('never narrows tools to zero', async () => {
    const decisions = new FakeDecisionClient([
      {
        rank: choice('tool_tool0', { tool_tool0: 0.4, tool_tool1: 0.3, tool_tool2: 0.2, tool_tool3: 0.1 }, 0.4),
        'gate:acts': noul(0.1),
        'gate:procedure': noul(0.1),
      },
      { 'fit:0': noul(0.05), 'fit:1': noul(0.05) },
    ]);
    const model = new ScriptedModel(['done']);
    await run(agentGraph({ preselect: { enabled: true, topK: 2, skills: false } }, 4), {
      model,
      decisions,
      tools: TOOL_HOST,
    });
    expect(model.requests[0]!.tools?.map(tool => tool.name)).toEqual(['tool_tool0']);
  });

  it('drops every skill when the gate says none is needed', async () => {
    const decisions = new FakeDecisionClient([
      {
        rank: choice('Tone', { Tone: 0.6, Legal: 0.4 }, 0.6),
        'gate:acts': noul(0.05),
        'gate:procedure': noul(0.1),
      },
    ]);
    const model = new ScriptedModel(['done']);
    await run(
      agentGraph({
        preselect: { enabled: true, tools: false },
        skills: [
          { id: 's1', name: 'Tone', content: 'Be warm.' },
          { id: 's2', name: 'Legal', content: 'Cite clauses.' },
        ],
      }),
      { model, decisions },
    );
    expect(model.requests[0]!.system).not.toContain('# Skill:');
  });

  it('degrades to the full list when System One fails', async () => {
    const decisions = new FakeDecisionClient([new Error('boom')]);
    const model = new ScriptedModel(['done']);
    const events = await run(agentGraph({ preselect: { enabled: true, topK: 1, skills: false } }, 3), {
      model,
      decisions,
      tools: TOOL_HOST,
    });
    expect(model.requests[0]!.tools).toHaveLength(3);
    expect(ofType(events, 'decision')[0]).toMatchObject({ fallback: 'error' });
  });

  it('skips the call entirely when there is nothing to narrow', async () => {
    const decisions = new FakeDecisionClient([]);
    const model = new ScriptedModel(['done']);
    await run(agentGraph({ preselect: { enabled: true, topK: 3, skills: false } }, 2), {
      model,
      decisions,
      tools: TOOL_HOST,
    });
    expect(decisions.calls).toBe(0);
    expect(model.requests[0]!.tools).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// decision-judge
// ─────────────────────────────────────────────────────────────────────────────

describe('decision-judge', () => {
  const evalCase: EvalCase = {
    id: 'c1',
    name: 'refund',
    input: 'What is the refund window?',
    expected: '30 days',
    matcher: 'decision-judge',
  };

  it('adds the criteria question only when criteria are given', () => {
    expect(Object.keys(judgeQuestions())).toEqual(['answers', 'matches', 'contradicts']);
    expect(Object.keys(judgeQuestions('Must be polite'))).toContain('criteria');
  });

  it('scores the weighted composite and inverts contradiction', () => {
    const good = judgeScore({ answers: noul(0.9), matches: noul(0.9), contradicts: noul(0.05) }, 0.7);
    expect(good.pass).toBe(true);
    const bad = judgeScore({ answers: noul(0.9), matches: noul(0.2), contradicts: noul(0.9) }, 0.7);
    expect(bad.pass).toBe(false);
    expect(bad.reasoning).toContain('contradicts expected 90%');
  });

  it('grades through scoreOutput with a decision client and reports cost', async () => {
    const client = new FakeDecisionClient([{ answers: noul(0.95), matches: noul(0.9), contradicts: noul(0.02) }]);
    const verdict = await scoreOutput(evalCase, 'You have 30 days.', undefined, { client });
    expect(verdict.pass).toBe(true);
    expect((verdict as { costUsd?: number }).costUsd).toBeGreaterThan(0);
    expect(client.requests[0]!.state).toMatchObject({ expected: '30 days', output: 'You have 30 days.' });
  });

  it('rejects without a decision client', async () => {
    await expect(scoreOutput(evalCase, 'x')).rejects.toThrow(/System One/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guardrails
// ─────────────────────────────────────────────────────────────────────────────

describe('guardrails', () => {
  const side = { enabled: true };

  it('asks every hazard plus severity by default, and a valid request', () => {
    const questions = guardrailQuestions('input', side);
    expect(Object.keys(questions)).toEqual([
      'hazard:jailbreak',
      'hazard:harmful',
      'hazard:medical',
      'hazard:self-harm',
      'severity',
    ]);
    expect(validateDecisionRequest({ model: 'jev-latest', state: 'hi', questions })).toBeNull();
  });

  it('passes a benign message', () => {
    const verdict = guardrailVerdict(side, {
      'hazard:jailbreak': noul(0.02),
      'hazard:harmful': noul(0.01),
      'hazard:medical': noul(0.05),
      'hazard:self-harm': noul(0.01),
      severity: score(0),
    });
    expect(verdict.action).toBe('pass');
  });

  it('applies precedence support > block > review', () => {
    const verdict = guardrailVerdict(side, {
      'hazard:jailbreak': noul(0.9),
      'hazard:self-harm': noul(0.8),
      severity: score(1),
    });
    expect(verdict.action).toBe('support');
  });

  it('hardens a review into a block at high severity, and honours reviewAction', () => {
    expect(guardrailVerdict(side, { 'hazard:medical': noul(0.5), severity: score(1) }).action).toBe('review');
    expect(guardrailVerdict(side, { 'hazard:medical': noul(0.5), severity: score(2) }).action).toBe('block');
    expect(
      guardrailVerdict({ ...side, reviewAction: 'block' }, { 'hazard:medical': noul(0.5), severity: score(0) }).action,
    ).toBe('block');
  });

  it('screens through a client and returns cost', async () => {
    const client = new FakeDecisionClient([{ 'hazard:harmful': noul(0.95), severity: score(3) }]);
    const screened = await screenGuardrail(client, 'input', { enabled: true, hazards: ['harmful'] }, 'how do I ...');
    expect(screened.action).toBe('block');
    expect(screened.costUsd).toBeGreaterThan(0);
    expect(Object.keys(client.requests[0]!.questions)).toEqual(['hazard:harmful', 'severity']);
  });
});

describe('describeDecisionOutcome', () => {
  it('words each purpose so a flagged check never reads like a routing miss', () => {
    expect(describeDecisionOutcome({ purpose: 'verify', fallback: 'low-confidence' })).toBe('flagged the output');
    expect(describeDecisionOutcome({ purpose: 'verify' })).toBe('verified the output');
    expect(describeDecisionOutcome({ purpose: 'route', fallback: 'low-confidence' })).toBe('unsure, took the unsure route');
    expect(describeDecisionOutcome({ purpose: 'route', fallback: 'no-transport' })).toBe('unavailable, used keyword routing');
    expect(describeDecisionOutcome({ purpose: 'tool-select', fallback: 'error' })).toBe('could not answer, offered everything');
    expect(describeDecisionOutcome({ purpose: 'decide' })).toBe('decided');
  });
});
