/**
 * Loopback transport resilience for the Miniflare suites.
 *
 * Every `Miniflare#dispatchFetch` is a real TCP request to workerd over
 * 127.0.0.1, and the connection is not reused - one request means one socket,
 * and Windows parks each closed socket in TIME_WAIT for two minutes. `cloud`'s
 * `test:unit` chain runs several Miniflare suites back to back, several of them
 * property suites issuing hundreds of requests, which drains the ephemeral port
 * range and surfaces partway through an otherwise passing property as:
 *
 *   TypeError: fetch failed -> Error: connect EADDRINUSE 127.0.0.1:<port>
 *
 * `getD1Database` costs THE SAME ONE SOCKET PER STATEMENT. That was measured,
 * not assumed: 300 `prepare().run()` calls through the magic proxy leave 306
 * sockets in TIME_WAIT, and installing a keep-alive global undici dispatcher
 * changes nothing, because the proxy builds its own pool inside miniflare. So a
 * suite that never calls `dispatchFetch` is not exempt - it is usually the
 * bigger consumer, since every statement the WORKER code issues against the
 * proxied binding crosses the loopback too. The billing suites spend ~12,800
 * sockets between them against a 16,384-port range, which is what pushed
 * `telemetry-ingest` into `EADDRINUSE` at the tail of the chain.
 *
 * That is a harness failure, not a worker failure. `withLoopbackRetry` (fetch)
 * and `withLoopbackRetryD1` (D1) retry exactly that and nothing else: an error
 * whose cause chain carries a connect-time port exhaustion code, on a call whose
 * body can be replayed. A connect failure happens before any byte reaches
 * workerd, so the retried call is the first one the worker sees - a retry cannot
 * double-write, which is what makes retrying a D1 INSERT safe here.
 *
 * Everything else propagates on the first attempt, unchanged: an assertion
 * failure, a revived worker exception, any HTTP status, a `D1_ERROR`, a socket
 * reset while a response is streaming. Retries are counted, and each suite
 * prints `loopbackRetries()` in its summary, so a machine that needs them is
 * visible rather than silently slower.
 *
 * Lowering iteration counts would have been the other way out. It is the wrong
 * one: the properties are the point, and 100 runs is the floor they are
 * declared at. Suite ORDER in `package.json` is the second part of the fix - the
 * D1-proxy-heavy billing suites run last, so the fetch property suites start
 * against a clean port range rather than the 12,800 sockets those leave behind.
 *
 * The THIRD part is `await-port-drain.mjs`, and it exists because retrying has a
 * ceiling these wrappers cannot raise: the ladder below tops out at ~22s while
 * TIME_WAIT is 120s, so it survives a transient shortage and not an empty range.
 * A suite that needs thousands of sockets to itself gets a drain barrier in front
 * of it in `test:unit` instead.
 */

/**
 * Connect-time failures that mean "no ephemeral port was available", not "the
 * worker is broken". Deliberately short: `ECONNRESET` and `ECONNREFUSED` can
 * both mean workerd died, and retrying those would hide a real defect.
 */
const PORT_EXHAUSTION_CODES = new Set(['EADDRINUSE', 'EADDRNOTAVAIL']);

/**
 * Backoff before each retry. TIME_WAIT drains continuously, so the first steps
 * are short - but a chain that has just spent twelve thousand sockets needs the
 * OS to recycle THOUSANDS, which takes seconds, not milliseconds. The tail steps
 * are the difference between "retried and passed" and "retried four times inside
 * 1.35s and failed anyway", and they are only ever paid on a machine that is
 * genuinely out of ports.
 */
const BACKOFF_MS = [100, 350, 900, 2500, 6000, 12_000];

let retries = 0;

/** How many loopback retries this process has needed. */
export function loopbackRetries() {
  return retries;
}

/**
 * Visibility without a per-suite edit: the two telemetry suites print
 * `loopbackRetries()` in their own summary, and every other importer gets this
 * one line, only when the machine actually needed a retry. Silence means the
 * port range was never the reason a suite was slow.
 */
process.on('exit', () => {
  if (retries > 0) console.log(`\n(loopback port exhaustion retries: ${retries})`);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every `code` on an error, its `cause` chain and any aggregated `errors`. */
function collectCodes(error, out = new Set(), depth = 0) {
  if (error === null || typeof error !== 'object' || depth > 6) return out;
  if (typeof error.code === 'string') out.add(error.code);
  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) collectCodes(nested, out, depth + 1);
  }
  collectCodes(error.cause, out, depth + 1);
  return out;
}

/**
 * Every `message` on an error and its cause chain. The D1 magic proxy revives a
 * failure as a `D1_ERROR` whose text carries the original sentence but whose
 * `code` is D1's own, so the code scan alone would miss port exhaustion on that
 * path. Matching the two OS tokens as text is still precise: neither string
 * occurs in a SQL, constraint or binding error.
 */
function collectMessages(error, out = [], depth = 0) {
  if (error === null || typeof error !== 'object' || depth > 6) return out;
  if (typeof error.message === 'string') out.push(error.message);
  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) collectMessages(nested, out, depth + 1);
  }
  collectMessages(error.cause, out, depth + 1);
  return out;
}

function isPortExhaustion(error) {
  for (const code of collectCodes(error)) {
    if (PORT_EXHAUSTION_CODES.has(code)) return true;
  }
  for (const message of collectMessages(error)) {
    for (const code of PORT_EXHAUSTION_CODES) {
      if (message.includes(code)) return true;
    }
  }
  return false;
}

/** Retries `attempt` on connect-time port exhaustion only. */
async function retrying(attemptFn) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await attemptFn();
    } catch (error) {
      if (attempt >= BACKOFF_MS.length) throw error;
      if (!isPortExhaustion(error)) throw error;
      retries += 1;
      await sleep(BACKOFF_MS[attempt]);
    }
  }
}

/**
 * A body is replayable when `new Request(input, init)` can build it again from
 * the same init. Strings and absent bodies can; a stream cannot, and retrying
 * one would report a disturbed-stream error instead of the real cause.
 */
function isReplayable(init) {
  if (init === null || init === undefined) return true;
  const body = init.body;
  return body === null || body === undefined || typeof body === 'string';
}

/**
 * Wraps `mf.dispatchFetch` in place so every call site in the suite - helpers
 * and the direct `mf.dispatchFetch(...)` calls alike - is covered by one edit
 * at the factory. Returns the same instance; all other Miniflare methods are
 * untouched.
 */
export function withLoopbackRetry(mf) {
  const dispatch = mf.dispatchFetch.bind(mf);
  mf.dispatchFetch = async (input, init) => {
    if (!isReplayable(init)) return dispatch(input, init);
    return retrying(() => dispatch(input, init));
  };
  return mf;
}

/**
 * The same protection for a binding taken out of the instance with
 * `getD1Database`. Every terminal call there is one loopback request, so a
 * drained port range fails a suite that never dispatches a fetch just as
 * readily - and those suites are the ones draining it.
 *
 * Shape follows the recording wrapper in `telemetry-ingest.test.mjs`: statements
 * carry their `__inner` so `batch` can hand workerd the real ones. A statement
 * is an immutable descriptor - `bind` returns a new one - so replaying a
 * terminal call replays nothing else.
 */
function wrapStatement(inner) {
  return {
    __inner: inner,
    bind: (...values) => wrapStatement(inner.bind(...values)),
    first: (column) => retrying(() => (column === undefined ? inner.first() : inner.first(column))),
    run: () => retrying(() => inner.run()),
    all: () => retrying(() => inner.all()),
    raw: (options) => retrying(() => inner.raw(options)),
  };
}

export function withLoopbackRetryD1(db) {
  return {
    prepare: (sql) => wrapStatement(db.prepare(sql)),
    batch: (statements) => retrying(() => db.batch(statements.map((s) => s.__inner ?? s))),
    exec: (sql) => retrying(() => db.exec(sql)),
    dump: () => retrying(() => db.dump()),
  };
}
