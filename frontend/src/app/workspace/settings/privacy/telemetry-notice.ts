import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ButtonModule } from 'primeng/button';

import { McpOAuthService } from '../../../core/mcp-oauth.service';
import { COUNTER_CATALOG } from '../../../core/telemetry-catalog';
import { TelemetryService } from '../../../core/telemetry.service';
import { SettingsDialogService } from '../settings-dialog.service';
import { ToastService } from '../../../shared/toast/toast.service';
import { PRIVACY_POLICY_URL } from './privacy-settings';

/**
 * First_Run_Notice - the one-time disclosure that anonymous usage counters are
 * collected (1.2), shown again only when `CURRENT_DISCLOSURE_VERSION` is bumped
 * (1.8) and never again once dismissed (1.3).
 *
 * DELIBERATELY NOT A DIALOG. It carries no `role="dialog"`, traps no focus, and
 * covers no part of the workspace: a disclosure the user has not asked for must
 * not stand between them and their work. That also keeps it out of the way of
 * the global key handlers, which probe for `[role="dialog"]` to decide whether
 * an overlay owns Escape - claiming to be a dialog here would make Escape treat
 * the notice as a modal and swallow the canvas shortcut.
 *
 * It sits in the same layer band as the AI review bar (`z-index: 60`), below
 * expanded panels (75) and every real dialog (80), so the Settings dialog it
 * opens layers cleanly over it.
 */
@Component({
  selector: 'app-telemetry-notice',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonModule],
  template: `
    <div class="phorma-tnotice" role="status">
      <i class="ti ti-shield-lock phorma-tnotice__icon" aria-hidden="true"></i>

      <div class="phorma-tnotice__body">
        <p class="phorma-tnotice__title">Anonymous usage counters are on</p>
        <p class="phorma-tnotice__text">
          Phorma counts which features get used so the studio can be improved. Counts only,
          {{ counterCount }} of them, grouped by day: never your prompts, workflows, data or
          credentials. It also records your app version, platform, locale and timezone.
        </p>
        <div class="phorma-tnotice__actions">
          <button
            type="button"
            pButton
            size="small"
            class="phorma-btn-content phorma-tnotice__btn"
            (click)="openPrivacySettings()"
          >
            <i class="ti ti-settings" aria-hidden="true"></i>
            <span>Privacy settings</span>
          </button>
          <button
            type="button"
            pButton
            severity="secondary"
            size="small"
            class="phorma-tnotice__link"
            [text]="true"
            (click)="openPolicy()"
          >
            <i class="ti ti-external-link" aria-hidden="true"></i>
            <span>Privacy policy</span>
          </button>
        </div>
      </div>

      <button
        type="button"
        class="phorma-tnotice__dismiss"
        aria-label="Dismiss the privacy notice"
        (click)="dismiss()"
      >
        <i class="ti ti-x" aria-hidden="true"></i>
      </button>
    </div>
  `,
  styles: [
    `
      /* Frosted card anchored above the 24px status bar. Plain glass like every
         other chrome surface: no specular shimmer, no extra hairline.
         Root font size is 14px, so every rem here is against 14. */
      :host {
        display: contents;
      }

      .phorma-tnotice {
        position: fixed;
        bottom: 40px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 60;
        display: flex;
        align-items: flex-start;
        gap: 12px;
        width: min(34rem, calc(100vw - 2rem));
        padding: 14px 14px 14px 16px;
        border: 1px solid var(--phorma-border, rgba(255, 255, 255, 0.1));
        border-radius: 12px;
        background: var(--phorma-chrome-bg, rgba(14, 15, 18, 0.45));
        backdrop-filter: blur(20px) saturate(200%) brightness(1.04);
        -webkit-backdrop-filter: blur(20px) saturate(200%) brightness(1.04);
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
        animation: phorma-tnotice-rise 0.18s ease-out;
      }

      @keyframes phorma-tnotice-rise {
        from {
          opacity: 0;
          transform: translateX(-50%) translateY(8px);
        }
        to {
          opacity: 1;
          transform: translateX(-50%) translateY(0);
        }
      }

      .phorma-tnotice__icon {
        flex: 0 0 auto;
        margin-top: 1px;
        font-size: 1.143rem;
        color: var(--p-primary-color, #8578f6);
      }

      .phorma-tnotice__body {
        flex: 1 1 auto;
        min-width: 0;
      }

      .phorma-tnotice__title {
        margin: 0;
        font-size: 0.929rem;
        font-weight: 600;
        color: var(--p-text-color);
      }

      .phorma-tnotice__text {
        margin: 4px 0 0;
        font-size: 0.857rem;
        line-height: 1.55;
        color: var(--p-text-muted-color);
      }

      .phorma-tnotice__actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 10px;
      }

      .phorma-tnotice__btn.p-button,
      .phorma-tnotice__link.p-button {
        gap: 6px;
      }

      .phorma-tnotice__link.p-button {
        padding-left: 8px;
        padding-right: 8px;
      }

      /* Bespoke dismiss affordance rather than a button-shaped control: it is
         chrome, and a second bordered button would compete with the primary
         action for attention. */
      .phorma-tnotice__dismiss {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: var(--p-text-muted-color);
        font-size: 0.929rem;
        cursor: pointer;
        transition:
          background 0.15s ease,
          color 0.15s ease;

        &:hover {
          background: color-mix(in srgb, var(--p-text-color) 10%, transparent);
          color: var(--p-text-color);
        }
      }

      @media (prefers-reduced-transparency: reduce) {
        .phorma-tnotice {
          backdrop-filter: none;
          -webkit-backdrop-filter: none;
          background: color-mix(in srgb, var(--phorma-canvas-bg, #0e0f12) 96%, transparent);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .phorma-tnotice {
          animation: none;
        }
      }
    `,
  ],
})
export class TelemetryNotice {
  private readonly telemetry = inject(TelemetryService);
  private readonly settingsDialog = inject(SettingsDialogService);
  private readonly toast = inject(ToastService);
  // The app's one external-link helper: `plugin-opener` on desktop, a
  // `noopener` tab in the browser.
  private readonly links = inject(McpOAuthService);

  /** How many counter names the catalog permits, read from the catalog itself. */
  protected readonly counterCount = COUNTER_CATALOG.size;

  /** Hides the notice for this disclosure version, on every later start (1.3). */
  protected dismiss(): void {
    this.telemetry.dismissNotice();
  }

  /**
   * Opens the Privacy page of the Settings dialog (1.2), through the same
   * `SettingsDialogService` rail every other deep-link uses. Dismisses on the
   * way: the user has read the notice and is now looking at the full detail, so
   * leaving the card behind the dialog would only be noise.
   */
  protected openPrivacySettings(): void {
    this.telemetry.dismissNotice();
    this.settingsDialog.open('privacy');
  }

  protected async openPolicy(): Promise<void> {
    try {
      await this.links.openExternal(PRIVACY_POLICY_URL);
    } catch {
      this.toast.error('Could not open the policy', PRIVACY_POLICY_URL);
    }
  }
}
