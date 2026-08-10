/**
 * `WorkerConnectionStore` — connection resolution on the Cloudflare Worker host
 * (design §7.2, Requirements 2.4-2.7, 2.11, 2.12, 3.5, 3.6, 3.7, 3.10, 3.11).
 *
 * Three sources, deliberately separated:
 *
 * 1. **Secret values** come from worker environment variables named by the
 *    engine's `workerSecretName(connectionId, secretKey)` — always `CONN_`
 *    prefixed and `^[A-Z][A-Z0-9_]*$` shaped, set through
 *    `CloudService.putWorkerSecret` (`wrangler secret put`, value on stdin)
 *    (Requirement 3.5).
 * 2. **Metadata** (`Connection` minus every value) travels with the push and
 *    nothing else: the worker never reads the studio's IndexedDB, so a
 *    connection the operator did not push simply does not exist here
 *    (Requirements 3.6, 3.11).
 * 3. **OAuth access tokens** are cached in the workflow state store under
 *    `oauth:{connectionId}` with no expiry applied to the ENTRY — the token's
 *    own `expiresAt` is what decides freshness. A refresh is a run-time
 *    operation and `wrangler secret put` is a deploy-time one, so a refreshed
 *    token never becomes a worker secret (Requirements 3.7, 3.10).
 *
 * Resolution is complete-or-reject throughout: every code path either returns a
 * bundle holding every declared `secretKeys` name (plus a live `accessToken` for
 * the OAuth modes) or throws, because a partially populated bundle would mean a
 * silently unauthenticated outbound request (Requirements 2.3, 2.5, 2.12).
 */

import {
  CONNECTION_ID_PATTERN,
  assertConnectionId,
  oauthStateKey,
  scopedStateKey,
  workerSecretName,
  type Connection,
  type ConnectionAuth,
  type ConnectionStore,
  type ConnectionSummary,
  type ConnectionType,
  type ResolvedConnection,
  type SqlLimits,
  type WorkflowStateStore,
} from '@phorma/engine';

/**
 * A token must have at least this much validity left to be used, whether it
 * came from the cache or from a fresh grant (Requirements 2.7, 2.12, 3.10).
 */
export const OAUTH_MIN_REMAINING_MS = 30_000;

/** Assumed lifetime when a token endpoint omits `expires_in`. */
const OAUTH_DEFAULT_LIFETIME_SEC = 3600;

/** Cap on the token request itself, so a hung identity provider cannot wedge a run. */
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;

/** Shape stored under `oauth:{connectionId}` (design §8.1). */
export interface CachedOAuthToken {
  /** The access token. */
  token: string;
  /** Absolute epoch ms at which the token stops being valid. */
  expiresAt: number;
}

/**
 * Worker env as this module needs it: a bag of unknowns. Values are read only
 * when they are strings, so `Env` (bindings and all) can be passed directly.
 */
export type WorkerConnectionEnv = Readonly<Record<string, unknown>>;

export interface WorkerConnectionStoreOptions {
  /** Scope for the `oauth:` cache key. Same value the engine uses for state. */
  readonly workflowId?: string;
  /** Clock, injectable so a token-expiry test need not wait. Default `Date.now`. */
  readonly now?: () => number;
  /** Token endpoint transport. Default the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** The two `auth.mode` values that need a token before a request goes out. */
type OAuthMode = Extract<
  ConnectionAuth,
  { mode: 'oauth2-client-credentials' } | { mode: 'oauth2-refresh' }
>;

/**
 * Reads connection secrets from worker env, named by `workerSecretName`.
 * Connection METADATA travels with the push (see
 * {@link connectionMetadataFromPush}), so the worker never needs the studio's
 * browser storage.
 */
export class WorkerConnectionStore implements ConnectionStore {
  private readonly clock: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly workflowId: string;
  /**
   * In-flight refreshes, keyed by connection id. Requirement 2.7: every
   * resolution arriving while a refresh is in flight is served from that single
   * refresh, so N concurrent nodes cause exactly one grant — which also matters
   * for providers that rotate on use.
   */
  private readonly refreshing = new Map<string, Promise<CachedOAuthToken>>();

  constructor(
    private readonly env: WorkerConnectionEnv,
    private readonly metadata: Map<string, Connection>,
    private readonly tokenCache: WorkflowStateStore,
    options: WorkerConnectionStoreOptions = {},
  ) {
    this.clock = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.workflowId = options.workflowId ?? '';
  }

  /**
   * Requirements 2.3, 2.5, 2.6, 2.7, 2.11, 2.12, 3.5, 3.11.
   *
   * Order is the guarantee: id shape, then delivery, then secrets, then the
   * token. Nothing reads an environment variable until the id is valid AND the
   * metadata was actually pushed.
   */
  async resolve(connectionId: string): Promise<ResolvedConnection> {
    // Requirement 2.11: reject a malformed id before touching any secret.
    const id = assertConnectionId(connectionId);

    // Requirements 2.4, 3.11: an unpushed connection does not exist here, and
    // no `CONN_*` variable is read for it.
    const connection = this.metadata.get(id);
    if (connection === undefined) {
      throw new Error(
        `Connection "${id}" was not delivered to this worker. ` +
          `Push the connection metadata before running a workflow that references it.`,
      );
    }

    const secrets = this.readDeclaredSecrets(connection);

    if (connection.auth.mode === 'oauth2-client-credentials' || connection.auth.mode === 'oauth2-refresh') {
      // A failure here throws, so `secrets` (already read) is discarded with the
      // stack rather than handed out half-usable (Requirement 2.12).
      secrets.accessToken = await this.accessToken(connection, connection.auth, secrets);
    }

    return freezeResolved(connection, secrets);
  }

  /**
   * Requirement 2.9: the non-secret projection, carrying secret NAMES and how
   * many of them the worker env actually holds. Feeds push-time capability
   * validation, which is why a missing secret must be countable without being
   * readable.
   */
  async list(): Promise<ConnectionSummary[]> {
    return [...this.metadata.values()]
      .map((connection) => ({
        ...connection,
        secretKeys: [...connection.secretKeys],
        secretsPresent: connection.secretKeys.filter((key) => this.secretValue(connection.id, key) !== undefined)
          .length,
      }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  // ── Secrets ───────────────────────────────────────────────────────────────

  /**
   * Requirements 2.3, 2.5, 3.5: every declared name or nothing. The first
   * missing key names itself and the connection, and the values read before it
   * go out of scope unused — there is no partial bundle to leak or misuse.
   */
  private readDeclaredSecrets(connection: Connection): Record<string, string> {
    const secrets: Record<string, string> = {};
    for (const key of connection.secretKeys) {
      const value = this.secretValue(connection.id, key);
      if (value === undefined) {
        throw new Error(
          `Connection "${connection.name}" (${connection.id}) is missing the secret "${key}". ` +
            `Set the worker secret ${workerSecretName(connection.id, key)} and deploy again.`,
        );
      }
      secrets[key] = value;
    }
    return secrets;
  }

  /** One `CONN_*` lookup. Absent, non-string and empty all read as absent. */
  private secretValue(connectionId: string, secretKey: string): string | undefined {
    const value = this.env[workerSecretName(connectionId, secretKey)];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  // ── OAuth ─────────────────────────────────────────────────────────────────

  /**
   * Requirement 3.10: a cached token with at least 30 seconds left is served as
   * is and no grant request is made. Otherwise one refresh runs, shared by
   * every concurrent resolution of the same connection (Requirement 2.7).
   */
  private async accessToken(
    connection: Connection,
    auth: OAuthMode,
    secrets: Readonly<Record<string, string>>,
  ): Promise<string> {
    const cached = await this.readCachedToken(connection.id);
    if (cached !== undefined && this.isUsable(cached)) return cached.token;

    const inFlight = this.refreshing.get(connection.id);
    if (inFlight !== undefined) {
      const shared = await inFlight;
      // The shared refresh is only usable if it is still usable for US: a token
      // that aged out between the grant and this await is not good enough.
      if (this.isUsable(shared)) return shared.token;
    }

    const refresh = this.refresh(connection, auth, secrets).finally(() => {
      this.refreshing.delete(connection.id);
    });
    this.refreshing.set(connection.id, refresh);
    const token = await refresh;
    return token.token;
  }

  /** True while at least {@link OAUTH_MIN_REMAINING_MS} of validity remains. */
  private isUsable(token: CachedOAuthToken): boolean {
    return token.expiresAt - this.clock() >= OAUTH_MIN_REMAINING_MS;
  }

  /** The cache key: `{workflowId}::oauth:{connectionId}` (design §8.1). */
  private cacheKey(connectionId: string): string {
    return scopedStateKey(this.workflowId, oauthStateKey(connectionId));
  }

  /** A malformed or expired cache entry reads as absent, never as an error. */
  private async readCachedToken(connectionId: string): Promise<CachedOAuthToken | undefined> {
    let raw: string | undefined;
    try {
      raw = (await this.tokenCache.get(this.cacheKey(connectionId)))?.value;
    } catch {
      // A state-store hiccup must not fail a run that can simply refresh.
      return undefined;
    }
    if (raw === undefined) return undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<CachedOAuthToken> | null;
      if (
        parsed === null ||
        typeof parsed.token !== 'string' ||
        parsed.token.length === 0 ||
        typeof parsed.expiresAt !== 'number' ||
        !Number.isFinite(parsed.expiresAt)
      ) {
        return undefined;
      }
      return { token: parsed.token, expiresAt: parsed.expiresAt };
    } catch {
      return undefined;
    }
  }

  /**
   * Requirements 2.12, 3.7: obtains a token, rejects with the connection and
   * the `auth.mode` on any failure (including a token too short-lived to be
   * worth using), and caches a good one under `oauth:{connectionId}` with no
   * entry expiry.
   */
  private async refresh(
    connection: Connection,
    auth: OAuthMode,
    secrets: Readonly<Record<string, string>>,
  ): Promise<CachedOAuthToken> {
    const fail = (detail: string): never => {
      throw new Error(
        `Connection "${connection.name}" (${connection.id}) could not obtain an OAuth access token ` +
          `for auth mode ${auth.mode}: ${detail}`,
      );
    };

    const clientId = secrets[auth.clientIdSecretKey];
    const clientSecret = secrets[auth.clientSecretKey];
    if (clientId === undefined || clientSecret === undefined) {
      const missing = clientId === undefined ? auth.clientIdSecretKey : auth.clientSecretKey;
      fail(`the secret "${missing}" is not declared in secretKeys.`);
    }

    const body = new URLSearchParams();
    if (auth.mode === 'oauth2-client-credentials') {
      body.set('grant_type', 'client_credentials');
      if (auth.scope) body.set('scope', auth.scope);
    } else {
      const refreshToken = secrets[auth.refreshTokenSecretKey];
      if (refreshToken === undefined) {
        fail(`the secret "${auth.refreshTokenSecretKey}" is not declared in secretKeys.`);
      }
      body.set('grant_type', 'refresh_token');
      body.set('refresh_token', refreshToken as string);
    }

    const requestedAt = this.clock();
    let response: Response;
    try {
      response = await this.fetchImpl(auth.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          // Client credentials go in the Authorization header, never in a URL
          // and never in a log line.
          Authorization: `Basic ${base64(`${clientId}:${clientSecret}`)}`,
        },
        body: body.toString(),
        signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // The endpoint's own message can echo a client secret, so only the class
      // of failure is reported.
      return fail(`the token request to ${auth.tokenUrl} failed (${transportDetail(error)}).`);
    }

    if (!response.ok) {
      // Status only: an error body from a token endpoint routinely repeats the
      // credentials it just rejected.
      return fail(`the token endpoint answered HTTP ${response.status}.`);
    }

    let grant: { access_token?: unknown; expires_in?: unknown };
    try {
      grant = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    } catch {
      return fail('the token endpoint did not answer with JSON.');
    }

    if (typeof grant.access_token !== 'string' || grant.access_token.length === 0) {
      return fail('the token endpoint returned no access token.');
    }
    const lifetimeSec =
      typeof grant.expires_in === 'number' && Number.isFinite(grant.expires_in) && grant.expires_in > 0
        ? grant.expires_in
        : OAUTH_DEFAULT_LIFETIME_SEC;

    const token: CachedOAuthToken = {
      token: grant.access_token,
      expiresAt: requestedAt + lifetimeSec * 1000,
    };
    if (!this.isUsable(token)) {
      return fail(
        `the returned token has under ${OAUTH_MIN_REMAINING_MS / 1000} seconds of validity left.`,
      );
    }

    // Requirement 3.7: cached in the state store (no `ttlSec`, so the `oauth:`
    // namespace default of "never expires" applies), never in a worker secret.
    // A cache write that cannot land costs an extra refresh next time, which is
    // not worth failing a run over.
    try {
      await this.tokenCache.set(this.cacheKey(connection.id), JSON.stringify(token));
    } catch {
      /* keep going with the live token */
    }
    return token;
  }
}

/**
 * Builds the metadata map from a push payload, keeping NON-SECRET fields only
 * (Requirement 3.6): whatever else the payload carries — a `secrets` object
 * included — is dropped here rather than trusted downstream.
 *
 * Malformed entries are skipped, not fatal: a connection that fails to parse is
 * simply undelivered, and `resolve` already rejects those by name
 * (Requirement 3.11).
 */
export function connectionMetadataFromPush(payload: unknown): Map<string, Connection> {
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.connections)
      ? payload.connections
      : [];

  const metadata = new Map<string, Connection>();
  for (const entry of list) {
    const connection = sanitizeConnectionMetadata(entry);
    if (connection !== undefined) metadata.set(connection.id, connection);
  }
  return metadata;
}

/**
 * One pushed entry, reduced to the fields of `Connection` and nothing else.
 * Returns undefined when the id, name, type or auth mode is unusable.
 */
export function sanitizeConnectionMetadata(entry: unknown): Connection | undefined {
  if (!isRecord(entry)) return undefined;
  const id = entry.id;
  if (typeof id !== 'string' || !CONNECTION_ID_PATTERN.test(id)) return undefined;
  const name = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name.slice(0, 100) : id;
  const type = entry.type;
  if (!isConnectionType(type)) return undefined;
  const auth = sanitizeAuth(entry.auth);
  if (auth === undefined) return undefined;

  const now = new Date(0).toISOString();
  const connection: Connection = {
    id,
    name,
    type,
    config: stringRecord(entry.config),
    // Names only — a pushed payload has no business carrying values, and this
    // is where that is enforced (Requirements 2.2, 3.6).
    secretKeys: secretKeyNames(entry.secretKeys),
    auth,
    allowWrites: entry.allowWrites === true,
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : now,
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : now,
  };
  const limits = sanitizeLimits(entry.limits);
  if (limits !== undefined) connection.limits = limits;
  return connection;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const CONNECTION_TYPES: readonly ConnectionType[] = ['http', 'oauth2', 'sql', 'aws-sigv4', 'smtp'];

const AUTH_MODES: readonly ConnectionAuth['mode'][] = [
  'none',
  'bearer',
  'basic',
  'basic-token',
  'header',
  'query',
  'oauth2-client-credentials',
  'oauth2-refresh',
  'aws-sigv4',
];

/**
 * Requirement 2.6: `secrets` and `config` are frozen, so a node that receives a
 * resolved connection cannot add, replace or delete an entry in the store's
 * view of it.
 */
function freezeResolved(connection: Connection, secrets: Record<string, string>): ResolvedConnection {
  const resolved: ResolvedConnection = {
    id: connection.id,
    type: connection.type,
    config: Object.freeze({ ...connection.config }),
    secrets: Object.freeze({ ...secrets }),
    auth: connection.auth,
    allowWrites: connection.allowWrites === true,
  };
  if (connection.limits !== undefined) resolved.limits = { ...connection.limits };
  return Object.freeze(resolved);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isConnectionType(value: unknown): value is ConnectionType {
  return typeof value === 'string' && (CONNECTION_TYPES as readonly string[]).includes(value);
}

/** Keeps the declared auth shape when the mode is known, drops it otherwise. */
function sanitizeAuth(value: unknown): ConnectionAuth | undefined {
  if (!isRecord(value)) return undefined;
  const mode = value.mode;
  if (typeof mode !== 'string' || !(AUTH_MODES as readonly string[]).includes(mode)) return undefined;
  return value as unknown as ConnectionAuth;
}

function stringRecord(value: unknown): Record<string, string> {
  const config: Record<string, string> = {};
  if (!isRecord(value)) return config;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') config[key] = entry;
  }
  return config;
}

/** 0 to 32 unique non-empty names (Requirement 2.1). */
function secretKeyNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    if (names.includes(entry)) continue;
    names.push(entry);
    if (names.length === 32) break;
  }
  return names;
}

function sanitizeLimits(value: unknown): SqlLimits | undefined {
  if (!isRecord(value)) return undefined;
  const limits: SqlLimits = {};
  for (const key of ['statementTimeoutMs', 'maxRows', 'maxResultBytes'] as const) {
    const entry = value[key];
    if (typeof entry === 'number' && Number.isFinite(entry) && entry > 0) limits[key] = Math.floor(entry);
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

/** Base64 of a UTF-8 string, Workers-safe (no Node Buffer). */
function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Failure class only — a token endpoint's own text can echo a secret. */
function transportDetail(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timed out';
    return error.name;
  }
  return 'unknown error';
}
