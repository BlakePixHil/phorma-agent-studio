import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ButtonModule } from 'primeng/button';

import { BillingService } from '../../core/billing.service';
import { BillingCtaService } from './billing-cta.service';
import { CheckoutFallback } from './checkout-fallback';

/**
 * What a `past_due` tenant sees instead of a Subscribe CTA (requirement 17).
 *
 * ## Why it is one component and not five template branches
 *
 * Five surfaces upsell Phorma Cloud - the Models and Cloud pages in Settings,
 * the agent config panel, the Ctrl+P builder and the assistant composer - and
 * every one of them renders on `!subscribed()`. A `past_due` tenant fails that
 * test while HAVING a plan, so all five would offer to sell them a second
 * subscription, which is both the wrong remedy and, in Stripe, a second
 * subscription rather than a fixed one. Branching in five templates would mean
 * five chances to get the copy or the action wrong, so the branch is one tag.
 *
 * It is also the cheapest thing for the budget. `settings-dialog.scss` sits at
 * ~21.9kB against a 22kB `anyComponentStyle` warning, and `anyComponentStyle` is
 * measured PER stylesheet, so a notice with its own sheet costs the settings
 * sheet nothing.
 *
 * ## Why the action is the portal and the copy says nothing was lost
 *
 * Updating a card is a payment-details flow we deliberately do not own
 * (requirement 28), so the action is a Billing Portal session. And requirement
 * 18 keeps a `past_due` tenant's tier, data and runtime key, so the copy has to
 * say so: a user who reads "runs are paused" and assumes their workflows are
 * gone is the failure mode this text exists to prevent.
 *
 * A successful portal hand-off opens the bounded post-checkout window
 * (requirements 29, 30), because a card update produces an `invoice.paid` that
 * restores `active` and nothing else would tell the studio.
 */
@Component({
  selector: 'app-past-due-notice',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonModule, CheckoutFallback],
  templateUrl: './past-due-notice.html',
  styleUrl: './past-due-notice.scss',
})
export class PastDueNotice {
  protected readonly billing = inject(BillingService);
  private readonly cta = inject(BillingCtaService);

  /** True once the portal was requested from here (arms the reopen affordance). */
  protected readonly attempted = signal(false);

  protected async updateCard(): Promise<void> {
    this.attempted.set(true);
    // The hand-off and its bounded poll live in `BillingCtaService`, so the
    // toast raised by a `past_due` run failure and this notice cannot drift.
    await this.cta.updateCard();
  }
}
