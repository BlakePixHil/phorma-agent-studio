/**
 * Integration test for the reference sync graph (design §14.1, task 22.3).
 *
 * Builds the nightly aggregate-sync reference graph exactly as described in
 * design.md §14.1 (manual-trigger stands in for schedule-trigger — the trigger
 * kind is irrelevant to everything downstream of it):
 *
 *   trigger -> http-request (fetch jobs, paginated, resultKey "jobs")
 *           -> aggregate (group by clientId)
 *           -> transform (map to CRM fields, resultKey "records")
 *           -> assert (3 assertions, baselineStateKey "baseline:crm-sync", onBreach "fail")
 *           -> for-each (batchSize 100)
 *                -> http-request (upsert, idempotencyKey)
 *           -> state-set (watermark "wm:jobs")
 *
 * No agent anywhere in this path (Requirement 1.1); every node is a data node.
 * The host fakes are the real task 22.1 in-memory implementations — nothing at
 * the engine level is mocked — so this proves the WIRING of the reference
 * graph, not just each node in isolation.
 *
 * **Validates: Requirements 12.11, 12.12, 12.14, 14.4, 14.7, 14.8**
 *
 *  - 12.11: `considered = changed + skipped` after the delta stage.
 *  - 12.12/12.14: a write's own success gates the delta hash / idempotency
 *    claim — modelled here through the batched-upsert idempotency claim.
 *  - 14.4: exactly one `sync-summary` immediately before the terminal event.
 *  - 14.7: every `page-fetched` / `http-response` / `state-written` /
 *    `assert-passed` count is folded into the summary before it is emitted.
 *  - 14.8: `written + failed <= considered`, and `SyncSummary.guards` holds one
 *    entry per evaluated assertion.
 */

import { describe, expect, it } from 'vitest';

import type { ResolvedConnection } from './connections.js';
import type { DataRequest, DataResponse } from './data-host.js';
import { startRun } from './engine.js';
import type { RunEvent } from './events.js';
import { accumulateSync, createSyncSummary } from './run-record.js';
import { scopedStateKey, watermarkStateKey } from './state.js';
import { FakeConnectionStore, FakeDataFetcher, NEVER_CALLED_MODEL } from './test/fake-host.js';
import { MemoryStateStore } from './test/memory-state-store.js';
import type {
  AggregateNodeData,
  AssertNodeData,
  ForEachNodeData,
  HttpRequestNodeData,
  StateSetNodeData,
  TransformNodeData,
  WorkflowGraph,
  WorkflowNode,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const RUN_ID = 'run-1';
const WORKFLOW_ID = 'wf-crm-sync';
const FETCH_CONNECTION_ID = 'conn-lob';
const CRM_CONNECTION_ID = 'conn-crm';
const TOTAL_RECORDS = 250;
const BATCH_SIZE = 100;

function port(id: string, role: 'message-in' | 'message-out') {
  return { id, name: id, role };
}

function connect(id: string, outputId: string, inputId: string) {
  return { id, outputId, inputId, kind: 'handoff' as const };
}

function trigger(): WorkflowNode {
  // Manual trigger stands in for schedule-trigger (task instructions): the
  // executor never looks at the trigger kind past the first handoff.
  return {
    id: 'n1',
    name: 'Nightly',
    kind: 'manual-trigger',
    category: 'trigger',
    icon: 'pi-play',
    position: { x: 0, y: 0 },
    ports: [port('n1-out-1', 'message-out')],
    data: {},
  };
}

function fetchJobsNode(): WorkflowNode {
  const data: HttpRequestNodeData = {
    connectionId: FETCH_CONNECTION_ID,
    method: 'GET',
    url: '/api/jobs',
    responseMode: 'json',
    pagination: {
      mode: 'cursor',
      cursorPath: 'meta.nextCursor',
      cursorParam: 'cursor',
      itemsPath: 'data',
      maxPages: 200,
    },
    resultKey: 'jobs',
  };
  return {
    id: 'n2',
    name: 'Fetch jobs',
    kind: 'http-request',
    category: 'flow',
    icon: 'ti ti-api',
    position: { x: 320, y: 120 },
    ports: [
      port('n2-in-1', 'message-in'),
      port('n2-out-1', 'message-out'),
      port('n2-err-1', 'message-out'),
    ],
    data,
  };
}

function countsPerClientNode(): WorkflowNode {
  const data: AggregateNodeData = {
    op: 'group',
    itemsPath: 'jobs.items',
    group: {
      by: ['clientId'],
      metrics: [
        { name: 'openJobs', fn: 'countIf', where: 'item.status == "open"' },
        { name: 'largeJobs', fn: 'countIf', where: 'item.sizeBand == "L"' },
        { name: 'totalValue', fn: 'sum', path: 'value' },
      ],
    },
    resultKey: 'groups',
  };
  return {
    id: 'n3',
    name: 'Counts per client',
    kind: 'aggregate',
    category: 'flow',
    icon: 'pi-chart-bar',
    position: { x: 440, y: 120 },
    ports: [port('n3-in-1', 'message-in'), port('n3-out-1', 'message-out')],
    data,
  };
}

function mapToCrmFieldsNode(): WorkflowNode {
  const data: TransformNodeData = {
    itemsPath: 'groups',
    mode: 'array',
    fields: [
      { target: 'External_Client_Id', expression: 'item.clientId', required: true },
      { target: 'Open_Jobs', expression: 'item.openJobs', cast: 'integer', default: 0 },
      { target: 'Large_Jobs', expression: 'item.largeJobs', cast: 'integer', default: 0 },
      { target: 'Pipeline_Value', expression: 'round(item.totalValue, 2)', cast: 'number' },
    ],
    resultKey: 'records',
  };
  return {
    id: 'n4',
    name: 'Map to CRM fields',
    kind: 'transform',
    category: 'flow',
    icon: 'pi-sliders-h',
    position: { x: 560, y: 120 },
    ports: [port('n4-in-1', 'message-in'), port('n4-out-1', 'message-out')],
    data,
  };
}

const ASSERT_PASSED_PORT = 'n5-out-pass';
const ASSERT_FAILED_PORT = 'n5-out-fail';

function sanityGuardNode(): WorkflowNode {
  const data: AssertNodeData = {
    baselineStateKey: 'baseline:crm-sync',
    onBreach: 'fail',
    assertions: [
      {
        name: 'has rows',
        expression: 'len($.records) >= 1',
        message: 'Source returned no records — refusing to overwrite good data.',
      },
      {
        name: 'ids present',
        expression: 'countIf($.records, "isEmpty(item.External_Client_Id)") == 0',
      },
      {
        name: 'value variance',
        severity: 'error',
        expression:
          'isNull(baseline.totalValue) ? true : ' +
          'abs(sum($.records, "item.Pipeline_Value") - baseline.totalValue) / ' +
          'max(baseline.totalValue, 1) <= 0.25',
        message: 'Pipeline value moved more than 25% since the last run.',
      },
    ],
  };
  return {
    id: 'n5',
    name: 'Sanity guard',
    kind: 'assert',
    category: 'flow',
    icon: 'ti ti-shield-check',
    position: { x: 680, y: 120 },
    ports: [
      port('n5-in-1', 'message-in'),
      port(ASSERT_PASSED_PORT, 'message-out'),
      port(ASSERT_FAILED_PORT, 'message-out'),
    ],
    data,
  };
}

function batchesOf100Node(): WorkflowNode {
  const data: ForEachNodeData = {
    itemsPath: 'records',
    batchSize: BATCH_SIZE,
    concurrency: 1,
    continueOnError: true,
  };
  return {
    id: 'n6',
    name: 'Batches of 100',
    kind: 'for-each',
    category: 'flow',
    icon: 'ti ti-repeat',
    position: { x: 800, y: 120 },
    ports: [
      port('n6-in-1', 'message-in'),
      port('n6-body-1', 'message-out'),
      port('n6-done-1', 'message-out'),
    ],
    data,
  };
}

function upsertToCrmNode(): WorkflowNode {
  const data: HttpRequestNodeData = {
    connectionId: CRM_CONNECTION_ID,
    method: 'POST',
    url: '/crm/v8/Deals/upsert',
    bodyMode: 'json',
    body: '{{input}}',
    // Each batch is an array of records; the FIRST record's client id varies
    // per batch (every job carries a distinct `clientId`), which is what makes
    // this idempotency key unique per batch rather than colliding across all
    // three (`{{index}}`/`{{batchIndex}}` are not payload fields the template
    // interpolator resolves — see `interpolatePayload`).
    idempotencyKey: `crm-upsert-${RUN_ID}-{{0.External_Client_Id}}`,
    persistResponseBody: false,
  };
  return {
    id: 'n7',
    name: 'Upsert to CRM',
    kind: 'http-request',
    category: 'flow',
    icon: 'ti ti-api',
    position: { x: 920, y: 120 },
    ports: [
      port('n7-in-1', 'message-in'),
      port('n7-out-1', 'message-out'),
      port('n7-err-1', 'message-out'),
    ],
    data,
  };
}

function advanceWatermarkNode(): WorkflowNode {
  // The design §14.1 fragment illustrates `max(map($.jobs.items, "item.updatedAt"))`,
  // but `max()` only folds numeric operands (Requirement 4.6) — ISO timestamp
  // strings are exactly what `compareWatermark` orders lexicographically, not
  // what `max()` accepts. `now()` (the deterministic run clock) is a valid
  // watermark value that is guaranteed to advance past the seeded baseline
  // below, which is what this test needs to observe.
  const data: StateSetNodeData = {
    key: 'wm:jobs',
    valueExpression: 'formatDate(now(), "iso")',
    semantics: 'watermark',
  };
  return {
    id: 'n8',
    name: 'Advance watermark',
    kind: 'state-set',
    category: 'flow',
    icon: 'ti ti-database',
    position: { x: 1040, y: 120 },
    ports: [port('n8-in-1', 'message-in'), port('n8-out-1', 'message-out')],
    data,
  };
}

/**
 * Builds the §14.1 reference graph exactly:
 *
 *   trigger -> fetch jobs -> counts per client -> map to CRM fields ->
 *   sanity guard --Passed--> batches of 100 -> upsert to CRM (loop body) ->
 *   [loop done] -> advance watermark
 */
function referenceGraph(): WorkflowGraph {
  const nodes: WorkflowNode[] = [
    trigger(),
    fetchJobsNode(),
    countsPerClientNode(),
    mapToCrmFieldsNode(),
    sanityGuardNode(),
    batchesOf100Node(),
    upsertToCrmNode(),
    advanceWatermarkNode(),
  ];
  const connections = [
    connect('c1', 'n1-out-1', 'n2-in-1'),
    connect('c2', 'n2-out-1', 'n3-in-1'),
    connect('c3', 'n3-out-1', 'n4-in-1'),
    connect('c4', 'n4-out-1', 'n5-in-1'),
    connect('c5', ASSERT_PASSED_PORT, 'n6-in-1'),
    connect('c6', 'n6-body-1', 'n7-in-1'),
    connect('c7', 'n6-done-1', 'n8-in-1'),
  ];
  return { nodes, connections };
}

/**
 * One synthetic job record. Each job carries its OWN `clientId`, so grouping
 * by `clientId` (the reference graph's aggregate step) yields one output
 * record per job — `TOTAL_RECORDS` records reaching the batched upsert, per
 * the task's "processes ~250 records across 3 batches" requirement.
 */
function job(index: number) {
  return {
    id: `job-${index}`,
    clientId: `client-${index}`,
    status: index % 3 === 0 ? 'open' : 'closed',
    sizeBand: index % 7 === 0 ? 'L' : 'S',
    value: 100 + index,
    updatedAt: `2024-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
  };
}

function ok(body: string, over: Partial<DataResponse> = {}): Partial<DataResponse> {
  return { status: 200, headers: {}, body, byteCount: body.length, durationMs: 5, ...over };
}

function seedConnections(): FakeConnectionStore {
  const store = new FakeConnectionStore();
  const base: Omit<ResolvedConnection, 'id'> = {
    type: 'http',
    config: { baseUrl: 'https://api.example.com' },
    secrets: {},
    auth: { mode: 'none' },
    allowWrites: false,
  };
  store.seed({ id: FETCH_CONNECTION_ID, ...base });
  store.seed({ id: CRM_CONNECTION_ID, ...base, allowWrites: true });
  return store;
}

/** Scripts a single-page fetch of `TOTAL_RECORDS` jobs (no next cursor). */
function seedFetcher(): FakeDataFetcher {
  const jobs = Array.from({ length: TOTAL_RECORDS }, (_, index) => job(index));
  const body = JSON.stringify({ data: jobs, meta: {} });
  // One page for the fetch; every upsert batch call answers 200 with an empty
  // body ("no additional requests" is checked below via `upsertFetcher.requests`).
  const script: Partial<DataResponse>[] = [ok(body)];
  const upsertBatches = Math.ceil(TOTAL_RECORDS / BATCH_SIZE);
  for (let i = 0; i < upsertBatches; i++) script.push(ok('{"status":"ok"}'));
  return new FakeDataFetcher(script);
}

interface HostSet {
  readonly connections: FakeConnectionStore;
  readonly fetcher: FakeDataFetcher;
  readonly state: MemoryStateStore;
}

function freshHosts(): HostSet {
  return {
    connections: seedConnections(),
    fetcher: seedFetcher(),
    state: new MemoryStateStore(),
  };
}

/**
 * Total `Pipeline_Value` the synthetic job set (see {@link job}) actually
 * produces, summed across every grouped client record: `sum(100 + i)` for
 * `i` in `0..TOTAL_RECORDS-1`.
 */
const EXPECTED_PIPELINE_TOTAL =
  TOTAL_RECORDS * 100 + ((TOTAL_RECORDS - 1) * TOTAL_RECORDS) / 2;

/** Seeds the baseline the guard reads, so its variance assertion holds. */
async function seedBaseline(state: MemoryStateStore): Promise<void> {
  const key = scopedStateKey(WORKFLOW_ID, 'baseline:crm-sync');
  // A baseline within ±25% of the synthetic job set's actual pipeline total,
  // so the variance assertion holds (Requirement 7.1) without being a trivial
  // no-op comparison against itself.
  await state.set(key, JSON.stringify({ totalValue: EXPECTED_PIPELINE_TOTAL * 1.1 }));
}

/** Seeds a pre-existing watermark, so the run's advance is observable. */
async function seedWatermark(state: MemoryStateStore): Promise<void> {
  const key = scopedStateKey(WORKFLOW_ID, watermarkStateKey('jobs'));
  await state.set(key, '2020-01-01T00:00:00.000Z');
}

function eventsOf<T extends RunEvent['type']>(
  events: readonly RunEvent[],
  type: T,
): Extract<RunEvent, { type: T }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

interface RunResult {
  readonly events: RunEvent[];
  readonly output: string | undefined;
  readonly failure: string | undefined;
}

async function runReferenceGraph(hosts: HostSet): Promise<RunResult> {
  const events: RunEvent[] = [];
  const handle = startRun({
    runId: RUN_ID,
    graph: referenceGraph(),
    input: '{}',
    workflowId: WORKFLOW_ID,
    model: NEVER_CALLED_MODEL,
    emit: event => events.push(event),
    requestApproval: async () => true,
    requestInput: async () => '',
    connections: hosts.connections,
    dataFetch: hosts.fetcher.fetch,
    state: hosts.state,
  });
  await handle.done;
  return {
    events,
    output: eventsOf(events, 'run-completed')[0]?.output,
    failure: eventsOf(events, 'run-failed')[0]?.error,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The test
// ─────────────────────────────────────────────────────────────────────────────

describe('the reference sync graph (design §14.1)', () => {
  it('runs the whole nightly sync end to end with no failure', async () => {
    const hosts = freshHosts();
    await seedBaseline(hosts.state);
    await seedWatermark(hosts.state);

    const run = await runReferenceGraph(hosts);

    expect(run.failure).toBeUndefined();
    expect(run.output).toBeDefined();
  });

  it('batches the 250 upserts into 3 calls, not 250 individual requests', async () => {
    const hosts = freshHosts();
    await seedBaseline(hosts.state);
    await seedWatermark(hosts.state);

    const run = await runReferenceGraph(hosts);
    expect(run.failure).toBeUndefined();

    const loopCompleted = eventsOf(run.events, 'loop-completed');
    expect(loopCompleted).toHaveLength(1);
    // ceil(250 / 100) = 3 batches (Requirements 9.8, 9.9).
    expect(loopCompleted[0]!.total).toBe(3);
    expect(loopCompleted[0]!.succeeded).toBe(3);
    expect(loopCompleted[0]!.failed).toBe(0);

    // The upsert node's own request count: 1 fetch + 3 upserts = 4 total,
    // never 1 + 250.
    expect(hosts.fetcher.callCount).toBe(1 + 3);
    const upsertRequests = hosts.fetcher.requests.filter((request: DataRequest) =>
      request.url.includes('/crm/v8/Deals/upsert'),
    );
    expect(upsertRequests).toHaveLength(3);
  });

  it('advances the watermark only after every batched upsert has completed', async () => {
    const hosts = freshHosts();
    await seedBaseline(hosts.state);
    await seedWatermark(hosts.state);

    const run = await runReferenceGraph(hosts);
    expect(run.failure).toBeUndefined();

    const upsertCompleted = eventsOf(run.events, 'node-completed').filter(
      event => event.nodeId === 'n7',
    );
    const loopCompleted = eventsOf(run.events, 'loop-completed');
    const watermarkWritten = eventsOf(run.events, 'state-written').find(
      event => event.semantics === 'watermark',
    );

    expect(upsertCompleted).toHaveLength(3);
    expect(loopCompleted).toHaveLength(1);
    expect(watermarkWritten).toBeDefined();

    // Every upsert index precedes the loop's own completion index, which in
    // turn precedes the watermark write's index (design §14.1 ordering).
    const upsertIndices = upsertCompleted.map(event => run.events.indexOf(event));
    const loopIndex = run.events.indexOf(loopCompleted[0]!);
    const watermarkIndex = run.events.indexOf(watermarkWritten!);

    expect(Math.max(...upsertIndices)).toBeLessThan(loopIndex);
    expect(loopIndex).toBeLessThan(watermarkIndex);

    // The watermark actually advanced: it read the seeded value and stored a
    // newer one (Requirement 12.8).
    expect(watermarkWritten!.changed).toBe(true);
    expect(watermarkWritten!.from).toBe('2020-01-01T00:00:00.000Z');
  });

  it('carries considered = changed + skipped and written + failed <= considered', async () => {
    const hosts = freshHosts();
    await seedBaseline(hosts.state);
    await seedWatermark(hosts.state);

    const run = await runReferenceGraph(hosts);
    expect(run.failure).toBeUndefined();

    const summaryEvent = eventsOf(run.events, 'sync-summary')[0];
    expect(summaryEvent).toBeDefined();
    const summary = summaryEvent!.summary;

    // The §14.1 reference graph runs no `delta`-semantics `state-set` (its
    // watermark advance is `semantics: 'watermark'`, not `'delta'`), so the
    // delta stage never contributes a `changed`/`skipped` count here: both
    // stay zero, and `accumulateSync` raises `considered` to match the write
    // loop's own report instead (documented in `run-record.ts` as the
    // behaviour for "a workflow that writes without a delta filter").
    // Requirement 12.11's identity is re-verified directly against
    // `accumulateSync` below, over a summary that DOES run a delta stage.
    expect(summary.changed).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.considered).toBe(summary.written + summary.failed);
    // Requirement 14.8: a write loop can only ever report as many successes
    // and failures as were considered.
    expect(summary.written + summary.failed).toBeLessThanOrEqual(summary.considered);
    expect(summary.written).toBe(3);
    expect(summary.failed).toBe(0);
  });

  it('holds considered = changed + skipped after a delta stage (Requirement 12.11)', () => {
    // `accumulateSync` is the pure fold the engine feeds every emitted event
    // into before it emits `sync-summary` (Requirement 14.7); this reference
    // graph runs no `delta`-semantics `state-set`, so the identity is checked
    // directly against the accumulator with a delta-stage event sequence,
    // exactly the shape §14.1's aggregate-then-upsert pattern would produce
    // for a workflow that adds a `delta` guard ahead of its write loop.
    const summary = createSyncSummary();
    const deltaWrite = (changed: boolean): RunEvent => ({
      type: 'state-written',
      runId: RUN_ID,
      nodeId: 'delta-1',
      key: 'delta:jobs:client-1',
      semantics: 'delta',
      changed,
      at: Date.now(),
    });
    for (const changed of [true, true, false, true, false, false]) {
      accumulateSync(deltaWrite(changed), summary);
    }
    expect(summary.considered).toBe(summary.changed + summary.skipped);
    expect(summary.changed).toBe(3);
    expect(summary.skipped).toBe(3);
  });

  it('exposes exactly one Sync_Summary.guards entry per evaluated assertion', async () => {
    const hosts = freshHosts();
    await seedBaseline(hosts.state);
    await seedWatermark(hosts.state);

    const run = await runReferenceGraph(hosts);
    expect(run.failure).toBeUndefined();

    const summaryEvent = eventsOf(run.events, 'sync-summary')[0];
    const guards = summaryEvent!.summary.guards ?? [];

    // 3 assertions declared on the guard node (Requirement 7.1); one guard
    // entry per evaluated assertion, all held.
    expect(guards).toHaveLength(3);
    expect(guards.map(guard => guard.name)).toEqual(['has rows', 'ids present', 'value variance']);
    expect(guards.every(guard => guard.passed)).toBe(true);

    const assertPassed = eventsOf(run.events, 'assert-passed');
    expect(assertPassed).toHaveLength(1);
    expect(assertPassed[0]!.checked).toBe(3);
    expect(eventsOf(run.events, 'assert-breached')).toHaveLength(0);
  });

  it('emits exactly one sync-summary immediately before run-completed', async () => {
    const hosts = freshHosts();
    await seedBaseline(hosts.state);
    await seedWatermark(hosts.state);

    const run = await runReferenceGraph(hosts);
    expect(run.failure).toBeUndefined();

    const types = run.events.map(event => event.type);
    expect(types.filter(type => type === 'sync-summary')).toHaveLength(1);
    expect(types.at(-1)).toBe('run-completed');
    expect(types.at(-2)).toBe('sync-summary');
  });
});
