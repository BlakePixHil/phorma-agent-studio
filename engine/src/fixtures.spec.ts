import { describe, expect, it } from 'vitest';
import type { DataResponse, FixtureStore, SqlResult } from './data-host.js';
import {
  FIXTURE_MAX_BYTES,
  createFixtureOccurrences,
  createHttpFixtureSession,
  createSqlFixtureSession,
  fixtureKey,
  httpRequestFingerprint,
  parseHttpFixture,
  resolveFixtureMode,
  serializeHttpFixture,
  sqlRequestFingerprint,
  workflowFixtureKey,
} from './fixtures.js';
import { STATE_NS } from './state.js';

/**
 * Fixture identity and record/replay (Requirements 16.1 to 16.9, 16.11, 16.12).
 * No host, no network: the store is a plain map, or absent.
 */

function memoryStore(seed: Record<string, string> = {}): FixtureStore & { entries: Map<string, string>; writes: number } {
  const entries = new Map<string, string>(Object.entries(seed));
  const store = {
    entries,
    writes: 0,
    async read(key: string) {
      return entries.get(key);
    },
    async write(key: string, value: string) {
      store.writes += 1;
      entries.set(key, value);
    },
  };
  return store;
}

const response: DataResponse = {
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"items":[1,2]}',
  byteCount: 15,
  durationMs: 87,
};

const sqlResult: SqlResult = {
  rows: [{ id: 1 }, { id: 2 }],
  rowCount: 2,
  truncated: true,
  durationMs: 42,
};

const request = {
  method: 'POST',
  url: 'https://api.example.com/v1/orders?limit=10',
  headers: { Authorization: 'Bearer live-token', 'Content-Type': 'application/json' },
  body: '{"a":1}',
};

describe('resolveFixtureMode', () => {
  it('accepts the four modes and treats everything else as off', () => {
    expect(resolveFixtureMode('off')).toBe('off');
    expect(resolveFixtureMode('record')).toBe('record');
    expect(resolveFixtureMode('replay')).toBe('replay');
    expect(resolveFixtureMode('replay-or-record')).toBe('replay-or-record');

    expect(resolveFixtureMode(undefined)).toBe('off');
    expect(resolveFixtureMode('')).toBe('off');
    expect(resolveFixtureMode('Replay')).toBe('off');
    expect(resolveFixtureMode(7)).toBe('off');
  });
});

describe('fixture identity', () => {
  it('is stable across calls and scoped under the fx: namespace', () => {
    const first = workflowFixtureKey('wf-1', 'node-a', '{"x":1}', 0, 'abcd1234');
    const second = workflowFixtureKey('wf-1', 'node-a', '{"x":1}', 0, 'abcd1234');

    expect(first).toBe(second);
    expect(first).toContain(STATE_NS.fixture);
    expect(first.startsWith('wf-1::')).toBe(true);
    expect(fixtureKey('node-a', '{"x":1}', 0, 'abcd1234')).toBe(first.slice('wf-1::'.length));
  });

  it('changes when any one component changes', () => {
    const base = workflowFixtureKey('wf-1', 'node-a', '{"x":1}', 0, 'abcd1234');
    const variants = [
      workflowFixtureKey('wf-2', 'node-a', '{"x":1}', 0, 'abcd1234'),
      workflowFixtureKey('wf-1', 'node-b', '{"x":1}', 0, 'abcd1234'),
      workflowFixtureKey('wf-1', 'node-a', '{"x":2}', 0, 'abcd1234'),
      workflowFixtureKey('wf-1', 'node-a', '{"x":1}', 1, 'abcd1234'),
      workflowFixtureKey('wf-1', 'node-a', '{"x":1}', 0, 'ffff0000'),
    ];

    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it('counts occurrences from zero per node and payload', () => {
    const occurrences = createFixtureOccurrences();

    expect(occurrences.next('node-a', '{}')).toBe(0);
    expect(occurrences.next('node-a', '{}')).toBe(1);
    expect(occurrences.peek('node-a', '{}')).toBe(2);
    expect(occurrences.next('node-a', '{"x":1}')).toBe(0);
    expect(occurrences.next('node-b', '{}')).toBe(0);
  });
});

describe('request fingerprints', () => {
  it('excludes HTTP header values so a rotated credential still matches', () => {
    const rotated = { ...request, headers: { ...request.headers, Authorization: 'Bearer rotated-token' } };

    expect(httpRequestFingerprint(rotated)).toBe(httpRequestFingerprint(request));
  });

  it('is insensitive to header name casing and order, sensitive to method, url and body', () => {
    const reordered = {
      ...request,
      headers: { 'content-TYPE': 'application/json', authorization: 'Bearer live-token' },
    };
    expect(httpRequestFingerprint(reordered)).toBe(httpRequestFingerprint(request));

    const changed = [
      { ...request, method: 'PUT' },
      { ...request, url: `${request.url}&page=2` },
      { ...request, body: '{"a":2}' },
      { ...request, headers: { ...request.headers, 'X-Extra': '1' } },
    ].map(httpRequestFingerprint);

    expect(new Set([httpRequestFingerprint(request), ...changed]).size).toBe(5);
  });

  it('treats an absent body as an empty string', () => {
    const { body: _body, ...withoutBody } = request;

    expect(httpRequestFingerprint(withoutBody)).toBe(httpRequestFingerprint({ ...withoutBody, body: '' }));
  });

  it('ignores SQL parameter key ordering but not values or statement', () => {
    const statement = 'select * from o where id = :id and since > :since';

    expect(sqlRequestFingerprint(statement, { id: 1, since: 'x' })).toBe(
      sqlRequestFingerprint(statement, { since: 'x', id: 1 }),
    );
    expect(sqlRequestFingerprint(statement, { id: 2, since: 'x' })).not.toBe(
      sqlRequestFingerprint(statement, { id: 1, since: 'x' }),
    );
    expect(sqlRequestFingerprint(`${statement} limit 1`, { id: 1, since: 'x' })).not.toBe(
      sqlRequestFingerprint(statement, { id: 1, since: 'x' }),
    );
  });
});

describe('serialisation round trip', () => {
  it('reproduces status, headers, body and truncation with a zero duration', () => {
    const raw = serializeHttpFixture({ ...response, truncated: true });
    const replayed = parseHttpFixture(raw);

    expect(replayed).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"items":[1,2]}',
      byteCount: 15,
      truncated: true,
      durationMs: 0,
    });
  });

  it('rejects text that is not a readable fixture', () => {
    expect(parseHttpFixture('not json')).toBeUndefined();
    expect(parseHttpFixture('[]')).toBeUndefined();
    expect(parseHttpFixture('{"kind":"sql","rows":[]}')).toBeUndefined();
    expect(parseHttpFixture('{"kind":"http","status":"200","body":""}')).toBeUndefined();
  });
});

describe('fixture modes', () => {
  const base = {
    workflowId: 'wf-1',
    nodeId: 'node-a',
    nodeName: 'Fetch orders',
    payload: '{"x":1}',
    occurrence: 0,
    requestFingerprint: 'abcd1234',
  };

  it('off reads nothing and writes nothing', async () => {
    const store = memoryStore();
    const session = createHttpFixtureSession({ ...base, mode: 'off', store });

    expect(await session.read()).toBeUndefined();
    expect(await session.write(response)).toEqual({ stored: false });
    expect(store.writes).toBe(0);
    expect(store.entries.size).toBe(0);
  });

  it('record skips the read and overwrites the key', async () => {
    const store = memoryStore();
    const session = createHttpFixtureSession({ ...base, mode: 'record', store });
    store.entries.set(session.key, 'previous');

    expect(await session.read()).toBeUndefined();
    expect(await session.write(response)).toEqual({ stored: true });
    expect(parseHttpFixture(store.entries.get(session.key) as string)?.status).toBe(200);
  });

  it('replay serves the stored response with durationMs 0 and never writes', async () => {
    const store = memoryStore();
    const recorder = createHttpFixtureSession({ ...base, mode: 'record', store });
    await recorder.write(response);

    const session = createHttpFixtureSession({ ...base, mode: 'replay', store });
    const replay = await session.read();

    expect(replay?.replayed).toBe(true);
    expect(replay?.durationMs).toBe(0);
    expect(replay?.value.durationMs).toBe(0);
    expect(replay?.value.status).toBe(200);
    expect(await session.write(response)).toEqual({ stored: false });
    expect(store.writes).toBe(1);
  });

  it('replay fails naming the node and asking for record when the fixture is missing', async () => {
    const store = memoryStore();
    const session = createHttpFixtureSession({ ...base, mode: 'replay', store });

    await expect(session.read()).rejects.toThrow(/Fetch orders[\s\S]*record/);
    expect(store.entries.size).toBe(0);
  });

  it('replay fails when the host provides no fixture store', async () => {
    const session = createSqlFixtureSession({ ...base, mode: 'replay' });

    await expect(session.read()).rejects.toThrow(/no fixture store/);
  });

  it('replay-or-record reads first, then records exactly once on a miss', async () => {
    const store = memoryStore();
    const first = createSqlFixtureSession({ ...base, mode: 'replay-or-record', store });

    expect(await first.read()).toBeUndefined();
    expect(await first.write(sqlResult)).toEqual({ stored: true });

    const second = createSqlFixtureSession({ ...base, mode: 'replay-or-record', store });
    const replay = await second.read();

    expect(replay?.value).toEqual({ rows: sqlResult.rows, rowCount: 2, truncated: true, durationMs: 0 });
    expect(store.writes).toBe(1);
  });

  it('warns instead of failing when there is no store, the write rejects or the fixture is oversized', async () => {
    const noStore = await createHttpFixtureSession({ ...base, mode: 'record' }).write(response);
    expect(noStore.stored).toBe(false);
    expect(noStore.warning).toMatch(/no fixture store/);

    const failing: FixtureStore = {
      async read() {
        return undefined;
      },
      async write() {
        throw new Error('quota exceeded');
      },
    };
    const rejected = await createHttpFixtureSession({ ...base, mode: 'record', store: failing }).write(response);
    expect(rejected.stored).toBe(false);
    expect(rejected.warning).toMatch(/quota exceeded/);

    const store = memoryStore();
    const oversized = await createHttpFixtureSession({ ...base, mode: 'record', store }).write({
      ...response,
      body: 'a'.repeat(FIXTURE_MAX_BYTES + 1),
    });
    expect(oversized.stored).toBe(false);
    expect(oversized.warning).toMatch(/fixture limit/);
    expect(store.entries.size).toBe(0);
  });

  it('treats a corrupt entry as a miss for replay-or-record and a failure for replay', async () => {
    const store = memoryStore();
    const session = createHttpFixtureSession({ ...base, mode: 'replay-or-record', store });
    store.entries.set(session.key, '{"kind":"http"}');

    expect(await session.read()).toBeUndefined();
    await expect(createHttpFixtureSession({ ...base, mode: 'replay', store }).read()).rejects.toThrow(
      /no recorded fixture/,
    );
  });
});
