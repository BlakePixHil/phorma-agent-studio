/**
 * Stripe billing from the studio: start a Checkout Session, open the Billing
 * Portal, and nothing else.
 *
 * ## Why this is a DI LEAF (requirement 31)
 *
 * The known NG0200 cycle is
 * `RunControllerService -> ModelTransportService -> PhormaCloudService ->
 * CloudService -> RunControllerService`, and `CloudService` legitimately injects
 * `RunControllerService`, so anything on that path must not reach `CloudService`.
 * This service will be consumed from the toolbar, the settings dialog, the
 * credits dialog and the runs panel - four surfaces that between them already
 * touch every service on that cycle - so it takes the conservative shape rather
 * than the convenient one:
 *
 *  - the base URL comes from {@link loadPhormaCloudUrl}, the leaf MODULE that
 *    exists for exactly this reason, never from `CloudService`;
 *  - the session token comes from `ClerkService` DIRECTLY. `PhormaCloudService`
 *    already has a `sessionToken()` doing the same three lines, but injecting it
 *    would put a service that sits ON the cycle inside this one's injector, and
 *    the whole point is that no billing call site can become the edge that closes
 *    it. Duplicating three lines is the cheaper half of that trade;
 *  - `McpOAuthService` is injected for {@link McpOAuthService.openExternal}, and
 *    is safe: it injects `TauriService` (which injects nothing) and
 *    `SettingsService` (which injects only `TauriService`), so it cannot reach
 *    the cycle. Requirement 27 says no second link helper appears, so the
 *    historical home of that helper is reused rather than copied.
 *
 * `billing.service.spec.ts` asserts the leaf shape against the whole
 * CONSTRUCTION CHAIN rather than against this file's import list, so a forbidden
 * service arriving transitively through `McpOAuthService` fails too.
 *
 * ## What it deliberately does not do
 *
 * No toasts, no dialogs, no navigation, no polling. It exposes {@link pending}
 * and {@link error} and lets the calling surface decide how to render them,
 * because the four call sites have four different affordances (a plan card, a
 * pack tile, a toolbar chip, a `past_due` banner). The post-checkout `/api/me`
 * poll lives with the surface that starts the checkout, not here.
 *
 * It also does not know whether this deployment HAS billing. Requirement 32
 * keeps billing surfaces absent on BYO, and that is a rendering decision the
 * components make from `PhormaCloudService`; a leaf cannot ask.
 */

import { Injectable, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ClerkService } from 'ngx-clerk';
import { firstValueFrom, timeout } from 'rxjs';

import type { CreditPack } from './credit-packs';
import { McpOAuthService } from './mcp-oauth.service';
import { loadPhormaCloudUrl } from './phorma-cloud-url';

/**
 * The lookup keys `/api/checkout` will accept - the structural twin of
 * `BILLING_LOOKUP_KEYS` in `cloud/src/stripe.ts`, which is the real security
 * boundary. This union exists so a studio call site cannot invent a key at all;
 * the worker still refuses anything off its own allowlist, because a type is not
 * a check.
 *
 * A key names a PRODUCT, never a price id: sandbox and live price ids differ, so
 * a hardcoded id would be wrong in one of the two modes. Adding annual pricing
 * means one more entry here and one more in the worker's Map.
 */
export type BillingLookupKey =
  | 'phorma_starter_monthly'
  | 'phorma_pro_monthly'
  | 'phorma_team_monthly'
  | 'phorma_topup_small'
  | 'phorma_topup_medium'
  | 'phorma_topup_large';

/** Every value of {@link BillingLookupKey}, for validation and iteration. */
export const BILLING_LOOKUP_KEYS: readonly BillingLookupKey[] = [
  'phorma_starter_monthly',
  'phorma_pro_monthly',
  'phorma_team_monthly',
  'phorma_topup_small',
  'phorma_topup_medium',
  'phorma_topup_large',
];

/**
 * Self-serve subscription tiers and their lookup keys.
 *
 * `enterprise` is absent on purpose (requirement 9): it stays sales-led with no
 * Stripe price, so {@link subscriptionLookupKey} returning null for it is the
 * correct answer rather than a gap.
 */
const SUBSCRIPTION_LOOKUP_KEYS: Readonly<Record<string, BillingLookupKey>> = {
  starter: 'phorma_starter_monthly',
  pro: 'phorma_pro_monthly',
  team: 'phorma_team_monthly',
};

/** Top-up pack ids to lookup keys. Total over {@link CreditPack.id} by type. */
const TOPUP_LOOKUP_KEYS: Readonly<Record<CreditPack['id'], BillingLookupKey>> = {
  small: 'phorma_topup_small',
  medium: 'phorma_topup_medium',
  large: 'phorma_topup_large',
};

/**
 * The lookup key for a tier id, or null when that tier is not self-serve.
 *
 * Takes a plain string because the caller's tier comes from D1 through
 * `/api/me`, where an unknown or custom tier is a legitimate value. Read through
 * `hasOwnProperty`, so `'constructor'` is a miss rather than a truthy inherited
 * value.
 */
export function subscriptionLookupKey(tier: string | null | undefined): BillingLookupKey | null {
  if (typeof tier !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(SUBSCRIPTION_LOOKUP_KEYS, tier)
    ? SUBSCRIPTION_LOOKUP_KEYS[tier]
    : null;
}

/** The lookup key for a credit pack. Total, because the id union is closed. */
export function topupLookupKey(packId: CreditPack['id']): BillingLookupKey {
  return TOPUP_LOOKUP_KEYS[packId];
}

/** What {@link BillingService} currently has in flight. */
export type BillingRequest =
  | { readonly kind: 'checkout'; readonly lookupKey: BillingLookupKey }
  | { readonly kind: 'portal' };

/**
 * Why the last billing attempt did not reach Stripe's hosted page.
 *
 * `status` is the worker's HTTP status, or null when the request never got an
 * answer (signed out, offline, an unreadable URL, a blocked popup). `code` is
 * the stable machine code from requirement 19 when the body carries one - today
 * only `/api/infer` sends one, and these two routes answer `{ error }` alone, so
 * treat it as forward compatibility rather than something to branch on. The
 * `past_due` branch in task 7.6 reads the tenant's `status` off `/api/me`, not
 * this.
 */
export interface BillingError {
  readonly message: string;
  readonly status: number | null;
  readonly code: string | null;
}

/**
 * How long to wait for Clerk to hand over a session. Bounded because
 * `ClerkService.session$` is a `ReplaySubject` with no initial value: an
 * unbounded `firstValueFrom` on a Clerk that never loads would leave
 * {@link BillingService.pending} set forever and the button spinning.
 */
const SESSION_TOKEN_TIMEOUT_MS = 10_000;

/** Longest URL we will hand to the OS. Mirrors the worker's own bound. */
const BILLING_URL_MAX_CHARS = 2048;

/**
 * The hosted Stripe URL, or null.
 *
 * The worker already refuses a non-https URL, and this checks again because the
 * value is about to be handed to the operating system on desktop: a scheme with
 * a handler meaning is the one thing that must never get through, and "the other
 * side validated it" is not a property this side can observe.
 */
function hostedBillingUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > BILLING_URL_MAX_CHARS) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

@Injectable({ providedIn: 'root' })
export class BillingService {
  private readonly clerk = inject(ClerkService);
  private readonly links = inject(McpOAuthService);

  /**
   * Clerk's user, read as a signal for the same reason `PhormaCloudService`
   * does: it is the SYNCHRONOUS "is anybody signed in" answer, and awaiting
   * `session$` without it can hang on a Clerk that has not loaded.
   */
  private readonly user = toSignal(this.clerk.user$, { initialValue: null });

  /** True once Clerk reports a signed-in user. */
  readonly signedIn = computed(() => this.user() != null);

  private readonly request = signal<BillingRequest | null>(null);
  private readonly lastError = signal<BillingError | null>(null);
  private readonly url = signal<string | null>(null);

  /** The billing request in flight, or null. At most one at a time. */
  readonly pending = this.request.asReadonly();

  /** True while any billing request is in flight. */
  readonly busy = computed(() => this.request() !== null);

  /**
   * The lookup key currently checking out, or null. Lets one plan card or pack
   * tile spin without every other one spinning with it.
   */
  readonly checkoutPending = computed(() => {
    const request = this.request();
    return request?.kind === 'checkout' ? request.lookupKey : null;
  });

  /** True while the Billing Portal session is being created. */
  readonly portalPending = computed(() => this.request()?.kind === 'portal');

  /** Why the last attempt failed, or null. Cleared when a new attempt starts. */
  readonly error = this.lastError.asReadonly();

  /**
   * The last hosted URL this service resolved, kept so a surface can offer it as
   * a plain link.
   *
   * Not decoration. In browser mode `openExternal` calls
   * `window.open(url, '_blank', 'noopener')`, which returns null UNCONDITIONALLY
   * per spec - so a popup-blocker refusal cannot be detected, and the refusal is
   * a live possibility here specifically: the tab is opened AFTER an await on a
   * worker round trip that itself makes two or three Stripe calls, by which point
   * the click's transient user activation may have expired. There is no way to
   * observe that, so the mitigation is to keep the URL and let the surface render
   * "Didn't open? Open checkout" beside the button. The URL is a live Stripe
   * session either way.
   */
  readonly lastUrl = this.url.asReadonly();

  /** Drops the recorded failure, e.g. when a dialog closes. */
  clearError(): void {
    this.lastError.set(null);
  }

  /**
   * Starts a Stripe Checkout Session for one allowlisted lookup key and opens it
   * externally. Resolves true when the hosted page was opened.
   *
   * The boolean is the seam task 7.5 needs: a caller starts its bounded
   * `/api/me` poll only when the user actually reached Stripe, so an abandoned
   * or refused checkout leaves no timer running.
   */
  async startCheckout(lookupKey: BillingLookupKey): Promise<boolean> {
    return this.open({ kind: 'checkout', lookupKey });
  }

  /**
   * Opens the Stripe Billing Portal - cancel, change plan, update card, invoice
   * history (requirement 28). Resolves true when the portal was opened.
   */
  async openBillingPortal(): Promise<boolean> {
    return this.open({ kind: 'portal' });
  }

  /**
   * One request path for both routes, so neither can forget the token, the
   * re-entrancy guard, the URL check or clearing `pending`.
   */
  private async open(request: BillingRequest): Promise<boolean> {
    // Re-entrancy guard, not a nicety: each POST creates a real Stripe object,
    // and a double-clicked Subscribe button would otherwise open two Checkout
    // Sessions and leave one of them dangling.
    if (this.request() !== null) return false;

    const base = loadPhormaCloudUrl();
    if (!base) {
      return this.fail('Phorma Cloud is not configured on this install.', null, null);
    }

    this.request.set(request);
    this.lastError.set(null);
    try {
      const jwt = await this.sessionToken();
      if (!jwt) {
        return this.fail('Sign in to Phorma Cloud first.', null, null);
      }

      const path = request.kind === 'checkout' ? '/api/checkout' : '/api/billing-portal';
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        // The portal route reads no body; sending `{}` keeps one code path and
        // matches the JSON content type the header already claims.
        body: JSON.stringify(request.kind === 'checkout' ? { lookupKey: request.lookupKey } : {}),
      });
      const payload = (await response.json().catch(() => null)) as {
        url?: unknown;
        error?: unknown;
        code?: unknown;
      } | null;

      if (!response.ok) {
        // The worker's own prose, which already distinguishes "no billing
        // account yet" (404) from "Stripe is not configured" (501) from a
        // Stripe-side refusal. Restating it here would only make it vaguer.
        const message =
          typeof payload?.error === 'string' && payload.error
            ? payload.error
            : `Phorma Cloud responded with HTTP ${response.status}.`;
        return this.fail(
          message,
          response.status,
          typeof payload?.code === 'string' ? payload.code : null,
        );
      }

      const url = hostedBillingUrl(payload?.url);
      if (!url) {
        return this.fail('Phorma Cloud returned an unreadable billing URL.', response.status, null);
      }
      // Set BEFORE the hand-off, so `lastUrl` is populated even if `openExternal`
      // throws on the desktop path.
      this.url.set(url);
      await this.links.openExternal(url);
      return true;
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : String(error), null, null);
    } finally {
      this.request.set(null);
    }
  }

  /** Records the failure and answers false, so callers can `return this.fail(...)`. */
  private fail(message: string, status: number | null, code: string | null): false {
    this.lastError.set({ message, status, code });
    return false;
  }

  /**
   * A fresh Clerk session JWT, or null.
   *
   * The equivalent of `PhormaCloudService.sessionToken()`, which this service may
   * not inject (see the file header). Two guards make it safe to await from a
   * button handler: the signed-in signal, and a timeout on `session$` - Clerk's
   * subjects replay a value only once Clerk has loaded, so both a signed-out user
   * and a Clerk that never arrives answer null instead of hanging.
   */
  private async sessionToken(): Promise<string | null> {
    if (!this.signedIn()) return null;
    try {
      const session = await firstValueFrom(
        this.clerk.session$.pipe(timeout({ first: SESSION_TOKEN_TIMEOUT_MS })),
      );
      return (await session?.getToken()) ?? null;
    } catch {
      // A timeout or a rejected `getToken` are the same actionable state: there
      // is no usable session, and the caller says so.
      return null;
    }
  }
}
