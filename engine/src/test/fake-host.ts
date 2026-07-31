/**
 * In-memory host fakes for the deterministic data path integration suites
 * (design "Testing Strategy" → Integration tests; Requirements 18.1, 18.2).
 *
 * These implement the whole `RunOptions` capability surface a data-path run
 * needs — not stubs — so the integration and replay-safety suites (tasks
 * 22.2-22.4) can drive the real `startRun` end to end with no network, no
 * disk and no language model anywhere in the run:
 *
 * - `FakeConnectionStore` — seeded `ResolvedConnection` records, rejecting an
 *   unknown id exactly the way a real host must (Requirement 2.4).
 * - `FakeDataFetcher` — a scriptable `DataFetcher`: one queued step per call,
 *   each a partial `DataResponse` (status, headers, body — including a 429
 *   carrying `Retry-After`, for the retry classifier) or an `Error` to throw
 *   (including `DataTransportError`, for transport-failure classification).
 * - `FakeSqlHost` — a scriptable `SqlHost`: a per-driver `supports()` set plus
 *   one queued result or error per `query()` call.
 * - `MemoryFixtureStore` — a plain in-memory `FixtureStore`.
 * - `NEVER_CALLED_MODEL` — a `ModelClient` that throws if streamed at all,
 *   proving a data-only run makes zero calls to `RunOptions.model`
 *   (Requirement 1.2).
 *
 * `MemoryStateStore` (the `WorkflowStateStore` fake) already lives in
 * `./memory-state-store.js` and is reused as-is; it is not duplicated here.
 */

import type {
  ConnectionStore,
  DataFetcher,
  DataRequest,
  DataResponse,
  FixtureStore,
  SqlHost,
  SqlRequest,
  SqlResult,
} from '../data-host.js';
import type { ResolvedConnection, SqlDriver } from '../connections.js';
import type { ModelClient } from '../model.js';

// ─────────────────────────────────────────────────────────────────────────────
// ConnectionStore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A `ConnectionStore` seeded with `ResolvedConnection` records by id.
 *
 * `resolve` returns the seeded record for a known id and rejects for an
 * unknown one, mirroring the real host rejection behaviour (Requirement 2.4):
 * no partial bundle is ever returned, and the message names the requested id.
 */
export class FakeConnectionStore implements ConnectionStore {
  private readonly connections = new Map<string, ResolvedConnection>();

  constructor(seed: Iterable<ResolvedConnection> = []) {
    for (const connection of seed) this.connections.set(connection.id, connection);
  }

  /** Adds or replaces a seeded connection, keyed by `connection.id`. */
  seed(connection: ResolvedConnection): void {
    this.connections.set(connection.id, connection);
  }

  /** Removes a previously seeded connection, so a later `resolve` rejects. */
  remove(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  async resolve(connectionId: string): Promise<ResolvedConnection> {
    const connection = this.connections.get(connectionId);
    if (connection === undefined) {
      throw new Error(`Unknown connection "${connectionId}".`);
    }
    return connection;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DataFetcher
// ─────────────────────────────────────────────────────────────────────────────

/** One scripted answer for `FakeDataFetcher`: a (partial) response, or a rejection to throw. */
export type DataScriptStep = Partial<DataResponse> | Error;

/**
 * A scriptable `DataFetcher` that replays a queued sequence of responses (or
 * throws a queued error) once per call, in order.
 *
 * A call past the end of the script rejects loudly, so "issues at most N
 * requests" is checked by construction rather than by counting afterwards.
 * Every request the engine issued is recorded on `requests`, in order, so
 * tests can assert on headers, bodies and idempotency keys actually sent.
 *
 * Explicitly supports the two script shapes the retry classifier needs:
 *  - a 429 (or any status) carrying a `Retry-After` header, via
 *    `{ status: 429, headers: { 'retry-after': '120' } }`;
 *  - a transport failure, via `new DataTransportError('timeout', '…')`
 *    queued as a script step (it is an `Error`, so it is simply thrown).
 */
export class FakeDataFetcher {
  private readonly script: DataScriptStep[];
  private index = 0;

  /** Every request issued so far, in call order. */
  readonly requests: DataRequest[] = [];

  constructor(script: readonly DataScriptStep[] = []) {
    this.script = [...script];
  }

  /** Bound function form, ready to hand to `RunOptions.dataFetch`. */
  readonly fetch: DataFetcher = async (request: DataRequest): Promise<DataResponse> => {
    this.requests.push(request);
    const step = this.script[this.index++];
    if (step === undefined) {
      throw new Error(
        `FakeDataFetcher received an unscripted request (call ${this.index}) to ${request.url}.`,
      );
    }
    if (step instanceof Error) throw step;
    const body = step.body ?? '';
    return {
      status: 200,
      headers: {},
      byteCount: body.length,
      durationMs: 0,
      ...step,
      body,
    };
  };

  /** Appends more scripted steps, for tests that grow the script as they go. */
  enqueue(...steps: DataScriptStep[]): void {
    this.script.push(...steps);
  }

  /** Number of calls made so far. */
  get callCount(): number {
    return this.requests.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SqlHost
// ─────────────────────────────────────────────────────────────────────────────

/** One scripted answer for `FakeSqlHost`: a (partial) result, or a rejection to throw. */
export type SqlScriptStep = Partial<SqlResult> | Error;

const ALL_SQL_DRIVERS: readonly SqlDriver[] = ['postgres', 'mysql', 'mssql', 'sqlite'];

export interface FakeSqlHostOptions {
  /** Queued answers, one per `query()` call, in order. Default: empty rows. */
  readonly script?: readonly SqlScriptStep[];
  /** Drivers `supports()` accepts. Default: all four driver families. */
  readonly supports?: Iterable<SqlDriver>;
}

/**
 * A scriptable `SqlHost`: a controllable per-driver `supports()` plus a
 * queued sequence of results or errors for `query()`, replayed in order.
 *
 * A call past the end of the script answers with zero rows rather than
 * rejecting, since most SQL tests care about the request shape (statement,
 * params, limits) more than an exhaustive script; use `enqueue` for the cases
 * that do need a specific failure or truncated result at a specific call.
 */
export class FakeSqlHost implements SqlHost {
  private readonly script: SqlScriptStep[];
  private index = 0;
  private readonly supportedDrivers: Set<SqlDriver>;

  /** Every request submitted so far, in call order. */
  readonly requests: SqlRequest[] = [];

  constructor(options: FakeSqlHostOptions = {}) {
    this.script = [...(options.script ?? [])];
    this.supportedDrivers = new Set(options.supports ?? ALL_SQL_DRIVERS);
  }

  supports(driver: SqlDriver): boolean {
    return this.supportedDrivers.has(driver);
  }

  /** Marks `driver` as supported or unsupported for subsequent `supports()` calls. */
  setSupports(driver: SqlDriver, supported: boolean): void {
    if (supported) this.supportedDrivers.add(driver);
    else this.supportedDrivers.delete(driver);
  }

  async query(request: SqlRequest): Promise<SqlResult> {
    this.requests.push(request);
    const step = this.script[this.index++];
    if (step === undefined) {
      return { rows: [], rowCount: 0, durationMs: 0 };
    }
    if (step instanceof Error) throw step;
    const rows = step.rows ?? [];
    return { rowCount: rows.length, durationMs: 0, ...step, rows };
  }

  /** Appends more scripted steps, for tests that grow the script as they go. */
  enqueue(...steps: SqlScriptStep[]): void {
    this.script.push(...steps);
  }

  /** Number of calls made so far. */
  get callCount(): number {
    return this.requests.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FixtureStore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A plain in-memory `FixtureStore`: a `Map` behind `read`/`write`, with call
 * counters so a test can assert "recorded once" or "replayed with no write".
 */
export class MemoryFixtureStore implements FixtureStore {
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

  /** Seeds a fixture directly, as a recorded run would have left it. */
  seed(key: string, value: string): void {
    this.entries.set(key, value);
  }

  clear(): void {
    this.entries.clear();
    this.reads = 0;
    this.writes = 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ModelClient
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A `ModelClient` that throws the moment it is streamed. Handed to
 * `RunOptions.model` in every data-path integration run so that a passing
 * test proves the run made zero calls to the model — not merely that nobody
 * happened to check (Requirement 1.2).
 */
export const NEVER_CALLED_MODEL: ModelClient = {
  async *stream() {
    throw new Error('No model call is expected in these scripted runs.');
  },
};
