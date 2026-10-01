/**
 * Host capability contracts for the deterministic data path (design §2.5).
 *
 * The engine core stays pure: it never opens a socket, never reads a keychain,
 * never touches IndexedDB or SQLite. Everything environment-specific arrives
 * through the optional capabilities on `RunOptions` declared here — one
 * interface per concern, implemented once per host (Tauri desktop, browser
 * preview, Cloudflare Worker).
 *
 * Every capability is optional. A missing capability produces a descriptive
 * node failure, matching the existing convention for `RunOptions.waitForEvent`:
 * a host that cannot do the thing omits it, and reaching a node that needs it
 * fails the run with a message naming the host and the capability.
 *
 * This module is pure declaration plus one error class hierarchy. No I/O, no
 * runtime dependency.
 */

import type {
  ConnectionSummary,
  ConnectionType,
  ResolvedConnection,
  SqlDriver,
} from './connections.js';

// ─────────────────────────────────────────────────────────────────────────────
// P1-1 Connections
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves a connection reference into usable credentials.
 *
 * The engine only ever holds a `connectionId` from the spec; the host owns the
 * secret backend (desktop keychain, `CONN_*` worker secrets). Resolution is a
 * complete-or-reject operation: a partially populated bundle would mean a
 * silently unauthenticated request, which is never acceptable.
 */
export interface ConnectionStore {
  /**
   * Resolves a connection INCLUDING secret values. Throws a descriptive error
   * when the connection or a declared secret is missing — a missing secret is
   * an operator problem, never a silent unauthenticated request.
   */
  resolve(connectionId: string): Promise<ResolvedConnection>;
  /** Non-secret listing for validation and pickers. */
  list?(): Promise<ConnectionSummary[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// P1-2 / P1-7 / P1-10 Outbound HTTP
// ─────────────────────────────────────────────────────────────────────────────

/** One outbound HTTP request, fully constructed by the engine. */
export interface DataRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  /**
   * How `body` is encoded. `base64` means the body is binary and the host
   * MUST decode it to bytes before sending (multipart uploads). Absent or
   * `utf8` means `body` is sent as UTF-8 text, exactly as before.
   */
  bodyEncoding?: 'utf8' | 'base64';
  timeoutMs?: number;
  /** Response byte cap. The host truncates and sets `truncated`. */
  maxResponseBytes?: number;
}

/** The host's answer to a {@link DataRequest}. */
export interface DataResponse {
  status: number;
  /** Lower-cased header names. Hosts MUST include `retry-after` when present. */
  headers: Record<string, string>;
  body: string;
  /** True when `maxResponseBytes` clipped the body. */
  truncated?: boolean;
  byteCount: number;
  durationMs: number;
}

/**
 * Outbound HTTP for data nodes (distinct from `ToolHost`, which serves agents).
 *
 * MUST reject rather than return on transport failure, so the retry classifier
 * can tell "never reached the server" from "the server answered"; MUST NOT
 * throw for HTTP status codes — a 500 is a `DataResponse`, not an exception.
 * Hosts apply their own egress hardening (the worker reuses
 * `assertPublicHttpUrl` from `cloud/src/workflow-agent.ts`).
 */
export type DataFetcher = (request: DataRequest) => Promise<DataResponse>;

/** Transport-level failure classes, needed for non-idempotent retry safety. */
export type TransportFailureKind = 'connect' | 'dns' | 'tls' | 'timeout' | 'aborted' | 'unknown';

/**
 * A request that never produced an HTTP response. `kind` is what makes a retry
 * decision safe: only a provably unsent request may be retried when the step is
 * not idempotent.
 */
export class DataTransportError extends Error {
  constructor(
    readonly kind: TransportFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'DataTransportError';
  }

  /** True when the request provably never reached the server. */
  get requestNeverSent(): boolean {
    return this.kind === 'connect' || this.kind === 'dns' || this.kind === 'tls';
  }
}

/** `HttpStatusError.bodyPreview` is capped at this many characters. */
export const HTTP_BODY_PREVIEW_MAX_CHARS = 512;

/**
 * An HTTP response outside the node's declared success codes.
 *
 * Carries exactly what the retry classifier needs — the status and the
 * lower-cased response headers, so a `retry-after` lookup needs no
 * normalisation — plus a capped body preview for the failure message.
 * `bodyPreview` is clipped to {@link HTTP_BODY_PREVIEW_MAX_CHARS} and passes
 * through the redaction pipeline before it can reach an event or an error
 * message.
 */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly headers: Record<string, string>,
    readonly bodyPreview: string,
  ) {
    super(`HTTP ${status}`);
    this.name = 'HttpStatusError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// P1-6 SQL
// ─────────────────────────────────────────────────────────────────────────────

/** A parameterised statement plus the resolved limits the host enforces. */
export interface SqlRequest {
  driver: SqlDriver;
  connection: ResolvedConnection;
  /** Statement with named parameters (`:name`). Never interpolated. */
  statement: string;
  params: Record<string, string | number | boolean | null>;
  maxRows: number;
  maxResultBytes: number;
  statementTimeoutMs: number;
}

export interface SqlResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  /** True when `maxRows`/`maxResultBytes` truncated the result. */
  truncated?: boolean;
  /** Inferred column types, powering the "Test query" affordance. */
  columns?: { name: string; type: string }[];
  durationMs: number;
}

/** Parameterised SQL execution, one implementation per driver family. */
export interface SqlHost {
  /** Drivers this host can actually execute. Consulted before `query`. */
  supports(driver: SqlDriver): boolean;
  /** Executes a parameterised statement. Rejects on driver/transport error. */
  query(request: SqlRequest): Promise<SqlResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// P1-8 Durable state
// ─────────────────────────────────────────────────────────────────────────────

/** One stored state value with its bookkeeping. */
export interface StateEntry {
  key: string;
  value: string;
  updatedAt: number;
  /** Absolute epoch ms expiry. Absent = no expiry beyond retention policy. */
  expiresAt?: number;
}

/**
 * Durable key/value scoped to (workflowId). Sits alongside `RunJournal` as a
 * host capability: desktop → IndexedDB, worker → DO SQLite, AWS → DynamoDB.
 */
export interface WorkflowStateStore {
  get(key: string): Promise<StateEntry | undefined>;
  set(key: string, value: string, options?: { ttlSec?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  /** Bounded prefix scan. Hosts MUST cap `limit` (default 1000). */
  list(prefix: string, limit?: number): Promise<StateEntry[]>;
  /**
   * Compare-and-set. Resolves true when written, false when `expected` did not
   * match the stored value. This is what makes idempotency claims atomic.
   */
  compareAndSet(
    key: string,
    expected: string | undefined,
    value: string,
    options?: { ttlSec?: number },
  ): Promise<boolean>;
}

// ─────────────────────────────────────────────────────────────────────────────
// P1-13 Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Record/replay storage for `http-request` and `sql-query` responses. */
export interface FixtureStore {
  /** `key` is the deterministic fixture identity from design §11.1. */
  read(key: string): Promise<string | undefined>;
  write(key: string, value: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run artifacts (document delivery G2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a payload carries for a file a step produced. The bytes never travel
 * through a payload, a prompt or a trace event: they stay in the host's
 * {@link ArtifactStore} and are addressed by `id` within the run.
 */
export interface ArtifactRef {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

/** One stored artifact: its reference plus the bytes and provenance. */
export interface StoredArtifact {
  ref: ArtifactRef;
  /** Producing node id (display and audit only). */
  nodeId: string;
  /** Epoch milliseconds. */
  createdAt: number;
  bytes: Uint8Array;
}

/**
 * Run-scoped binary storage. A host keeps artifacts with the run record and
 * deletes them when the record is deleted or pruned, so an artifact never
 * outlives the history entry that references it.
 *
 * `put` with an existing `(runId, id)` REPLACES the stored artifact: a
 * re-executed producer derives the same id and overwrites rather than adds.
 */
export interface ArtifactStore {
  put(runId: string, artifact: StoredArtifact): Promise<void>;
  get(runId: string, id: string): Promise<StoredArtifact | undefined>;
  /** Every artifact reference of the run, in creation order. */
  list(runId: string): Promise<ArtifactRef[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// P2-10, shared with Phase 1: declared host capability set
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a host names the store entry holding one connection secret. Declared
 * rather than inferred so a validation message can tell the operator exactly
 * what to set, without the validator hard-coding a host id.
 *
 * - `os-keychain`: `conn:{id}:{key}` in the OS keychain (desktop).
 * - `cloudflare-worker-env`: a `CONN_*` worker secret / vault entry.
 * - `none`: this host cannot hold a connection secret at all.
 */
export type ConnectionSecretScheme =
  | 'os-keychain'
  | 'cloudflare-worker-env'
  | 'aws-secrets-manager'
  | 'none';

/**
 * What a host can actually run. Used for run-time guardrails and push-time
 * validation (design §12), so an operator learns a workflow cannot run here
 * before a node fails mid-run.
 */
export interface HostCapabilities {
  id: 'tauri-desktop' | 'browser' | 'cloudflare-worker' | string;
  label: string;
  nodeKinds: readonly string[];
  sqlDrivers: readonly SqlDriver[];
  connectionTypes: readonly ConnectionType[];
  /** Where a connection secret lives on this host. Absent reads as `none`. */
  connectionSecretScheme?: ConnectionSecretScheme;
  features: {
    cron: boolean;
    durableState: boolean;
    fixtures: boolean;
    privateNetworkEgress: boolean;
    stdioMcp: boolean;
    mcpOAuth: boolean;
    /**
     * The host can inject a System One `DecisionClient` (a TypeSafe key, a
     * Phorma Cloud sign-in, or a worker secret). Declared rather than probed so
     * validation can say a Decide node cannot run here before it fails.
     */
    decisions: boolean;
    /**
     * The host supplies a run-scoped `ArtifactStore`, so `render-document`,
     * email attachments and multipart uploads can run here.
     */
    artifacts: boolean;
  };
}
