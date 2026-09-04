/**
 * The failure `code` a run event carries (stripe-billing requirement 19).
 *
 * Requirement 19 is "the gate returns a stable machine code AND every consumer
 * branches on it instead of prose". A type field nothing populates satisfies
 * neither half, so every assertion here runs against events a real `startRun`
 * ACTUALLY EMITTED, with the code entering the way it enters in production: as
 * `ModelRequestError.code`, which the studio's `/api/infer` client lifts off the
 * refusal body before the refusal becomes an ordinary `Error` travelling through
 * the engine.
 *
 * The negative cases are the load-bearing ones. `code` is only worth branching
 * on while it means "the responder issued this token", so an ordinary failure
 * must leave the field ABSENT (not empty), and a Node socket error - which
 * populates its own unrelated `code` - must not be mistaken for one.
 *
 * **Validates: Requirements 19**
 */

import { describe, expect, it } from 'vitest';

import { startRun } from './engine.js';
import type { RunEvent } from './events.js';
import { ModelRequestError, type ModelChunk, type ModelClient } from './model.js';
import { createRunRecorder } from './run-record.js';
import type { WorkflowGraph, WorkflowNode } from './types.js';

const RUN_ID = 'run-failure-code';

/** The gate's real token for an exhausted balance, per `cloud/src/tenants.ts`. */
const CREDITS_EXHAUSTED = 'credits_exhausted';

/** The shape `PhormaCloudModelClient` throws on a 402 from `/api/infer`. */
function refusal(code?: string): ModelRequestError {
  return new ModelRequestError(
    `Phorma Cloud request failed (402): Monthly credits exhausted.`,
    402,
    code,
  );
}

/** A model client that always fails the way `thrown` describes. */
function failingModel(thrown: unknown): ModelClient {
  return {
    // eslint-disable-next-line require-yield
    async *stream(): AsyncIterable<ModelChunk> {
      throw thrown;
    },
  };
}

function trigger(): WorkflowNode {
  return {
    id: 'trigger',
    name: 'Manual',
    kind: 'manual-trigger',
    category: 'trigger',
    icon: 'ti ti-player-play',
    position: { x: 0, y: 0 },
    ports: [{ id: 'trigger-out-1', name: 'Out', role: 'message-out' }],
    data: {},
  };
}

/** An agent with a hosted model, so the run really calls the model client. */
function agent(): WorkflowNode {
  return {
    id: 'agent-1',
    name: 'Writer',
    kind: 'agent',
    category: 'agent',
    icon: 'ti ti-user',
    position: { x: 200, y: 0 },
    ports: [
      { id: 'agent-in-1', name: 'In', role: 'message-in' },
      { id: 'agent-out-1', name: 'Out', role: 'message-out' },
    ],
    data: { provider: 'phorma-cloud', model: 'anthropic/claude-sonnet-4', prompt: 'Write.' },
  };
}

const GRAPH: WorkflowGraph = {
  nodes: [trigger(), agent()],
  connections: [{ id: 'c1', outputId: 'trigger-out-1', inputId: 'agent-in-1', kind: 'handoff' }],
};

/** Runs the one-agent graph against a model client that fails with `thrown`. */
async function runFailing(thrown: unknown): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  const handle = startRun({
    runId: RUN_ID,
    graph: GRAPH,
    input: '{}',
    model: failingModel(thrown),
    emit: (event) => events.push(event),
    requestApproval: async () => true,
    requestInput: async () => '',
  });
  await handle.done;
  return events;
}

function terminal(events: readonly RunEvent[]): Extract<RunEvent, { type: 'run-failed' }> {
  const failed = events.filter(
    (event): event is Extract<RunEvent, { type: 'run-failed' }> => event.type === 'run-failed',
  );
  expect(failed).toHaveLength(1);
  return failed[0]!;
}

/**
 * The agent's own `node-failed`. A propagating failure also fails every ancestor
 * frame in the walk (the trigger here), so this filters by node rather than
 * asserting a single event.
 */
function nodeFailure(events: readonly RunEvent[]): Extract<RunEvent, { type: 'node-failed' }> {
  const failed = events.filter(
    (event): event is Extract<RunEvent, { type: 'node-failed' }> =>
      event.type === 'node-failed' && event.nodeId === 'agent-1',
  );
  expect(failed).toHaveLength(1);
  return failed[0]!;
}

describe('run failure code (requirement 19)', () => {
  it('carries an entitlement refusal code out to the terminal run-failed event', async () => {
    const events = await runFailing(refusal(CREDITS_EXHAUSTED));

    // The whole point: a consumer can pick the "Buy credits" CTA off this field
    // without matching a word of the message.
    expect(terminal(events).code).toBe(CREDITS_EXHAUSTED);
    // ...and the node that hit the wall names it too, so the trace can attribute
    // the refusal to a node rather than only to the run.
    expect(nodeFailure(events).code).toBe(CREDITS_EXHAUSTED);
  });

  it('keeps the message intact alongside the code, so the prose fallback still works', async () => {
    const events = await runFailing(refusal(CREDITS_EXHAUSTED));

    // Requirement 20: an older worker sends no code, and consumers fall back to
    // this regex. Adding the code must not have replaced the prose.
    expect(terminal(events).error).toMatch(/credits exhausted/i);
    expect(terminal(events).error).toContain('402');
  });

  it('leaves the field undefined - never an empty token - for an ordinary failure', async () => {
    const events = await runFailing(new Error('the model provider melted'));

    // `event.code ?? fallback` is what every consumer relies on. A
    // present-but-empty token would read as "coded" and skip the fallback.
    expect(terminal(events).code).toBeUndefined();
    expect(nodeFailure(events).code).toBeUndefined();
    // And it does not survive serialization, so nothing downstream of the
    // WebSocket relay or the run record sees the key at all.
    expect(JSON.parse(JSON.stringify(terminal(events)))).not.toHaveProperty('code');
  });

  it('leaves the field absent for a refusal from a worker that predates the code', async () => {
    const events = await runFailing(refusal(undefined));

    expect(terminal(events).code).toBeUndefined();
    // The fallback regex is the only thing left, and it still matches.
    expect(terminal(events).error).toMatch(/credits exhausted/i);
  });

  it('never mistakes a socket error\u2019s own `code` for an entitlement token', async () => {
    // undici and Node populate `code` on transport failures. A duck-typed reader
    // would stamp `ECONNRESET` into a field documented as a billing token, and
    // the run record would then carry a token that means nothing.
    const socket = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const events = await runFailing(socket);

    expect(terminal(events).code).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain('ECONNRESET');
  });

  it('preserves the code through the run recorder, so run history keeps it', async () => {
    const events = await runFailing(refusal(CREDITS_EXHAUSTED));
    const recorder = createRunRecorder({
      runId: RUN_ID,
      workflowId: null,
      workflowName: 'Failure code',
      source: 'manual',
      environment: 'local',
      graph: GRAPH,
    });
    for (const event of events) recorder.record(event);

    const recorded = recorder
      .snapshot()
      .events.find((event) => event.type === 'run-failed');
    expect(recorded).toBeDefined();
    expect((recorded as { code?: string }).code).toBe(CREDITS_EXHAUSTED);
  });
});
