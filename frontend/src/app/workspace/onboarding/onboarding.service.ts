import { Injectable, inject, signal } from '@angular/core';

import { TauriService } from '../../core/tauri.service';
import { loadLayout, saveLayout } from '../../core/layout-storage';

/**
 * First-run setup wizard visibility + completion state.
 *
 * The wizard auto-opens on the first desktop launch and can be re-run from
 * Settings. It is deliberately modal-strict: the ONLY exits are finishing
 * the steps or explicitly skipping - both of which mark setup as done so it
 * never auto-opens again. There is no plain "close" API by design.
 *
 * Web mode skips it entirely - the Ollama install step is desktop-only and
 * the browser preview is for debugging, not first-time users.
 */
@Injectable({ providedIn: 'root' })
export class OnboardingService {
  private readonly tauri = inject(TauriService);

  /** Whether the wizard dialog is currently visible. */
  readonly visible = signal(false);

  /** Whether the user has been through the wizard in any way (finish OR skip). */
  readonly completed = signal(loadLayout('firstRunDone', false));

  /** Opens the wizard (first run, or re-run from Settings). */
  open(): void {
    this.visible.set(true);
  }

  /**
   * Closes the wizard and permanently marks setup as done. Called on finish
   * AND on skip - once the user has been through the wizard in any way, it
   * never auto-opens again.
   */
  finish(): void {
    this.visible.set(false);
    this.completed.set(true);
    saveLayout('firstRunDone', true);
  }

  /**
   * Auto-opens the wizard on first desktop launch. Called from the App
   * component constructor. No-op in web mode or when already completed.
   */
  maybeAutoOpen(): void {
    if (this.tauri.isDesktop && !this.completed()) {
      this.open();
    }
  }
}
