import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ClerkService } from 'ngx-clerk';
import { firstValueFrom } from 'rxjs';

import { PHORMA_CLOUD_DEFAULT_URL } from './cloud.service';
import { loadLayout } from './layout-storage';

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
  plus: 2000,
  pro: 3000,
  team: 10000,
};

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

  /** Opens Clerk's modal sign-in flow. */
  signIn(): void {
    this.clerk.openSignIn();
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
    // Read phormaCloudUrl directly from localStorage (not CloudService) to
    // avoid a circular DI: RunControllerService → ModelTransportService →
    // PhormaCloudService → CloudService → RunControllerService.
    const base = loadLayout('phormaCloudUrl', PHORMA_CLOUD_DEFAULT_URL);
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
