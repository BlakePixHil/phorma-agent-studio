/**
 * Property test for the AWS_Host runner resume mechanism.
 *
 * Property 8: Resume replays completed work without repeating a side effect.
 * Validates: Requirements 3.6, 3.9, 3.11
 *
 * The test creates a linear workflow graph of N agent nodes, simulates a first
 * partial run that journals entries for the first K nodes (an arbitrary
 * replacement point), seeds those entries into a FakeRunTable, then starts a
 * resumed run that preloads the journal from the table. The property asserts
 * that the resumed run invokes the model only for nodes NOT already in the
 * journal - completed work is replayed without repeating a side effect.
 *
 * Feature: aws-deployment-target
 * Requirements: 3.6, 3.9, 3.11
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type {
  JournalEntry,
  ModelClient,
  RunEvent,
  WorkflowGraph,
  WorkflowNode,
  WorkflowConnection,
} from '@phorma/engine';
import { startRun } from '@phorma/engine';
import { FakeRunTable } from '../test/fake-run-table.js';

// ---------------------------------------------------------------------------
// Graph builder helpers
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
 * Each agent node uses a unique prompt so we can identify which node made the
 * model call from the request content.
 */
function buildLinearAgentGraph(nodeCount: number): WorkflowGraph {
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

  return {
    nodes: [trigger, ...agentNodes],
    connections: edges,
  };
}

/**
 * Create a JournalStore-like preload from a FakeRunTable.
 * Reads all items under the journal# sk prefix and returns them as a Map.
 */
function preloadFromTable(table: FakeRunTable, pkVal: string): Map<string, JournalEntry> {
  const result = table.query({ pk: pkVal, skPrefix: 'journal#', pageSize: 5000 });
  const map = new Map<string, JournalEntry>();
  for (const item of result.items) {
    const key = item['journalKey'] as string;
    if (key) {
      map.set(key, {
        output: (item['output'] as string) ?? '',
        viaPortIds: item['viaPortIds'] as string[] | undefined,
      });
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Property 8: Resume replays completed work without repeating a side effect
// ---------------------------------------------------------------------------

describe('runner - Property 8: Resume replays completed work without repeating a side effect', () => {
  /**
   * **Validates: Requirements 3.6, 3.9, 3.11**
   *
   * A linear graph of N agent nodes is executed in two phases:
   *
   * Phase 1 (first attempt): Run via startRun with a recording journal.
   * Interrupt after the first K agent nodes complete (arbitrary replacement
   * point). The journal holds entries for the trigger plus those K nodes.
   *
   * Phase 2 (resume): Seed a FakeRunTable with the journal entries from
   * phase 1, preload them, then start a new run with that preloaded journal.
   * The engine replays the trigger and K completed agent nodes without
   * calling the model, then executes only the remaining (N-K) agent nodes
   * with fresh model calls.
   *
   * The property: model calls during the resumed run equal exactly (N - K).
   * No previously-completed side effect is repeated.
   */
  it('model calls during resume equal exactly the count of un-journaled agent nodes', async () => {
    await fc.assert(
      fc.asyncProperty(
        // nodeCount: 2 to 6 agent nodes in the linear chain
        fc.integer({ min: 2, max: 6 }),
        // replacementPoint: will be clamped to [1, nodeCount-1]
        fc.integer({ min: 1, max: 6 }),
        async (nodeCount, rawPoint) => {
          const replacementPoint = Math.max(1, Math.min(rawPoint, nodeCount - 1));
          const graph = buildLinearAgentGraph(nodeCount);
          const runId = 'resume-test';
          const input = 'test-input';

          // ── Phase 1: Partial run to build the journal ───────────────────
          const journalMap = new Map<string, JournalEntry>();
          const journal = {
            lookup: (key: string) => journalMap.get(key),
            record: (key: string, entry: JournalEntry) => { journalMap.set(key, entry); },
          };

          // Track model calls per agent node in phase 1
          let agentCallCount = 0;
          let interrupted!: () => void;
          const interruptedSignal = new Promise<void>(resolve => (interrupted = resolve));

          const phase1Model: ModelClient = {
            stream: async function* () {
              agentCallCount += 1;
              if (agentCallCount > replacementPoint) {
                // Simulate interruption: signal and never complete
                interrupted();
                await new Promise<never>(() => {});
                return;
              }
              // Complete normally with a deterministic output
              yield { type: 'text', text: `phase1-output-${agentCallCount}` };
            },
          } as ModelClient;

          startRun({
            runId,
            graph: structuredClone(graph),
            input,
            model: phase1Model,
            emit: () => {},
            requestApproval: async () => true,
            requestInput: async () => '',
            waitForEvent: async () => '',
            journal,
          });

          await interruptedSignal;

          // The journal now has entries for the trigger + first K agent nodes.
          // trigger's output = input (passthrough), each agent's output =
          // 'phase1-output-N'. The (K+1)th agent started but never completed
          // (no journal entry), so the journal has exactly K+1 entries.
          expect(journalMap.size).toBe(replacementPoint + 1); // trigger + K agents

          // ── Seed FakeRunTable with the partial journal ──────────────────
          const table = new FakeRunTable();
          const pkVal = `wf#test-workflow`;

          for (const [key, entry] of journalMap) {
            table.seed(
              { pk: pkVal, sk: `journal#${key}` },
              { journalKey: key, output: entry.output, viaPortIds: entry.viaPortIds },
            );
          }

          // Verify seeded items are retrievable
          const preloaded = preloadFromTable(table, pkVal);
          expect(preloaded.size).toBe(journalMap.size);

          // ── Phase 2: Resume with the preloaded journal ──────────────────
          const resumeModelCalls: string[] = [];
          const resumeJournal = {
            lookup: (key: string) => preloaded.get(key),
            record: (key: string, entry: JournalEntry) => {
              // Record new entries (for the remaining agent nodes)
              preloaded.set(key, entry);
              // Also persist to the table (simulates durable write)
              table.putItem({
                key: { pk: pkVal, sk: `journal#${key}` },
                item: { journalKey: key, output: entry.output, viaPortIds: entry.viaPortIds },
              });
            },
          };

          const resumeModel: ModelClient = {
            stream: async function* () {
              resumeModelCalls.push(`call-${resumeModelCalls.length}`);
              yield { type: 'text', text: `resume-output-${resumeModelCalls.length}` };
            },
          } as ModelClient;

          const resumeEvents: RunEvent[] = [];
          const handle = startRun({
            runId,
            graph: structuredClone(graph),
            input,
            model: resumeModel,
            emit: (event: RunEvent) => { resumeEvents.push(event); },
            requestApproval: async () => true,
            requestInput: async () => '',
            waitForEvent: async () => '',
            journal: resumeJournal,
          });

          await handle.done;

          // Run should complete
          const completed = resumeEvents.some(e => e.type === 'run-completed');
          expect(completed).toBe(true);

          // ── Property assertion ──────────────────────────────────────────
          // Model calls during resume = exactly (nodeCount - replacementPoint)
          // Only the un-journaled agent nodes needed the model.
          expect(resumeModelCalls.length).toBe(nodeCount - replacementPoint);

          // Verify no preloaded journal key was written again (no duplicate
          // side effect storage)
          const originalKeys = new Set(journalMap.keys());
          const finalResult = table.query({ pk: pkVal, skPrefix: 'journal#', pageSize: 5000 });
          // Total journal entries = original + new (one per remaining agent)
          expect(finalResult.items.length).toBe(
            replacementPoint + 1 + (nodeCount - replacementPoint),
          );

          // Every original entry is still present with its original output
          for (const [key, entry] of journalMap) {
            const item = finalResult.items.find(i => (i['journalKey'] as string) === key);
            expect(item).toBeDefined();
            expect(item!['output']).toBe(entry.output);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
