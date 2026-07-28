import { Injectable, computed, signal } from '@angular/core';

/**
 * Side panels that can be expanded into a full-size dialog.
 *
 * These ids intentionally match the {@link PanelTab} ids in
 * `panel-registry.service.ts` so the toolbar can map the active right-side
 * tab straight onto an expandable surface.
 */
export type ExpandablePanelId = 'prompt' | 'properties' | 'evals' | 'usage';

/** Every expandable panel id, in right-sidebar order. */
export const EXPANDABLE_PANEL_IDS: readonly ExpandablePanelId[] = [
  'prompt',
  'properties',
  'evals',
  'usage',
] as const;

/** Narrows an arbitrary panel tab id to an expandable one. */
export function isExpandablePanelId(id: string): id is ExpandablePanelId {
  return (EXPANDABLE_PANEL_IDS as readonly string[]).includes(id);
}

/**
 * Owns which side panel is currently expanded into a dialog.
 *
 * A single signal (rather than one `visible` flag per dialog) enforces the
 * "only one expanded dialog at a time" invariant for free, and lets the
 * toolbar toggle whatever is active without knowing the dialog components.
 *
 * Deliberately dependency-free: the expanded dialogs read the same services
 * as their sidebar counterparts, so expanding never copies state — it is the
 * same workflow document, the same eval suites, the same usage ledger.
 * Panel collapse/width state in `PanelRegistryService` is left untouched.
 */
@Injectable({ providedIn: 'root' })
export class PanelExpandService {
  private readonly _expanded = signal<ExpandablePanelId | null>(null);

  /** The expanded panel, or null when no dialog is open. */
  readonly expanded = this._expanded.asReadonly();

  /** True while any panel is expanded (used to suppress canvas shortcuts). */
  readonly anyOpen = computed(() => this._expanded() !== null);

  isOpen(id: ExpandablePanelId): boolean {
    return this._expanded() === id;
  }

  open(id: ExpandablePanelId): void {
    this._expanded.set(id);
  }

  close(): void {
    this._expanded.set(null);
  }

  toggle(id: ExpandablePanelId): void {
    this._expanded.update(current => (current === id ? null : id));
  }
}
