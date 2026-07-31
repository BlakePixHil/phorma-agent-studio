/**
 * Unit tests for `for-each` batch mode as the engine actually runs it
 * (design §5.5, Requirements 9.8, 9.9, 9.11).
 *
 * `batchItems` is exhaustively covered by its own property test; what these
 * cases pin down is the WIRING: what the loop reports as `loop-started.total`,
 * what a body execution receives as its payload, and that an absent or
 * out-of-range `batchSize` leaves today's per-item behaviour untouched.
 */

import { describe, expect, it } from 'vitest';

import { startRun } from './engine.js';
import type { RunEvent } from './events.js';
import type { ModelClient } from './model.js';
import type { ForEachNodeData, WorkflowGraph, WorkflowNode } from './types.js';

const RUN_ID = 'run-1';

const NEVER_CALLED_MODEL: ModelClient = {
  async *stream() {
    throw new Error('No model call is expected in these scripted runs.');
  },
};

function port(id: string, role: 'message-in' | 'message-out') {
  return { id, name: id, role };
}

function connect(id: string, outputId: string, inputId: string) {
  return { id, outputId, inputId, kind: 'handoff' as const };
}

function trigger(): WorkflowNode {
  return {
    id: 'trigger',
    name: 'Manual',
    kind: 'manual-trigger',
    category: 'trigger',
    icon: 'pi-play',
    position: { x: 0, y: 0 },
    ports: [port('trigger-out-1', 'message-out')],
    data: {},
  };
}

function forEachNode(data: Partial<ForEachNodeData>): WorkflowNode {
  return {
    id: 'loop-1',
    name: 'Each record',
    kind: 'for-each',
    category: 'flow',
    icon: 'ti ti-repeat',
    position: { x: 200, y: 0 },
    ports: [
      port('loop-1-in-1', 'message-in'),
      port('loop-1-out-1', 'message-out'),
      port('loop-1-done-1', 'message-out'),
    ],
    data: data as ForEachNodeData,
  };
}

/**
 * Loop body: a byte-identical pass-through node, so its completed output is
 * the iteration payload. `router` with a single out-port always matches that
 * port and returns the payload unchanged (unlike `transform`, which requires
 * at least one field to execute at all).
 */
function body(): WorkflowNode {
  return {
    id: 'body',
    name: 'Body',
    kind: 'router',
    category: 'flow',
    icon: 'pi-sliders-h',
    position: { x: 400, y: 0 },
    ports: [port('body-in-1', 'message-in'), port('body-out-1', 'message-out')],
    data: {},
  };
}

function eventsOf<T extends RunEvent['type']>(
  events: readonly RunEvent[],
  type: T,
): Extract<RunEvent, { type: T }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

interface Result {
  readonly events: RunEvent[];
  /** The payload each body execution received, in iteration order. */
  readonly bodyPayloads: string[];
  readonly failure: string | undefined;
}

async function runLoop(data: Partial<ForEachNodeData>, input: string): Promise<Result> {
  const events: RunEvent[] = [];
  const graph: WorkflowGraph = {
    nodes: [trigger(), forEachNode(data), body()],
    connections: [
      connect('c1', 'trigger-out-1', 'loop-1-in-1'),
      connect('c2', 'loop-1-out-1', 'body-in-1'),
    ],
  };

  const handle = startRun({
    runId: RUN_ID,
    graph,
    input,
    workflowId: 'wf-1',
    model: NEVER_CALLED_MODEL,
    emit: event => events.push(event),
    requestApproval: async () => true,
    requestInput: async () => '',
  });
  await handle.done;

  return {
    events,
    // The body node is a pass-through, so its output IS the payload it received.
    bodyPayloads: eventsOf(events, 'node-completed')
      .filter(event => event.nodeId === 'body')
      .map(event => event.output),
    failure: eventsOf(events, 'node-failed').find(event => event.nodeId === 'loop-1')?.error,
  };
}

// ── batch mode (9.8, 9.11) ───────────────────────────────────────────────────

describe('for-each batch mode', () => {
  it('reports the batch count as the total and hands each batch to the body', async () => {
    const run = await runLoop(
      { itemsPath: 'records', batchSize: 2, concurrency: 1, continueOnError: true },
      JSON.stringify({ records: [1, 2, 3, 4, 5] }),
    );

    expect(run.failure).toBeUndefined();

    // ceil(5 / 2) = 3 iterations, not 5 (Requirements 9.8, 9.11).
    const started = eventsOf(run.events, 'loop-started');
    expect(started).toHaveLength(1);
    expect(started[0]!.total).toBe(3);

    const iterations = eventsOf(run.events, 'loop-iteration');
    expect(iterations.map(event => event.index)).toEqual([0, 1, 2]);
    expect(iterations.every(event => event.total === 3)).toBe(true);
    // `loop-iteration.item` is the batch array (Requirement 9.11); only the
    // last batch is short.
    expect(iterations.map(event => event.item)).toEqual(['[1,2]', '[3,4]', '[5]']);

    // The body sees the batch, so a "max N per call" API is one config field.
    expect(run.bodyPayloads).toEqual(['[1,2]', '[3,4]', '[5]']);

    const completed = eventsOf(run.events, 'loop-completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ total: 3, succeeded: 3, failed: 0 });
  });

  it('runs one iteration when the batch size covers every item', async () => {
    const run = await runLoop(
      { itemsPath: 'records', batchSize: 100 },
      JSON.stringify({ records: ['a', 'b', 'c'] }),
    );

    expect(eventsOf(run.events, 'loop-started')[0]!.total).toBe(1);
    expect(run.bodyPayloads).toEqual(['["a","b","c"]']);
  });

  it('runs zero iterations for an empty source list', async () => {
    const run = await runLoop({ itemsPath: 'records', batchSize: 3 }, JSON.stringify({ records: [] }));

    expect(eventsOf(run.events, 'loop-started')[0]!.total).toBe(0);
    expect(eventsOf(run.events, 'loop-iteration')).toHaveLength(0);
    expect(run.bodyPayloads).toEqual([]);
  });
});

// ── per-item fallback (9.9) ──────────────────────────────────────────────────

describe('for-each per-item fallback', () => {
  it('keeps one item per iteration when batchSize is absent', async () => {
    const run = await runLoop({ itemsPath: 'records' }, JSON.stringify({ records: [1, 2, 3] }));

    expect(eventsOf(run.events, 'loop-started')[0]!.total).toBe(3);
    expect(eventsOf(run.events, 'loop-iteration').map(event => event.item)).toEqual(['1', '2', '3']);
    expect(run.bodyPayloads).toEqual(['1', '2', '3']);
  });

  it.each([0, 1, -4, 1.5, 10_001])('keeps one item per iteration for batchSize %s', async size => {
    const run = await runLoop(
      { itemsPath: 'records', batchSize: size },
      JSON.stringify({ records: ['x', 'y'] }),
    );

    expect(eventsOf(run.events, 'loop-started')[0]!.total).toBe(2);
    // A string item still travels as its raw text, exactly as before.
    expect(run.bodyPayloads).toEqual(['x', 'y']);
  });
});
