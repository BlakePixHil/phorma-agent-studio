import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';

import type { RunEvent, RunScope } from '@phorma/engine';

import { RunControllerService } from './run-controller.service';
import { TauriService } from './tauri.service';
import { WorkflowService } from './workflow.service';

/**
 * `RunControllerService.apply()` - the only path from a `RunEvent` to what the
 * user sees.
 *
 * This surface had no tests at all. It is a ~250-line switch over 25+ event
 * types that both the local engine and the cloud WebSocket feed, and it carries
 * three product rules that nothing was checking:
 *
 *  1. Credits, not dollars: the Phorma Cloud share of a cost is accumulated
 *     separately so it can render as plan credits, and only the BYO share is
 *     ever shown in USD. The split is decided by `provider === 'phorma-cloud'`.
 *  2. Sub-workflow child events must not animate the parent canvas - their node
 *     ids belong to another graph - while STILL contributing their usage, since
 *     a nested run spends the same money.
 *  3. A new run clears the previous run's totals rather than accumulating onto
 *     them.
 *
 * `apply()` is synchronous and signal-in/signal-out, so these are fed as event
 * literals and read straight off the exposed signals - no run, no transport.
 */
describe('RunControllerService.apply', () => {
  let runController: RunControllerService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideNoopAnimations(), { provide: TauriService, useValue: { isDesktop: false } }],
    });
    runController = TestBed.inject(RunControllerService);
    TestBed.inject(WorkflowService).newWorkflow();
  });

  const RUN_ID = 'run-apply-spec';

  /** One nested frame, the shape the engine puts on a child event's scope. */
  const CHILD_SCOPE: RunScope[] = [
    {
      nodeId: 'exec-1',
      workflowId: 'wf-child',
      workflowName: 'Child',
      frameId: 'frame-1',
      depth: 1,
    },
  ];

  function apply(...events: RunEvent[]): void {
    for (const event of events) runController.apply(event);
  }

  function started(): RunEvent {
    return { type: 'run-started', runId: RUN_ID, input: '{}', at: 1 };
  }

  /**
   * A usage event carrying a REPORTED cost, so the assertion is about the
   * split and not about the pricing table's estimate for a given model.
   */
  function usage(
    provider: string,
    costUsd: number,
    over: { nodeId?: string; scope?: RunScope[]; inputTokens?: number; outputTokens?: number } = {},
  ): RunEvent {
    return {
      type: 'node-usage',
      runId: RUN_ID,
      nodeId: over.nodeId ?? 'n1',
      provider,
      model: 'anthropic/claude-sonnet-4',
      usage: {
        inputTokens: over.inputTokens ?? 100,
        outputTokens: over.outputTokens ?? 50,
        costUsd,
        costSource: 'reported',
      },
      at: 2,
      ...(over.scope ? { scope: over.scope } : {}),
    } as RunEvent;
  }

  // ── Credits vs dollars ────────────────────────────────────────────────────

  describe('the credits/dollars split', () => {
    it('counts a BYO cost in costUsd only, never in the Phorma Cloud share', () => {
      apply(started(), usage('anthropic', 0.25));

      const totals = runController.runUsage();
      expect(totals.costUsd).toBeCloseTo(0.25, 10);
      expect(totals.phormaCloudCostUsd).toBe(0);
      expect(totals.phormaCloud).toBeFalse();
    });

    it('counts a Phorma Cloud cost in BOTH totals, so credits and the grand total agree', () => {
      apply(started(), usage('phorma-cloud', 0.4));

      const totals = runController.runUsage();
      expect(totals.costUsd).toBeCloseTo(0.4, 10);
      expect(totals.phormaCloudCostUsd).toBeCloseTo(0.4, 10);
      expect(totals.phormaCloud).toBeTrue();
    });

    it('splits a mixed run so the BYO remainder is exactly costUsd minus the cloud share', () => {
      apply(
        started(),
        usage('phorma-cloud', 0.4),
        usage('anthropic', 0.25),
        usage('openai', 0.1),
        usage('phorma-cloud', 0.05),
      );

      const totals = runController.runUsage();
      expect(totals.costUsd).toBeCloseTo(0.8, 10);
      expect(totals.phormaCloudCostUsd).toBeCloseTo(0.45, 10);
      // What the UI renders as USD "(est.)" is this remainder. If the split
      // leaked, a user would be billed credits AND shown the same money again.
      expect(totals.costUsd - totals.phormaCloudCostUsd).toBeCloseTo(0.35, 10);
      expect(totals.phormaCloud).toBeTrue();
    });

    it('accumulates token counts across every provider', () => {
      apply(
        started(),
        usage('anthropic', 0.1, { inputTokens: 100, outputTokens: 10 }),
        usage('phorma-cloud', 0.1, { inputTokens: 200, outputTokens: 20 }),
      );

      const totals = runController.runUsage();
      expect(totals.inputTokens).toBe(300);
      expect(totals.outputTokens).toBe(30);
    });

    it('marks the run estimated when any component cost was estimated, not reported', () => {
      apply(started(), usage('anthropic', 0.25));
      expect(runController.runUsage().estimated).toBeFalse();

      const estimated: RunEvent = {
        type: 'node-usage',
        runId: RUN_ID,
        nodeId: 'n2',
        provider: 'anthropic',
        model: 'anthropic/claude-sonnet-4',
        usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.05, costSource: 'estimated' },
        at: 3,
      } as RunEvent;
      apply(estimated);

      // An estimate anywhere taints the whole total, because the UI carries one
      // "(est.)" suffix for the run, not one per node.
      expect(runController.runUsage().estimated).toBeTrue();
      expect(runController.runUsage().costUsd).toBeCloseTo(0.3, 10);
    });

    it('clears the previous run totals when a new run starts', () => {
      apply(started(), usage('phorma-cloud', 0.4));
      expect(runController.runUsage().costUsd).toBeGreaterThan(0);

      apply(started());

      expect(runController.runUsage()).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        phormaCloudCostUsd: 0,
        estimated: false,
        phormaCloud: false,
      });
    });
  });

  // ── Sub-workflow scope suppression ────────────────────────────────────────

  describe('scoped (sub-workflow) events', () => {
    it('does not animate the parent canvas for a child node', () => {
      apply(started(), {
        type: 'node-started',
        runId: RUN_ID,
        nodeId: 'child-node-1',
        nodeName: 'Child step',
        at: 2,
        scope: CHILD_SCOPE,
      } as RunEvent);

      // The child's node id belongs to another graph: a ring drawn for it would
      // land on whatever parent node happens to share the id, or on nothing.
      expect(runController.nodeStates().has('child-node-1')).toBeFalse();
    });

    it('DOES animate the parent canvas for an unscoped node', () => {
      apply(started(), {
        type: 'node-started',
        runId: RUN_ID,
        nodeId: 'parent-node-1',
        nodeName: 'Parent step',
        at: 2,
      } as RunEvent);

      expect(runController.nodeStates().get('parent-node-1')).toBe('thinking');
    });

    it('still counts a child frame cost - a nested run spends real money', () => {
      apply(started(), usage('phorma-cloud', 0.2, { nodeId: 'child-node-1', scope: CHILD_SCOPE }));

      const totals = runController.runUsage();
      expect(totals.costUsd).toBeCloseTo(0.2, 10);
      expect(totals.phormaCloudCostUsd).toBeCloseTo(0.2, 10);
      // Usage counted, canvas untouched: the two rules hold at the same time.
      expect(runController.nodeStates().has('child-node-1')).toBeFalse();
    });

    it('leaves the parent node state alone when a child node completes or fails', () => {
      apply(
        started(),
        {
          type: 'node-started',
          runId: RUN_ID,
          nodeId: 'shared-id',
          nodeName: 'Parent step',
          at: 2,
        } as RunEvent,
        // A child frame that happens to reuse the parent's node id must not
        // flip the parent's ring to done or error.
        {
          type: 'node-completed',
          runId: RUN_ID,
          nodeId: 'shared-id',
          nodeName: 'Child step',
          output: '{}',
          at: 3,
          scope: CHILD_SCOPE,
        } as RunEvent,
        {
          type: 'node-failed',
          runId: RUN_ID,
          nodeId: 'shared-id',
          nodeName: 'Child step',
          error: 'child blew up',
          at: 4,
          scope: CHILD_SCOPE,
        } as RunEvent,
      );

      expect(runController.nodeStates().get('shared-id')).toBe('thinking');
    });

    it('does not pulse a parent edge for a child handoff', () => {
      apply(started(), {
        type: 'handoff',
        runId: RUN_ID,
        connectionId: 'conn-child-1',
        fromNodeId: 'c1',
        toNodeId: 'c2',
        at: 2,
        scope: CHILD_SCOPE,
      } as RunEvent);

      expect(runController.activeEdges().has('conn-child-1')).toBeFalse();
      expect(runController.nodeStates().has('c2')).toBeFalse();
    });
  });

  // ── Trace ─────────────────────────────────────────────────────────────────

  describe('the trace timeline', () => {
    it('records events but never a token or thinking chunk', () => {
      apply(
        started(),
        { type: 'node-token', runId: RUN_ID, nodeId: 'n1', token: 'hello' } as RunEvent,
        { type: 'node-thinking', runId: RUN_ID, nodeId: 'n1', token: 'pondering' } as RunEvent,
      );

      const trace = runController.trace();
      expect(trace.length).toBeGreaterThan(0);
      const text = JSON.stringify(trace);
      expect(text).not.toContain('hello');
      expect(text).not.toContain('pondering');
    });

    it('counts streamed characters even though they never reach the trace', () => {
      apply(
        started(),
        { type: 'node-token', runId: RUN_ID, nodeId: 'n1', token: 'abcde' } as RunEvent,
        { type: 'node-token', runId: RUN_ID, nodeId: 'n1', token: 'fg' } as RunEvent,
      );

      expect(runController.streamedChars()).toBe(7);
    });
  });
});
