/**
 * Xero token broker — one firm-owned OAuth app, N client organisations.
 *
 * The firm connects its Xero account once (standard OAuth authorization-code
 * flow, `offline_access` scope). This module holds the refresh token, mints
 * short-lived access tokens on demand, and resolves entity names to tenant
 * ids via GET /connections. Every Xero tool takes the entity/tenant as an
 * argument and goes through {@link xeroRequest}.
 *
 * Secrets (via ToolContext.env):
 * - XERO_CLIENT_ID / XERO_CLIENT_SECRET — the firm's OAuth app.
 * - XERO_REFRESH_TOKEN — seeded by the one-time connect flow.
 *
 * NOTE: Xero rotates refresh tokens on every refresh. The broker keeps the
 * newest one in memory; hosts that persist secrets should watch
 * `onRefreshTokenRotated`.
 */

import { apiFetch, requireEnv, type ToolContext } from './mcp.js';

const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONNECTIONS_URL = 'https://api.xero.com/connections';

interface CachedToken {
  accessToken: string;
  /** Epoch ms after which the token is considered stale (60s skew). */
  expiresAt: number;
}

export interface XeroConnection {
  tenantId: string;
  tenantName: string;
  tenantType: string;
}

export class XeroBroker {
  private cached: CachedToken | null = null;
  private connections: XeroConnection[] | null = null;
  private currentRefreshToken: string | null = null;
  /** In-flight refresh, shared by concurrent callers (single-flight). */
  private refreshing: Promise<string> | null = null;

  /** Hosts persist the rotated refresh token here (Xero rotates on use). */
  onRefreshTokenRotated?: (token: string) => void;

  async accessToken(ctx: ToolContext): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt) {
      return this.cached.accessToken;
    }
    // Single-flight: Xero ROTATES the refresh token on every refresh, so two
    // concurrent refreshes would race — the loser's rotated token is lost
    // and the stored token may be invalidated. Concurrent tool calls share
    // one refresh instead.
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshAccessToken(ctx).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refreshAccessToken(ctx: ToolContext): Promise<string> {
    const clientId = requireEnv(ctx, 'XERO_CLIENT_ID', 'Set the firm Xero OAuth app client id.');
    const clientSecret = requireEnv(ctx, 'XERO_CLIENT_SECRET', 'Set the firm Xero OAuth app client secret.');
    const refreshToken =
      this.currentRefreshToken ??
      requireEnv(ctx, 'XERO_REFRESH_TOKEN', 'Connect the firm Xero account first (one-time OAuth consent).');

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const { json } = await apiFetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      },
      body: body.toString(),
    });
    const token = json as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!token.access_token) throw new Error('Xero token refresh returned no access token.');

    if (token.refresh_token && token.refresh_token !== refreshToken) {
      this.currentRefreshToken = token.refresh_token;
      this.onRefreshTokenRotated?.(token.refresh_token);
    }
    this.cached = {
      accessToken: token.access_token,
      expiresAt: Date.now() + ((token.expires_in ?? 1800) - 60) * 1000,
    };
    return token.access_token;
  }

  /** Lists the firm's connected organisations (cached per process). */
  async listConnections(ctx: ToolContext): Promise<XeroConnection[]> {
    if (this.connections) return this.connections;
    const token = await this.accessToken(ctx);
    const { json } = await apiFetch(CONNECTIONS_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const list = (json as { tenantId: string; tenantName: string; tenantType: string }[]) ?? [];
    this.connections = list.map(item => ({
      tenantId: item.tenantId,
      tenantName: item.tenantName,
      tenantType: item.tenantType,
    }));
    return this.connections;
  }

  /**
   * Resolves an entity reference (tenant id OR organisation name, case
   * insensitive, partial match allowed when unambiguous) to a tenant id.
   */
  async resolveTenant(ctx: ToolContext, entity: string): Promise<XeroConnection> {
    const connections = await this.listConnections(ctx);
    const needle = entity.trim().toLowerCase();
    const byId = connections.find(conn => conn.tenantId.toLowerCase() === needle);
    if (byId) return byId;
    const exact = connections.filter(conn => conn.tenantName.toLowerCase() === needle);
    if (exact.length === 1) return exact[0];
    const partial = connections.filter(conn => conn.tenantName.toLowerCase().includes(needle));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      throw new Error(
        `Entity "${entity}" matches ${partial.length} organisations: ` +
          partial.map(conn => conn.tenantName).join(', ') +
          '. Be more specific or pass the tenant id.',
      );
    }
    throw new Error(
      `No connected Xero organisation matches "${entity}". Connected: ` +
        (connections.map(conn => conn.tenantName).join(', ') || '(none)'),
    );
  }
}

/** Makes an authenticated, tenant-scoped Xero API request. */
export async function xeroRequest(
  broker: XeroBroker,
  ctx: ToolContext,
  tenantId: string,
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  const token = await broker.accessToken(ctx);
  const { json } = await apiFetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Xero-Tenant-Id': tenantId,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  return json;
}
