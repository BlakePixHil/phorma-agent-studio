import { Injectable, signal } from '@angular/core';

import type { SkillDef } from '../../core/skills.model';

/**
 * Opens/closes the skill editor dialog (EPIC 6). `editing` carries the
 * library skill being edited, or null for a brand-new skill.
 */
@Injectable({ providedIn: 'root' })
export class SkillEditorDialogService {
  readonly visible = signal(false);
  /** The skill under edit, or null when creating a new one. */
  readonly editing = signal<SkillDef | null>(null);

  openNew(): void {
    this.editing.set(null);
    this.visible.set(true);
  }

  openEdit(skill: SkillDef): void {
    this.editing.set(skill);
    this.visible.set(true);
  }

  close(): void {
    this.visible.set(false);
    this.editing.set(null);
  }
}
