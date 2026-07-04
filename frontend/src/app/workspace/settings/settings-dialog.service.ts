import { Injectable, signal } from '@angular/core';

/**
 * Opens/closes the Settings dialog from anywhere (menubar, empty states,
 * properties panel deep-links). `open('integrations')` jumps straight to a
 * specific settings page.
 */
@Injectable({ providedIn: 'root' })
export class SettingsDialogService {
  readonly visible = signal(false);

  /** The settings page to show; the dialog binds its nav to this. */
  readonly activePageId = signal('general');

  open(pageId?: string): void {
    if (pageId) this.activePageId.set(pageId);
    this.visible.set(true);
  }

  close(): void {
    this.visible.set(false);
  }
}
