import { Injectable, inject, signal } from '@angular/core';

import { WorkflowService } from './workflow.service';
import type { WorkflowGraph } from './workflow.model';

/**
 * One AI editing transaction on a workflow document. Captures the graph
 * BEFORE the AI touched it so the whole edit can be reverted atomically,
 * plus a human-readable log of what was applied.
 *
 * Designed for growth: a future chat continuation appends more ops to the
 * same open transaction, and a future diff view renders `ops` against
 * `before`. `HistoryService` snapshots remain untouched — Ctrl+Z still works
 * independently of this record.
 */
export interface WorkflowEditTransaction {
  id: string;
  /** Document the edit applies to (transactions never cross tabs). */
  docId: string;
  /** The user's natural-language request that started the transaction. */
  request: string;
  /** Deep clone of the graph before the first AI mutation. */
  before: WorkflowGraph;
  /** Human-readable descriptions of each applied operation, in order. */
  ops: string[];
  startedAt: number;
}

let transactionCounter = 0;

/**
 * Owns the lifecycle of AI edit transactions: begin → record ops → settle
 * (keep or revert). At most one transaction is pending review at a time —
 * starting a new AI run implicitly keeps the previous result.
 */
@Injectable({ providedIn: 'root' })
export class AiEditSessionService {
  private readonly workflow = inject(WorkflowService);

  /** The last finished transaction awaiting a keep/revert decision. */
  readonly pendingReview = signal<WorkflowEditTransaction | null>(null);

  /** The transaction currently being written to by a running AI build. */
  private active: WorkflowEditTransaction | null = null;

  /**
   * Opens a transaction against the active document, snapshotting the
   * current graph. Any previous unreviewed transaction is implicitly kept.
   */
  begin(request: string): WorkflowEditTransaction {
    this.pendingReview.set(null);
    transactionCounter += 1;
    const docId = this.workflow.activeDoc()?.docId ?? '';
    this.active = {
      id: `ai-edit-${Date.now().toString(36)}-${transactionCounter}`,
      docId,
      request,
      before: structuredClone(this.workflow.graph()),
      ops: [],
      startedAt: Date.now(),
    };
    return this.active;
  }

  /** Appends a human-readable op description to the active transaction. */
  record(op: string): void {
    this.active?.ops.push(op);
  }

  /**
   * Closes the active transaction and offers it for review (Revert/Keep
   * toast). No-op when nothing was applied — an empty transaction needs no
   * review.
   */
  commit(): void {
    const txn = this.active;
    this.active = null;
    if (!txn || txn.ops.length === 0) return;
    this.pendingReview.set(txn);
  }

  /** Abandons the active transaction, restoring the pre-edit graph. */
  rollbackActive(): void {
    const txn = this.active;
    this.active = null;
    if (!txn || txn.ops.length === 0) return;
    this.restore(txn);
  }

  /** Reverts the pending-review transaction (the "Revert" toast action). */
  revert(): void {
    const txn = this.pendingReview();
    this.pendingReview.set(null);
    if (!txn) return;
    this.restore(txn);
  }

  /** Accepts the pending-review transaction (the "Keep" toast action). */
  keep(): void {
    this.pendingReview.set(null);
  }

  private restore(txn: WorkflowEditTransaction): void {
    // Only restore when the transaction's document is still active —
    // replaceGraph operates on the active tab.
    if (this.workflow.activeDoc()?.docId !== txn.docId) return;
    this.workflow.replaceGraph(structuredClone(txn.before));
  }
}
