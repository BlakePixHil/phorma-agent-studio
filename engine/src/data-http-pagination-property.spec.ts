import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createPaginationLoop,
  cursorKey,
  DEFAULT_MAX_PAGES,
  maxPagesOf,
  type CursorState,
  type PageFetched,
} from './data-http.js';
import type { PaginationConfig } from './types.js';

/**
 * Property 9: Paginated fetch terminates and conserves items (design §5.1.3).
 *
 * 45. **Page bound.** ∀ server behaviour: total requests ≤ `maxPages`.
 * 46. **Termination.** ∀ server returning a non-advancing cursor/page: the loop
 *     terminates.
 * 47. **Item conservation.** ∀ sequence of pages `P`: accumulated items equal
 *     `concat(P)`, in page order.
 *
 * **Validates: Requirements 9.2, 9.3, 9.5, 9.14**
 *
 * Scoping notes, following the requirement text rather than narrowing the claims:
 *
 * - "Server behaviour" is a generated script of per-page responses plus a tail
 *   behaviour that repeats forever once the script runs out, so a server that
 *   never stops offering a next position is a first-class case rather than an
 *   afterthought.
 * - The four looping modes are all generated. `cursor` and `link-header` let the
 *   server choose the next position (advance, pin the one it just served, replay
 *   an earlier one, or offer none); `page` and `offset` derive the next position
 *   internally, so there the server only chooses the item count, which is exactly
 *   what decides the final page under 9.6.
 * - `maxPages` is drawn from both the accepted 1..1000 range and out-of-range
 *   values (0, negative, 1001, fractional, absent) so the bound asserted is the
 *   EFFECTIVE cap of 9.2, not whatever node data claimed.
 * - The driver runs a bounded number of iterations (`maxPages + 3`). Reaching
 *   that bound with the loop still requestable is the failure signature of a
 *   non-terminating fetch, so claim 46 is observed rather than assumed.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Generated server behaviour
// ─────────────────────────────────────────────────────────────────────────────

/** The looping modes; `none` issues a single request and is a unit-test case. */
const LOOPING_MODES = ['cursor', 'page', 'offset', 'link-header'] as const;
type LoopingMode = (typeof LOOPING_MODES)[number];

/** What the server does with the next pagination value it could offer. */
type NextKind = 'advance' | 'pin' | 'replay' | 'none';

/** One scripted response: how many items, and which next position to offer. */
interface Step {
  readonly items: number;
  readonly next: NextKind;
}

interface Behaviour {
  readonly mode: LoopingMode;
  /** Declared `maxPages`, possibly out of range on purpose. */
  readonly declaredMaxPages: number | undefined;
  /** Page size for mode `offset`; a full page there is what advances the loop. */
  readonly limit: number;
  /** Responses for pages 1..len, then `tail` forever. */
  readonly steps: readonly Step[];
  readonly tail: Step;
}

const stepArb: fc.Arbitrary<Step> = fc.record({
  items: fc.integer({ min: 0, max: 4 }),
  next: fc.constantFrom<NextKind>('advance', 'pin', 'replay', 'none'),
});

const declaredMaxPagesArb: fc.Arbitrary<number | undefined> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 1, max: 6 }) },
  { weight: 1, arbitrary: fc.constantFrom(0, -3, 1001, 2.5) },
  { weight: 1, arbitrary: fc.constant(undefined) },
);

const behaviourArb: fc.Arbitrary<Behaviour> = fc.record({
  mode: fc.constantFrom(...LOOPING_MODES),
  declaredMaxPages: declaredMaxPagesArb,
  limit: fc.integer({ min: 1, max: 3 }),
  steps: fc.array(stepArb, { maxLength: 8 }),
  tail: stepArb,
});

function paginationOf(behaviour: Behaviour): PaginationConfig {
  // `maxPages` is deliberately fed values the type forbids: 9.2 defines what the
  // engine does with them, so the cast keeps the generator honest.
  const maxPages = behaviour.declaredMaxPages as number;
  switch (behaviour.mode) {
    case 'cursor':
      return { mode: 'cursor', cursorPath: 'meta.next', cursorParam: 'cursor', itemsPath: 'data', maxPages };
    case 'page':
      return { mode: 'page', pageParam: 'page', itemsPath: 'data', maxPages };
    case 'offset':
      return {
        mode: 'offset',
        offsetParam: 'offset',
        limitParam: 'limit',
        limit: behaviour.limit,
        itemsPath: 'data',
        maxPages,
      };
    default:
      return { mode: 'link-header', itemsPath: 'data', maxPages };
  }
}

/** One response as the host would hand it to the loop, plus what it contained. */
interface Served {
  readonly parsed: unknown;
  readonly headers: Record<string, string>;
  readonly items: readonly unknown[];
}

/**
 * A server driven by the generated behaviour. Items are tagged with their page
 * and index so item conservation is checked on identity, not on counts.
 */
function makeServer(behaviour: Behaviour): (page: number) => Served {
  const offered: string[] = [];

  const nextValue = (kind: NextKind, page: number): string | undefined => {
    switch (kind) {
      case 'none':
        return undefined;
      case 'advance':
        return `c${page}`;
      case 'pin':
        // The position it just served: requesting it again would replay a page.
        return offered[offered.length - 1] ?? `c${page}`;
      default:
        return offered[0] ?? `c${page}`;
    }
  };

  return (page: number): Served => {
    const step = behaviour.steps[page - 1] ?? behaviour.tail;
    const count = behaviour.mode === 'offset' ? Math.min(step.items, behaviour.limit) : step.items;
    const items = Array.from({ length: count }, (_, index) => `p${page}-i${index}`);

    if (behaviour.mode === 'cursor') {
      const value = nextValue(step.next, page);
      if (value !== undefined) offered.push(value);
      return {
        parsed: { data: items, ...(value === undefined ? {} : { meta: { next: value } }) },
        headers: {},
        items,
      };
    }

    if (behaviour.mode === 'link-header') {
      const value = nextValue(step.next, page);
      if (value !== undefined) offered.push(value);
      const url = value === undefined ? undefined : `https://api.example.com/jobs?token=${value}`;
      return {
        parsed: { data: items },
        headers: url === undefined ? {} : { link: `<${url}>; rel="next"` },
        items,
      };
    }

    // `page` and `offset` advance internally; the item count is the only lever.
    return { parsed: { data: items }, headers: {}, items };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Driver
// ─────────────────────────────────────────────────────────────────────────────

interface Run {
  /** Effective page cap for the behaviour (9.2). */
  readonly maxPages: number;
  /** Requests actually issued. */
  readonly requests: number;
  /** Cursor used for each request, in order. */
  readonly cursors: readonly (CursorState | undefined)[];
  /** What the server returned for each accepted page, in page order. */
  readonly served: readonly (readonly unknown[])[];
  /** The `page-fetched` bodies, one per accepted page (9.4). */
  readonly events: readonly PageFetched[];
  /** True when the loop refused a further request within the iteration bound. */
  readonly terminated: boolean;
  readonly result: { items: unknown[]; pages: number };
}

/**
 * Runs a paginated fetch against a scripted server, exactly as design §5.1 has
 * the executor do it: while `canRequest()`, build from `loop.cursor`, fetch, then
 * `accept`. The iteration bound is three above the effective cap, so a loop that
 * would spin forever shows up as `terminated: false` instead of hanging.
 */
function drive(behaviour: Behaviour): Run {
  const pagination = paginationOf(behaviour);
  const loop = createPaginationLoop(pagination);
  const respond = makeServer(behaviour);
  const maxPages = maxPagesOf(pagination);

  const cursors: (CursorState | undefined)[] = [];
  const served: (readonly unknown[])[] = [];
  const events: PageFetched[] = [];
  let requests = 0;

  for (let iteration = 0; iteration < maxPages + 3; iteration += 1) {
    if (!loop.canRequest()) break;
    cursors.push(loop.cursor);
    requests += 1;
    const response = respond(requests);
    const outcome = loop.accept(response.parsed, response.headers);
    served.push(response.items);
    events.push(outcome.event);
    // What `accept` reports for the page must be what the server sent.
    expect(outcome.items).toEqual(response.items);
    expect(outcome.done).toBe(!loop.canRequest());
  }

  return {
    maxPages,
    requests,
    cursors,
    served,
    events,
    terminated: !loop.canRequest(),
    result: loop.result(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Claim 45: page bound
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 9 — claim 45: a paginated fetch issues at most maxPages requests', () => {
  it('never exceeds the effective page cap, whatever the server does', () => {
    fc.assert(
      fc.property(behaviourArb, (behaviour) => {
        const run = drive(behaviour);
        const declared = behaviour.declaredMaxPages;
        const inRange = Number.isInteger(declared) && (declared as number) >= 1 && (declared as number) <= 1000;

        expect(run.maxPages).toBe(inRange ? (declared as number) : DEFAULT_MAX_PAGES);
        expect(run.requests).toBeLessThanOrEqual(run.maxPages);
        expect(run.result.pages).toBe(run.requests);
      }),
      { numRuns: 300 },
    );
  });

  it('stops exactly at the cap when the server always offers another page', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), fc.constantFrom(...LOOPING_MODES), (maxPages, mode) => {
        const endless: Step = { items: 2, next: 'advance' };
        const run = drive({
          mode,
          declaredMaxPages: maxPages,
          limit: 2,
          steps: [],
          tail: endless,
        });

        expect(run.requests).toBe(maxPages);
        expect(run.terminated).toBe(true);
        // Stopping at the cap still reports that data remained (9.7).
        expect(run.events.at(-1)?.hasMore).toBe(true);
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 46: termination
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 9 — claim 46: the loop terminates on a non-advancing server', () => {
  it('refuses a further request within the page cap for every behaviour', () => {
    fc.assert(
      fc.property(behaviourArb, (behaviour) => {
        const run = drive(behaviour);
        expect(run.terminated).toBe(true);
        // No position is ever requested twice, which is what makes it terminate.
        const keys = run.cursors.map((cursor) => cursorKey(cursor));
        expect(new Set(keys).size).toBe(keys.length);
      }),
      { numRuns: 300 },
    );
  });

  it('stops at the second page when the server pins the position it just served', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<LoopingMode>('cursor', 'link-header'),
        fc.integer({ min: 2, max: 50 }),
        fc.integer({ min: 0, max: 4 }),
        (mode, maxPages, items) => {
          const run = drive({
            mode,
            declaredMaxPages: maxPages,
            limit: 2,
            steps: [],
            tail: { items, next: 'pin' },
          });

          // Page 1 offers a new position, page 2 offers that same one again.
          expect(run.requests).toBe(2);
          expect(run.terminated).toBe(true);
          // Every item accumulated before the stop is retained (9.5).
          expect(run.result.items).toEqual(run.served.flat());
        },
      ),
    );
  });

  it('stops without a further request when the server replays an earlier position', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<LoopingMode>('cursor', 'link-header'),
        fc.integer({ min: 1, max: 6 }),
        (mode, advancing) => {
          const steps: Step[] = Array.from({ length: advancing }, () => ({ items: 1, next: 'advance' }));
          const run = drive({
            mode,
            declaredMaxPages: 100,
            limit: 2,
            steps,
            tail: { items: 1, next: 'replay' },
          });

          // The advancing prefix, then one page whose next position is already spent.
          expect(run.requests).toBe(advancing + 1);
          expect(run.terminated).toBe(true);
          expect(run.result.items).toEqual(run.served.flat());
        },
      ),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim 47: item conservation
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 9 — claim 47: accumulated items are the concatenation of the pages', () => {
  it('keeps every item of every accepted page, in page order', () => {
    fc.assert(
      fc.property(behaviourArb, (behaviour) => {
        const run = drive(behaviour);

        expect(run.result.items).toEqual(run.served.flat());
        expect(run.result.items).toHaveLength(run.served.reduce((total, page) => total + page.length, 0));

        // Each event names its one-based page and that page's own item count (9.4).
        run.events.forEach((event, index) => {
          expect(event.page).toBe(index + 1);
          expect(event.items).toBe((run.served[index] as readonly unknown[]).length);
        });
        // A more-pages flag is only false on the last event, or on none at all.
        expect(run.events.slice(0, -1).every((event) => event.hasMore)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('conserves items across a run whose pages are all non-empty', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 8 }), (counts) => {
        const steps: Step[] = counts.map((items) => ({ items, next: 'advance' }));
        const run = drive({
          mode: 'cursor',
          declaredMaxPages: counts.length,
          limit: 2,
          steps,
          tail: { items: 0, next: 'none' },
        });

        expect(run.requests).toBe(counts.length);
        expect(run.result.items).toEqual(counts.flatMap((count, page) =>
          Array.from({ length: count }, (_, index) => `p${page + 1}-i${index}`),
        ));
      }),
    );
  });
});
