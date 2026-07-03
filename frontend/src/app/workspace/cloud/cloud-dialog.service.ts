import { Injectable, signal } from '@angular/core';

/** Opens/closes the Cloud dialog from anywhere (toolbar, Runs panel). */
@Injectable({ providedIn: 'root' })
export class CloudDialogService {
  readonly visible = signal(false);

  open(): void {
    this.visible.set(true);
  }

  close(): void {
    this.visible.set(false);
  }
}
