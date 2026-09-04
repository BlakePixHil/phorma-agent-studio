import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { ButtonModule } from 'primeng/button';

import { BillingService } from '../../core/billing.service';
import { McpOAuthService } from '../../core/mcp-oauth.service';

/**
 * The recovery affordance every billing CTA needs, in one place.
 *
 * ## Why it exists
 *
 * A blocked popup is UNDETECTABLE. `window.open(url, '_blank', 'noopener')`
 * returns null unconditionally per spec, so browser mode cannot tell a refused
 * tab from an opened one - and the refusal is a live possibility for billing
 * specifically, because the tab opens AFTER an await on a worker round trip that
 * itself makes two or three Stripe calls, by which point the click's transient
 * user activation may have expired. `BillingService.lastUrl` keeps the live
 * Stripe URL for exactly this, and this component is the surface that offers it:
 * "Didn't open? Open checkout", rendered beside the button that just ran.
 *
 * It renders the recorded failure too, so no call site has to grow its own error
 * paragraph. Between the two, a billing CTA is a `p-button` plus one tag.
 *
 * ## Why {@link attempted} is an input rather than derived
 *
 * `BillingService` is a singleton and `lastUrl` is global, so an unscoped
 * fallback would light up on EVERY mounted billing surface - open the credits
 * dialog after choosing a plan and it would offer to reopen the plan's checkout.
 * The owning surface therefore says whether IT started the last request. One
 * signal set in the click handler is cheaper than teaching the service which
 * component asked, and it keeps the service a leaf with no view concerns.
 *
 * Note the affordance shows after a SUCCESSFUL hand-off as well. That is the
 * point: success is exactly the case we cannot verify.
 */
@Component({
  selector: 'app-checkout-fallback',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonModule],
  templateUrl: './checkout-fallback.html',
  styleUrl: './checkout-fallback.scss',
})
export class CheckoutFallback {
  private readonly billing = inject(BillingService);
  // The app's ONE external-link helper, the same one `BillingService` hands the
  // URL to. Safe to inject here for the reason its own header records: it reaches
  // only `TauriService` and `SettingsService`, so it cannot close the NG0200
  // cycle around the run path.
  private readonly links = inject(McpOAuthService);

  /** True when THIS surface started the billing request now recorded. */
  readonly attempted = input(false);

  /**
   * Label for the reopen action. Defaults to the dominant case; a surface that
   * also opens the Billing Portal should pass something that covers both.
   */
  readonly openLabel = input('Open checkout');

  /** Why the last attempt failed, or null. */
  protected readonly message = computed(() =>
    this.attempted() ? (this.billing.error()?.message ?? null) : null,
  );

  /**
   * The URL to offer, or null. Withheld while a request is in flight so the
   * link cannot appear beside its own spinner and invite a second tab.
   */
  protected readonly reopenUrl = computed(() =>
    this.attempted() && !this.billing.busy() ? this.billing.lastUrl() : null,
  );

  protected reopen(): void {
    const url = this.reopenUrl();
    if (url) void this.links.openExternal(url);
  }
}
