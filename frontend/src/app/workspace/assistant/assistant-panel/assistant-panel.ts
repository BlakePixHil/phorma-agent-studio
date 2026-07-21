import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';

import { AssistantChat } from '../assistant-chat/assistant-chat';
import { AssistantChatService } from '../../../core/assistant-chat.service';
import { AssistantDialogService } from '../assistant-dialog.service';
import type { ChatThread } from '../../../core/assistant-chat.model';

/**
 * The Assistant sidebar panel (EPIC 5): a compact chat surface. Shows the
 * per-workflow thread list when no conversation is open, and the shared
 * {@link AssistantChat} view when one is. The expand button (top right)
 * hands the SAME conversation to the large dialog.
 */
@Component({
  selector: 'app-assistant-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AssistantChat, DatePipe],
  templateUrl: './assistant-panel.html',
  styleUrl: './assistant-panel.scss',
})
export class AssistantPanel {
  protected readonly chat = inject(AssistantChatService);
  protected readonly dialog = inject(AssistantDialogService);

  protected openThread(thread: ChatThread): void {
    this.chat.openThread(thread);
  }

  protected deleteThread(thread: ChatThread, event: Event): void {
    event.stopPropagation();
    void this.chat.deleteThread(thread);
  }

  protected expand(): void {
    this.dialog.open();
  }
}
