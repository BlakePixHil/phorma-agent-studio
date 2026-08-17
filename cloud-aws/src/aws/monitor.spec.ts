/**
 * Monitor tests: unit tests and property tests for the MonitorAdapter.
 *
 * Feature: aws-deployment-target
 * Requirements: 7.2, 7.12, 7.13, 7.14, 7.16
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fc from 'fast-check';

import type { RunEvent } from '@phorma/engine';

import { FakeMonitorBackend } from '../test/fake-monitor.js';
import { MonitorAdapter } from './monitor.js';

describe('MonitorAdapter', () => {
  let backend: FakeMonitorBackend;
  let monitor: MonitorAdapter;

  const makeEvent = (type = 'node-started', seq = 1): RunEvent =>
    ({ type, nodeId: 'n1', timestamp: new Date().toISOString(), seq } as unknown as RunEvent);

  beforeEach(() => {
    backend = new FakeMonitorBackend();
    monitor = new MonitorAdapter(backend);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Req 7.14, 7.16: Continue with zero connections
  // ─────────────────────────────────────────────────────────────────────────

  it('resolves successfully when zero connections are open', async () => {
    const event = makeEvent();
    await expect(monitor.push('wf1', event)).resolves.toBeUndefined();
    expect(backend.posted).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Req 7.2: Fan out to every connection of the target workflow
  // ─────────────────────────────────────────────────────────────────────────

  it('pushes to every connection of the target workflow', async () => {
    backend.addConnection('wf1', 'conn-a');
    backend.addConnection('wf1', 'conn-b');
    backend.addConnection('wf1', 'conn-c');

    const event = makeEvent();
    await monitor.push('wf1', event);

    expect(backend.posted).toHaveLength(3);
    const postedIds = backend.posted.map((p) => p.connectionId).sort();
    expect(postedIds).toEqual(['conn-a', 'conn-b', 'conn-c']);
  });

  it('does not push to connections of another workflow', async () => {
    backend.addConnection('wf1', 'conn-a');
    backend.addConnection('wf2', 'conn-b');

    const event = makeEvent();
    await monitor.push('wf1', event);

    expect(backend.posted).toHaveLength(1);
    expect(backend.posted[0].connectionId).toBe('conn-a');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Req 7.13: Discard stale connection on GoneException
  // ─────────────────────────────────────────────────────────────────────────

  it('discards a connection on GoneException and continues', async () => {
    backend.addConnection('wf1', 'conn-live');
    backend.addConnection('wf1', 'conn-stale');
    backend.markGone('conn-stale');

    const event = makeEvent();
    await monitor.push('wf1', event);

    // Live connection received the event
    expect(backend.posted.some((p) => p.connectionId === 'conn-live')).toBe(true);
    // Stale connection was removed
    expect(backend.removed).toContain('conn-stale');
    // Stale connection no longer in the connection list
    expect(backend.getConnections('wf1')).not.toContain('conn-stale');
  });

  it('continues the run when all connections are gone', async () => {
    backend.addConnection('wf1', 'conn-a');
    backend.addConnection('wf1', 'conn-b');
    backend.markGone('conn-a');
    backend.markGone('conn-b');

    const event = makeEvent();
    await expect(monitor.push('wf1', event)).resolves.toBeUndefined();

    expect(backend.removed).toContain('conn-a');
    expect(backend.removed).toContain('conn-b');
    expect(backend.posted).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Req 7.2: Correct serialization
  // ─────────────────────────────────────────────────────────────────────────

  it('serializes the event as JSON', async () => {
    backend.addConnection('wf1', 'conn-a');
    const event = makeEvent('node-completed', 5);

    await monitor.push('wf1', event);

    expect(backend.posted).toHaveLength(1);
    const parsed = JSON.parse(backend.posted[0].data);
    expect(parsed.type).toBe('node-completed');
    expect(parsed.seq).toBe(5);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Req 7.16: Multiple connections all receive the same event
  // ─────────────────────────────────────────────────────────────────────────

  it('delivers the same event to multiple connections', async () => {
    backend.addConnection('wf1', 'conn-1');
    backend.addConnection('wf1', 'conn-2');
    backend.addConnection('wf1', 'conn-3');

    const event = makeEvent('run-started', 1);
    await monitor.push('wf1', event);

    // All get the same serialized payload
    const payloads = new Set(backend.posted.map((p) => p.data));
    expect(payloads.size).toBe(1);
    expect(backend.posted).toHaveLength(3);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Mixed scenario: some gone, some live, different workflows
  // ─────────────────────────────────────────────────────────────────────────

  it('handles a mix of live, gone and other-workflow connections', async () => {
    backend.addConnection('wf1', 'live-1');
    backend.addConnection('wf1', 'live-2');
    backend.addConnection('wf1', 'gone-1');
    backend.addConnection('wf2', 'other-wf');
    backend.markGone('gone-1');

    const event = makeEvent();
    await monitor.push('wf1', event);

    // Live connections received the event
    const receivedIds = backend.posted.map((p) => p.connectionId).sort();
    expect(receivedIds).toEqual(['live-1', 'live-2']);

    // Gone was removed
    expect(backend.removed).toContain('gone-1');

    // Other workflow was untouched
    expect(backend.posted.every((p) => p.connectionId !== 'other-wf')).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// Property 22: Monitor delivery reaches every connection of that workflow
// exactly once and no other
// Validates: Requirements 7.2, 7.13, 7.14, 7.16
// Feature: aws-deployment-target
// ---------------------------------------------------------------------------

describe('monitor - Property 22: Monitor delivery reaches every connection of that workflow exactly once and no other', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Generators
  // ─────────────────────────────────────────────────────────────────────────

  /** Generate a workflow id: 'wf-' followed by 1-8 alphanumeric characters. */
  const arbWorkflowId = fc
    .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
      minLength: 1,
      maxLength: 8,
    })
    .map((chars) => `wf-${chars.join('')}`);

  /** Generate a unique set of 1 to 5 distinct workflow ids. */
  const arbWorkflowIds = fc.uniqueArray(arbWorkflowId, { minLength: 1, maxLength: 5 });

  /** Generate a connection count per workflow (0-20). */
  const arbConnectionCount = fc.integer({ min: 0, max: 20 });

  /** Generate a subset of indices to mark as gone. */
  function arbGoneIndices(total: number): fc.Arbitrary<Set<number>> {
    if (total === 0) return fc.constant(new Set<number>());
    return fc.uniqueArray(fc.integer({ min: 0, max: total - 1 }), { minLength: 0, maxLength: total }).map(
      (arr) => new Set(arr),
    );
  }

  /**
   * **Validates: Requirements 7.2, 7.13, 7.14, 7.16**
   *
   * For any number of connections (0 to N) for the target workflow, and any
   * number of connections for OTHER workflows, only the target workflow's
   * connections receive the event. Each connection of the target workflow
   * receives the event exactly once. The number of successfully posted events
   * equals the number of live (non-gone) connections. Gone connections are
   * discarded without affecting other deliveries. Zero connections still
   * resolves successfully.
   */
  it('delivers to every live connection of the target workflow exactly once and to no other', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbWorkflowIds,
        fc.array(arbConnectionCount, { minLength: 1, maxLength: 5 }),
        fc.nat({ max: 99 }),
        async (workflowIds, connectionCounts, gonePercent) => {
          // Ensure we have enough connection counts for all workflow ids
          const counts = workflowIds.map((_, i) => connectionCounts[i % connectionCounts.length]);

          const backend = new FakeMonitorBackend();
          const monitor = new MonitorAdapter(backend);

          // Build connection topology: for each workflow, create N connections
          const topology = new Map<string, { all: string[]; gone: Set<number> }>();

          for (let wi = 0; wi < workflowIds.length; wi++) {
            const wfId = workflowIds[wi];
            const count = counts[wi];
            const connections: string[] = [];

            for (let ci = 0; ci < count; ci++) {
              const connId = `conn-${wi}-${ci}`;
              backend.addConnection(wfId, connId);
              connections.push(connId);
            }

            // Determine which connections are gone based on gonePercent
            const goneCount = Math.floor(count * (gonePercent / 100));
            const goneSet = new Set<number>();
            for (let g = 0; g < goneCount; g++) {
              goneSet.add(g);
              backend.markGone(connections[g]);
            }

            topology.set(wfId, { all: connections, gone: goneSet });
          }

          // Pick the first workflow as the target
          const targetWfId = workflowIds[0];
          const targetInfo = topology.get(targetWfId)!;
          const liveConnections = targetInfo.all.filter((_, i) => !targetInfo.gone.has(i));
          const goneConnections = targetInfo.all.filter((_, i) => targetInfo.gone.has(i));

          // Push an event to the target workflow
          const event = {
            type: 'node-started',
            nodeId: 'n1',
            timestamp: new Date().toISOString(),
            seq: 1,
          } as unknown as RunEvent;

          // Should always resolve (Req 7.14, 7.16)
          await expect(monitor.push(targetWfId, event)).resolves.toBeUndefined();

          // 1. Only target workflow connections receive the event (Req 7.2)
          const postedConnectionIds = backend.posted.map((p) => p.connectionId);
          const otherWfConnections = new Set<string>();
          for (let wi = 1; wi < workflowIds.length; wi++) {
            const info = topology.get(workflowIds[wi])!;
            for (const conn of info.all) {
              otherWfConnections.add(conn);
            }
          }
          for (const connId of postedConnectionIds) {
            expect(otherWfConnections.has(connId)).toBe(false);
          }

          // 2. Each live connection of the target receives the event exactly once (Req 7.2)
          const postedToTarget = postedConnectionIds.filter((id) => liveConnections.includes(id));
          expect(postedToTarget.sort()).toEqual([...liveConnections].sort());

          // 3. Number of successfully posted events equals live connections count (Req 7.16)
          expect(backend.posted.length).toBe(liveConnections.length);

          // 4. Gone connections are discarded (Req 7.13)
          for (const goneConn of goneConnections) {
            expect(backend.removed).toContain(goneConn);
            expect(backend.posted.some((p) => p.connectionId === goneConn)).toBe(false);
          }

          // 5. Zero connections case: if target has zero connections, still resolves
          // (implicitly tested when counts[0] === 0; verified by the resolves assertion above)
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.14, 7.16**
   *
   * Specifically test that zero connections always resolves successfully,
   * regardless of connections on other workflows.
   */
  it('resolves successfully with zero target connections even when other workflows have many', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbWorkflowId,
        fc.array(
          fc.tuple(arbWorkflowId, fc.integer({ min: 1, max: 20 })),
          { minLength: 1, maxLength: 5 },
        ),
        async (targetWfId, otherWorkflows) => {
          const backend = new FakeMonitorBackend();
          const monitor = new MonitorAdapter(backend);

          // Add connections only to other workflows (not the target)
          for (const [wfId, count] of otherWorkflows) {
            if (wfId === targetWfId) continue;
            for (let i = 0; i < count; i++) {
              backend.addConnection(wfId, `other-${wfId}-${i}`);
            }
          }

          const event = {
            type: 'run-started',
            nodeId: 'root',
            timestamp: new Date().toISOString(),
            seq: 1,
          } as unknown as RunEvent;

          // Zero target connections - resolves without error (Req 7.14, 7.16)
          await expect(monitor.push(targetWfId, event)).resolves.toBeUndefined();

          // No events posted at all
          expect(backend.posted.length).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.2, 7.13**
   *
   * The persisted run event count is invariant in the number of open
   * connections - gone connections do not affect the delivery to live ones.
   */
  it('persisted event count is invariant: gone connections do not affect live delivery', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbWorkflowId,
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 100 }),
        async (wfId, totalConnections, gonePercent) => {
          const backend = new FakeMonitorBackend();
          const monitor = new MonitorAdapter(backend);

          const connections: string[] = [];
          for (let i = 0; i < totalConnections; i++) {
            const connId = `conn-inv-${i}`;
            backend.addConnection(wfId, connId);
            connections.push(connId);
          }

          // Mark a subset as gone based on percent
          const goneCount = Math.floor(totalConnections * (gonePercent / 100));
          const goneSet = new Set<string>();
          for (let g = 0; g < goneCount; g++) {
            backend.markGone(connections[g]);
            goneSet.add(connections[g]);
          }

          const expectedLiveCount = totalConnections - goneCount;

          const event = {
            type: 'node-completed',
            nodeId: 'n2',
            timestamp: new Date().toISOString(),
            seq: 3,
          } as unknown as RunEvent;

          await monitor.push(wfId, event);

          // The number of successfully posted events equals live connections (Req 7.2)
          expect(backend.posted.length).toBe(expectedLiveCount);

          // All gone connections were removed (Req 7.13)
          for (const gone of goneSet) {
            expect(backend.removed).toContain(gone);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Feature: aws-byo-deploy, Property 12: Monitor fan-out and stale pruning
// Validates: Requirements 8.7
// ---------------------------------------------------------------------------

describe('monitor - Property 12: Monitor fan-out and stale pruning', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Generators
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Connection ids for one workflow: a unique set drawn from a small index
   * space so collisions between the target and the decoy are impossible, and
   * the empty set is reachable on its own weighted branch rather than only by
   * luck.
   */
  function arbConnectionIds(prefix: string): fc.Arbitrary<string[]> {
    return fc.oneof(
      { weight: 1, arbitrary: fc.constant<string[]>([]) },
      {
        weight: 6,
        arbitrary: fc
          .uniqueArray(fc.integer({ min: 0, max: 40 }), { minLength: 1, maxLength: 12 })
          .map((indices) => indices.map((i) => `${prefix}-conn-${i}`)),
      },
    );
  }

  /**
   * A genuine subset of a connection set, expressed as a same-length mask.
   * The two degenerate subsets - nothing stale and everything stale - get
   * their own branches so both edges are exercised on every run of the suite.
   */
  function arbStaleMask(size: number): fc.Arbitrary<boolean[]> {
    if (size === 0) return fc.constant<boolean[]>([]);
    return fc.oneof(
      { weight: 1, arbitrary: fc.constant<boolean[]>(new Array(size).fill(false)) },
      { weight: 1, arbitrary: fc.constant<boolean[]>(new Array(size).fill(true)) },
      { weight: 4, arbitrary: fc.array(fc.boolean(), { minLength: size, maxLength: size }) },
    );
  }

  /** One RunEvent to fan out. */
  const arbEvent: fc.Arbitrary<RunEvent> = fc
    .record({
      type: fc.constantFrom('run-started', 'node-started', 'node-completed', 'run-completed'),
      nodeId: fc.string({ minLength: 1, maxLength: 8 }),
      seq: fc.nat({ max: 1_000 }),
    })
    .map((e) => ({ ...e, timestamp: new Date(0).toISOString() }) as unknown as RunEvent);

  /**
   * Target workflow connections plus the stale subset, plus a decoy workflow
   * with its own connection set.
   */
  const arbTopology = fc
    .tuple(arbConnectionIds('target'), arbConnectionIds('decoy'))
    .chain(([targetConnections, decoyConnections]) =>
      fc.record({
        targetConnections: fc.constant(targetConnections),
        decoyConnections: fc.constant(decoyConnections),
        staleMask: arbStaleMask(targetConnections.length),
      }),
    );

  /**
   * **Validates: Requirements 8.7**
   *
   * For any connection set on a workflow and any subset of it stale, pushing
   * one RunEvent delivers it exactly once to each live connection, delivers it
   * to no connection of the decoy workflow, deletes exactly the stale
   * connection records, and resolves successfully - including when the set is
   * empty and when every connection is stale.
   */
  it('delivers once per live connection, never cross-workflow, and prunes exactly the stale set', async () => {
    await fc.assert(
      fc.asyncProperty(arbTopology, arbEvent, async (topology, event) => {
        const { targetConnections, decoyConnections, staleMask } = topology;
        const targetWorkflowId = 'wf-target';
        const decoyWorkflowId = 'wf-decoy';

        const backend = new FakeMonitorBackend();
        const monitor = new MonitorAdapter(backend);

        for (const connectionId of targetConnections) {
          backend.addConnection(targetWorkflowId, connectionId);
        }
        for (const connectionId of decoyConnections) {
          backend.addConnection(decoyWorkflowId, connectionId);
        }

        const stale = targetConnections.filter((_, i) => staleMask[i]);
        const live = targetConnections.filter((_, i) => !staleMask[i]);
        for (const connectionId of stale) {
          backend.markGone(connectionId);
        }

        // Resolves for every topology, including the empty connection set
        await expect(monitor.push(targetWorkflowId, event)).resolves.toBeUndefined();

        // 1. Exactly once per live connection - not zero times, not twice
        const deliveries = new Map<string, number>();
        for (const post of backend.posted) {
          deliveries.set(post.connectionId, (deliveries.get(post.connectionId) ?? 0) + 1);
        }
        for (const connectionId of live) {
          expect(deliveries.get(connectionId)).toBe(1);
        }
        expect(backend.posted).toHaveLength(live.length);
        for (const post of backend.posted) {
          expect(post.data).toBe(JSON.stringify(event));
        }

        // 2. Never reaches the decoy workflow's connections, and never prunes them
        const decoySet = new Set(decoyConnections);
        for (const post of backend.posted) {
          expect(decoySet.has(post.connectionId)).toBe(false);
        }
        for (const connectionId of backend.removed) {
          expect(decoySet.has(connectionId)).toBe(false);
        }
        expect([...backend.getConnections(decoyWorkflowId)].sort()).toEqual(
          [...decoyConnections].sort(),
        );

        // 3. Exactly the stale records are deleted - no more, no less, no repeats
        expect([...backend.removed].sort()).toEqual([...stale].sort());
        expect([...backend.getConnections(targetWorkflowId)].sort()).toEqual([...live].sort());
      }),
      { numRuns: 100 },
    );
  });
});
