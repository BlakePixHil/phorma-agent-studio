import { Injectable, signal } from '@angular/core';

/**
 * Streams agent (and background mutation) activity so the canvas can glow the
 * node currently being edited. In Phase 2 there is no LLM wiring yet — this is
 * the rail the future agent engine and a Tauri event channel will push through.
 */
export type AgentActivityKind = 'editing' | 'created' | 'connected' | 'removed';

export interface AgentActivityEvent {
  nodeId: string;
  kind: AgentActivityKind;
  message?: string;
}

@Injectable({ providedIn: 'root' })
export class AgentStreamService {
  /** Node ids currently in an "editing" state, used to drive the canvas glow. */
  private readonly editingNodesState = signal<ReadonlySet<string>>(new Set());

  /** Most recent activity event, for transient UI feedback. */
  private readonly lastEventState = signal<AgentActivityEvent | null>(null);

  readonly editingNodes = this.editingNodesState.asReadonly();
  readonly lastEvent = this.lastEventState.asReadonly();

  /** Returns whether a given node is currently being edited by the agent. */
  isEditing(nodeId: string): boolean {
    return this.editingNodesState().has(nodeId);
  }

  emit(event: AgentActivityEvent): void {
    this.lastEventState.set(event);
    if (event.kind === 'editing') {
      this.markEditing(event.nodeId);
    } else {
      this.clearEditing(event.nodeId);
    }
  }

  markEditing(nodeId: string): void {
    this.editingNodesState.update(set => {
      const next = new Set(set);
      next.add(nodeId);
      return next;
    });
  }

  clearEditing(nodeId: string): void {
    this.editingNodesState.update(set => {
      if (!set.has(nodeId)) return set;
      const next = new Set(set);
      next.delete(nodeId);
      return next;
    });
  }

  clearAll(): void {
    this.editingNodesState.set(new Set());
  }
}
