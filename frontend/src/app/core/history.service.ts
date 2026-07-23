import { computed, effect, inject, Injectable, signal } from '@angular/core';

import { WorkflowService } from './workflow.service';
import type { WorkflowGraph } from './workflow.model';

/**
 * Maximum number of snapshots retained per stack. Beyond this the oldest
 * snapshot is discarded — memory stays bounded on long editing sessions.
 */
const MAX_HISTORY = 100;

/**
 * Minimum gap (in ms) between two snapshots for them to be considered
 * distinct edits. Snapshots taken within this window replace the previous
 * one — this coalesces rapid signal updates (e.g. a drag fires many
 * `moveNodes` commits) into a single undoable step.
 */
const COALESCE_MS = 400;

/**
 * Reactive undo/redo for the active workflow graph.
 *
 * The graph is a plain serialisable value, so we use snapshot-based history.
 * An `effect` watches the active graph signal and, whenever it changes,
 * pushes the PREVIOUS value onto the undo stack. Every mutation (drag, add,
 * delete, prompt edit, paste) is automatically undoable without call sites
 * having to remember to snapshot.
 *
 * Switching workflow tabs resets both stacks — each document would otherwise
 * leak snapshots into its neighbours' timelines.
 *
 * Undo/redo swap the live graph via `replaceGraph`; a guard (`isApplying`)
 * prevents the tracking effect from treating those programmatic restores as
 * new user edits.
 */
@Injectable({ providedIn: 'root' })
export class HistoryService {
  private readonly workflow = inject(WorkflowService);

  private readonly undoStack = signal<WorkflowGraph[]>([]);
  private readonly redoStack = signal<WorkflowGraph[]>([]);

  /** True when there is at least one snapshot to undo. */
  readonly canUndo = computed(() => this.undoStack().length > 0);
  /** True when there is at least one snapshot to redo. */
  readonly canRedo = computed(() => this.redoStack().length > 0);

  /** The graph value captured at the last effect run. */
  private trackedGraph: WorkflowGraph | null = null;
  /** Timestamp of the last push — used for coalescing rapid edits. */
  private lastPushAt = 0;
  /**
   * Set while undo/redo is restoring a snapshot, so the tracking effect
   * doesn't treat the programmatic restore as a brand-new user edit.
   */
  private isApplying = false;
  /** Last observed document id — used to reset history on tab switch. */
  private trackedDocId: string | null = null;
  /** Forces the next observed user edit to start a fresh undo step. */
  private boundaryPending = false;

  constructor() {
    effect(() => {
      const docId = this.workflow.activeDocId();
      const current = this.workflow.graph();

      // On tab switch, reset history and re-seed the tracker without
      // pushing — different documents have independent timelines.
      if (this.trackedDocId !== docId) {
        this.trackedDocId = docId;
        this.undoStack.set([]);
        this.redoStack.set([]);
        this.trackedGraph = current;
        this.lastPushAt = 0;
        this.boundaryPending = false;
        return;
      }

      // On first run just seed the tracker without pushing.
      if (this.trackedGraph === null) {
        this.trackedGraph = current;
        return;
      }

      // Skip when the change is our own undo/redo restore. The guard is
      // cleared here (inside the effect) so it stays active until the
      // tracking effect has processed the programmatic graph swap.
      if (this.isApplying) {
        this.trackedGraph = current;
        this.isApplying = false;
        return;
      }

      // Skip no-op updates (same reference).
      if (this.trackedGraph === current) return;

      const previous = this.trackedGraph;
      this.trackedGraph = current;

      const now = Date.now();
      if (
        !this.boundaryPending &&
        now - this.lastPushAt < COALESCE_MS &&
        this.undoStack().length > 0
      ) {
        // Coalesce: a burst of rapid edits collapses to a single undo step
        // pointing back to the pre-burst graph.
        this.undoStack.update(stack => [...stack.slice(0, -1), this.clone(previous)]);
      } else {
        this.undoStack.update(stack => [...stack, this.clone(previous)].slice(-MAX_HISTORY));
      }
      this.boundaryPending = false;
      this.lastPushAt = now;
      // Any new user edit clears the redo stack.
      this.redoStack.set([]);
    });
  }

  /**
   * Makes the next graph mutation an explicit one-shot undo boundary. Use
   * before atomic graph replacements that must not merge with a prior edit.
   */
  boundaryOnce(): void {
    this.boundaryPending = true;
  }

  /** Restores the previous graph state, pushing the current state onto redo. */
  undo(): void {
    const stack = this.undoStack();
    if (stack.length === 0) return;

    const previous = stack[stack.length - 1];
    const current = this.workflow.graph();

    this.undoStack.update(s => s.slice(0, -1));
    this.redoStack.update(s => [...s, this.clone(current)].slice(-MAX_HISTORY));

    this.isApplying = true;
    this.workflow.replaceGraph(this.clone(previous));
    this.trackedGraph = previous;
    this.lastPushAt = 0;
    this.boundaryPending = false;
  }

  /** Re-applies a previously undone state, pushing the current state onto undo. */
  redo(): void {
    const stack = this.redoStack();
    if (stack.length === 0) return;

    const next = stack[stack.length - 1];
    const current = this.workflow.graph();

    this.redoStack.update(s => s.slice(0, -1));
    this.undoStack.update(s => [...s, this.clone(current)].slice(-MAX_HISTORY));

    this.isApplying = true;
    this.workflow.replaceGraph(this.clone(next));
    this.trackedGraph = next;
    this.lastPushAt = 0;
    this.boundaryPending = false;
  }

  private clone(graph: WorkflowGraph): WorkflowGraph {
    return structuredClone(graph);
  }
}
