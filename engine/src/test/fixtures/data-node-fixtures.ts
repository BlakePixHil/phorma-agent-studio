/**
 * Committed fixtures for the CI fixture-replay suite (task 22.4).
 *
 * These entries were captured once by driving the real `startRun` over one
 * `http-request` node and one `sql-query` node with `fixtures: 'record'`
 * against the scripted `FakeDataFetcher` / `FakeSqlHost` responses described
 * by {@link RECORDING_INPUTS} below, then copying the resulting
 * `MemoryFixtureStore` entries verbatim. Nothing in this file is
 * hand-written JSON: it is the actual serialised output of
 * `serializeHttpFixture` / `serializeSqlFixture` (`engine/src/fixtures.ts`).
 *
 * `fixture-replay.spec.ts` seeds a fresh `MemoryFixtureStore` from
 * {@link DATA_NODE_FIXTURES} (never from a live record pass) and re-runs the
 * SAME two node graphs with `fixtures: 'replay'`, using fake hosts that throw
 * if invoked at all — proving every response the run produces came from this
 * committed data, not a live (even fake) call.
 *
 * Regenerating this file (only ever needed if the graphs below change):
 * drive the two graphs once with `fixtures: 'record'` and a real
 * `MemoryFixtureStore`, then copy `store.entries` here.
 */

/** Inputs used to record the two fixtures below. Kept alongside the data so a
 *  future re-record reproduces the same keys. */
export const RECORDING_INPUTS = {
  workflowId: 'wf-fixture-replay',
  http: {
    nodeId: 'http-1',
    payload: '{"tenant":"acme"}',
    url: 'https://api.example.com/orders',
    method: 'GET',
    resultKey: 'orders',
  },
  sql: {
    nodeId: 'sql-1',
    payload: '{"status":"open"}',
    statement: 'select id, total from orders where status = :status',
    connectionId: 'conn-fixture',
  },
} as const;

/**
 * Workflow-scoped fixture-store entries, keyed exactly as
 * `workflowFixtureKey` (`engine/src/fixtures.ts`) derives them: the same key
 * a `replay` run recomputes from `workflowId`, `nodeId`, the input payload
 * hash, the occurrence index and the request fingerprint.
 */
export const DATA_NODE_FIXTURES: Readonly<Record<string, string>> = {
  'wf-fixture-replay::fx:http-1|4a1565fd|0|860d4f81':
    '{"body":"{\\"items\\":[{\\"id\\":1,\\"total\\":42}]}","byteCount":32,"headers":{"content-type":"application/json"},"kind":"http","status":200}',
  'wf-fixture-replay::fx:sql-1|b34bfeb5|0|332b722b':
    '{"kind":"sql","rowCount":1,"rows":[{"id":1,"total":42}]}',
};

/** Expected node output once replayed, for the assertions in the spec file. */
export const EXPECTED_HTTP_OUTPUT = '{"tenant":"acme","orders":{"items":[{"id":1,"total":42}]}}';
export const EXPECTED_SQL_OUTPUT = '{"rows":[{"id":1,"total":42}],"rowCount":1}';
