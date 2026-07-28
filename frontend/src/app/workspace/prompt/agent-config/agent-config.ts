import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';

import { ModelTransportService } from '../../../core/model-transport.service';
import { PanelRegistryService } from '../../../core/panel-registry.service';
import { PhormaCloudService } from '../../../core/phorma-cloud.service';
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
  portBaseId,
  type AgentNodeData,
  type AgentRetryPolicy,
  type ModelProviderId,
  type WorkflowNode,
} from '../../../core/workflow.model';

/** Agent node with its data narrowed - the shape this component operates on. */
export type AgentNode = WorkflowNode & { data: AgentNodeData };

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
 * Everything about an agent that is not its prompt: skills, model, reliability
 * and a read-only capability summary.
 *
 * Shared by the Prompt panel (single narrow column) and the expanded Prompt
 * dialog (right-hand context rail) so the two surfaces can never drift. All
 * state is read from and written straight through to {@link WorkflowService},
 * so both instances stay in lockstep with no synchronisation.
 */
@Component({
  selector: 'app-agent-config',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    ButtonModule,
    CheckboxModule,
    InputNumberModule,
    InputTextModule,
    SelectModule,
  ],
  templateUrl: './agent-config.html',
  styleUrl: './agent-config.scss',
})
export class AgentConfig {
  private readonly workflow = inject(WorkflowService);
  private readonly settings = inject(SettingsService);
  private readonly transport = inject(ModelTransportService);
  private readonly phormaCloud = inject(PhormaCloudService);
  private readonly settingsDialog = inject(SettingsDialogService);
  private readonly skills = inject(SkillsService);
  private readonly skillEditor = inject(SkillEditorDialogService);
  private readonly panels = inject(PanelRegistryService);

  /** The agent being configured. */
  readonly agent = input.required<AgentNode>();

  /**
   * Prefix for generated input ids. The panel and the dialog can be in the
   * DOM at the same time, so ids must not collide (label `for` targets break).
   */
  readonly scope = input<string>('panel');

  /** Which sections to render, in order. Lets the panel and dialog differ. */
  readonly sections = input<readonly AgentConfigSection[]>([
    'skills',
    'model',
    'reliability',
    'capabilities',
  ]);

  protected has(section: AgentConfigSection): boolean {
    return this.sections().includes(section);
  }

  protected id(suffix: string): string {
    return `${this.scope()}-${suffix}`;
  }

  // ── Model ───────────────────────────────────────────────────────────────

  /**
   * Provider options: "Application default" first, then explicit providers.
   * Phorma Cloud appears once the user is signed in; selecting it without an
   * active subscription reveals a subscribe CTA instead of the model picker.
   */
  protected readonly providers = computed(() => {
    const signedIn = this.phormaCloud.signedIn();
    return [
      { id: DEFAULT_PROVIDER_OPTION, label: 'Application default' },
      ...MODEL_PROVIDERS.filter(p => p.id !== 'phorma-cloud' || signedIn),
    ];
  });

  protected readonly phormaCloudSubscribed = computed(() => this.phormaCloud.subscribed());

  protected readonly needsPhormaCloudSubscription = computed(
    () => this.agent().data.provider === 'phorma-cloud' && !this.phormaCloud.subscribed(),
  );

  protected readonly inheritsDefault = computed(() => !this.agent().data.provider);

  protected readonly providerValue = computed(
    () => this.agent().data.provider ?? DEFAULT_PROVIDER_OPTION,
  );

  protected readonly resolvedDefaultLabel = computed(() => {
    const provider = MODEL_PROVIDERS.find(p => p.id === this.settings.defaultProvider());
    return `${provider?.label ?? this.settings.defaultProvider()} · ${this.settings.defaultModel()}`;
  });

  protected readonly isBedrock = computed(() => this.agent().data.provider === 'bedrock');

  protected readonly isPhormaCloud = computed(
    () => this.agent().data.provider === 'phorma-cloud',
  );

  protected readonly regionValue = computed(() => this.agent().data.region ?? '');

  protected readonly defaultRegionLabel = computed(() => this.settings.bedrockRegion());

  protected readonly liveModels = signal<string[]>([]);
  protected readonly loadingModels = signal(false);
  protected readonly modelFetchError = signal<string | null>(null);
  private lastModelFetch = '';

  protected readonly modelSuggestions = computed(() => {
    const provider = this.agent().data.provider;
    if (!provider) return [];
    if (provider === 'phorma-cloud') return PROVIDER_MODEL_SUGGESTIONS['phorma-cloud'];
    if (LIVE_FETCH_PROVIDERS.has(provider)) {
      return this.liveModels().length > 0
        ? this.liveModels()
        : PROVIDER_MODEL_SUGGESTIONS[provider];
    }
    return PROVIDER_MODEL_SUGGESTIONS[provider] ?? [];
  });

  protected readonly showModelDropdown = computed(() => {
    const provider = this.agent().data.provider;
    if (!provider) return false;
    // Phorma Cloud: always the curated dropdown. BYO: dropdown when the live
    // fetch succeeded; fall back to free text on error. Bedrock: free text
    // (its own discovery lives in Settings).
    if (provider === 'phorma-cloud') return true;
    if (LIVE_FETCH_PROVIDERS.has(provider)) return this.modelFetchError() === null;
    return false;
  });

  protected onProviderChange(value: string): void {
    const agent = this.agent();
    if (value === DEFAULT_PROVIDER_OPTION) {
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
    if (LIVE_FETCH_PROVIDERS.has(provider)) void this.loadModels(provider);
  }

  protected onModelChange(model: string): void {
    this.workflow.updateNodeData(this.agent().id, { model: (model ?? '').trim() });
  }

  protected onRegionChange(value: string): void {
    this.workflow.updateNodeData(this.agent().id, {
      region: (value ?? '').trim() || undefined,
    });
  }

  protected openSubscribe(): void {
    this.settingsDialog.open('cloud');
  }

  /**
   * Fetches the live model list for a BYO provider into {@link liveModels}.
   * Fails silently (recording the error) so the picker falls back to static
   * suggestions + free text. Desktop goes through the Rust proxy (the key
   * stays in the keychain); browser preview fetches directly (CORS permitting).
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

  // ── Skills (EPIC 6) ─────────────────────────────────────────────────────

  protected readonly attachedSkills = computed(() => this.agent().data.skills ?? []);

  protected readonly attachableSkills = computed(() => {
    const attached = new Set(this.attachedSkills().map(skill => skill.id));
    return this.skills.skills().filter(skill => !attached.has(skill.id));
  });

  protected readonly libraryHasSkills = computed(() => this.skills.skills().length > 0);

  protected attachSkill(skillId: string | null): void {
    if (!skillId) return;
    const skill = this.skills.byId().get(skillId);
    if (!skill || this.attachedSkills().some(attached => attached.id === skillId)) return;
    this.workflow.updateNodeData(this.agent().id, {
      skills: [...this.attachedSkills(), toAgentSkill(skill)],
    });
  }

  protected detachSkill(skillId: string): void {
    const remaining = this.attachedSkills().filter(skill => skill.id !== skillId);
    // Empty lists serialize absent - keep specs clean.
    this.workflow.updateNodeData(this.agent().id, {
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

  protected newSkill(): void {
    this.skillEditor.openNew();
  }

  // ── Capabilities summary ────────────────────────────────────────────────

  /** Tools attached to this agent via tool-links. */
  protected readonly attachedTools = computed<WorkflowNode[]>(() => {
    const agent = this.agent();
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

  // ── Reliability (EPIC 3) ────────────────────────────────────────────────

  protected readonly fallbackProviders = computed(() => {
    const signedIn = this.phormaCloud.signedIn();
    return MODEL_PROVIDERS.filter(p => p.id !== 'phorma-cloud' || signedIn);
  });

  /** Whether automatic retries are enabled (default ON). */
  protected readonly retryEnabled = computed(() => !this.agent().data.retry?.disabled);

  /** Retry attempts shown in the input (total attempts incl. the first). */
  protected readonly retryAttempts = computed(() => this.agent().data.retry?.maxAttempts ?? 2);

  protected readonly hasFallback = computed(() => !!this.agent().data.fallback);

  /** Model suggestions for the fallback provider (static list - keep it simple). */
  protected readonly fallbackModelSuggestions = computed(() => {
    const provider = this.agent().data.fallback?.provider;
    return provider ? (PROVIDER_MODEL_SUGGESTIONS[provider] ?? []) : [];
  });

  protected readonly hasErrorBranch = computed(() => {
    const agent = this.agent();
    const errorPortId = agent.data.errorPortId;
    return !!errorPortId && agent.ports.some(port => port.id === errorPortId);
  });

  protected toggleRetry(enabled: boolean): void {
    const agent = this.agent();
    const retry: AgentRetryPolicy = { ...agent.data.retry, disabled: enabled ? undefined : true };
    if (retry.disabled === undefined) delete retry.disabled;
    this.workflow.updateNodeData(agent.id, {
      retry: Object.keys(retry).length > 0 ? retry : undefined,
    });
  }

  /** Retry attempts from p-inputnumber (clamped 1..5; 2 is the default). */
  protected onRetryAttemptsChange(value: number | null): void {
    const agent = this.agent();
    const raw = Number(value);
    const maxAttempts = Number.isFinite(raw) ? Math.min(Math.max(Math.round(raw), 1), 5) : 2;
    this.workflow.updateNodeData(agent.id, {
      retry: { ...agent.data.retry, maxAttempts: maxAttempts === 2 ? undefined : maxAttempts },
    });
  }

  protected toggleFallback(enabled: boolean): void {
    const agent = this.agent();
    if (!enabled) {
      this.workflow.updateNodeData(agent.id, { fallback: undefined });
      return;
    }
    // Seed with the agent's own provider (or the app default) + first suggestion.
    const provider = agent.data.provider ?? this.settings.defaultProvider();
    const model = PROVIDER_MODEL_SUGGESTIONS[provider]?.[0] ?? '';
    this.workflow.updateNodeData(agent.id, { fallback: { provider, model } });
  }

  protected onFallbackProviderChange(value: string): void {
    const agent = this.agent();
    if (!agent.data.fallback) return;
    const provider = value as ModelProviderId;
    this.workflow.updateNodeData(agent.id, {
      fallback: { provider, model: PROVIDER_MODEL_SUGGESTIONS[provider]?.[0] ?? '' },
    });
  }

  protected onFallbackModelChange(model: string): void {
    const agent = this.agent();
    if (!agent.data.fallback) return;
    this.workflow.updateNodeData(agent.id, {
      fallback: { ...agent.data.fallback, model: (model ?? '').trim() },
    });
  }

  /** Node timeout from p-inputnumber. Empty/0 clears the limit. */
  protected onTimeoutChange(value: number | null): void {
    const raw = Number(value);
    const timeoutSec = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : undefined;
    this.workflow.updateNodeData(this.agent().id, { timeoutSec });
  }

  protected toggleErrorBranch(enabled: boolean): void {
    const agent = this.agent();
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
    this.workflow.updateNodeData(this.agent().id, {
      compressionDisabled: enabled ? undefined : true,
    });
  }
}

/** The configuration groups {@link AgentConfig} can render. */
export type AgentConfigSection = 'skills' | 'model' | 'reliability' | 'capabilities';
