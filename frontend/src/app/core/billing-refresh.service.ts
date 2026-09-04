/**
 * Learning the outcome of a checkout, when nothing tells us.
 *
 * ## Why polling at all
 *
 * The webhook is the ONLY writer of subscription state, and Stripe may deliver
 * it seconds after the browser comes back. `GET /billing/return` therefore
 * conveys no billing state on purpose - it cannot know any yet - and the studio
 * has no addressable URL for Stripe to hand a result to in the first place. So
 * the only honest way the studio learns that a purchase landed is to re-read
 * `/api/me` (requirement 29).
 *
 * ## Why it is bounded, and how
 *
 * An unbounded poll on a checkout the user abandoned is a permanent background
 * request loop, which requirement 30 forbids. The bound is 24 attempts, 5
 * seconds apart, so the window closes after two minutes.
 *
 * That number is sized against the two clocks in play, and they are very
 * different. Stripe queues `checkout.session.completed` the moment the payment
 * succeeds and normally delivers it in well under a second, so the webhook is
 * not the long pole. The HUMAN is: entering a card on the hosted page takes
 * tens of seconds, and the poll has to still be alive when they finish. Two
 * minutes covers an unhurried card entry plus delivery with room to spare,
 * costs 24 cheap GETs in the worst case, and is bounded by construction rather
 * than by a stop condition that an abandoned checkout would never satisfy.
 *
 * Three things end the window early or keep it honest:
 *
 *  - it only starts when `BillingService.startCheckout` (or the portal call)
 *    resolved TRUE, meaning the hosted page was actually handed off. A refused
 *    popup, a signed-out user or a 501 from an unconfigured worker leaves no
 *    timer running at all;
 *  - it stops the moment the profile's BILLING fields change, which is the
 *    answer it was waiting for;
 *  - a window `focus` refresh (requirement 30) catches the common case of the
 *    user tabbing straight back, so the 5 second grid is a floor on latency and
 *    not the only path.
 *
 * The focus listener lives and dies WITH the window, which is the point: a
 * permanent listener refreshing `/api/me` on every alt-tab would be a
 * background request loop wearing a different hat, and there is no reason to
 * watch for a billing change at a moment when no billing change was started.
 *
 * ## Sequencing, because `refresh()` does not dedupe
 *
 * `PhormaCloudService.refresh()` is safe to call repeatedly - it is a GET that
 * replaces `profile` and records its own error - but it does NOT guard against
 * concurrent calls: two in flight both write `loading`, and the later response
 * wins regardless of which was issued first. So this service never has two
 * outstanding: the poll is a `setTimeout` CHAIN rather than a `setInterval`, so
 * the next attempt is scheduled only after the previous one settles, and the
 * focus path skips while `loading()` is true.
 */

import { DestroyRef, Injectable, InjectionToken, inject, signal } from '@angular/core';

import { PhormaCloudService, type PhormaCloudProfile } from './phorma-cloud.service';

/** How the post-checkout window is bounded. */
export interface BillingPollConfig {
  /** Delay between attempts, in ms. */
  readonly intervalMs: number;
  /** Hard cap on attempts. `intervalMs * maxAttempts` is the whole window. */
  readonly maxAttempts: number;
}

/**
 * The bound, as a token so a test can shrink the window instead of mocking the
 * clock. The default is the shipped one and is the number requirement 30 is
 * about; see the file header for why it is 24 x 5s.
 */
export const BILLING_POLL_CONFIG = new InjectionToken<BillingPollConfig>('phorma.billing.poll', {
  factory: (): BillingPollConfig => ({ intervalMs: 5_000, maxAttempts: 24 }),
});

/**
 * The billing-relevant shape of a profile, as a comparable string.
 *
 * Deliberately EXCLUDES `runsUsed`, `creditsUsed` and the USD counters. Those
 * move whenever any run settles, including a run started in another window, and
 * a poll that treated that as its answer would stop before the webhook landed
 * and leave the plan stale. What it includes is everything a billing event can
 * change: whether the tenant exists, which tier they are on, their subscription
 * status, and the two allowance ceilings a tier change moves.
 *
 * A top-up is the one purchase this cannot see, because a grant raises the
 * ceiling through additive fields the studio does not read yet - so a pack
 * purchase runs the window out rather than stopping early. That is the cheap
 * side of the trade: 24 GETs, versus a false stop on every unrelated run.
 */
function billingFingerprint(profile: PhormaCloudProfile | null): string {
  if (!profile) return 'signed-out';
  const quota = profile.quota;
  return [
    profile.provisioned ? 'yes' : 'no',
    profile.tier ?? '-',
    profile.status ?? '-',
    quota ? String(quota.creditsLimit) : '-',
    quota ? String(quota.runsLimit) : '-',
  ].join('|');
}

@Injectable({ providedIn: 'root' })
export class BillingRefreshService {
  private readonly phormaCloud = inject(PhormaCloudService);
  private readonly config = inject(BILLING_POLL_CONFIG);

  private timer: ReturnType<typeof setTimeout> | null = null;
  private attemptsLeft = 0;
  private baseline = '';
  private listening = false;

  /** True while the post-checkout window is open. Renderable, e.g. as a hint. */
  readonly watching = signal(false);

  /** Attempts still available in the current window. Zero when idle. */
  readonly remaining = signal(0);

  constructor() {
    // A root service outlives every billing surface, so nothing else would ever
    // clear the timer or the listener. App teardown does.
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  /**
   * Opens the post-checkout window: a bounded `/api/me` poll plus a focus
   * refresh.
   *
   * Call this ONLY when the hosted page was actually opened - that is what the
   * boolean from `BillingService.startCheckout` and `openBillingPortal` is for.
   * Calling it again restarts the window rather than stacking a second timer,
   * which is the right answer for a user who buys a plan and then a top-up: the
   * baseline moves to what they have now, so the second window is watching for
   * the second change.
   */
  watch(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.baseline = billingFingerprint(this.phormaCloud.profile());
    this.attemptsLeft = Math.max(0, this.config.maxAttempts);
    this.remaining.set(this.attemptsLeft);
    this.watching.set(true);
    if (this.attemptsLeft === 0) {
      this.stop();
      return;
    }
    this.listen();
    this.schedule();
  }

  /** Closes the window: clears the timer, drops the listener. Idempotent. */
  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.unlisten();
    this.attemptsLeft = 0;
    this.remaining.set(0);
    this.watching.set(false);
  }

  private schedule(): void {
    this.timer = setTimeout(() => void this.attempt(), this.config.intervalMs);
  }

  private async attempt(): Promise<void> {
    this.timer = null;
    if (!this.watching()) return;
    this.attemptsLeft -= 1;
    this.remaining.set(this.attemptsLeft);
    await this.phormaCloud.refresh();
    // `stop()` may have run while the request was in flight (app teardown, or a
    // focus refresh that saw the change first), and re-scheduling then would
    // resurrect a closed window.
    if (!this.watching()) return;
    if (this.changed() || this.attemptsLeft <= 0) {
      this.stop();
      return;
    }
    this.schedule();
  }

  /** True once the profile's billing fields differ from the window's baseline. */
  private changed(): boolean {
    return billingFingerprint(this.phormaCloud.profile()) !== this.baseline;
  }

  /**
   * Requirement 30's focus refresh. Both events are bound because they answer
   * different questions: `focus` covers the desktop shell and a separate browser
   * window regaining focus, `visibilitychange` covers a background TAB in the
   * same window being brought forward, which fires no window focus event at all.
   */
  private readonly onReturn = (): void => {
    if (!this.watching()) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (this.phormaCloud.loading()) return;
    void this.refreshOnce();
  };

  private async refreshOnce(): Promise<void> {
    await this.phormaCloud.refresh();
    if (this.watching() && this.changed()) this.stop();
  }

  private listen(): void {
    if (this.listening || typeof window === 'undefined') return;
    window.addEventListener('focus', this.onReturn);
    document.addEventListener('visibilitychange', this.onReturn);
    this.listening = true;
  }

  private unlisten(): void {
    if (!this.listening) return;
    window.removeEventListener('focus', this.onReturn);
    document.removeEventListener('visibilitychange', this.onReturn);
    this.listening = false;
  }
}
