import { ChangeDetectionStrategy, Component, HostListener, inject } from '@angular/core';
import { DatePipe } from '@angular/common';

import { AssistantChat } from '../assistant-chat/assistant-chat';
import { AssistantChatService } from '../../../core/assistant-chat.service';
import { AssistantDialogService } from '../assistant-dialog.service';
import { WorkflowAnalyzerService } from '../../../core/workflow-analyzer.service';
import { MigrationImportService } from '../../../core/migration/migration-import.service';
import type { ChatThread } from '../../../core/assistant-chat.model';

/**
 * The expanded Assistant dialog (EPIC 5): a large two-pane chat surface —
 * thread list on the left, the shared conversation view on the right, plus
 * the deeper features (workflow analyzer, migration import). Mirrors the
 * bespoke overlay pattern of the cloud/credits dialogs (no p-dialog).
 */
@Component({
  selector: 'app-assistant-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AssistantChat, DatePipe],
  templateUrl: './assistant-dialog.html',
  styleUrl: './assistant-dialog.scss',
})
export class AssistantDialog {
  protected readonly dialog = inject(AssistantDialogService);
  protected readonly chat = inject(AssistantChatService);
  protected readonly analyzer = inject(WorkflowAnalyzerService);
  protected readonly importer = inject(MigrationImportService);

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (!this.dialog.visible()) return;
    if (this.chat.busy()) return;
    this.dialog.close();
  }

  protected onBackdropClick(): void {
    if (this.chat.busy()) return;
    this.dialog.close();
  }

  protected openThread(thread: ChatThread): void {
    this.chat.openThread(thread);
  }

  protected deleteThread(thread: ChatThread, event: Event): void {
    event.stopPropagation();
    void this.chat.deleteThread(thread);
  }

  protected analyze(): void {
    void this.analyzer.analyze();
  }

  protected importWorkflow(): void {
    void this.importer.importFromClipboardOrPrompt();
  }
}
