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
 * Cloudflare `wrangler secret` name. Always matches `^[A-Z][A-Z0-9_]*$`, which
 * is what `CloudService.putWorkerSecret` requires.
 */
export function workerSecretName(connectionId: string, secretKey: string): string {
  const norm = (s: string) => s.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  return `CONN_${norm(connectionId)}_${norm(secretKey)}`;
}
