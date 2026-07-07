import { inject, Injectable } from '@angular/core';

import {
  McpOAuthClient,
  canonicalResourceUri,
  parseResourceMetadataUrl,
  type AuthServerMetadata,
  type OAuthClientInfo,
  type OAuthCrypto,
  type OAuthTokens,
} from '@phorma/engine';

import { SettingsService } from './settings.service';
import { TauriService } from './tauri.service';

/** Persisted OAuth session for a remote MCP node (minus the access token). */
interface StoredOAuthSession {
  tokens: OAuthTokens;
  metadata: AuthServerMetadata;
  client: OAuthClientInfo;
  resource: string;
  scopes?: string[];
}

/** Refresh a token this many ms before it actually expires. */
const REFRESH_SKEW_MS = 60_000;

/**
 * Preferred desktop loopback port, so the redirect URI is stable and users can
 * register it once with providers that require a fixed callback (e.g. GitHub).
 */
const OAUTH_LOOPBACK_PORT = 7328;

/**
 * Orchestrates interactive MCP OAuth 2.1 for remote (`sse`) tool nodes.
 *
 * Ties together the framework-free {@link McpOAuthClient} (discovery, PKCE,
 * token exchange, refresh) with the host-specific pieces it cannot do itself:
 * opening the system browser and capturing the redirect. On desktop that's a
 * Rust loopback listener; in the browser it's a popup + postMessage. Tokens
 * live in the OS keychain (desktop) or localStorage (browser), never in the
 * workflow file.
 */
@Injectable({ providedIn: 'root' })
export class McpOAuthService {
  private readonly tauri = inject(TauriService);
  private readonly settings = inject(SettingsService);

  // Route the OAuth client's HTTP through Rust on desktop (the webview blocks
  // cross-origin fetches to the auth server / well-known endpoints — same
  // reason LLM + HTTP-tool calls go through the backend). Arrow fn so the
  // engine's `.bind(globalThis)` can't strip our `this`.
  private readonly client = new McpOAuthClient(browserCrypto(), (input, init) =>
    this.routedFetch(input, init),
  );

  /** The secret key under which a node's OAuth session JSON is stored. */
  private sessionKey(nodeId: string): string {
    return `mcp-oauth:${nodeId}`;
  }

  /** The secret key under which a node's pre-registered OAuth client is stored. */
  private clientKey(nodeId: string): string {
    return `mcp-oauth-client:${nodeId}`;
  }

  /**
   * Stores a user-provided OAuth client (id + optional secret) for servers
   * whose authorization server lacks dynamic client registration. Some
   * providers (e.g. GitHub) REQUIRE the secret at the token endpoint even for
   * public clients — PKCE still binds the code to this login attempt.
   */
  async setClientCredentials(nodeId: string, clientId: string, clientSecret?: string): Promise<void> {
    const value = JSON.stringify({ client_id: clientId.trim(), client_secret: clientSecret?.trim() || undefined });
    await this.settings.setMcpSecret(nodeId, this.clientKey(nodeId), clientId.trim() ? value : '');
  }

  /** Whether a node has stored OAuth client credentials. */
  async hasClientCredentials(nodeId: string): Promise<boolean> {
    return (await this.loadClient(nodeId)) !== null;
  }

  private async loadClient(nodeId: string): Promise<OAuthClientInfo | null> {
    const raw = await this.settings.resolveMcpBearer(nodeId, this.clientKey(nodeId));
    if (!raw) return null;
    try {
      const client = JSON.parse(raw) as OAuthClientInfo;
      return client.client_id ? client : null;
    } catch {
      return null;
    }
  }

  /**
   * Resolves the OAuth client to use: a user-provided client id wins; else
   * dynamic client registration. Throws a helpful message when the AS supports
   * neither so the UI can prompt for a client id.
   */
  private async resolveClient(
    nodeId: string,
    metadata: AuthServerMetadata,
    redirectUri: string,
    fallbackClient?: OAuthClientInfo,
  ): Promise<OAuthClientInfo> {
    const stored = await this.loadClient(nodeId);
    if (stored) return stored;
    if (fallbackClient?.client_id) return fallbackClient;
    if (metadata.registration_endpoint) {
      return this.client.registerClient(metadata, redirectUri);
    }
    throw new Error(
      'This provider needs a one-time app setup — follow the “One-time setup” steps in the panel, then connect again.',
    );
  }

  /**
   * Runs the full interactive authorization flow for a remote MCP server and
   * persists the resulting tokens. Returns the access token on success.
   *
   * @throws When discovery, consent, or the token exchange fails.
   */
  async connect(
    nodeId: string,
    serverUrl: string,
    options?: { fallbackClient?: OAuthClientInfo },
  ): Promise<string> {
    const resource = canonicalResourceUri(serverUrl);

    // 1. Discover the protected-resource metadata (probe for the 401 hint).
    const resourceMetadataUrl = await this.probeResourceMetadataUrl(serverUrl);
    const prm = await this.client.discoverProtectedResource(serverUrl, resourceMetadataUrl);
    const authServer = prm.authorization_servers?.[0];
    if (!authServer) {
      throw new Error('This MCP server did not advertise an OAuth authorization server.');
    }

    // 2. Discover the authorization-server metadata.
    const metadata = await this.client.discoverAuthServer(authServer);

    // Scopes: prefer the resource's advertised scopes (RFC 9728) — providers
    // like GitHub list them ONLY there, and an empty scope yields a token
    // with no useful grants.
    const scopes = prm.scopes_supported ?? metadata.scopes_supported;

    // 3. Reserve a redirect URI (loopback on desktop; app origin in browser).
    const { redirectUri, capture } = await this.beginCallbackCapture();

    try {
      // 4. Obtain a client: user-stored credentials win; then any preset
      // default client; then dynamic registration (RFC 7591).
      const client = await this.resolveClient(nodeId, metadata, redirectUri, options?.fallbackClient);

      // 5. Build the authorization request and open the browser.
      const request = await this.client.buildAuthorizationRequest(metadata, client, {
        resource,
        redirectUri,
        scopes,
      });
      const popup = await this.openBrowser(request.authorizationUrl);
      capture.trackPopup?.(popup);

      // 6. Wait for the redirect, validate state, exchange the code.
      const callback = await capture();
      if (callback.error) {
        throw new Error(`Authorization was denied: ${callback.error_description ?? callback.error}`);
      }
      if (!callback.code) throw new Error('No authorization code was returned.');
      if (callback.state !== request.state) {
        throw new Error('OAuth state mismatch — aborting to prevent a CSRF/redirect attack.');
      }

      const tokens = await this.client.exchangeCode(metadata, client, {
        code: callback.code,
        pkce: request.pkce,
        redirectUri,
        resource,
      });

      await this.storeSession(nodeId, { tokens, metadata, client, resource, scopes });
      return tokens.access_token;
    } finally {
      capture.cancel?.();
    }
  }

  /**
   * Returns a valid access token for a node, refreshing it if it has expired
   * (or is about to). Returns `null` when the node has never connected.
   */
  async validAccessToken(nodeId: string): Promise<string | null> {
    const session = await this.loadSession(nodeId);
    if (!session) return null;

    const { tokens } = session;
    const expiresSoon = tokens.expires_at !== undefined && tokens.expires_at - REFRESH_SKEW_MS <= Date.now();
    if (!expiresSoon) return tokens.access_token;

    if (!tokens.refresh_token) return tokens.access_token; // best effort; may 401
    const refreshed = await this.client.refresh(session.metadata, session.client, {
      refreshToken: tokens.refresh_token,
      resource: session.resource,
      scopes: session.scopes,
    });
    // Preserve a refresh token if the AS didn't rotate one back.
    if (!refreshed.refresh_token) refreshed.refresh_token = tokens.refresh_token;
    await this.storeSession(nodeId, { ...session, tokens: refreshed });
    return refreshed.access_token;
  }

  /** Whether a node has a stored OAuth session. */
  async isConnected(nodeId: string): Promise<boolean> {
    return (await this.loadSession(nodeId)) !== null;
  }

  /**
   * The redirect URI the user must register with their OAuth provider. Stable
   * loopback on desktop; the app-origin callback page in the browser.
   */
  redirectUriHint(): string {
    return this.tauri.isDesktop
      ? `http://127.0.0.1:${OAUTH_LOOPBACK_PORT}/callback`
      : `${window.location.origin}/oauth/callback.html`;
  }

  /** Clears a node's stored OAuth session (disconnect). */
  async disconnect(nodeId: string): Promise<void> {
    await this.settings.setMcpSecret(nodeId, this.sessionKey(nodeId), '');
  }

  // ── Host-specific callback capture ─────────────────────────────────────────

  /**
   * Reserves a redirect URI and returns a `capture()` that resolves with the
   * OAuth query params once the browser redirects back.
   */
  private async beginCallbackCapture(): Promise<{
    redirectUri: string;
    capture: CallbackCapture;
  }> {
    if (this.tauri.isDesktop) return this.desktopCapture();
    return this.browserCapture();
  }

  /**
   * Desktop: a Rust loopback listener. Prefers a stable port so users can
   * register a fixed redirect URI with providers (e.g. GitHub OAuth apps
   * require an exact callback URL); falls back to ephemeral if taken.
   */
  private async desktopCapture(): Promise<{ redirectUri: string; capture: CallbackCapture }> {
    const { invoke } = await import('@tauri-apps/api/core');
    const started = await invoke<{ listenerId: string; redirectUri: string }>('oauth_loopback_start', {
      preferredPort: OAUTH_LOOPBACK_PORT,
    });
    const capture: CallbackCapture = () =>
      invoke<OAuthCallback>('oauth_loopback_wait', { listenerId: started.listenerId });
    capture.cancel = () => {
      void invoke('oauth_loopback_cancel', { listenerId: started.listenerId }).catch(() => undefined);
    };
    return { redirectUri: started.redirectUri, capture };
  }

  /**
   * Browser: redirect back to a static callback route on the app origin, with
   * the popup posting its query params back via `postMessage`.
   */
  private async browserCapture(): Promise<{ redirectUri: string; capture: CallbackCapture }> {
    const redirectUri = `${window.location.origin}/oauth/callback.html`;
    let popup: Window | null = null;
    const capture: CallbackCapture = () =>
      new Promise<OAuthCallback>((resolve, reject) => {
        const timer = setTimeout(() => {
          window.removeEventListener('message', onMessage);
          reject(new Error('Timed out waiting for OAuth consent.'));
        }, 300_000);
        const onMessage = (event: MessageEvent) => {
          if (event.origin !== window.location.origin) return;
          const data = event.data as { type?: string } & OAuthCallback;
          if (data?.type !== 'phorma-oauth-callback') return;
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          resolve(data);
        };
        window.addEventListener('message', onMessage);
      });
    capture.cancel = () => popup?.close();
    // Popup is opened by openBrowser(); track it so cancel() can close it.
    capture.trackPopup = (win: Window | null) => {
      popup = win;
    };
    return { redirectUri, capture };
  }

  /**
   * Opens the authorization URL: system browser on desktop, popup in browser.
   * Returns the popup window (browser only) so it can be tracked/closed.
   */
  private async openBrowser(url: string): Promise<Window | null> {
    if (this.tauri.isDesktop) {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
      return null;
    }
    return window.open(url, 'phorma-oauth', 'popup,width=520,height=720');
  }

  /**
   * Opens any URL in the user's browser (system browser on desktop, new tab
   * in browser mode). Used by guided OAuth-app setup links.
   */
  async openExternal(url: string): Promise<void> {
    if (this.tauri.isDesktop) {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
      return;
    }
    window.open(url, '_blank', 'noopener');
  }

  // ── Session storage (reuses the MCP secret keychain path) ───────────────────

  private async storeSession(nodeId: string, session: StoredOAuthSession): Promise<void> {
    await this.settings.setMcpSecret(nodeId, this.sessionKey(nodeId), JSON.stringify(session));
  }

  private async loadSession(nodeId: string): Promise<StoredOAuthSession | null> {
    const raw = await this.settings.resolveMcpBearer(nodeId, this.sessionKey(nodeId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredOAuthSession;
    } catch {
      return null;
    }
  }

  /**
   * Best-effort probe to read the `resource_metadata` URL from a 401's
   * `WWW-Authenticate` header. Returns `null` when the server answers without
   * the hint (we fall back to the well-known path).
   */
  private async probeResourceMetadataUrl(serverUrl: string): Promise<string | null> {
    try {
      const response = await this.routedFetch(serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
      });
      if (response.status === 401) {
        return parseResourceMetadataUrl(response.headers.get('WWW-Authenticate'));
      }
    } catch {
      // Network/CORS failure — fall back to the well-known path.
    }
    return null;
  }

  /**
   * Fetch that routes through the Rust backend on desktop (no webview CORS)
   * and uses plain `fetch` in the browser. Returns a standard `Response` so
   * the engine's OAuth client is environment-agnostic.
   */
  private async routedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (!this.tauri.isDesktop) return fetch(input, init);

    const url = typeof input === 'string' ? input : input.toString();
    const { invoke } = await import('@tauri-apps/api/core');
    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value;
      });
    }
    const result = await invoke<{ status: number; body: string; headers?: Record<string, string> }>(
      'http_request',
      {
        url,
        method: (init?.method ?? 'GET').toUpperCase(),
        headers,
        body: typeof init?.body === 'string' ? init.body : null,
      },
    );
    return new Response(result.body, {
      status: result.status,
      headers: result.headers ?? {},
    });
  }
}

/** The query params captured from an OAuth redirect. */
interface OAuthCallback {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

/** A one-shot capture function with optional lifecycle hooks. */
interface CallbackCapture {
  (): Promise<OAuthCallback>;
  cancel?: () => void;
  trackPopup?: (win: Window | null) => void;
}

/** Web Crypto adapter for the engine's {@link OAuthCrypto} contract. */
function browserCrypto(): OAuthCrypto {
  return {
    randomBytes: (length: number) => crypto.getRandomValues(new Uint8Array(length)),
    sha256: async (data: Uint8Array) => {
      // Copy into a fresh ArrayBuffer-backed view so the type is a plain
      // ArrayBuffer (not ArrayBufferLike) for `digest`'s BufferSource param.
      const buffer = new ArrayBuffer(data.byteLength);
      new Uint8Array(buffer).set(data);
      return new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
    },
  };
}
