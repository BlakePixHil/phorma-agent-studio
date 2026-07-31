import { Injectable, computed, inject, signal } from '@angular/core';

import { WorkflowService, type OpenWorkflowDoc } from './workflow.service';

/** One workflow the assistant can see, as rendered in the chat context strip. */
export interface AssistantContextItem {
  /** Open-tab id. Stable while the tab is open; the context key. */
  docId: string;
  /** Library workflow id, or null for an unsaved draft. */
  workflowId: string | null;
  name: string;
  nodes: number;
  connections: number;
  /** True for the active document, which is always in context. */
  active: boolean;
  /** True when the tab has edits not yet saved to the library. */
  dirty: boolean;
}

/**
 * What the assistant can see.
 *
 * The workflow you are looking at is ALWAYS in context - that is the whole
 * point of a studio assistant, and making the user add it would be busywork.
 * Additional open tabs are opt-in, added from the document tab's right-click
 * menu, which is how you get the assistant to compare two workflows or copy a
 * pattern from one into another.
 *
 * Context is keyed by open-tab id rather than workflow id, so it covers unsaved
 * drafts and drops itself when the tab closes. It is deliberately session
 * state: a stale context item silently riding along in a later conversation is
 * worse than re-adding it.
 *
 * Injects nothing but {@link WorkflowService}, so the document tab bar can use
 * it without pulling the assistant's model/cloud dependency graph into the
 * layout shell.
 */
@Injectable({ providedIn: 'root' })
export class AssistantContextService {
  private readonly workflow = inject(WorkflowService);

  /** Opt-in tab ids, in the order the user added them. */
  private readonly extraDocIds = signal<readonly string[]>([]);

  /** The active document, always in context. Null before startup completes. */
  readonly active = computed<AssistantContextItem | null>(() => {
    const doc = this.workflow.activeDoc();
    return doc ? itemOf(doc, true) : null;
  });

  /**
   * Opt-in workflows, resolved against the OPEN tabs. Closed tabs disappear on
   * their own, and the active document is filtered out because it is already
   * covered by {@link active}.
   */
  readonly extras = computed<AssistantContextItem[]>(() => {
    const activeDocId = this.workflow.activeDocId();
    const open = new Map(this.workflow.documents().map(doc => [doc.docId, doc]));
    return this.extraDocIds()
      .filter(docId => docId !== activeDocId)
      .map(docId => open.get(docId))
      .filter((doc): doc is OpenWorkflowDoc => doc !== undefined)
      .map(doc => itemOf(doc, false));
  });

  /** Everything in context, active first - what the chat strip renders. */
  readonly items = computed<AssistantContextItem[]>(() => {
    const active = this.active();
    return active ? [active, ...this.extras()] : this.extras();
  });

  /** True when this tab is in context, either as the active doc or an extra. */
  has(docId: string): boolean {
    return this.workflow.activeDocId() === docId || this.extraDocIds().includes(docId);
  }

  /** True when this tab is in context only because it is the active document. */
  isActive(docId: string): boolean {
    return this.workflow.activeDocId() === docId;
  }

  add(docId: string): void {
    if (this.extraDocIds().includes(docId)) return;
    this.extraDocIds.update(ids => [...ids, docId]);
  }

  remove(docId: string): void {
    this.extraDocIds.update(ids => ids.filter(id => id !== docId));
  }

  /** Adds the tab when absent, removes it when present. */
  toggle(docId: string): void {
    if (this.extraDocIds().includes(docId)) this.remove(docId);
    else this.add(docId);
  }

  clear(): void {
    this.extraDocIds.set([]);
  }

  /**
   * The open documents behind the opt-in context items, for prompt assembly.
   * Returns the live docs (not clones) - callers only read from them.
   */
  extraDocuments(): OpenWorkflowDoc[] {
    const activeDocId = this.workflow.activeDocId();
    const open = new Map(this.workflow.documents().map(doc => [doc.docId, doc]));
    return this.extraDocIds()
      .filter(docId => docId !== activeDocId)
      .map(docId => open.get(docId))
      .filter((doc): doc is OpenWorkflowDoc => doc !== undefined);
  }
}

function itemOf(doc: OpenWorkflowDoc, active: boolean): AssistantContextItem {
  return {
    docId: doc.docId,
    workflowId: doc.workflowId,
    name: doc.name,
    nodes: doc.graph.nodes.length,
    connections: doc.graph.connections.length,
    active,
    dirty: doc.dirty,
  };
}
