import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { ButtonModule } from 'primeng/button';
import { TextareaModule } from 'primeng/textarea';

import { AgentConfig } from '../agent-config/agent-config';
import { FieldGenerationService } from '../../../core/field-generation.service';
import { PanelExpandService } from '../../../core/panel-expand.service';
import { SelectionService } from '../../../core/selection.service';
import { WorkflowService } from '../../../core/workflow.service';
import { renderMarkdown } from '../../../shared/markdown/render-markdown';
import { isAgentNode, type AgentNodeData, type WorkflowNode } from '../../../core/workflow.model';

/**
 * The Prompt panel (right side, default tab): the markdown prompt editor for
 * the selected Agent node, plus its model configuration and a live summary of
 * attached tools and handoffs.
 *
 * Everything below the editor lives in {@link AgentConfig}, shared with the
 * expanded Prompt dialog. All prompts are markdown; the preview renders
 * through marked + DOMPurify - never raw innerHTML.
 */
@Component({
  selector: 'app-prompt-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AgentConfig, ButtonModule, TextareaModule],
  templateUrl: './prompt-panel.html',
  styleUrl: './prompt-panel.scss',
})
export class PromptPanel {
  private readonly selection = inject(SelectionService);
  private readonly workflow = inject(WorkflowService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly panelExpand = inject(PanelExpandService);
  protected readonly fieldGen = inject(FieldGenerationService);

  protected readonly previewing = signal(false);

  /** The selected agent node, or null when the selection isn't an agent. */
  protected readonly agent = computed<(WorkflowNode & { data: AgentNodeData }) | null>(() => {
    const node = this.selection.selectedNode();
    return node && isAgentNode(node) ? node : null;
  });

  /** Sanitized HTML preview of the markdown prompt. */
  protected readonly previewHtml = computed<SafeHtml>(() => {
    const agent = this.agent();
    if (!agent) return '';
    return this.sanitizer.bypassSecurityTrustHtml(renderMarkdown(agent.data.prompt));
  });

  protected togglePreview(): void {
    this.previewing.update(value => !value);
  }

  /** Opens the expanded prompt dialog (bigger editor + prompt library). */
  protected expand(): void {
    this.panelExpand.open('prompt');
  }

  /** True while the AI is drafting this agent's prompt. */
  protected readonly generating = computed(
    () => this.fieldGen.generatingFor() === this.agent()?.id,
  );

  /** One-shot AI generation/improvement of the agent's system prompt. */
  protected async generatePrompt(): Promise<void> {
    const agent = this.agent();
    if (!agent || this.generating()) return;
    const prompt = await this.fieldGen.generateAgentPrompt(agent).catch(() => null);
    // Re-read the selection - it may have changed during generation.
    const current = this.agent();
    if (prompt && current?.id === agent.id) {
      this.workflow.updateNodeData(current.id, { prompt });
    }
  }

  protected onPromptInput(event: Event): void {
    const agent = this.agent();
    if (!agent) return;
    const prompt = (event.target as HTMLTextAreaElement | null)?.value ?? '';
    this.workflow.updateNodeData(agent.id, { prompt });
  }
}
