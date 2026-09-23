import { ChangeDetectionStrategy, Component, inject, viewChild } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { Popover, PopoverModule } from 'primeng/popover';

import { NotificationCenterService } from '../../../core/notification-center.service';
import { NotificationsService } from '../../../core/notifications.service';
import { PhormaCloudService } from '../../../core/phorma-cloud.service';
import { refusalNotice } from '../../../core/billing-refusal';
import { BillingCtaService } from '../../../shared/billing/billing-cta.service';
import type { PendingActionRow, StudioNotification } from '../../../core/notifications.model';

/**
 * The toolbar notification bell.
 *
 * ## Why a `p-popover` and not a bespoke overlay
 *
 * The toolbar host is `z-index: 50` with `-webkit-app-region: drag`, so an
 * absolutely-positioned child would sit inside that stacking context and a plain
 * `<div>` would become a window-drag handle on desktop. `p-popover` appends to the
 * body, so it escapes both, and the library owns anchoring, outside-click and
 * Escape - which is three behaviours not worth reimplementing.
 *
 * ## Why it must NOT carry `role="dialog"`
 *
 * `Toolbar.anyOverlayOpen()` is literally `!!document.querySelector('[role="dialog"]')`
 * and gates whether Escape deselects canvas nodes. A dropdown claiming to be a
 * dialog would break canvas deselection for as long as the bell is open. This is a
 * menu, not a modal, and the markup says so.
 *
 * ## Why the count pill is OUTSIDE the button
 *
 * The trigger passes `icon` like every sibling toolbar button, and the pill is an
 * absolutely-positioned sibling of the `<p-button>`, anchored to this component's
 * host. It used to be projected INSIDE the button, which needed
 * `overflow: visible` on `.p-button` so the pill could overhang - and that same
 * override let PrimeNG's ripple ink bleed out past the button's edge. Outside the
 * button, the default clipping stays on and the pill still overhangs.
 */
@Component({
  selector: 'app-notification-bell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonModule, TooltipModule, PopoverModule],
  templateUrl: './notification-bell.html',
  styleUrl: './notification-bell.scss',
})
export class NotificationBell {
  protected readonly centre = inject(NotificationCenterService);
  protected readonly store = inject(NotificationsService);
  protected readonly phormaCloud = inject(PhormaCloudService);
  // The one place a refusal becomes a navigation or a Stripe hand-off. Injected
  // here rather than reimplemented so the bell, the run-failed toast, the Ctrl+P
  // palette and the chat cannot drift into four answers for one refusal.
  private readonly billingCta = inject(BillingCtaService);

  private readonly popover = viewChild.required<Popover>('pop');

  /** Ids whose inline Approve/Reject is in flight, so the row can disable itself. */
  protected readonly busy = new Set<string>();

  /**
   * Pass-through overrides for the popover panel.
   *
   * PrimeNG's `Popover` hard-codes `role="dialog"` and `aria-modal` on its panel,
   * and BOTH are wrong here. `Toolbar.anyOverlayOpen()` is
   * `!!document.querySelector('[role="dialog"]')` and gates whether Escape
   * deselects canvas nodes, so leaving it would silently break the canvas for as
   * long as the bell is open - and this is a dropdown, so it is not modal and must
   * not claim to be. `pt` is the sanctioned way to reach a PrimeNG internal;
   * `notification-bell.spec.ts` asserts the result rather than trusting it.
   */
  protected readonly POPOVER_PT = {
    root: { role: 'menu', 'aria-modal': null, 'aria-label': 'Notifications' },
  } as const;

  /**
   * `aria-expanded` on the trigger, through `pt` for the same reason.
   *
   * `[attr.aria-expanded]` on `<p-button>` lands on the COMPONENT HOST, not on the
   * native `<button>` PrimeNG renders inside it - so it looks correct in the
   * template and is invisible to a screen reader, which is the worst of both.
   */
  protected triggerPt(): Record<string, Record<string, unknown>> {
    return { root: { 'aria-expanded': String(this.centre.open()) } };
  }

  /**
   * What the badge shows, capped.
   *
   * Past the cap the exact number stops being information - nobody acts
   * differently on 47 than on "lots" - and a three-digit pill breaks the 44px
   * toolbar row.
   */
  protected badgeLabel(): string {
    const count = this.centre.badgeCount();
    return count > 9 ? '9+' : String(count);
  }

  /**
   * Always the outline bell. `ti-bell-filled` is NOT in the outline webfont
   * `styles.scss` imports (filled glyphs ship in a separate `tabler-icons-filled`
   * font), so it rendered no glyph at all and the bell vanished the moment a
   * notification arrived. The pill carries the state.
   */
  protected bellIcon(): string {
    return 'ti ti-bell';
  }

  protected tooltip(): string {
    const pending = this.centre.pendingActions().length;
    if (pending > 0) {
      return `${pending} thing${pending === 1 ? '' : 's'} waiting on you`;
    }
    const unread = this.store.unreadCount();
    if (unread > 0) return `${unread} new notification${unread === 1 ? '' : 's'}`;
    return 'Notifications';
  }

  protected toggle(event: Event): void {
    this.centre.toggle();
    this.popover().toggle(event);
  }

  /** Keeps the service's `open` signal honest when PrimeNG dismisses the panel. */
  protected onHide(): void {
    this.centre.close();
  }

  protected refresh(): void {
    void this.centre.refresh();
  }

  protected markAllRead(): void {
    this.centre.markAllRead();
  }

  protected dismiss(notification: StudioNotification, event: Event): void {
    // The row itself navigates, so the dismiss button must not also trigger it.
    event.stopPropagation();
    this.centre.dismiss(notification.id);
  }

  protected openNotification(notification: StudioNotification): void {
    this.centre.navigateToNotification(notification);
    this.popover().hide();
  }

  protected openAction(row: PendingActionRow): void {
    this.centre.navigateTo(row);
    this.popover().hide();
  }

  protected isBusy(row: PendingActionRow): boolean {
    return this.busy.has(row.id);
  }

  /**
   * Settles a pending approval from the row.
   *
   * `busy` is a plain Set rather than a signal because the rows it gates are
   * re-rendered by the pending signal changing anyway, and a decision is in flight
   * for a few hundred milliseconds at most. It is cleared in a `finally` so a
   * failure cannot leave a row permanently disabled.
   */
  protected async decide(row: PendingActionRow, approved: boolean, event: Event): Promise<void> {
    event.stopPropagation();
    if (this.busy.has(row.id)) return;
    this.busy.add(row.id);
    try {
      await this.centre.resolve(row, approved);
    } finally {
      this.busy.delete(row.id);
    }
  }

  /** Copy for a pending row's second line. */
  protected actionHint(row: PendingActionRow): string {
    switch (row.kind) {
      case 'approval':
        return row.hasPayload ? 'Review the details before approving' : row.message;
      case 'question':
        return row.message;
      case 'wait':
        return `Waiting for "${row.id}"`;
    }
  }

  /** Tabler icon for a pending row. */
  protected actionIcon(row: PendingActionRow): string {
    switch (row.kind) {
      case 'approval':
        return 'ti-shield-question';
      case 'question':
        return 'ti-message-question';
      case 'wait':
        return 'ti-clock-hour-4';
    }
  }

  /** The button label a notification's billing remedy earns, or null. */
  protected remedyLabel(notification: StudioNotification): string | null {
    return notification.remedy ? (refusalNotice(notification.remedy)?.label ?? null) : null;
  }

  /** Performs a notification's billing remedy. */
  protected runRemedy(notification: StudioNotification, event: Event): void {
    event.stopPropagation();
    if (!notification.remedy) return;
    this.popover().hide();
    this.billingCta.run(notification.remedy);
  }

  /**
   * Sends an unsubscribed account to the plan cards.
   *
   * Deliberately the same `'subscribe'` remedy every other CTA uses, and NOT a
   * direct checkout: a footer line in a narrow dropdown cannot ask which of three
   * plans somebody wants, and `BillingCtaService` already routes that to the
   * considered path.
   */
  protected viewPlans(): void {
    this.popover().hide();
    this.billingCta.run('subscribe');
  }
}
