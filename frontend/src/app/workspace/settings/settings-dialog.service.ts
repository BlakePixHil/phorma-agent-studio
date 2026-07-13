import { Injectable, signal } from '@angular/core';

/**
 * Opens/closes the Settings dialog from anywhere (menubar, empty states,
 * properties panel deep-links). `open('integrations')` jumps straight to a
 * specific settings page.
 *
 * Pass an `anchorId` to scroll to a specific element after the dialog opens,
 * e.g. `open('integrations', 'integration-github-token')` opens the
 * Integrations page and scrolls to the GitHub token card.
 */
@Injectable({ providedIn: 'root' })
export class SettingsDialogService {
  readonly visible = signal(false);

  /** The settings page to show; the dialog binds its nav to this. */
  readonly activePageId = signal('general');

  /**
   * An element id to scroll into view after the dialog opens (without the
   * leading `#`). Cleared after the dialog consumes it. When null, the
   * content area starts at the top.
   */
  readonly anchorId = signal<string | null>(null);

  open(pageId?: string, anchorId?: string): void {
    if (pageId) this.activePageId.set(pageId);
    this.anchorId.set(anchorId ?? null);
    this.visible.set(true);
  }

  close(): void {
    this.visible.set(false);
    this.anchorId.set(null);
  }
}
