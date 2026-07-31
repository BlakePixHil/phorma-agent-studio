/**
 * Worker data + SQL drivers (task 18.3, Requirements 8.16, 8.17, 8.18, 8.20,
 * 10.5, 10.10, 10.11, 10.14, 18.5).
 *
 * No worker and no network: `fetch` is a stub, so the properties under test are
 * exactly the ones the engine's retry classifier and payload merge depend on —
 * a blocked URL never dispatches, every status resolves, headers arrive
 * lower-cased, an oversized body is clipped with the retained byte count, a
 * timeout is a `DataTransportError` of kind `timeout`, and the SQL host answers
 * `supports` for `postgres`/`mysql` only.
 *
 * Run: npx -y tsx cloud/test/data-host.test.mjs
 */

import {
  WORKER_SQL_DRIVERS,
  WorkerSqlHost,
  assertPublicHttpUrl,
  classifyFetchFailure,
  clampSqlResult,
  createWorkerDataFetcher,
  toPositionalStatement,
} from '../src/data-host.ts';

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

async function rejection(promise) {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

const request = (overrides = {}) => ({
  url: 'https://api.example.com/v1/items',
  method: 'GET',
  headers: {},
  ...overrides,
});

// ── Egress guard (18.5) ─────────────────────────────────────────────────────

console.log('\nEgress guard');
{
  const blocked = ['http://localhost/x', 'http://127.0.0.1/x', 'http://10.0.0.4/x', 'file:///etc/passwd'];
  check(
    'blocks loopback, RFC1918, localhost and non-http schemes',
    blocked.every((url) => {
      try {
        assertPublicHttpUrl(url);
        return false;
      } catch {
        return true;
      }
    }),
  );

  let calls = 0;
  const fetcher = createWorkerDataFetcher({
    fetchImpl: async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    },
  });
  const error = await rejection(fetcher(request({ url: 'http://169.254.169.254/latest/meta-data' })));
  check('a blocked data URL rejects and dispatches nothing', calls === 0 && error !== undefined);
  check(
    'a blocked data URL is NOT a DataTransportError (so it is not retried)',
    error?.name !== 'DataTransportError',
    error?.name,
  );
}

// ── Responses (8.16, 8.17, 8.18) ────────────────────────────────────────────

console.log('\nResponses');
{
  const fetcher = createWorkerDataFetcher({
    fetchImpl: async () =>
      new Response('server exploded', {
        status: 503,
        headers: { 'Retry-After': '17', Link: '<https://api.example.com/v1/items?page=2>; rel="next"' },
      }),
  });
  const response = await fetcher(request());
  check('a 5xx resolves rather than rejects', response.status === 503);
  check('header names come back lower-cased', response.headers['retry-after'] === '17');
  check('the link header survives', response.headers['link']?.includes('rel="next"') === true);
  check('byteCount counts the body', response.byteCount === 15, String(response.byteCount));
  check('an unclipped body is not truncated', response.truncated === false);
}

{
  const fetcher = createWorkerDataFetcher({
    fetchImpl: async () => new Response('abcdefghij', { status: 200 }),
  });
  const clipped = await fetcher(request({ maxResponseBytes: 4 }));
  check('an oversized body is clipped at the cap', clipped.body === 'abcd', clipped.body);
  check('byteCount reports the RETAINED bytes', clipped.byteCount === 4, String(clipped.byteCount));
  check('truncated is set', clipped.truncated === true);

  const exact = await createWorkerDataFetcher({
    fetchImpl: async () => new Response('abcd', { status: 200 }),
  })(request({ maxResponseBytes: 4 }));
  check('a body exactly at the cap is not reported truncated', exact.truncated === false);
}

// ── Transport failures (8.16, 8.20) ─────────────────────────────────────────

console.log('\nTransport failures');
{
  const fetcher = createWorkerDataFetcher({
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
  });
  const error = await rejection(fetcher(request({ timeoutMs: 1 })));
  check('our own abort timer reports kind "timeout"', error?.kind === 'timeout', error?.kind);
  check('a timeout is not "never sent"', error?.requestNeverSent === false);
}

{
  const fetcher = createWorkerDataFetcher({
    fetchImpl: async () => {
      throw new TypeError('connection refused');
    },
  });
  const error = await rejection(fetcher(request()));
  check('a refused connection is kind "connect"', error?.kind === 'connect', error?.kind);
  check('a refused connection is provably never sent', error?.requestNeverSent === true);
  check(
    'certificate and DNS failures map to tls/dns',
    classifyFetchFailure(new TypeError('certificate has expired')) === 'tls' &&
      classifyFetchFailure(new TypeError('getaddrinfo ENOTFOUND api.example.com')) === 'dns',
  );
  check('an unrecognised failure stays "unknown"', classifyFetchFailure(new Error('nope')) === 'unknown');
}

// ── SQL host (10.5, 10.10, 10.11, 10.14, 18.5) ──────────────────────────────

console.log('\nSQL host');
{
  const host = new WorkerSqlHost();
  check(
    'supports postgres and mysql only',
    host.supports('postgres') && host.supports('mysql') && !host.supports('mssql') && !host.supports('sqlite'),
  );
  check('the declared driver list matches', WORKER_SQL_DRIVERS.join(',') === 'postgres,mysql');

  const unsupported = await rejection(host.query(sqlRequest({ driver: 'mssql' })));
  check('an unsupported driver rejects by name', /mssql/.test(unsupported?.message ?? ''), unsupported?.message);

  const unconfigured = await rejection(host.query(sqlRequest()));
  check(
    'a supported but unconfigured driver names the host',
    /Cloudflare Worker/.test(unconfigured?.message ?? ''),
    unconfigured?.message,
  );
}

{
  const host = new WorkerSqlHost({
    executors: {
      postgres: async () => ({
        rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
        rowCount: 3,
        durationMs: 4,
      }),
    },
  });
  const result = await host.query(sqlRequest({ maxRows: 2 }));
  check('maxRows clips the result', result.rows.length === 2 && result.rowCount === 2);
  check('clipping sets truncated', result.truncated === true);

  const timedOut = await rejection(
    new WorkerSqlHost({
      executors: { postgres: () => new Promise(() => {}) },
    }).query(sqlRequest({ statementTimeoutMs: 20 })),
  );
  check('an over-running statement is aborted', /did not complete within 20 ms/.test(timedOut?.message ?? ''));
}

{
  const byBytes = clampSqlResult(
    { rows: [{ a: 'x'.repeat(40) }, { a: 'y' }], rowCount: 2, durationMs: 1 },
    sqlRequest({ maxResultBytes: 30 }),
    1,
  );
  check('maxResultBytes clips the result', byBytes.rows.length === 0 && byBytes.truncated === true);
}

// ── Named → positional binding (10.4) ───────────────────────────────────────

console.log('\nParameter binding');
{
  const statement =
    "SELECT * FROM users -- :ignored\nWHERE name = :name AND note <> ':name' AND id::text = :id";
  const numbered = toPositionalStatement(statement, { name: "'; DROP TABLE users; --", id: 7 }, 'numbered');
  check('postgres placeholders are numbered in order', numbered.statement.includes('name = $1'));
  check('a cast is untouched', numbered.statement.includes('id::text = $2'));
  check('a literal :name is left alone', numbered.statement.includes("note <> ':name'"));
  check('a comment :name is left alone', numbered.statement.includes('-- :ignored'));
  check(
    'the injection payload travels as a VALUE, never as statement text',
    numbered.values[0] === "'; DROP TABLE users; --" && !numbered.statement.includes('DROP TABLE users; --'),
  );

  const question = toPositionalStatement('SELECT :a, :b', { a: 1, b: null }, 'question');
  check('mysql placeholders are question marks', question.statement === 'SELECT ?, ?');
  check('values keep their order and null', question.values.length === 2 && question.values[1] === null);

  const unbound = (() => {
    try {
      toPositionalStatement('SELECT :missing', {}, 'question');
      return undefined;
    } catch (error) {
      return error;
    }
  })();
  check('an unbound parameter is rejected, never nulled', /:missing/.test(unbound?.message ?? ''));
}

function sqlRequest(overrides = {}) {
  return {
    driver: 'postgres',
    connection: { id: 'conn-1', type: 'sql', config: {}, secrets: {}, auth: { mode: 'none' } },
    statement: 'SELECT 1',
    params: {},
    maxRows: 10_000,
    maxResultBytes: 4 * 1024 * 1024,
    statementTimeoutMs: 30_000,
    ...overrides,
  };
}

console.log(failures === 0 ? '\nAll worker data-host checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
