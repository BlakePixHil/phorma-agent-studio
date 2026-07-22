import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { TextareaModule } from 'primeng/textarea';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

import { FieldGenerationService } from '../../../core/field-generation.service';
import { ModelTransportService } from '../../../core/model-transport.service';
import { PanelRegistryService } from '../../../core/panel-registry.service';
import { PhormaCloudService } from '../../../core/phorma-cloud.service';
import { SelectionService } from '../../../core/selection.service';
import { SettingsService } from '../../../core/settings.service';
import { SettingsDialogService } from '../../settings/settings-dialog.service';
import { SkillEditorDialogService } from '../../skills/skill-editor-dialog.service';
import { SkillsService } from '../../../core/skills.service';
import { toAgentSkill } from '../../../core/skills.model';
import { WorkflowService } from '../../../core/workflow.service';
import {
  MODEL_PROVIDERS,
  PROVIDER_MODEL_SUGGESTIONS,
  findNodeForConnector,
  isAgentNode,
  portBaseId,
  type AgentNodeData,
  type AgentRetryPolicy,
  type ModelProviderId,
  type WorkflowNode,
} from '../../../core/workflow.model';

/**
 * Sentinel select value meaning "inherit the application default model"
 * (agents store no provider/model in that case).
 */
const DEFAULT_PROVIDER_OPTION = '__default__';

/** BYO providers that support a live model-list fetch. */
const LIVE_FETCH_PROVIDERS: ReadonlySet<ModelProviderId> = new Set([
  'anthropic',
  'openai',
  'gemini',
  'openrouter',
]);

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
  imports: [FormsModule, SelectModule, TextareaModule],
  templateUrl: './prompt-panel.html',
  styleUrl: './prompt-panel.scss',
})
export class PromptPanel {
  private readonly selection = inject(SelectionService);
  private readonly workflow = inject(WorkflowService);
  private readonly settings = inject(SettingsService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly transport = inject(ModelTransportService);
  private readonly phormaCloud = inject(PhormaCloudService);
  private readonly settingsDialog = inject(SettingsDialogService);
  protected readonly fieldGen = inject(FieldGenerationService);
  private readonly skills = inject(SkillsService);
  private readonly skillEditor = inject(SkillEditorDialogService);
  private readonly panels = inject(PanelRegistryService);

  /**
   * Provider options: "Application default" first, then explicit providers.
   * Phorma Cloud is shown (and selectable) whenever the user is signed in;
   * if they lack an active subscription, selecting it reveals a subscribe
   * call-to-action instead of the model picker.
   */
  protected readonly providers = computed(() => {
    const signedIn = this.phormaCloud.signedIn();
    return [
      { id: DEFAULT_PROVIDER_OPTION, label: 'Application default' },
      ...MODEL_PROVIDERS.filter(p => p.id !== 'phorma-cloud' || signedIn),
    ];
  });

  /** Whether the signed-in account can use Phorma Cloud (active subscription). */
  protected readonly phormaCloudSubscribed = computed(() => this.phormaCloud.subscribed());

  /**
   * True when the agent targets Phorma Cloud but the account has no active
   * subscription — the model picker is replaced by a subscribe CTA.
   */
  protected readonly needsPhormaCloudSubscription = computed(
    () => this.agent()?.data.provider === 'phorma-cloud' && !this.phormaCloud.subscribed(),
  );

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

  /** Whether the agent explicitly targets Amazon Bedrock (region applies). */
  protected readonly isBedrock = computed(() => this.agent()?.data.provider === 'bedrock');

  /** Whether the agent targets Phorma Cloud (curated models, no key needed). */
  protected readonly isPhormaCloud = computed(
    () => this.agent()?.data.provider === 'phorma-cloud',
  );

  /** The agent's explicit region, or empty when inheriting the app default. */
  protected readonly regionValue = computed(() => this.agent()?.data.region ?? '');

  /** Hint shown in the region input when the agent inherits the app default. */
  protected readonly defaultRegionLabel = computed(() => this.settings.bedrockRegion());

  /** Live-fetched model ids for the current BYO provider (empty until loaded). */
  protected readonly liveModels = signal<string[]>([]);
  /** True while fetching the model list for the current BYO provider. */
  protected readonly loadingModels = signal(false);
  /** Last model-fetch error (null when the last fetch succeeded). */
  protected readonly modelFetchError = signal<string | null>(null);
  /** Provider already fetched (or fetching), to avoid duplicate auto-fetches. */
  private lastModelFetch = '';

  /**
   * Options for the model dropdown. Phorma Cloud uses the curated list; BYO
   * providers use live-fetched ids (falling back to static suggestions on
   * error); Bedrock uses its existing discovery path.
   */
  protected readonly modelSuggestions = computed(() => {
    const provider = this.agent()?.data.provider;
    if (!provider) return [];
    if (provider === 'phorma-cloud') return PROVIDER_MODEL_SUGGESTIONS['phorma-cloud'];
    if (LIVE_FETCH_PROVIDERS.has(provider)) {
      return this.liveModels().length > 0 ? this.liveModels() : PROVIDER_MODEL_SUGGESTIONS[provider];
    }
    return PROVIDER_MODEL_SUGGESTIONS[provider] ?? [];
  });

  /** Whether to show the model dropdown (vs. a free-text input). */
  protected readonly showModelDropdown = computed(() => {
    const provider = this.agent()?.data.provider;
    if (!provider) return false;
    // Phorma Cloud: always the curated dropdown. BYO: dropdown when live
    // fetch succeeded; fall back to free text on error. Bedrock: free text
    // (its own discovery lives in Settings).
    if (provider === 'phorma-cloud') return true;
    if (LIVE_FETCH_PROVIDERS.has(provider)) return this.modelFetchError() === null;
    return false;
  });

  // ── Skills (EPIC 6) ───────────────────────────────────────────────────

  /** Skills attached to the selected agent (embedded by value). */
  protected readonly attachedSkills = computed(() => this.agent()?.data.skills ?? []);

  /** Library skills not yet attached — options for the "Add skill" picker. */
  protected readonly attachableSkills = computed(() => {
    const attached = new Set(this.attachedSkills().map(skill => skill.id));
    return this.skills.skills().filter(skill => !attached.has(skill.id));
  });

  /** Whether the library has any skills at all (drives the empty hint). */
  protected readonly libraryHasSkills = computed(() => this.skills.skills().length > 0);

  /** Attaches a library skill (embedded by value) to the selected agent. */
  protected attachSkill(skillId: string | null): void {
    const agent = this.agent();
    if (!agent || !skillId) return;
    const skill = this.skills.byId().get(skillId);
    if (!skill || this.attachedSkills().some(attached => attached.id === skillId)) return;
    this.workflow.updateNodeData(agent.id, {
      skills: [...this.attachedSkills(), toAgentSkill(skill)],
    });
  }

  protected detachSkill(skillId: string): void {
    const agent = this.agent();
    if (!agent) return;
    const remaining = this.attachedSkills().filter(skill => skill.id !== skillId);
    // Empty lists serialize absent — keep specs clean.
    this.workflow.updateNodeData(agent.id, {
      skills: remaining.length > 0 ? remaining : undefined,
    });
  }

  /** Opens the Skills panel (library management lives there). */
  protected openSkillsPanel(): void {
    const tab = this.panels.tabs().find(t => t.id === 'skills');
    const side = tab?.side ?? 'left';
    this.panels.setActive(side, 'skills');
    // Reveal the sidebar if it's collapsed.
    if (side === 'left') this.panels.collapsedLeft.set(false);
    else this.panels.collapsedRight.set(false);
  }

  /** Creates a new skill via the editor dialog. */
  protected newSkill(): void {
    this.skillEditor.openNew();
  }

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

  /** True while the AI is drafting this agent's prompt. */
  protected readonly generating = computed(
    () => this.fieldGen.generatingFor() === this.agent()?.id,
  );

  /** One-shot AI generation/improvement of the agent's system prompt. */
  protected async generatePrompt(): Promise<void> {
    const agent = this.agent();
    if (!agent || this.generating()) return;
    const prompt = await this.fieldGen.generateAgentPrompt(agent).catch(() => null);
    // Re-read the selection — it may have changed during generation.
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
    // Kick off a live model fetch for BYO providers (best-effort).
    if (LIVE_FETCH_PROVIDERS.has(provider)) void this.loadModels(provider);
  }

  protected onModelChange(model: string): void {
    const agent = this.agent();
    if (!agent) return;
    this.workflow.updateNodeData(agent.id, { model: (model ?? '').trim() });
  }

  /**
   * Opens the Cloud settings page where the user can subscribe to Phorma
   * Cloud. Stripe checkout is not wired up yet (placeholder), so this simply
   * deep-links to the Cloud settings for now.
   */
  protected openSubscribe(): void {
    this.settingsDialog.open('cloud');
  }

  protected onModelInput(event: Event): void {
    const agent = this.agent();
    if (!agent) return;
    this.workflow.updateNodeData(agent.id, {
      model: (event.target as HTMLInputElement | null)?.value ?? '',
    });
  }

  /**
   * Fetches the live model list for a BYO provider into {@link liveModels}.
   * Fails silently (recording the error) so the picker falls back to static
   * suggestions + free text. Desktop goes through the Rust proxy (key stays
   * in the keychain); browser preview fetches directly (CORS permitting).
   */
  private async loadModels(provider: ModelProviderId): Promise<void> {
    if (!LIVE_FETCH_PROVIDERS.has(provider)) return;
    if (this.lastModelFetch === provider) return;
    this.lastModelFetch = provider;
    this.loadingModels.set(true);
    this.modelFetchError.set(null);
    try {
      const ids = await this.transport.listModels(
        provider as 'anthropic' | 'openai' | 'gemini' | 'openrouter',
      );
      this.liveModels.set(ids);
    } catch (error) {
      this.liveModels.set([]);
      this.modelFetchError.set(error instanceof Error ? error.message : String(error));
      // Allow a retry on the next provider change.
      this.lastModelFetch = '';
    } finally {
      this.loadingModels.set(false);
    }
  }

  protected onRegionInput(event: Event): void {
    const agent = this.agent();
    if (!agent) return;
    // Empty = inherit the application default Bedrock region.
    const region = (event.target as HTMLInputElement | null)?.value.trim() || undefined;
    this.workflow.updateNodeData(agent.id, { region });
  }

  // ── Reliability (EPIC 3) ────────────────────────────────────────────────

  /** Provider options for the fallback model picker (no sentinel row). */
  protected readonly fallbackProviders = computed(() => {
    const signedIn = this.phormaCloud.signedIn();
    return MODEL_PROVIDERS.filter(p => p.id !== 'phorma-cloud' || signedIn);
  });

  /** Whether automatic retries are enabled (default ON). */
  protected readonly retryEnabled = computed(() => !this.agent()?.data.retry?.disabled);

  /** Retry attempts shown in the input (total attempts incl. the first). */
  protected readonly retryAttempts = computed(() => this.agent()?.data.retry?.maxAttempts ?? 2);

  /** Whether a fallback model is configured. */
  protected readonly hasFallback = computed(() => !!this.agent()?.data.fallback);

  /** Model suggestions for the fallback provider (static list — keep it simple). */
  protected readonly fallbackModelSuggestions = computed(() => {
    const provider = this.agent()?.data.fallback?.provider;
    return provider ? (PROVIDER_MODEL_SUGGESTIONS[provider] ?? []) : [];
  });

  /** Whether this agent has an "On error" output branch. */
  protected readonly hasErrorBranch = computed(() => {
    const agent = this.agent();
    const errorPortId = agent?.data.errorPortId;
    return !!errorPortId && !!agent?.ports.some(port => port.id === errorPortId);
  });

  protected toggleRetry(enabled: boolean): void {
    const agent = this.agent();
    if (!agent) return;
    const retry: AgentRetryPolicy = { ...agent.data.retry, disabled: enabled ? undefined : true };
    if (retry.disabled === undefined) delete retry.disabled;
    this.workflow.updateNodeData(agent.id, {
      retry: Object.keys(retry).length > 0 ? retry : undefined,
    });
  }

  protected onRetryAttemptsInput(event: Event): void {
    const agent = this.agent();
    if (!agent) return;
    const raw = Number((event.target as HTMLInputElement | null)?.value);
    const maxAttempts = Number.isFinite(raw) ? Math.min(Math.max(Math.round(raw), 1), 5) : 2;
    this.workflow.updateNodeData(agent.id, {
      retry: { ...agent.data.retry, maxAttempts: maxAttempts === 2 ? undefined : maxAttempts },
    });
  }

  protected toggleFallback(enabled: boolean): void {
    const agent = this.agent();
    if (!agent) return;
    if (!enabled) {
      this.workflow.updateNodeData(agent.id, { fallback: undefined });
      return;
    }
    // Seed with the agent's own provider (or the app default) + first suggestion.
    const provider =
      agent.data.provider ?? this.settings.defaultProvider();
    const model = PROVIDER_MODEL_SUGGESTIONS[provider]?.[0] ?? '';
    this.workflow.updateNodeData(agent.id, { fallback: { provider, model } });
  }

  protected onFallbackProviderChange(value: string): void {
    const agent = this.agent();
    if (!agent?.data.fallback) return;
    const provider = value as ModelProviderId;
    this.workflow.updateNodeData(agent.id, {
      fallback: { provider, model: PROVIDER_MODEL_SUGGESTIONS[provider]?.[0] ?? '' },
    });
  }

  protected onFallbackModelChange(model: string): void {
    const agent = this.agent();
    if (!agent?.data.fallback) return;
    this.workflow.updateNodeData(agent.id, {
      fallback: { ...agent.data.fallback, model: (model ?? '').trim() },
    });
  }

  protected onTimeoutInput(event: Event): void {
    const agent = this.agent();
    if (!agent) return;
    const raw = Number((event.target as HTMLInputElement | null)?.value);
    const timeoutSec = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : undefined;
    this.workflow.updateNodeData(agent.id, { timeoutSec });
  }

  protected toggleErrorBranch(enabled: boolean): void {
    const agent = this.agent();
    if (!agent) return;
    if (enabled) {
      if (this.hasErrorBranch()) return;
      // Reuse a stale errorPortId's port if it still exists; otherwise add one.
      const port = {
        id: `${agent.id}-err${Date.now().toString(36)}`,
        name: 'On error',
        role: 'message-out' as const,
      };
      this.workflow.updateNodePorts(agent.id, [...agent.ports, port]);
      this.workflow.updateNodeData(agent.id, { errorPortId: port.id });
    } else {
      const errorPortId = agent.data.errorPortId;
      this.workflow.updateNodeData(agent.id, { errorPortId: undefined });
      if (errorPortId) {
        // Removing the port also drops any connections wired to it.
        this.workflow.updateNodePorts(
          agent.id,
          agent.ports.filter(port => port.id !== errorPortId),
        );
      }
    }
  }

  protected toggleCompression(enabled: boolean): void {
    const agent = this.agent();
    if (!agent) return;
    this.workflow.updateNodeData(agent.id, {
      compressionDisabled: enabled ? undefined : true,
    });
  }
}
