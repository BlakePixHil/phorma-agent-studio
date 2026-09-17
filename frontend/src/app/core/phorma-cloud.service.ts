import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ClerkService } from 'ngx-clerk';
import { firstValueFrom } from 'rxjs';

import { ToastService } from '../shared/toast/toast.service';
import { DesktopAuthService } from './desktop-auth.service';
import { TerminalOutputService } from './terminal-output.service';
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
 * Asks Clerk's image CDN for a thumbnail rather than the full-size original.
 *
 * 64px covers the 28px toolbar avatar on a 2x display. Appends rather than
 * assumes a clean URL: `imageUrl` carries no query today, but a future one would
 * silently truncate under a hardcoded `?`.
 */
function scaleClerkImage(url: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}width=64&height=64&fit=crop&quality=85`;
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
 * Workflows with a live cloud backup per plan - MUST mirror `backupWorkflows` in
 * `cloud/src/tenants.ts` TIERS (cloud-workflow-backup, Requirement 10.9).
 *
 * The worker enforces it; this map is only so the studio can SAY what the cap is
 * before a user hits it. A cap the user meets with no warning is how a durability
 * feature stops covering the workflow they cared about.
 */
const TIER_BACKUP_WORKFLOWS: Record<string, number> = {
  starter: 25,
  pro: 100,
  team: 250,
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
  private readonly toast = inject(ToastService);
  // The desktop credential. A DI LEAF (`TauriService` + `McpOAuthService` only), so
  // injecting it here does not close the NG0200 cycle this service sits on.
  private readonly desktopAuth = inject(DesktopAuthService);
  // Also safe on that cycle: `TerminalOutputService` injects NOTHING at all. It is
  // here so a sign-in failure leaves its real cause somewhere a user can read it -
  // a toast cannot carry a URL or an exception message usefully.
  private readonly terminal = inject(TerminalOutputService);

  /**
   * Current Clerk user. Always null on desktop, and that is not a bug: the webview
   * cannot hold a Clerk session against a production instance, so a desktop install
   * is signed in via {@link DesktopAuthService} and Clerk never loads a user here.
   * Read {@link signedIn} rather than this for "is there an account".
   */
  readonly user = toSignal(this.clerk.user$, { initialValue: null });

  /**
   * True when this install has an account, by EITHER route.
   *
   * Clerk in a browser build, the desktop credential in a packaged one. Every gate
   * in the studio reads this, so keeping it a union is what let the desktop
   * credential land without touching the billing surfaces, the model picker or the
   * run path.
   */
  readonly signedIn = computed(() => this.user() != null || this.desktopAuth.signedIn());
  /**
   * Signed-in email (best-effort display value).
   *
   * On desktop it comes from the sign-in page via the handoff rather than from a
   * Clerk user object, and it can legitimately be null - a tenant row only exists
   * once someone has subscribed, so there is no server-side address to fall back on
   * for a brand new account. Surfaces must render an account with no address rather
   * than treat null as signed out.
   */
  readonly email = computed(() => {
    const user = this.user();
    return user?.primaryEmailAddress?.emailAddress ?? this.desktopAuth.email() ?? null;
  });

  /**
   * Signed-in profile picture (best-effort display value), or null.
   *
   * The same Clerk-or-handoff union as {@link email}, and null for the same kind
   * of ordinary reasons: an account with no provider photo, a handoff from a
   * worker older than the field, or a URL that failed the host check. Callers
   * fall back to an initial - `hasImage` is checked at the source, so null here
   * means "no photo" rather than "photo we could not load", and Clerk's generated
   * placeholder is deliberately never substituted for ours.
   *
   * Clerk's own value is scaled through its image CDN's query parameters (the
   * handoff path is scaled at the source, on the sign-in page).
   */
  readonly avatarUrl = computed(() => {
    const user = this.user();
    const clerkImage = user?.hasImage ? user.imageUrl : null;
    if (clerkImage) return scaleClerkImage(clerkImage);
    return this.desktopAuth.imageUrl() ?? null;
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

  /**
   * How many workflows this tenant's plan will back up.
   *
   * 0 when there is no active plan, because backup is a subscriber capability -
   * which is also what makes this the honest number to render beside a "backup is
   * off" state rather than a cap that does not apply.
   */
  readonly backupWorkflowCap = computed(() => {
    const profile = this.profile();
    if (profile?.status !== 'active' || !profile.tier) return 0;
    return TIER_BACKUP_WORKFLOWS[profile.tier] ?? TIER_BACKUP_WORKFLOWS['starter'];
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

    // Adopt a credential left by a previous session. No-op in a browser build.
    // This flips `signedIn()` when it finds one, which the effect above then turns
    // into the first `/api/me` - so a desktop user who signed in last week is
    // signed in again before any gated surface reads `subscribed()`.
    void this.desktopAuth.restore();
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
   * ## What the desktop path does instead
   *
   * It runs the browser handoff in {@link DesktopAuthService}: the studio mints a
   * one-time code, the system browser signs in on `cloud.phorma-labs.com` (which IS
   * same-site with Clerk, so cookies work there), and the studio exchanges the code
   * for a Phorma credential it keeps in the OS keychain. Clerk still authenticates
   * every human; it just does it somewhere the cookie can live.
   */
  signIn(): void {
    if (this.signInIsExternal) {
      void this.beginDesktopSignIn();
      return;
    }
    // Browser parity path. `forceRedirectUrl` overrides the instance's
    // `after_sign_in_url`; `forceRedirectUrl` and not `fallbackRedirectUrl`
    // because the fallback only applies when Clerk has no opinion of its own,
    // and here the instance has one and it points elsewhere.
    this.clerk.openSignIn({ forceRedirectUrl: window.location.href });
  }

  /**
   * Runs the handoff and reports the outcome.
   *
   * Every failure gets a distinct sentence, because they have distinct remedies and
   * the previous version of this flow failed by showing the user a vendor error page
   * with no way back. `timed-out` is by far the most likely and is not an error at
   * all - it is what an abandoned sign-in looks like.
   */
  private async beginDesktopSignIn(): Promise<void> {
    const signedIn = await this.desktopAuth.begin(url => this.offerManualSignIn(url));
    if (signedIn) {
      await this.refresh();
      this.toast.success('Signed in', this.email() ?? undefined);
      return;
    }
    switch (this.desktopAuth.failure()) {
      case 'cancelled':
        return; // The user did it on purpose; a toast would be noise.
      case 'timed-out':
        this.toast.warning(
          'Sign-in was not completed',
          'The browser sign-in did not finish in time. You can start again whenever you like.',
        );
        return;
      case 'unreachable':
        // This now means ONLY that the request never got an answer - a failed
        // browser launch no longer lands here, so "check your connection" is
        // finally true whenever it is shown.
        //
        // The ADDRESS is named, because "check your connection" is the wrong advice
        // about as often as it is the right one: the endpoint is an OVERRIDABLE
        // per-origin setting, so a stale `wrangler dev` URL or a retired host
        // produces exactly this failure on one machine while another signs in fine.
        // Seeing the host is what tells those two apart without a console.
        this.reportSignInDetail();
        this.toast.error(
          'Could not reach Phorma Cloud',
          `No answer from ${loadPhormaCloudUrl()}. Nothing was changed. If that is not the address you expect, reset it in Settings > Cloud; otherwise check your connection and try again.`,
        );
        return;
      default:
        this.reportSignInDetail();
        this.toast.error(
          'Sign-in was refused',
          'Phorma Cloud would not authorize this device. Try again, or contact support if it keeps happening.',
        );
    }
  }

  /**
   * The recovery path when the system browser could not be launched.
   *
   * This is NOT a failure: the one-time code is minted, registered, and the poll is
   * about to start, so a user who opens the URL themselves signs in normally. The
   * previous version discarded all of that and told them to check their connection.
   *
   * The URL goes to the console as well as the toast, because it is long, the toast
   * has a copy button but the console is where somebody will look for it a minute
   * later, and a two-minute window is not long enough to lose it in.
   */
  private offerManualSignIn(url: string): void {
    this.reportSignInDetail();
    this.terminal.append('problems', 'warning', `Open this page to sign in: ${url}`);
    this.toast.warning(
      'Open the sign-in page yourself',
      `This app could not launch your browser, but the sign-in is still valid for two minutes. Open: ${url}`,
    );
  }

  /**
   * Puts the real cause in the Problems console.
   *
   * Both failure paths in `DesktopAuthService` used to `catch {}` and discard the
   * error, so a `plugin-opener` permission problem and a dead network produced the
   * identical "check your connection" toast and left nothing behind to tell them
   * apart. A toast cannot carry a stack trace; the console can.
   */
  private reportSignInDetail(): void {
    const detail = this.desktopAuth.lastErrorDetail();
    if (detail) this.terminal.append('problems', 'error', `Desktop sign-in: ${detail}`);
  }

  /**
   * The bearer for Phorma Cloud calls, or null when signed out.
   *
   * THE seam that makes one credential change reach everything. `/api/me` here,
   * `/api/infer` through `ModelTransportService`, and the billing routes through
   * `BillingService` all call this, so none of them needed editing when desktop
   * stopped carrying a Clerk session: a browser build still gets a short-lived
   * Clerk JWT, a desktop build gets its Phorma device token, and the worker's
   * `verifyBearer` accepts either.
   */
  async sessionToken(): Promise<string | null> {
    if (this.tauri.isDesktop) return await this.desktopAuth.token();
    if (!this.signedIn()) return null;
    const session = await firstValueFrom(this.clerk.session$);
    return (await session?.getToken()) ?? null;
  }

  /**
   * Signs out and clears the cached profile.
   *
   * Both credentials are cleared regardless of platform. That is deliberate rather
   * than lazy: `isDesktop` decides which one EXISTS, and a sign-out that consulted
   * it would leave a stale credential behind on any build where that assumption was
   * ever wrong. Note the desktop half is local-only in lean v1 - see
   * `DesktopAuthService.signOut`.
   */
  async signOut(): Promise<void> {
    await this.desktopAuth.signOut();
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
      // Through the seam, not through Clerk directly: on desktop there is no Clerk
      // session to mint from and this would always have thrown.
      const bearer = await this.sessionToken();
      if (!bearer) throw new Error('Could not get a session token. Sign in again.');

      const response = await fetch(`${base}/api/me`, {
        headers: { Authorization: `Bearer ${bearer}` },
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
