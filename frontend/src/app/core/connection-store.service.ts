import { Injectable, inject } from '@angular/core';

import {
  assertConnectionId,
  connectionSecretName,
  oauthStateKey,
  scopedStateKey,
  type Connection,
  type ConnectionAuth,
  type ConnectionStore,
  type ConnectionSummary,
  type ResolvedConnection,
} from '@phorma/engine';

import { IndexedDbStorageService } from './indexed-db-storage.service';
import { TauriService } from './tauri.service';
import { WorkflowStateService } from './workflow-state.service';

/**
 * `ConnectionStoreService` — connection resolution on the desktop host
 * (design §7, §7.1; Requirements 2.3-2.8, 2.11, 2.12, 3.1-3.4, 18.3).
 *
 * Three sources, deliberately separated, mirroring `WorkerConnectionStore` in
 * `cloud/src/connections.ts`:
 *
 * 1. **Metadata** (`Connection` minus every value) comes from the global
 *    IndexedDB `connections` store (Requirement 3.4).
 * 2. **Secret values** stay in the OS keychain under `conn:{id}:{key}` and are
 *    read, applied to the outbound request and scrubbed out of the answer inside
 *    the Rust `data_request` / `sql_query` commands (Requirement 3.3). This
 *    service therefore never holds a value: it verifies PRESENCE through
 *    `has_secret` and hands the engine a {@link hostSecretSentinel} per declared
 *    key. The sentinel is what the Rust side overwrites — caller headers land
 *    first, `Authorization` among them is dropped, and connection auth is
 *    applied last — so an outbound request always carries the real credential
 *    and the webview never sees one.
 * 3. **OAuth access tokens** are obtained here, written to the keychain as the
 *    connection's `accessToken` secret, and their EXPIRY (never the token) is
 *    cached in the workflow state store under `oauth:{connectionId}`.
 *
 * Resolution is complete-or-reject throughout: every path either returns a
 * bundle naming every declared `secretKeys` entry (plus `accessToken` for the
 * OAuth modes) or throws, because a partially populated bundle would mean a
 * silently unauthenticated outbound request (Requirements 2.3, 2.5, 2.12).
 */

/**
 * Prefix of the stand-in value handed to the engine in place of a real secret.
 * Longer than the redactor's `MIN_SECRET_LEN`, so a sentinel that somehow
 * reached an event would be scrubbed like any other registered secret.
 */
export const HOST_SECRET_SENTINEL_PREFIX = 'phorma-host-secret:';

/** A token must keep this much validity to be used (Requirements 2.7, 2.12). */
export const OAUTH_MIN_REMAINING_MS = 30_000;

/** Assumed lifetime when a token endpoint omits `expires_in`. */
const OAUTH_DEFAULT_LIFETIME_SEC = 3600;

/** Cap on the grant itself, so a hung identity provider cannot wedge a run. */
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;

/** A token response is small; anything larger is not a token response. */
const OAUTH_MAX_RESPONSE_BYTES = 64 * 1024;

/** Secret key holding the live OAuth access token (design §7). */
const ACCESS_TOKEN_SECRET_KEY = 'accessToken';

/** The message the browser preview and a keychain-less build both report. */
export const NO_KEYCHAIN_MESSAGE =
  'Connections need the desktop app or a deployed worker — browser preview cannot hold credentials.';

/**
 * The stand-in value for one connection secret. Carries the connection id, which
 * is what lets {@link ConnectionStoreService.credentialsFor} recover the
 * credential reference from a request the engine built without ever seeing a
 * secret.
 */
export function hostSecretSentinel(connectionId: string, secretKey: string): string {
  return `${HOST_SECRET_SENTINEL_PREFIX}${connectionId}#${secretKey}`;
}

/** Matches a sentinel and captures the connection id it names. */
const SENTINEL_PATTERN = /phorma-host-secret:(conn-[A-Za-z0-9_-]{1,64})/;

/** What the desktop `data_request` / `sql_query` commands need to apply auth. */
export interface HostCredentialReference {
  readonly connectionId: string;
  /** Keychain secret NAMES the Rust side must resolve, never values. */
  readonly secretKeys: string[];
  readonly auth: ConnectionAuth;
}

/** Cached OAuth bookkeeping. The token itself stays in the keychain. */
interface CachedTokenExpiry {
  /** Absolute epoch ms at which the stored `accessToken` stops being valid. */
  expiresAt: number;
}

/** Minimal view of the Rust `data_request` answer, used for the token grant. */
interface TokenGrantResponse {
  status: number;
  body: string;
}

@Injectable({ providedIn: 'root' })
export class ConnectionStoreService implements ConnectionStore {
  private readonly db = inject(IndexedDbStorageService);
  private readonly tauri = inject(TauriService);
  private readonly state = inject(WorkflowStateService);

  /**
   * Metadata of every connection resolved in this session, keyed by id. Holds
   * NAMES and the auth descriptor only, and exists so `credentialsFor` can turn
   * a built request back into a credential reference.
   */
  private readonly resolved = new Map<string, HostCredentialReference>();

  /**
   * In-flight grants, keyed by connection id. Requirement 2.7: every resolution
   * arriving while a grant is in flight is served from that single grant, so N
   * concurrent nodes cause exactly one token request — which also matters for
   * providers that rotate a refresh token on use.
   */
  private readonly granting = new Map<string, Promise<CachedTokenExpiry>>();

  /** Injectable clock, so a token-expiry test need not wait. */
  private clock: () => number = () => Date.now();

  /**
   * A `ConnectionStore` bound to one workflow, which is the form
   * `RunOptions.connections` takes. The scope only affects the
   * `oauth:{connectionId}` cache key; secrets are global to the machine, exactly
   * like the `connections` store itself.
   */
  forWorkflow(workflowId: string): ConnectionStore {
    return {
      resolve: (connectionId: string) => this.resolve(connectionId, workflowId),
      list: () => this.list(),
    };
  }

  /** Test seam: replaces the clock used for token freshness decisions. */
  setClock(now: () => number): void {
    this.clock = now;
  }

  /**
   * Requirements 19.7, 19.8: whether this host can hold a connection secret at
   * all. The connection editor uses this to disable secret entry outright —
   * mirroring `resolve`'s desktop-only gate — rather than let a write appear to
   * succeed on a host with no keychain to receive it.
   */
  get secretsSupported(): boolean {
    return this.tauri.isDesktop;
  }

  /**
   * Requirement 19.4/2.9 support: whether one declared secret is present in
   * the keychain, without ever reading its value. Public wrapper around the
   * same presence check `resolve`/`list` use internally.
   */
  async secretPresent(connectionId: string, secretKey: string): Promise<boolean> {
    return this.hasSecret(connectionId, secretKey);
  }

  /**
   * Requirement 19.7: writes one connection secret directly to the keychain.
   * Never touches Connection metadata or `WorkflowSpec` — the caller (the
   * connection editor) persists only the fact that a value now exists, never
   * the value itself. Rejects when the host has no keychain to write to.
   */
  async writeSecret(connectionId: string, secretKey: string, value: string): Promise<void> {
    if (!this.secretsSupported) throw new Error(NO_KEYCHAIN_MESSAGE);
    await this.storeSecret(connectionId, secretKey, value);
  }

  /**
   * Requirement 19.6: removes one connection secret from the keychain (used
   * when deleting a Connection, or clearing a single field). Empty-value
   * `set_secret` already clears the entry on the Rust side, so this is the
   * same call under a name that reads correctly at call sites that remove
   * rather than write.
   */
  async clearSecret(connectionId: string, secretKey: string): Promise<void> {
    if (!this.secretsSupported) throw new Error(NO_KEYCHAIN_MESSAGE);
    await this.storeSecret(connectionId, secretKey, '');
  }

  /**
   * Requirements 2.3, 2.5, 2.6, 2.7, 2.11, 2.12, 3.1, 3.4.
   *
   * Order is the guarantee: id shape, then metadata, then keychain presence,
   * then the token. Nothing reads the keychain until the id is valid AND the
   * connection actually exists locally.
   */
  async resolve(connectionId: string, workflowId = ''): Promise<ResolvedConnection> {
    // Requirement 2.11: reject a malformed id before touching any secret.
    const id = assertConnectionId(connectionId);

    // Requirement 2.4: an unknown connection reads no secret and names itself.
    const connection = await this.db.getConnection(id);
    if (connection === undefined) {
      throw new Error(
        `Connection "${id}" is not known to this machine. ` +
          `Create it in Connections before running a workflow that references it.`,
      );
    }

    if (!this.tauri.isDesktop) {
      // Requirement 3.8: no secret store worth trusting, so no resolution.
      throw new Error(NO_KEYCHAIN_MESSAGE);
    }

    const secretKeys = await this.assertDeclaredSecretsPresent(connection);

    if (
      connection.auth.mode === 'oauth2-client-credentials' ||
      connection.auth.mode === 'oauth2-refresh'
    ) {
      // A failure here throws, so nothing half-usable is handed out
      // (Requirement 2.12).
      await this.accessToken(connection, connection.auth, workflowId);
      secretKeys.push(ACCESS_TOKEN_SECRET_KEY);
    }

    this.resolved.set(id, { connectionId: id, secretKeys, auth: connection.auth });
    return freezeResolved(connection, secretKeys);
  }

  /**
   * Requirement 2.9: the non-secret projection, carrying secret NAMES and how
   * many of them the keychain actually holds. Feeds the properties panel and
   * push-time capability validation, which is why a missing secret must be
   * countable without being readable.
   */
  async list(): Promise<ConnectionSummary[]> {
    const connections = await this.db.listConnections();
    const summaries: ConnectionSummary[] = [];
    for (const connection of connections) {
      const missing: string[] = [];
      for (const key of connection.secretKeys) {
        if (!(await this.hasSecret(connection.id, key))) missing.push(key);
      }
      summaries.push({
        ...connection,
        secretKeys: [...connection.secretKeys],
        secretsPresent: connection.secretKeys.length - missing.length,
        missingSecretKeys: missing,
      });
    }
    return summaries.sort((left, right) => left.id.localeCompare(right.id));
  }

  /**
   * Recovers the credential reference for a request the engine built from a
   * resolved connection, by finding the sentinel the engine copied into the
   * request while applying auth (design §7.1).
   *
   * Returns undefined for a request that carries no sentinel, which is the
   * normal case for an unauthenticated call or a `notify` webhook. Throws when a
   * sentinel names a connection this session never resolved: reaching the
   * network with an unreplaced sentinel would be an unauthenticated request, and
   * failing is the only safe answer.
   */
  credentialsFor(request: {
    url: string;
    headers: Record<string, string>;
  }): HostCredentialReference | undefined {
    const id = findSentinelConnectionId(request);
    if (id === undefined) return undefined;

    const reference = this.resolved.get(id);
    if (reference === undefined) {
      throw new Error(
        `Connection "${id}" was referenced by a request but is not resolved in this session, ` +
          `so its credentials cannot be applied. Re-run the workflow.`,
      );
    }
    return reference;
  }

  // ── Keychain presence ─────────────────────────────────────────────────────

  /**
   * Requirements 2.3, 2.5, 3.1: every declared name or nothing. The first
   * missing key names itself and the connection, and no value is read for any of
   * them — presence is all the webview is entitled to know.
   */
  private async assertDeclaredSecretsPresent(connection: Connection): Promise<string[]> {
    const names: string[] = [];
    for (const key of connection.secretKeys) {
      if (!(await this.hasSecret(connection.id, key))) {
        throw new Error(
          `Connection "${connection.name}" (${connection.id}) is missing the secret "${key}". ` +
            `Store it in Connections and try again.`,
        );
      }
      names.push(key);
    }
    return names;
  }

  /** One keychain presence check. An unreadable keychain reads as absent. */
  private async hasSecret(connectionId: string, secretKey: string): Promise<boolean> {
    if (!this.tauri.isDesktop) return false;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<boolean>('has_secret', {
        key: connectionSecretName(connectionId, secretKey),
      });
    } catch {
      return false;
    }
  }

  /** Writes one connection secret to the keychain under `conn:{id}:{key}`. */
  private async storeSecret(connectionId: string, secretKey: string, value: string): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_secret', { key: connectionSecretName(connectionId, secretKey), value });
  }

  // ── OAuth ─────────────────────────────────────────────────────────────────

  /**
   * Requirements 2.7, 2.12: a stored token with at least 30 seconds left is used
   * as is and no grant is made. Otherwise one grant runs, shared by every
   * concurrent resolution of the same connection.
   */
  private async accessToken(
    connection: Connection,
    auth: Extract<
      ConnectionAuth,
      { mode: 'oauth2-client-credentials' } | { mode: 'oauth2-refresh' }
    >,
    workflowId: string,
  ): Promise<void> {
    const cached = await this.readCachedExpiry(workflowId, connection.id);
    if (
      cached !== undefined &&
      this.isUsable(cached) &&
      (await this.hasSecret(connection.id, ACCESS_TOKEN_SECRET_KEY))
    ) {
      return;
    }

    const inFlight = this.granting.get(connection.id);
    if (inFlight !== undefined) {
      const shared = await inFlight;
      // The shared grant only counts if it is still usable for US: a token that
      // aged out between the grant and this await is not good enough.
      if (this.isUsable(shared)) return;
    }

    const grant = this.grant(connection, auth, workflowId).finally(() => {
      this.granting.delete(connection.id);
    });
    this.granting.set(connection.id, grant);
    await grant;
  }

  /** True while at least {@link OAUTH_MIN_REMAINING_MS} of validity remains. */
  private isUsable(token: CachedTokenExpiry): boolean {
    return token.expiresAt - this.clock() >= OAUTH_MIN_REMAINING_MS;
  }

  /** The cache key: `{workflowId}::oauth:{connectionId}` (design §8.1). */
  private cacheKey(workflowId: string, connectionId: string): string {
    return scopedStateKey(workflowId, oauthStateKey(connectionId));
  }

  /** A malformed or absent cache entry reads as absent, never as an error. */
  private async readCachedExpiry(
    workflowId: string,
    connectionId: string,
  ): Promise<CachedTokenExpiry | undefined> {
    let raw: string | undefined;
    try {
      raw = (await this.state.get(this.cacheKey(workflowId, connectionId)))?.value;
    } catch {
      // A state-store hiccup must not fail a run that can simply grant again.
      return undefined;
    }
    if (raw === undefined) return undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<CachedTokenExpiry> | null;
      if (
        parsed === null ||
        typeof parsed.expiresAt !== 'number' ||
        !Number.isFinite(parsed.expiresAt)
      ) {
        return undefined;
      }
      return { expiresAt: parsed.expiresAt };
    } catch {
      return undefined;
    }
  }

  /**
   * Requirement 2.12: obtains a token, stores it in the keychain, caches its
   * expiry, and rejects with the connection and the `auth.mode` on any failure —
   * including a token too short-lived to be worth using.
   */
  private async grant(
    connection: Connection,
    auth: Extract<
      ConnectionAuth,
      { mode: 'oauth2-client-credentials' } | { mode: 'oauth2-refresh' }
    >,
    workflowId: string,
  ): Promise<CachedTokenExpiry> {
    const fail = (detail: string): never => {
      throw new Error(
        `Connection "${connection.name}" (${connection.id}) could not obtain an OAuth access token ` +
          `for auth mode ${auth.mode}: ${detail}`,
      );
    };

    if (auth.mode === 'oauth2-refresh') {
      // A refresh-token grant needs the refresh token in the REQUEST BODY, and
      // the desktop host deliberately never lets a secret value cross the IPC
      // boundary into the webview that would have to build that body
      // (Requirement 3.3). Rather than weaken that, the stored `accessToken` is
      // used while it lasts and the operator is told exactly what to do next.
      return fail(
        `the refresh grant cannot run on the desktop host, because it would require the refresh ` +
          `token in a request body built by the webview. Store a current "${ACCESS_TOKEN_SECRET_KEY}" ` +
          `secret for this connection, or run this workflow on a deployed worker.`,
      );
    }

    const tokenUrl = (auth.tokenUrl ?? '').trim();
    if (tokenUrl.length === 0) fail('the connection declares no token url.');
    for (const key of [auth.clientIdSecretKey, auth.clientSecretKey]) {
      if (!connection.secretKeys.includes(key)) {
        fail(`the secret "${key}" is not declared in secretKeys.`);
      }
    }

    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    if (auth.scope) body.set('scope', auth.scope);

    const requestedAt = this.clock();
    let response: TokenGrantResponse;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      // The client credentials are read from the keychain and applied INSIDE
      // Rust: the grant goes out authenticated without either value ever
      // reaching this code (Requirement 3.3).
      response = await invoke<TokenGrantResponse>('data_request', {
        connectionId: connection.id,
        secretKeys: [auth.clientIdSecretKey, auth.clientSecretKey],
        auth: {
          mode: 'basic',
          userSecretKey: auth.clientIdSecretKey,
          passwordSecretKey: auth.clientSecretKey,
        },
        request: {
          url: tokenUrl,
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: body.toString(),
          timeoutMs: OAUTH_REQUEST_TIMEOUT_MS,
          maxResponseBytes: OAUTH_MAX_RESPONSE_BYTES,
        },
      });
    } catch (error) {
      // Class of failure only: an identity provider's own message routinely
      // repeats the credentials it just rejected.
      return fail(`the token request to ${tokenUrl} failed (${grantFailureDetail(error)}).`);
    }

    if (response.status < 200 || response.status >= 300) {
      return fail(`the token endpoint answered HTTP ${response.status}.`);
    }

    let parsed: { access_token?: unknown; expires_in?: unknown };
    try {
      parsed = JSON.parse(response.body) as { access_token?: unknown; expires_in?: unknown };
    } catch {
      return fail('the token endpoint did not answer with JSON.');
    }
    if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
      return fail('the token endpoint returned no access token.');
    }

    const lifetimeSec =
      typeof parsed.expires_in === 'number' &&
      Number.isFinite(parsed.expires_in) &&
      parsed.expires_in > 0
        ? parsed.expires_in
        : OAUTH_DEFAULT_LIFETIME_SEC;
    const expiry: CachedTokenExpiry = { expiresAt: requestedAt + lifetimeSec * 1000 };
    if (!this.isUsable(expiry)) {
      return fail(
        `the returned token has under ${OAUTH_MIN_REMAINING_MS / 1000} seconds of validity left.`,
      );
    }

    // The token goes to the keychain, which is where `data_request` reads it
    // from as the connection's `accessToken` secret; only its expiry is cached
    // in the state store, so the weaker store never holds a credential.
    try {
      await this.storeSecret(connection.id, ACCESS_TOKEN_SECRET_KEY, parsed.access_token);
    } catch (error) {
      return fail(`the token could not be stored in the keychain (${grantFailureDetail(error)}).`);
    }
    try {
      // No `ttlSec`: the `oauth:` namespace never expires an entry, and the
      // token's own `expiresAt` is what decides freshness (Requirement 3.7).
      await this.state.set(this.cacheKey(workflowId, connection.id), JSON.stringify(expiry));
    } catch {
      /* an uncacheable expiry costs one extra grant, never a run */
    }
    return expiry;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Requirement 2.6: `secrets` and `config` are frozen, so a node that receives a
 * resolved connection cannot add, replace or delete an entry in the store's view
 * of it. Every declared name is present, with a sentinel where a value would be
 * on a host that lets values reach the caller.
 */
function freezeResolved(connection: Connection, secretKeys: readonly string[]): ResolvedConnection {
  const secrets: Record<string, string> = {};
  for (const key of secretKeys) secrets[key] = hostSecretSentinel(connection.id, key);

  const resolved: ResolvedConnection = {
    id: connection.id,
    type: connection.type,
    config: Object.freeze({ ...connection.config }),
    secrets: Object.freeze(secrets),
    auth: connection.auth,
    allowWrites: connection.allowWrites === true,
  };
  if (connection.limits !== undefined) resolved.limits = { ...connection.limits };
  return Object.freeze(resolved);
}

/**
 * Finds the connection id named by a sentinel anywhere in a built request.
 *
 * Two auth modes transform the sentinel on the way in, so both forms are
 * searched: `query` percent-encodes it into the url, and `basic` base64-encodes
 * it into the `Authorization` header.
 */
function findSentinelConnectionId(request: {
  url: string;
  headers: Record<string, string>;
}): string | undefined {
  const candidates = [request.url, decodeSafe(request.url)];
  for (const value of Object.values(request.headers ?? {})) {
    candidates.push(value);
    const basic = /^\s*Basic\s+(\S+)\s*$/i.exec(value);
    if (basic) candidates.push(base64DecodeSafe(basic[1]));
  }
  for (const candidate of candidates) {
    const match = SENTINEL_PATTERN.exec(candidate);
    if (match) return match[1];
  }
  return undefined;
}

/** A url that is not valid percent-encoding is searched as it stands. */
function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Non-base64 header values simply yield nothing to search. */
function base64DecodeSafe(value: string): string {
  try {
    return atob(value);
  } catch {
    return '';
  }
}

/** Failure class only, never a provider's own text. */
function grantFailureDetail(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'kind' in error) {
    const kind = (error as { kind?: unknown }).kind;
    if (typeof kind === 'string' && kind.length > 0) return kind;
  }
  if (error instanceof Error) return error.name;
  return 'unknown error';
}
