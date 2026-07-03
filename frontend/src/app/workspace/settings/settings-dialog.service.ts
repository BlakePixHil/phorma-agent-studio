import { Injectable, signal } from '@angular/core';

/** Opens/closes the Settings dialog from anywhere (toolbar, empty states). */
@Injectable({ providedIn: 'root' })
export class SettingsDialogService {
  readonly visible = signal(false);

  open(): void {
    this.visible.set(true);
  }

  close(): void {
    this.visible.set(false);
  }
}
