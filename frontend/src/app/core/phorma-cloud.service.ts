import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ClerkService } from 'ngx-clerk';
import { firstValueFrom } from 'rxjs';

import { CLERK_ACCOUNT_PORTAL_URL } from '../../environments/clerk';
import { ToastService } from '../shared/toast/toast.service';
import { McpOAuthService } from './mcp-oauth.service';
import { loadPhormaCloudUrl } from './phorma-cloud-url';
import { TauriService } from './tauri.service';
import { TelemetryService } from './telemetry.service';

/** Profile + quota returned by the hosted control plane's `GET /api/me`. */
export interface PhormaCloudProfile {
  id: string;
  provisioned: boolean;
  tier: string | null;
  status: 'active' | 'past_due' | 'canceled' | null;
  quota: {
    month: string;
    runsUsed: number;
    runsLimit: number;
    /** Usage credits consumed this month — the only billing unit the UI shows. */
    creditsUsed: number;
    /** Monthly usage-credit allowance for the tier. */
    creditsLimit: number;
    /** Internal USD spend (analytics only — never displayed to the user). */
    costUsdUsed: number;
    /** Internal USD budget cap (analytics only — never displayed to the user). */
    costUsdLimit: number;
  } | null;
}

/**
 * Monthly credit allowance per tier — MUST mirror `monthlyCredits` in
 * `cloud/src/tenants.ts` TIERS. Used only as a fallback when the deployed
 * worker predates the credits fields in `/api/me` (returns costUsd* but no
 * credits*); once the worker is redeployed this map is never consulted.
 */
const TIER_MONTHLY_CREDITS: Record<string, number> = {
  starter: 1000,
  pro: 3000,
  team: 10000,
};

/** Nested workflow depth per plan. Free and BYO runs use 2. */
const TIER_SUB_WORKFLOW_DEPTH: Record<string, number> = {
  starter: 5,
  pro: 8,
  team: 10,
};

/**
 * Max active cron schedules per workflow per plan - MUST mirror
 * `schedulesPerWorkflow` in `cloud/src/tenants.ts` TIERS. The worker's
 * `rescheduleCron` arms schedules in graph order and silently drops the rest
 * once the budget is spent; this map lets the studio surface that drop on the
 * canvas BEFORE the user pushes. BYO Cloudflare has no cap (Infinity).
 */
const TIER_SCHEDULES_PER_WORKFLOW: Record<string, number> = {
  starter: 1,
  pro: 5,
  team: 20,
};

/**
 * Marketing names for tier ids — the raw id is a D1 string (`team`, not
 * "Teams"). Unknown ids (e.g. a custom enterprise tier) title-case through.
 */
const TIER_LABELS: Record<string, string> = {
  starter: 'Starter',
  pro: 'Pro',
  team: 'Teams',
  enterprise: 'Enterprise',
};

/** Display label for a tier id. */
export function tierLabel(tier: string | null | undefined): string {
  if (!tier) return 'Free';
  return TIER_LABELS[tier] ?? tier.charAt(0).toUpperCase() + tier.slice(1);
}

/**
 * Backfills `creditsUsed`/`creditsLimit` on a `/api/me` payload when a stale
 * worker omits them, deriving credits from the USD fields + the known tier
 * allowance (`credits = costUsd / costUsdLimit * creditsLimit`). No-ops when
 * the worker already sends credits. Keeps the UI showing real numbers instead
 * of a bare "/" during deploy lag.
 */
function normalizeProfile(profile: PhormaCloudProfile): PhormaCloudProfile {
  const quota = profile.quota;
  if (!quota) return profile;
  if (typeof quota.creditsLimit === 'number' && typeof quota.creditsUsed === 'number') {
    return profile;
  }
  const creditsLimit = TIER_MONTHLY_CREDITS[profile.tier ?? 'starter'] ?? TIER_MONTHLY_CREDITS['starter'];
  const creditsUsed =
    quota.costUsdLimit > 0
      ? Math.max(0, Math.round((quota.costUsdUsed / quota.costUsdLimit) * creditsLimit))
      : 0;
  return { ...profile, quota: { ...quota, creditsUsed, creditsLimit } };
}

/**
 * The studio's Phorma Cloud account session.
 *
 * Sign-in itself is Clerk (toolbar user button / modal); this service layers
 * the Phorma-specific account state on top: subscription tier, status, and
 * the month-to-date quota from the hosted control plane (`GET /api/me`).
 *
 * Consumers: the Settings → Cloud Phorma panel (quota bar) and the Cloud
 * dialog's account chip.
 */
@Injectable({ providedIn: 'root' })
export class PhormaCloudService {
  private readonly clerk = inject(ClerkService);
  // Safe DI direction even though this service sits on the known NG0200 cycle:
  // `TelemetryService` is a leaf that injects only `TauriService`, so it cannot
  // reach `CloudService` or `RunControllerService` from here.
  private readonly telemetry = inject(TelemetryService);
  // Also safe on the NG0200 cycle, and checked rather than assumed:
  // `TauriService` is a leaf, `ToastService` injects nothing at all, and
  // `McpOAuthService` reaches only `TauriService` + `SettingsService`, neither of
  // which touches `CloudService` or `RunControllerService`. `McpOAuthService` is
  // reused for `openExternal` rather than re-importing the opener plugin here -
  // `BillingService` already takes that rail for Stripe Checkout.
  private readonly tauri = inject(TauriService);
  private readonly links = inject(McpOAuthService);
  private readonly toast = inject(ToastService);

  /** Current Clerk user (null until Clerk loads / when signed out). */
  readonly user = toSignal(this.clerk.user$, { initialValue: null });
  /** True once Clerk reports a signed-in user. */
  readonly signedIn = computed(() => this.user() != null);
  /** Signed-in email (best-effort display value). */
  readonly email = computed(() => {
    const user = this.user();
    return user?.primaryEmailAddress?.emailAddress ?? null;
  });

  /** Latest /api/me response (null until fetched or when signed out). */
  readonly profile = signal<PhormaCloudProfile | null>(null);
  /** True while a profile refresh is in flight. */
  readonly loading = signal(false);
  /** Human-readable error from the last refresh attempt (null when ok). */
  readonly error = signal<string | null>(null);

  /** Subscription is active and the account can run workflows. */
  readonly subscribed = computed(() => this.profile()?.status === 'active');

  /**
   * The tenant has a subscription whose last payment FAILED.
   *
   * A distinct state from unsubscribed, because the remedy is different: this
   * user updates a card in the Billing Portal, an unsubscribed user buys a plan
   * (requirement 17). Every Subscribe CTA in the studio branches on this, and
   * the gate agrees - `resolveHostedInference` answers `subscription_past_due`
   * rather than `no_subscription`.
   *
   * It reads the tenant `status` off `/api/me` and NOT a billing error code:
   * `/api/checkout` and `/api/billing-portal` answer `{ error }` with no code,
   * so there is nothing to branch on there, and a `past_due` tenant may never
   * have touched a billing route in this session anyway.
   *
   * Note `subscribed()` stays false here, which is correct - hosted runs are
   * paused - while the tenant keeps their tier, data and runtime key
   * (requirement 18). So a surface must not read `!subscribed()` as "no plan".
   */
  readonly pastDue = computed(() => this.profile()?.status === 'past_due');

  /**
    * Effective nested workflow frame depth. Unknown active custom tiers match
    * the hosted starter fallback (5) until custom limits are provisioned.
    * Inactive, missing, or malformed profiles use the Free limit of 2.
   */
  readonly subWorkflowDepth = computed(() => {
    const profile = this.profile();
    if (profile?.status !== 'active' || !profile.tier) return 2;
    return Math.min(25, Math.max(2, TIER_SUB_WORKFLOW_DEPTH[profile.tier] ?? 5));
  });

  /**
   * Max active cron schedules per workflow for the signed-in tenant's plan.
   * Unknown active custom tiers fall back to the starter limit (1). Inactive,
   * missing, or malformed profiles use 1 (the most restrictive) so a user who
   * hasn't signed in sees the conservative cap rather than an unbounded one.
   * BYO Cloudflare deployments have no schedule cap — the worker only enforces
   * the budget in hosted mode.
   */
  readonly schedulesPerWorkflow = computed(() => {
    const profile = this.profile();
    if (profile?.status !== 'active' || !profile.tier) return 1;
    return TIER_SCHEDULES_PER_WORKFLOW[profile.tier] ?? 1;
  });

  /** 0–1 fraction of the monthly run allowance used (null without quota). */
  readonly runsFraction = computed(() => {
    const quota = this.profile()?.quota;
    if (!quota || quota.runsLimit <= 0) return null;
    return Math.min(1, quota.runsUsed / quota.runsLimit);
  });

  /** 0–1 fraction of the monthly usage-credit allowance used (null without quota). */
  readonly creditsFraction = computed(() => {
    const quota = this.profile()?.quota;
    if (!quota || quota.creditsLimit <= 0) return null;
    return Math.min(1, quota.creditsUsed / quota.creditsLimit);
  });

  /**
   * True when the tenant is running low on credits (>= 85% used) or has run
   * out. Gates the "Buy more credits" upsell so it only appears when a top-up
   * is actually relevant — not while plenty of credits remain.
   */
  readonly lowOnCredits = computed(() => {
    const fraction = this.creditsFraction();
    return fraction != null && fraction >= 0.85;
  });

  /**
   * Credits earned per USD of real inference for the signed-in tenant's tier
   * (the inverse burn rate), derived from the quota's credit/USD limits.
   * Falls back to the base 250 credits/$1 (starter's no-bonus rate) when no
   * quota is loaded. Used to render a Phorma Cloud run's cost in abstract
   * credits.
   */
  readonly creditsPerUsd = computed(() => {
    const quota = this.profile()?.quota;
    if (!quota || quota.costUsdLimit <= 0) return 250;
    return quota.creditsLimit / quota.costUsdLimit;
  });

  constructor() {
    // Eagerly load the account profile as soon as Clerk reports a signed-in
    // user, so subscription state (`subscribed()`) is known before the model
    // picker or any gated UI reads it — not only after the Cloud settings
    // page is opened. Clears the profile on sign-out.
    let lastSignedIn = false;
    effect(() => {
      const signedIn = this.signedIn();
      if (signedIn === lastSignedIn) return;
      lastSignedIn = signedIn;
      if (signedIn) void this.refresh();
      else this.profile.set(null);
    });
  }

  /**
   * True when sign-in has to leave the app and happen in the system browser,
   * which is every DESKTOP build. Surfaces read it so their copy can promise
   * what will actually happen instead of implying an in-app modal.
   */
  readonly signInIsExternal = this.tauri.isDesktop;

  /**
   * Starts sign-in: Clerk's in-app modal in a browser tab, the system browser on
   * desktop.
   *
   * ## Why desktop cannot use the modal
   *
   * Clerk's in-webview modal CANNOT complete against a PRODUCTION Clerk
   * instance, and no amount of Clerk Dashboard configuration changes that. The
   * mechanism, measured in Chromium at the real webview origin:
   *
   * A production instance identifies the browser client with a `__client` cookie
   * scoped `Domain=clerk.phorma-labs.com; Secure; HttpOnly; SameSite=Lax`. The
   * Tauri webview's origin is `http://tauri.localhost` (Windows and Android) or
   * `tauri://localhost` (macOS and Linux), which is cross-site with
   * `phorma-labs.com`. So Chromium (1) REFUSES TO STORE that cookie, and (2)
   * refuses to send it even when it is injected into the jar by hand, because a
   * `SameSite=Lax` cookie never rides a cross-site subresource request. clerk-js
   * is therefore handed a brand new anonymous client on every single FAPI call.
   *
   * The visible symptom is the Google button. Clerk still returns a Google URL,
   * the browser makes the round trip, and the callback at
   * `https://clerk.phorma-labs.com/v1/oauth_callback` then arrives with no client
   * to attach the attempt to - so Clerk answers 403 `authorization_invalid`
   * ("You are not authorized to perform this request") and the webview renders
   * that raw JSON as a dead-end page with no way back into the app.
   *
   * Two things that look like fixes and are not:
   * - `Clerk.load({ standardBrowser: false })`. clerk-js hardcodes
   *   `credentials: 'include'` for FAPI in BOTH its standard and non-standard
   *   load paths, so the browser bundle has no cookie-free transport to switch to.
   * - `app.windows.useHttpsScheme` in `tauri.conf.json`. The discriminator is
   *   cross-site-ness, not the scheme: Cloudflare's `SameSite=None` cookies were
   *   stored from the very same response that had Clerk's `SameSite=Lax` ones
   *   rejected.
   *
   * A DEVELOPMENT instance is exempt and always looked fine locally, which is why
   * this survived to a release: dev instances are cookieless
   * (`auth_config.cookieless_dev`) and thread the client through the URL as
   * `__clerk_db_jwt`, needing no cross-site cookie at all.
   *
   * ## What the desktop path does today
   *
   * It opens Clerk's hosted Account Portal in the system browser, where the same
   * flow is first-party on `phorma-labs.com` and works, Google included. That is
   * enough to CREATE and manage an account, and it is deliberately not dressed up
   * as more than that: the desktop app cannot yet pick the resulting session up,
   * because doing so needs the browser to hand a credential back to the app.
   * `.kiro/specs/desktop-signin-handoff/` is that work. Until it lands the toast
   * is the honest answer, and it must not be softened into "signing you in".
   *
   * The browser path still needs no `forceRedirectUrl`: the instance's
   * `after_sign_in_url` points at `https://app.phorma-labs.com`, which does not
   * resolve, but the Account Portal is a normal web page and landing on a broken
   * host AFTER authenticating leaves the account created and the session live.
   * Fixing that Dashboard value is still worth doing - it is the difference
   * between finishing on a real page and finishing on a browser error.
   */
  signIn(): void {
    if (this.signInIsExternal) {
      void this.openAccountPortal();
      return;
    }
    // Browser parity path. `forceRedirectUrl` overrides the instance's broken
    // `after_sign_in_url`; `forceRedirectUrl` and not `fallbackRedirectUrl`
    // because the fallback only applies when Clerk has no opinion of its own,
    // and here the instance has one and it is wrong.
    this.clerk.openSignIn({ forceRedirectUrl: window.location.href });
  }

  /**
   * Hands the Account Portal to the OS browser and says so.
   *
   * `sign-up` rather than `sign-in` is the landing page on purpose: the portal
   * carries a "Sign in" link for anyone who already has an account, while a user
   * with no account who lands on `sign-in` has to notice a smaller link to get
   * anywhere. Both pages offer Continue with Google.
   */
  private async openAccountPortal(): Promise<void> {
    const url = `${CLERK_ACCOUNT_PORTAL_URL}/sign-up`;
    try {
      await this.links.openExternal(url);
      this.toast.warning(
        'Finish signing in in your browser',
        'Your Phorma account is created and managed in the browser. Linking this ' +
          'desktop app to that account is not available yet, so the studio will ' +
          'still show you as signed out when you come back.',
      );
    } catch {
      // A failed hand-off leaves the user with no way to reach the portal, so the
      // URL itself becomes the message - they can copy it out of the toast.
      this.toast.error('Could not open your browser', url);
    }
  }

  /**
   * Resolves a fresh Clerk session JWT for authenticating to the Phorma Cloud
   * API (e.g. /api/infer). Returns null when signed out or no session token
   * can be minted. Used by the local-run Phorma Cloud model transport.
   */
  async sessionToken(): Promise<string | null> {
    if (!this.signedIn()) return null;
    const session = await firstValueFrom(this.clerk.session$);
    return (await session?.getToken()) ?? null;
  }

  /** Signs the Clerk session out and clears the cached profile. */
  async signOut(): Promise<void> {
    const clerk = await firstValueFrom(this.clerk.clerk$);
    await clerk?.signOut();
    this.profile.set(null);
    this.error.set(null);
  }

  /**
   * Refreshes the account profile + quota from the hosted control plane.
   * Safe to call when signed out (clears state) or when the control plane
   * is unreachable (records the error, keeps prior profile).
   */
  async refresh(): Promise<void> {
    if (!this.signedIn()) {
      this.profile.set(null);
      this.error.set(null);
      return;
    }
    // Read the URL from the leaf module (not CloudService) to avoid a circular
    // DI: RunControllerService → ModelTransportService → PhormaCloudService →
    // CloudService → RunControllerService.
    const base = loadPhormaCloudUrl();
    if (!base) return;

    this.loading.set(true);
    this.error.set(null);
    try {
      const session = await firstValueFrom(this.clerk.session$);
      const jwt = await session?.getToken();
      if (!jwt) throw new Error('Could not get a session token. Sign in again.');

      const response = await fetch(`${base}/api/me`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!response.ok) {
        // A 401 from the control plane means the session the studio holds is not
        // accepted: the one authentication failure this service can observe, and
        // the only status counted here (Requirements 3.1, 3.2). Category only -
        // the status, the body and the error text stay local, because
        // `recordError` has no parameter they could travel in.
        if (response.status === 401) this.telemetry.recordError('auth');
        const detail = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `Phorma Cloud responded with HTTP ${response.status}.`);
      }
      this.profile.set(normalizeProfile((await response.json()) as PhormaCloudProfile));
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loading.set(false);
    }
  }
}
