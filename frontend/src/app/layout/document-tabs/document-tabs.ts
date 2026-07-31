import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import {
  CdkDrag,
  CdkDragDrop,
  CdkDragPreview,
  CdkDropList,
} from '@angular/cdk/drag-drop';
import { ContextMenuModule } from 'primeng/contextmenu';
import type { MenuItem } from 'primeng/api';

import { AssistantContextService } from '../../core/assistant-context.service';
import { PanelRegistryService } from '../../core/panel-registry.service';
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
  imports: [CdkDropList, CdkDrag, CdkDragPreview, ContextMenuModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './document-tabs.html',
  styleUrl: './document-tabs.scss',
})
export class DocumentTabs {
  private readonly workflow = inject(WorkflowService);
  private readonly selection = inject(SelectionService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly assistantContext = inject(AssistantContextService);
  private readonly panels = inject(PanelRegistryService);

  protected readonly documents = this.workflow.documents;
  protected readonly activeDocId = this.workflow.activeDocId;

  /** True when a tab is one the assistant can see. Drives the tab marker. */
  protected inAssistantContext(doc: OpenWorkflowDoc): boolean {
    return this.assistantContext.has(doc.docId);
  }

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
  protected async closeDocument(event: Event | null, doc: OpenWorkflowDoc): Promise<void> {
    // Null when the close came from the right-click menu rather than the ✕.
    event?.stopPropagation();

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

  // ── Right-click menu ──────────────────────────────────────────────────────

  /** Tab the context menu is bound to (set on right-click, before it opens). */
  private readonly contextDoc = signal<OpenWorkflowDoc | null>(null);

  /**
   * The tab strip is the menu's target. PrimeNG v20 needs an explicit
   * `[target]` or it never binds its contextmenu listener, and a signal-based
   * `viewChild` is what resolves once the strip has rendered (same pattern as
   * the sidebar tab menu).
   */
  private readonly tabStripRef = viewChild<ElementRef<HTMLElement>>('tabStrip');
  protected readonly tabStripTarget = computed(() => this.tabStripRef()?.nativeElement);

  protected onTabContextMenu(doc: OpenWorkflowDoc): void {
    this.contextDoc.set(doc);
  }

  /**
   * Flat menu, no submenus: PrimeNG opens submenus on hover, which synthetic
   * clicks cannot reach in tests.
   */
  protected readonly tabContextMenuItems = computed<MenuItem[]>(() => {
    const doc = this.contextDoc();
    if (!doc) return [];
    const active = this.assistantContext.isActive(doc.docId);
    const present = this.assistantContext.has(doc.docId);
    return [
      {
        label: active
          ? 'Always in assistant context'
          : present
            ? 'Remove from assistant context'
            : 'Add to assistant context',
        icon: present ? 'ti ti-eye-off' : 'ti ti-eye',
        // The active document is context by definition, so there is nothing to
        // toggle - the item stays as an explanation rather than disappearing.
        disabled: active,
        command: () => this.toggleAssistantContext(doc),
      },
      { separator: true },
      {
        label: 'Close',
        icon: 'ti ti-x',
        command: () => void this.closeDocument(null, doc),
      },
    ];
  });

  /**
   * Adds or removes a tab from the assistant's context, revealing the Assistant
   * panel on add so the user sees the chip they just created.
   */
  private toggleAssistantContext(doc: OpenWorkflowDoc): void {
    const adding = !this.assistantContext.has(doc.docId);
    this.assistantContext.toggle(doc.docId);
    if (!adding) return;
    const side = this.panels.tabs().find(tab => tab.id === 'assistant')?.side ?? 'right';
    this.panels.setActive(side, 'assistant');
    if (side === 'left') this.panels.collapsedLeft.set(false);
    else this.panels.collapsedRight.set(false);
  }
}
