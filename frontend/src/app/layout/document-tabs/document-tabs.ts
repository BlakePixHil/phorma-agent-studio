import {
  ChangeDetectionStrategy,
  Component,
  inject,
} from '@angular/core';
import {
  CdkDrag,
  CdkDragDrop,
  CdkDragPreview,
  CdkDropList,
} from '@angular/cdk/drag-drop';

import { WorkflowService, type OpenWorkflowDoc } from '../../core/workflow.service';
import { SelectionService } from '../../core/selection.service';
import { ConfirmDialogService } from '../../shared/confirm-dialog/confirm-dialog.service';

/**
 * Document tab bar — the strip below the toolbar that lists every open
 * workflow. Tabs are closable and reorderable; each shows an unsaved dot when
 * its draft has edits and confirms with Save / Discard / Cancel on close.
 *
 * The bar offsets its left/right edges by the adjacent sidebar widths so it
 * never overlaps the panels (mirrors the canvas minimap offset pattern).
 */
@Component({
  selector: 'app-document-tabs',
  imports: [CdkDropList, CdkDrag, CdkDragPreview],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './document-tabs.html',
  styleUrl: './document-tabs.scss',
})
export class DocumentTabs {
  private readonly workflow = inject(WorkflowService);
  private readonly selection = inject(SelectionService);
  private readonly confirmDialog = inject(ConfirmDialogService);

  protected readonly documents = this.workflow.documents;
  protected readonly activeDocId = this.workflow.activeDocId;

  /** Activates a workflow tab. */
  protected openDocument(doc: OpenWorkflowDoc): void {
    if (this.activeDocId() === doc.docId) return;
    this.workflow.activateDocument(doc.docId);
    this.selection.clear();
  }

  /** Opens a fresh untitled workflow (the "+" button). */
  protected newWorkflow(): void {
    this.workflow.newWorkflow();
    this.selection.clear();
  }

  /** Middle-click closes a tab (browser-style). */
  protected onAuxClick(event: MouseEvent, doc: OpenWorkflowDoc): void {
    if (event.button === 1) {
      event.preventDefault();
      void this.closeDocument(event, doc);
    }
  }

  /**
   * Closes a workflow tab. When the tab has unsaved edits, prompts with a
   * Save / Discard / Cancel dialog first.
   */
  protected async closeDocument(event: Event, doc: OpenWorkflowDoc): Promise<void> {
    event.stopPropagation();

    if (doc.dirty) {
      const result = await this.confirmDialog.confirmThreeWay({
        title: 'Unsaved changes',
        message: `"${doc.name}" has unsaved changes. Save before closing?`,
        alternateLabel: 'Save',
        confirmLabel: 'Discard',
        cancelLabel: 'Cancel',
        tone: 'danger',
      });
      if (result === 'cancel') return;
      if (result === 'alternate') {
        // Make the tab active so its draft is live, then save it.
        if (this.activeDocId() !== doc.docId) {
          this.workflow.activateDocument(doc.docId);
        }
        const saved = await this.workflow.saveActive();
        if (!saved) return; // save failed — keep the tab open
      }
    }

    this.workflow.closeDocument(doc.docId);
    this.selection.clear();
  }

  /** Commits a drag-reorder of the tab strip. */
  protected onDrop(event: CdkDragDrop<OpenWorkflowDoc[]>): void {
    this.workflow.reorderDocuments(event.previousIndex, event.currentIndex);
  }
}
