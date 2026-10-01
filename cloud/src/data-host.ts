/**
 * Outbound HTTP and SQL for the Cloudflare Worker host (design §13,
 * Requirements 8.16, 8.17, 8.18, 8.20, 10.5, 10.10, 10.11, 10.14, 18.5).
 *
 * The engine constructs a request and hands it over; this module is the only
 * place on the worker that opens a socket for a data node. Three guarantees are
 * the whole point of it:
 *
 * 1. **Egress stays public.** Every data URL goes through
 *    {@link assertPublicHttpUrl} — the same SSRF guard the hosted tool path has
 *    always used, moved here so both callers share one implementation rather
 *    than drifting apart (Requirement 18.5). A blocked URL rejects with a plain
 *    `Error`, deliberately NOT a `DataTransportError`, so the retry classifier
 *    treats it as not-retryable: repeating it would be blocked identically.
 * 2. **Failures are classified, not flattened.** `fetch` rejects with a handful
 *    of opaque `TypeError`s; the retry classifier needs to know whether the
 *    request provably never landed. {@link classifyFetchFailure} maps what a
 *    Worker can actually observe onto the six `TransportFailureKind` values, and
 *    only `connect`/`dns`/`tls` (which imply nothing was written) are reported
 *    for a failure that could not have reached the server (Requirement 8.16).
 * 3. **Every answer is bounded.** The response body is read through a capped
 *    reader (Requirement 8.18) and the whole attempt — headers AND body — sits
 *    under one abort timer (Requirement 8.20), so a server that dribbles bytes
 *    forever cannot hold a run open.
 *
 * SQL is deliberately thin. `WorkerSqlHost.supports` answers true for `postgres`
 * and `mysql` only (Requirement 18.5); MSSQL and SQLite are not reachable from a
 * Worker, and the engine's `supports` gate turns that into a clear node failure
 * instead of a mid-statement error. The wire protocol itself is an injected
 * {@link WorkerSqlExecutor} per driver family — a Hyperdrive-backed driver is a
 * separately schedulable increment, exactly like the desktop `sql_query`
 * commands — while the limits, the statement timeout and the truncation
 * accounting live here so every executor inherits them (Requirements 10.10,
 * 10.11, 10.14).
 */

import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_REQUEST_TIMEOUT_SEC,
  MAX_REQUEST_TIMEOUT_SEC,
  MIN_REQUEST_TIMEOUT_SEC,
  DataTransportError,
  decodeBase64,
  maskSqlText,
  utf8ByteLength,
  type DataFetcher,
  type DataRequest,
  type DataResponse,
  type SqlDriver,
  type SqlHost,
  type SqlRequest,
  type SqlResult,
  type TransportFailureKind,
} from '@phorma/engine';

/** Label used in every failure message, matching `CLOUDFLARE_CAPABILITIES.label`. */
export const WORKER_HOST_LABEL = 'Cloudflare Worker';

// ─────────────────────────────────────────────────────────────────────────────
// Egress guard (Requirement 18.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SSRF guard: blocks URLs that address private, loopback, link-local or
 * metadata space by hostname shape, and anything that is not http/https.
 *
 * Workers cannot resolve DNS before `fetch`, so this is a best-effort literal
 * check — the platform additionally blocks direct RFC1918 access from Workers.
 * `label` only shapes the message ("tool URL" for the agent tool path, "data
 * request URL" for the data path), never the decision.
 */
export function assertPublicHttpUrl(raw: string, label = 'tool URL'): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Blocked ${label} (unparseable): ${raw.slice(0, 100)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Blocked ${label} (protocol ${url.protocol}) — only http/https allowed.`);
  }
  const host = url.hostname.toLowerCase();
  const blockedHosts = ['localhost', 'metadata.google.internal'];
  if (blockedHosts.includes(host) || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error(`Blocked ${label} (internal host): ${host}`);
  }
  // Literal IPv4 checks: loopback, RFC1918, link-local/metadata, CGNAT.
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    const blocked =
      a === 127 ||
      a === 10 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127);
    if (blocked) throw new Error(`Blocked ${label} (private address): ${host}`);
  }
  // IPv6 loopback/link-local/unique-local literals.
  if (host.includes(':')) {
    const bare = host.replace(/^\[|\]$/g, '');
    if (bare === '::1' || bare.startsWith('fe80') || bare.startsWith('fc') || bare.startsWith('fd')) {
      throw new Error(`Blocked ${label} (private IPv6): ${host}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DataFetcher (Requirements 8.16, 8.17, 8.18, 8.20)
// ─────────────────────────────────────────────────────────────────────────────

/** Absolute per-attempt timeout bounds, mirroring the engine's `timeoutSec` range. */
const MIN_TIMEOUT_MS = MIN_REQUEST_TIMEOUT_SEC * 1000;
const MAX_TIMEOUT_MS = MAX_REQUEST_TIMEOUT_SEC * 1000;
const DEFAULT_TIMEOUT_MS = DEFAULT_REQUEST_TIMEOUT_SEC * 1000;

/** Methods for which `fetch` refuses a request body. */
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

export interface WorkerDataFetcherOptions {
  /**
   * Applies {@link assertPublicHttpUrl} to every request. Default true: the
   * worker is a shared, credential-holding host, so the guard is opt-OUT and
   * only a BYO deployment that owns its own network should turn it off.
   */
  readonly restrictEgress?: boolean;
  /** Transport, injectable so a test needs no network. Default the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Clock for `durationMs`. Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * Builds the worker's {@link DataFetcher}.
 *
 * Contract, restated because the retry classifier depends on every clause of it:
 * a transport failure REJECTS with a {@link DataTransportError} carrying one of
 * the six kinds; every HTTP status — 3xx, 4xx, 5xx alike — RESOLVES with a
 * {@link DataResponse}; header names come back lower-cased with `retry-after`
 * and `link` intact; a body above the cap is truncated with `byteCount` counting
 * the bytes RETAINED.
 */
export function createWorkerDataFetcher(options: WorkerDataFetcherOptions = {}): DataFetcher {
  const restrictEgress = options.restrictEgress ?? true;
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const clock = options.now ?? (() => Date.now());

  return async function workerDataFetch(request: DataRequest): Promise<DataResponse> {
    // Requirement 18.5: the guard runs before anything is dispatched, and a
    // blocked URL is a plain Error — not retryable, because a retry is blocked
    // identically.
    if (restrictEgress) assertPublicHttpUrl(request.url, 'data request URL');

    const timeoutMs = resolveTimeoutMs(request.timeoutMs);
    const maxBytes = resolveMaxBytes(request.maxResponseBytes);
    const method = (request.method || 'GET').toUpperCase();

    const controller = new AbortController();
    /**
     * Distinguishes OUR abort from a caller's: both surface as an `AbortError`,
     * but only ours is a `timeout` (Requirement 8.16).
     */
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const startedAt = clock();
    try {
      const init: RequestInit = {
        method,
        headers: { ...request.headers },
        signal: controller.signal,
        redirect: 'follow',
      };
      // `fetch` rejects a GET/HEAD carrying a body; dropping it here keeps that
      // author mistake out of the transport-failure taxonomy.
      if (request.body !== undefined && !BODYLESS_METHODS.has(method)) {
        // A `base64` body is binary (multipart uploads): send the bytes.
        init.body = request.bodyEncoding === 'base64' ? decodeBase64(request.body) : request.body;
      }

      let response: Response;
      try {
        response = await fetchImpl(request.url, init);
      } catch (error) {
        throw toTransportError(error, timedOut, timeoutMs);
      }

      // The timer still covers the body: the response is not complete until the
      // last retained byte is read (Requirement 8.20).
      let read: { body: string; byteCount: number; truncated: boolean };
      try {
        read = await readCapped(response, maxBytes);
      } catch (error) {
        throw toTransportError(error, timedOut, timeoutMs);
      }

      return {
        status: response.status,
        headers: lowerCasedHeaders(response.headers),
        body: read.body,
        truncated: read.truncated,
        byteCount: read.byteCount,
        durationMs: Math.max(0, clock() - startedAt),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Requirement 8.17: lower-cased names, `retry-after` and `link` included
 * whenever the response carries them. `Headers` iteration already lower-cases on
 * the Workers runtime; the explicit call keeps that true on any other transport
 * a test might inject.
 */
function lowerCasedHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Requirement 8.18: reads at most `maxBytes` of the body, reporting the retained
 * byte count and whether anything was dropped.
 *
 * Streaming rather than `response.text()` is what makes the cap real: a 2 GB
 * answer must never be materialised just to be clipped afterwards. The stream is
 * cancelled the moment the cap is reached, so the connection is released instead
 * of draining.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ body: string; byteCount: number; truncated: boolean }> {
  const stream = response.body;
  if (stream === null) return { body: '', byteCount: 0, truncated: false };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;

      const room = maxBytes - retained;
      if (value.byteLength >= room) {
        // Keep exactly the bytes that fit, then stop reading.
        if (room > 0) {
          chunks.push(value.subarray(0, room));
          retained += room;
        }
        truncated = value.byteLength > room || !(await isEndOfStream(reader));
        break;
      }
      chunks.push(value);
      retained += value.byteLength;
    }
  } finally {
    // `cancel` on an already-finished stream is a no-op; on a clipped one it
    // releases the connection rather than draining the remainder.
    await reader.cancel().catch(() => undefined);
  }

  return { body: decodeUtf8(chunks, retained), byteCount: retained, truncated };
}

/**
 * True when the stream had nothing left. Called only when a chunk exactly filled
 * the cap, so "reached the cap" is not reported as truncation for a body that
 * happened to be exactly `maxBytes` long.
 */
async function isEndOfStream(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<boolean> {
  const next = await reader.read();
  return next.done === true || next.value === undefined || next.value.byteLength === 0;
}

/** Joins the retained chunks and decodes them, replacing a clipped sequence. */
function decodeUtf8(chunks: readonly Uint8Array[], byteLength: number): string {
  if (byteLength === 0) return '';
  const merged = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Non-fatal decoding on purpose: clipping at a byte cap can cut a multi-byte
  // sequence in half, and a replacement character is a better answer than a throw.
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(merged);
}

/** Requirement 8.20: node-supplied timeout when sane, otherwise 30 seconds. */
function resolveTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(timeoutMs), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/** Requirement 8.18: node-supplied cap when positive, otherwise 4 MiB. */
function resolveMaxBytes(maxResponseBytes: number | undefined): number {
  if (typeof maxResponseBytes !== 'number' || !Number.isFinite(maxResponseBytes)) {
    return DEFAULT_MAX_RESPONSE_BYTES;
  }
  const floored = Math.floor(maxResponseBytes);
  return floored > 0 ? floored : DEFAULT_MAX_RESPONSE_BYTES;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transport failure classification (Requirement 8.16)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps a `fetch` rejection onto a {@link TransportFailureKind}.
 *
 * Only `connect`, `dns` and `tls` mean "the request provably never reached the
 * server", and only those let the retry classifier repeat a non-idempotent
 * write. Everything ambiguous therefore lands on `unknown`, which is the safe
 * side of that decision: a timeout on a POST may well have been applied by the
 * server.
 *
 * `timedOut` comes from our own abort timer, so it wins over the generic
 * `AbortError` name a caller-supplied signal would produce.
 */
export function classifyFetchFailure(error: unknown, timedOut = false): TransportFailureKind {
  if (timedOut) return 'timeout';
  if (error instanceof DataTransportError) return error.kind;

  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError') return 'timeout';
  if (name === 'AbortError') return 'aborted';

  const text = `${name} ${error instanceof Error ? error.message : String(error)}`.toLowerCase();
  if (/timed?\s?out|timeout|etimedout/.test(text)) return 'timeout';
  if (/abort/.test(text)) return 'aborted';
  if (/certificat|\btls\b|\bssl\b|handshake|self.signed/.test(text)) return 'tls';
  if (/\bdns\b|getaddrinfo|enotfound|eai_again|could not be resolved|name not resolved/.test(text)) {
    return 'dns';
  }
  if (
    /econnrefused|econnreset|epipe|ehostunreach|enetunreach|connection (refused|reset|closed|failed)|failed to connect|could not connect|network connection lost|socket/.test(
      text,
    )
  ) {
    return 'connect';
  }
  return 'unknown';
}

/** Wraps a rejection as a {@link DataTransportError}, preserving the message. */
function toTransportError(error: unknown, timedOut: boolean, timeoutMs: number): DataTransportError {
  const kind = classifyFetchFailure(error, timedOut);
  if (kind === 'timeout' && timedOut) {
    return new DataTransportError(kind, `Request timed out after ${timeoutMs} ms.`);
  }
  if (error instanceof DataTransportError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new DataTransportError(kind, detail.length > 0 ? detail : `Transport failure (${kind}).`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SqlHost (Requirements 10.5, 10.10, 10.11, 10.14, 18.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The only drivers reachable from a Worker (Requirement 18.5), matching
 * `CLOUDFLARE_CAPABILITIES.sqlDrivers`. MSSQL needs TDS and SQLite needs a local
 * file, neither of which a Worker can provide, so `supports` says so up front and
 * the engine fails the node before a statement is submitted.
 */
export const WORKER_SQL_DRIVERS: readonly SqlDriver[] = ['postgres', 'mysql'];

/**
 * One driver family's wire implementation, injected rather than imported.
 *
 * Keeping it injected is what lets the Hyperdrive/TCP driver land as its own
 * increment (the worker bundle carries no SQL client today) while `WorkerSqlHost`
 * already owns the parts that must not be re-implemented per driver: the
 * `supports` gate, the statement timeout and the row/byte truncation accounting.
 *
 * An executor receives the fully resolved {@link SqlRequest} — statement,
 * separate parameter values, and all three limits — and MUST bind every value
 * through the driver, never into the statement text (Requirement 10.4).
 */
export type WorkerSqlExecutor = (request: SqlRequest) => Promise<SqlResult>;

export interface WorkerSqlHostOptions {
  /** Wire implementation per driver family. A driver with no entry is unconfigured. */
  readonly executors?: Partial<Record<SqlDriver, WorkerSqlExecutor>>;
  /** Clock for `durationMs` when an executor reports none. Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * `SqlHost` for the Cloudflare Worker.
 *
 * `supports` is the contract the engine checks before every statement, and it is
 * driver-shaped rather than configuration-shaped on purpose: it answers "can this
 * host ever run this driver", so push-time capability validation gives the same
 * verdict as the run itself (Requirement 18.5).
 */
export class WorkerSqlHost implements SqlHost {
  private readonly executors: Partial<Record<SqlDriver, WorkerSqlExecutor>>;
  private readonly clock: () => number;

  constructor(options: WorkerSqlHostOptions = {}) {
    this.executors = { ...options.executors };
    this.clock = options.now ?? (() => Date.now());
  }

  /** Requirement 18.5: true for `postgres` and `mysql`, false for everything else. */
  supports(driver: SqlDriver): boolean {
    return WORKER_SQL_DRIVERS.includes(driver);
  }

  /**
   * Requirements 10.10, 10.11, 10.14.
   *
   * The executor does the talking; this method owns the boundaries. The timeout
   * races the executor so a driver that never settles cannot hold the run, and
   * the result is clipped to the resolved `maxRows`/`maxResultBytes` so
   * `truncated` is trustworthy even for an executor that streams everything back.
   */
  async query(request: SqlRequest): Promise<SqlResult> {
    if (!this.supports(request.driver)) {
      throw new Error(
        `The ${WORKER_HOST_LABEL} host cannot run the "${request.driver}" SQL driver. ` +
          `Supported drivers: ${WORKER_SQL_DRIVERS.join(', ')}.`,
      );
    }

    const executor = this.executors[request.driver];
    if (executor === undefined) {
      throw new Error(
        `The ${WORKER_HOST_LABEL} host has no "${request.driver}" driver configured. ` +
          `Bind a Hyperdrive-backed ${request.driver} driver on this worker before running SQL nodes.`,
      );
    }

    const startedAt = this.clock();
    const result = await withStatementTimeout(
      executor(request),
      request.statementTimeoutMs,
      request.driver,
    );
    const elapsed = Math.max(0, this.clock() - startedAt);

    return clampSqlResult(result, request, elapsed);
  }
}

/**
 * Requirement 10.14: aborts an over-running statement with a message naming the
 * driver and the elapsed budget. The executor's own promise is abandoned rather
 * than cancelled — a driver that supports cancellation should also honour
 * `statementTimeoutMs` itself; this is the backstop that guarantees the engine
 * always regains control.
 */
async function withStatementTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  driver: SqlDriver,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `SQL statement on the ${driver} driver did not complete within ${timeoutMs} ms and was aborted.`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Requirement 10.11: keeps at most `maxRows` rows and at most `maxResultBytes`
 * of serialised rows, marking the result truncated when anything was dropped.
 *
 * Byte accounting is done on the JSON encoding of each row because that is what
 * the engine will put in the payload — the same measure the desktop drivers
 * apply, so a workflow reports the same truncation on either host. A row already
 * marked truncated by the executor stays truncated.
 */
export function clampSqlResult(result: SqlResult, request: SqlRequest, elapsedMs: number): SqlResult {
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const maxRows = Number.isFinite(request.maxRows) ? Math.max(1, Math.floor(request.maxRows)) : rows.length;
  const maxBytes = Number.isFinite(request.maxResultBytes)
    ? Math.max(1, Math.floor(request.maxResultBytes))
    : Number.POSITIVE_INFINITY;

  const kept: Record<string, unknown>[] = [];
  let bytes = 0;
  let truncated = result.truncated === true;

  for (const row of rows) {
    if (kept.length >= maxRows) {
      truncated = true;
      break;
    }
    bytes += utf8ByteLength(safeJson(row));
    if (bytes > maxBytes) {
      truncated = true;
      break;
    }
    kept.push(row);
  }

  const clamped: SqlResult = {
    rows: kept,
    rowCount: kept.length,
    durationMs: Number.isFinite(result.durationMs) ? result.durationMs : elapsedMs,
  };
  if (truncated) clamped.truncated = true;
  if (result.columns !== undefined) clamped.columns = result.columns;
  return clamped;
}

/** A row that cannot be serialised still has to be measured, never thrown over. */
function safeJson(row: unknown): string {
  try {
    return JSON.stringify(row) ?? 'null';
  } catch {
    return String(row);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Named → positional binding, shared by every driver family
// ─────────────────────────────────────────────────────────────────────────────

/** Placeholder dialect of a driver family. */
export type PositionalStyle = 'numbered' | 'question';

/** `$1, $2, …` for Postgres, `?` for MySQL. */
export function positionalStyleFor(driver: SqlDriver): PositionalStyle {
  return driver === 'postgres' ? 'numbered' : 'question';
}

/**
 * Rewrites `:name` parameters into the driver's positional placeholders and
 * returns the values in matching order (Requirement 10.4).
 *
 * This is the one place a statement is edited, and it never inserts a VALUE:
 * every `:name` becomes a placeholder and the value travels in the returned
 * array, so a payload containing `'; DROP TABLE users; --` can only ever arrive
 * as a bound string. Occurrences inside string literals, quoted identifiers and
 * comments are left alone, using the engine's position-preserving mask — the
 * same mask the engine's own extraction uses, so the two agree by construction.
 *
 * A `:name` with no entry in `params` is rejected rather than bound to null: a
 * silently-null predicate is a wrong answer, not a smaller one.
 */
export function toPositionalStatement(
  statement: string,
  params: Readonly<Record<string, string | number | boolean | null>>,
  style: PositionalStyle,
): { statement: string; values: (string | number | boolean | null)[] } {
  const masked = maskSqlText(statement);
  const values: (string | number | boolean | null)[] = [];
  let out = '';
  let i = 0;

  while (i < statement.length) {
    // Outside the source's literal/comment regions the mask matches the source,
    // so a `:` present in BOTH is a real parameter position.
    if (masked[i] !== ':' || statement[i] !== ':') {
      out += statement[i];
      i += 1;
      continue;
    }
    if (masked[i + 1] === ':') {
      out += '::';
      i += 2;
      continue;
    }
    if (isWordChar(masked[i - 1])) {
      out += statement[i];
      i += 1;
      continue;
    }

    let end = i + 1;
    while (end < masked.length && isWordChar(masked[end])) end += 1;
    const name = statement.slice(i + 1, end);
    const first = name[0];
    if (name.length === 0 || first === undefined || (first >= '0' && first <= '9')) {
      out += statement[i];
      i += 1;
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      throw new Error(`SQL statement references the parameter ":${name}", which has no bound value.`);
    }
    values.push(params[name] ?? null);
    out += style === 'numbered' ? `$${values.length}` : '?';
    i = end;
  }

  return { statement: out, values };
}

function isWordChar(char: string | undefined): boolean {
  if (char === undefined) return false;
  return (
    (char >= 'a' && char <= 'z') ||
    (char >= 'A' && char <= 'Z') ||
    (char >= '0' && char <= '9') ||
    char === '_'
  );
}
