/**
 * Connection: the credential entity (P1-1).
 *
 * A Connection is a named, typed credential bundle that lives OUTSIDE the
 * workflow spec. Nodes reference it by `id` only, which is what keeps specs
 * safe to export, diff, version and push: no secret value ever travels with a
 * `WorkflowSpec`.
 *
 * This module is pure declaration plus two naming helpers and one id
 * validator. Resolution (reading actual secret values) is a HOST concern —
 * see `ConnectionStore` in `engine/src/data-host.ts`.
 */

import type { SqlDriver } from './types.js';

/**
 * SQL driver families. Declared once in `engine/src/types.ts` so connection
 * metadata and `sql-query` node data share exactly one definition; re-exported
 * here because a connection's driver is part of the connection vocabulary.
 */
export type { SqlDriver };

/** Credential families a Connection can describe. */
export type ConnectionType = 'http' | 'oauth2' | 'sql' | 'aws-sigv4' | 'smtp';

/**
 * A named, typed credential bundle stored OUTSIDE the spec. Nodes reference it
 * by `id` only.
 */
export interface Connection {
  /** Referenced from `node.data.connectionId`. Stable, `conn-` prefixed. */
  id: string;
  /** Operator-facing label, 1 to 100 characters. */
  name: string;
  type: ConnectionType;
  /** Non-secret config: baseUrl, host, port, database, tokenUrl, region, driver. */
  config: Record<string, string>;
  /** Secret field NAMES only. Values live in the host's secret store. */
  secretKeys: string[];
  /** How auth is applied to an outbound request. Never templated by the user. */
  auth: ConnectionAuth;
  /**
   * Writes are opt-in ON THE CONNECTION, so a read-only credential cannot be
   * misused by any workflow that references it. Absent means false.
   */
  allowWrites?: boolean;
  /** SQL only: statement timeout, row and byte caps applied by the host. */
  limits?: SqlLimits;
  /** ISO-8601 UTC timestamp. */
  createdAt: string;
  /** ISO-8601 UTC timestamp. */
  updatedAt: string;
}

/** How the host applies the resolved secrets to an outbound request. */
export type ConnectionAuth =
  | { mode: 'none' }
  | { mode: 'bearer'; secretKey: string }
  | { mode: 'basic'; userSecretKey: string; passwordSecretKey: string }
  | { mode: 'basic-token'; tokenSecretKey: string }
  | { mode: 'header'; header: string; secretKey: string; prefix?: string }
  | { mode: 'query'; param: string; secretKey: string }
  | {
      mode: 'oauth2-client-credentials';
      tokenUrl: string;
      clientIdSecretKey: string;
      clientSecretKey: string;
      scope?: string;
    }
  | {
      mode: 'oauth2-refresh';
      tokenUrl: string;
      clientIdSecretKey: string;
      clientSecretKey: string;
      refreshTokenSecretKey: string;
    }
  | {
      mode: 'aws-sigv4';
      service: string;
      region: string;
      accessKeySecretKey: string;
      secretKeySecretKey: string;
    };

/** SQL guard rails carried by the connection and enforced by the host. */
export interface SqlLimits {
  /** Default 30_000. */
  statementTimeoutMs?: number;
  /** Default 10_000. */
  maxRows?: number;
  /** Default 4 * 1024 * 1024. */
  maxResultBytes?: number;
}

/**
 * A connection with its secret values resolved. Produced by the HOST at
 * execution time and NEVER serialised, logged, journaled, or emitted.
 */
export interface ResolvedConnection {
  id: string;
  type: ConnectionType;
  config: Readonly<Record<string, string>>;
  /** secretKey -> value. Redaction is seeded from these values. */
  secrets: Readonly<Record<string, string>>;
  auth: ConnectionAuth;
  /** Resolved from `Connection.allowWrites`, absent treated as false. */
  allowWrites: boolean;
  limits?: SqlLimits;
}

/** The non-secret projection safe for the palette, pickers and validation. */
export type ConnectionSummary = Omit<Connection, 'secretKeys'> & {
  /** Names only, already secret-free. */
  secretKeys: string[];
  /** Number of `secretKeys` actually present in the host's store. */
  secretsPresent: number;
  /**
   * The declared names the host's store does NOT hold, so validation can say
   * WHICH secret to set rather than only how many are missing. Still a name
   * list, so it is as secret-free as `secretKeys`. Optional for backwards
   * compatibility: a host that omits it falls back to the count.
   */
  missingSecretKeys?: string[];
  usedByWorkflowIds?: string[];
};

/** Every `Connection.id` must match this shape. */
export const CONNECTION_ID_PATTERN = /^conn-[A-Za-z0-9_-]{1,64}$/;

/** Keychain / secret-entry prefix for connection secrets on the desktop host. */
export const CONNECTION_SECRET_PREFIX = 'conn:';

/** True when `value` is a non-empty string matching {@link CONNECTION_ID_PATTERN}. */
export function isConnectionId(value: unknown): value is string {
  return typeof value === 'string' && CONNECTION_ID_PATTERN.test(value);
}

/**
 * Throws a message naming the rejected value when `value` is not a valid
 * connection id. Callers (every `ConnectionStore`) must run this BEFORE
 * reading any secret value.
 */
export function assertConnectionId(value: unknown): string {
  if (!isConnectionId(value)) {
    const shown = typeof value === 'string' ? `"${value}"` : String(value);
    throw new Error(
      `Invalid connection id ${shown}: expected a value matching ${CONNECTION_ID_PATTERN.source}.`,
    );
  }
  return value;
}

/** Host-agnostic secret entry name for one connection field. */
export function connectionSecretName(connectionId: string, secretKey: string): string {
  return `${CONNECTION_SECRET_PREFIX}${connectionId}:${secretKey}`;
}

/**
 * Every secret field name a `ConnectionAuth` descriptor POINTS AT, in
 * declaration order and without duplicates.
 *
 * `auth` never holds a value - it names which entry of the connection's secret
 * store to apply, which is why `basic` needs two names and the OAuth modes need
 * three. Authoring surfaces use this to keep `Connection.secretKeys` in step
 * with the selected auth mode automatically: a pointer to a name the connection
 * does not declare resolves to nothing at run time, and the operator has no way
 * to see why.
 */
export function authSecretKeyNames(auth: ConnectionAuth | undefined): string[] {
  if (!auth) return [];
  const names: string[] = [];
  switch (auth.mode) {
    case 'none':
      break;
    case 'bearer':
    case 'header':
    case 'query':
      names.push(auth.secretKey);
      break;
    case 'basic':
      names.push(auth.userSecretKey, auth.passwordSecretKey);
      break;
    case 'oauth2-client-credentials':
      names.push(auth.clientIdSecretKey, auth.clientSecretKey);
      break;
    case 'oauth2-refresh':
      names.push(auth.clientIdSecretKey, auth.clientSecretKey, auth.refreshTokenSecretKey);
      break;
    case 'aws-sigv4':
      names.push(auth.accessKeySecretKey, auth.secretKeySecretKey);
      break;
  }
  return [...new Set(names.map((name) => name.trim()).filter((name) => name.length > 0))];
}

/**
 * Cloudflare `wrangler secret` name. Always matches `^[A-Z][A-Z0-9_]*$`, which
 * is what `CloudService.putWorkerSecret` requires.
 */
export function workerSecretName(connectionId: string, secretKey: string): string {
  const norm = (s: string) => s.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  return `CONN_${norm(connectionId)}_${norm(secretKey)}`;
}

/**
 * Secrets Manager entry name for one connection field, under the prefix the
 * IaC_App owns. Deterministic, injective over (connectionId, secretKey), and
 * capped at 512 characters. Secrets Manager permits `/_+=.@-` in names, so the
 * connection id (already `^conn-[A-Za-z0-9_-]{1,64}$`) needs no escaping and
 * only the secret key is normalised.
 *
 * Shape: `{prefix}/conn/{connectionId}/{normalisedSecretKey}`
 *
 * The `/` separator is excluded from the normalised character class so that a
 * secret key value cannot forge a different (connectionId, secretKey) pair.
 */
export function awsSecretName(prefix: string, connectionId: string, secretKey: string): string {
  // Replace any character outside the safe set with `_XX` hex encoding.
  // Safe set: A-Z a-z 0-9 _ - . (no `/` - keeps the separator unambiguous).
  const normalised = secretKey.replace(/[^A-Za-z0-9_.\-]/g, (ch) => {
    const hex = ch.charCodeAt(0).toString(16).padStart(2, '0');
    return `_${hex}`;
  });
  const name = `${prefix}/conn/${connectionId}/${normalised}`;
  if (name.length > 512) {
    throw new Error(
      `awsSecretName exceeds 512 characters (got ${name.length}) for connectionId="${connectionId}", secretKey="${secretKey}".`,
    );
  }
  return name;
}
