import { ChangeDetectionStrategy, Component, HostListener, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';

import { BillingRefreshService } from '../../../core/billing-refresh.service';
import { BillingService, topupLookupKey } from '../../../core/billing.service';
import { CREDIT_PACKS, type CreditPack } from '../../../core/credit-packs';
import { CreditsDialogService } from '../credits-dialog.service';
import { PhormaCloudService } from '../../../core/phorma-cloud.service';
import { SettingsDialogService } from '../../settings/settings-dialog.service';
import { CheckoutFallback } from '../../../shared/billing/checkout-fallback';
import { PastDueNotice } from '../../../shared/billing/past-due-notice';

/**
 * Buy Credits - the top-up pack picker, shown when a Phorma Cloud tenant wants
 * more credits mid-month (the Settings > Cloud quota panel, or the "Buy credits"
 * CTA on a credits-exhausted run failure).
 *
 * Each pack starts a real Stripe Checkout Session in payment mode; the webhook
 * writes the credit grant when the payment completes, so nothing here has to
 * guess whether the money arrived.
 *
 * ## Why the packs are gated on an active subscription (requirement 26)
 *
 * The pricing page says top-ups are for subscribers, and the worker enforces it,
 * but the reason is not policy for its own sake: a grant RAISES the monthly
 * ceiling rather than standing alone, so credits bought without a plan would sit
 * on an account that cannot run anything and would read as money taken for
 * nothing. An unsubscribed visitor therefore gets a note and a route to the plan
 * cards instead of a disabled grid with no explanation.
 */
@Component({
  selector: 'app-credits-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, ButtonModule, TooltipModule, CheckoutFallback, PastDueNotice],
  templateUrl: './credits-dialog.html',
  styleUrl: './credits-dialog.scss',
})
export class CreditsDialog {
  protected readonly dialog = inject(CreditsDialogService);
  protected readonly phormaCloud = inject(PhormaCloudService);
  protected readonly billing = inject(BillingService);
  private readonly settingsDialog = inject(SettingsDialogService);
  private readonly refresh = inject(BillingRefreshService);

  protected readonly packs = CREDIT_PACKS;

  /**
   * True when a top-up may be OFFERED at all (multi-organisation-phorma,
   * Requirement 19.7).
   *
   * False while an organisation owner is active. The packs then disappear entirely
   * rather than rendering disabled: an organisation's credits come from its tier,
   * which Phorma Labs sets, and `/api/checkout` refuses that owner with
   * `billing_managed` before any Stripe call. The dialog keeps its credit READING,
   * which is the other half of requirement 19.8 - the balance is information, the
   * pack is a purchase.
   */
  protected readonly selfServeBilling = computed(() => this.phormaCloud.selfServeBilling());

  /** Top-ups are subscriber-only, and personal-owner-only. */
  protected readonly canBuy = computed(
    () => this.phormaCloud.subscribed() && this.selfServeBilling(),
  );

  /** True once a checkout was started from here (arms the reopen affordance). */
  protected readonly checkoutAttempted = signal(false);

  /** True while THIS pack's Checkout Session is being created. */
  protected isBuying(pack: CreditPack): boolean {
    return this.billing.checkoutPending() === topupLookupKey(pack.id);
  }

  protected async buy(pack: CreditPack): Promise<void> {
    if (!this.canBuy()) return;
    this.checkoutAttempted.set(true);
    // A grant lands through the webhook like any other purchase, so the same
    // bounded `/api/me` window applies (requirements 29, 30). It runs the bound
    // out rather than stopping early - see `billingFingerprint`.
    if (await this.billing.startCheckout(topupLookupKey(pack.id))) this.refresh.watch();
  }

  /** Sends an unsubscribed visitor to the plan cards on Settings > Cloud. */
  protected openPlans(): void {
    this.dialog.close();
    this.settingsDialog.open('cloud');
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.dialog.visible()) this.dialog.close();
  }
}
