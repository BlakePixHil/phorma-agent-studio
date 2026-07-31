/**
 * Unit tests for the `http-request` executor as the engine actually runs it
 * (design §5.1, §8.3).
 *
 * Every case drives `startRun` over a two-or-three node graph with a SCRIPTED
 * `DataFetcher`: one entry per expected call, so an extra request fails the run
 * loudly instead of silently passing. Nothing here mocks the engine — the
 * pagination loop, the fixture state machine, the retry wrapper and the
 * idempotency claim are the real ones, wired through the real host capability
 * contracts.
 *
 * The pure-function suites for the same surface live in `data-http-request`,
 * `data-http-pagination` and `fixtures`; this file covers only what needs a run.
 */

import { describe, expect, it } from 'vitest';

import type { DataFetcher, DataRequest, DataResponse, FixtureStore } from './data-host.js';
import { DataTransportError, type TransportFailureKind } from './data-host.js';
import { DEFAULT_MAX_RESPONSE_BYTES } from './data-http.js';
import { startRun } from './engine.js';
import type { RunEvent } from './events.js';
import type { ModelClient } from './model.js';
import { claimIdempotent, idempotencyStateKey, scopedStateKey } from './state.js';
import { MemoryStateStore } from './test/memory-state-store.js';
import type {
  HttpRequestNodeData,
  PaginationConfig,
  WorkflowGraph,
  WorkflowNode,
} from './types.js';

// ── harness ─────────────────────────────────────────────────────────────────

const WORKFLOW_ID = 'wf-1';
const RUN_ID = 'run-1';

const NEVER_CALLED_MODEL: ModelClient = {
  async *stream() {
    throw new Error('No model call is expected in these scripted runs.');
  },
};

/** Node data plus the response cap the engine reads off the node (8.18). */
type HttpData = Partial<HttpRequestNodeData> & { maxResponseBytes?: number };

/** One scripted answer: a (partial) response, or a rejection to throw. */
type ScriptStep = Partial<DataResponse> | Error;

interface ScriptedFetcher {
  readonly fetch: DataFetcher;
  /** Every request the engine issued, in order. */
  readonly requests: DataRequest[];
}

/** A 200 with a JSON body, byte-counted the way a host would report it. */
function ok(body: string, over: Partial<DataResponse> = {}): Partial<DataResponse> {
  return { status: 200, headers: {}, body, byteCount: body.length, durationMs: 7, ...over };
}

/**
 * A fetcher that answers from `script` in order. A call past the end of the
 * script rejects, so "issues at most N requests" is checked by construction.
 */
function scripted(script: readonly ScriptStep[]): ScriptedFetcher {
  const requests: DataRequest[] = [];
  let index = 0;
  return {
    requests,
    fetch: async (request: DataRequest): Promise<DataResponse> => {
      requests.push(request);
      const step = script[index++];
      if (step === undefined) {
        throw new Error(`Unscripted request ${index} to ${request.url}.`);
      }
      if (step instanceof Error) throw step;
      return {
        status: 200,
        headers: {},
        body: '',
        byteCount: 0,
        durationMs: 0,
        ...step,
      };
    },
  };
}

/** A fetcher that fails the run if it is called at all. */
function neverCalled(): ScriptedFetcher {
  return scripted([]);
}

/** In-memory `FixtureStore` that counts what the engine asked of it. */
class MemoryFixtureStore implements FixtureStore {
  readonly entries = new Map<string, string>();
  reads = 0;
  writes = 0;

  async read(key: string): Promise<string | undefined> {
    this.reads++;
    return this.entries.get(key);
  }

  async write(key: string, value: string): Promise<void> {
    this.writes++;
    this.entries.set(key, value);
  }
}

function port(id: string, role: 'message-in' | 'message-out') {
  return { id, name: id, role };
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
 * A pass-through node used as a downstream marker. `router` with a single
 * out-port always matches that port and returns the payload byte-identically
 * (unlike `transform`, which requires at least one field to execute at all).
 */
function passThrough(id: string): WorkflowNode {
  return {
    id,
    name: id,
    kind: 'router',
    category: 'data',
    icon: 'pi-sliders-h',
    position: { x: 400, y: 0 },
    ports: [port(`${id}-in-1`, 'message-in'), port(`${id}-out-1`, 'message-out')],
    data: {},
  };
}

function httpNode(data: HttpData, wireError: boolean): WorkflowNode {
  return {
    id: 'http-1',
    name: 'Call API',
    kind: 'http-request',
    category: 'data',
    icon: 'ti ti-api',
    position: { x: 200, y: 0 },
    ports: [
      port('http-1-in-1', 'message-in'),
      port('http-1-out-1', 'message-out'),
      port('http-1-err-1', 'message-out'),
    ],
    data: {
      method: 'GET',
      url: 'https://api.example.com/things',
      ...(wireError ? { errorPortId: 'http-1-err-1' } : {}),
      ...data,
    } as HttpRequestNodeData,
  };
}

interface RunSetup {
  readonly data: HttpData;
  readonly fetcher?: ScriptedFetcher;
  readonly input?: string;
  readonly state?: MemoryStateStore;
  readonly fixtures?: FixtureStore;
  /** Wires the node's "On error" port so a failure routes instead of failing. */
  readonly wireError?: boolean;
}

interface RunResult {
  readonly events: RunEvent[];
  readonly requests: DataRequest[];
  /** The http node's outgoing payload, when it completed. */
  readonly output: string | undefined;
  /** The http node's failure message, when it failed. */
  readonly failure: string | undefined;
  /** True when the downstream marker node executed. */
  readonly downstreamRan: boolean;
}

function connect(id: string, outputId: string, inputId: string) {
  return { id, outputId, inputId, kind: 'handoff' as const };
}

function graphFor(setup: RunSetup): WorkflowGraph {
  const wireError = setup.wireError === true;
  const nodes = [trigger(), httpNode(setup.data, wireError), passThrough('next')];
  const connections = [
    connect('c1', 'trigger-out-1', 'http-1-in-1'),
    connect('c2', 'http-1-out-1', 'next-in-1'),
  ];
  if (wireError) {
    nodes.push(passThrough('caught'));
    connections.push(connect('c3', 'http-1-err-1', 'caught-in-1'));
  }
  return { nodes, connections };
}

async function runHttp(setup: RunSetup): Promise<RunResult> {
  const events: RunEvent[] = [];
  const fetcher = setup.fetcher ?? neverCalled();
  const handle = startRun({
    runId: RUN_ID,
    graph: graphFor(setup),
    input: setup.input ?? '{}',
    workflowId: WORKFLOW_ID,
    model: NEVER_CALLED_MODEL,
    emit: event => events.push(event),
    requestApproval: async () => true,
    requestInput: async () => '',
    dataFetch: fetcher.fetch,
    ...(setup.state ? { state: setup.state } : {}),
    ...(setup.fixtures ? { fixtures: setup.fixtures } : {}),
  });
  await handle.done;

  const completed = eventsOf(events, 'node-completed').find(event => event.nodeId === 'http-1');
  const failed = eventsOf(events, 'node-failed').find(event => event.nodeId === 'http-1');
  return {
    events,
    requests: fetcher.requests,
    output: completed?.output,
    failure: failed?.error,
    downstreamRan: eventsOf(events, 'node-started').some(event => event.nodeId === 'next'),
  };
}

function eventsOf<T extends RunEvent['type']>(
  events: readonly RunEvent[],
  type: T,
): Extract<RunEvent, { type: T }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

const urlsOf = (requests: readonly DataRequest[]): string[] => requests.map(request => request.url);

const headerOf = (request: DataRequest, name: string): string | undefined =>
  Object.entries(request.headers ?? {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];

// ── success classification (8.11, 8.12) ─────────────────────────────────────

describe('http-request success classification', () => {
  it('accepts a 2xx and emits one request and one response event for the attempt', async () => {
    const fetcher = scripted([ok('{"id":"a1","name":"Widget"}', { byteCount: 27, durationMs: 12 })]);
    const run = await runHttp({ data: {}, fetcher });

    expect(run.output).toBe('{"id":"a1","name":"Widget"}');
    expect(run.downstreamRan).toBe(true);

    const requestEvents = eventsOf(run.events, 'http-request');
    expect(requestEvents).toHaveLength(1);
    expect(requestEvents[0]).toMatchObject({
      nodeId: 'http-1',
      nodeName: 'Call API',
      method: 'GET',
      url: 'https://api.example.com/things',
      attempt: 1,
    });
    // Bodies are opt-in; this node opted out of both.
    expect('body' in requestEvents[0]!).toBe(false);

    const responseEvents = eventsOf(run.events, 'http-response');
    expect(responseEvents).toHaveLength(1);
    expect(responseEvents[0]).toMatchObject({ status: 200, byteCount: 27, durationMs: 12 });
    expect(responseEvents[0]!.truncated).toBeUndefined();
    expect(responseEvents[0]!.replayed).toBeUndefined();
  });

  it.each([
    [200, true],
    [204, true],
    [299, true],
    [199, false],
    [300, false],
  ])('treats status %i as a success: %s', async (status, succeeds) => {
    const body = status === 204 ? '' : '{"ok":true}';
    const run = await runHttp({
      data: {},
      wireError: true,
      fetcher: scripted([ok(body, { status })]),
    });

    if (succeeds) {
      expect(run.failure).toBeUndefined();
      expect(run.output).toBe(status === 204 ? 'null' : '{"ok":true}');
    } else {
      expect(run.failure).toBe(`HTTP ${status}`);
    }
  });

  it('additionally accepts a listed successCode', async () => {
    const run = await runHttp({
      data: { successCodes: [404, 418] },
      fetcher: scripted([ok('{"teapot":true}', { status: 418 })]),
    });
    expect(run.output).toBe('{"teapot":true}');
  });

  it('ignores listed values that are not integers in 100-599', async () => {
    for (const status of [600, 99]) {
      const run = await runHttp({
        data: { successCodes: [600, 99, 404.5] },
        wireError: true,
        fetcher: scripted([ok('{"nope":true}', { status })]),
      });
      expect(run.failure).toBe(`HTTP ${status}`);
    }
  });

  it('honours at most 20 listed successCodes', async () => {
    // 21 codes: the first is honoured, the 21st is past the cap.
    const successCodes = Array.from({ length: 21 }, (_unused, index) => 400 + index);
    const accepted = await runHttp({
      data: { successCodes },
      wireError: true,
      fetcher: scripted([ok('{"first":true}', { status: 400 })]),
    });
    expect(accepted.output).toBe('{"first":true}');

    const rejected = await runHttp({
      data: { successCodes },
      wireError: true,
      fetcher: scripted([ok('{"twentyFirst":true}', { status: 420 })]),
    });
    expect(rejected.failure).toBe('HTTP 420');
  });
});

describe('http-request status failure (8.12)', () => {
  const BODY = `{"error":"${'x'.repeat(2_000)}"}`;

  it('merges no part of the failed response into the payload and routes the failure', async () => {
    const run = await runHttp({
      data: {},
      input: '{"orderId":"o-7"}',
      wireError: true,
      fetcher: scripted([ok(BODY, { status: 500, headers: { 'content-type': 'application/json' } })]),
    });

    expect(run.failure).toBe('HTTP 500');
    expect(run.output).toBeUndefined();
    expect(run.downstreamRan).toBe(false);

    // The "On error" branch carries the failure and the UNCHANGED input.
    const routed = eventsOf(run.events, 'node-error-routed');
    expect(routed).toHaveLength(1);
    expect(routed[0]!.error).toBe('HTTP 500');

    const caught = eventsOf(run.events, 'node-completed').find(event => event.nodeId === 'caught');
    expect(caught).toBeDefined();
    const errorPayload = JSON.parse(caught!.output) as { error: string; input: string };
    expect(errorPayload.input).toBe('{"orderId":"o-7"}');
    expect(errorPayload.error).toBe('HTTP 500');
    // The response body never reaches the trace through the failure message.
    expect(caught!.output).not.toContain('xxxx');
  });

  it('fails the run when no error port is wired', async () => {
    const run = await runHttp({
      data: {},
      fetcher: scripted([ok('{}', { status: 503 })]),
    });
    expect(run.failure).toBe('HTTP 503');
    expect(eventsOf(run.events, 'run-failed')).toHaveLength(1);
  });
});

// ── rate limiting and transport failures (retry wiring, 8.8) ────────────────

describe('http-request retry wiring', () => {
  it('honours Retry-After on a 429 and resends the identical idempotency key', async () => {
    const fetcher = scripted([
      ok('{"error":"slow down"}', { status: 429, headers: { 'retry-after': '120' } }),
      ok('{"id":"ok"}'),
    ]);
    const run = await runHttp({
      data: {
        method: 'POST',
        bodyMode: 'json',
        body: '{"id":"{{orderId}}"}',
        idempotencyKey: '  order-{{orderId}}  ',
        // A tiny ceiling keeps the honoured delay honest and the test fast.
        retry: { maxAttempts: 2, backoffMs: 0, idempotent: true, maxRetryAfterMs: 5 },
      },
      input: '{"orderId":"o-9"}',
      fetcher,
    });

    expect(run.output).toBe('{"id":"ok"}');
    expect(fetcher.requests).toHaveLength(2);

    const retries = eventsOf(run.events, 'node-retrying');
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ attempt: 1, maxAttempts: 2, delayMs: 5 });
    expect(retries[0]!.error).toBe('HTTP 429 (retry reason: retry-after)');

    // One `http-request` event per attempt, numbered from 1 (8.9).
    expect(eventsOf(run.events, 'http-request').map(event => event.attempt)).toEqual([1, 2]);
    expect(eventsOf(run.events, 'http-response').map(event => event.status)).toEqual([429, 200]);

    // Trimmed, capped and byte-identical on the retry (8.8).
    const keys = fetcher.requests.map(request => headerOf(request, 'idempotency-key'));
    expect(keys).toEqual(['order-o-9', 'order-o-9']);
  });

  it.each<[TransportFailureKind, number]>([
    ['connect', 2],
    ['dns', 2],
    ['tls', 2],
    ['timeout', 1],
    ['aborted', 1],
    ['unknown', 1],
  ])(
    'a %s failure gives a non-idempotent step %i attempt(s)',
    async (kind, expectedAttempts) => {
      const fetcher = scripted([
        new DataTransportError(kind, `${kind} failed`),
        ok('{"recovered":true}'),
      ]);
      const run = await runHttp({
        data: { retry: { maxAttempts: 2, backoffMs: 0 } },
        wireError: true,
        fetcher,
      });

      expect(fetcher.requests).toHaveLength(expectedAttempts);
      if (expectedAttempts === 2) {
        expect(run.output).toBe('{"recovered":true}');
      } else {
        // The request may have landed, so it is never repeated (11.4).
        expect(run.failure).toBe(`${kind} failed`);
      }
    },
  );

  it('retries every transport kind for a step declared idempotent', async () => {
    const fetcher = scripted([
      new DataTransportError('timeout', 'took too long'),
      ok('{"recovered":true}'),
    ]);
    const run = await runHttp({
      data: { retry: { maxAttempts: 2, backoffMs: 0, idempotent: true } },
      fetcher,
    });

    expect(fetcher.requests).toHaveLength(2);
    expect(run.output).toBe('{"recovered":true}');
    expect(eventsOf(run.events, 'node-retrying')[0]!.error).toBe(
      'timeout: took too long (retry reason: transport)',
    );
    // A rejected attempt produced no response, so no `http-response` for it.
    expect(eventsOf(run.events, 'http-request')).toHaveLength(2);
    expect(eventsOf(run.events, 'http-response')).toHaveLength(1);
  });
});

// ── the response byte cap and truncation (8.18) ─────────────────────────────

describe('http-request response byte cap', () => {
  it('passes the 4 MiB default cap to the fetcher when the node declares none', async () => {
    const fetcher = scripted([ok('{"ok":true}')]);
    await runHttp({ data: {}, fetcher });
    expect(fetcher.requests[0]!.maxResponseBytes).toBe(DEFAULT_MAX_RESPONSE_BYTES);
    expect(DEFAULT_MAX_RESPONSE_BYTES).toBe(4_194_304);
  });

  it('passes a node-declared cap to the fetcher', async () => {
    const fetcher = scripted([ok('{"ok":true}')]);
    await runHttp({ data: { maxResponseBytes: 1_024 }, fetcher });
    expect(fetcher.requests[0]!.maxResponseBytes).toBe(1_024);
  });

  it('reports the retained byte count and the truncation flag on the response event', async () => {
    const body = '{"items":[1,2,3]}';
    const run = await runHttp({
      data: { maxResponseBytes: 17 },
      fetcher: scripted([ok(body, { truncated: true, byteCount: 17 })]),
    });

    const response = eventsOf(run.events, 'http-response')[0]!;
    expect(response.truncated).toBe(true);
    expect(response.byteCount).toBe(17);
    expect(run.output).toBe('{"items":[1,2,3]}');
  });

  it('fails the node when truncation left the body unparseable, saying it was truncated', async () => {
    const run = await runHttp({
      data: { maxResponseBytes: 12 },
      wireError: true,
      fetcher: scripted([ok('{"items":[1,2', { truncated: true, byteCount: 13 })]),
    });

    expect(run.failure).toMatch(/not valid JSON/);
    expect(run.failure).toMatch(/truncated at the response byte cap/);
    expect(run.downstreamRan).toBe(false);
  });

  it('keeps a truncated body usable in text mode', async () => {
    const run = await runHttp({
      data: { responseMode: 'text', maxResponseBytes: 5 },
      fetcher: scripted([ok('{"ite', { truncated: true, byteCount: 5 })]),
    });
    expect(run.output).toBe('"{\\"ite"');
  });
});

// ── the five pagination modes (9.13, 9.12, 9.14) ────────────────────────────

const CURSOR: PaginationConfig = {
  mode: 'cursor',
  cursorPath: 'meta.next',
  cursorParam: 'cursor',
  itemsPath: 'data',
  maxPages: 10,
};

describe('http-request pagination mode none (9.12)', () => {
  it('issues exactly one request, accumulates nothing and emits no page-fetched', async () => {
    const fetcher = scripted([ok('{"data":{"id":"a1"},"meta":{"next":"c2"}}')]);
    const run = await runHttp({ data: { resultPath: 'data' }, fetcher });

    expect(fetcher.requests).toHaveLength(1);
    expect(eventsOf(run.events, 'page-fetched')).toHaveLength(0);
    expect(run.output).toBe('{"id":"a1"}');
  });

  it('treats an absent pagination configuration and mode none alike', async () => {
    for (const pagination of [undefined, { mode: 'none' } as PaginationConfig]) {
      const fetcher = scripted([ok('{"data":[1,2]}')]);
      const run = await runHttp({ data: { pagination }, fetcher });
      expect(fetcher.requests).toHaveLength(1);
      expect(run.output).toBe('{"data":[1,2]}');
      expect(eventsOf(run.events, 'page-fetched')).toHaveLength(0);
    }
  });
});

describe('http-request pagination mode cursor (9.13)', () => {
  it('sends no cursor on the first page and the resolved cursor on every later page', async () => {
    const fetcher = scripted([
      ok('{"data":[1,2],"meta":{"next":"c2"}}'),
      ok('{"data":[3],"meta":{"next":"c3"}}'),
      ok('{"data":[4],"meta":{}}'),
    ]);
    const run = await runHttp({
      data: { url: 'https://api.example.com/jobs', pagination: CURSOR },
      fetcher,
    });

    expect(urlsOf(fetcher.requests)).toEqual([
      'https://api.example.com/jobs',
      'https://api.example.com/jobs?cursor=c2',
      'https://api.example.com/jobs?cursor=c3',
    ]);
    expect(
      eventsOf(run.events, 'page-fetched').map(({ page, items, hasMore }) => ({ page, items, hasMore })),
    ).toEqual([
      { page: 1, items: 2, hasMore: true },
      { page: 2, items: 1, hasMore: true },
      { page: 3, items: 1, hasMore: false },
    ]);
    expect(run.output).toBe('{"items":[1,2,3,4],"pages":3}');
  });

  it('stops at maxPages and still reports that data remained', async () => {
    const fetcher = scripted([
      ok('{"data":[1],"meta":{"next":"c2"}}'),
      ok('{"data":[2],"meta":{"next":"c3"}}'),
    ]);
    const run = await runHttp({
      data: {
        url: 'https://api.example.com/jobs',
        pagination: { ...CURSOR, maxPages: 2 },
      },
      fetcher,
    });

    expect(fetcher.requests).toHaveLength(2);
    expect(eventsOf(run.events, 'page-fetched').at(-1)).toMatchObject({ page: 2, hasMore: true });
    expect(run.output).toBe('{"items":[1,2],"pages":2}');
  });
});

describe('http-request pagination mode page (9.13)', () => {
  it('starts at startPage and increases the page by one per later request', async () => {
    const fetcher = scripted([ok('{"data":[1,2]}'), ok('{"data":[3,4]}'), ok('{"data":[]}')]);
    const run = await runHttp({
      data: {
        url: 'https://api.example.com/jobs',
        pagination: {
          mode: 'page',
          pageParam: 'page',
          sizeParam: 'per_page',
          pageSize: 2,
          startPage: 2,
          itemsPath: 'data',
          maxPages: 10,
        },
      },
      fetcher,
    });

    expect(urlsOf(fetcher.requests)).toEqual([
      'https://api.example.com/jobs?page=2&per_page=2',
      'https://api.example.com/jobs?page=3&per_page=2',
      'https://api.example.com/jobs?page=4&per_page=2',
    ]);
    // A page yielding zero items is the final page (9.6).
    expect(eventsOf(run.events, 'page-fetched').at(-1)).toMatchObject({
      page: 3,
      items: 0,
      hasMore: false,
    });
    expect(run.output).toBe('{"items":[1,2,3,4],"pages":3}');
  });

  it('defaults the first page to 1 when startPage is absent', async () => {
    const fetcher = scripted([ok('{"data":[]}')]);
    await runHttp({
      data: {
        url: 'https://api.example.com/jobs',
        pagination: { mode: 'page', pageParam: 'page', itemsPath: 'data', maxPages: 10 },
      },
      fetcher,
    });
    expect(urlsOf(fetcher.requests)).toEqual(['https://api.example.com/jobs?page=1']);
  });
});

describe('http-request pagination mode offset (9.13)', () => {
  it('starts at offset 0 and advances by the limit while pages are full', async () => {
    const fetcher = scripted([ok('{"data":[1,2]}'), ok('{"data":[3]}')]);
    const run = await runHttp({
      data: {
        url: 'https://api.example.com/jobs',
        pagination: {
          mode: 'offset',
          offsetParam: 'offset',
          limitParam: 'limit',
          limit: 2,
          itemsPath: 'data',
          maxPages: 10,
        },
      },
      fetcher,
    });

    expect(urlsOf(fetcher.requests)).toEqual([
      'https://api.example.com/jobs?offset=0&limit=2',
      'https://api.example.com/jobs?offset=2&limit=2',
    ]);
    // A short page is the final page (9.6).
    expect(run.output).toBe('{"items":[1,2,3],"pages":2}');
  });
});

describe('http-request pagination mode link-header (9.13)', () => {
  it('requests the url of the matching link relation verbatim', async () => {
    const fetcher = scripted([
      ok('{"data":[1]}', {
        headers: { link: '<https://api.example.com/jobs?page=2&per=1>; rel="next"' },
      }),
      ok('{"data":[2]}', {
        headers: { link: '<https://api.example.com/jobs?page=1>; rel="prev"' },
      }),
    ]);
    const run = await runHttp({
      data: {
        url: 'https://api.example.com/jobs',
        pagination: { mode: 'link-header', itemsPath: 'data', maxPages: 10 },
      },
      fetcher,
    });

    expect(urlsOf(fetcher.requests)).toEqual([
      'https://api.example.com/jobs',
      'https://api.example.com/jobs?page=2&per=1',
    ]);
    expect(run.output).toBe('{"items":[1,2],"pages":2}');
  });

  it('follows a configured relation instead of next', async () => {
    const fetcher = scripted([
      ok('{"data":[1]}', {
        headers: { Link: '<https://api.example.com/jobs?page=9>; rel="LAST"' },
      }),
      ok('{"data":[2]}'),
    ]);
    await runHttp({
      data: {
        url: 'https://api.example.com/jobs',
        pagination: { mode: 'link-header', rel: 'last', itemsPath: 'data', maxPages: 10 },
      },
      fetcher,
    });
    expect(urlsOf(fetcher.requests)).toEqual([
      'https://api.example.com/jobs',
      'https://api.example.com/jobs?page=9',
    ]);
  });

});

describe('http-request paginated result selection (9.14)', () => {
  it('applies resultPath and resultKey to the accumulated payload', async () => {
    const fetcher = scripted([ok('{"data":[1,2],"meta":{}}')]);
    const run = await runHttp({
      data: {
        url: 'https://api.example.com/jobs',
        pagination: CURSOR,
        resultPath: 'items',
        resultKey: 'rows',
      },
      input: '{"tenant":"acme"}',
      fetcher,
    });
    expect(run.output).toBe('{"tenant":"acme","rows":[1,2]}');
  });
});

// ── the four fixture modes (16.5, 16.7, 16.8) ───────────────────────────────

describe('http-request fixtures', () => {
  const INPUT = '{"tenant":"acme"}';

  it('mode off performs the real call with no fixture read and no fixture write', async () => {
    const store = new MemoryFixtureStore();
    const fetcher = scripted([ok('{"live":true}')]);
    const run = await runHttp({ data: { fixtures: 'off' }, input: INPUT, fixtures: store, fetcher });

    expect(run.output).toBe('{"live":true}');
    expect(store.reads).toBe(0);
    expect(store.writes).toBe(0);
    expect(store.entries.size).toBe(0);
  });

  it('mode record reads nothing, calls live and stores a fixture that later replays (16.7)', async () => {
    const store = new MemoryFixtureStore();
    const recording = await runHttp({
      data: { fixtures: 'record' },
      input: INPUT,
      fixtures: store,
      fetcher: scripted([ok('{"recorded":1}', { status: 201, byteCount: 15, durationMs: 33 })]),
    });

    expect(store.reads).toBe(0);
    expect(store.writes).toBe(1);
    expect(store.entries.size).toBe(1);
    const recordedResponse = eventsOf(recording.events, 'http-response')[0]!;
    expect(recordedResponse.replayed).toBeUndefined();
    expect(recordedResponse.durationMs).toBe(33);

    // The stored fixture reproduces the response with no call at all (16.5).
    const replay = await runHttp({
      data: { fixtures: 'replay' },
      input: INPUT,
      fixtures: store,
      fetcher: neverCalled(),
    });

    expect(replay.requests).toHaveLength(0);
    expect(replay.output).toBe(recording.output);
    const replayedResponse = eventsOf(replay.events, 'http-response')[0]!;
    expect(replayedResponse).toMatchObject({
      status: 201,
      durationMs: 0,
      byteCount: 15,
      replayed: true,
    });
    // Same event types, in the same order, as the live call (16.9).
    expect(
      replay.events
        .filter(event => event.type === 'http-request' || event.type === 'http-response')
        .map(event => event.type),
    ).toEqual(['http-request', 'http-response']);
  });

  it('mode record overwrites the value already stored at the key', async () => {
    const store = new MemoryFixtureStore();
    await runHttp({
      data: { fixtures: 'record' },
      input: INPUT,
      fixtures: store,
      fetcher: scripted([ok('{"generation":1}')]),
    });
    await runHttp({
      data: { fixtures: 'record' },
      input: INPUT,
      fixtures: store,
      fetcher: scripted([ok('{"generation":2}')]),
    });

    expect(store.entries.size).toBe(1);
    expect(store.reads).toBe(0);
    const replay = await runHttp({
      data: { fixtures: 'replay' },
      input: INPUT,
      fixtures: store,
      fetcher: neverCalled(),
    });
    expect(replay.output).toBe('{"generation":2}');
  });

  it('mode replay fails the node on a miss without calling out or touching the store (16.6)', async () => {
    const store = new MemoryFixtureStore();
    const run = await runHttp({
      data: { fixtures: 'replay' },
      input: INPUT,
      fixtures: store,
      wireError: true,
      fetcher: neverCalled(),
    });

    expect(run.requests).toHaveLength(0);
    expect(run.failure).toMatch(/no recorded fixture/);
    expect(run.failure).toMatch(/record/);
    expect(store.writes).toBe(0);
    expect(store.entries.size).toBe(0);
    // No request was announced for a call that never happened.
    expect(eventsOf(run.events, 'http-request')).toHaveLength(0);
    expect(eventsOf(run.events, 'http-response')).toHaveLength(0);
  });

  it('mode replay-or-record calls once and records on a miss, then replays on a hit (16.8)', async () => {
    const store = new MemoryFixtureStore();
    const miss = await runHttp({
      data: { fixtures: 'replay-or-record' },
      input: INPUT,
      fixtures: store,
      fetcher: scripted([ok('{"first":true}')]),
    });

    expect(miss.requests).toHaveLength(1);
    expect(store.reads).toBe(1);
    expect(store.writes).toBe(1);
    expect(eventsOf(miss.events, 'http-response')[0]!.replayed).toBeUndefined();

    const hit = await runHttp({
      data: { fixtures: 'replay-or-record' },
      input: INPUT,
      fixtures: store,
      fetcher: neverCalled(),
    });

    expect(hit.requests).toHaveLength(0);
    expect(store.reads).toBe(2);
    expect(store.writes).toBe(1);
    expect(hit.output).toBe('{"first":true}');
    expect(eventsOf(hit.events, 'http-response')[0]!.replayed).toBe(true);
  });

  it('records one fixture per page of a paginated fetch and replays every page', async () => {
    const store = new MemoryFixtureStore();
    const recorded = await runHttp({
      data: { url: 'https://api.example.com/jobs', pagination: CURSOR, fixtures: 'record' },
      input: INPUT,
      fixtures: store,
      fetcher: scripted([ok('{"data":[1],"meta":{"next":"c2"}}'), ok('{"data":[2],"meta":{}}')]),
    });

    expect(store.entries.size).toBe(2);
    expect(recorded.output).toBe('{"items":[1,2],"pages":2}');

    const replayed = await runHttp({
      data: { url: 'https://api.example.com/jobs', pagination: CURSOR, fixtures: 'replay' },
      input: INPUT,
      fixtures: store,
      fetcher: neverCalled(),
    });

    expect(replayed.requests).toHaveLength(0);
    expect(replayed.output).toBe('{"items":[1,2],"pages":2}');
    expect(eventsOf(replayed.events, 'http-response').every(event => event.replayed === true)).toBe(
      true,
    );
  });

  it('returns the live response with a warning when the store rejects the write (16.12)', async () => {
    const rejecting: FixtureStore = {
      read: async () => undefined,
      write: async () => {
        throw new Error('quota exceeded');
      },
    };
    const warnings: string[] = [];
    const console = globalThis.console;
    const original = console.warn;
    console.warn = (message?: unknown) => warnings.push(String(message));
    try {
      const run = await runHttp({
        data: { fixtures: 'record' },
        input: INPUT,
        fixtures: rejecting,
        fetcher: scripted([ok('{"live":true}')]),
      });
      expect(run.output).toBe('{"live":true}');
    } finally {
      console.warn = original;
    }
    expect(warnings.some(message => message.includes('quota exceeded'))).toBe(true);
  });
});

// ── the idempotency claim (12.14) ───────────────────────────────────────────

describe('http-request idempotency claim', () => {
  const CLAIM_INPUT = '{"orderId":"o-42"}';
  const WRITE_DATA: HttpData = {
    method: 'POST',
    url: 'https://api.example.com/orders',
    bodyMode: 'json',
    body: '{"id":"{{orderId}}"}',
    idempotencyKey: 'order-{{orderId}}',
  };
  const SCOPED_KEY = scopedStateKey(WORKFLOW_ID, idempotencyStateKey('order-o-42'));

  it('issues the write when it wins the claim', async () => {
    const state = new MemoryStateStore();
    const fetcher = scripted([ok('{"created":true}')]);
    const run = await runHttp({ data: WRITE_DATA, input: CLAIM_INPUT, state, fetcher });

    expect(fetcher.requests).toHaveLength(1);
    expect(headerOf(fetcher.requests[0]!, 'idempotency-key')).toBe('order-o-42');
    expect(run.output).toBe('{"created":true}');
    expect(run.downstreamRan).toBe(true);

    const reads = eventsOf(run.events, 'state-read');
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ nodeId: 'http-1', key: SCOPED_KEY, found: false });
    expect((await state.get(SCOPED_KEY))?.value).toBe('claimed');
  });

  it('performs no write and ends the branch when another owner holds the claim', async () => {
    const state = new MemoryStateStore();
    // Another run got there first.
    expect(await claimIdempotent('order-o-42', state, { workflowId: WORKFLOW_ID })).toBe(true);

    const fetcher = neverCalled();
    const run = await runHttp({ data: WRITE_DATA, input: CLAIM_INPUT, state, fetcher });

    // No outbound call, and nothing announced as if there had been one.
    expect(fetcher.requests).toHaveLength(0);
    expect(eventsOf(run.events, 'http-request')).toHaveLength(0);
    expect(eventsOf(run.events, 'http-response')).toHaveLength(0);

    // The lost claim is visible in the trace, and the payload is untouched.
    const reads = eventsOf(run.events, 'state-read');
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ nodeId: 'http-1', key: SCOPED_KEY, found: true });
    expect(run.failure).toBeUndefined();
    expect(run.output).toBe(CLAIM_INPUT);

    // The branch ends here: no delta hash and no target write can follow.
    expect(run.downstreamRan).toBe(false);
    expect(eventsOf(run.events, 'run-completed')).toHaveLength(1);

    // Exactly one skip, with `considered = changed + skipped` preserved.
    const summary = eventsOf(run.events, 'sync-summary')[0]?.summary;
    expect(summary).toBeDefined();
    expect(summary!.skipped).toBe(1);
    expect(summary!.considered).toBe(1);
    expect(summary!.changed).toBe(0);
    expect(summary!.considered).toBe(summary!.changed + summary!.skipped);
  });

  it('claims once per execution, so a retry re-sends the key it already owns', async () => {
    const state = new MemoryStateStore();
    const fetcher = scripted([
      ok('{"error":"slow down"}', { status: 429, headers: { 'retry-after': '0' } }),
      ok('{"created":true}'),
    ]);
    const run = await runHttp({
      data: {
        ...WRITE_DATA,
        retry: { maxAttempts: 2, backoffMs: 0, idempotent: true, maxRetryAfterMs: 0 },
      },
      input: CLAIM_INPUT,
      state,
      fetcher,
    });

    expect(fetcher.requests).toHaveLength(2);
    expect(run.output).toBe('{"created":true}');
    // One claim for the node execution, not one per attempt.
    expect(eventsOf(run.events, 'state-read')).toHaveLength(1);
    expect(state.writes).toBe(1);
  });

  it('takes no claim when the node renders no idempotency key', async () => {
    const state = new MemoryStateStore();
    const fetcher = scripted([ok('{"created":true}')]);
    const run = await runHttp({
      data: { ...WRITE_DATA, idempotencyKey: '   ' },
      input: CLAIM_INPUT,
      state,
      fetcher,
    });

    expect(fetcher.requests).toHaveLength(1);
    expect(headerOf(fetcher.requests[0]!, 'idempotency-key')).toBeUndefined();
    expect(eventsOf(run.events, 'state-read')).toHaveLength(0);
    expect(state.size).toBe(0);
    expect(run.output).toBe('{"created":true}');
  });
});
