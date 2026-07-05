import { Injectable, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ClerkService } from 'ngx-clerk';
import { firstValueFrom } from 'rxjs';

import { CloudService } from './cloud.service';

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
    costUsdUsed: number;
    costUsdLimit: number;
  } | null;
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
  private readonly cloud = inject(CloudService);

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

  /** 0–1 fraction of the monthly inference budget used (null without quota). */
  readonly costFraction = computed(() => {
    const quota = this.profile()?.quota;
    if (!quota || quota.costUsdLimit <= 0) return null;
    return Math.min(1, quota.costUsdUsed / quota.costUsdLimit);
  });

  /** Opens Clerk's modal sign-in flow. */
  signIn(): void {
    this.clerk.openSignIn();
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
    const base = this.cloud.phormaCloudUrl();
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
      this.profile.set((await response.json()) as PhormaCloudProfile);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loading.set(false);
    }
  }
}
