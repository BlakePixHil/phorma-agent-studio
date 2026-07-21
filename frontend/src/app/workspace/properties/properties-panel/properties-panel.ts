import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import cronstrue from 'cronstrue';

import { SelectionService } from '../../../core/selection.service';
import { WorkflowService } from '../../../core/workflow.service';
import { findCatalogEntryByKind, findMcpPreset, type McpEnvField } from '../../../core/node-catalog';
import { SettingsService } from '../../../core/settings.service';
import { McpOAuthService } from '../../../core/mcp-oauth.service';
import { SettingsDialogService } from '../../settings/settings-dialog.service';
import { ToastService } from '../../../shared/toast/toast.service';
import type {
  ApprovalGateData,
  ForEachNodeData,
  HttpToolData,
  McpToolData,
  ScheduleTriggerData,
  WaitEventNodeData,
  WebhookTriggerData,
  WorkflowNode,
} from '../../../core/workflow.model';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

// ── Cron editor ─────────────────────────────────────────────────────────────

interface CronFields {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

function parseCron(cron: string): CronFields {
  const parts = cron.trim().split(/\s+/);
  return {
    minute: parts[0] ?? '*',
    hour: parts[1] ?? '*',
    dayOfMonth: parts[2] ?? '*',
    month: parts[3] ?? '*',
    dayOfWeek: parts[4] ?? '*',
  };
}

function buildCron(fields: CronFields): string {
  return `${fields.minute} ${fields.hour} ${fields.dayOfMonth} ${fields.month} ${fields.dayOfWeek}`;
}

interface CronFieldOption {
  value: string;
  label: string;
}

interface CronFieldDef {
  key: keyof CronFields;
  label: string;
  options: CronFieldOption[];
}

const CRON_FIELD_DEFS: CronFieldDef[] = [
  {
    key: 'minute',
    label: 'Minute',
    options: [
      { value: '*', label: 'Every' },
      { value: '0', label: '0' },
      { value: '15', label: '15' },
      { value: '30', label: '30' },
      { value: '45', label: '45' },
    ],
  },
  {
    key: 'hour',
    label: 'Hour',
    options: [
      { value: '*', label: 'Every' },
      { value: '0', label: '12am' },
      { value: '6', label: '6am' },
      { value: '9', label: '9am' },
      { value: '12', label: '12pm' },
      { value: '15', label: '3pm' },
      { value: '18', label: '6pm' },
      { value: '21', label: '9pm' },
    ],
  },
  {
    key: 'dayOfMonth',
    label: 'Day',
    options: [
      { value: '*', label: 'Every' },
      { value: '1', label: '1st' },
      { value: '15', label: '15th' },
    ],
  },
  {
    key: 'month',
    label: 'Month',
    options: [
      { value: '*', label: 'Every' },
      { value: '1', label: 'Jan' },
      { value: '2', label: 'Feb' },
      { value: '3', label: 'Mar' },
      { value: '4', label: 'Apr' },
      { value: '5', label: 'May' },
      { value: '6', label: 'Jun' },
      { value: '7', label: 'Jul' },
      { value: '8', label: 'Aug' },
      { value: '9', label: 'Sep' },
      { value: '10', label: 'Oct' },
      { value: '11', label: 'Nov' },
      { value: '12', label: 'Dec' },
    ],
  },
  {
    key: 'dayOfWeek',
    label: 'Weekday',
    options: [
      { value: '*', label: 'Every' },
      { value: '1-5', label: 'Weekdays' },
      { value: '0,6', label: 'Weekends' },
      { value: '0', label: 'Sun' },
      { value: '1', label: 'Mon' },
      { value: '2', label: 'Tue' },
      { value: '3', label: 'Wed' },
      { value: '4', label: 'Thu' },
      { value: '5', label: 'Fri' },
      { value: '6', label: 'Sat' },
    ],
  },
];

interface CronPreset {
  label: string;
  cron: string;
  description: string;
}

const CRON_PRESETS: CronPreset[] = [
  { label: 'Every hour', cron: '0 * * * *', description: 'At minute 0 of every hour' },
  { label: 'Daily 9am', cron: '0 9 * * *', description: 'At 9:00 AM every day' },
  { label: 'Weekdays 9am', cron: '0 9 * * 1-5', description: 'At 9:00 AM, Mon-Fri' },
  { label: 'Monthly 1st', cron: '0 9 1 * *', description: 'At 9:00 AM on the 1st' },
];

/**
 * The Properties panel (right side): generic node configuration — name,
 * description — plus kind-specific fields for triggers, tools, and flow
 * nodes. Agents' prompts/models live in the Prompt panel.
 */
@Component({
  selector: 'app-properties-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, SelectModule],
  templateUrl: './properties-panel.html',
  styleUrl: './properties-panel.scss',
})
export class PropertiesPanel {
  private readonly selection = inject(SelectionService);
  private readonly workflow = inject(WorkflowService);
  private readonly settings = inject(SettingsService);
  private readonly settingsDialog = inject(SettingsDialogService);
  private readonly toast = inject(ToastService);
  private readonly oauth = inject(McpOAuthService);

  protected readonly httpMethods = [...HTTP_METHODS];
  protected readonly mcpTransports = [
    { id: 'stdio', label: 'Local process (stdio)' },
    { id: 'sse', label: 'Remote (SSE)' },
  ];

  protected readonly node = computed(() => this.selection.selectedNode());
  protected readonly multiSelection = computed(() => this.selection.selectedNodes().length > 1);

  /** Workflow-level execution settings (rendered when nothing is selected). */
  protected readonly workflowSettings = computed(
    () => this.workflow.activeDoc()?.settings ?? {},
  );

  protected onWorkflowTimeoutInput(event: Event): void {
    const raw = Number((event.target as HTMLInputElement | null)?.value);
    this.workflow.updateSettings({
      timeoutMinutes: Number.isFinite(raw) && raw > 0 ? Math.round(raw) : undefined,
    });
  }

  /** Catalog description for the selected node's kind. */
  protected readonly kindLabel = computed(() => {
    const node = this.node();
    return node ? (findCatalogEntryByKind(node.kind)?.label ?? node.kind) : '';
  });

  // ── Cron editor state ───────────────────────────────────────────────────────

  protected readonly cronFieldDefs = CRON_FIELD_DEFS;
  protected readonly cronPresets = CRON_PRESETS;

  /** Parse the cron string into individual fields (reactive). */
  protected readonly cronFields = computed<CronFields>(() => {
    const data = this.scheduleData();
    return parseCron(data?.cron ?? '* * * * *');
  });

  /** Human-readable description of the cron expression. */
  protected readonly cronHumanReadable = computed<string | null>(() => {
    const data = this.scheduleData();
    if (!data?.cron?.trim()) return null;
    try {
      return cronstrue.toString(data.cron);
    } catch {
      return null;
    }
  });

  /** Whether the cron expression is syntactically valid according to cronstrue. */
  protected readonly cronInvalid = computed(() => {
    const data = this.scheduleData();
    if (!data?.cron?.trim()) return true;
    try {
      cronstrue.toString(data.cron);
      return false;
    } catch {
      return true;
    }
  });

  /** Track which preset is currently selected (by cron string). */
  protected readonly selectedPreset = computed(() => {
    const data = this.scheduleData();
    if (!data) return null;
    return CRON_PRESETS.find(p => p.cron === data.cron)?.label ?? null;
  });

  /**
   * Check if a field's current value is a simple atomic value (not a range,
   * step, list, or wildcard). Used to decide whether to highlight a chip.
   */
  protected isSimpleFieldValue(field: keyof CronFields, value: string): boolean {
    const fields = this.cronFields();
    return fields[field] === value;
  }

  protected onCronFieldChange(field: keyof CronFields, value: string): void {
    const fields = this.cronFields();
    this.patchData({ cron: buildCron({ ...fields, [field]: value }) });
  }

  protected onCronPreset(preset: CronPreset): void {
    this.patchData({ cron: preset.cron });
  }

  // Narrowed data views for the kind-specific sections.
  protected readonly scheduleData = computed<ScheduleTriggerData | null>(() => {
    const node = this.node();
    return node?.kind === 'schedule-trigger' ? (node.data as ScheduleTriggerData) : null;
  });
  protected readonly webhookData = computed<WebhookTriggerData | null>(() => {
    const node = this.node();
    return node?.kind === 'webhook-trigger' ? (node.data as WebhookTriggerData) : null;
  });
  protected readonly httpData = computed<HttpToolData | null>(() => {
    const node = this.node();
    return node?.kind === 'http-tool' ? (node.data as HttpToolData) : null;
  });
  protected readonly mcpData = computed<McpToolData | null>(() => {
    const node = this.node();
    return node?.kind === 'mcp-tool' ? (node.data as McpToolData) : null;
  });
  protected readonly approvalData = computed<ApprovalGateData | null>(() => {
    const node = this.node();
    return node?.kind === 'approval-gate' ? (node.data as ApprovalGateData) : null;
  });
  protected readonly forEachData = computed<ForEachNodeData | null>(() => {
    const node = this.node();
    return node?.kind === 'for-each' ? (node.data as ForEachNodeData) : null;
  });
  protected readonly waitEventData = computed<WaitEventNodeData | null>(() => {
    const node = this.node();
    return node?.kind === 'wait-event' ? (node.data as WaitEventNodeData) : null;
  });

  /** The MCP preset that seeded the selected node, if any. */
  protected readonly mcpPreset = computed(() => {
    const data = this.mcpData();
    return data?.presetId ? findMcpPreset(data.presetId) ?? null : null;
  });

  /**
   * Whether the selected node's server URL is fixed by its preset (e.g. the
   * official GitHub server). Fixed URLs render read-only — editing them only
   * breaks the integration. Presets with an empty url (generic “Remote MCP”)
   * stay editable.
   */
  protected readonly urlLockedByPreset = computed(() => {
    const preset = this.mcpPreset();
    return !!(preset && preset.transport === 'sse' && preset.url);
  });

  /** Per-field secret input drafts, keyed by env var name. */
  protected readonly mcpSecretDrafts = signal<Record<string, string>>({});

  /**
   * Whether the Advanced group (per-node credential overrides, command/args)
   * is expanded. Collapses whenever the selection changes.
   */
  protected readonly advancedOpen = signal(false);

  /**
   * Refresh configured-secret badges whenever the selected node changes.
   * `untracked` is REQUIRED: the refresh reads AND writes
   * `mcpSecretsConfigured` synchronously in browser mode, which would
   * otherwise loop this effect forever.
   */
  protected readonly secretFlagsRefresher = effect(() => {
    const node = this.node();
    const data = this.mcpData();
    if (!node || !data?.envKeys?.length) return;
    const envKeys = data.envKeys;
    const presetId = data.presetId;
    untracked(() => {
      void this.settings.refreshMcpSecretFlags(node.id, envKeys);
      // Preset-scoped flags power the "using application defaults" status.
      if (presetId) void this.settings.refreshPresetSecretFlags(presetId, envKeys);
    });
  });

  /** Collapse the Advanced group when the selection changes. */
  protected readonly advancedCollapser = effect(() => {
    this.node();
    this.advancedOpen.set(false);
  });

  protected toggleAdvanced(): void {
    this.advancedOpen.update(open => !open);
  }

  /** Deep-link to Settings → Integrations (application defaults). */
  protected openIntegrationSettings(): void {
    this.settingsDialog.open('integrations');
  }

  /**
   * Whether every credential of the selected preset node resolves — from a
   * node-scoped override or the preset-scoped application default.
   */
  protected readonly presetFullyConfigured = computed(() => {
    const preset = this.mcpPreset();
    const node = this.node();
    if (!preset || !node) return false;
    const flags = this.settings.mcpSecretsConfigured();
    return preset.envSchema.every(
      field =>
        flags[`${node.id}:${field.name}`] || flags[`preset:${preset.id}:${field.name}`],
    );
  });

  /** Whether the node overrides ANY preset credential locally. */
  protected readonly hasNodeOverrides = computed(() => {
    const preset = this.mcpPreset();
    const node = this.node();
    if (!preset || !node) return false;
    const flags = this.settings.mcpSecretsConfigured();
    return preset.envSchema.some(field => flags[`${node.id}:${field.name}`]);
  });

  /** Whether a preset credential is configured at the application level. */
  protected presetDefaultConfigured(envKey: string): boolean {
    const preset = this.mcpPreset();
    return preset ? !!this.settings.mcpSecretsConfigured()[`preset:${preset.id}:${envKey}`] : false;
  }

  /**
   * The preset's user-provided argument fields paired with their absolute
   * index in `data.args` (static args come first). Rendered as labeled inputs
   * so users don't have to hand-edit positional command args.
   */
  protected readonly mcpArgFields = computed(() => {
    const preset = this.mcpPreset();
    const data = this.mcpData();
    if (!preset?.argFields?.length || !data) return null;
    const offset = preset.args?.length ?? 0;
    return preset.argFields.map((field, i) => ({
      field,
      index: offset + i,
      value: data.args?.[offset + i] ?? '',
    }));
  });

  /** Whether the selected remote node uses interactive OAuth. */
  protected readonly usesOAuth = computed(() => this.mcpData()?.authMode === 'oauth');

  /** OAuth connection state for the selected node (drives the Connect button). */
  protected readonly oauthConnected = signal(false);
  /** Whether an OAuth consent flow is currently in progress. */
  protected readonly oauthConnecting = signal(false);

  /** Refresh the OAuth connected badge whenever the selection changes. */
  protected readonly oauthStatusRefresher = effect(() => {
    const node = this.node();
    const data = this.mcpData();
    if (!node || data?.authMode !== 'oauth') {
      this.oauthConnected.set(false);
      return;
    }
    untracked(() => {
      void this.oauth.isConnected(node.id).then(connected => this.oauthConnected.set(connected));
    });
  });

  /** Draft OAuth client id input (for servers without dynamic registration). */
  protected readonly oauthClientIdDraft = signal('');
  /** Draft OAuth client secret (providers like GitHub require one). */
  protected readonly oauthClientSecretDraft = signal('');
  /** Whether a client id is already stored for the selected node. */
  protected readonly oauthClientConfigured = signal(false);
  /** Whether the one-time setup block is expanded despite being complete. */
  protected readonly oauthSetupOpen = signal(false);

  /** The redirect URI the user must register with their OAuth provider. */
  protected readonly oauthRedirectUri = computed(() => {
    // Recompute per selection; the value itself is host-stable.
    this.node();
    return this.oauth.redirectUriHint();
  });

  /** Guided setup metadata for providers without dynamic registration. */
  protected readonly oauthSetup = computed(() => this.mcpPreset()?.oauthSetup ?? null);

  /**
   * Whether an OAuth client is available without user action — either stored
   * on the node or shipped with the preset (`defaultClient`).
   */
  protected readonly oauthClientAvailable = computed(
    () => this.oauthClientConfigured() || !!this.oauthSetup()?.defaultClient,
  );

  /**
   * Whether the one-time setup UI should show: for providers that declare
   * `oauthSetup`, when no client resolves yet — or expanded manually.
   */
  protected readonly oauthSetupVisible = computed(
    () => !!this.oauthSetup() && (!this.oauthClientAvailable() || this.oauthSetupOpen()),
  );

  /** Refresh the stored-client-id badge when the selection changes. */
  protected readonly oauthClientRefresher = effect(() => {
    const node = this.node();
    const data = this.mcpData();
    if (!node || data?.authMode !== 'oauth') {
      this.oauthClientConfigured.set(false);
      return;
    }
    untracked(() => {
      this.oauthClientIdDraft.set('');
      this.oauthClientSecretDraft.set('');
      this.oauthSetupOpen.set(false);
      void this.oauth.hasClientCredentials(node.id).then(has => this.oauthClientConfigured.set(has));
    });
  });

  protected onOAuthClientIdInput(event: Event): void {
    this.oauthClientIdDraft.set(this.inputValue(event));
  }

  protected onOAuthClientSecretInput(event: Event): void {
    this.oauthClientSecretDraft.set(this.inputValue(event));
  }

  protected toggleOAuthSetup(): void {
    this.oauthSetupOpen.update(open => !open);
  }

  /**
   * Opens the provider's “register an OAuth app” page with the callback URL
   * pre-filled, so the user only has to click Register and copy credentials.
   */
  protected async openOAuthRegisterPage(): Promise<void> {
    const setup = this.oauthSetup();
    if (!setup) return;
    const url = setup.registerUrlTemplate.replace(
      '{callback}',
      encodeURIComponent(this.oauthRedirectUri()),
    );
    await this.oauth.openExternal(url);
  }

  /** Saves the user-provided OAuth app credentials for the selected node. */
  protected async saveOAuthClient(): Promise<void> {
    const node = this.node();
    if (!node) return;
    const clientId = this.oauthClientIdDraft().trim();
    if (!clientId) return;
    if (this.oauthSetup()?.needsClientSecret && !this.oauthClientSecretDraft().trim()) {
      this.toast.error('Client secret required', 'This provider requires a client secret — generate one on the OAuth app page.');
      return;
    }
    try {
      await this.oauth.setClientCredentials(node.id, clientId, this.oauthClientSecretDraft());
      this.oauthClientConfigured.set(true);
      this.oauthClientIdDraft.set('');
      this.oauthClientSecretDraft.set('');
      this.oauthSetupOpen.set(false);
      this.toast.success('OAuth app saved', 'Now click Connect to sign in.');
    } catch (error) {
      this.toast.error('Could not save credentials', error instanceof Error ? error.message : String(error));
    }
  }

  /** Copies the redirect URI to the clipboard for pasting into the provider. */
  protected async copyRedirectUri(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.oauthRedirectUri());
      this.toast.success('Redirect URI copied');
    } catch {
      this.toast.error('Could not copy', 'Copy it manually from the field.');
    }
  }

  /** Runs the interactive OAuth consent flow for the selected remote node. */
  protected async connectOAuth(): Promise<void> {
    const node = this.node();
    const data = this.mcpData();
    if (!node || !data?.url) return;
    this.oauthConnecting.set(true);
    try {
      const defaultClient = this.oauthSetup()?.defaultClient;
      await this.oauth.connect(node.id, data.url, {
        fallbackClient: defaultClient
          ? { client_id: defaultClient.clientId, client_secret: defaultClient.clientSecret }
          : undefined,
      });
      this.oauthConnected.set(true);
      this.toast.success('Connected', node.name);
    } catch (error) {
      this.toast.error('Could not connect', error instanceof Error ? error.message : String(error));
    } finally {
      this.oauthConnecting.set(false);
    }
  }

  /** Clears the stored OAuth session for the selected node. */
  protected async disconnectOAuth(): Promise<void> {
    const node = this.node();
    if (!node) return;
    try {
      await this.oauth.disconnect(node.id);
      this.oauthConnected.set(false);
      this.toast.success('Disconnected', node.name);
    } catch (error) {
      this.toast.error('Could not disconnect', error instanceof Error ? error.message : String(error));
    }
  }

  /** Router/parallel/aggregator branch ports are editable lists. */
  protected readonly editableOutPorts = computed(() => {
    const node = this.node();
    if (!node) return null;
    if (node.kind !== 'router' && node.kind !== 'parallel' && node.kind !== 'aggregator') {
      return null;
    }
    const role = node.kind === 'aggregator' ? 'message-in' : 'message-out';
    return { role, ports: node.ports.filter(port => port.role === role) } as const;
  });

  protected onNameInput(event: Event): void {
    const node = this.node();
    if (!node) return;
    this.workflow.updateNode(node.id, {
      name: (event.target as HTMLInputElement | null)?.value ?? '',
    });
  }

  protected onDescriptionInput(event: Event): void {
    const node = this.node();
    if (!node) return;
    this.workflow.updateNode(node.id, {
      description: (event.target as HTMLTextAreaElement | null)?.value ?? '',
    });
  }

  protected patchData(patch: Record<string, unknown>): void {
    const node = this.node();
    if (!node) return;
    this.workflow.updateNodeData(node.id, patch);
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? '';
  }

  protected numberValue(event: Event, fallback: number): number {
    const raw = Number((event.target as HTMLInputElement | null)?.value);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  }

  protected checkboxValue(event: Event): boolean {
    return (event.target as HTMLInputElement | null)?.checked ?? false;
  }

  protected renamePort(node: WorkflowNode, portId: string, event: Event): void {
    const name = this.inputValue(event);
    this.workflow.updateNodePorts(
      node.id,
      node.ports.map(port => (port.id === portId ? { ...port, name } : port)),
    );
  }

  protected addBranchPort(node: WorkflowNode, role: 'message-in' | 'message-out'): void {
    const count = node.ports.filter(port => port.role === role).length;
    const label = node.kind === 'aggregator' ? 'Input' : node.kind === 'router' ? 'Route' : 'Branch';
    const letter = String.fromCharCode(65 + count); // A, B, C…
    this.workflow.updateNodePorts(node.id, [
      ...node.ports,
      { id: `${node.id}-p${Date.now().toString(36)}`, name: `${label} ${letter}`, role },
    ]);
  }

  protected removePort(node: WorkflowNode, portId: string): void {
    this.workflow.updateNodePorts(
      node.id,
      node.ports.filter(port => port.id !== portId),
    );
  }

  // ── MCP args editor ────────────────────────────────────────────────────────

  protected onArgInput(index: number, event: Event): void {
    const data = this.mcpData();
    if (!data) return;
    const args = [...(data.args ?? [])];
    args[index] = this.inputValue(event);
    this.patchData({ args });
  }

  protected addArg(): void {
    const data = this.mcpData();
    if (!data) return;
    this.patchData({ args: [...(data.args ?? []), ''] });
  }

  protected removeArg(index: number): void {
    const data = this.mcpData();
    if (!data) return;
    const args = [...(data.args ?? [])];
    args.splice(index, 1);
    this.patchData({ args });
  }

  // ── MCP secret env vars ────────────────────────────────────────────────────

  protected secretConfigured(envKey: string): boolean {
    const node = this.node();
    return node ? !!this.settings.mcpSecretsConfigured()[`${node.id}:${envKey}`] : false;
  }

  protected onSecretInput(envKey: string, event: Event): void {
    const value = (event.target as HTMLInputElement | null)?.value ?? '';
    this.mcpSecretDrafts.update(drafts => ({ ...drafts, [envKey]: value }));
  }

  protected async saveSecret(envKey: string): Promise<void> {
    const node = this.node();
    if (!node) return;
    const draft = this.mcpSecretDrafts()[envKey];
    if (draft === undefined) return;
    try {
      await this.settings.setMcpSecret(node.id, envKey, draft);
      this.mcpSecretDrafts.update(drafts => {
        const next = { ...drafts };
        delete next[envKey];
        return next;
      });
      this.toast.success(draft.trim() ? 'Secret saved' : 'Secret removed', envKey);
    } catch (error) {
      this.toast.error('Could not save secret', error instanceof Error ? error.message : String(error));
    }
  }

  protected async clearSecret(envKey: string): Promise<void> {
    const node = this.node();
    if (!node) return;
    try {
      await this.settings.clearMcpSecret(node.id, envKey);
      this.toast.success('Secret removed', envKey);
    } catch (error) {
      this.toast.error('Could not remove secret', error instanceof Error ? error.message : String(error));
    }
  }
}
