import { effect, Injectable, signal } from '@angular/core';
import { loadLayout, saveLayout } from './layout-storage';

export type ZoomCommand = 'in' | 'out' | 'reset' | 'fit' | null;

/**
 * Which corner of the canvas the minimap is anchored to.
 * The minimap offsets itself from the adjacent sidebars and console dock
 * based on this setting.
 */
export type MinimapAnchor = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** All valid minimap anchors (used by settings UI). */
export const MINIMAP_ANCHORS: MinimapAnchor[] = [
  'top-left', 'top-right', 'bottom-left', 'bottom-right',
];

/** Grid spacing (in canvas-space px) used when grid snapping is enabled. */
export const GRID_SNAP_SIZE = 24;

/**
 * Lightweight reactive canvas view state shared between the canvas and the
 * app shell (zoom, grid, minimap). Document state lives in WorkflowService.
 */
@Injectable({ providedIn: 'root' })
export class CanvasStateService {
  /** Current zoom scale (integer %). Written by Canvas, read by App shell. */
  readonly zoomScale = signal(100);

  /** Whether the dot grid is visible. Toggled by View > Toggle Grid. */
  readonly gridVisible = signal(loadLayout('gridVisible', true));

  /**
   * Whether node dragging snaps to the grid. Off by default; toggled via
   * the View menu, a hotkey, or the toolbar icon button. Persisted across
   * sessions via localStorage.
   */
  readonly gridSnap = signal(loadLayout('gridSnap', false));

  /**
   * Whether the canvas minimap is visible. Toggled via the View menu.
   * Persisted across sessions via localStorage.
   */
  readonly minimapVisible = signal(loadLayout('minimapVisible', true));

  /** Which corner the minimap is anchored to. Persisted across sessions. */
  readonly minimapAnchor = signal<MinimapAnchor>(loadLayout('minimapAnchor', 'bottom-right'));

  /**
   * One-shot zoom command fired by the toolbar View menu.
   * Canvas reads this via effect() and resets to null after executing.
   */
  readonly zoomCommand = signal<ZoomCommand>(null);

  /**
   * Remembered canvas transform (scale + pan offset) keyed by document id.
   * Lets the canvas restore the exact view when switching workflow tabs
   * instead of refitting.
   */
  private readonly canvasTransforms = new Map<string, { sc: number; ox: number; oy: number }>();

  /** Stores the current canvas transform for a document key. */
  saveCanvasTransform(key: string, t: { sc: number; ox: number; oy: number }): void {
    this.canvasTransforms.set(key, t);
  }

  /** Returns the remembered transform for a document key, or null if none. */
  getCanvasTransform(key: string): { sc: number; ox: number; oy: number } | null {
    return this.canvasTransforms.get(key) ?? null;
  }

  constructor() {
    // Persist layout state whenever it changes. Best-effort: writes are
    // wrapped in try/catch inside saveLayout.
    effect(() => saveLayout('gridVisible', this.gridVisible()));
    effect(() => saveLayout('gridSnap', this.gridSnap()));
    effect(() => saveLayout('minimapVisible', this.minimapVisible()));
    effect(() => saveLayout('minimapAnchor', this.minimapAnchor()));
  }

  /** Snaps a canvas-space coordinate to the nearest grid cell. */
  snap(value: number): number {
    return Math.round(value / GRID_SNAP_SIZE) * GRID_SNAP_SIZE;
  }

  /** Snaps a 2D position to the grid. */
  snapPosition(pos: { x: number; y: number }): { x: number; y: number } {
    return { x: this.snap(pos.x), y: this.snap(pos.y) };
  }
}
