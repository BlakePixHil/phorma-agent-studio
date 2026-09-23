import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { SelectModule } from 'primeng/select';

import { SelectionService } from '../../../core/selection.service';
import { WorkflowService } from '../../../core/workflow.service';
import {
  WEEKDAY_INITIALS,
  WEEKDAY_LABELS,
  buildScheduleCron,
  describePlan,
  formatInZone,
  formatZoneOffset,
  localTimeZone,
  nextOccurrences,
  parseSchedule,
  supportedTimeZones,
  zoneObservesDst,
  type ScheduleFrequency,
  type SchedulePlan,
} from '../../../core/schedule-cron';
import { InfoPopover } from '../../../shared/info-popover/info-popover';
import { DecisionConfig } from '../decision-config/decision-config';
import {
  MCP_LOCAL_ICON,
  MCP_OAUTH_ICON,
  MCP_TRANSPORT_LABEL,
  findCatalogEntryByKind,
  findMcpPreset,
  mcpTransportKind,
  type McpEnvField,
} from '../../../core/node-catalog';
import { SettingsService } from '../../../core/settings.service';
import { McpOAuthService } from '../../../core/mcp-oauth.service';
import { SettingsDialogService } from '../../settings/settings-dialog.service';
import { PhormaCloudIcon } from '../../../shared/icons/phorma-cloud-icon';
import { ToastService } from '../../../shared/toast/toast.service';
import { PhormaCloudService, tierLabel } from '../../../core/phorma-cloud.service';
import { CloudService } from '../../../core/cloud.service';
import { CapabilityFindingsService } from '../../../core/capability-findings.service';
import { ConnectionStoreService } from '../../../core/connection-store.service';
import { PanelRegistryService } from '../../../core/panel-registry.service';
import { TauriService } from '../../../core/tauri.service';
import {
  BROWSER_CAPABILITIES,
  TAURI_DESKTOP_CAPABILITIES,
  terminalLeafNodes,
  toPortalSlug,
  validateAgainstCapabilities,
  validateExpression,
  type CapabilityFinding,
  type ConnectionSummary,
  type PortalField,
} from '@phorma/engine';
import type {
  AggregateMetric,
  AggregateNodeData,
  ApprovalGateData,
  AskUserNodeData,
  Assertion,
  AssertNodeData,
  ExecuteWorkflowNodeData,
  FixtureMode,
  ForEachNodeData,
  GroupSpec,
  HttpRequestNodeData,
  HttpToolData,
  HttpToolParam,
  JoinSpec,
  McpToolData,
  NodeRetryPolicy,
  NotifyNodeData,
  PaginationConfig,
  PivotSpec,
  PortalTriggerData,
  ScheduleTriggerData,
  SqlQueryNodeData,
  StateGetNodeData,
  StateSetNodeData,
  TransformField,
  TransformNodeData,
  WaitEventNodeData,
  WebhookTriggerData,
  WorkflowGraph,
  WorkflowNode,
} from '../../../core/workflow.model';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

// ── Data nodes (deterministic data path) ────────────────────────────────────
// Option tables for the data-node controls. Each list is scoped to exactly one
// node kind's field, so no control can leak into a kind that lacks the field.

/** `http-request` allows HEAD as well, unlike the agent-facing HTTP tool. */
const DATA_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;

interface Choice<T extends string> {
  id: T;
  label: string;
}

const BODY_MODES: Choice<'none' | 'json' | 'text' | 'form'>[] = [
  { id: 'none', label: 'No body' },
  { id: 'json', label: 'JSON' },
  { id: 'text', label: 'Text' },
  { id: 'form', label: 'Form encoded' },
];

const RESPONSE_MODES: Choice<'json' | 'text'>[] = [
  { id: 'json', label: 'Parse as JSON' },
  { id: 'text', label: 'Keep as text' },
];

const PAGINATION_MODES: Choice<PaginationConfig['mode']>[] = [
  { id: 'none', label: 'Single request' },
  { id: 'cursor', label: 'Cursor / token' },
  { id: 'page', label: 'Page number' },
  { id: 'offset', label: 'Offset and limit' },
  { id: 'link-header', label: 'Link header' },
];

const FIXTURE_MODES: Choice<FixtureMode>[] = [
  { id: 'off', label: 'Live calls' },
  { id: 'record', label: 'Record responses' },
  { id: 'replay', label: 'Replay recordings' },
  { id: 'replay-or-record', label: 'Replay, else record' },
];

const RETRY_ON_MODES: Choice<'transient' | 'all' | 'none'>[] = [
  { id: 'transient', label: 'Transient failures (429, 5xx, network)' },
  { id: 'all', label: 'Every failure' },
  { id: 'none', label: 'Never retry' },
];

const SQL_DRIVERS: Choice<'postgres' | 'mysql' | 'mssql' | 'sqlite'>[] = [
  { id: 'postgres', label: 'PostgreSQL' },
  { id: 'mysql', label: 'MySQL / MariaDB' },
  { id: 'mssql', label: 'SQL Server' },
  { id: 'sqlite', label: 'SQLite' },
];

const TRANSFORM_MODES: Choice<'record' | 'array'>[] = [
  { id: 'record', label: 'One record' },
  { id: 'array', label: 'Array of records' },
];

const TRANSFORM_CASTS: Choice<'' | NonNullable<TransformField['cast']>>[] = [
  { id: '', label: 'No cast' },
  { id: 'string', label: 'String' },
  { id: 'number', label: 'Number' },
  { id: 'integer', label: 'Integer' },
  { id: 'boolean', label: 'Boolean' },
  { id: 'date-iso', label: 'ISO date' },
];

const AGGREGATE_OPS: Choice<AggregateNodeData['op']>[] = [
  { id: 'group', label: 'Group and summarise' },
  { id: 'join', label: 'Join two lists' },
  { id: 'pivot', label: 'Pivot into columns' },
];

const METRIC_FNS: Choice<AggregateMetric['fn']>[] = [
  { id: 'count', label: 'count' },
  { id: 'countIf', label: 'countIf' },
  { id: 'sum', label: 'sum' },
  { id: 'min', label: 'min' },
  { id: 'max', label: 'max' },
  { id: 'avg', label: 'avg' },
  { id: 'first', label: 'first' },
  { id: 'distinct', label: 'distinct' },
];

const JOIN_TYPES: Choice<JoinSpec['type']>[] = [
  { id: 'inner', label: 'Inner (matches only)' },
  { id: 'left', label: 'Left (keep unmatched left rows)' },
];

const ASSERT_SEVERITIES: Choice<'error' | 'warn'>[] = [
  { id: 'error', label: 'Error' },
  { id: 'warn', label: 'Warning' },
];

const BREACH_MODES: Choice<'fail' | 'route'>[] = [
  { id: 'fail', label: 'Fail the node' },
  { id: 'route', label: 'Route out the Failed port' },
];

const STATE_SEMANTICS: Choice<'value' | 'delta' | 'watermark'>[] = [
  { id: 'value', label: 'Value (store as given)' },
  { id: 'delta', label: 'Delta hash (detect changes)' },
  { id: 'watermark', label: 'Watermark (monotonic maximum)' },
];

const NOTIFY_CHANNELS: Choice<'email' | 'webhook' | 'chat-webhook'>[] = [
  { id: 'email', label: 'Email' },
  { id: 'webhook', label: 'Webhook' },
  { id: 'chat-webhook', label: 'Chat webhook' },
];

/** Kinds carrying a `retry` policy. Nothing else renders the retry block. */
const RETRY_KINDS = new Set(['http-request', 'sql-query', 'notify', 'decide']);
/** Kinds carrying a `fixtures` mode — the ones that perform real I/O. */
const FIXTURE_KINDS = new Set(['http-request', 'sql-query', 'decide']);
/** Kinds carrying an `errorPortId`. `assert` uses `failedPortId` instead. */
const ERROR_PORT_KINDS = new Set(['http-request', 'sql-query', 'notify', 'decide']);
/** Kinds carrying a `connectionId`. */
const CONNECTION_KINDS = new Set(['http-request', 'sql-query', 'notify', 'http-tool']);

/**
 * One connection choice for the picker (Requirements 2.9, 19.4): the display
 * fields off `ConnectionSummary` plus a precomputed usability flag, so the
 * template never has to re-derive it. Never carries a secret value.
 */
interface ConnectionOption {
  id: string;
  label: string;
  type: string;
  secretsPresent: number;
  secretsTotal: number;
  /** True when the host cannot use this connection as is (missing secrets). */
  disabled: boolean;
}

// ── Expression validation (Requirement 19.3) ────────────────────────────────

/** Milliseconds of quiet typing before an expression field is validated. */
const EXPRESSION_DEBOUNCE_MS = 300;

/** Field families carrying an engine expression, one debounce timer each. */
type ExpressionFieldKind = 'transform' | 'sql-param' | 'metric' | 'assertion' | 'state-value';

/** A rejected expression: the engine's message and its zero-based position. */
interface ExpressionIssue {
  readonly message: string;
  /** Absent when the rejection applies to the whole source, not one character. */
  readonly position?: number;
}

/** Fresh pagination config with the design's defaults for the chosen mode. */
function defaultPagination(mode: PaginationConfig['mode']): PaginationConfig {
  switch (mode) {
    case 'cursor':
      return { mode, cursorPath: '', cursorParam: 'cursor', itemsPath: '', maxPages: 100 };
    case 'page':
      return {
        mode,
        pageParam: 'page',
        sizeParam: 'per_page',
        pageSize: 100,
        startPage: 1,
        itemsPath: '',
        maxPages: 100,
      };
    case 'offset':
      return { mode, offsetParam: 'offset', limitParam: 'limit', limit: 100, itemsPath: '', maxPages: 100 };
    case 'link-header':
      return { mode, rel: 'next', itemsPath: '', maxPages: 100 };
    default:
      return { mode: 'none' };
  }
}

/**
 * `cronstrue` renders "0 9 * * 1-5" as "At 09:00 AM, Monday through Friday".
 * It is ~48kB of CommonJS and is only needed while a Schedule trigger is
 * selected, so it is loaded on demand rather than shipped in the initial
 * bundle (which also clears the CommonJS optimization-bailout warning).
 */
let cronDescriber: ((cron: string) => string) | null = null;
let cronDescriberLoading: Promise<void> | null = null;

function loadCronDescriber(): Promise<void> {
  cronDescriberLoading ??= import('cronstrue').then(module => {
    const describe = module.default ?? module;
    cronDescriber = (cron: string) => describe.toString(cron);
  });
  return cronDescriberLoading;
}

/** Field types offered by the form-mode field editor. */
const PORTAL_FIELD_TYPES: { id: PortalField['type']; label: string }[] = [
  { id: 'text', label: 'Short text' },
  { id: 'textarea', label: 'Long text' },
  { id: 'select', label: 'Dropdown' },
  { id: 'number', label: 'Number' },
  { id: 'boolean', label: 'Yes / no' },
];

// ── Schedule editor ─────────────────────────────────────────────────────────

/** Wraps a stepped value around its range, so 23 + 1 hour lands back on 0. */
function wrap(value: number, min: number, max: number): number {
  const span = max - min + 1;
  return ((((value - min) % span) + span) % span) + min;
}

/** The frequency segmented control, in display order. */
const SCHEDULE_FREQUENCIES: { id: ScheduleFrequency; label: string }[] = [
  { id: 'hourly', label: 'Hourly' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'custom', label: 'Custom' },
];



/**
 * The full properties form: generic node configuration - name, description -
 * plus kind-specific fields for triggers, tools, and flow nodes. Agents'
 * prompts/models live in the Prompt panel.
 *
 * Rendered by BOTH the Properties side panel (single narrow column) and the
 * expanded Properties dialog (multi-column grid), so the two surfaces can
 * never drift. Layout is the host's job: this component only emits sections.
 * All state is read from and written straight through to the services, so
 * both instances stay in lockstep with no synchronisation.
 */
@Component({
  selector: 'app-properties-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    ButtonModule,
    CheckboxModule,
    InputNumberModule,
    InputTextModule,
    SelectModule,
    TextareaModule,
    PhormaCloudIcon,
    InfoPopover,
    DecisionConfig,
  ],
  templateUrl: './properties-form.html',
  styleUrl: './properties-form.scss',
})
export class PropertiesForm {
  private readonly selection = inject(SelectionService);
  private readonly workflow = inject(WorkflowService);
  private readonly settings = inject(SettingsService);
  private readonly settingsDialog = inject(SettingsDialogService);
  private readonly toast = inject(ToastService);
  private readonly oauth = inject(McpOAuthService);
  private readonly phormaCloud = inject(PhormaCloudService);
  private readonly cloud = inject(CloudService);
  private readonly connectionStore = inject(ConnectionStoreService);
  private readonly capabilityFindings = inject(CapabilityFindingsService);
  private readonly panels = inject(PanelRegistryService);
  private readonly tauri = inject(TauriService);

  /**
   * Prefix for generated input ids. The side panel and the expanded dialog can
   * be in the DOM simultaneously, so ids must not collide - duplicates break
   * every `<label for>` association and confuse screen readers.
   */
  readonly scope = input<string>('panel');

  /** Suffixes a field id with the current scope. */
  protected id(suffix: string): string {
    return `${this.scope()}-${suffix}`;
  }

  /** Renders the node header (icon + kind). The dialog draws its own. */
  readonly showHeader = input<boolean>(true);

  /**
   * `stack` is the sidebar's single narrow column; `grid` flows sections into
   * as many ~320px columns as the container allows (the expanded dialog).
   */
  readonly layout = input<'stack' | 'grid'>('stack');

  protected readonly httpMethods = [...HTTP_METHODS];
  protected readonly mcpTransports = [
    { id: 'stdio', label: 'Local process (stdio)' },
    { id: 'sse', label: 'Remote (SSE)' },
  ];

  protected readonly mcpTransportKind = mcpTransportKind;
  protected readonly mcpTransportLabel = MCP_TRANSPORT_LABEL;
  protected readonly mcpLocalIcon = MCP_LOCAL_ICON;
  protected readonly mcpOauthIcon = MCP_OAUTH_ICON;

  protected readonly node = computed(() => this.selection.selectedNode());
  protected readonly multiSelection = computed(() => this.selection.selectedNodes().length > 1);

  /** Workflow-level execution settings (rendered when nothing is selected). */
  protected readonly workflowSettings = computed(
    () => this.workflow.activeDoc()?.settings ?? {},
  );

  /** Workflow timeout from p-inputnumber. Empty/0 clears the limit. */
  protected onWorkflowTimeoutChange(value: number | null): void {
    const raw = Number(value);
    this.workflow.updateSettings({
      timeoutMinutes: Number.isFinite(raw) && raw > 0 ? Math.round(raw) : undefined,
    });
  }

  /** Catalog description for the selected node's kind. */
  protected readonly kindLabel = computed(() => {
    const node = this.node();
    return node ? (findCatalogEntryByKind(node.kind)?.label ?? node.kind) : '';
  });

  // ── Schedule editor state ───────────────────────────────────────────────────

  protected readonly scheduleFrequencies = SCHEDULE_FREQUENCIES;
  protected readonly weekdayInitials = WEEKDAY_INITIALS;

  /** Zone the schedule is authored in: the node's, else the browser's. */
  protected readonly scheduleZone = computed(
    () => this.scheduleData()?.timezone?.trim() || localTimeZone(),
  );

  /** Zone options for the picker, with the current offset alongside each id. */
  protected readonly timeZoneOptions = computed(() =>
    supportedTimeZones().map(zone => ({
      value: zone,
      label: `${zone.replace(/_/g, ' ')} · ${formatZoneOffset(zone)}`,
    })),
  );

  /**
   * The stored UTC cron read back as a plan in the authoring zone. `custom`
   * whenever the expression is richer than the visual controls can express, so a
   * hand-written cron is never silently rewritten.
   */
  protected readonly schedulePlan = computed<SchedulePlan>(() =>
    parseSchedule(this.scheduleData()?.cron ?? '', this.scheduleZone()),
  );

  /**
   * Node the user explicitly switched to Custom on. Needed because the frequency
   * is otherwise DERIVED from the cron: a cron the visual editor can express
   * parses back to that shape, so the Custom segment could never stay selected
   * on, say, `0 * * * *`. Scoped to a node id so selecting a different schedule
   * starts from what its own expression says.
   */
  private readonly customCronNodeId = signal<string | null>(null);

  /** The frequency the editor is SHOWING, honouring an explicit Custom choice. */
  protected readonly scheduleFrequency = computed<ScheduleFrequency>(() => {
    const parsed = this.schedulePlan().frequency;
    if (parsed === 'custom') return 'custom';
    return this.customCronNodeId() === this.node()?.id ? 'custom' : parsed;
  });

  /** Plain-English summary of the schedule in its own zone. */
  protected readonly scheduleSummary = computed(() =>
    describePlan(this.schedulePlan(), this.scheduleZone()),
  );

  /** True when the chosen zone observes daylight saving, which we cannot track. */
  protected readonly scheduleZoneHasDst = computed(() => zoneObservesDst(this.scheduleZone()));

  /**
   * The next few fire times, rendered in the authoring zone. This is the honest
   * answer to "when will this actually run": it is computed from the STORED UTC
   * cron, so any conversion mistake shows up here rather than hiding behind a
   * friendly summary.
   */
  protected readonly scheduleNextRuns = computed(() => {
    const cron = this.scheduleData()?.cron?.trim();
    if (!cron) return [];
    const zone = this.scheduleZone();
    return nextOccurrences(cron, 3).map(at => formatInZone(at, zone));
  });

  protected onScheduleFrequency(frequency: ScheduleFrequency): void {
    if (frequency === this.scheduleFrequency()) return;
    if (frequency === 'custom') {
      // Switching to Custom reveals the raw expression WITHOUT rewriting it, so
      // it is safe to use just to look at what a visual schedule compiled to.
      this.customCronNodeId.set(this.node()?.id ?? null);
      this.patchData({ timezone: this.scheduleZone() });
      return;
    }
    this.customCronNodeId.set(null);
    this.commitSchedulePlan({ ...this.schedulePlan(), frequency });
  }

  protected onScheduleHour(value: number | string): void {
    this.commitSchedulePlan({ ...this.schedulePlan(), hour: Number(value) });
  }

  protected onScheduleMinute(value: number | string): void {
    this.commitSchedulePlan({ ...this.schedulePlan(), minute: Number(value) });
  }

  protected onScheduleDayOfMonth(value: number | string): void {
    this.commitSchedulePlan({ ...this.schedulePlan(), dayOfMonth: Number(value) });
  }

/**
   * Two-digit display for an hour or minute. `type="number"` cannot show a
   * leading zero, which rendered 09:00 as "9 : 0" - so the time fields are text
   * inputs and {@link onScheduleTimeKeydown} restores arrow-key stepping.
   */
  protected padTime(value: number): string {
    return String(value).padStart(2, '0');
  }

  /**
   * Up/Down step the field the way a number input would, because that is the
   * fastest way to nudge a time and users expect it from a spinner-shaped
   * control. Minutes move in 5s, matching the old `step` attribute.
   */
  protected onScheduleTimeKeydown(event: KeyboardEvent, field: 'hour' | 'minute' | 'day'): void {
    const direction = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const plan = this.schedulePlan();
    if (field === 'hour') {
      this.onScheduleHour(wrap(plan.hour + direction, 0, 23));
    } else if (field === 'minute') {
      this.onScheduleMinute(wrap(plan.minute + direction * 5, 0, 59));
    } else {
      this.onScheduleDayOfMonth(wrap(plan.dayOfMonth + direction, 1, 31));
    }
  }

  /** Full weekday name for the day toggles' accessible labels ("M" alone is not one). */
  protected weekdayName(day: number): string {
    return WEEKDAY_LABELS[day] ?? '';
  }

  protected isScheduleWeekday(day: number): boolean {
    return this.schedulePlan().weekdays.includes(day);
  }

  protected toggleScheduleWeekday(day: number): void {
    const plan = this.schedulePlan();
    const weekdays = plan.weekdays.includes(day)
      ? plan.weekdays.filter(d => d !== day)
      : [...plan.weekdays, day].sort((a, b) => a - b);
    // Never commit an empty set: a weekly cron with no day fires never, and the
    // user is mid-edit rather than asking for that.
    if (weekdays.length === 0) return;
    this.commitSchedulePlan({ ...plan, weekdays });
  }

  protected onScheduleZone(zone: string): void {
    const plan = this.schedulePlan();
    if (plan.frequency === 'custom') {
      // Custom keeps its raw cron; the zone only changes how times are shown.
      this.patchData({ timezone: zone });
      return;
    }
    // Re-derive the UTC cron so the wall-clock time the user set is preserved in
    // the NEW zone. Reading the plan in the old zone first is what makes this a
    // move rather than a reinterpretation.
    this.patchData({ timezone: zone, cron: buildScheduleCron(plan, zone) });
  }

  /** Writes a plan back as a UTC cron plus its authoring zone. */
  private commitSchedulePlan(plan: SchedulePlan): void {
    const zone = this.scheduleZone();
    this.patchData({ timezone: zone, cron: buildScheduleCron(plan, zone) });
  }

  /**
   * Bumped once the lazy `cronstrue` chunk lands, so the two computeds below
   * recompute with the describer available.
   */
  private readonly cronDescriberReady = signal(cronDescriber !== null);

  /** Human-readable description of the cron expression. */
  protected readonly cronHumanReadable = computed<string | null>(() => {
    const data = this.scheduleData();
    if (!data?.cron?.trim()) return null;
    if (!this.cronDescriberReady() || !cronDescriber) return null;
    try {
      return cronDescriber(data.cron);
    } catch {
      return null;
    }
  });

  /** Whether the cron expression is syntactically valid according to cronstrue. */
  protected readonly cronInvalid = computed(() => {
    const data = this.scheduleData();
    if (!data?.cron?.trim()) return true;
    // Before the describer loads, assume valid: flashing "Invalid" at a correct
    // expression for one frame would be worse than saying nothing.
    if (!this.cronDescriberReady() || !cronDescriber) return false;
    try {
      cronDescriber(data.cron);
      return false;
    } catch {
      return true;
    }
  });

  // Narrowed data views for the kind-specific sections.
  protected readonly scheduleData = computed<ScheduleTriggerData | null>(() => {
    const node = this.node();
    return node?.kind === 'schedule-trigger' ? (node.data as ScheduleTriggerData) : null;
  });
  protected readonly webhookData = computed<WebhookTriggerData | null>(() => {
    const node = this.node();
    return node?.kind === 'webhook-trigger' ? (node.data as WebhookTriggerData) : null;
  });
  protected readonly portalData = computed<PortalTriggerData | null>(() => {
    const node = this.node();
    return node?.kind === 'portal-trigger' ? (node.data as PortalTriggerData) : null;
  });
  protected readonly httpData = computed<HttpToolData | null>(() => {
    const node = this.node();
    return node?.kind === 'http-tool' ? (node.data as HttpToolData) : null;
  });

  /**
   * Named http-tool params, always an array. Empty means the node still uses
   * the single `input` placeholder (backward compatible default).
   */
  protected readonly httpToolParams = computed<HttpToolParam[]>(
    () => this.httpData()?.params ?? [],
  );

  protected addHttpToolParam(): void {
    const data = this.httpData();
    if (!data) return;
    this.patchData({
      params: [...(data.params ?? []), { name: '', required: true } satisfies HttpToolParam],
    });
  }

  protected updateHttpToolParam(index: number, patch: Partial<HttpToolParam>): void {
    const params = [...(this.httpData()?.params ?? [])];
    if (!params[index]) return;
    params[index] = { ...params[index], ...patch };
    this.patchData({ params });
  }

  protected removeHttpToolParam(index: number): void {
    const params = [...(this.httpData()?.params ?? [])];
    if (!params[index]) return;
    params.splice(index, 1);
    this.patchData({ params });
  }
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
  protected readonly askUserData = computed<AskUserNodeData | null>(() => {
    const node = this.node();
    return node?.kind === 'ask-user' ? (node.data as AskUserNodeData) : null;
  });
  protected readonly executeWorkflowData = computed<ExecuteWorkflowNodeData | null>(() => {
    const node = this.node();
    return node?.kind === 'execute-workflow' ? (node.data as ExecuteWorkflowNodeData) : null;
  });

  // Data nodes. Same narrowing pattern: one accessor per kind, so a section
  // renders only for the kind whose data actually carries those fields.
  protected readonly httpRequestData = computed<HttpRequestNodeData | null>(() => {
    const node = this.node();
    return node?.kind === 'http-request' ? (node.data as HttpRequestNodeData) : null;
  });
  protected readonly sqlQueryData = computed<SqlQueryNodeData | null>(() => {
    const node = this.node();
    return node?.kind === 'sql-query' ? (node.data as SqlQueryNodeData) : null;
  });
  protected readonly transformData = computed<TransformNodeData | null>(() => {
    const node = this.node();
    return node?.kind === 'transform' ? (node.data as TransformNodeData) : null;
  });
  protected readonly aggregateData = computed<AggregateNodeData | null>(() => {
    const node = this.node();
    return node?.kind === 'aggregate' ? (node.data as AggregateNodeData) : null;
  });
  protected readonly assertData = computed<AssertNodeData | null>(() => {
    const node = this.node();
    return node?.kind === 'assert' ? (node.data as AssertNodeData) : null;
  });
  protected readonly stateGetData = computed<StateGetNodeData | null>(() => {
    const node = this.node();
    return node?.kind === 'state-get' ? (node.data as StateGetNodeData) : null;
  });
  protected readonly stateSetData = computed<StateSetNodeData | null>(() => {
    const node = this.node();
    return node?.kind === 'state-set' ? (node.data as StateSetNodeData) : null;
  });
  protected readonly notifyData = computed<NotifyNodeData | null>(() => {
    const node = this.node();
    return node?.kind === 'notify' ? (node.data as NotifyNodeData) : null;
  });

  // ── Portal trigger (EPIC 9) ─────────────────────────────────────────────────

  protected readonly portalFieldTypes = PORTAL_FIELD_TYPES;
  protected readonly portalModes = [
    { id: 'chat', label: 'Chat' },
    { id: 'form', label: 'Form' },
  ];
  protected readonly portalAccessModes = [
    { id: 'public', label: 'Anyone with the link' },
    { id: 'token', label: 'Requires an access key' },
  ];
  protected readonly portalThemes = [
    { id: 'auto', label: 'Match visitor' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ];

  /**
   * Nodes eligible to answer visitors — the graph's terminal leaves. Reuses
   * the engine's rail so the picker and the publish validator never disagree.
   */
  protected readonly portalResponderOptions = computed(() => {
    if (!this.portalData()) return [];
    const graph = this.workflow.activeDoc()?.graph;
    if (!graph) return [];
    const leaves = terminalLeafNodes(graph as WorkflowGraph);
    return [
      { id: '', label: leaves.length === 1 ? `Auto (${leaves[0].name})` : 'Auto (last step)' },
      ...leaves.map(leaf => ({ id: leaf.id, label: leaf.name })),
    ];
  });

  /**
   * The public address the portal will be served from, once deployed.
   * Delegates to `CloudService` so the custom-portal-domain rule lives in one
   * place (this used to re-derive the URL and silently ignored the domain).
   */
  protected readonly portalUrl = computed(() => {
    const slug = this.portalData()?.slug?.trim();
    return slug ? this.cloud.portalUrl(slug) : null;
  });

  /** Live invoke URL for the webhook trigger — replaces the old dead hint. */
  protected readonly webhookUrl = computed(() => {
    if (!this.webhookData()) return null;
    const base = this.cloud.effectiveWorkerUrl();
    const workflowId = this.workflow.activeDoc()?.workflowId;
    if (!base || !workflowId) return null;
    return `${base}/agents/workflow-agent/${encodeURIComponent(workflowId)}/trigger`;
  });

  /** Sanitizes typed slugs so the address stays legal as the user types. */
  protected onPortalSlugInput(event: Event): void {
    const raw = this.inputValue(event);
    // Keep the raw dashes while typing (`my-` is a legal intermediate state)
    // but strip anything that could never appear in a slug.
    const cleaned = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 48);
    this.patchData({ slug: cleaned });
  }

  /** Fills an empty slug from the workflow name. */
  protected suggestPortalSlug(): void {
    const name = this.workflow.activeDoc()?.name ?? '';
    const slug = toPortalSlug(name);
    if (!slug) {
      this.toast.warning('Name this workflow first', 'The address is derived from the workflow name.');
      return;
    }
    this.patchData({ slug });
  }

  protected async copyPortalUrl(): Promise<void> {
    const url = this.portalUrl();
    if (!url) return;
    await this.copyText(url, 'Portal address copied');
  }

  protected async copyWebhookUrl(): Promise<void> {
    const url = this.webhookUrl();
    if (!url) return;
    await this.copyText(url, 'Webhook URL copied');
  }

  private async copyText(text: string, title: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.toast.success(title, text);
    } catch {
      this.toast.error('Could not copy', 'Copy the address from the field instead.');
    }
  }

  protected openPortalUrl(): void {
    const url = this.portalUrl();
    if (url) window.open(url, '_blank', 'noopener');
  }

  // ── Portal form fields ──

  private patchPortalFields(fields: PortalField[]): void {
    this.patchData({ fields });
  }

  protected addPortalField(): void {
    const fields = [...(this.portalData()?.fields ?? [])];
    const index = fields.length + 1;
    fields.push({ key: `field${index}`, label: `Field ${index}`, type: 'text' });
    this.patchPortalFields(fields);
  }

  protected removePortalField(index: number): void {
    const fields = [...(this.portalData()?.fields ?? [])];
    fields.splice(index, 1);
    this.patchPortalFields(fields);
  }

  protected movePortalField(index: number, delta: number): void {
    const fields = [...(this.portalData()?.fields ?? [])];
    const target = index + delta;
    if (target < 0 || target >= fields.length) return;
    [fields[index], fields[target]] = [fields[target], fields[index]];
    this.patchPortalFields(fields);
  }

  protected updatePortalField(index: number, patch: Partial<PortalField>): void {
    const fields = [...(this.portalData()?.fields ?? [])];
    if (!fields[index]) return;
    fields[index] = { ...fields[index], ...patch };
    this.patchPortalFields(fields);
  }

  /** Comma-separated dropdown options, edited as one line. */
  protected portalFieldOptionsText(field: PortalField): string {
    return (field.options ?? []).join(', ');
  }

  // ── Embedding ──

  /** Allowed embed origins as one editable comma-separated line. */
  protected portalEmbedOriginsText(data: PortalTriggerData): string {
    return (data.embedOrigins ?? []).join(', ');
  }

  /** True when embedding is on but no origin restricts it (i.e. any site). */
  protected portalEmbedOpen(data: PortalTriggerData): boolean {
    return !(data.embedOrigins ?? []).some(origin => origin.trim().length > 0);
  }

  protected onPortalEmbedOriginsInput(event: Event): void {
    // Stored raw; the engine normalizes and de-duplicates at publish time, and
    // the validator reports anything unusable.
    const embedOrigins = this.inputValue(event)
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean);
    this.patchData({ embedOrigins });
  }

  protected onPortalFieldOptionsInput(index: number, event: Event): void {
    const options = this.inputValue(event)
      .split(',')
      .map(option => option.trim())
      .filter(Boolean);
    this.updatePortalField(index, { options });
  }

  protected readonly workflowOptions = computed(() => {
    const data = this.executeWorkflowData();
    const embedded = this.workflow.activeDoc()?.subWorkflows ?? {};
    const saved = this.workflow.library();
    const options = new Map(
      saved.map(spec => [spec.id, { id: spec.id, label: spec.name, embeddedOnly: false }]),
    );
    for (const target of Object.values(embedded)) {
      if (!options.has(target.id)) {
        options.set(target.id, {
          id: target.id,
          label: `${target.name} (embedded snapshot)`,
          embeddedOnly: true,
        });
      }
    }
    // Preserve a configured target even if an older imported document did
    // not carry its embedded body. This makes the unresolved state explicit.
    if (data?.workflowId && !options.has(data.workflowId)) {
      options.set(data.workflowId, {
        id: data.workflowId,
        label: `${data.workflowName ?? data.workflowId} (unavailable)`,
        embeddedOnly: true,
      });
    }
    return [...options.values()];
  });

  protected readonly targetIsEmbeddedOnly = computed(() => {
    const workflowId = this.executeWorkflowData()?.workflowId;
    return !!workflowId &&
      !this.workflow.library().some(spec => spec.id === workflowId) &&
      !!this.workflow.activeDoc()?.subWorkflows?.[workflowId];
  });

  protected readonly subWorkflowDepthHint = computed(() => {
    const profile = this.phormaCloud.profile();
    const plan = profile?.status === 'active' ? tierLabel(profile.tier) : 'Free';
    return `${plan} allows ${this.phormaCloud.subWorkflowDepth()} nested workflow levels.`;
  });

  protected selectWorkflow(workflowId: string | null): void {
    const target = this.workflow.library().find(spec => spec.id === workflowId) ??
      (workflowId ? this.workflow.activeDoc()?.subWorkflows?.[workflowId] : undefined);
    this.patchData({
      workflowId: target?.id,
      workflowName: target?.name,
    });
  }

  protected openTargetWorkflow(): void {
    const workflowId = this.executeWorkflowData()?.workflowId;
    if (!workflowId) return;
    if (this.workflow.library().some(spec => spec.id === workflowId)) {
      this.workflow.openWorkflow(workflowId);
      return;
    }
    const embedded = this.workflow.activeDoc()?.subWorkflows?.[workflowId];
    if (embedded) this.workflow.openEmbeddedSnapshot(embedded);
    else this.toast.warning('Workflow unavailable', 'This target is not saved or embedded in the active workflow.');
  }

  protected readonly hasExecuteWorkflowErrorBranch = computed(() => {
    const node = this.node();
    const errorPortId = this.executeWorkflowData()?.errorPortId;
    return !!errorPortId && !!node?.ports.some(port => port.id === errorPortId);
  });

  protected toggleExecuteWorkflowErrorBranch(enabled: boolean): void {
    const node = this.node();
    if (!node || node.kind !== 'execute-workflow') return;
    const data = node.data as ExecuteWorkflowNodeData;
    if (enabled) {
      if (this.hasExecuteWorkflowErrorBranch()) return;
      const port = {
        id: `${node.id}-err${Date.now().toString(36)}`,
        name: 'On error',
        role: 'message-out' as const,
      };
      this.workflow.updateNodePorts(node.id, [...node.ports, port]);
      this.workflow.updateNodeData(node.id, { errorPortId: port.id });
      return;
    }
    this.workflow.updateNodeData(node.id, { errorPortId: undefined });
    if (data.errorPortId) {
      this.workflow.updateNodePorts(
        node.id,
        node.ports.filter(port => port.id !== data.errorPortId),
      );
    }
  }

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

  /**
   * Pulls in the lazy cron describer the first time a Schedule trigger is
   * selected. `untracked` guards the signal write, matching the pattern used by
   * the secret-flag refresher above.
   */
  protected readonly cronDescriberLoader = effect(() => {
    if (!this.scheduleData() || this.cronDescriberReady()) return;
    untracked(() => {
      void loadCronDescriber().then(() => this.cronDescriberReady.set(true));
    });
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

  /** Kinds whose System One configuration renders in `DecisionConfig`. */
  protected readonly usesDecisionConfig = computed(() => {
    const kind = this.node()?.kind;
    return kind === 'router' || kind === 'approval-gate' || kind === 'decide';
  });

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

  // ── Data nodes ─────────────────────────────────────────────────────────────

  protected readonly dataHttpMethods = [...DATA_HTTP_METHODS];
  protected readonly bodyModes = BODY_MODES;
  protected readonly responseModes = RESPONSE_MODES;
  protected readonly paginationModes = PAGINATION_MODES;
  protected readonly fixtureModes = FIXTURE_MODES;
  protected readonly retryOnModes = RETRY_ON_MODES;
  protected readonly sqlDrivers = SQL_DRIVERS;
  protected readonly transformModes = TRANSFORM_MODES;
  protected readonly transformCasts = TRANSFORM_CASTS;
  protected readonly aggregateOps = AGGREGATE_OPS;
  protected readonly metricFns = METRIC_FNS;
  protected readonly joinTypes = JOIN_TYPES;
  protected readonly assertSeverities = ASSERT_SEVERITIES;
  protected readonly breachModes = BREACH_MODES;
  protected readonly stateSemantics = STATE_SEMANTICS;
  protected readonly notifyChannels = NOTIFY_CHANNELS;

  /**
   * Connection reference for the three kinds that carry one. Returns `null` for
   * every other kind so the control never renders where the field is absent.
   */
  protected readonly connectionRef = computed<{ connectionId: string } | null>(() => {
    const node = this.node();
    if (!node || !CONNECTION_KINDS.has(node.kind)) return null;
    const data = node.data as { connectionId?: string };
    return { connectionId: data.connectionId ?? '' };
  });

  /**
   * The local host's capability record — Desktop when running inside Tauri,
   * Browser preview otherwise. Local runs never target the worker record, so
   * the picker (Requirement 19.4) and the future run-time gate (task 20.7)
   * both read from here.
   */
  protected readonly activeHostCapabilities = computed(() =>
    this.tauri.isDesktop ? TAURI_DESKTOP_CAPABILITIES : BROWSER_CAPABILITIES,
  );

  /** Every locally known connection, secret-free. Refreshed on selection. */
  protected readonly connectionSummaries = signal<ConnectionSummary[]>([]);

  /**
   * Reloads the connection inventory whenever a connection-bearing node is
   * selected, so the picker reflects secrets stored (or removed) since the
   * last selection. `untracked` guards the signal write, matching the
   * `secretFlagsRefresher` pattern above.
   */
  protected readonly connectionListRefresher = effect(() => {
    const ref = this.connectionRef();
    if (!ref) return;
    untracked(() => {
      void this.connectionStore
        .list()
        .then(list => this.connectionSummaries.set(list))
        .catch(() => this.connectionSummaries.set([]));
    });
  });

  /**
   * Requirements 2.9, 19.4: every locally known connection whose `type` the
   * active host declares, with its name, type, and secret-presence count —
   * never a secret value. A connection missing one or more declared secrets is
   * flagged `disabled` so the template can mark it unusable without hiding it.
   */
  protected readonly connectionOptions = computed<ConnectionOption[]>(() => {
    const capabilities = this.activeHostCapabilities();
    return this.connectionSummaries()
      .filter(summary => (capabilities.connectionTypes as readonly string[]).includes(summary.type))
      .map(summary => ({
        id: summary.id,
        label: `${summary.name} (${summary.id})`,
        type: summary.type,
        secretsPresent: summary.secretsPresent,
        secretsTotal: summary.secretKeys.length,
        disabled: summary.secretsPresent < summary.secretKeys.length,
      }));
  });

  /**
   * Requirement 19.4: true when the node's stored `connectionId` is non-empty
   * but matches no listed value — the second "mark as unusable" case, distinct
   * from a listed-but-incomplete connection. The stored id is never changed
   * because of this; it only drives a hint in the template.
   */
  protected readonly connectionUnmatched = computed(() => {
    const ref = this.connectionRef();
    if (!ref || !ref.connectionId) return false;
    return !this.connectionOptions().some(option => option.id === ref.connectionId);
  });

  /**
   * Requirements 17.8, 17.9, 17.15: capability findings for the SELECTED
   * node, validated against the active host's capability record and the
   * local connection inventory. Only the current graph is walked — a
   * selected node is always on the graph the currently open document
   * renders, never inside an embedded sub-workflow (those open as their own
   * read-only tab), so `subWorkflows` play no part here. A plain
   * `computed()` driven by the same graph/selection/connection signals the
   * rest of the form already reads, so it lands well inside the 500 ms
   * window Requirement 17.9 allows without a dedicated debounce. Findings
   * are surfaced inline only — see {@link nodeCapabilityFindings} — and
   * never disable a control, matching Requirement 17.8's "editing action
   * available" guarantee.
   */
  protected readonly nodeCapabilityFindings = computed<CapabilityFinding[]>(() => {
    const node = this.node();
    if (!node) return [];
    const graph = this.workflow.graph();
    const capabilities = this.activeHostCapabilities();
    const connections = this.connectionSummaries();
    const local = validateAgainstCapabilities({ graph }, capabilities, connections).filter(
      finding => finding.nodeId === node.id,
    );
    // Deploy-target findings ride along so an undeployable node says so while
    // it is being authored, not first at push time.
    return [
      ...local,
      ...this.capabilityFindings.deployFindings().filter(finding => finding.nodeId === node.id),
    ];
  });

  /** Opens the Connections panel (create/rename/delete lives there). */
  protected openConnectionsPanel(): void {
    const tab = this.panels.tabs().find(t => t.id === 'connections');
    const side = tab?.side ?? 'left';
    this.panels.setActive(side, 'connections');
    if (side === 'left') this.panels.collapsedLeft.set(false);
    else this.panels.collapsedRight.set(false);
  }

  /** Retry policy of the selected node, or `null` when the kind has none. */
  protected readonly retryPolicy = computed<NodeRetryPolicy | null>(() => {
    const node = this.node();
    if (!node || !RETRY_KINDS.has(node.kind)) return null;
    return (node.data as { retry?: NodeRetryPolicy }).retry ?? {};
  });

  /** Fixture mode of the selected node, or `null` when the kind has none. */
  protected readonly fixtureMode = computed<FixtureMode | null>(() => {
    const node = this.node();
    if (!node || !FIXTURE_KINDS.has(node.kind)) return null;
    return (node.data as { fixtures?: FixtureMode }).fixtures ?? 'off';
  });

  /** Error-routing target for the kinds carrying `errorPortId`. */
  protected readonly errorPortRef = computed<{ errorPortId: string } | null>(() => {
    const node = this.node();
    if (!node || !ERROR_PORT_KINDS.has(node.kind)) return null;
    const data = node.data as { errorPortId?: string };
    return { errorPortId: data.errorPortId ?? '' };
  });

  /** Outbound ports of the selected node, offered as routing targets. */
  protected readonly outPortOptions = computed(() => {
    const node = this.node();
    if (!node) return [];
    return [
      { id: '', label: 'None — fail the node' },
      ...node.ports
        .filter(port => port.role === 'message-out')
        .map(port => ({ id: port.id, label: port.name })),
    ];
  });

  protected patchRetry(patch: Partial<NodeRetryPolicy>): void {
    const current = this.retryPolicy();
    if (!current) return;
    this.patchData({ retry: { ...current, ...patch } });
  }

  /** p-inputnumber emits `null` when cleared; an absent field means "default". */
  protected numberOrUndefined(value: number | null): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  /** Comma-separated rendering of a string list field. */
  protected csvText(list: readonly string[] | undefined): string {
    return (list ?? []).join(', ');
  }

  private parseCsv(text: string): string[] {
    return text
      .split(',')
      .map(part => part.trim())
      .filter(Boolean);
  }

  /** Comma-separated rendering of the `successCodes` number list. */
  protected numberCsvText(list: readonly number[] | undefined): string {
    return (list ?? []).join(', ');
  }

  private parseNumberCsv(text: string): number[] {
    return this.parseCsv(text)
      .map(part => Number(part))
      .filter(value => Number.isFinite(value));
  }

  // ── Debounced expression validation (Requirement 19.3) ──
  //
  // Every expression field writes its text straight into the node on each
  // keystroke, so the entered text is always retained. Validation is the only
  // debounced part: `validateExpression` runs 300 ms after the last keystroke
  // and its result decides whether a message sits under the field.

  /** Rejections currently shown, keyed by field family and row index. */
  private readonly expressionIssues = signal<Readonly<Record<string, ExpressionIssue>>>({});

  /** Pending debounce timers, one per expression field. */
  private readonly expressionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Guards the reset effect so a data edit alone does not clear the messages. */
  private expressionNodeId: string | null = null;

  /**
   * A different node means different fields: drop every pending timer and
   * message so no rejection is attributed to the newly selected node.
   */
  protected readonly expressionResetter = effect(() => {
    const nodeId = this.selection.selectedNodeId();
    untracked(() => {
      if (nodeId === this.expressionNodeId) return;
      this.expressionNodeId = nodeId;
      this.resetExpressionValidation();
    });
  });

  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    // A timer that fires after teardown would write to a destroyed component.
    this.destroyRef.onDestroy(() => this.cancelExpressionTimers());
  }

  private expressionKey(field: ExpressionFieldKind, index?: number): string {
    return index === undefined ? field : `${field}:${index}`;
  }

  /** The rejection shown for one expression field, or `null` while it is ok. */
  protected expressionIssue(field: ExpressionFieldKind, index?: number): ExpressionIssue | null {
    return this.expressionIssues()[this.expressionKey(field, index)] ?? null;
  }

  /** Message plus zero-based position, as displayed under the field. */
  protected expressionIssueText(issue: ExpressionIssue): string {
    return issue.position === undefined
      ? issue.message
      : `${issue.message} (position ${issue.position})`;
  }

  /**
   * Schedules `validateExpression` for one field, 300 ms after this keystroke.
   * `optional` marks a field where empty text means "no expression at all" (the
   * `countIf` predicate), so clearing it removes the message rather than
   * reporting the empty-source rejection.
   */
  private checkExpressionLater(
    field: ExpressionFieldKind,
    index: number | undefined,
    source: string,
    optional = false,
  ): void {
    const key = this.expressionKey(field, index);
    const pending = this.expressionTimers.get(key);
    if (pending !== undefined) clearTimeout(pending);
    this.expressionTimers.set(
      key,
      setTimeout(() => {
        this.expressionTimers.delete(key);
        this.setExpressionIssue(key, this.issueFor(source, optional));
      }, EXPRESSION_DEBOUNCE_MS),
    );
  }

  /** `validateExpression` is documented as throwing for no input at all. */
  private issueFor(source: string, optional: boolean): ExpressionIssue | null {
    if (optional && !source.trim()) return null;
    let result: ReturnType<typeof validateExpression>;
    try {
      result = validateExpression(source);
    } catch (error) {
      return { message: error instanceof Error ? error.message : String(error) };
    }
    if (result.ok) return null;
    return result.position === undefined
      ? { message: result.error }
      : { message: result.error, position: result.position };
  }

  private setExpressionIssue(key: string, issue: ExpressionIssue | null): void {
    this.expressionIssues.update(current => {
      if (issue === null) {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      }
      return { ...current, [key]: issue };
    });
  }

  private cancelExpressionTimers(): void {
    for (const timer of this.expressionTimers.values()) clearTimeout(timer);
    this.expressionTimers.clear();
  }

  /**
   * Drops every pending check and message. Called on a selection change and
   * whenever a row is added, removed or reordered, since the messages are keyed
   * by row index and would otherwise point at the wrong expression.
   */
  private resetExpressionValidation(): void {
    this.cancelExpressionTimers();
    if (Object.keys(this.expressionIssues()).length) this.expressionIssues.set({});
  }

  // ── http-request ──

  /** Pagination mode with `none` as the default for an unconfigured node. */
  protected readonly paginationMode = computed<PaginationConfig['mode']>(
    () => this.httpRequestData()?.pagination?.mode ?? 'none',
  );

  /** Mode-specific pagination views, so each control reads a narrowed config. */
  protected readonly cursorPagination = computed(() => {
    const pagination = this.httpRequestData()?.pagination;
    return pagination?.mode === 'cursor' ? pagination : null;
  });
  protected readonly pagePagination = computed(() => {
    const pagination = this.httpRequestData()?.pagination;
    return pagination?.mode === 'page' ? pagination : null;
  });
  protected readonly offsetPagination = computed(() => {
    const pagination = this.httpRequestData()?.pagination;
    return pagination?.mode === 'offset' ? pagination : null;
  });
  protected readonly linkHeaderPagination = computed(() => {
    const pagination = this.httpRequestData()?.pagination;
    return pagination?.mode === 'link-header' ? pagination : null;
  });

  /** Switching mode replaces the config: each mode has its own required keys. */
  protected onPaginationModeChange(mode: PaginationConfig['mode']): void {
    if (!this.httpRequestData()) return;
    this.patchData({ pagination: defaultPagination(mode) });
  }

  protected patchPagination(patch: Record<string, unknown>): void {
    const pagination = this.httpRequestData()?.pagination;
    if (!pagination || pagination.mode === 'none') return;
    this.patchData({ pagination: { ...pagination, ...patch } as PaginationConfig });
  }

  protected onSuccessCodesInput(event: Event): void {
    const codes = this.parseNumberCsv(this.inputValue(event));
    this.patchData({ successCodes: codes.length ? codes : undefined });
  }

  /** Query-string and header pairs share one editor shape. */
  private httpPairs(field: 'query' | 'headers'): { key: string; value: string }[] {
    return [...(this.httpRequestData()?.[field] ?? [])];
  }

  protected addHttpPair(field: 'query' | 'headers'): void {
    if (!this.httpRequestData()) return;
    this.patchData({ [field]: [...this.httpPairs(field), { key: '', value: '' }] });
  }

  protected updateHttpPair(
    field: 'query' | 'headers',
    index: number,
    patch: Partial<{ key: string; value: string }>,
  ): void {
    const pairs = this.httpPairs(field);
    if (!pairs[index]) return;
    pairs[index] = { ...pairs[index], ...patch };
    this.patchData({ [field]: pairs });
  }

  protected removeHttpPair(field: 'query' | 'headers', index: number): void {
    const pairs = this.httpPairs(field);
    if (!pairs[index]) return;
    pairs.splice(index, 1);
    this.patchData({ [field]: pairs });
  }

  // ── sql-query ──

  protected addSqlParam(): void {
    const data = this.sqlQueryData();
    if (!data) return;
    this.patchData({ params: [...(data.params ?? []), { name: '', expression: '' }] });
  }

  protected updateSqlParam(index: number, patch: Partial<{ name: string; expression: string }>): void {
    const params = [...(this.sqlQueryData()?.params ?? [])];
    if (!params[index]) return;
    params[index] = { ...params[index], ...patch };
    this.patchData({ params });
  }

  /** Stores the typed text, then schedules its validation. */
  protected onSqlParamExpressionInput(index: number, event: Event): void {
    const text = this.inputValue(event);
    this.updateSqlParam(index, { expression: text });
    this.checkExpressionLater('sql-param', index, text);
  }

  protected removeSqlParam(index: number): void {
    const params = [...(this.sqlQueryData()?.params ?? [])];
    if (!params[index]) return;
    params.splice(index, 1);
    this.patchData({ params });
    this.resetExpressionValidation();
  }

  // ── transform ──

  /**
   * Mapped fields, always an array. An older imported spec can omit `fields`
   * even though the type declares it, and `@for` over `undefined` throws.
   */
  protected readonly transformFields = computed<TransformField[]>(
    () => this.transformData()?.fields ?? [],
  );

  protected addTransformField(): void {
    const data = this.transformData();
    if (!data) return;
    this.patchData({ fields: [...(data.fields ?? []), { target: '', expression: '' }] });
  }

  protected updateTransformField(index: number, patch: Partial<TransformField>): void {
    const fields = [...(this.transformData()?.fields ?? [])];
    if (!fields[index]) return;
    fields[index] = { ...fields[index], ...patch };
    this.patchData({ fields });
  }

  /** Stores the typed text, then schedules its validation. */
  protected onTransformExpressionInput(index: number, event: Event): void {
    const text = this.inputValue(event);
    this.updateTransformField(index, { expression: text });
    this.checkExpressionLater('transform', index, text);
  }

  protected removeTransformField(index: number): void {
    const fields = [...(this.transformData()?.fields ?? [])];
    if (!fields[index]) return;
    fields.splice(index, 1);
    this.patchData({ fields });
    this.resetExpressionValidation();
  }

  protected moveTransformField(index: number, delta: number): void {
    const fields = [...(this.transformData()?.fields ?? [])];
    const target = index + delta;
    if (!fields[index] || target < 0 || target >= fields.length) return;
    [fields[index], fields[target]] = [fields[target], fields[index]];
    this.patchData({ fields });
    this.resetExpressionValidation();
  }

  /** A cast of `''` means "leave the evaluated value as it is". */
  protected onTransformCast(index: number, cast: string): void {
    this.updateTransformField(index, { cast: (cast || undefined) as TransformField['cast'] });
  }

  /** A default may be stored as a number or boolean by an imported spec. */
  protected transformDefaultText(field: TransformField): string {
    return field.default === undefined || field.default === null ? '' : String(field.default);
  }

  /** The literal default is typed as text and stored as text, or cleared. */
  protected onTransformDefault(index: number, event: Event): void {
    const text = this.inputValue(event);
    this.updateTransformField(index, { default: text.length ? text : undefined });
  }

  /**
   * Lookup tables are a nested map, so they are edited as JSON. The draft keeps
   * the typed text while it is unparseable, which is why it lives in a signal
   * instead of being derived from the node data.
   */
  protected readonly lookupsDraft = signal<string | null>(null);
  protected readonly lookupsError = signal<string | null>(null);

  /** Drop the draft whenever the selection changes. */
  protected readonly lookupsResetter = effect(() => {
    this.node();
    untracked(() => {
      this.lookupsDraft.set(null);
      this.lookupsError.set(null);
    });
  });

  protected lookupsText(): string {
    const draft = this.lookupsDraft();
    if (draft !== null) return draft;
    const lookups = this.transformData()?.lookups;
    return lookups && Object.keys(lookups).length ? JSON.stringify(lookups, null, 2) : '';
  }

  protected onLookupsInput(event: Event): void {
    const text = this.inputValue(event);
    this.lookupsDraft.set(text);
    if (!text.trim()) {
      this.lookupsError.set(null);
      this.patchData({ lookups: undefined });
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.lookupsError.set('Expected a JSON object of named tables.');
        return;
      }
      this.lookupsError.set(null);
      this.patchData({ lookups: parsed as TransformNodeData['lookups'] });
    } catch (error) {
      this.lookupsError.set(error instanceof Error ? error.message : 'Invalid JSON.');
    }
  }

  // ── aggregate ──

  protected readonly groupSpec = computed<GroupSpec | null>(() => {
    const data = this.aggregateData();
    return data?.op === 'group' ? (data.group ?? { by: [], metrics: [] }) : null;
  });
  protected readonly joinSpec = computed<JoinSpec | null>(() => {
    const data = this.aggregateData();
    if (data?.op !== 'join') return null;
    return (
      data.join ?? { leftPath: '', rightPath: '', leftKey: '', rightKey: '', type: 'inner' }
    );
  });
  protected readonly pivotSpec = computed<PivotSpec | null>(() => {
    const data = this.aggregateData();
    if (data?.op !== 'pivot') return null;
    return data.pivot ?? { keyFields: [], valueField: '' };
  });

  /** Selecting an operation materialises that operation's spec if it is absent. */
  protected onAggregateOpChange(op: AggregateNodeData['op']): void {
    const data = this.aggregateData();
    if (!data) return;
    const patch: Record<string, unknown> = { op };
    if (op === 'group' && !data.group) patch['group'] = { by: [], metrics: [] };
    if (op === 'join' && !data.join) {
      patch['join'] = { leftPath: '', rightPath: '', leftKey: '', rightKey: '', type: 'inner' };
    }
    if (op === 'pivot' && !data.pivot) patch['pivot'] = { keyFields: [], valueField: '' };
    this.patchData(patch);
  }

  protected patchGroup(patch: Partial<GroupSpec>): void {
    const group = this.groupSpec();
    if (!group) return;
    this.patchData({ group: { ...group, ...patch } });
  }

  protected patchJoin(patch: Partial<JoinSpec>): void {
    const join = this.joinSpec();
    if (!join) return;
    this.patchData({ join: { ...join, ...patch } });
  }

  protected patchPivot(patch: Partial<PivotSpec>): void {
    const pivot = this.pivotSpec();
    if (!pivot) return;
    this.patchData({ pivot: { ...pivot, ...patch } });
  }

  protected onGroupByInput(event: Event): void {
    this.patchGroup({ by: this.parseCsv(this.inputValue(event)) });
  }

  protected onPivotKeyFieldsInput(event: Event): void {
    this.patchPivot({ keyFields: this.parseCsv(this.inputValue(event)) });
  }

  protected onPivotColumnsInput(event: Event): void {
    const columns = this.parseCsv(this.inputValue(event));
    this.patchPivot({ columns: columns.length ? columns : undefined });
  }

  /** A numeric-looking fill value is stored as a number, anything else as text. */
  protected onPivotFillValueInput(event: Event): void {
    const text = this.inputValue(event).trim();
    if (!text) {
      this.patchPivot({ fillValue: undefined });
      return;
    }
    const numeric = Number(text);
    this.patchPivot({ fillValue: Number.isFinite(numeric) ? numeric : text });
  }

  protected pivotFillValueText(pivot: PivotSpec): string {
    return pivot.fillValue === undefined || pivot.fillValue === null ? '' : String(pivot.fillValue);
  }

  /** Group metrics, always an array (see `transformFields`). */
  protected readonly groupMetrics = computed<AggregateMetric[]>(
    () => this.groupSpec()?.metrics ?? [],
  );

  protected addMetric(): void {
    const group = this.groupSpec();
    if (!group) return;
    const index = (group.metrics ?? []).length + 1;
    this.patchGroup({ metrics: [...(group.metrics ?? []), { name: `metric${index}`, fn: 'count' }] });
  }

  protected updateMetric(index: number, patch: Partial<AggregateMetric>): void {
    const group = this.groupSpec();
    if (!group) return;
    const metrics = [...(group.metrics ?? [])];
    if (!metrics[index]) return;
    metrics[index] = { ...metrics[index], ...patch };
    this.patchGroup({ metrics });
  }

  /**
   * Stores the typed predicate, then schedules its validation. The predicate is
   * optional, so an empty field carries no rejection.
   */
  protected onMetricWhereInput(index: number, event: Event): void {
    const text = this.inputValue(event);
    this.updateMetric(index, { where: text });
    this.checkExpressionLater('metric', index, text, true);
  }

  protected removeMetric(index: number): void {
    const group = this.groupSpec();
    if (!group) return;
    const metrics = [...(group.metrics ?? [])];
    if (!metrics[index]) return;
    metrics.splice(index, 1);
    this.patchGroup({ metrics });
    this.resetExpressionValidation();
  }

  // ── assert ──

  /** Assertions, always an array (see `transformFields`). */
  protected readonly assertions = computed<Assertion[]>(
    () => this.assertData()?.assertions ?? [],
  );

  protected addAssertion(): void {
    const data = this.assertData();
    if (!data) return;
    const index = (data.assertions ?? []).length + 1;
    this.patchData({
      assertions: [
        ...(data.assertions ?? []),
        { name: `check${index}`, expression: '', severity: 'error' } satisfies Assertion,
      ],
    });
  }

  protected updateAssertion(index: number, patch: Partial<Assertion>): void {
    const assertions = [...(this.assertData()?.assertions ?? [])];
    if (!assertions[index]) return;
    assertions[index] = { ...assertions[index], ...patch };
    this.patchData({ assertions });
  }

  /** Stores the typed text, then schedules its validation. */
  protected onAssertionExpressionInput(index: number, event: Event): void {
    const text = this.inputValue(event);
    this.updateAssertion(index, { expression: text });
    this.checkExpressionLater('assertion', index, text);
  }

  protected removeAssertion(index: number): void {
    const assertions = [...(this.assertData()?.assertions ?? [])];
    if (!assertions[index]) return;
    assertions.splice(index, 1);
    this.patchData({ assertions });
    this.resetExpressionValidation();
  }

  // ── state-set ──

  /** Stores the typed text, then schedules its validation. */
  protected onStateValueExpressionInput(event: Event): void {
    const text = this.inputValue(event);
    this.patchData({ valueExpression: text });
    this.checkExpressionLater('state-value', undefined, text);
  }
}
