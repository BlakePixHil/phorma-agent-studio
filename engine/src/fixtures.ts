/**
 * Mock / replay fixtures for the two I/O nodes (design §11, P1-13).
 *
 * Pure and host-free: the only thing this module touches is the optional
 * {@link FixtureStore} handed in by the caller. Everything else — key
 * derivation, request fingerprinting, serialisation and the mode state machine
 * — is deterministic text in, deterministic text out, so a fixture recorded on
 * the desktop replays byte-identically in a Cloudflare Worker or in CI.
 *
 * Three invariants shape the module:
 *
 * 1. **Identity is deterministic and complete.** A key is derived from the
 *    workflow id, the `fx:` namespace, the node id, an `fnv1a` hash of the input
 *    payload, the 0-based occurrence index within the run and the request
 *    fingerprint (Requirement 16.2). Change any one of those and the key changes,
 *    so an edited request misses its fixture instead of silently replaying a
 *    stale response.
 * 2. **Header values never enter the fingerprint.** Only the lower-cased header
 *    NAMES, sorted, participate (Requirements 16.3, 16.4) — rotating a
 *    credential must not invalidate every fixture, and a secret must never be
 *    hashed into a durable key.
 * 3. **A replay is honest about itself.** A replayed response reports
 *    `durationMs: 0` and carries `replayed: true`, so a trace never pretends a
 *    fixture was a live call (Requirement 16.9).
 */

import type { DataRequest, DataResponse, FixtureStore, SqlResult } from './data-host.js';
import { STATE_NS, canonicalJson, fnv1a, scopedStateKey, utf8ByteLength } from './state.js';
import type { FixtureMode } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mode resolution (Requirement 16.1)
// ─────────────────────────────────────────────────────────────────────────────

/** The four accepted fixture modes. Anything else resolves to `off`. */
export const FIXTURE_MODES: readonly FixtureMode[] = ['off', 'record', 'replay', 'replay-or-record'];

/** Serialised fixture byte cap; a larger fixture is not stored (Requirement 16.12). */
export const FIXTURE_MAX_BYTES = 4_194_304;

/**
 * Resolves a node's declared fixture mode. An absent value, or any value outside
 * the four accepted modes, means `off`: the node performs the real call with no
 * fixture read and no fixture write (Requirement 16.1).
 */
export function resolveFixtureMode(value: unknown): FixtureMode {
  return typeof value === 'string' && (FIXTURE_MODES as readonly string[]).includes(value)
    ? (value as FixtureMode)
    : 'off';
}

/** True when the mode consults the store before performing a call (16.5, 16.8). */
export function fixtureModeReads(mode: FixtureMode): boolean {
  return mode === 'replay' || mode === 'replay-or-record';
}

/** True when the mode records the live response (16.7, 16.8). */
export function fixtureModeWrites(mode: FixtureMode): boolean {
  return mode === 'record' || mode === 'replay-or-record';
}

// ─────────────────────────────────────────────────────────────────────────────
// §11.1 Fixture identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic fixture key. Mirrors the journal key strategy in
 * `WorkflowRun.nextExecutionKey` (`nodeId | payloadHash | occurrence`) so a
 * replayed run addresses the same fixtures a recorded run wrote.
 */
export function fixtureKey(
  nodeId: string,
  payload: string,
  occurrence: number,
  requestFingerprint: string,
): string {
  return `${STATE_NS.fixture}${nodeId}|${fnv1a(payload)}|${occurrence}|${requestFingerprint}`;
}

/**
 * The workflow-scoped form actually handed to a {@link FixtureStore}: the same
 * `workflowId::` scope every durable state key carries, so one workflow's
 * fixtures can never address another's (Requirements 16.2, 16.10).
 */
export function workflowFixtureKey(
  workflowId: string,
  nodeId: string,
  payload: string,
  occurrence: number,
  requestFingerprint: string,
): string {
  return scopedStateKey(workflowId, fixtureKey(nodeId, payload, occurrence, requestFingerprint));
}

/**
 * Request fingerprint of an `http-request` node: method, url, the lower-cased
 * request header NAMES sorted ascending, and the body treated as an empty string
 * when absent (Requirement 16.3).
 *
 * Header VALUES are deliberately excluded, including every value a
 * ResolvedConnection contributed, so rotating a credential yields the same
 * fingerprint as before the rotation (Requirement 16.4).
 */
export function httpRequestFingerprint(
  request: Pick<DataRequest, 'method' | 'url' | 'headers' | 'body'>,
): string {
  const names = Object.keys(request.headers ?? {})
    .map((name) => name.toLowerCase())
    .sort();
  const body = typeof request.body === 'string' ? request.body : '';
  return fnv1a(`${request.method}\n${request.url}\n${canonicalJson(names)}\n${body}`);
}

/**
 * Request fingerprint of a `sql-query` node: the statement plus the canonical
 * JSON form of the parameters, so parameter key ordering never changes the key
 * (Requirement 16.3).
 */
export function sqlRequestFingerprint(
  statement: string,
  params: Readonly<Record<string, string | number | boolean | null>>,
): string {
  return fnv1a(`${statement}${canonicalJson(params ?? {})}`);
}

/**
 * 0-based occurrence counter for a node within one run (Requirement 16.2).
 *
 * Keyed by `nodeId|payloadHash` exactly like the journal, so the second visit to
 * a node inside a loop iteration with the same input gets occurrence 1 and
 * therefore its own fixture.
 */
export interface FixtureOccurrences {
  /** Returns the next 0-based index for this `(nodeId, payload)` pair. */
  next(nodeId: string, payload: string): number;
  /** The index the next call would return, without consuming it. */
  peek(nodeId: string, payload: string): number;
}

export function createFixtureOccurrences(): FixtureOccurrences {
  const counts = new Map<string, number>();
  const keyOf = (nodeId: string, payload: string): string => `${nodeId}|${fnv1a(payload)}`;
  return {
    next(nodeId, payload) {
      const key = keyOf(nodeId, payload);
      const occurrence = counts.get(key) ?? 0;
      counts.set(key, occurrence + 1);
      return occurrence;
    },
    peek(nodeId, payload) {
      return counts.get(keyOf(nodeId, payload)) ?? 0;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialised shapes
// ─────────────────────────────────────────────────────────────────────────────

/** A recorded HTTP response: exactly what Requirement 16.5 must reproduce. */
export interface HttpFixture {
  readonly kind: 'http';
  readonly status: number;
  /** Lower-cased header names, as the host reported them. */
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly byteCount: number;
  readonly truncated?: boolean;
}

/** A recorded SQL result: rows, row count and truncation state (16.5). */
export interface SqlFixture {
  readonly kind: 'sql';
  readonly rows: Record<string, unknown>[];
  readonly rowCount: number;
  readonly truncated?: boolean;
  readonly columns?: { name: string; type: string }[];
}

export type Fixture = HttpFixture | SqlFixture;

/** Serialises a live response into its fixture text. */
export function serializeHttpFixture(response: DataResponse): string {
  const fixture: HttpFixture = {
    kind: 'http',
    status: response.status,
    headers: { ...(response.headers ?? {}) },
    body: typeof response.body === 'string' ? response.body : '',
    byteCount: Number.isFinite(response.byteCount)
      ? response.byteCount
      : utf8ByteLength(typeof response.body === 'string' ? response.body : ''),
    ...(response.truncated ? { truncated: true } : {}),
  };
  // Canonical text: two identical responses serialise byte-identically, so a
  // re-record is a no-op rather than a spurious store write.
  return canonicalJson(fixture);
}

/** Serialises a live SQL result into its fixture text. */
export function serializeSqlFixture(result: SqlResult): string {
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const fixture: SqlFixture = {
    kind: 'sql',
    rows,
    rowCount: Number.isFinite(result.rowCount) ? result.rowCount : rows.length,
    ...(result.truncated ? { truncated: true } : {}),
    ...(result.columns ? { columns: result.columns } : {}),
  };
  return canonicalJson(fixture);
}

/** A response served from a fixture: zero duration, marked as replayed (16.9). */
export interface FixtureReplay<T> {
  readonly value: T;
  readonly replayed: true;
  readonly durationMs: 0;
}

/**
 * Rehydrates a recorded HTTP response. `durationMs` is 0 because no call
 * happened; a caller emitting `http-response` reports `replayed: true`.
 *
 * Returns `undefined` for text that is not a readable HTTP fixture, so a corrupt
 * or foreign entry is treated as a miss rather than replayed as garbage.
 */
export function parseHttpFixture(raw: string): DataResponse | undefined {
  const fixture = parseFixture(raw);
  if (!fixture || fixture.kind !== 'http') return undefined;
  return {
    status: fixture.status,
    headers: fixture.headers,
    body: fixture.body,
    byteCount: fixture.byteCount,
    ...(fixture.truncated ? { truncated: true } : {}),
    durationMs: 0,
  };
}

/** Rehydrates a recorded SQL result, with `durationMs: 0` (16.5, 16.9). */
export function parseSqlFixture(raw: string): SqlResult | undefined {
  const fixture = parseFixture(raw);
  if (!fixture || fixture.kind !== 'sql') return undefined;
  return {
    rows: fixture.rows,
    rowCount: fixture.rowCount,
    ...(fixture.truncated ? { truncated: true } : {}),
    ...(fixture.columns ? { columns: fixture.columns } : {}),
    durationMs: 0,
  };
}

/** Validates and narrows fixture text. Total: never throws. */
function parseFixture(raw: string): Fixture | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;

  if (record['kind'] === 'http') {
    const status = record['status'];
    const body = record['body'];
    if (typeof status !== 'number' || !Number.isFinite(status)) return undefined;
    if (typeof body !== 'string') return undefined;
    const headers = stringRecord(record['headers']);
    if (headers === undefined) return undefined;
    const byteCount = typeof record['byteCount'] === 'number' && Number.isFinite(record['byteCount'])
      ? (record['byteCount'] as number)
      : utf8ByteLength(body);
    return {
      kind: 'http',
      status,
      headers,
      body,
      byteCount,
      ...(record['truncated'] === true ? { truncated: true } : {}),
    };
  }

  if (record['kind'] === 'sql') {
    const rows = record['rows'];
    if (!Array.isArray(rows)) return undefined;
    if (!rows.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row))) {
      return undefined;
    }
    const typedRows = rows as Record<string, unknown>[];
    const rowCount = typeof record['rowCount'] === 'number' && Number.isFinite(record['rowCount'])
      ? (record['rowCount'] as number)
      : typedRows.length;
    const columns = Array.isArray(record['columns'])
      ? (record['columns'] as { name: string; type: string }[])
      : undefined;
    return {
      kind: 'sql',
      rows: typedRows,
      rowCount,
      ...(record['truncated'] === true ? { truncated: true } : {}),
      ...(columns ? { columns } : {}),
    };
  }

  return undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string') return undefined;
    out[key] = entry;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The four modes
// ─────────────────────────────────────────────────────────────────────────────

/** What a fixture write attempt produced (Requirement 16.12). */
export interface FixtureWriteOutcome {
  /** True only when the store accepted the fixture. */
  readonly stored: boolean;
  /**
   * Present when the fixture was NOT stored for a recoverable reason: no store
   * on this host, a rejected write, or a serialised fixture over
   * {@link FIXTURE_MAX_BYTES}. The caller reports it as a warning and returns the
   * live response as the node's output.
   */
  readonly warning?: string;
}

/** Everything needed to address one node execution's fixture. */
export interface FixtureSessionOptions {
  /** The node's declared `fixtures` value, unvalidated. */
  readonly mode?: unknown;
  /** Workflow scope for the key. Defaults to `''`. */
  readonly workflowId?: string;
  readonly nodeId: string;
  /** Used in error and warning messages; falls back to `nodeId`. */
  readonly nodeName?: string;
  /** The node's input payload, hashed into the key. */
  readonly payload: string;
  /** 0-based occurrence index of this execution within the run. */
  readonly occurrence: number;
  /** {@link httpRequestFingerprint} or {@link sqlRequestFingerprint}. */
  readonly requestFingerprint: string;
  /** Absent on a host with no fixture support. */
  readonly store?: FixtureStore;
}

/**
 * The record/replay state machine for one node execution.
 *
 * `read()` and `write()` between them implement all four modes:
 *
 * | mode               | `read()`                                   | `write(live)`            |
 * | ------------------ | ------------------------------------------ | ------------------------ |
 * | `off`              | `undefined`, store untouched               | no-op, no warning        |
 * | `record`           | `undefined`, store untouched (16.7)        | overwrites the key       |
 * | `replay`           | fixture, or a node failure (16.6, 16.11)   | no-op, no warning        |
 * | `replay-or-record` | fixture when present, else `undefined`     | writes on a miss (16.8)  |
 */
export interface FixtureSession<T> {
  /** The resolved mode. */
  readonly mode: FixtureMode;
  /** The workflow-scoped store key. */
  readonly key: string;
  /** True when {@link read} may consult the store. */
  readonly reads: boolean;
  /** True when {@link write} may store a live response. */
  readonly writes: boolean;
  /**
   * Reads the fixture. Resolves the replayed value, or `undefined` when the
   * caller must perform the real call.
   *
   * Rejects only in `replay` mode: with a message naming the node and asking for
   * `record` when no fixture exists (16.6), and with a message naming the node
   * and the host when the host supplies no store at all (16.11). Neither path
   * performs a call or mutates a stored fixture.
   */
  read(): Promise<FixtureReplay<T> | undefined>;
  /**
   * Records a live response. Never rejects: a failure to store is a warning, not
   * a run failure, because the live response is already a valid node output
   * (16.12).
   */
  write(value: T): Promise<FixtureWriteOutcome>;
}

interface FixtureCodec<T> {
  serialize(value: T): string;
  parse(raw: string): T | undefined;
  /** Noun used in messages, e.g. `response` / `result`. */
  readonly noun: string;
}

const HTTP_CODEC: FixtureCodec<DataResponse> = {
  serialize: serializeHttpFixture,
  parse: parseHttpFixture,
  noun: 'response',
};

const SQL_CODEC: FixtureCodec<SqlResult> = {
  serialize: serializeSqlFixture,
  parse: parseSqlFixture,
  noun: 'result',
};

/** Record/replay for an `http-request` node execution. */
export function createHttpFixtureSession(options: FixtureSessionOptions): FixtureSession<DataResponse> {
  return createSession(options, HTTP_CODEC);
}

/** Record/replay for a `sql-query` node execution. */
export function createSqlFixtureSession(options: FixtureSessionOptions): FixtureSession<SqlResult> {
  return createSession(options, SQL_CODEC);
}

function createSession<T>(options: FixtureSessionOptions, codec: FixtureCodec<T>): FixtureSession<T> {
  const mode = resolveFixtureMode(options.mode);
  const label = (options.nodeName ?? '').trim() || options.nodeId;
  const key = workflowFixtureKey(
    options.workflowId ?? '',
    options.nodeId,
    options.payload,
    options.occurrence,
    options.requestFingerprint,
  );
  const store = options.store;

  return {
    mode,
    key,
    reads: fixtureModeReads(mode),
    writes: fixtureModeWrites(mode),

    async read(): Promise<FixtureReplay<T> | undefined> {
      if (!fixtureModeReads(mode)) return undefined;

      if (!store) {
        if (mode === 'replay') {
          throw new Error(
            `Step "${label}" is set to replay fixtures, but this host provides no fixture store.`,
          );
        }
        return undefined;
      }

      const raw = await store.read(key);
      const value = typeof raw === 'string' ? codec.parse(raw) : undefined;
      if (value === undefined) {
        if (mode === 'replay') {
          throw new Error(
            `Step "${label}" has no recorded fixture for this request. Run it once in "record" mode first.`,
          );
        }
        return undefined;
      }
      return { value, replayed: true, durationMs: 0 };
    },

    async write(value: T): Promise<FixtureWriteOutcome> {
      if (!fixtureModeWrites(mode)) return { stored: false };

      if (!store) {
        return {
          stored: false,
          warning: `Step "${label}" recorded no fixture: this host provides no fixture store.`,
        };
      }

      const serialised = codec.serialize(value);
      const bytes = utf8ByteLength(serialised);
      if (bytes > FIXTURE_MAX_BYTES) {
        return {
          stored: false,
          warning:
            `Step "${label}" recorded no fixture: the ${codec.noun} is ${bytes} bytes, over the ` +
            `${FIXTURE_MAX_BYTES} byte fixture limit.`,
        };
      }

      try {
        await store.write(key, serialised);
        return { stored: true };
      } catch (error) {
        return {
          stored: false,
          warning: `Step "${label}" recorded no fixture: ${messageOf(error)}`,
        };
      }
    },
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  const text = String(error ?? '').trim();
  return text.length > 0 ? text : 'the fixture store rejected the write.';
}
