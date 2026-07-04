import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

import { SelectionService } from '../../../core/selection.service';
import { SettingsService } from '../../../core/settings.service';
import { WorkflowService } from '../../../core/workflow.service';
import {
  MODEL_PROVIDERS,
  PROVIDER_MODEL_SUGGESTIONS,
  findNodeForConnector,
  isAgentNode,
  portBaseId,
  type AgentNodeData,
  type ModelProviderId,
  type WorkflowNode,
} from '../../../core/workflow.model';

/**
 * Sentinel select value meaning "inherit the application default model"
 * (agents store no provider/model in that case).
 */
const DEFAULT_PROVIDER_OPTION = '__default__';

/**
 * The Prompt panel (right side, default tab): the markdown prompt editor for
 * the selected Agent node, plus its model configuration and a live summary of
 * attached tools and handoffs.
 *
 * All prompts are markdown. The preview renders through marked + DOMPurify —
 * never raw innerHTML.
 */
@Component({
  selector: 'app-prompt-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, SelectModule],
  templateUrl: './prompt-panel.html',
  styleUrl: './prompt-panel.scss',
})
export class PromptPanel {
  private readonly selection = inject(SelectionService);
  private readonly workflow = inject(WorkflowService);
  private readonly settings = inject(SettingsService);
  private readonly sanitizer = inject(DomSanitizer);

  /** Provider options: "Application default" first, then explicit providers. */
  protected readonly providers = [
    { id: DEFAULT_PROVIDER_OPTION, label: 'Application default' },
    ...MODEL_PROVIDERS,
  ];
  protected readonly previewing = signal(false);

  /** The selected agent node, or null when the selection isn't an agent. */
  protected readonly agent = computed<(WorkflowNode & { data: AgentNodeData }) | null>(() => {
    const node = this.selection.selectedNode();
    return node && isAgentNode(node) ? node : null;
  });

  /** Whether the agent inherits the application default model. */
  protected readonly inheritsDefault = computed(() => !this.agent()?.data.provider);

  /** The select value for the provider dropdown (sentinel when inheriting). */
  protected readonly providerValue = computed(
    () => this.agent()?.data.provider ?? DEFAULT_PROVIDER_OPTION,
  );

  /** Human-readable resolved default, shown as a hint while inheriting. */
  protected readonly resolvedDefaultLabel = computed(() => {
    const provider = MODEL_PROVIDERS.find(p => p.id === this.settings.defaultProvider());
    return `${provider?.label ?? this.settings.defaultProvider()} · ${this.settings.defaultModel()}`;
  });

  /** Model suggestions for the agent's current provider. */
  protected readonly modelSuggestions = computed(() => {
    const agent = this.agent();
    if (!agent?.data.provider) return [];
    return PROVIDER_MODEL_SUGGESTIONS[agent.data.provider];
  });

  /** Tools attached to this agent via tool-links. */
  protected readonly attachedTools = computed<WorkflowNode[]>(() => {
    const agent = this.agent();
    if (!agent) return [];
    const graph = this.workflow.graph();
    const toolsPortIds = new Set(
      agent.ports.filter(port => port.role === 'tools').map(port => port.id),
    );
    return graph.connections
      .filter(conn => conn.kind === 'tool-link' && toolsPortIds.has(portBaseId(conn.outputId)))
      .flatMap(conn => {
        const target = findNodeForConnector(graph, conn.inputId);
        return target ? [target.node] : [];
      });
  });

  /** Agents this one hands off to. */
  protected readonly handoffTargets = computed<WorkflowNode[]>(() => {
    const agent = this.agent();
    if (!agent) return [];
    const graph = this.workflow.graph();
    const outPortIds = new Set(
      agent.ports.filter(port => port.role === 'message-out').map(port => port.id),
    );
    return graph.connections
      .filter(conn => conn.kind === 'handoff' && outPortIds.has(portBaseId(conn.outputId)))
      .flatMap(conn => {
        const target = findNodeForConnector(graph, conn.inputId);
        return target ? [target.node] : [];
      });
  });

  /** Sanitized HTML preview of the markdown prompt. */
  protected readonly previewHtml = computed<SafeHtml>(() => {
    const agent = this.agent();
    if (!agent) return '';
    const raw = marked.parse(agent.data.prompt, { async: false });
    return this.sanitizer.bypassSecurityTrustHtml(DOMPurify.sanitize(raw));
  });

  protected togglePreview(): void {
    this.previewing.update(value => !value);
  }

  protected onPromptInput(event: Event): void {
    const agent = this.agent();
    if (!agent) return;
    const prompt = (event.target as HTMLTextAreaElement | null)?.value ?? '';
    this.workflow.updateNodeData(agent.id, { prompt });
  }

  protected onProviderChange(value: string): void {
    const agent = this.agent();
    if (!agent) return;
    if (value === DEFAULT_PROVIDER_OPTION) {
      // Inherit the application default: clear the explicit model config.
      if (!agent.data.provider) return;
      this.workflow.updateNodeData(agent.id, { provider: undefined, model: undefined });
      return;
    }
    const provider = value as ModelProviderId;
    if (agent.data.provider === provider) return;
    // Switching provider resets the model to that provider's first suggestion.
    this.workflow.updateNodeData(agent.id, {
      provider,
      model: PROVIDER_MODEL_SUGGESTIONS[provider][0] ?? '',
    });
  }

  protected onModelInput(event: Event): void {
    const agent = this.agent();
    if (!agent) return;
    this.workflow.updateNodeData(agent.id, {
      model: (event.target as HTMLInputElement | null)?.value ?? '',
    });
  }

  protected onModelPick(model: string): void {
    const agent = this.agent();
    if (!agent) return;
    this.workflow.updateNodeData(agent.id, { model });
  }

  protected onTemperatureInput(event: Event): void {
    const agent = this.agent();
    if (!agent) return;
    const raw = (event.target as HTMLInputElement | null)?.value ?? '';
    const parsed = Number(raw);
    this.workflow.updateNodeData(agent.id, {
      temperature: Number.isFinite(parsed) ? Math.min(2, Math.max(0, parsed)) : undefined,
    });
  }
}
