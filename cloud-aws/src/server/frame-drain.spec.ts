/**
 * Property tests for the Frame_Inbox drain.
 *
 * Property 13: Frame drain preserves arrival order
 * Validates: Requirements 7.7
 *
 * Feature: aws-byo-deploy, Property 13: Frame drain preserves arrival order
 *
 * The oracle is deliberately independent of `keys.ts frameSk`: expected order is
 * the tuple order `(arrivedAtMs, connectionId, n)`, not a re-sort of the stored
 * sort keys. That is what makes the test able to fail when the drain reorders -
 * asserting against the same string the drain read back would prove nothing.
 *
 * Connection ids are constrained to lowercase alphanumerics because
 * `FakeRunTable` orders a partition with `localeCompare`, which only agrees with
 * DynamoDB's byte ordering on a single-case alphanumeric alphabet. Arrival
 * timestamps deliberately COLLIDE across differing connection ids and counters:
 * disambiguating those is the entire reason the sort key is composite.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';

import { FakeRunTable } from '../test/fake-run-table.js';
import {
  FakeDocumentTableClient,
  type RecordedRequest,
} from '../test/fake-document-table-client.js';
import type { ControlFrame } from '../core/frames.js';
import type { HeldLease } from '../core/host-contract.js';
import { pk, leaseSk, frameSk, runSk } from '../core/keys.js';
import { drainFrameInbox } from './frame-drain.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────────────────────

const TABLE_NAME = 'phorma-run-table';

/** The drain's page size, and the boundary the generated backlog must cross. */
const FRAME_PAGE_SIZE = 100;

/** Deletes per fenced transaction, plus the lease ConditionCheck in slot 0. */
const MAX_TRANSACT_ITEMS = 25;

/**
 * What a seeded Frame_Inbox item carries in `body`.
 *
 * `inert-event` is parseable but routes to `ignore` for every possible pending
 * state, so the drain consumes it without delivering it. `bad-json`,
 * `unknown-type` and `no-body` are the three ways an item fails `parseFrame`.
 */
type BodyKind =
  | 'approval'
  | 'question'
  | 'event'
  | 'trigger'
  | 'stop'
  | 'inert-event'
  | 'bad-json'
  | 'unknown-type'
  | 'no-body';

const DELIVERED_KINDS: ReadonlySet<BodyKind> = new Set<BodyKind>([
  'approval',
  'question',
  'event',
  'trigger',
  'stop',
]);

/** One item to seed into the inbox. */
interface FrameSeed {
  arrivedAtMs: number;
  connectionId: string;
  n: number;
  kind: BodyKind;
  /** Unique per seed, in GENERATION order - never in key order. */
  tag: string;
}

/**
 * Arrival timestamps. Small values sit alongside real epoch milliseconds so the
 * 13-digit zero-padding of `frameSk` is load-bearing, and the pool is small so
 * collisions are the norm rather than the exception.
 */
const ARRIVAL_POOL = [1, 999, 1_700_000_000_000, 1_700_000_000_001, 1_700_000_000_002, 9_000_000_000_000];

/** Connection ids of differing lengths, all lowercase alphanumeric. */
const CONNECTION_POOL = ['a', 'aa', 'c1', 'c2', 'zz9'];

const BODY_KINDS: BodyKind[] = [
  'approval',
  'question',
  'event',
  'trigger',
  'stop',
  'inert-event',
  'bad-json',
  'unknown-type',
  'no-body',
];

/** The raw text stored in `body`, or undefined for an item with no `body`. */
function bodyFor(kind: BodyKind, tag: string): string | undefined {
  switch (kind) {
    case 'approval':
      return JSON.stringify({ type: 'approval', requestId: tag, approved: true });
    case 'question':
      return JSON.stringify({ type: 'question', requestId: tag, response: `r-${tag}` });
    case 'event':
      return JSON.stringify({ type: 'event', correlationKey: tag, payload: `p-${tag}` });
    case 'trigger':
      return JSON.stringify({ type: 'trigger', input: tag });
    case 'stop':
      return JSON.stringify({ type: 'stop' });
    case 'inert-event':
      // Blank after trimming, so `routeFrame` ignores it whatever is pending.
      return JSON.stringify({ type: 'event', correlationKey: '   ' });
    case 'bad-json':
      return `{not json ${tag}`;
    case 'unknown-type':
      return JSON.stringify({ type: 'bogus', requestId: tag });
    case 'no-body':
      return undefined;
  }
}

/** One raw draw over the key space: 6 x 5 x 10 = 300 distinct arrival keys. */
const drawArb = fc.record({
  arrival: fc.nat({ max: ARRIVAL_POOL.length - 1 }),
  connection: fc.nat({ max: CONNECTION_POOL.length - 1 }),
  n: fc.nat({ max: 9 }),
  kind: fc.constantFrom(...BODY_KINDS),
});

/**
 * Two regimes, both needed. Left to itself fast-check keeps arrays small, so a
 * backlog large enough to cross the 100-item page boundary has to be asked for
 * explicitly - and a `size: 'max'` draw of 300 over 300 keys survives the
 * collision filter at roughly 190 items, comfortably three pages.
 */
const drawsArb = fc.oneof(
  { arbitrary: fc.array(drawArb, { minLength: 0, maxLength: 40 }), weight: 3 },
  {
    arbitrary: fc.array(drawArb, { minLength: 200, maxLength: 300, size: 'max' }),
    weight: 1,
  },
);

/** Generate seeds, then drop key collisions so each seed is one stored item. */
const seedsArb = drawsArb
  .map((raw) => {
    const seen = new Set<string>();
    const seeds: FrameSeed[] = [];
    for (const candidate of raw) {
      const arrivedAtMs = ARRIVAL_POOL[candidate.arrival];
      const connectionId = CONNECTION_POOL[candidate.connection];
      const sk = frameSk(arrivedAtMs, connectionId, candidate.n);
      if (seen.has(sk)) continue;
      seen.add(sk);
      seeds.push({
        arrivedAtMs,
        connectionId,
        n: candidate.n,
        kind: candidate.kind,
        tag: `t${seeds.length}`,
      });
    }
    return seeds;
  });

const workflowIdArb = fc
  .string({ minLength: 1, maxLength: 16 })
  .map((raw) => raw.replace(/#/g, '_'));

const fenceArb = fc.integer({ min: 1, max: 5_000 });

interface Harness {
  table: FakeRunTable;
  client: FakeDocumentTableClient;
  delivered: ControlFrame[];
  drain(): Promise<number>;
  remainingFrameSks(): string[];
}

/**
 * Seed the lease, one unrelated `run#` item and every frame, and return the
 * drain wired to the fake. `heldFence` of undefined models no run in flight.
 */
function harness(workflowId: string, fence: number, seeds: FrameSeed[], hold = true): Harness {
  const table = new FakeRunTable();
  const client = new FakeDocumentTableClient(table, { tableName: TABLE_NAME });
  const partition = pk(workflowId);

  table.seed({ pk: partition, sk: leaseSk() }, { fence, expiresAtMs: 0, runnerId: 'runner-1' });
  // A neighbour outside the `frame#` prefix: the drain must leave it alone.
  table.seed({ pk: partition, sk: runSk('run-1') }, { status: 'running' });

  for (const seed of seeds) {
    const body = bodyFor(seed.kind, seed.tag);
    table.seed(
      { pk: partition, sk: frameSk(seed.arrivedAtMs, seed.connectionId, seed.n) },
      { tag: seed.tag, ...(body === undefined ? {} : { body }) },
    );
  }

  const lease: HeldLease = { workflowId, runnerId: 'runner-1', fence, expiresAtMs: 0 };
  const delivered: ControlFrame[] = [];

  return {
    table,
    client,
    delivered,
    drain: () =>
      drainFrameInbox({
        table: client,
        tableName: TABLE_NAME,
        lease: () => (hold ? lease : undefined),
        deliver: (frame) => delivered.push(frame),
      }),
    remainingFrameSks: () =>
      table
        .query({ pk: partition, skPrefix: 'frame#' })
        .items.map((item) => String(item['sk'])),
  };
}

/**
 * Expected delivery order: the seeds sorted by the composite arrival key
 * `(arrivedAtMs, connectionId, n)`, keeping only the ones that parse and are
 * not inert, as the frames the Runner should see.
 */
function expectedDelivery(seeds: FrameSeed[]): ControlFrame[] {
  return [...seeds]
    .sort(
      (a, b) =>
        a.arrivedAtMs - b.arrivedAtMs ||
        (a.connectionId < b.connectionId ? -1 : a.connectionId > b.connectionId ? 1 : 0) ||
        a.n - b.n,
    )
    .filter((seed) => DELIVERED_KINDS.has(seed.kind))
    .map((seed) => JSON.parse(bodyFor(seed.kind, seed.tag)!) as ControlFrame);
}

/**
 * Assert one recorded write is a fenced transaction: item 0 is the
 * `ConditionCheck` on `{ pk: 'wf#{workflowId}', sk: 'lease' }` asserting
 * equality with the held fencing token, and every remaining item writes the
 * same partition without touching the lease item. Mirrors the shape
 * `run-table.spec.ts` asserts for every other run-scoped write.
 */
function assertFencedTransact(request: RecordedRequest, workflowId: string, fence: number): void {
  expect(request.operation, `an unfenced ${request.operation} reached Run_Table`).toBe(
    'TransactWriteItems',
  );

  const items = (request.input as TransactWriteCommandInput).TransactItems ?? [];
  expect(items.length).toBeGreaterThanOrEqual(2);
  expect(items.length).toBeLessThanOrEqual(MAX_TRANSACT_ITEMS);

  const check = items[0].ConditionCheck;
  expect(check, 'item 0 of a fenced transaction is the lease ConditionCheck').toBeDefined();
  expect(check!.Key).toEqual({ pk: pk(workflowId), sk: leaseSk() });

  const names = check!.ExpressionAttributeNames ?? {};
  const values = check!.ExpressionAttributeValues ?? {};
  const match = /^(#\S+) = (:\S+)$/.exec(check!.ConditionExpression ?? '');
  expect(match, `unexpected lease condition '${check!.ConditionExpression}'`).not.toBeNull();
  expect(names[match![1]]).toBe('fence');
  expect(values[match![2]]).toBe(fence);

  for (const item of items.slice(1)) {
    const key = item.Delete?.Key as Record<string, unknown> | undefined;
    expect(key, 'a fenced frame transaction only deletes').toBeDefined();
    expect(key!['pk']).toBe(pk(workflowId));
    expect(key!['sk']).not.toBe(leaseSk());
    expect(String(key!['sk']).startsWith('frame#')).toBe(true);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Property 13: Frame drain preserves arrival order
// ─────────────────────────────────────────────────────────────────────────────

describe('frame-drain - Property 13: Frame drain preserves arrival order', () => {
  it('delivers parseable frames in ascending arrival-key order and deletes every drained item', async () => {
    await fc.assert(
      fc.asyncProperty(workflowIdArb, fenceArb, seedsArb, async (workflowId, fence, seeds) => {
        const h = harness(workflowId, fence, seeds);

        const drained = await h.drain();

        // 1. Ordering: element-for-element, across every page boundary.
        expect(h.delivered).toEqual(expectedDelivery(seeds));

        // 2. Every seeded item is drained, parseable or not, and nothing
        //    outside the `frame#` prefix is touched.
        expect(drained).toBe(seeds.length);
        expect(h.remainingFrameSks()).toEqual([]);
        expect(h.table.getItem({ pk: pk(workflowId), sk: runSk('run-1') })).not.toBeNull();
        expect(h.table.getItem({ pk: pk(workflowId), sk: leaseSk() })).not.toBeNull();

        // 3. Unparseable and inert frames are consumed, never delivered.
        expect(h.delivered.length).toBe(
          seeds.filter((seed) => DELIVERED_KINDS.has(seed.kind)).length,
        );

        // 4. Every delete is fenced with the held token, so a Zombie Runner
        //    cannot consume the inbox (the no-lease case is the next test).
        const writes = h.client.requests.filter(
          (request) => request.operation === 'TransactWriteItems',
        );
        for (const write of writes) assertFencedTransact(write, workflowId, fence);
        if (seeds.length > 0) expect(writes.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  it('delivers nothing, deletes nothing and returns 0 while no lease is held', async () => {
    await fc.assert(
      fc.asyncProperty(
        workflowIdArb,
        fenceArb,
        seedsArb.filter((seeds) => seeds.length > 0),
        async (workflowId, fence, seeds) => {
          const h = harness(workflowId, fence, seeds, false);

          const drained = await h.drain();

          expect(drained).toBe(0);
          expect(h.delivered).toEqual([]);
          expect(h.client.requests).toEqual([]);
          expect(h.remainingFrameSks().length).toBe(seeds.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Worked examples - the page boundary and the two non-delivered shapes
// ─────────────────────────────────────────────────────────────────────────────

describe('frame-drain - worked examples', () => {
  /** 260 frames on one colliding timestamp: three pages, one arrival key. */
  function collidingSeeds(count: number): FrameSeed[] {
    const seeds: FrameSeed[] = [];
    for (let index = 0; index < count; index++) {
      seeds.push({
        arrivedAtMs: ARRIVAL_POOL[2],
        connectionId: CONNECTION_POOL[index % CONNECTION_POOL.length],
        n: Math.floor(index / CONNECTION_POOL.length),
        kind: 'trigger',
        tag: `t${index}`,
      });
    }
    return seeds;
  }

  it('drains a backlog larger than one page in arrival order', async () => {
    const seeds = collidingSeeds(260);
    expect(seeds.length).toBeGreaterThan(FRAME_PAGE_SIZE * 2);

    const h = harness('wf-pages', 7, seeds);
    const drained = await h.drain();

    expect(drained).toBe(260);
    expect(h.delivered).toEqual(expectedDelivery(seeds));
    expect(h.remainingFrameSks()).toEqual([]);
  });

  it('deletes an unparseable frame without delivering it', async () => {
    const h = harness('wf-bad', 3, [
      { arrivedAtMs: 5, connectionId: 'a', n: 0, kind: 'bad-json', tag: 't0' },
      { arrivedAtMs: 6, connectionId: 'a', n: 0, kind: 'no-body', tag: 't1' },
      { arrivedAtMs: 7, connectionId: 'a', n: 0, kind: 'unknown-type', tag: 't2' },
    ]);

    expect(await h.drain()).toBe(3);
    expect(h.delivered).toEqual([]);
    expect(h.remainingFrameSks()).toEqual([]);
  });

  it('deletes an inert event without delivering it', async () => {
    const h = harness('wf-inert', 3, [
      { arrivedAtMs: 5, connectionId: 'a', n: 0, kind: 'inert-event', tag: 't0' },
      { arrivedAtMs: 6, connectionId: 'a', n: 0, kind: 'event', tag: 't1' },
    ]);

    expect(await h.drain()).toBe(2);
    expect(h.delivered).toEqual([{ type: 'event', correlationKey: 't1', payload: 'p-t1' }]);
  });

  it('rejects the drain of a zombie Runner whose fence has been superseded', async () => {
    const h = harness('wf-zombie', 4, [
      { arrivedAtMs: 5, connectionId: 'a', n: 0, kind: 'trigger', tag: 't0' },
    ]);
    // Another Runner took the lease: the stored fence moved on.
    h.table.seed(
      { pk: pk('wf-zombie'), sk: leaseSk() },
      { fence: 5, expiresAtMs: 0, runnerId: 'runner-2' },
    );

    await expect(h.drain()).rejects.toThrow();
    expect(h.remainingFrameSks().length).toBe(1);
  });
});
