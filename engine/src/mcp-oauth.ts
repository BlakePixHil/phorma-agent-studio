/**
 * MCP OAuth 2.1 client — the pure, framework-free half of interactive
 * authorization for remote (streamable-HTTP) MCP servers.
 *
 * Implements the discovery + PKCE + token-exchange logic from the MCP
 * authorization spec (2025-06-18): RFC 9728 protected-resource metadata,
 * RFC 8414 authorization-server metadata, RFC 7591 dynamic client
 * registration, PKCE (OAuth 2.1), and RFC 8707 resource indicators.
 *
 * This module NEVER opens a browser, receives a redirect, or persists tokens.
 * The HOST drives those (desktop opens the system browser + captures a
 * loopback callback; the studio/worker stores tokens). Keeping it pure means
 * it runs unchanged in the browser, the Tauri webview, and the Cloudflare
 * worker.
 */

/** OAuth 2.0 Protected Resource Metadata (RFC 9728), trimmed to what we use. */
export interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  /**
   * Scopes the RESOURCE understands. Many providers (e.g. GitHub) advertise
   * scopes here rather than on the authorization-server metadata, so callers
   * should prefer these when building the authorization request.
   */
  scopes_supported?: string[];
}

/** OAuth 2.0 Authorization Server Metadata (RFC 8414), trimmed. */
export interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
}

/** A registered (or pre-configured) OAuth client. */
export interface OAuthClientInfo {
  client_id: string;
  /** Present only for confidential clients; public clients omit it. */
  client_secret?: string;
}

/** The token set returned by the authorization server. */
export interface OAuthTokens {
  access_token: string;
  token_type?: string;
  /** Seconds until the access token expires. */
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  /** Absolute expiry (ms epoch), computed by this client for convenience. */
  expires_at?: number;
}

/** PKCE verifier/challenge pair. */
export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/**
 * Injected primitives so the client stays DOM-free. Browser/webview pass
 * `crypto.subtle` + `crypto.getRandomValues`; the worker passes the global
 * `crypto`. All are standard Web Crypto, available in every target.
 */
export interface OAuthCrypto {
  randomBytes(length: number): Uint8Array;
  sha256(data: Uint8Array): Promise<Uint8Array>;
}

/** Parameters needed to begin an authorization request. */
export interface BeginAuthOptions {
  /** Canonical MCP server URI (RFC 8707 resource indicator, no trailing slash). */
  resource: string;
  /** The loopback (or https) redirect URI the host will capture. */
  redirectUri: string;
  /** Requested scopes; falls back to the AS's advertised scopes. */
  scopes?: string[];
}

/** The authorization URL plus the state the host must round-trip back. */
export interface AuthRequest {
  authorizationUrl: string;
  state: string;
  pkce: PkcePair;
  redirectUri: string;
  resource: string;
}

/**
 * Builds the RFC 8414 / RFC 9728 well-known metadata URL candidates for a
 * given URL and metadata type. Per those specs the `.well-known/<type>`
 * segment is inserted BETWEEN the host and any path component; we also try the
 * root form for servers that host metadata there.
 *
 * Example for `https://api.example.com/mcp` and `oauth-protected-resource`:
 *   1. https://api.example.com/.well-known/oauth-protected-resource/mcp
 *   2. https://api.example.com/.well-known/oauth-protected-resource
 */
function wellKnownCandidates(url: string, type: string): string[] {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/$/, ''); // drop trailing slash
  const root = `${parsed.origin}/.well-known/${type}`;
  const candidates: string[] = [];
  if (path && path !== '') candidates.push(`${root}${path}`);
  candidates.push(root);
  return candidates;
}

/** Base64url without padding, per RFC 7636. */
function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = typeof btoa === 'function' ? btoa(binary) : bufferToBase64(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Node fallback when `btoa` is unavailable (worker has it; guard anyway). */
function bufferToBase64(binary: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const B = (globalThis as any).Buffer;
  if (B) return B.from(binary, 'binary').toString('base64');
  throw new Error('No base64 encoder available in this environment.');
}

/** Strips a trailing slash and any fragment to form the canonical resource URI. */
export function canonicalResourceUri(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  let out = parsed.toString();
  if (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * Parses the `resource_metadata` URL out of a 401's `WWW-Authenticate` header,
 * per RFC 9728 §5.1. Returns `null` when absent.
 */
export function parseResourceMetadataUrl(wwwAuthenticate: string | null): string | null {
  if (!wwwAuthenticate) return null;
  const match = /resource_metadata="([^"]+)"/i.exec(wwwAuthenticate);
  return match ? match[1] : null;
}

export class McpOAuthClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly crypto: OAuthCrypto,
    fetchImpl?: typeof fetch,
  ) {
    // `fetch` MUST be called with `this` bound to the global (window/worker):
    // browsers throw "can only call window.fetch on instances of window" if it
    // is invoked as a method of another object (e.g. `this.fetchImpl(...)`).
    this.fetchImpl = (fetchImpl ?? globalThis.fetch).bind(globalThis);
  }

  /** Generates a PKCE verifier/challenge pair (S256). */
  async createPkce(): Promise<PkcePair> {
    const verifier = base64Url(this.crypto.randomBytes(32));
    const challenge = base64Url(await this.crypto.sha256(encodeUtf8(verifier)));
    return { verifier, challenge, method: 'S256' };
  }

  /** A random, URL-safe state / nonce value. */
  randomState(): string {
    return base64Url(this.crypto.randomBytes(16));
  }

  /**
   * Discovers the protected-resource metadata for an MCP server. Prefers the
   * `resource_metadata` URL from a 401 `WWW-Authenticate` header; otherwise
   * tries the RFC 9728 well-known locations (path-aware, then root).
   */
  async discoverProtectedResource(
    serverUrl: string,
    resourceMetadataUrl?: string | null,
  ): Promise<ProtectedResourceMetadata> {
    const candidates = resourceMetadataUrl
      ? [resourceMetadataUrl]
      : wellKnownCandidates(serverUrl, 'oauth-protected-resource');
    return this.fetchFirstJson<ProtectedResourceMetadata>(
      candidates,
      'Could not load MCP protected-resource metadata',
    );
  }

  /**
   * Fetches OAuth 2.0 Authorization Server Metadata (RFC 8414), trying the
   * path-aware well-known location, the root, and the OIDC discovery doc.
   */
  async discoverAuthServer(authServerUrl: string): Promise<AuthServerMetadata> {
    const candidates = [
      ...wellKnownCandidates(authServerUrl, 'oauth-authorization-server'),
      ...wellKnownCandidates(authServerUrl, 'openid-configuration'),
    ];
    return this.fetchFirstJson<AuthServerMetadata>(
      candidates,
      'Could not load OAuth authorization-server metadata',
    );
  }

  /**
   * Fetches the first candidate URL that returns a 2xx JSON document. Reports
   * the last status seen when all candidates fail.
   */
  private async fetchFirstJson<T>(urls: string[], errorPrefix: string): Promise<T> {
    let lastStatus = 0;
    for (const url of urls) {
      try {
        const response = await this.fetchImpl(url, { headers: { Accept: 'application/json' } });
        if (response.ok) return (await response.json()) as T;
        lastStatus = response.status;
      } catch {
        // Network/CORS failure on this candidate — try the next one.
      }
    }
    throw new Error(`${errorPrefix} (HTTP ${lastStatus || 'unreachable'}).`);
  }

  /**
   * Registers a public client via Dynamic Client Registration (RFC 7591).
   * Used when the AS advertises a `registration_endpoint` and no client id is
   * pre-configured.
   */
  async registerClient(
    metadata: AuthServerMetadata,
    redirectUri: string,
    clientName = 'Phorma Agent Studio',
  ): Promise<OAuthClientInfo> {
    if (!metadata.registration_endpoint) {
      throw new Error('Authorization server does not support dynamic client registration.');
    }
    const response = await this.fetchImpl(metadata.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none', // public client (PKCE)
      }),
    });
    if (!response.ok) {
      throw new Error(`Dynamic client registration failed (HTTP ${response.status}).`);
    }
    return (await response.json()) as OAuthClientInfo;
  }

  /**
   * Builds the authorization URL (with PKCE challenge, state, and the RFC 8707
   * `resource` parameter). The host opens this in a browser.
   */
  async buildAuthorizationRequest(
    metadata: AuthServerMetadata,
    client: OAuthClientInfo,
    options: BeginAuthOptions,
  ): Promise<AuthRequest> {
    const pkce = await this.createPkce();
    const state = this.randomState();
    const scopes = options.scopes ?? metadata.scopes_supported ?? [];
    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', client.client_id);
    url.searchParams.set('redirect_uri', options.redirectUri);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    // RFC 8707: MUST send resource on authorize + token, even if AS ignores it.
    url.searchParams.set('resource', options.resource);
    if (scopes.length) url.searchParams.set('scope', scopes.join(' '));
    return { authorizationUrl: url.toString(), state, pkce, redirectUri: options.redirectUri, resource: options.resource };
  }

  /** Exchanges an authorization code for tokens (PKCE + resource). */
  async exchangeCode(
    metadata: AuthServerMetadata,
    client: OAuthClientInfo,
    params: { code: string; pkce: PkcePair; redirectUri: string; resource: string },
  ): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: client.client_id,
      code_verifier: params.pkce.verifier,
      resource: params.resource,
    });
    if (client.client_secret) body.set('client_secret', client.client_secret);
    return this.tokenRequest(metadata, body);
  }

  /** Refreshes an access token using a refresh token (+ resource). */
  async refresh(
    metadata: AuthServerMetadata,
    client: OAuthClientInfo,
    params: { refreshToken: string; resource: string; scopes?: string[] },
  ): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: params.refreshToken,
      client_id: client.client_id,
      resource: params.resource,
    });
    if (client.client_secret) body.set('client_secret', client.client_secret);
    if (params.scopes?.length) body.set('scope', params.scopes.join(' '));
    return this.tokenRequest(metadata, body);
  }

  private async tokenRequest(metadata: AuthServerMetadata, body: URLSearchParams): Promise<OAuthTokens> {
    const response = await this.fetchImpl(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`OAuth token request failed (HTTP ${response.status}): ${text}`);
    }
    // Some providers (notably GitHub) return HTTP 200 with an `error` field in
    // the body instead of a 4xx status — surface those as failures too.
    const tokens = JSON.parse(text) as OAuthTokens & { error?: string; error_description?: string };
    if (tokens.error) {
      throw new Error(
        `OAuth token request failed: ${tokens.error_description ?? tokens.error}`,
      );
    }
    if (!tokens.access_token) {
      throw new Error('OAuth token response did not include an access token.');
    }
    if (typeof tokens.expires_in === 'number') {
      tokens.expires_at = Date.now() + tokens.expires_in * 1000;
    }
    return tokens;
  }
}

/** Encodes a string as UTF-8 bytes (TextEncoder is available in all targets). */
function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
