import { Injectable, InjectionToken, computed, inject, signal } from '@angular/core';

import { McpOAuthService } from './mcp-oauth.service';
import { loadPhormaCloudUrl } from './phorma-cloud-url';
import { TauriService } from './tauri.service';

/**
 * Desktop sign-in: the browser handoff, and the credential it leaves behind.
 *
 * ## Why the desktop app cannot just use Clerk
 *
 * Clerk's in-webview flow CANNOT complete against a production instance. The
 * instance identifies a browser client with `__client`, a `SameSite=Lax` cookie on
 * `clerk.phorma-labs.com`, and this webview's origin (`http://tauri.localhost` on
 * Windows, `tauri://localhost` on macOS and Linux) is a different registrable
 * domain - so Chromium refuses both to store that cookie and to send it. clerk-js
 * is handed a fresh anonymous client on every call, and the Google round trip ends
 * on Clerk's own `authorization_invalid` error page. Measurements and the two
 * things that look like fixes but are not are in
 * `.kiro/specs/desktop-signin-handoff/requirements.md`.
 *
 * So Clerk still authenticates the human, in their real browser where cookies work,
 * and hands a Phorma credential back to this app.
 *
 * ## The flow
 *
 * 1. Mint a 256-bit code here and send only its SHA-256 to
 *    `POST /api/auth/device/start`.
 * 2. Open `/auth/device?c=<code>` in the system browser. That page is served by the
 *    worker on `cloud.phorma-labs.com`, which IS same-site with Clerk, so sign-in
 *    works there normally.
 * 3. The page claims the code with a verified Clerk session.
 * 4. Poll `POST /api/auth/device/redeem` until it returns a token, then hand it to
 *    the OS keychain.
 *
 * ## DI position - this must stay a leaf
 *
 * It injects `TauriService` and `McpOAuthService` only. `PhormaCloudService` injects
 * THIS service, and `PhormaCloudService` already sits on the
 * `RunControllerService -> ModelTransportService -> PhormaCloudService` path, so an
 * edge from here into `CloudService` or `RunControllerService` would close the
 * NG0200 cycle. The base URL therefore comes from `loadPhormaCloudUrl()` - the leaf
 * module that exists for exactly this reason - and never from `CloudService`.
 *
 * ## What is deliberately NOT here (lean v1)
 *
 * The token is long-lived and there is no server-side record of it, so it cannot be
 * revoked before it expires. `signOut()` deletes the keychain copy, which retires
 * THIS machine; a copy taken off a compromised machine keeps working until it
 * expires, and rotating `PHORMA_AUTH_SECRET` on the worker is the only global kill
 * switch. That trade bought a working sign-in now. The revocable design is in the
 * spec's `design.md`.
 */

/** Poll shape for the redeem loop, overridable so tests can shrink the clock. */
export interface DeviceAuthPollConfig {
  intervalMs: number;
  maxAttempts: number;
}

/**
 * 24 attempts, 5s apart - two minutes, matching `BILLING_POLL_CONFIG`.
 *
 * Same shape for the same reason: the user is off in a browser and may never come
 * back, so the loop must terminate on its own rather than run until the app is
 * closed. Two minutes is comfortably longer than a sign-in takes and short enough
 * that an abandoned attempt stops being a background request loop.
 */
export const DEVICE_AUTH_POLL_CONFIG = new InjectionToken<DeviceAuthPollConfig>(
  'phorma.deviceAuth.poll',
  { providedIn: 'root', factory: (): DeviceAuthPollConfig => ({ intervalMs: 5_000, maxAttempts: 24 }) },
);

/** Where the account email is remembered. Not a secret; the token is. */
const EMAIL_STORAGE_KEY = 'phorma.desktopAuth.email';

/** Where the account avatar URL is remembered. Also not a secret. */
const AVATAR_STORAGE_KEY = 'phorma.desktopAuth.imageUrl';

/**
 * The display-only half of a handoff: what to CALL the account, not what it may
 * do. One object rather than two parallel parameters through `store`/`adopt`/
 * storage, so a third display field does not triple the plumbing again.
 *
 * Both members are independently optional. A brand new account has no tenant row
 * and may supply neither; a user with no provider photo supplies only the email.
 */
export interface DesktopAccountDisplay {
  email: string | null;
  imageUrl: string | null;
}

/** Nothing to display. Used for a signed-out state and an unparseable payload. */
const NO_DISPLAY: DesktopAccountDisplay = { email: null, imageUrl: null };

/**
 * Re-checks an avatar URL before it can become an `<img src>`.
 *
 * The worker already applies the authoritative version of this
 * (`sanitizeClaimedImageUrl` in `cloud/src/device-auth.ts`), and this is not a
 * substitute for it. It exists because there is a SECOND source on this side -
 * `localStorage`, which anything running in the webview can write - and because
 * an older worker predating that sanitizer would send an unchecked value. Cheap,
 * local, and it fails to the account initial rather than to an error.
 */
export function isDisplayableAvatarUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.port.length === 0 &&
      url.hostname.toLowerCase().endsWith('.clerk.com')
    );
  } catch {
    return false;
  }
}

/** What the studio is currently doing about sign-in. */
export type DesktopAuthState = 'signed-out' | 'pending' | 'signed-in';

/** Why a handoff ended without a credential. */
export type DesktopAuthFailure =
  /** The user cancelled from the studio. */
  | 'cancelled'
  /** Nobody completed the browser sign-in inside the window. */
  | 'timed-out'
  /** The worker refused, or is not configured for desktop sign-in. */
  | 'refused'
  /** The worker could not be reached at all. */
  | 'unreachable';

/**
 * How the sign-in URL got in front of the user.
 *
 * `browser` is the happy path. `manual` means the system browser could not be
 * launched and the URL is being offered for the user to open themselves - which is
 * a WORKING sign-in, not a failure, so it is deliberately not a
 * {@link DesktopAuthFailure}.
 *
 * This distinction exists because the two were previously collapsed into
 * `'unreachable'`, which told a user to "check your connection" when the network
 * was fine and only `openUrl` had failed - and then abandoned a perfectly valid
 * one-time code instead of letting them paste the URL into a browser.
 */
export type DesktopAuthHandoff = 'browser' | 'manual';

@Injectable({ providedIn: 'root' })
export class DesktopAuthService {
  private readonly tauri = inject(TauriService);
  private readonly links = inject(McpOAuthService);
  private readonly poll = inject(DEVICE_AUTH_POLL_CONFIG);

  private readonly stateSignal = signal<DesktopAuthState>('signed-out');
  private readonly failureSignal = signal<DesktopAuthFailure | null>(null);
  private readonly userIdSignal = signal<string | null>(null);
  private readonly emailSignal = signal<string | null>(null);
  private readonly imageUrlSignal = signal<string | null>(null);

  /** Current sign-in state. */
  readonly state = this.stateSignal.asReadonly();
  /** Why the last attempt ended, when it ended badly. Cleared on a new attempt. */
  readonly failure = this.failureSignal.asReadonly();
  /** Clerk user id of the signed-in account, decoded from the token. */
  readonly userId = this.userIdSignal.asReadonly();
  /** Account email, when the sign-in page supplied one. Display only. */
  readonly email = this.emailSignal.asReadonly();
  /**
   * Account avatar URL, when the sign-in page supplied one. Display only.
   *
   * Null is the NORMAL case, not a failure: a user with no provider photo, an
   * install signed in against a worker older than this field, or a URL that did
   * not pass {@link isDisplayableAvatarUrl}. Callers fall back to the initial.
   */
  readonly imageUrl = this.imageUrlSignal.asReadonly();
  /** True once a credential is held. */
  readonly signedIn = computed(() => this.stateSignal() === 'signed-in');

  /**
   * The sign-in URL of the attempt in flight, and how it was delivered.
   *
   * Kept so a launch failure has a recovery path instead of a dead end - the same
   * reason `BillingService.lastUrl` exists, and the reason
   * `McpOAuthService.openExternal`'s own comment says a caller that needs one
   * should hold the URL. Null between attempts.
   */
  readonly pendingUrl = signal<string | null>(null);
  readonly handoff = signal<DesktopAuthHandoff>('browser');

  /**
   * Why the last launch or request failed, verbatim.
   *
   * Both failure paths used to `catch {}` and discard the error, which is why
   * "Could not reach Phorma Cloud" was shown for a `plugin-opener` permission
   * problem. This is display-and-log detail, never a control-flow signal.
   */
  readonly lastErrorDetail = signal<string | null>(null);

  /**
   * In-memory copy of the token.
   *
   * The keychain is the durable store; this avoids an IPC round trip per request
   * on the run path. Null means "not loaded yet OR signed out" - {@link token}
   * resolves that ambiguity by asking Rust once.
   */
  private cachedToken: string | null = null;
  private loaded = false;
  private cancelled = false;

  /**
   * Loads any credential left by a previous session.
   *
   * Called by `PhormaCloudService` at construction rather than run from a
   * constructor here, so the order is explicit and a browser build never pays for
   * it.
   */
  async restore(): Promise<void> {
    if (!this.tauri.isDesktop || this.loaded) return;
    this.loaded = true;
    const token = await this.readStoredToken();
    if (!token) return;
    this.adopt(token, loadStoredDisplay());
  }

  /**
   * Starts a browser handoff. Resolves true once a credential is held.
   *
   * Safe to call while one is already pending: the existing attempt is abandoned
   * first, so a user who clicks twice gets one live poll loop rather than two
   * racing ones.
   */
  async begin(onManualHandoff?: (url: string) => void): Promise<boolean> {
    if (!this.tauri.isDesktop) return false;
    this.cancel();
    this.cancelled = false;
    this.failureSignal.set(null);
    this.lastErrorDetail.set(null);
    this.handoff.set('browser');
    this.pendingUrl.set(null);
    this.stateSignal.set('pending');

    const base = loadPhormaCloudUrl().replace(/\/$/, '');
    const code = randomCode();

    let started: Response;
    try {
      started = await fetch(`${base}/api/auth/device/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codeHash: await sha256Hex(code) }),
      });
    } catch (error) {
      // A THROWN fetch here really is a network or CORS problem: the request never
      // got an answer. Recorded rather than swallowed, because the previous version
      // reported it identically to a failed browser launch.
      this.lastErrorDetail.set(`${base}/api/auth/device/start: ${messageOf(error)}`);
      return this.fail('unreachable');
    }
    if (!started.ok) {
      this.lastErrorDetail.set(`${base}/api/auth/device/start answered HTTP ${started.status}`);
      return this.fail('refused');
    }

    const signInUrl = `${base}/auth/device?c=${encodeURIComponent(code)}`;
    // Published BEFORE the launch attempt, so a failure has something to offer.
    this.pendingUrl.set(signInUrl);

    try {
      await this.links.openExternal(signInUrl);
    } catch (error) {
      // The code is minted, registered and valid for its full window, so a launch
      // failure is NOT a reason to abandon the attempt - it is a reason to let the
      // user open the URL themselves. Previously this returned `unreachable` and
      // threw away a working sign-in over a `plugin-opener` problem.
      this.lastErrorDetail.set(`Could not open the browser: ${messageOf(error)}`);
      this.handoff.set('manual');
      // Told to the caller NOW rather than on return: the poll below runs for two
      // minutes, and a URL handed over after the code expires is no use to anybody.
      onManualHandoff?.(signInUrl);
    }

    return await this.pollForToken(base, code);
  }

  /** Abandons a pending handoff. The code simply expires worker-side. */
  cancel(): void {
    if (this.stateSignal() !== 'pending') return;
    this.cancelled = true;
    this.stateSignal.set(this.cachedToken ? 'signed-in' : 'signed-out');
    this.failureSignal.set('cancelled');
  }

  /**
   * The bearer for Phorma Cloud calls, or null when signed out.
   *
   * Reads through to the keychain the first time, so a credential from a previous
   * session works without an explicit {@link restore}.
   */
  async token(): Promise<string | null> {
    if (!this.tauri.isDesktop) return null;
    if (this.cachedToken) return this.cachedToken;
    if (!this.loaded) await this.restore();
    return this.cachedToken;
  }

  /**
   * Forgets the credential on THIS machine.
   *
   * Lean v1 has no server-side revocation, so this retires the local copy and
   * nothing else - see the class comment. Deliberately does not fail loudly if the
   * keychain delete throws: the in-memory state is cleared either way, so the user
   * is signed out of the app even on a keychain error.
   */
  async signOut(): Promise<void> {
    this.cachedToken = null;
    this.userIdSignal.set(null);
    this.emailSignal.set(null);
    this.imageUrlSignal.set(null);
    this.stateSignal.set('signed-out');
    this.failureSignal.set(null);
    saveStoredDisplay(NO_DISPLAY);
    if (!this.tauri.isDesktop) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      // An empty value is the documented way to clear an entry: `set_secret`
      // routes it to `clear_secret_value`.
      await invoke('set_secret', { key: DEVICE_TOKEN_KEY, value: '' });
    } catch {
      // Nothing actionable, and the app-level state is already signed out.
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async pollForToken(base: string, code: string): Promise<boolean> {
    for (let attempt = 0; attempt < this.poll.maxAttempts; attempt++) {
      if (this.cancelled) return false;
      // Waits BEFORE the first attempt on purpose: the browser has not even opened
      // yet, so an immediate poll is guaranteed to be pending.
      await sleep(this.poll.intervalMs);
      if (this.cancelled) return false;

      let response: Response;
      try {
        response = await fetch(`${base}/api/auth/device/redeem`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
      } catch {
        // A transient network failure mid-poll is not fatal; keep trying until the
        // attempt budget runs out.
        continue;
      }

      if (response.status === 202) continue; // claimed by nobody yet
      if (response.status === 404) return this.fail('timed-out'); // expired or spent
      if (!response.ok) return this.fail('refused');

      const payload = (await response.json().catch(() => null)) as
        | { token?: unknown; email?: unknown; imageUrl?: unknown }
        | null;
      const token = typeof payload?.token === 'string' ? payload.token : null;
      if (!token) return this.fail('refused');

      await this.store(token, {
        email: typeof payload?.email === 'string' ? payload.email : null,
        imageUrl: isDisplayableAvatarUrl(payload?.imageUrl) ? payload.imageUrl : null,
      });
      return true;
    }
    return this.fail('timed-out');
  }

  private async store(token: string, display: DesktopAccountDisplay): Promise<void> {
    this.adopt(token, display);
    saveStoredDisplay(display);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_secret', { key: DEVICE_TOKEN_KEY, value: token });
    } catch {
      // The session still works for as long as the app stays open; only the
      // survive-a-restart part is lost, and reporting it here would interrupt a
      // sign-in that otherwise succeeded.
    }
  }

  /** Adopts a token into memory and derives the identity from it. */
  private adopt(token: string, display: DesktopAccountDisplay): void {
    this.cachedToken = token;
    // The user id comes from the TOKEN, not from storage, so the displayed account
    // can never drift from the credential actually being sent.
    this.userIdSignal.set(subjectOf(token));
    this.emailSignal.set(display.email);
    this.imageUrlSignal.set(display.imageUrl);
    this.stateSignal.set('signed-in');
  }

  private async readStoredToken(): Promise<string | null> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const stored = await invoke<string | null>('phorma_auth_token');
      return typeof stored === 'string' && stored.length > 0 ? stored : null;
    } catch {
      return null;
    }
  }

  private fail(reason: DesktopAuthFailure): false {
    this.failureSignal.set(reason);
    this.stateSignal.set(this.cachedToken ? 'signed-in' : 'signed-out');
    this.pendingUrl.set(null);
    return false;
  }
}

/** An error's message, without leaking a non-Error's internals. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Keychain entry name. Must match `DEVICE_TOKEN_KEY` in `llm.rs`. */
const DEVICE_TOKEN_KEY = 'phorma-auth:device-token';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** 32 CSPRNG bytes, base64url. The entire security of the exchange. */
function randomCode(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Reads the `sub` out of a device token's payload WITHOUT verifying it.
 *
 * Safe, and not a shortcut: the worker verifies the signature on every request, so
 * a tampered token buys nothing but a wrong name in the account card on the
 * attacker's own machine. Doing it here avoids a second store for the user id that
 * could drift from the credential.
 */
export function subjectOf(token: string): string | null {
  const body = token.replace(/^phd_/, '');
  const encoded = body.slice(0, body.indexOf('.'));
  if (!encoded) return null;
  try {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const payload = JSON.parse(json) as { s?: unknown };
    return typeof payload.s === 'string' && payload.s.length > 0 ? payload.s : null;
  } catch {
    return null;
  }
}

function loadStoredDisplay(): DesktopAccountDisplay {
  const imageUrl = readStored(AVATAR_STORAGE_KEY);
  return {
    email: readStored(EMAIL_STORAGE_KEY),
    // Re-checked on the way OUT of storage, not only on the way in: an install
    // that stored a value under an older, laxer rule must not keep rendering it.
    imageUrl: isDisplayableAvatarUrl(imageUrl) ? imageUrl : null,
  };
}

function saveStoredDisplay(display: DesktopAccountDisplay): void {
  writeStored(EMAIL_STORAGE_KEY, display.email);
  writeStored(AVATAR_STORAGE_KEY, display.imageUrl);
}

function readStored(key: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const value = localStorage.getItem(key);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Private-mode or quota failure. These are display niceties.
  }
}

