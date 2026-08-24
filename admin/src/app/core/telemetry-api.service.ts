import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { InjectionToken, Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ClerkService, type ActiveSessionResource } from 'ngx-clerk';

import { environment } from '../../environments/environment';
import type {
  DateRange,
  EnvironmentResponse,
  FeaturesResponse,
  GeographyResponse,
  SummaryResponse,
  TelemetryRoute,
  TrendResponse,
} from './models';

/**
 * The ONLY way this package talks to the Admin_API.
 *
 * Two requirements shape the design, and both are enforced structurally rather
 * than by discipline at each call site:
 *
 * - **10.2** every issued request carries `Authorization: Bearer <session token>`.
 * - **10.3** while no Clerk session exists, NO Admin_API request is issued.
 *
 * The mechanism is a one-way funnel. `request()` resolves the session token
 * first and returns early when there is none; only `send()` builds a request,
 * and `send()` cannot be called without a `SessionToken`, which is a branded
 * type only `toSessionToken` can mint from a non-blank string. So "issue a
 * request with a missing or empty Authorization header" is not a code path that
 * typechecks, let alone one a view could reach.
 *
 * Both seams a test needs are injected: `SESSION_TOKEN_RESOLVER` for the token
 * and Angular's `HttpClient` for the transport.
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
 * The resolver the service uses. Overridable, which is how a test drives the
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
 * `no-session` and `forbidden` are separate outcomes from `failed` because the
 * shell reacts differently to each: sign-in surface (10.3), not-authorized state
 * (10.4), and a per-view error state with retry (10.12).
 */
export type AdminResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'no-session' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'failed'; readonly reason: string };

/** No Clerk session, so no request was issued (10.3). */
export const NO_SESSION = Object.freeze({ kind: 'no-session' } as const);

/** The Admin_API answered 403 (10.4). */
export const FORBIDDEN = Object.freeze({ kind: 'forbidden' } as const);

/** The single message a failure without usable copy falls back to. */
export const REQUEST_FAILURE_FALLBACK = 'Could not reach the telemetry API.';

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

// --- The service -----------------------------------------------------------

/** Path prefix the Admin_API owns. Twin of `TELEMETRY_ADMIN_PREFIX` in `cloud/`. */
export const TELEMETRY_ADMIN_PREFIX = '/api/admin/telemetry/';

@Injectable({ providedIn: 'root' })
export class TelemetryApiService {
  private readonly http = inject(HttpClient);
  private readonly resolveToken = inject(SESSION_TOKEN_RESOLVER);
  private readonly baseUrl = environment.apiBaseUrl.replace(/\/+$/, '');

  private readonly forbiddenState = signal(false);

  /**
   * True once any call has been answered 403. The shell reads this to switch to
   * the not-authorized state (10.4); a later successful call clears it.
   */
  readonly forbidden = this.forbiddenState.asReadonly();

  /** Active installs for 1/7/30 days plus range totals (10.5). */
  fetchSummary(range: DateRange): Promise<AdminResult<SummaryResponse>> {
    return this.request<SummaryResponse>('summary', range);
  }

  /** Installs and runs by country and by region (10.6). */
  fetchGeography(range: DateRange): Promise<AdminResult<GeographyResponse>> {
    return this.request<GeographyResponse>('geography', range);
  }

  /** Installs by app version, platform, runtime mode and locale (10.7). */
  fetchEnvironment(range: DateRange): Promise<AdminResult<EnvironmentResponse>> {
    return this.request<EnvironmentResponse>('environment', range);
  }

  /** Summed Counter values grouped by Counter name (10.8). */
  fetchFeatures(range: DateRange): Promise<AdminResult<FeaturesResponse>> {
    return this.request<FeaturesResponse>('features', range);
  }

  /** Per-day installs, sessions and runs (10.9). */
  fetchTrend(range: DateRange): Promise<AdminResult<TrendResponse>> {
    return this.request<TrendResponse>('trend', range);
  }

  /** The absolute URL of one aggregate route. */
  url(route: TelemetryRoute): string {
    return `${this.baseUrl}${TELEMETRY_ADMIN_PREFIX}${route}`;
  }

  /**
   * The single gate. Resolves the session token FIRST and returns early when
   * there is none, so the no-session case never reaches `send` (10.3).
   */
  private async request<T>(route: TelemetryRoute, range: DateRange): Promise<AdminResult<T>> {
    const token = toSessionToken(await this.safeResolveToken());
    if (token === null) return NO_SESSION;
    return this.send<T>(route, range, token);
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
    route: TelemetryRoute,
    range: DateRange,
    token: SessionToken,
  ): Promise<AdminResult<T>> {
    try {
      const value = await firstValueFrom(
        this.http.get<T>(this.url(route), {
          headers: new HttpHeaders({ Authorization: `Bearer ${token}` }),
          params: new HttpParams({ fromObject: { from: range.from, to: range.to } }),
        }),
      );
      this.forbiddenState.set(false);
      return { kind: 'ok', value };
    } catch (reason) {
      if (reason instanceof HttpErrorResponse) {
        // 403: verified, but not an owner (10.4).
        if (reason.status === 403) {
          this.forbiddenState.set(true);
          return FORBIDDEN;
        }
        // 401: the token the browser held is no longer a session. Same surface
        // as never having had one, so the shell renders sign-in (10.3).
        if (reason.status === 401) return NO_SESSION;
      }
      return { kind: 'failed', reason: describeRequestFailure(reason) };
    }
  }
}
