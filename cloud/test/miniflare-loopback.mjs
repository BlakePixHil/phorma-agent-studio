/**
 * Loopback transport resilience for the Miniflare suites.
 *
 * Every `Miniflare#dispatchFetch` is a real TCP request to workerd over
 * 127.0.0.1. Miniflare sets `reset: true` on each runtime request, so its
 * internal undici `Pool` cannot keep the connection alive - one request means
 * one socket, and Windows parks each closed socket in TIME_WAIT for two
 * minutes. `cloud`'s `test:unit` chain runs four Miniflare suites back to back,
 * two of them property suites issuing hundreds of requests, which drains the
 * ephemeral port range and surfaces partway through an otherwise passing
 * property as:
 *
 *   TypeError: fetch failed -> Error: connect EADDRINUSE 127.0.0.1:<port>
 *
 * That is a harness failure, not a worker failure. `withLoopbackRetry` retries
 * exactly that and nothing else: an error whose cause chain carries a
 * connect-time port exhaustion code, on a request whose body can be replayed.
 * A connect failure happens before any byte reaches workerd, so the retried
 * request is the first one the worker sees - a retry cannot double-write.
 *
 * Everything else propagates on the first attempt, unchanged: an assertion
 * failure, a revived worker exception, any HTTP status, a socket reset while a
 * response is streaming. Retries are counted, and each suite prints
 * `loopbackRetries()` in its summary, so a machine that needs them is visible
 * rather than silently slower.
 *
 * Lowering iteration counts would have been the other way out. It is the wrong
 * one: the properties are the point, and 100 runs is the floor they are
 * declared at.
 */

/**
 * Connect-time failures that mean "no ephemeral port was available", not "the
 * worker is broken". Deliberately short: `ECONNRESET` and `ECONNREFUSED` can
 * both mean workerd died, and retrying those would hide a real defect.
 */
const PORT_EXHAUSTION_CODES = new Set(['EADDRINUSE', 'EADDRNOTAVAIL']);

/** Backoff before each retry. TIME_WAIT drains continuously, so this is short. */
const BACKOFF_MS = [100, 350, 900];

let retries = 0;

/** How many loopback retries this process has needed. */
export function loopbackRetries() {
  return retries;
}

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

function isPortExhaustion(error) {
  for (const code of collectCodes(error)) {
    if (PORT_EXHAUSTION_CODES.has(code)) return true;
  }
  return false;
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
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await dispatch(input, init);
      } catch (error) {
        if (attempt >= BACKOFF_MS.length) throw error;
        if (!isPortExhaustion(error) || !isReplayable(init)) throw error;
        retries += 1;
        await sleep(BACKOFF_MS[attempt]);
      }
    }
  };
  return mf;
}
