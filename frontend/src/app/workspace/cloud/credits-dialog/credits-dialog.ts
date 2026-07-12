import { ChangeDetectionStrategy, Component, HostListener, inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';

import { CREDIT_PACKS } from '../../../core/credit-packs';
import { CreditsDialogService } from '../credits-dialog.service';
import { PhormaCloudService } from '../../../core/phorma-cloud.service';

/**
 * Buy Credits — a placeholder pack picker shown when a Phorma Cloud tenant
 * wants to top up mid-month (Settings → Cloud quota panel, or the "Buy
 * credits" CTA on a credits-exhausted run failure toast).
 *
 * Payments are not wired up yet (no Stripe/checkout integration in this
 * pass) — every pack's purchase button is disabled with a "Coming soon"
 * label. This establishes the UI shape and pack pricing ahead of that work.
 * Styled to match `CloudDialog` / `ConfirmDialog` (same overlay + card).
 */
@Component({
  selector: 'app-credits-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, ButtonModule, TooltipModule],
  templateUrl: './credits-dialog.html',
  styleUrl: './credits-dialog.scss',
})
export class CreditsDialog {
  protected readonly dialog = inject(CreditsDialogService);
  protected readonly phormaCloud = inject(PhormaCloudService);
  protected readonly packs = CREDIT_PACKS;

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.dialog.visible()) this.dialog.close();
  }
}
