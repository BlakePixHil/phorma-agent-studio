/**
 * Unit tests for the paginated fetch surface (design §5.1.3, P1-7).
 *
 * Table-driven examples for `maxPages` resolution, the first-page cursor of each
 * mode, item accumulation at `itemsPath`, the cursor advance of all four looping
 * modes and the three ways the loop stops: an exhausted response, a server that
 * keeps handing back a position already requested, and the page cap. The
 * property test for termination and item conservation is task 12.4.
 */

import { describe, expect, it } from 'vitest';
import {
  buildDataRequest,
  createPaginationLoop,
  cursorKey,
  DEFAULT_MAX_PAGES,
  initialCursor,
  isPaginated,
  maxPagesOf,
  nextCursorFrom,
  pageItems,
  parseLinkHeader,
  type CursorState,
} from './data-http.js';
import type { HttpRequestNodeData, PaginationConfig, WorkflowNode } from './types.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const cursorMode = (over: Partial<Extract<PaginationConfig, { mode: 'cursor' }>> = {}) =>
  ({
    mode: 'cursor',
    cursorPath: 'meta.next',
    cursorParam: 'cursor',
    itemsPath: 'data',
    maxPages: 10,
    ...over,
  }) satisfies PaginationConfig;

const pageMode = (over: Partial<Extract<PaginationConfig, { mode: 'page' }>> = {}) =>
  ({ mode: 'page', pageParam: 'page', itemsPath: 'data', maxPages: 10, ...over }) satisfies PaginationConfig;

const offsetMode = (over: Partial<Extract<PaginationConfig, { mode: 'offset' }>> = {}) =>
  ({
    mode: 'offset',
    offsetParam: 'offset',
    limitParam: 'limit',
    limit: 2,
    itemsPath: 'data',
    maxPages: 10,
    ...over,
  }) satisfies PaginationConfig;

const linkMode = (over: Partial<Extract<PaginationConfig, { mode: 'link-header' }>> = {}) =>
  ({ mode: 'link-header', itemsPath: 'data', maxPages: 10, ...over }) satisfies PaginationConfig;

function httpNode(data: Partial<HttpRequestNodeData>): WorkflowNode {
  return {
    id: 'node-1',
    name: 'Call API',
    kind: 'http-request',
    category: 'flow',
    icon: 'ti ti-api',
    position: { x: 0, y: 0 },
    ports: [],
    data: { method: 'GET', url: 'https://api.example.com/things', ...data } as HttpRequestNodeData,
  };
}

// ── mode vocabulary and page cap (9.1, 9.2, 9.12) ───────────────────────────

describe('isPaginated', () => {
  it('treats an absent configuration and mode none as a single request', () => {
    expect(isPaginated(undefined)).toBe(false);
    expect(isPaginated({ mode: 'none' })).toBe(false);
    expect(maxPagesOf(undefined)).toBe(1);
    expect(maxPagesOf({ mode: 'none' })).toBe(1);
  });

  it.each([cursorMode(), pageMode(), offsetMode(), linkMode()])('accepts mode $mode', (pagination) => {
    expect(isPaginated(pagination)).toBe(true);
  });

  it('rejects an unknown mode rather than looping on it', () => {
    expect(isPaginated({ mode: 'keyset' } as unknown as PaginationConfig)).toBe(false);
  });
});

describe('maxPagesOf', () => {
  const cases: [unknown, number][] = [
    [1, 1],
    [200, 200],
    [1000, 1000],
    [0, DEFAULT_MAX_PAGES],
    [-5, DEFAULT_MAX_PAGES],
    [1001, DEFAULT_MAX_PAGES],
    [2.5, DEFAULT_MAX_PAGES],
    [undefined, DEFAULT_MAX_PAGES],
    ['50', DEFAULT_MAX_PAGES],
  ];

  it.each(cases)('resolves maxPages %s to %i', (declared, expected) => {
    expect(maxPagesOf(cursorMode({ maxPages: declared as number }))).toBe(expected);
  });
});

// ── first-page cursor (9.13) ────────────────────────────────────────────────

describe('initialCursor', () => {
  it('sends no cursor parameter on the first page of mode cursor', () => {
    expect(initialCursor(cursorMode())).toBeUndefined();
  });

  it('has no url to follow on the first page of mode link-header', () => {
    expect(initialCursor(linkMode())).toBeUndefined();
  });

  it('starts mode page at startPage when set and at 1 otherwise', () => {
    expect(initialCursor(pageMode())).toEqual({ mode: 'page', pageParam: 'page', page: 1 });
    expect(initialCursor(pageMode({ startPage: 7, sizeParam: 'per_page', pageSize: 50 }))).toEqual({
      mode: 'page',
      pageParam: 'page',
      page: 7,
      sizeParam: 'per_page',
      pageSize: 50,
    });
  });

  it('starts mode offset at 0 and carries the limit', () => {
    expect(initialCursor(offsetMode({ limit: 25 }))).toEqual({
      mode: 'offset',
      offsetParam: 'offset',
      offset: 0,
      limitParam: 'limit',
      limit: 25,
    });
  });
});

describe('buildDataRequest with a pagination cursor', () => {
  it('omits the cursor parameter on the first page and sends it on a later page', () => {
    const node = httpNode({ url: 'https://api.example.com/jobs' });
    expect(buildDataRequest(node, '', undefined, initialCursor(cursorMode())).url).toBe(
      'https://api.example.com/jobs',
    );
    const next = nextCursorFrom(cursorMode(), { meta: { next: 'c2' } }, undefined, undefined);
    expect(buildDataRequest(node, '', undefined, next).url).toBe('https://api.example.com/jobs?cursor=c2');
  });

  it('sends page and size parameters after the configured query entries', () => {
    const node = httpNode({ url: 'https://api.example.com/jobs', query: [{ key: 'since', value: '2026-01-01' }] });
    const cursor = initialCursor(pageMode({ startPage: 2, sizeParam: 'per_page', pageSize: 100 }));
    expect(buildDataRequest(node, '', undefined, cursor).url).toBe(
      'https://api.example.com/jobs?since=2026-01-01&page=2&per_page=100',
    );
  });

  it('sends offset and limit on every page of mode offset', () => {
    const node = httpNode({ url: 'https://api.example.com/jobs' });
    expect(buildDataRequest(node, '', undefined, initialCursor(offsetMode({ limit: 50 }))).url).toBe(
      'https://api.example.com/jobs?offset=0&limit=50',
    );
  });

  it('requests the server link verbatim for mode link-header', () => {
    const cursor: CursorState = { mode: 'link-header', url: 'https://api.example.com/jobs?page=2&per=50' };
    expect(buildDataRequest(httpNode({ url: 'https://api.example.com/jobs' }), '', undefined, cursor).url).toBe(
      'https://api.example.com/jobs?page=2&per=50',
    );
  });
});

// ── item accumulation (9.3) ─────────────────────────────────────────────────

describe('pageItems', () => {
  it('resolves the array at itemsPath', () => {
    expect(pageItems(cursorMode({ itemsPath: 'payload.rows' }), { payload: { rows: [1, 2] } })).toEqual([1, 2]);
  });

  it.each([
    ['absent', {}],
    ['null', { data: null }],
  ])('counts an %s value at itemsPath as zero items', (_label, parsed) => {
    expect(pageItems(cursorMode(), parsed)).toEqual([]);
  });

  it.each([
    ['an object', { data: { id: 1 } }],
    ['a string', { data: 'nope' }],
    ['a number', { data: 3 }],
  ])('fails naming itemsPath when the path resolves to %s', (_label, parsed) => {
    expect(() => pageItems(cursorMode(), parsed)).toThrow(/itemsPath "data"/);
  });
});

// ── cursor advance (9.5, 9.6, 9.13) ─────────────────────────────────────────

describe('nextCursorFrom mode cursor', () => {
  it('advances to the value at cursorPath', () => {
    expect(nextCursorFrom(cursorMode(), { meta: { next: 'abc' }, data: [1] }, undefined, undefined)).toEqual({
      mode: 'cursor',
      param: 'cursor',
      value: 'abc',
    });
  });

  it('accepts a numeric cursor', () => {
    expect(nextCursorFrom(cursorMode(), { meta: { next: 42 } }, undefined, undefined)).toEqual({
      mode: 'cursor',
      param: 'cursor',
      value: '42',
    });
  });

  it.each([
    ['absent', {}],
    ['null', { meta: { next: null } }],
    ['empty', { meta: { next: '  ' } }],
    ['structural', { meta: { next: { id: 1 } } }],
  ])('stops on a %s cursor value', (_label, parsed) => {
    expect(nextCursorFrom(cursorMode(), parsed, undefined, undefined)).toBeUndefined();
  });
});

describe('nextCursorFrom mode page', () => {
  it('increases the page by one while pages yield items', () => {
    const current = initialCursor(pageMode({ startPage: 3, sizeParam: 'per_page', pageSize: 20 }));
    expect(nextCursorFrom(pageMode({ startPage: 3, sizeParam: 'per_page', pageSize: 20 }), { data: [1] }, undefined, current)).toEqual({
      mode: 'page',
      pageParam: 'page',
      page: 4,
      sizeParam: 'per_page',
      pageSize: 20,
    });
  });

  it('treats a page yielding zero items as the final page', () => {
    expect(nextCursorFrom(pageMode(), { data: [] }, undefined, initialCursor(pageMode()))).toBeUndefined();
  });
});

describe('nextCursorFrom mode offset', () => {
  it('advances the offset by the limit on a full page', () => {
    expect(nextCursorFrom(offsetMode({ limit: 2 }), { data: [1, 2] }, undefined, initialCursor(offsetMode({ limit: 2 })))).toEqual(
      { mode: 'offset', offsetParam: 'offset', offset: 2, limitParam: 'limit', limit: 2 },
    );
  });

  it('treats a short page as the final page', () => {
    expect(
      nextCursorFrom(offsetMode({ limit: 3 }), { data: [1, 2] }, undefined, initialCursor(offsetMode({ limit: 3 }))),
    ).toBeUndefined();
  });
});

describe('parseLinkHeader', () => {
  it('follows rel=next by default', () => {
    const header = '<https://api.example.com/jobs?page=3>; rel="next", <https://api.example.com/jobs?page=1>; rel="first"';
    expect(parseLinkHeader(header)).toBe('https://api.example.com/jobs?page=3');
  });

  it('honours a configured rel and matches it case-insensitively', () => {
    const header = '<https://api.example.com/jobs?page=9>; rel="LAST"';
    expect(parseLinkHeader(header, 'last')).toBe('https://api.example.com/jobs?page=9');
  });

  it('keeps a comma inside the url and inside a quoted parameter', () => {
    const header = '<https://api.example.com/jobs?ids=1,2,3>; rel="next"; title="a,b"';
    expect(parseLinkHeader(header)).toBe('https://api.example.com/jobs?ids=1,2,3');
  });

  it.each([
    ['absent', undefined],
    ['empty', '   '],
    ['relation-less', '<https://api.example.com/jobs?page=2>'],
    ['other relations only', '<https://api.example.com/jobs?page=1>; rel="prev"'],
  ])('returns no url for a %s header', (_label, header) => {
    expect(parseLinkHeader(header as string | undefined)).toBeUndefined();
  });

  it('reads the link header case-insensitively through nextCursorFrom', () => {
    const headers = { Link: '<https://api.example.com/jobs?page=2>; rel="next"' };
    expect(nextCursorFrom(linkMode(), { data: [1] }, headers, undefined)).toEqual({
      mode: 'link-header',
      url: 'https://api.example.com/jobs?page=2',
    });
  });
});

describe('cursorKey', () => {
  it('gives the start position and every mode a distinct identity', () => {
    const keys = [
      cursorKey(undefined),
      cursorKey({ mode: 'cursor', param: 'cursor', value: 'a' }),
      cursorKey({ mode: 'page', pageParam: 'page', page: 2 }),
      cursorKey({ mode: 'offset', offsetParam: 'offset', offset: 2, limitParam: 'limit', limit: 2 }),
      cursorKey({ mode: 'link-header', url: 'https://api.example.com/jobs?page=2' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives two cursors addressing the same page the same identity', () => {
    expect(cursorKey({ mode: 'cursor', param: 'cursor', value: 'a' })).toBe(
      cursorKey({ mode: 'cursor', param: 'cursor', value: 'a' }),
    );
  });
});

// ── the loop (9.2, 9.4, 9.5, 9.7, 9.12, 9.14) ───────────────────────────────

describe('createPaginationLoop', () => {
  it('accumulates items in fetch order and reports the completed page count', () => {
    const loop = createPaginationLoop(cursorMode());
    const events = [
      loop.accept({ data: [1, 2], meta: { next: 'c2' } }),
      loop.accept({ data: [3], meta: { next: 'c3' } }),
      loop.accept({ data: [4, 5], meta: {} }),
    ];

    expect(events.map((outcome) => outcome.event)).toEqual([
      { page: 1, items: 2, hasMore: true },
      { page: 2, items: 1, hasMore: true },
      { page: 3, items: 2, hasMore: false },
    ]);
    expect(loop.result()).toEqual({ items: [1, 2, 3, 4, 5], pages: 3 });
    expect(loop.canRequest()).toBe(false);
    expect(loop.done).toBe(true);
  });

  it('hands the next cursor to the following request', () => {
    const loop = createPaginationLoop(cursorMode());
    expect(loop.cursor).toBeUndefined();
    loop.accept({ data: [1], meta: { next: 'c2' } });
    expect(loop.cursor).toEqual({ mode: 'cursor', param: 'cursor', value: 'c2' });
    expect(loop.canRequest()).toBe(true);
  });

  it('counts an empty page and keeps looping while a cursor advances', () => {
    const loop = createPaginationLoop(cursorMode());
    expect(loop.accept({ data: [], meta: { next: 'c2' } }).event).toEqual({ page: 1, items: 0, hasMore: true });
    loop.accept({ data: [7], meta: {} });
    expect(loop.result()).toEqual({ items: [7], pages: 2 });
  });

  it('stops on a server that keeps handing back the position it just served', () => {
    const loop = createPaginationLoop(cursorMode());
    loop.accept({ data: [1], meta: { next: 'stuck' } });
    const second = loop.accept({ data: [2], meta: { next: 'stuck' } });

    expect(second.event).toEqual({ page: 2, items: 1, hasMore: true });
    expect(second.nextCursor).toBeUndefined();
    expect(second.done).toBe(true);
    expect(loop.canRequest()).toBe(false);
    expect(loop.result()).toEqual({ items: [1, 2], pages: 2 });
  });

  it('retains every accumulated item when the loop stops', () => {
    const loop = createPaginationLoop(pageMode());
    loop.accept({ data: ['a'] });
    loop.accept({ data: [] });
    expect(loop.result()).toEqual({ items: ['a'], pages: 2 });
    expect(() => loop.accept({ data: ['b'] })).toThrow(/already stopped/);
  });

  it('issues at most maxPages requests and still reports that data remained', () => {
    const loop = createPaginationLoop(cursorMode({ maxPages: 2 }));
    expect(loop.maxPages).toBe(2);
    loop.accept({ data: [1], meta: { next: 'c2' } });
    const final = loop.accept({ data: [2], meta: { next: 'c3' } });

    expect(final.event).toEqual({ page: 2, items: 1, hasMore: true });
    expect(final.done).toBe(true);
    expect(loop.canRequest()).toBe(false);
    expect(loop.result()).toEqual({ items: [1, 2], pages: 2 });
  });

  it('follows the link header until the server stops offering one', () => {
    const loop = createPaginationLoop(linkMode());
    loop.accept({ data: [1] }, { link: '<https://api.example.com/jobs?page=2>; rel="next"' });
    expect(loop.cursor).toEqual({ mode: 'link-header', url: 'https://api.example.com/jobs?page=2' });
    loop.accept({ data: [2] }, { link: '<https://api.example.com/jobs?page=1>; rel="prev"' });
    expect(loop.done).toBe(true);
    expect(loop.result()).toEqual({ items: [1, 2], pages: 2 });
  });

  it('walks offset pages until a short page arrives', () => {
    const loop = createPaginationLoop(offsetMode({ limit: 2 }));
    loop.accept({ data: [1, 2] });
    expect(loop.cursor).toEqual({ mode: 'offset', offsetParam: 'offset', offset: 2, limitParam: 'limit', limit: 2 });
    loop.accept({ data: [3] });
    expect(loop.result()).toEqual({ items: [1, 2, 3], pages: 2 });
  });

  it('fails the node when a page resolves itemsPath to a non-array', () => {
    const loop = createPaginationLoop(cursorMode());
    expect(() => loop.accept({ data: { id: 1 } })).toThrow(/itemsPath "data"/);
  });

  it('allows exactly one request and accumulates nothing for mode none', () => {
    const loop = createPaginationLoop({ mode: 'none' });
    expect(loop.maxPages).toBe(1);
    expect(loop.canRequest()).toBe(true);
    expect(loop.cursor).toBeUndefined();
    expect(() => loop.accept({ data: [1] })).toThrow(/not paginated/);
    expect(loop.result()).toEqual({ items: [], pages: 0 });
  });
});
