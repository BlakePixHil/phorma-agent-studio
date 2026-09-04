import { Injectable, computed, inject, signal } from '@angular/core';

import {
  applyConnectionAuth,
  BROWSER_CAPABILITIES,
  createRedactor,
  DEFAULT_MAX_RESPONSE_BYTES,
  startRun,
  TAURI_DESKTOP_CAPABILITIES,
  validateAgainstCapabilities,
  withEstimatedCost,
  type CapabilityFinding,
  type ConnectionSummary,
  type DataRequest,
  type HostCapabilities,
  type Redactor,
  type ResolvedConnection,
  type RunEvent,
  type RunHandle,
  type RunNodeState,
  type RunRecord,
} from '@phorma/engine';

import { AgentStreamService } from './agent-stream.service';
import { refusalNotice, remedyForRunFailure } from './billing-refusal';
import { ConnectionStoreService } from './connection-store.service';
import {
  messageOf,
  notificationDetail,
  notificationEndpoint,
  notificationTriggerFor,
  notificationWanted,
  NOTIFY_DETAIL_CHARS,
  NOTIFY_MAX_ATTEMPTS,
  NOTIFY_TIMEOUT_MS,
  resolveRunRetention,
  type NotifyTrigger,
  type WorkflowNotificationPolicy,
} from './data-path-settings';
import { DataFetchService } from './data-fetch.service';
import { FixtureStoreService } from './fixture-store.service';
import { ModelTransportService } from './model-transport.service';
import { ModelPricingService } from './model-pricing.service';
import { PanelRegistryService } from './panel-registry.service';
import { RUN_HISTORY_LIMIT, RunHistoryService } from './run-history.service';
import { SettingsService } from './settings.service';
import { SqlHostService } from './sql-host.service';
import { TauriService } from './tauri.service';
import { counterName } from './telemetry-catalog';
import { TelemetryService } from './telemetry.service';
import { TerminalOutputService } from './terminal-output.service';
import { ToolHostService } from './tool-host.service';
import { WorkflowStateService } from './workflow-state.service';
import { WorkflowService } from './workflow.service';
import { BillingCtaService } from '../shared/billing/billing-cta.service';
import { ToastService } from '../shared/toast/toast.service';
import { PhormaCloudService } from './phorma-cloud.service';
import { describeRunEvent, traceFromRunLog } from './run-trace';
import { portBaseId, type WorkflowGraph, type WorkflowSpec } from './workflow.model';

/** Live usage totals for the current run (see {@link RunControllerService.runUsage}). */
export interface RunUsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** Total USD (reported + estimated), including the Phorma Cloud share. */
  costUsd: number;
  /** USD share billed to Phorma Cloud plan credits — display as credits only. */
  phormaCloudCostUsd: number;
  /** True when any portion of `costUsd` is a pricing-table estimate. */
  estimated: boolean;
  /** True once any round ran on Phorma Cloud. */
  phormaCloud: boolean;
}

const EMPTY_RUN_USAGE: RunUsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  phormaCloudCostUsd: 0,
  estimated: false,
  phormaCloud: false,
};

/** One entry in the Runs panel trace timeline. */
export interface TraceEntry {
  id: number;
  at: number;
  icon: string;
  label: string;
  /** Expandable payload (markdown/plain text). */
  detail?: string;
  tone: 'info' | 'success' | 'warning' | 'error';
  /**
   * Classification used by the Runs panel to group consecutive tool activity
   * into a single container. A tool call and its result are distinct entries
   * but count as one logical step in the group header.
   */
  kind: 'tool-call' | 'tool-result' | 'event';
  /** Root-to-leaf Execute Workflow scope for nested trace grouping. */
  scope?: RunEvent['scope'];
}

/** A pending human approval, surfaced in the Runs panel. */
export interface PendingApproval {
  /** Engine identity for this exact gate occurrence. */
  requestId: string;
  nodeId: string;
  nodeName: string;
  message: string;
  payload: string;
  resolve: (approved: boolean) => void;
}

/** A suspended Wait-for-Event node, surfaced in the Runs panel. */
export interface PendingWait {
  nodeId: string;
  nodeName: string;
  correlationKey: string;
  message: string;
  payload: string;
  /** Delivers the external event's payload (JSON or plain text). */
  resolve: (eventPayload: string) => void;
}

/** A suspended Ask-User node, surfaced in the Runs panel. */
export interface PendingQuestion {
  /** Engine identity for this exact ask occurrence. */
  requestId: string;
  nodeId: string;
  nodeName: string;
  question: string;
  payload: string;
  /** Delivers the user's free-text response. */
  resolve: (response: string) => void;
}

/** How long a handoff edge stays lit after the pulse (ms). */
const EDGE_PULSE_MS = 1400;
/** Trace buffer cap. */
const MAX_TRACE_ENTRIES = 500;

function truncateArgs(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

function firstLine(value: string): string {
  const line = value.split('\n', 1)[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

/**
 * The run controller — bridges the engine's RunEvent stream to the studio:
 * node glow states + edge pulses on the canvas, console lines, the Runs
 * trace timeline, approval gates, and the toolbar's run/pause/step/stop
 * controls. Cloud monitoring (Phase 4) feeds the SAME `apply()` path, which
 * is what gives local and deployed runs identical visualization.
 */
@Injectable({ providedIn: 'root' })
export class RunControllerService {
  private readonly workflow = inject(WorkflowService);
  private readonly transport = inject(ModelTransportService);
  private readonly settings = inject(SettingsService);
  private readonly terminal = inject(TerminalOutputService);
  private readonly agentStream = inject(AgentStreamService);
  private readonly toolHost = inject(ToolHostService);
  private readonly toast = inject(ToastService);
  private readonly panels = inject(PanelRegistryService);
  // Every billing CTA a run failure can raise. Safe DI direction: it reaches
  // only signal-holder dialog services, the `BillingService` leaf, and
  // `PhormaCloudService`, which this service already injects one line down.
  private readonly billingCta = inject(BillingCtaService);
  private readonly phormaCloud = inject(PhormaCloudService);
  private readonly runHistory = inject(RunHistoryService);
  private readonly pricing = inject(ModelPricingService);
  private readonly tauri = inject(TauriService);
  private readonly connectionStore = inject(ConnectionStoreService);
  private readonly dataFetch = inject(DataFetchService);
  private readonly sqlHost = inject(SqlHostService);
  private readonly workflowState = inject(WorkflowStateService);
  private readonly fixtureStore = inject(FixtureStoreService);
  // Safe DI direction: `TelemetryService` is a leaf that injects only
  // `TauriService`, so this edge cannot close the known NG0200 cycle
  // (`RunControllerService -> ModelTransportService -> PhormaCloudService ->
  // CloudService -> RunControllerService`).
  private readonly telemetry = inject(TelemetryService);

  private handle: RunHandle | null = null;
  private traceCounter = 0;
  private runCounter = 0;
  private readonly edgeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Toast ids raised for pending questions, so they can be dismissed on answer. */
  private readonly questionToasts = new Map<string, number>();

  // ── Reactive state the UI consumes ─────────────────────────────────────────

  /** Per-node run state for canvas rings. */
  readonly nodeStates = signal<ReadonlyMap<string, RunNodeState>>(new Map());
  /** Connection ids currently pulsing. */
  readonly activeEdges = signal<ReadonlySet<string>>(new Set());
  /** Node ids with breakpoints. */
  readonly breakpoints = signal<ReadonlySet<string>>(new Set());
  /** The Runs panel timeline for the current/most recent run. */
  readonly trace = signal<TraceEntry[]>([]);
  /** Approval requests awaiting a human. */
  readonly pendingApprovals = signal<PendingApproval[]>([]);
  /** Wait-for-Event nodes awaiting an external event. */
  readonly pendingWaits = signal<PendingWait[]>([]);
  /** Ask-User nodes awaiting a free-text response. */
  readonly pendingQuestions = signal<PendingQuestion[]>([]);
  /**
   * Draft answers per pending Ask-User request id. Owned here (not by the
   * Runs panel) because the same question is answerable from two surfaces —
   * the inline canvas overlay and the Runs panel card — and both must edit
   * and submit the same text.
   */
  readonly questionDrafts = signal<Record<string, string>>({});
  /**
   * Request id whose Runs-panel answer box should take focus, set by the
   * "Answer" toast action. The panel clears it once focus lands.
   */
  readonly focusQuestionId = signal<string | null>(null);
  /** Task input used for the next run (bound to the Runs panel textarea). */
  readonly runInput = signal('');
  /** Total streamed characters this run (cheap progress proxy). */
  readonly streamedChars = signal(0);
  /**
   * Per-node reasoning/thinking text captured during a run. Not persisted to
   * the DB — dumped on restart or when a node is removed from the canvas.
   * `streaming` is true while the node is still emitting thinking tokens;
   * the canvas overlay uses it to drive the shimmer and auto-collapse.
   */
  readonly nodeThinking = signal<ReadonlyMap<string, { text: string; streaming: boolean }>>(new Map());

  /**
   * Cumulative token/cost usage for the current run, summed from node-usage
   * events (one per model round). `costUsd` is provider-reported where
   * available (OpenRouter/Phorma Cloud) and pricing-table ESTIMATED
   * otherwise (`estimated` flips true). `phormaCloudCostUsd` is the share
   * billed to plan credits — the UI must render that share as credits,
   * never dollars.
   */
  readonly runUsage = signal<RunUsageTotals>(EMPTY_RUN_USAGE);

  /**
   * Set while a persisted run is displayed on the canvas ("Bring to
   * Canvas"). Cleared when a new run starts or the session is reset. The
   * Runs panel shows a "viewing past run" banner while non-null.
   */
  readonly viewingHistoricalRunId = signal<string | null>(null);

  /**
   * Set by CloudService while a monitor is connected: routes approval
   * resolutions for REMOTE runs over the WebSocket. Local runs create their
   * own pending entries via the engine callback and ignore this.
   */
  remoteApprovalSender: ((requestId: string, approved: boolean) => void) | null = null;

  /**
   * Set by CloudService while a monitor is connected: delivers external
   * events for REMOTE runs over the WebSocket (manual injection from the
   * Runs panel; production events arrive via the worker's /events webhook).
   */
  remoteEventSender: ((correlationKey: string, payload: string) => void) | null = null;

  /**
   * Set by CloudService while a monitor is connected: routes Ask-User
   * responses for REMOTE runs over the WebSocket. Local runs create their
   * own pending entries via the engine callback and ignore this.
   */
  remoteQuestionSender: ((requestId: string, response: string) => void) | null = null;

  readonly running = computed(() => {
    const phase = this.terminal.phase();
    return (
      phase === 'starting' ||
      phase === 'running' ||
      phase === 'paused' ||
      phase === 'waiting-approval' ||
      phase === 'waiting-event' ||
      phase === 'waiting-input'
    );
  });
  readonly paused = computed(() => this.terminal.phase() === 'paused');
  /**
   * True when a run has finished (completed, failed, or stopped) and the
   * session can be reset back to a pre-run state. Paused and
   * waiting-approval are intentionally excluded — the run is still alive.
   */
  readonly canReset = computed(() => {
    const phase = this.terminal.phase();
    return phase === 'completed' || phase === 'failed' || phase === 'stopped';
  });

  // ── Controls (toolbar + Runs panel) ────────────────────────────────────────

  /**
   * Starts a run of the active workflow.
   *
   * Requirement 17.9: before `startRun` is ever called, the Capability_Validator
   * runs against the active local host's capability record and its local
   * connection inventory. Requirement 17.10: any `error` finding blocks the run
   * entirely — no `startRun` call, no `RunHistoryService.beginRun` call, no run
   * record created — and every finding is surfaced. `terminal.setPhase(
   * 'starting')` guards this async gap so a second click cannot race a fresh
   * validation pass while one is already in flight (`running()` treats
   * 'starting' the same as 'running').
   */
  start(): void {
    if (this.running()) return;
    const portableSpec = this.workflow.exportActiveSpec();
    const graph = portableSpec?.graph ?? this.workflow.graph();
    if (graph.nodes.length === 0) {
      this.toast.warning('Nothing to run', 'Drop some agents onto the canvas first.');
      return;
    }
    if (!graph.nodes.some(node => node.category === 'trigger')) {
      this.toast.warning('No trigger', 'Add a Manual trigger so the run knows where to start.');
      return;
    }

    this.terminal.setPhase('starting');
    void this.validateAndStart(portableSpec, graph);
  }

  /**
   * Requirements 17.9, 17.10, 17.15: validates the graph (top level plus
   * every embedded sub-workflow) against the active local host's capability
   * record before anything else runs. A `warning`-only result never blocks
   * the run; any `error` finding does, with no `startRun` call and no run
   * record created.
   */
  private async validateAndStart(
    portableSpec: WorkflowSpec | null,
    graph: WorkflowGraph,
  ): Promise<void> {
    const capabilities = this.tauri.isDesktop ? TAURI_DESKTOP_CAPABILITIES : BROWSER_CAPABILITIES;
    let connections: ConnectionSummary[] = [];
    try {
      connections = await this.connectionStore.list();
    } catch {
      // An unreadable local inventory means every connectionId is unresolved,
      // which the validator reports as a finding — never a silent skip.
      connections = [];
    }

    const findings = validateAgainstCapabilities(
      { graph, subWorkflows: portableSpec?.subWorkflows },
      capabilities,
      connections,
    );
    const errors = findings.filter(finding => finding.severity === 'error');
    if (errors.length > 0) {
      this.terminal.setPhase('idle');
      this.reportCapabilityFindings(findings);
      this.toast.error(
        'Run blocked',
        `${errors.length} problem${errors.length === 1 ? '' : 's'} would prevent this workflow ` +
          `from running on ${capabilities.label}. See the Problems console.`,
      );
      return;
    }

    this.startValidatedRun(portableSpec, graph, capabilities);
  }

  /** Every returned finding, oldest first, into the Problems console. */
  private reportCapabilityFindings(findings: CapabilityFinding[]): void {
    this.terminal.open('problems');
    for (const finding of findings) {
      this.console('problems', finding.severity === 'error' ? 'error' : 'warning', finding.message);
    }
  }

  /** The original run-start sequence, run only once validation has passed. */
  private startValidatedRun(
    portableSpec: WorkflowSpec | null,
    graph: WorkflowGraph,
    capabilities: HostCapabilities,
  ): void {
    this.resetRunState();
    this.viewingHistoricalRunId.set(null);
    this.runCounter += 1;
    const runId = `run-${Date.now().toString(36)}-${this.runCounter}`;

    // One snapshot serves both the engine and the run-history record — the
    // user can keep editing the canvas while the run executes.
    const graphSnapshot = structuredClone(graph);
    const doc = this.workflow.activeDoc();
    const workflowId = doc?.workflowId ?? '';
    // The complete portable registry is captured once. No run callback reads
    // the mutable workflow library, so edits made while running cannot alter
    // a later child frame.
    const subWorkflows = portableSpec?.subWorkflows
      ? structuredClone(portableSpec.subWorkflows)
      : undefined;

    // Redaction (P1-12), built per run from the workflow's retention
    // settings and seeded further at run time with every resolved
    // connection secret. It sits IN FRONT of the run-history recorder, so a
    // secret can never be persisted, not even inside a clipped fragment
    // (Requirement 15.10). Rejected rules are reported, never fatal (15.16).
    const settings = portableSpec?.settings ?? doc?.settings;
    const retentionSettings = settings?.retention;
    const redactor = createRedactor({
      rules: Array.isArray(retentionSettings?.redact) ? retentionSettings.redact : [],
      noPersistNodeIds: Array.isArray(retentionSettings?.noPersistNodeIds)
        ? retentionSettings.noPersistNodeIds
        : [],
    });
    for (const ruleError of redactor.ruleErrors) {
      this.console('problems', 'warning', ruleError);
    }
    const retention = resolveRunRetention(retentionSettings, RUN_HISTORY_LIMIT, message =>
      this.console('problems', 'warning', message),
    );

    this.runHistory.beginRun({
      runId,
      workflowId: doc?.workflowId ?? null,
      workflowName: doc?.name ?? 'Untitled Workflow',
      graph: graphSnapshot,
      subWorkflows,
      retention,
    });

    const notificationPolicy = settings?.notifications;

    const handle = startRun({
      runId,
      graph: graphSnapshot,
      input: this.runInput().trim(),
      // ── Deterministic data path (P1) ────────────────────────────────────
      workflowId,
      connections: this.connectionStore.forWorkflow(workflowId),
      dataFetch: this.dataFetch.fetch,
      sql: this.sqlHost,
      state: this.workflowState,
      fixtures: this.fixtureStore,
      redact: value => redactor.scrub(value),
      capabilities,
      // Batch workflows (ForEach) legitimately execute far more nodes than
      // the default anti-runaway budget allows.
      maxExecutions:
        graph.nodes.some(node => node.kind === 'for-each') ||
          Object.values(subWorkflows ?? {}).some(workflow =>
            workflow.graph.nodes.some(node => node.kind === 'for-each'),
          )
          ? 2000
          : undefined,
      subWorkflows,
      maxSubWorkflowDepth: this.phormaCloud.subWorkflowDepth(),
      model: this.transport.create(),
      ollamaBaseUrl: this.settings.ollamaBaseUrl(),
      lmstudioBaseUrl: this.settings.lmstudioBaseUrl(),
      bedrockRegion: this.settings.bedrockRegion(),
      defaultModel: {
        provider: this.settings.defaultProvider(),
        model: this.settings.defaultModel(),
        temperature: this.settings.defaultTemperature(),
      },
      maxToolRounds: this.settings.maxToolRounds(),
      // Workflow-level timeout (Properties panel → Workflow settings).
      runTimeoutMs: (() => {
        const minutes = portableSpec?.settings?.timeoutMinutes;
        return typeof minutes === 'number' && minutes > 0 ? minutes * 60_000 : undefined;
      })(),
      // Context-window lookup for automatic context compression.
      contextWindow: this.pricing.contextWindowLookup(),
      tools: this.toolHost,
      // History records ONLY from the local engine's emit — cloud-monitor
      // events reach apply() directly and are persisted by the DO instead.
      emit: event => {
        // Requirement 15.10: the persistence path — and only the
        // persistence path — is redacted, ahead of the recorder's own 64 KB
        // clipping. The live canvas below (`apply`) keeps full fidelity.
        this.runHistory.record(redactor.event(event));
        this.apply(event);
        // Workflow-level notifications watch the run's own event stream
        // (Requirements 13.7, 13.10).
        this.notifyOnRunEvent(event, workflowId, doc?.name ?? 'Untitled Workflow', notificationPolicy, redactor);
      },
      requestApproval: (nodeId, message, payload, requestId) =>
        new Promise<boolean>(resolve => {
          const scopedNode = Object.values(subWorkflows ?? {})
            .flatMap(workflow => workflow.graph.nodes)
            .find(node => node.id === nodeId);
          const nodeName =
            graphSnapshot.nodes.find(node => node.id === nodeId)?.name ?? scopedNode?.name ?? nodeId;
          this.pendingApprovals.update(list => [
            ...list,
            { requestId, nodeId, nodeName, message, payload, resolve },
          ]);
        }),
      waitForEvent: (nodeId, correlationKey, message, payload, timeoutMs) =>
        new Promise<string>((resolve, reject) => {
          const nodeName =
            this.workflow.graph().nodes.find(node => node.id === nodeId)?.name ?? nodeId;
          // Local debug runs enforce the timeout with a plain timer; the
          // deployed path uses a durable DO alarm instead.
          let timer: ReturnType<typeof setTimeout> | undefined;
          const settle = (fn: () => void) => {
            if (timer) clearTimeout(timer);
            this.pendingWaits.update(list => list.filter(item => item.nodeId !== nodeId));
            fn();
          };
          if (timeoutMs && timeoutMs > 0) {
            timer = setTimeout(
              () =>
                settle(() =>
                  reject(new Error(`Timed out waiting for external event "${correlationKey}".`)),
                ),
              timeoutMs,
            );
          }
          this.pendingWaits.update(list => [
            ...list,
            {
              nodeId,
              nodeName,
              correlationKey,
              message,
              payload,
              resolve: eventPayload => settle(() => resolve(eventPayload)),
            },
          ]);
        }),
      requestInput: (nodeId, question, payload, requestId) =>
        new Promise<string>(resolve => {
          const scopedNode = Object.values(subWorkflows ?? {})
            .flatMap(workflow => workflow.graph.nodes)
            .find(node => node.id === nodeId);
          const nodeName =
            this.workflow.graph().nodes.find(node => node.id === nodeId)?.name ??
            scopedNode?.name ??
            nodeId;
          this.pendingQuestions.update(list => [
            ...list,
            { requestId, nodeId, nodeName, question, payload, resolve },
          ]);
        }),
    });
    for (const nodeId of this.breakpoints()) handle.gate.breakpoints.add(nodeId);
    this.handle = handle;
    void handle.done.finally(() => {
      if (this.handle === handle) this.handle = null;
    });
  }

  pauseOrResume(): void {
    if (!this.handle) return;
    if (this.paused()) this.handle.resume();
    else this.handle.pause();
  }

  step(): void {
    this.handle?.step();
  }

  stop(): void {
    if (!this.handle) return;
    this.handle.stop();
    // Unblock any pending approvals/waits/questions so the run can unwind.
    for (const approval of this.pendingApprovals()) approval.resolve(false);
    this.pendingApprovals.set([]);
    for (const wait of this.pendingWaits()) wait.resolve('');
    this.pendingWaits.set([]);
    for (const question of this.pendingQuestions()) question.resolve('');
    this.clearQuestions();
  }

  /**
   * Resets the run session back to a pre-run state: clears all consoles,
   * drops node glows/rings, edge pulses, the trace timeline, thinking
   * buffers, and pending approvals. Only valid when a run has finished —
   * the toolbar binds it to `canReset`. Has no effect on the workflow graph,
   * breakpoints, or run input.
   */
  reset(): void {
    if (!this.canReset()) return;
    this.resetRunState();
    this.nodeThinking.set(new Map());
    this.viewingHistoricalRunId.set(null);
    this.terminal.setPhase('idle');
  }

  /**
   * Seeds the canvas + Runs panel with a persisted run's final state
   * ("Bring to Canvas"). Read-only: no pending cards, no edge pulses, no
   * phase transitions beyond marking the viewer state — the run is history,
   * not resumable. The caller is responsible for opening the run's graph
   * snapshot first (see `WorkflowService.openRunSnapshot`).
   */
  loadHistoricalRun(record: RunRecord): void {
    if (this.running()) return;
    this.resetRunState();

    const names = new Map(record.graph.nodes.map(node => [node.id, node.name]));
    const nodeName = (id: string) => names.get(id) ?? id;

    // Final node rings from the event log (last state wins — re-executed
    // nodes in cycles/loops settle on their final outcome).
    const states = new Map<string, RunNodeState>();
    const thinking = new Map<string, { text: string; streaming: boolean }>();
    for (const event of record.events) {
      if ('scope' in event && event.scope?.length) continue;
      switch (event.type) {
        case 'node-started':
          states.set(event.nodeId, 'thinking');
          break;
        case 'node-completed':
          states.set(event.nodeId, 'done');
          break;
        case 'node-failed':
          states.set(event.nodeId, 'error');
          break;
        case 'node-thinking-text':
          thinking.set(event.nodeId, { text: event.text, streaming: false });
          break;
      }
    }

    this.nodeStates.set(states);
    this.nodeThinking.set(thinking);
    this.trace.set(traceFromRunLog(record.events, nodeName, { formatCost: this.formatTraceCost }));
    this.traceCounter = this.trace().length;
    this.runInput.set(record.summary.input);
    const usage = record.summary.usage;
    const phormaCloudCostUsd = usage.phormaCloudCostUsd ?? 0;
    this.runUsage.set({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      phormaCloudCostUsd,
      estimated: usage.estimated ?? false,
      phormaCloud: phormaCloudCostUsd > 0,
    });
    this.viewingHistoricalRunId.set(record.summary.id);
    this.terminal.setPhase(
      record.summary.status === 'running'
        ? 'idle'
        : record.summary.status === 'skipped'
          ? 'stopped'
          : record.summary.status,
    );
  }

  /** Exits historical-run viewing, clearing the seeded state (banner ×). */
  stopViewingHistoricalRun(): void {
    if (!this.viewingHistoricalRunId()) return;
    if (this.running()) return;
    this.resetRunState();
    this.viewingHistoricalRunId.set(null);
    this.terminal.setPhase('idle');
  }

  /** Resolves a pending approval from the Runs panel. */
  resolveApproval(requestId: string, approved: boolean): void {
    const approval = this.pendingApprovals().find(item => item.requestId === requestId);
    if (!approval) return;
    this.pendingApprovals.update(list => list.filter(item => item.requestId !== requestId));
    approval.resolve(approved);
  }

  /**
   * Delivers an external event to a suspended Wait-for-Event node (Runs
   * panel manual injection; webhook-fed cloud runs resolve on the worker).
   */
  resolveWait(nodeId: string, eventPayload: string): void {
    const wait = this.pendingWaits().find(item => item.nodeId === nodeId);
    if (!wait) return;
    this.pendingWaits.update(list => list.filter(item => item.nodeId !== nodeId));
    wait.resolve(eventPayload);
  }

  /** Submits a user's free-text response to a suspended Ask-User node. */
  resolveQuestion(requestId: string, response: string): void {
    const question = this.pendingQuestions().find(item => item.requestId === requestId);
    if (!question) return;
    this.pendingQuestions.update(list => list.filter(item => item.requestId !== requestId));
    this.clearQuestionDraft(requestId);
    question.resolve(response);
  }

  /** Records in-progress answer text for a pending Ask-User node. */
  setQuestionDraft(requestId: string, text: string): void {
    this.questionDrafts.update(drafts => ({ ...drafts, [requestId]: text }));
  }

  private clearQuestionDraft(requestId: string): void {
    this.questionDrafts.update(drafts => {
      if (!(requestId in drafts)) return drafts;
      const next = { ...drafts };
      delete next[requestId];
      return next;
    });
    if (this.focusQuestionId() === requestId) this.focusQuestionId.set(null);
    this.dismissQuestionToast(requestId);
  }

  /** Drops every pending question card along with its draft + focus state. */
  private clearQuestions(): void {
    this.pendingQuestions.set([]);
    this.questionDrafts.set({});
    this.focusQuestionId.set(null);
    for (const id of this.questionToasts.values()) this.toast.dismiss(id);
    this.questionToasts.clear();
  }

  /**
   * Makes a suspended question impossible to miss: reveals the Runs pane and
   * raises a persistent toast whose action focuses that question's answer box.
   * The canvas overlay is the primary surface, but it only exists for nodes on
   * the active graph — sub-workflow nodes are answerable in the panel only.
   */
  private announceQuestion(requestId: string, nodeName: string, question: string): void {
    this.revealRunsPane();
    if (this.questionToasts.has(requestId)) return;
    const id = this.toast.warning(`${nodeName} needs an answer`, firstLine(question), {
      label: 'Answer',
      onClick: () => {
        this.revealRunsPane();
        this.focusQuestionId.set(requestId);
      },
    });
    this.questionToasts.set(requestId, id);
  }

  private dismissQuestionToast(requestId: string): void {
    const id = this.questionToasts.get(requestId);
    if (id === undefined) return;
    this.questionToasts.delete(requestId);
    this.toast.dismiss(id);
  }

  /** Opens the sidebar on whichever side hosts the Runs tab and activates it. */
  private revealRunsPane(): void {
    const side = this.panels.tabs().find(tab => tab.id === 'runs')?.side ?? 'right';
    this.panels.setActive(side, 'runs');
    if (side === 'right') this.panels.expandRight();
    else this.panels.expandLeft();
  }

  /** Toggles a breakpoint on a node (context menu). */
  toggleBreakpoint(nodeId: string): void {
    this.breakpoints.update(current => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
    // Live-sync into an in-flight run.
    if (this.handle) {
      if (this.breakpoints().has(nodeId)) this.handle.gate.breakpoints.add(nodeId);
      else this.handle.gate.breakpoints.delete(nodeId);
    }
  }

  // ── RunEvent application (local engine AND cloud monitor feed this) ────────

  /**
   * Trace cost formatter (EPIC 2 display rule): Phorma Cloud-billed cost
   * renders as plan credits — never dollars — while BYO cost renders as
   * USD, labeled "(est.)" when it came from the pricing table.
   */
  readonly formatTraceCost = (provider: string, costUsd: number, estimated: boolean): string | null => {
    if (provider === 'phorma-cloud') {
      const credits = Math.max(1, Math.round(costUsd * this.phormaCloud.creditsPerUsd()));
      return `${credits.toLocaleString()} cr`;
    }
    return `$${costUsd.toFixed(4)}${estimated ? ' (est.)' : ''}`;
  };

  apply(event: RunEvent): void {
    // Trace entries come from the SAME pure builder the run-history detail
    // view uses (`describeRunEvent`) — live and historical timelines can
    // never drift apart. Token stream events never trace.
    if (event.type !== 'node-token' && event.type !== 'node-thinking') {
      // Live BYO usage events may lack a cost until estimation — estimate
      // here so the trace shows it (record/history paths estimate in the
      // recorder instead).
      const traced =
        event.type === 'node-usage'
          ? { ...event, usage: withEstimatedCost(event.usage, event.provider, event.model ?? '', this.pricing.estimator()) }
          : event;
      const desc = describeRunEvent(traced, id => this.nodeName(id), { formatCost: this.formatTraceCost });
      if (desc) this.pushTrace(desc.icon, desc.label, desc.detail, desc.tone, desc.kind, event.scope);
    }

    // Interior child events still contribute usage above, but their node ids
    // belong to another graph and must not animate the parent canvas.
    const scoped = !!event.scope?.length;

    switch (event.type) {
      case 'run-started':
        // RunEvents are the only visualization contract, and `apply()` is the
        // single funnel both the local engine and the cloud WebSocket feed, so
        // one call here covers both run paths.
        this.telemetry.count(counterName('run.started'));
        this.terminal.setPhase('running');
        if (this.settings.autoOpenConsoleOnRun()) this.terminal.open('run');
        this.console('run', 'info', `Run started${event.input ? ` — "${event.input}"` : ''}.`);
        // A new run dumps any prior thinking text (per the persistence rule:
        // thinking survives until node removal OR a restart).
        this.nodeThinking.set(new Map());
        this.runUsage.set(EMPTY_RUN_USAGE);
        break;

      case 'node-started':
        if (scoped) break;
        this.setNodeState(event.nodeId, 'thinking');
        this.agentStream.markEditing(event.nodeId);
        this.console('run', 'info', `→ ${event.nodeName}`);
        break;

      case 'node-token':
        if (scoped) break;
        this.streamedChars.update(count => count + event.token.length);
        this.appendStreaming(event.nodeId, event.token);
        break;

      case 'node-thinking':
        if (scoped) break;
        this.appendThinking(event.nodeId, event.token);
        break;

      case 'node-usage': {
        // Fill in an estimated cost for BYO providers that only report
        // token counts. Reported (OpenRouter/Phorma Cloud) costs win.
        const usage = withEstimatedCost(
          event.usage,
          event.provider,
          event.model ?? '',
          this.pricing.estimator(),
        );
        const costUsd = usage.costUsd ?? 0;
        const cloud = event.provider === 'phorma-cloud';
        this.runUsage.update(current => ({
          inputTokens: current.inputTokens + (usage.inputTokens ?? 0),
          outputTokens: current.outputTokens + (usage.outputTokens ?? 0),
          costUsd: current.costUsd + costUsd,
          // The Phorma Cloud share is billed to plan credits — shown in
          // abstract credits, never dollars.
          phormaCloudCostUsd: current.phormaCloudCostUsd + (cloud ? costUsd : 0),
          estimated: current.estimated || usage.costSource === 'estimated',
          phormaCloud: current.phormaCloud || cloud,
        }));
        break;
      }

      case 'node-completed':
        if (scoped) break;
        this.flushStreaming(event.nodeId);
        this.finishThinking(event.nodeId);
        this.setNodeState(event.nodeId, 'done');
        this.agentStream.clearEditing(event.nodeId);
        break;

      case 'node-failed':
        if (scoped) break;
        this.flushStreaming(event.nodeId);
        this.finishThinking(event.nodeId);
        this.setNodeState(event.nodeId, 'error');
        this.agentStream.clearEditing(event.nodeId);
        this.console('problems', 'error', `${event.nodeName}: ${event.error}`);
        break;

      case 'node-retrying':
        // The node stays in 'thinking' — the retry is part of its execution.
        this.console(
          'run',
          'warning',
          `${event.nodeName}: transient failure — retrying (attempt ${event.attempt + 1}/${event.maxAttempts}). ${event.error}`,
        );
        break;

      case 'node-fallback':
        this.console(
          'run',
          'warning',
          `${event.nodeName}: primary model ${event.fromModel} failed — switching to fallback ${event.toModel}.`,
        );
        break;

      case 'node-error-routed':
        this.console('run', 'warning', `${event.nodeName}: failure routed to the error branch.`);
        break;

      case 'context-compressed':
        this.console(
          'run',
          'info',
          `${this.nodeName(event.nodeId)}: context compressed (~${event.beforeTokens.toLocaleString()} → ~${event.afterTokens.toLocaleString()} tokens).`,
        );
        break;

      case 'handoff': {
        if (scoped) break;
        this.pulseEdge(event.connectionId);
        const from = this.nodeName(event.fromNodeId);
        const to = this.nodeName(event.toNodeId);
        this.setNodeState(event.toNodeId, 'queued');
        this.console('run', 'info', `${from} ⇢ ${to}`);
        break;
      }

      case 'tool-call': {
        if (scoped) break;
        // Light up the tool-link edge and the tool node while it executes.
        const edge = this.toolLinkConnection(event.nodeId, event.toolNodeId);
        if (edge) this.pulseEdge(edge);
        if (event.toolNodeId) this.setNodeState(event.toolNodeId, 'thinking');
        this.console('tools', 'info', `${this.nodeName(event.nodeId)} → ${event.name}(${truncateArgs(event.arguments)})`);
        break;
      }

      case 'tool-result':
        if (scoped) break;
        if (event.toolNodeId) this.setNodeState(event.toolNodeId, event.isError ? 'error' : 'done');
        this.console('tools', event.isError ? 'error' : 'info', `${event.name} → ${firstLine(event.result)}`);
        break;

      case 'approval-required':
        this.terminal.setPhase('waiting-approval');
        if (!scoped) this.setNodeState(event.nodeId, 'waiting-approval');
        this.console('run', 'warning', `Approval required: ${event.message}`);
        // Remote runs: the engine callback lives in the cloud, so synthesize
        // the pending entry here and resolve it over the monitor socket.
        if (
          this.remoteApprovalSender &&
          !this.pendingApprovals().some(item => item.requestId === event.requestId)
        ) {
          const send = this.remoteApprovalSender;
          this.pendingApprovals.update(list => [
            ...list,
            {
              requestId: event.requestId,
              nodeId: event.nodeId,
              nodeName: this.nodeName(event.nodeId),
              message: event.message,
              payload: event.payload,
              resolve: approved => send(event.requestId, approved),
            },
          ]);
        }
        break;

      case 'approval-resolved':
        if (!scoped) this.setNodeState(event.nodeId, event.approved ? 'done' : 'idle');
        // Remote monitors may still hold a synthetic pending card — clear it.
        this.pendingApprovals.update(list =>
          list.filter(item => item.requestId !== event.requestId),
        );
        this.terminal.setPhase(
          this.pendingApprovals().length > 0
            ? 'waiting-approval'
            : this.pendingQuestions().length > 0
              ? 'waiting-input'
              : 'running',
        );
        break;

      case 'loop-started':
        this.console('run', 'info', `${event.nodeName}: iterating ${event.total} item${event.total === 1 ? '' : 's'}.`);
        break;

      case 'loop-iteration':
        this.console('run', 'info', `${this.nodeName(event.nodeId)}: item ${event.index + 1}/${event.total}`);
        break;

      case 'loop-completed': {
        const tone = event.failed > 0 ? 'warning' : 'success';
        const summary = `${event.succeeded}/${event.total} succeeded${event.failed > 0 ? `, ${event.failed} failed` : ''}`;
        this.console('run', tone, `${this.nodeName(event.nodeId)}: loop finished — ${summary}.`);
        break;
      }

      case 'wait-started':
        this.terminal.setPhase('waiting-event');
        if (!scoped) this.setNodeState(event.nodeId, 'waiting-event');
        this.console('run', 'warning', `Waiting for event "${event.correlationKey}": ${event.message}`);
        // Remote runs: the engine callback lives in the cloud — synthesize a
        // pending card whose resolver ships the event over the monitor socket.
        if (
          this.remoteEventSender &&
          !this.pendingWaits().some(item => item.nodeId === event.nodeId)
        ) {
          const send = this.remoteEventSender;
          this.pendingWaits.update(list => [
            ...list,
            {
              nodeId: event.nodeId,
              nodeName: this.nodeName(event.nodeId),
              correlationKey: event.correlationKey,
              message: event.message,
              payload: event.payload,
              resolve: payload => send(event.correlationKey, payload),
            },
          ]);
        }
        break;

      case 'wait-resolved':
        this.terminal.setPhase('running');
        if (!scoped) this.setNodeState(event.nodeId, 'done');
        // Remote monitors may hold no local resolver — just clear any card.
        this.pendingWaits.update(list => list.filter(item => item.nodeId !== event.nodeId));
        this.console('run', 'info', `Event "${event.correlationKey}" arrived — resuming.`);
        break;

      case 'ask-required':
        this.terminal.setPhase('waiting-input');
        if (!scoped) this.setNodeState(event.nodeId, 'waiting-input');
        this.console('run', 'warning', `Question: ${event.question}`);
        // Remote runs: the engine callback lives in the cloud, so synthesize
        // the pending entry here and resolve it over the monitor socket.
        if (
          this.remoteQuestionSender &&
          !this.pendingQuestions().some(item => item.requestId === event.requestId)
        ) {
          const send = this.remoteQuestionSender;
          this.pendingQuestions.update(list => [
            ...list,
            {
              requestId: event.requestId,
              nodeId: event.nodeId,
              nodeName: this.nodeName(event.nodeId),
              question: event.question,
              payload: event.payload,
              resolve: response => send(event.requestId, response),
            },
          ]);
        }
        this.announceQuestion(event.requestId, this.nodeName(event.nodeId), event.question);
        break;

      case 'ask-resolved':
        if (!scoped) this.setNodeState(event.nodeId, 'done');
        // Remote monitors may still hold a synthetic pending card — clear it.
        this.pendingQuestions.update(list =>
          list.filter(item => item.requestId !== event.requestId),
        );
        this.dismissQuestionToast(event.requestId);
        this.terminal.setPhase(
          this.pendingApprovals().length > 0
            ? 'waiting-approval'
            : this.pendingQuestions().length > 0
              ? 'waiting-input'
              : 'running',
        );
        break;

      case 'subworkflow-started':
        if (!scoped) this.setNodeState(event.nodeId, 'thinking');
        this.console('run', 'info', `${event.nodeName}: running ${event.workflowName}.`);
        break;

      case 'subworkflow-completed':
        if (!scoped) this.setNodeState(event.nodeId, 'done');
        this.console('run', 'success', `${event.nodeName}: ${event.workflowName} completed.`);
        break;

      case 'subworkflow-failed':
        if (!scoped) this.setNodeState(event.nodeId, 'error');
        this.console('problems', 'error', `${event.nodeName}: ${event.workflowName} failed. ${event.error}`);
        break;

      case 'run-paused':
        this.terminal.setPhase('paused');
        this.console('run', 'warning', event.nodeId ? `Paused at breakpoint (${this.nodeName(event.nodeId)}).` : 'Paused.');
        break;

      case 'run-resumed':
        this.terminal.setPhase('running');
        this.console('run', 'info', 'Resumed.');
        break;

      case 'run-completed':
        this.telemetry.count(counterName('run.completed'));
        this.terminal.setPhase('completed');
        this.console('run', 'success', 'Run completed.');
        this.finishRun();
        break;

      case 'run-failed':
        // Category only. The error text stays local: `recordError` has no
        // parameter a message or a stack could travel in.
        this.telemetry.count(counterName('run.error'));
        this.telemetry.recordError('engine');
        this.terminal.setPhase('failed');
        this.console('problems', 'error', event.error);
        // Catch the exact moment a Phorma Cloud tenant hits an entitlement wall
        // and put the remedy on a toast, instead of making them dig through
        // Settings for whichever one applies. The code decides which
        // (requirement 19); a worker too old to send one falls back to the prose
        // this handler always matched (requirement 20). Other failures keep the
        // existing console/trace-only behaviour, with no generic toast.
        this.raiseBillingToast(event.error, event.code);
        this.finishRun();
        break;

      case 'run-stopped':
        this.terminal.setPhase('stopped');
        this.console('run', 'warning', 'Run stopped.');
        this.finishRun();
        break;
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Raises the billing toast a hosted refusal earns, if any.
   *
   * Only `run-failed` calls this, and that is deliberate. `node-failed` carries
   * the same code, but a propagating failure emits one `node-failed` per ancestor
   * frame, so a nested workflow that dies on an entitlement refusal would stack
   * a toast per frame for a single wall. The terminal event fires exactly once
   * per run, which is also the honest granularity: the remedy is for the run, not
   * for a node.
   *
   * A remedy with no label (an internal fault the user cannot buy their way out
   * of) still shows its notice, just without a button.
   */
  private raiseBillingToast(error: string, code?: string): void {
    const remedy = remedyForRunFailure(error, code);
    const notice = refusalNotice(remedy);
    if (!notice) return;
    this.toast.error(
      notice.summary,
      notice.detail,
      notice.label === null
        ? undefined
        : { label: notice.label, onClick: () => this.billingCta.run(remedy) },
    );
  }

  /** Streaming console buffers: one console line per node per flush. */
  private readonly streamBuffers = new Map<string, string>();

  private appendStreaming(nodeId: string, token: string): void {
    const buffer = (this.streamBuffers.get(nodeId) ?? '') + token;
    // Flush on newlines so the Agents channel reads as it streams.
    const lines = buffer.split('\n');
    const remainder = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) this.console('agents', 'info', `${this.nodeName(nodeId)}: ${line}`);
    }
    this.streamBuffers.set(nodeId, remainder);
  }

  private flushStreaming(nodeId: string): void {
    const remainder = this.streamBuffers.get(nodeId);
    if (remainder?.trim()) {
      this.console('agents', 'info', `${this.nodeName(nodeId)}: ${remainder}`);
    }
    this.streamBuffers.delete(nodeId);
  }

  /** Appends a reasoning/thinking token to the node's thinking buffer. */
  private appendThinking(nodeId: string, token: string): void {
    this.nodeThinking.update(current => {
      const next = new Map(current);
      const entry = next.get(nodeId) ?? { text: '', streaming: false };
      next.set(nodeId, { text: entry.text + token, streaming: true });
      return next;
    });
  }

  /** Marks a node's thinking stream as finished (keeps the text for review). */
  private finishThinking(nodeId: string): void {
    this.nodeThinking.update(current => {
      const entry = current.get(nodeId);
      if (!entry) return current;
      const next = new Map(current);
      next.set(nodeId, { text: entry.text, streaming: false });
      return next;
    });
  }

  /** Drops a single node's thinking text (called when the node is removed). */
  clearThinking(nodeId: string): void {
    this.nodeThinking.update(current => {
      if (!current.has(nodeId)) return current;
      const next = new Map(current);
      next.delete(nodeId);
      return next;
    });
  }

  private setNodeState(nodeId: string, state: RunNodeState): void {
    this.nodeStates.update(current => {
      const next = new Map(current);
      next.set(nodeId, state);
      return next;
    });
  }

  private pulseEdge(connectionId: string): void {
    this.activeEdges.update(current => {
      const next = new Set(current);
      next.add(connectionId);
      return next;
    });
    const existing = this.edgeTimers.get(connectionId);
    if (existing) clearTimeout(existing);
    this.edgeTimers.set(
      connectionId,
      setTimeout(() => {
        this.activeEdges.update(current => {
          const next = new Set(current);
          next.delete(connectionId);
          return next;
        });
        this.edgeTimers.delete(connectionId);
      }, EDGE_PULSE_MS),
    );
  }

  private pushTrace(
    icon: string,
    label: string,
    detail: string | undefined,
    tone: TraceEntry['tone'],
    kind: TraceEntry['kind'] = 'event',
    scope?: RunEvent['scope'],
  ): void {
    this.traceCounter += 1;
    this.trace.update(entries => {
      const next = [
        ...entries,
        { id: this.traceCounter, at: Date.now(), icon, label, detail, tone, kind, scope },
      ];
      return next.length > MAX_TRACE_ENTRIES ? next.slice(next.length - MAX_TRACE_ENTRIES) : next;
    });
  }

  private console(
    channel: 'run' | 'agents' | 'tools' | 'problems',
    level: 'info' | 'success' | 'warning' | 'error',
    message: string,
  ): void {
    this.terminal.append(channel, level, message);
  }

  private nodeName(nodeId: string): string {
    return this.workflow.graph().nodes.find(node => node.id === nodeId)?.name ?? nodeId;
  }

  /** Finds the tool-link connection between an agent and a tool node. */
  private toolLinkConnection(agentNodeId: string, toolNodeId: string): string | null {
    if (!toolNodeId) return null;
    const graph = this.workflow.graph();
    const agent = graph.nodes.find(node => node.id === agentNodeId);
    const tool = graph.nodes.find(node => node.id === toolNodeId);
    if (!agent || !tool) return null;
    const agentPorts = new Set(agent.ports.map(port => port.id));
    const toolPorts = new Set(tool.ports.map(port => port.id));
    return (
      graph.connections.find(
        conn =>
          conn.kind === 'tool-link' &&
          agentPorts.has(portBaseId(conn.outputId)) &&
          toolPorts.has(portBaseId(conn.inputId)),
      )?.id ?? null
    );
  }

  // ── Workflow-level notifications (P1-10) ────────────────────────────────────

  /**
   * Watches the run's own event stream and delivers the workflow
   * notification policy (Requirements 13.7, 13.10).
   *
   * Deliberately HOST behaviour, not engine behaviour: the run controller
   * already sees every event, so a policy needs no node on the canvas. A
   * policy that does not name the trigger for this event issues no outbound
   * request at all. Fire-and-forget: the run's outcome is reported whether
   * or not the delivery lands.
   */
  private notifyOnRunEvent(
    event: RunEvent,
    workflowId: string,
    workflowName: string,
    policy: WorkflowNotificationPolicy | undefined,
    redactor: Redactor,
  ): void {
    const trigger = notificationTriggerFor(event);
    if (trigger === undefined) return;
    // Requirement 13.10: no policy, or a policy that does not subscribe to
    // this trigger, means no notification and no request.
    if (!notificationWanted(policy, trigger)) return;

    void this.deliverWorkflowNotification(trigger, event, policy, workflowId, workflowName, redactor).catch(
      () => undefined,
    );
  }

  /**
   * One notification, at most {@link NOTIFY_MAX_ATTEMPTS} attempts, through
   * the same `DataFetcher` the data nodes use — so the egress guard, the
   * response cap and the per-attempt timeout are identical (Requirements
   * 13.7, 18.5).
   *
   * The body carries run metadata and a redacted reason only: never a node
   * output, never a resolved secret.
   */
  private async deliverWorkflowNotification(
    trigger: NotifyTrigger,
    event: RunEvent,
    policy: WorkflowNotificationPolicy,
    workflowId: string,
    workflowName: string,
    redactor: Redactor,
  ): Promise<void> {
    const connectionId = policy.connectionId?.trim();
    let conn: ResolvedConnection | undefined;
    if (connectionId) {
      try {
        conn = await this.connectionStore.forWorkflow(workflowId).resolve(connectionId);
      } catch (error) {
        // An unresolvable connection means no delivery, never a partial one.
        this.console(
          'problems',
          'warning',
          `Workflow notification for "${trigger}" was not delivered: ${redactor.scrub(messageOf(error))}`,
        );
        return;
      }
      // Requirement 15.2: registered before anything is emitted or persisted
      // about this delivery.
      redactor.addLiterals(Object.values(conn.secrets));
    }

    const to = (policy.to ?? '').trim();
    const endpoint = notificationEndpoint(to, conn);
    if (!endpoint) {
      this.console(
        'problems',
        'warning',
        `Workflow notification for "${trigger}" has no delivery target: set the notification recipient ` +
          `to an https URL, or give the connection a notifyUrl or baseUrl.`,
      );
      return;
    }

    const body = JSON.stringify({
      trigger,
      runId: 'runId' in event ? event.runId : null,
      workflowId: workflowId || null,
      workflowName,
      environment: 'local',
      // Recipient only when the endpoint is the provider, not the recipient.
      to: to === endpoint ? undefined : to || undefined,
      detail: redactor.scrub(notificationDetail(event)).slice(0, NOTIFY_DETAIL_CHARS),
      at: Date.now(),
    });

    // Auth last, exactly as the engine's request builder orders it, so the
    // connection always wins over the message's own headers.
    const request: DataRequest = applyConnectionAuth(
      {
        url: endpoint,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        timeoutMs: NOTIFY_TIMEOUT_MS,
        maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
      },
      conn,
    );

    let detail = 'no attempt was made';
    for (let attempt = 1; attempt <= NOTIFY_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.dataFetch.fetch(request);
        if (response.status >= 200 && response.status <= 299) return;
        detail = `HTTP ${response.status}`;
      } catch (error) {
        // A transport message can echo the target's own text, so it is
        // scrubbed before it can reach a console line.
        detail = redactor.scrub(messageOf(error));
      }
      if (attempt < NOTIFY_MAX_ATTEMPTS) {
        await new Promise<void>(resolve => setTimeout(resolve, 250 * attempt));
      }
    }
    this.console(
      'problems',
      'warning',
      `Workflow notification for "${trigger}" failed after ${NOTIFY_MAX_ATTEMPTS} attempts (${detail}).`,
    );
  }

  private resetRunState(): void {
    this.trace.set([]);
    this.nodeStates.set(new Map());
    this.activeEdges.set(new Set());
    this.pendingApprovals.set([]);
    this.pendingWaits.set([]);
    this.clearQuestions();
    this.streamedChars.set(0);
    this.streamBuffers.clear();
    this.nodeThinking.set(new Map());
    for (const timer of this.edgeTimers.values()) clearTimeout(timer);
    this.edgeTimers.clear();
    this.terminal.clearAll();
  }

  /** Clears transient glow state a beat after the run ends (rings persist). */
  private finishRun(): void {
    this.agentStream.clearAll();
    for (const approval of this.pendingApprovals()) approval.resolve(false);
    this.pendingApprovals.set([]);
    for (const wait of this.pendingWaits()) wait.resolve('');
    this.pendingWaits.set([]);
    for (const question of this.pendingQuestions()) question.resolve('');
    this.clearQuestions();
    // If the run spent Phorma Cloud credits, pull a fresh quota so the account
    // chip / Settings bar reflect the new balance without waiting for the next
    // dialog open. Backend metering settles via waitUntil, so a short delay
    // lets the D1 ledger write land before we re-read /api/me.
    if (this.runUsage().phormaCloud) {
      setTimeout(() => void this.phormaCloud.refresh(), 1500);
    }
  }
}
