import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';

import { BillingRefreshService } from '../../../core/billing-refresh.service';
import { BillingService, subscriptionLookupKey } from '../../../core/billing.service';
import { McpOAuthService } from '../../../core/mcp-oauth.service';
import { PhormaCloudService } from '../../../core/phorma-cloud.service';
import {
  CONTACT_SALES_URL,
  PLAN_CARDS,
  type PlanCard,
} from '../../../core/plan-catalog';
import { CheckoutFallback } from '../../../shared/billing/checkout-fallback';

/**
 * The plan picker on Settings > Cloud (requirement 9).
 *
 * ## Why a component and not more of `settings-dialog.html`
 *
 * Two reasons, and the second is the load-bearing one. Plan selection is a
 * self-contained surface with its own state (which card is checking out, whether
 * the portal is opening, whether the popup may have been blocked), and
 * `settings-dialog.scss` compiles to ~21.9kB against a 22kB `anyComponentStyle`
 * warning - roughly 580 bytes of headroom, which one card grid would blow
 * through. `anyComponentStyle` is measured PER stylesheet, so a card grid in its
 * own component is not a way around the budget, it is the budget working: the
 * settings sheet stays where it is and this surface gets its own.
 *
 * ## Choose versus change
 *
 * A second Checkout Session for a tenant who already has a subscription would
 * create a SECOND subscription in Stripe rather than moving them between plans,
 * so a card only offers checkout while the tenant has nothing active. Once they
 * do, every other card routes to the Billing Portal, which is where Stripe
 * handles the proration (requirement 28). `past_due` counts as having a
 * subscription for exactly this reason - the remedy there is a card update in the
 * portal, never a fresh purchase.
 *
 * ## Enterprise
 *
 * Enterprise carries no `priceUsd` and `subscriptionLookupKey('enterprise')`
 * answers null, so it is split out of the grid by data rather than by a special
 * case in the template: it renders a Contact sales action and no price at all.
 */
@Component({
  selector: 'app-plan-cards',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, ButtonModule, TooltipModule, CheckoutFallback],
  templateUrl: './plan-cards.html',
  styleUrl: './plan-cards.scss',
})
export class PlanCards {
  protected readonly billing = inject(BillingService);
  protected readonly phormaCloud = inject(PhormaCloudService);
  private readonly links = inject(McpOAuthService);
  private readonly refresh = inject(BillingRefreshService);

  /** Plans a user can buy without talking to anybody. */
  protected readonly selfServePlans = PLAN_CARDS.filter((plan) => plan.priceUsd !== null);

  /** Plans that are a conversation. Enterprise today. */
  protected readonly salesPlans = PLAN_CARDS.filter((plan) => plan.priceUsd === null);

  /**
   * True once a billing request has been started FROM here, which is what arms
   * the reopen affordance. See {@link CheckoutFallback}.
   */
  protected readonly attempted = signal(false);

  /**
   * True when the tenant has a subscription Stripe would consider live -
   * `active` or `past_due`. Both mean a plan change belongs in the portal.
   */
  protected readonly hasSubscription = computed(() => {
    const status = this.phormaCloud.profile()?.status;
    return status === 'active' || status === 'past_due';
  });

  /** The tier the tenant is on, or null when they are on no plan. */
  protected readonly currentTier = computed(() =>
    this.hasSubscription() ? (this.phormaCloud.profile()?.tier ?? null) : null,
  );

  protected isCurrent(plan: PlanCard): boolean {
    return this.currentTier() === plan.tier;
  }

  /** True while THIS card's Checkout Session is being created. */
  protected isCheckingOut(plan: PlanCard): boolean {
    return this.billing.checkoutPending() === subscriptionLookupKey(plan.tier);
  }

  protected actionLabel(plan: PlanCard): string {
    if (this.isCurrent(plan)) return 'Current plan';
    return this.hasSubscription() ? 'Change plan' : 'Choose';
  }

  /**
   * Buys the plan, or opens the portal to move to it. Guarded on the lookup key
   * so a plan with no Stripe price can never reach checkout even if it somehow
   * rendered in the self-serve grid.
   */
  protected async choose(plan: PlanCard): Promise<void> {
    if (this.isCurrent(plan)) return;
    this.attempted.set(true);
    if (this.hasSubscription()) {
      if (await this.billing.openBillingPortal()) this.refresh.watch();
      return;
    }
    const lookupKey = subscriptionLookupKey(plan.tier);
    if (!lookupKey) return;
    // The boolean is the seam: only a real hand-off to the hosted page opens the
    // bounded `/api/me` window, so an abandoned or refused checkout leaves no
    // timer running (requirements 29, 30).
    if (await this.billing.startCheckout(lookupKey)) this.refresh.watch();
  }

  /** Cancel, change plan, update card, invoice history (requirement 28). */
  protected async manageBilling(): Promise<void> {
    this.attempted.set(true);
    if (await this.billing.openBillingPortal()) this.refresh.watch();
  }

  protected contactSales(): void {
    void this.links.openExternal(CONTACT_SALES_URL);
  }
}
