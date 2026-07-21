import { Injectable, inject } from '@angular/core';

import { AssistantChatService } from '../assistant-chat.service';
import { ToastService } from '../../shared/toast/toast.service';
import { WorkflowService } from '../workflow.service';
import { buildConverterSystemPrompt } from '../workflow-builder-prompt';
import {
  detectForeignWorkflow,
  summarizeForeignWorkflow,
  type ForeignWorkflow,
} from './foreign-workflow';

/**
 * The migration converter (EPIC 5): turns a pasted n8n / Flowise / Dify
 * workflow export into a Phorma edit-plan proposal in the assistant chat.
 *
 * Two entry points:
 * - pasting an export directly into the chat input (the chat component
 *   detects the shape via {@link detect} and routes here), and
 * - the dialog's Import button, which reads the clipboard.
 */
@Injectable({ providedIn: 'root' })
export class MigrationImportService {
  private readonly chat = inject(AssistantChatService);
  private readonly workflow = inject(WorkflowService);
  private readonly toast = inject(ToastService);

  /** Shape-detects a pasted message. Null = not a workflow export. */
  detect(text: string): ForeignWorkflow | null {
    return detectForeignWorkflow(text);
  }

  /** Converts a detected foreign workflow via a Plan-mode chat task. */
  async convert(foreign: ForeignWorkflow): Promise<void> {
    if (this.chat.busy()) return;
    const label = `Import from ${sourceLabel(foreign.source)}${
      foreign.name ? `: "${foreign.name}"` : ''
    } (${foreign.nodes.length} nodes)`;
    await this.chat.sendTask({
      label,
      request: `Convert this ${sourceLabel(foreign.source)} workflow to a Phorma workflow:\n\n${summarizeForeignWorkflow(foreign)}`,
      system: buildConverterSystemPrompt(this.workflow.graph()),
      mode: 'plan',
      origin: 'converter',
    });
  }

  /**
   * The dialog's Import button: reads the clipboard and converts when it
   * holds a recognizable export, otherwise guides the user to paste into
   * the chat input.
   */
  async importFromClipboardOrPrompt(): Promise<void> {
    if (this.chat.busy()) return;
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      // Clipboard permission denied — fall through to the guidance toast.
    }
    const foreign = text ? this.detect(text) : null;
    if (foreign) {
      await this.convert(foreign);
      return;
    }
    this.toast.warning(
      'No workflow export found in your clipboard. Copy an n8n, Flowise, or Dify export (JSON) and try again — or paste it straight into the chat.',
    );
  }
}

function sourceLabel(source: ForeignWorkflow['source']): string {
  switch (source) {
    case 'n8n':
      return 'n8n';
    case 'flowise':
      return 'Flowise';
    case 'dify':
      return 'Dify';
  }
}
