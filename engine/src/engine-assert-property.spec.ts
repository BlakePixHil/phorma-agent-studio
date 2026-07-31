import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { startRun } from './engine.js';
import type { RunEvent } from './events.js';
import type { ModelClient } from './model.js';
import type { SyncSummary } from './run-record.js';
import type {
  Assertion,
  AssertNodeData,
  TransformNodeData,
  WorkflowGraph,
  WorkflowNode,
} from './types.js';

/**
 * Property 10: A breached guard stops the write path (design §5.6) — claims 48,
 * 49 and 50:
 *
 *  48. **Pass-through fidelity.** ∀ payload `p` where all guards hold: the output
 *      payload is exactly `p`.
 *  49. **Guard completeness.** ∀ assertion set `A`: all of `A` is evaluated and
 *      reported, even when the first breaches.
 *  50. **No downstream on breach.** ∀ breach with `onBreach: 'fail'`: no node
 *      reachable only through the `Passed` port executes.
 *
 * Every case drives the REAL `startRun` over a small graph whose `assert` node
 * sits between a trigger and a two-node `Passed` chain, so "stops the write path"
 * is observed the way an operator observes it: the downstream nodes never emit a
 * `node-started` event. Nothing is mocked — the guard, its expression compiler,
 * the routing decision and the sync audit record are the engine's own.
 *
 * Assertion expressions are drawn from two pools whose verdict is fixed
 * independently of the payload (`true` / `1 == 1` … vs `false` / `null` / `0` /
 * `''` …), which is what lets the expected verdict be computed in the test
 * without re-implementing the evaluator. Requirement 7.1's four falsy results are
 * all represented in the breaching pool.
 *
 * **Validates: Requirements 7.1, 7.2, 7.4**
 */

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const RUN_ID = 'run-1';
const WORKFLOW_ID = 'wf-1';

/** A guard reads no model, so any model call is a defect in the executor. */
const NEVER_CALLED_MODEL: ModelClient = {
  async *stream() {
    throw new Error('A guard must never call a model.');
  },
};

/** Expressions whose result always holds, whatever the payload (7.1). */
const HOLDING_EXPRESSIONS: readonly string[] = [
  'true',
  '1 == 1',
  "'ok'",
  '42',
  'isNull($.__absent__)',
  '$.__absent__ == null',
];

/** Expressions whose result is always one of `false`, `null`, `0`, `''` (7.1). */
const BREACHING_EXPRESSIONS: readonly string[] = [
  'false',
  'null',
  '0',
  "''",
  '1 == 2',
  '$.__absent__',
];

function port(id: string, role: 'message-in' | 'message-out', name = id) {
  return { id, name, role };
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

/**
 * A downstream marker: a `transform` that cannot fail, so a `node-started` for
 * it means the guard let the payload through and nothing else.
 */
function marker(id: string): WorkflowNode {
  return {
    id,
    name: id,
    kind: 'transform',
    category: 'data',
    icon: 'pi-sliders-h',
    position: { x: 600, y: 0 },
    ports: [port(`${id}-in-1`, 'message-in'), port(`${id}-out-1`, 'message-out')],
    data: {
      passthrough: true,
      fields: [{ target: 'seen', expression: 'true' }],
    } as TransformNodeData,
  };
}

const PASS_PORT = 'assert-1-out-pass';
const FAIL_PORT = 'assert-1-out-fail';

function assertNode(data: AssertNodeData): WorkflowNode {
  return {
    id: 'assert-1',
    name: 'Guard',
    kind: 'assert',
    category: 'data',
    icon: 'ti ti-shield-check',
    position: { x: 300, y: 0 },
    ports: [
      port('assert-1-in-1', 'message-in', 'In'),
      port(PASS_PORT, 'message-out', 'Passed'),
      port(FAIL_PORT, 'message-out', 'Failed'),
    ],
    data,
  };
}

function connect(id: string, outputId: string, inputId: string) {
  return { id, outputId, inputId, kind: 'handoff' as const };
}

interface Setup {
  readonly assertions: Assertion[];
  readonly onBreach?: 'fail' | 'route';
  /** Wires the `Failed` port, which is what makes `route` legal (7.6). */
  readonly wireFailed?: boolean;
  readonly payload: string;
}

/**
 * trigger → Guard, then `Passed` → `pass-1` → `pass-2`. Both pass nodes are
 * reachable ONLY through the `Passed` port, which is exactly what claim 50
 * quantifies over. `caught` hangs off `Failed` when the setup wires it.
 */
function graphFor(setup: Setup): WorkflowGraph {
  const data: AssertNodeData = {
    assertions: setup.assertions,
    ...(setup.onBreach ? { onBreach: setup.onBreach } : {}),
    ...(setup.wireFailed ? { failedPortId: FAIL_PORT } : {}),
  };
  const nodes = [trigger(), assertNode(data), marker('pass-1'), marker('pass-2')];
  const connections = [
    connect('c1', 'trigger-out-1', 'assert-1-in-1'),
    connect('c2', PASS_PORT, 'pass-1-in-1'),
    connect('c3', 'pass-1-out-1', 'pass-2-in-1'),
  ];
  if (setup.wireFailed) {
    nodes.push(marker('caught'));
    connections.push(connect('c4', FAIL_PORT, 'caught-in-1'));
  }
  return { nodes, connections };
}

interface RunResult {
  readonly events: RunEvent[];
  /** The guard's outgoing payload, when it completed. */
  readonly output: string | undefined;
  /** The guard's failure message, when it failed. */
  readonly failure: string | undefined;
  /** Node ids that started, in order. */
  readonly started: string[];
  readonly summary: SyncSummary | undefined;
}

async function runGuard(setup: Setup): Promise<RunResult> {
  const events: RunEvent[] = [];
  const handle = startRun({
    runId: RUN_ID,
    graph: graphFor(setup),
    input: setup.payload,
    workflowId: WORKFLOW_ID,
    model: NEVER_CALLED_MODEL,
    emit: (event) => events.push(event),
    requestApproval: async () => true,
    requestInput: async () => '',
  });
  await handle.done;

  return {
    events,
    output: eventsOf(events, 'node-completed').find((event) => event.nodeId === 'assert-1')?.output,
    failure: eventsOf(events, 'node-failed').find((event) => event.nodeId === 'assert-1')?.error,
    started: eventsOf(events, 'node-started').map((event) => event.nodeId),
    summary: eventsOf(events, 'sync-summary')[0]?.summary,
  };
}

function eventsOf<T extends RunEvent['type']>(
  events: readonly RunEvent[],
  type: T,
): Extract<RunEvent, { type: T }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

// ─────────────────────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────────────────────

/** One planned assertion: its intended verdict, severity and declared message. */
interface Plan {
  readonly holds: boolean;
  readonly severity: 'error' | 'warn';
  readonly message: string | null;
  readonly expression: string;
}

const planArb = (holds?: boolean): fc.Arbitrary<Plan> =>
  fc
    .record({
      holds: holds === undefined ? fc.boolean() : fc.constant(holds),
      severity: fc.constantFrom('error' as const, 'warn' as const),
      // A DECLARED message: non-blank on purpose. A whitespace-only message is
      // not a declaration, and the executor rightly falls back to the
      // expression source for it (Requirement 7.3).
      message: fc.option(fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,19}$/), { nil: null }),
      holding: fc.constantFrom(...HOLDING_EXPRESSIONS),
      breaching: fc.constantFrom(...BREACHING_EXPRESSIONS),
    })
    .map(({ holds: keep, severity, message, holding, breaching }) => ({
      holds: keep,
      severity,
      message,
      expression: keep ? holding : breaching,
    }));

/** Turns plans into a valid assertion list: distinct names, declaration order. */
function assertionsOf(plans: readonly Plan[]): Assertion[] {
  return plans.map((plan, index) => ({
    name: `g${index + 1}`,
    expression: plan.expression,
    severity: plan.severity,
    ...(plan.message === null ? {} : { message: plan.message }),
  }));
}

/** 1 to 8 assertions, every one of them holding. */
const allHoldingArb: fc.Arbitrary<Plan[]> = fc.array(planArb(true), {
  minLength: 1,
  maxLength: 8,
});

/**
 * 1 to 8 assertions with at least one BREACHED `error` among them, at an
 * arbitrary position — so "even when the first breaches" and "even when the last
 * breaches" are both sampled.
 */
const withErrorBreachArb: fc.Arbitrary<Plan[]> = fc
  .array(planArb(), { minLength: 1, maxLength: 8 })
  .chain((plans) =>
    fc
      .tuple(
        fc.integer({ min: 0, max: plans.length - 1 }),
        fc.constantFrom(...BREACHING_EXPRESSIONS),
      )
      .map(([at, expression]) =>
        plans.map((plan, index) =>
          index === at ? { ...plan, holds: false, severity: 'error' as const, expression } : plan,
        ),
      ),
  );

/**
 * Payloads a guard has to accept: JSON objects, JSON scalars and text that is
 * not JSON at all. Byte-identity is claimed for all of them.
 */
const payloadArb: fc.Arbitrary<string> = fc.oneof(
  fc
    .dictionary(fc.constantFrom('id', 'name', 'rows', 'amount'), fc.jsonValue() as fc.Arbitrary<unknown>, {
      maxKeys: 4,
    })
    .map((value) => JSON.stringify(value)),
  fc.jsonValue().map((value) => JSON.stringify(value)),
  fc.string({ maxLength: 32 }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Claim 48 — pass-through fidelity
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 10 (claim 48): a holding guard passes the payload through untouched', () => {
  it('returns the incoming payload byte-identically and routes Passed only', () => {
    return fc.assert(
      fc.asyncProperty(payloadArb, allHoldingArb, async (payload, plans) => {
        const run = await runGuard({ assertions: assertionsOf(plans), payload });

        // Byte-identical: not re-serialised, not re-ordered, not reformatted.
        expect(run.output).toBe(payload);
        expect(run.failure).toBeUndefined();

        // Exactly one `assert-passed`, counting every assertion, and no breach.
        const passed = eventsOf(run.events, 'assert-passed');
        expect(passed).toHaveLength(1);
        expect(passed[0]).toMatchObject({ nodeId: 'assert-1', checked: plans.length });
        expect(eventsOf(run.events, 'assert-breached')).toEqual([]);

        // The `Passed` chain ran; the `Failed` port had nothing to deliver.
        expect(run.started).toContain('pass-1');
        expect(run.started).toContain('pass-2');
        expect(run.summary?.guards?.every((guard) => guard.passed)).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  it('still passes the payload through when only warn-severity guards breach', () => {
    return fc.assert(
      fc.asyncProperty(
        payloadArb,
        fc.array(planArb(), { minLength: 1, maxLength: 8 }),
        async (payload, raw) => {
          // Every breach demoted to `warn`, so no `error` guard is breached.
          const plans = raw.map((plan) =>
            plan.holds ? plan : { ...plan, severity: 'warn' as const },
          );
          const run = await runGuard({ assertions: assertionsOf(plans), payload });

          expect(run.output).toBe(payload);
          expect(run.failure).toBeUndefined();
          expect(run.started).toContain('pass-1');
          expect(run.started).toContain('pass-2');

          // A warn breach is reported, and changes no routing.
          const breached = eventsOf(run.events, 'assert-breached');
          expect(breached.map((event) => event.assertion)).toEqual(
            assertionsOf(plans)
              .filter((_, index) => !plans[index].holds)
              .map((assertion) => assertion.name),
          );
          expect(breached.every((event) => event.severity === 'warn')).toBe(true);
          expect(breached.every((event) => event.routed === false)).toBe(true);
          expect(eventsOf(run.events, 'assert-passed')).toHaveLength(1);
        },
      ),
      { numRuns: 60 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 49 — guard completeness
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 10 (claim 49): every assertion is evaluated and reported', () => {
  it('reports all of them in declaration order when a breach fails the node', () => {
    return fc.assert(
      fc.asyncProperty(payloadArb, withErrorBreachArb, async (payload, plans) => {
        const assertions = assertionsOf(plans);
        const run = await runGuard({ assertions, onBreach: 'fail', payload });

        // No short-circuit: one audit entry per assertion, in order, with the
        // declared message preserved.
        expect(run.summary?.guards).toEqual(
          plans.map((plan, index) => ({
            name: assertions[index].name,
            passed: plan.holds,
            ...(plan.message === null ? {} : { message: plan.message }),
          })),
        );

        // One breach event per breached assertion, in declaration order.
        const breached = eventsOf(run.events, 'assert-breached');
        expect(breached.map((event) => event.assertion)).toEqual(
          assertions.filter((_, index) => !plans[index].holds).map((assertion) => assertion.name),
        );
        // An undeclared message falls back to the expression source.
        for (const event of breached) {
          const index = Number(event.assertion.slice(1)) - 1;
          expect(event.message).toBe(plans[index].message ?? plans[index].expression);
          expect(event.severity).toBe(plans[index].severity);
        }

        // A breached `error` guard yields no pass event and no output payload.
        expect(eventsOf(run.events, 'assert-passed')).toEqual([]);
        expect(run.output).toBeUndefined();

        // The failure names the EARLIEST-declared breached `error` assertion.
        const first = plans.findIndex((plan) => !plan.holds && plan.severity === 'error');
        expect(run.failure).toContain(`"${assertions[first].name}"`);
        expect(run.failure).toContain(plans[first].message ?? plans[first].expression);
      }),
      { numRuns: 60 },
    );
  });

  it('reports all of them when a breach routes out a wired Failed port', () => {
    return fc.assert(
      fc.asyncProperty(payloadArb, withErrorBreachArb, async (payload, plans) => {
        const assertions = assertionsOf(plans);
        const run = await runGuard({
          assertions,
          onBreach: 'route',
          wireFailed: true,
          payload,
        });

        expect(run.summary?.guards?.map((guard) => guard.name)).toEqual(
          assertions.map((assertion) => assertion.name),
        );
        expect(run.summary?.guards?.map((guard) => guard.passed)).toEqual(
          plans.map((plan) => plan.holds),
        );

        expect(eventsOf(run.events, 'assert-breached').map((event) => event.assertion)).toEqual(
          assertions.filter((_, index) => !plans[index].holds).map((assertion) => assertion.name),
        );
        expect(eventsOf(run.events, 'assert-passed')).toEqual([]);

        // Routed, not failed: the breach report carries the payload unchanged.
        expect(run.failure).toBeUndefined();
        expect(JSON.parse(run.output ?? 'null')).toEqual({
          breaches: plans
            .map((plan, index) => ({ plan, name: assertions[index].name }))
            .filter(({ plan }) => !plan.holds && plan.severity === 'error')
            .map(({ name }) => name),
          input: payload,
        });
      }),
      { numRuns: 60 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 50 — no downstream on breach
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 10 (claim 50): a failing breach stops the write path', () => {
  it('starts no node reachable only through the Passed port', () => {
    return fc.assert(
      fc.asyncProperty(
        payloadArb,
        withErrorBreachArb,
        fc.boolean(),
        async (payload, plans, omitOnBreach) => {
          const run = await runGuard({
            assertions: assertionsOf(plans),
            // `fail` and an absent `onBreach` are the same path (7.4).
            ...(omitOnBreach ? {} : { onBreach: 'fail' as const }),
            payload,
          });

          expect(run.failure).toBeDefined();
          expect(run.started).toEqual(['trigger', 'assert-1']);
          expect(eventsOf(run.events, 'run-completed')).toEqual([]);
          expect(eventsOf(run.events, 'run-failed')).toHaveLength(1);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('stops the write path even when route mode has no wired Failed port', () => {
    return fc.assert(
      fc.asyncProperty(payloadArb, withErrorBreachArb, async (payload, plans) => {
        // `route` without a wired port falls back to failing the node (7.6), so
        // the write path must still be closed.
        const run = await runGuard({
          assertions: assertionsOf(plans),
          onBreach: 'route',
          payload,
        });

        expect(run.failure).toBeDefined();
        expect(run.started).toEqual(['trigger', 'assert-1']);
        expect(run.output).toBeUndefined();
      }),
      { numRuns: 60 },
    );
  });
});
