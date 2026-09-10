import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { InjectionToken, Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ClerkService, type ActiveSessionResource } from 'ngx-clerk';

import type { DateRange } from './models';

/**
 * The one transport every `/api/admin/*` surface in this dashboard shares.
 *
 * There are two of them now - the telemetry aggregates and the billing cost and
 * revenue reads - and they must behave identically about credentials, because
 * they sit behind the SAME operator allowlist on the Worker (`admin-auth.ts`
 * there). Two request paths would be two chances to send a blank bearer.
 *
 * Two requirements shape the design, and both are enforced structurally rather
 * than by discipline at each call site:
 *
 * - **10.2** every issued request carries `Authorization: Bearer <session token>`.
 * - **10.3** while no Clerk session exists, NO Admin_API request is issued.
 *
 * The mechanism is a one-way funnel. {@link AdminRequestService.get} resolves the
 * session token first and returns early when there is none; only `send()` builds a
 * request, and `send()` cannot be called without a {@link SessionToken}, which is
 * a branded type only {@link toSessionToken} can mint from a non-blank string. So
 * "issue a request with a missing or empty Authorization header" is not a code
 * path that typechecks, let alone one a view could reach.
 *
 * ## 401 and "no session" are DIFFERENT outcomes, and that is the point
 *
 * This used to map HTTP 401 onto `no-session`, which cost real debugging time on
 * 2026-09-09. The two failures are indistinguishable on screen but have opposite
 * causes and opposite remedies:
 *
 *   `no-session`        Clerk never produced a session in this browser. Nothing
 *                       was sent. The remedy is to sign in.
 *   `session-rejected`  A token WAS sent and the Worker refused it - it verifies
 *                       a different Clerk instance, or this origin is missing from
 *                       `CLERK_AUTHORIZED_PARTIES`. Signing in again cannot help;
 *                       the deployment is misconfigured.
 *
 * Rendering the sign-in screen for the second one tells an operator to do the one
 * thing that will not work, forever. So they are separate `AdminResult` kinds with
 * separate signals and separate surfaces.
 *
 * Both seams a test needs are injected: {@link SESSION_TOKEN_RESOLVER} for the
 * token and Angular's `HttpClient` for the transport.
 */

// --- The session token -----------------------------------------------------

declare const sessionTokenBrand: unique symbol;

/**
 * A non-blank Clerk session token. Nominal on purpose: holding one is the proof
 * that a request is allowed to be built, so the brand is what makes the
 * no-session case unrepresentable further down.
 */
export type SessionToken = string & { readonly [sessionTokenBrand]: true };

/**
 * The single mint. Anything blank, absent or not a string is `null` - an empty
 * string would otherwise become the header `Bearer `, which is exactly the shape
 * 10.3 forbids.
 */
export function toSessionToken(raw: string | null | undefined): SessionToken | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : (trimmed as SessionToken);
}

/**
 * Yields the current Clerk session token, or `null` when there is no session.
 * Never throws and never blocks on a session that may never arrive.
 */
export type SessionTokenResolver = () => Promise<string | null>;

/**
 * The resolver the transport uses. Overridable, which is how a test drives the
 * signed-out case without a Clerk instance.
 */
export const SESSION_TOKEN_RESOLVER = new InjectionToken<SessionTokenResolver>(
  'admin.sessionTokenResolver',
  { providedIn: 'root', factory: clerkSessionTokenResolver },
);

/**
 * The production resolver, over `ngx-clerk`.
 *
 * It tracks the latest `session$` emission rather than awaiting one. `session$`
 * is a `ReplaySubject` that only emits once Clerk has loaded, so awaiting it
 * would hang forever when the publishable key is a placeholder (see
 * `app.config.ts`) - and a hung resolver is indistinguishable from a hung
 * dashboard. Not-yet-emitted is treated as "no session", which is the honest
 * reading and the one that keeps 10.3 true during startup.
 *
 * NOTE, because it has bitten this dashboard: a Clerk PRODUCTION instance
 * enforces origin validation, so a `pk_live_` key on an origin the instance does
 * not allow never loads and `session$` never emits - which arrives here as "no
 * session" and renders the sign-in screen with no error anywhere. If the sign-in
 * screen appears for an account that is definitely signed in elsewhere, check the
 * instance's `allowed_origins` before anything in this package.
 */
export function clerkSessionTokenResolver(): SessionTokenResolver {
  const clerk = inject(ClerkService);
  let session: ActiveSessionResource | null = null;

  // Root-scoped and app-lifetime, so there is nothing to tear down.
  clerk.session$.subscribe((next) => {
    session = next ?? null;
  });

  return async () => {
    const active = session;
    if (active === null) return null;
    try {
      return await active.getToken();
    } catch {
      // A refresh failure is a missing token, not a dashboard error.
      return null;
    }
  };
}

// --- Call outcomes ---------------------------------------------------------

/**
 * What one Admin_API call can produce, as one discriminated union.
 *
 * Four of the five are separate kinds because the shell reacts differently to
 * each: sign-in surface (10.3), session-rejected surface, not-authorized state
 * (10.4), and a per-view error state with retry (10.12).
 */
export type AdminResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  /** No Clerk session, so no request was issued (10.3). */
  | { readonly kind: 'no-session' }
  /** A token WAS sent and the Worker answered 401. A configuration fault, not a sign-in one. */
  | { readonly kind: 'session-rejected' }
  /** The Admin_API answered 403 (10.4). */
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'failed'; readonly reason: string };

/** No Clerk session, so no request was issued (10.3). */
export const NO_SESSION = Object.freeze({ kind: 'no-session' } as const);

/**
 * The Worker refused a token we did send.
 *
 * Deliberately NOT folded into {@link NO_SESSION}: see the module header. This is
 * the outcome that says "the deployment is misconfigured", and it must not render
 * a sign-in button.
 */
export const SESSION_REJECTED = Object.freeze({ kind: 'session-rejected' } as const);

/** The Admin_API answered 403 (10.4). */
export const FORBIDDEN = Object.freeze({ kind: 'forbidden' } as const);

/** The single message a failure without usable copy falls back to. */
export const REQUEST_FAILURE_FALLBACK = 'Could not reach the admin API.';

export function isOk<T>(
  result: AdminResult<T>,
): result is { readonly kind: 'ok'; readonly value: T } {
  return result.kind === 'ok';
}

/**
 * Display copy for a failed request. The Admin_API answers `{ error: string }`
 * with a static reason, so that string is used when present; anything else falls
 * back rather than rendering `[object Object]` or a raw status line.
 */
export function describeRequestFailure(reason: unknown): string {
  if (reason instanceof HttpErrorResponse) {
    const body = reason.error as { error?: unknown } | null;
    const served = typeof body?.error === 'string' ? body.error.trim() : '';
    if (served !== '') return served;
    return REQUEST_FAILURE_FALLBACK;
  }
  if (typeof reason === 'string' && reason.trim() !== '') return reason.trim();
  if (reason instanceof Error && reason.message.trim() !== '') return reason.message.trim();
  return REQUEST_FAILURE_FALLBACK;
}

// --- The transport ---------------------------------------------------------

/**
 * The single place an Admin_API request is built, for every surface.
 *
 * The two auth signals live HERE rather than on each feature service, because
 * they describe the SESSION rather than a route: one operator allowlist gates
 * both prefixes on the Worker, so a 403 on a billing read and a 403 on a
 * telemetry read are the same fact and the shell must not have to poll two
 * services to notice it.
 */
@Injectable({ providedIn: 'root' })
export class AdminRequestService {
  private readonly http = inject(HttpClient);
  private readonly resolveToken = inject(SESSION_TOKEN_RESOLVER);

  private readonly forbiddenState = signal(false);
  private readonly sessionRejectedState = signal(false);

  /**
   * True once any call has been answered 403. The shell reads this to switch to
   * the not-authorized state (10.4); a later successful call clears it.
   */
  readonly forbidden = this.forbiddenState.asReadonly();

  /**
   * True once any call has been answered 401 for a token we actually sent. The
   * shell reads this to explain that the Worker rejected the session rather than
   * asking the operator to sign in again. A later successful call clears it.
   */
  readonly sessionRejected = this.sessionRejectedState.asReadonly();

  /**
   * The single gate. Resolves the session token FIRST and returns early when
   * there is none, so the no-session case never reaches `send` (10.3).
   *
   * `url` is absolute and already includes the route; the caller owns its own
   * prefix, which is what lets one transport serve two route families.
   */
  async get<T>(url: string, range: DateRange): Promise<AdminResult<T>> {
    const token = toSessionToken(await this.safeResolveToken());
    if (token === null) return NO_SESSION;
    return this.send<T>(url, range, token);
  }

  /** A resolver that throws is a missing token, not a dashboard error. */
  private async safeResolveToken(): Promise<string | null> {
    try {
      return await this.resolveToken();
    } catch {
      return null;
    }
  }

  /**
   * The ONLY place a request is built. Requires a `SessionToken`, so the bearer
   * header is always present and never empty (10.2).
   */
  private async send<T>(
    url: string,
    range: DateRange,
    token: SessionToken,
  ): Promise<AdminResult<T>> {
    try {
      const value = await firstValueFrom(
        this.http.get<T>(url, {
          headers: new HttpHeaders({ Authorization: `Bearer ${token}` }),
          params: new HttpParams({ fromObject: { from: range.from, to: range.to } }),
        }),
      );
      // A success clears BOTH auth states: whatever was wrong is no longer wrong,
      // and leaving either latched would strand the shell on a stale surface.
      this.forbiddenState.set(false);
      this.sessionRejectedState.set(false);
      return { kind: 'ok', value };
    } catch (reason) {
      if (reason instanceof HttpErrorResponse) {
        // 403: verified, but not an operator (10.4).
        if (reason.status === 403) {
          this.forbiddenState.set(true);
          return FORBIDDEN;
        }
        // 401: we HELD a token and the Worker refused it. Not the same as never
        // having had one - the remedy is a deployment fix, not a sign-in.
        if (reason.status === 401) {
          this.sessionRejectedState.set(true);
          return SESSION_REJECTED;
        }
      }
      return { kind: 'failed', reason: describeRequestFailure(reason) };
    }
  }
}
