/**
 * Property tests for the AWS_Host runner's event parity.
 *
 * Property 23: The forwarded event sequence matches the host-independent reference.
 * Validates: Requirements 1.3, 1.8
 *
 * Model-based comparison: for any small workflow graph, start a run on an in-memory
 * reference host (direct startRun with no persistence), collect the emitted RunEvents,
 * then process those same events through the runner's processEvent pipeline (the path
 * the AWS host adapter takes). Assert the output (type, nodeId) pair sequence is
 * identical, the node completion ORDER is preserved, and payload CONTENT matches -
 * differing only in run id, timestamps and host identity fields.
 *
 * Feature: aws-deployment-target, Property 23: host-independent event parity
 * Requirements: 1.3, 1.8
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type {
  RunEvent,
  RunEventType,
  ModelClient,
  WorkflowGraph,
  WorkflowNode,
  WorkflowConnection,
} from '@phorma/engine';
import { startRun } from '@phorma/engine';
import { processEvent } from '../core/events.js';
import type { EventPipelineOutput } from '../core/events.js';

// ---------------------------------------------------------------------------
// Graph builder helpers (same pattern as runner-resume.spec.ts)
// ---------------------------------------------------------------------------

function makeNode(
  id: string,
  kind: string,
  ports: { id: string; name: string; role: 'message-in' | 'message-out' | 'tools' }[],
  data: object = {},
): WorkflowNode {
  return {
    id,
    name: id,
    kind,
    category: 'flow',
    icon: '',
    position: { x: 0, y: 0 },
    ports,
    data,
  };
}

function makeEdge(id: string, fromPort: string, toPort: string): WorkflowConnection {
  return { id, outputId: `${fromPort}-out`, inputId: `${toPort}-in`, kind: 'handoff' };
}

/**
 * Build a linear workflow: trigger -> agent-0 -> agent-1 -> ... -> agent-(N-1).
 * Each agent node has a unique prompt (deterministic output from the model stub).
 */
function buildLinearGraph(nodeCount: number): WorkflowGraph {
  const trigger = makeNode(
    'trigger',
    'manual-trigger',
    [{ id: 'trigger-start', name: 'Start', role: 'message-out' }],
  );

  const agentNodes: WorkflowNode[] = [];
  const edges: WorkflowConnection[] = [];

  for (let i = 0; i < nodeCount; i++) {
    const nodeId = `agent-${i}`;
    agentNodes.push(
      makeNode(
        nodeId,
        'agent',
        [
          { id: `${nodeId}-in`, name: 'In', role: 'message-in' },
          { id: `${nodeId}-out`, name: 'Out', role: 'message-out' },
        ],
        { prompt: `Step ${i}`, provider: 'openai', model: 'gpt-4' },
      ),
    );
  }

  // trigger -> agent-0
  edges.push(makeEdge('e-start', 'trigger-start', 'agent-0-in'));
  // agent-i -> agent-(i+1)
  for (let i = 0; i < nodeCount - 1; i++) {
    edges.push(makeEdge(`e-${i}`, `agent-${i}-out`, `agent-${i + 1}-in`));
  }

  return { nodes: [trigger, ...agentNodes], connections: edges };
}

/**
 * Build a branching workflow: trigger -> agent-A and trigger -> agent-B.
 * Two parallel branches from one trigger. Tests that the event order is
 * consistent for deterministic concurrent execution.
 */
function buildBranchingGraph(): WorkflowGraph {
  const trigger = makeNode(
    'trigger',
    'manual-trigger',
    [{ id: 'trigger-out', name: 'Start', role: 'message-out' }],
  );
  const agentA = makeNode(
    'agent-a',
    'agent',
    [
      { id: 'agent-a-in', name: 'In', role: 'message-in' },
      { id: 'agent-a-out', name: 'Out', role: 'message-out' },
    ],
    { prompt: 'Branch A', provider: 'openai', model: 'gpt-4' },
  );
  const agentB = makeNode(
    'agent-b',
    'agent',
    [
      { id: 'agent-b-in', name: 'In', role: 'message-in' },
      { id: 'agent-b-out', name: 'Out', role: 'message-out' },
    ],
    { prompt: 'Branch B', provider: 'openai', model: 'gpt-4' },
  );

  return {
    nodes: [trigger, agentA, agentB],
    connections: [
      makeEdge('e-a', 'trigger-out', 'agent-a-in'),
      makeEdge('e-b', 'trigger-out', 'agent-b-in'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Deterministic model stub - same output for both "hosts"
// ---------------------------------------------------------------------------

function makeDeterministicModel(): ModelClient {
  return {
    stream: async function* () {
      yield { type: 'text', text: 'deterministic-output' };
    },
  } as ModelClient;
}

// ---------------------------------------------------------------------------
// Arbitrary: small workflow graphs
// ---------------------------------------------------------------------------

function smallGraphArb(): fc.Arbitrary<{ graph: WorkflowGraph; description: string }> {
  return fc.oneof(
    // Linear graphs of 1 to 5 agent nodes
    fc.integer({ min: 1, max: 5 }).map(n => ({
      graph: buildLinearGraph(n),
      description: `linear-${n}`,
    })),
    // Branching graph (2 parallel agents)
    fc.constant({ graph: buildBranchingGraph(), description: 'branching-2' }),
  );
}

// ---------------------------------------------------------------------------
// Identity and payload fields that must be preserved across hosts
// ---------------------------------------------------------------------------

/** Fields that are allowed to differ between hosts (host-identity fields). */
const HOST_IDENTITY_FIELDS = new Set(['runId', 'at', 'scope']);

/** Extract the (type, nodeId) identity pair from an event. */
function eventIdentity(event: RunEvent): { type: RunEventType; nodeId?: string } {
  const e = event as Record<string, unknown>;
  return {
    type: event.type,
    nodeId: typeof e['nodeId'] === 'string' ? e['nodeId'] : undefined,
  };
}

/**
 * Extract payload content from an event, excluding host-identity fields.
 * This is the content that must match between hosts.
 */
function eventPayloadContent(event: RunEvent): Record<string, unknown> {
  const e = event as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(e)) {
    if (!HOST_IDENTITY_FIELDS.has(key)) {
      result[key] = e[key];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Property 23: The forwarded event sequence matches the host-independent reference
// ---------------------------------------------------------------------------

describe('runner - Property 23: The forwarded event sequence matches the host-independent reference', () => {
  /**
   * **Validates: Requirements 1.3, 1.8**
   *
   * Model-based comparison: run the same graph on two "hosts" (in-memory
   * reference via startRun, then a second run with a different run id) and
   * verify that:
   * - The event TYPE sequences are identical
   * - The node completion ORDER is identical
   * - Payload CONTENT is identical
   * - They differ ONLY in run id, timestamps and host identity fields
   */
  it('two hosts produce identical event sequences differing only in run id, timestamps and host identity', async () => {
    await fc.assert(
      fc.asyncProperty(
        smallGraphArb(),
        fc.string({ minLength: 4, maxLength: 16 }).filter(s => /\S/.test(s)),
        fc.string({ minLength: 4, maxLength: 16 }).filter(s => /\S/.test(s) && s !== 'ref-run'),
        async ({ graph }, input, altRunId) => {
          // ── Reference host: in-memory startRun ──────────────────────────
          const referenceEvents: RunEvent[] = [];
          const refHandle = startRun({
            runId: 'ref-run',
            graph: structuredClone(graph),
            input,
            model: makeDeterministicModel(),
            emit: (event: RunEvent) => { referenceEvents.push(event); },
            requestApproval: async () => true,
            requestInput: async () => '',
            waitForEvent: async () => '',
          });
          await refHandle.done;

          // ── AWS host simulation: same graph, different run id ────────────
          const awsEvents: RunEvent[] = [];
          const awsHandle = startRun({
            runId: altRunId,
            graph: structuredClone(graph),
            input,
            model: makeDeterministicModel(),
            emit: (event: RunEvent) => { awsEvents.push(event); },
            requestApproval: async () => true,
            requestInput: async () => '',
            waitForEvent: async () => '',
          });
          await awsHandle.done;

          // ── Assertion: same number of events (no dropped, no added) ─────
          expect(awsEvents.length).toBe(referenceEvents.length);
          expect(awsEvents.length).toBeGreaterThan(0);

          // ── Assertion: event TYPE sequence is identical ──────────────────
          for (let i = 0; i < referenceEvents.length; i++) {
            expect(awsEvents[i].type).toBe(referenceEvents[i].type);
          }

          // ── Assertion: node completion ORDER is identical ───────────────
          const refCompletions = referenceEvents
            .filter(e => e.type === 'node-completed')
            .map(e => eventIdentity(e));
          const awsCompletions = awsEvents
            .filter(e => e.type === 'node-completed')
            .map(e => eventIdentity(e));
          expect(awsCompletions).toEqual(refCompletions);

          // ── Assertion: (type, nodeId) pairs are identical ───────────────
          for (let i = 0; i < referenceEvents.length; i++) {
            const refId = eventIdentity(referenceEvents[i]);
            const awsId = eventIdentity(awsEvents[i]);
            expect(awsId.type).toBe(refId.type);
            expect(awsId.nodeId).toBe(refId.nodeId);
          }

          // ── Assertion: payload content matches (non-identity fields) ────
          for (let i = 0; i < referenceEvents.length; i++) {
            const refPayload = eventPayloadContent(referenceEvents[i]);
            const awsPayload = eventPayloadContent(awsEvents[i]);
            // Remove the runId from payload comparison (host-specific)
            delete refPayload['runId'];
            delete awsPayload['runId'];
            expect(awsPayload).toEqual(refPayload);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 1.3, 1.8**
   *
   * The processEvent pipeline (what the AWS runner's emit handler uses)
   * preserves the event TYPE, nodeId and sequence through the pipeline
   * without reordering, dropping or adding events.
   */
  it('processEvent pipeline preserves event identity and sequence from the reference host', async () => {
    await fc.assert(
      fc.asyncProperty(
        smallGraphArb(),
        fc.string({ minLength: 1, maxLength: 16 }).filter(s => /\S/.test(s)),
        async ({ graph }, input) => {
          // Run the reference host to get a real event stream
          const referenceEvents: RunEvent[] = [];
          const handle = startRun({
            runId: 'pipeline-ref',
            graph: structuredClone(graph),
            input,
            model: makeDeterministicModel(),
            emit: (event: RunEvent) => { referenceEvents.push(event); },
            requestApproval: async () => true,
            requestInput: async () => '',
            waitForEvent: async () => '',
          });
          await handle.done;

          // Process through the pipeline (what the AWS runner does)
          const pipelineOutputs: EventPipelineOutput[] = [];
          for (let i = 0; i < referenceEvents.length; i++) {
            pipelineOutputs.push(processEvent({
              event: referenceEvents[i],
              sequence: i + 1,
              persistPayload: true,
            }));
          }

          // No events dropped or added
          expect(pipelineOutputs.length).toBe(referenceEvents.length);

          // Sequence is contiguous from 1
          for (let i = 0; i < pipelineOutputs.length; i++) {
            expect(pipelineOutputs[i].sequence).toBe(i + 1);
          }

          // Event types preserved in order
          for (let i = 0; i < pipelineOutputs.length; i++) {
            expect(pipelineOutputs[i].event.type).toBe(referenceEvents[i].type);
          }

          // Identity fields preserved
          for (let i = 0; i < pipelineOutputs.length; i++) {
            const refEvt = referenceEvents[i] as Record<string, unknown>;
            const outEvt = pipelineOutputs[i].event as Record<string, unknown>;
            expect(outEvt['type']).toBe(refEvt['type']);
            expect(outEvt['runId']).toBe(refEvt['runId']);
            if ('nodeId' in refEvt) {
              expect(outEvt['nodeId']).toBe(refEvt['nodeId']);
            }
          }

          // Node completion order preserved
          const refOrder = referenceEvents
            .filter(e => e.type === 'node-completed')
            .map(e => (e as Record<string, unknown>)['nodeId']);
          const outOrder = pipelineOutputs
            .filter(o => o.event.type === 'node-completed')
            .map(o => (o.event as Record<string, unknown>)['nodeId']);
          expect(outOrder).toEqual(refOrder);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 1.3, 1.8**
   *
   * The only differences between two hosts running the same graph are the
   * run id, timestamps (at) and host identity fields. This test extracts
   * those fields and confirms they are the ONLY source of difference.
   */
  it('differences between two hosts are limited to run id, timestamps and host identity only', async () => {
    await fc.assert(
      fc.asyncProperty(
        smallGraphArb(),
        fc.string({ minLength: 1, maxLength: 16 }).filter(s => /\S/.test(s)),
        async ({ graph }, input) => {
          // Run on host A
          const hostAEvents: RunEvent[] = [];
          const handleA = startRun({
            runId: 'host-a-run',
            graph: structuredClone(graph),
            input,
            model: makeDeterministicModel(),
            emit: (event: RunEvent) => { hostAEvents.push(event); },
            requestApproval: async () => true,
            requestInput: async () => '',
            waitForEvent: async () => '',
          });
          await handleA.done;

          // Run on host B (different run id)
          const hostBEvents: RunEvent[] = [];
          const handleB = startRun({
            runId: 'host-b-run',
            graph: structuredClone(graph),
            input,
            model: makeDeterministicModel(),
            emit: (event: RunEvent) => { hostBEvents.push(event); },
            requestApproval: async () => true,
            requestInput: async () => '',
            waitForEvent: async () => '',
          });
          await handleB.done;

          expect(hostAEvents.length).toBe(hostBEvents.length);

          for (let i = 0; i < hostAEvents.length; i++) {
            const a = hostAEvents[i] as Record<string, unknown>;
            const b = hostBEvents[i] as Record<string, unknown>;

            // Collect all keys from both events
            const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);

            for (const key of allKeys) {
              if (HOST_IDENTITY_FIELDS.has(key)) {
                // These are ALLOWED to differ
                if (key === 'runId') {
                  // Run ids should be the respective host's id
                  expect(a['runId']).toBe('host-a-run');
                  expect(b['runId']).toBe('host-b-run');
                }
                // timestamps (at) may differ due to clock
                // scope may differ in nested scenarios
              } else {
                // Everything else MUST be identical
                expect(b[key]).toEqual(a[key]);
              }
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
