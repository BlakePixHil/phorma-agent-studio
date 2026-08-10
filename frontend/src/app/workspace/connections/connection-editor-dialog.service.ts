import { Injectable, signal } from '@angular/core';

import type { Connection } from '@phorma/engine';

/**
 * Opens/closes the connection editor dialog (Requirement 19.5). `editing`
 * carries the Connection being edited, or null for a brand-new one - mirrors
 * `SkillEditorDialogService`.
 */
@Injectable({ providedIn: 'root' })
export class ConnectionEditorDialogService {
  readonly visible = signal(false);
  /** The connection under edit, or null when creating a new one. */
  readonly editing = signal<Connection | null>(null);

  openNew(): void {
    this.editing.set(null);
    this.visible.set(true);
  }

  openEdit(connection: Connection): void {
    this.editing.set(connection);
    this.visible.set(true);
  }

  close(): void {
    this.visible.set(false);
    this.editing.set(null);
  }
}
