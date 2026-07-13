import { Injectable, signal } from '@angular/core';

import { loadLayout, saveLayout } from './layout-storage';

/**
 * How the AI applies edits to the canvas:
 * - `plan`  — one-shot: the model emits a complete JSON edit plan which is
 *             validated and then played back op-by-op with the glow effect.
 * - `agent` — live tool loop: the model iteratively calls graph tools and the
 *             canvas updates node-by-node as it works.
 */
export type BuilderMode = 'plan' | 'agent';

/**
 * Open/close state for the AI command palette (Ctrl+P / Cmd+P).
 *
 * Deliberately minimal — the palette is designed to grow beyond the AI
 * workflow builder (future: quick actions, chat continuation). Anything
 * specific to the AI builder itself (status, progress, errors) lives in
 * `WorkflowBuilderService`; this service only owns the shell.
 */
@Injectable({ providedIn: 'root' })
export class CommandPaletteService {
  readonly visible = signal(false);

  /** Selected builder mode, persisted across sessions. */
  readonly mode = signal<BuilderMode>(loadLayout<BuilderMode>('builderMode', 'plan'));

  open(): void {
    this.visible.set(true);
  }

  close(): void {
    this.visible.set(false);
  }

  toggle(): void {
    this.visible.update(v => !v);
  }

  setMode(mode: BuilderMode): void {
    this.mode.set(mode);
    saveLayout('builderMode', mode);
  }
}
