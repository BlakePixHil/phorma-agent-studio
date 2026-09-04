/**
 * Performing a {@link BillingRemedy} - the one place a refusal turns into a
 * navigation or a Stripe hand-off.
 *
 * ## Why it is a service and not a method on each surface
 *
 * Four surfaces raise a billing CTA: the run-failed toast, the Ctrl+P builder,
 * the assistant chat, and the `past_due` notice. `refusalNotice` already keeps
 * their COPY in one place; without this, their ACTIONS would still be four
 * copies of the same switch, and the expensive mistake (sending a `past_due`
 * tenant to checkout, which buys them a second subscription instead of fixing
 * the first) is an action mistake, not a copy mistake.
 *
 * ## DI safety
 *
 * `RunControllerService` consumes this and sits on the known NG0200 cycle
 * (`RunControllerService -> ModelTransportService -> PhormaCloudService ->
 * CloudService -> RunControllerService`), so nothing reachable from here may
 * inject `CloudService`. Checked, not assumed:
 *
 *  - `CreditsDialogService` and `SettingsDialogService` are pure signal holders
 *    that inject nothing. `RunControllerService` already injects the first.
 *  - `BillingService` is a verified DI leaf (`ClerkService` plus
 *    `McpOAuthService -> TauriService, SettingsService`), asserted against its
 *    whole construction chain by `billing.service.spec.ts`.
 *  - `BillingRefreshService` injects `PhormaCloudService`, which
 *    `RunControllerService` already injects directly, and which itself injects
 *    only `ClerkService` and `TelemetryService`.
 *
 * So this adds no edge that was not already there.
 */

import { Injectable, inject } from '@angular/core';

import { BillingRefreshService } from '../../core/billing-refresh.service';
import { BillingService } from '../../core/billing.service';
import type { BillingRemedy } from '../../core/billing-refusal';
import { CreditsDialogService } from '../../workspace/cloud/credits-dialog.service';
import { SettingsDialogService } from '../../workspace/settings/settings-dialog.service';

@Injectable({ providedIn: 'root' })
export class BillingCtaService {
  private readonly credits = inject(CreditsDialogService);
  private readonly settingsDialog = inject(SettingsDialogService);
  private readonly billing = inject(BillingService);
  private readonly refresh = inject(BillingRefreshService);

  /**
   * Runs the remedy. A no-op for the two remedies with no button, so a caller
   * may dispatch unconditionally.
   */
  run(remedy: BillingRemedy): void {
    switch (remedy) {
      case 'buy-credits':
        this.credits.open();
        return;
      case 'update-card':
        void this.updateCard();
        return;
      case 'subscribe':
      case 'upgrade-plan':
        // The plan cards, never a checkout. Subscribing needs a tier choice that
        // a toast cannot make, and an upgrade is a comparison the user has to
        // see; `openCloudPlans()` in the settings dialog deep-links the same way.
        this.settingsDialog.open('cloud');
        return;
      case 'contact-support':
      case 'none':
        return;
    }
  }

  /**
   * The Billing Portal hand-off, shared with `PastDueNotice`.
   *
   * The pairing is the whole point: a card update produces an `invoice.paid`
   * that restores `active`, and nothing else would tell the studio, so a
   * successful hand-off opens the bounded post-checkout window (requirements 29,
   * 30). Only a REAL hand-off starts it - a refused popup, a signed-out user or
   * a 501 from an unconfigured worker answers false and leaves no timer running.
   */
  async updateCard(): Promise<boolean> {
    const opened = await this.billing.openBillingPortal();
    if (opened) this.refresh.watch();
    return opened;
  }
}
