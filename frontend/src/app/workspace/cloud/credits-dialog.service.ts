import { Injectable, signal } from '@angular/core';

/** Opens/closes the Buy Credits dialog from anywhere (Settings, toast CTAs). */
@Injectable({ providedIn: 'root' })
export class CreditsDialogService {
  readonly visible = signal(false);

  open(): void {
    this.visible.set(true);
  }

  close(): void {
    this.visible.set(false);
  }
}
