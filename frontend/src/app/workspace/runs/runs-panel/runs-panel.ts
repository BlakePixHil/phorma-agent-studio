import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChildren,
} from '@angular/core';
import { CurrencyPipe, DatePipe, DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

import type { RunRecord, RunRecordSummary, RunRecordUsage } from '@phorma/engine';

import { CloudService } from '../../../core/cloud.service';
import { PhormaCloudService } from '../../../core/phorma-cloud.service';
import { RunControllerService, TraceEntry } from '../../../core/run-controller.service';
import { RunHistoryService } from '../../../core/run-history.service';
import { traceFromRunLog } from '../../../core/run-trace';
import { TerminalOutputService } from '../../../core/terminal-output.service';
import { WorkflowService } from '../../../core/workflow.service';
import type { EmbeddedWorkflow, WorkflowGraph } from '../../../core/workflow.model';
import { ButtonModule } from 'primeng/button';
import { Textarea } from 'primeng/textarea';

/**
 * A run of consecutive tool-activity entries, folded into a single collapsible
 * container. A `grouped` run holds > 1 tool entry; anything else (a lone tool
 * call or a non-tool event) is rendered inline as a single entry.
 */
export interface TraceGroup {
  /** Stable key for @for tracking. */
  key: string;
  /** True when this run should render as a collapsible container. */
  grouped: boolean;
  entries: TraceEntry[];
  /** Group header content. */
  title?: string;
  icon?: string;
  noun?: string;
}

/**
 * Folds consecutive tool-activity entries into collapsible containers.
 * Shared by the live trace and the run-history detail view.
 */
function foldTraceGroups(entries: TraceEntry[]): TraceGroup[] {
  const groups: TraceGroup[] = [];
  let bucket: TraceEntry[] | null = null;
  let scopeKey: string | null = null;
  for (const entry of entries) {
    const frame = entry.scope?.[0];
    const nextScopeKey = frame ? `${frame.nodeId}:${frame.workflowId}` : null;
    if (frame) {
      if (!bucket || scopeKey !== nextScopeKey) {
        bucket = [];
        scopeKey = nextScopeKey;
        groups.push({
          key: `s${entry.id}`,
          grouped: true,
          entries: bucket,
          title: frame.workflowName,
          icon: 'ti ti-stack-2',
          noun: 'event',
        });
      }
      bucket.push(entry);
    } else if (entry.kind === 'tool-call' || entry.kind === 'tool-result') {
      if (!bucket || scopeKey !== null) {
        bucket = [];
        groups.push({ key: `g${entry.id}`, grouped: true, entries: bucket, title: 'Tool activity', icon: 'ti ti-tool', noun: 'call' });
      }
      scopeKey = null;
      bucket.push(entry);
    } else {
      bucket = null;
      scopeKey = null;
      groups.push({ key: `e${entry.id}`, grouped: false, entries: [entry] });
    }
  }
  return groups;
}

/** A history row: the summary plus where its full record lives. */
interface HistoryRow {
  summary: RunRecordSummary;
  live: boolean;
}

/**
 * The Runs panel (right side): task input, run controls, pending approvals,
 * and the trace timeline — every RunEvent as a scannable, expandable entry.
 *
 * When the cloud monitor is connected, Run/Stop target the DEPLOYED instance
 * and its events animate the canvas through the same pipeline.
 */
@Component({
  selector: 'app-runs-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, DatePipe, DecimalPipe, NgTemplateOutlet, ButtonModule, Textarea],
  templateUrl: './runs-panel.html',
  styleUrl: './runs-panel.scss',
})
export class RunsPanel {
  protected readonly runController = inject(RunControllerService);
  private readonly domSanitizer = inject(DomSanitizer);
  protected readonly terminal = inject(TerminalOutputService);
  protected readonly cloud = inject(CloudService);
  private readonly phormaCloud = inject(PhormaCloudService);
  private readonly runHistory = inject(RunHistoryService);
  private readonly workflow = inject(WorkflowService);

  constructor() {
    // Reload history whenever the active workflow changes (and initially).
    effect(() => {
      this.workflow.activeDoc();
      void this.refreshHistory();
    });

    // The "Answer" toast action asks this panel to take focus for one
    // question; consume the request so it fires exactly once.
    effect(() => {
      const requestId = this.runController.focusQuestionId();
      if (!requestId) return;
      const box = this.answerBoxes().find(
        ref => ref.nativeElement.dataset['requestId'] === requestId,
      );
      if (!box) return;
      box.nativeElement.focus();
      this.runController.focusQuestionId.set(null);
    });

    // A notification deep link asks this panel to open one run. Consumed once the
    // row exists - a cloud run arrives with `refreshHistory`, so the request has to
    // survive until the list lands rather than being dropped on the first miss.
    effect(() => {
      const runId = this.runController.focusRunId();
      if (!runId) return;
      const row = this.historyRows().find(candidate => candidate.summary.id === runId);
      if (!row) return;
      // `untracked` because `openRun` reads and writes signals this effect would
      // otherwise re-enter: the effect hazard that has already OOM'd the renderer
      // in the settings dialog, the properties panel and the command palette.
      untracked(() => {
        this.runController.focusRunId.set(null);
        void this.openRun(row);
      });
    });
  }

  /** Trace entry ids the user has expanded. */
  protected readonly expanded = signal<ReadonlySet<number>>(new Set());

  /** Group keys the user has collapsed (groups start expanded). */
  protected readonly collapsedGroups = signal<ReadonlySet<string>>(new Set());

  /** Whether the run-history section is collapsed (starts expanded). */
  protected readonly historyCollapsed = signal(false);

  /** Trace entry id whose payload was just copied (drives the green tick). */
  protected readonly copiedId = signal<number | null>(null);
  private copyTimer?: ReturnType<typeof setTimeout>;

  /** Draft event payloads per suspended wait node (manual injection). */
  protected readonly waitDrafts = signal<Record<string, string>>({});

  /** Answer boxes for pending Ask-User cards, keyed by request id. */
  private readonly answerBoxes = viewChildren<ElementRef<HTMLTextAreaElement>>('answerBox');

  /** Cumulative run usage (tokens + cost when the provider reports it). */
  protected readonly usage = this.runController.runUsage;

  /**
   * The Phorma Cloud share of the run's cost expressed in plan credits.
   * Cloud-billed usage is NEVER shown in dollars — subscribers buy credits,
   * not inference at cost. Null when no round ran on Phorma Cloud.
   */
  protected readonly usageCredits = computed(() => {
    const u = this.usage();
    if (!u.phormaCloud || u.phormaCloudCostUsd <= 0) return null;
    return Math.max(1, Math.round(u.phormaCloudCostUsd * this.phormaCloud.creditsPerUsd()));
  });

  /** The BYO-key share of the run's cost in USD (0 when fully cloud-billed). */
  protected readonly usageByoUsd = computed(() => {
    const u = this.usage();
    return u.costUsd - u.phormaCloudCostUsd;
  });

  /**
   * Splits a persisted usage total for display: the Phorma Cloud share as
   * plan credits (never USD), the BYO share as USD. Backward compatible with
   * pre-EPIC-2 records that lack the split — their cost shows as USD, which
   * is correct for BYO and the best available fallback for old cloud runs.
   */
  protected costParts(usage: RunRecordUsage): { credits: number | null; usd: number | null; estimated: boolean } {
    const cloudShare = usage.phormaCloudCostUsd ?? 0;
    const byoShare = usage.costUsd - cloudShare;
    return {
      credits: cloudShare > 0 ? Math.max(1, Math.round(cloudShare * this.phormaCloud.creditsPerUsd())) : null,
      usd: byoShare > 0 ? byoShare : null,
      estimated: usage.estimated ?? false,
    };
  }

  /**
   * The trace, with consecutive tool-activity entries folded into containers.
   * A run of two or more tool entries becomes one collapsible group; single
   * tool entries and every non-tool event render inline.
   */
  protected readonly traceGroups = computed<TraceGroup[]>(() =>
    foldTraceGroups(this.runController.trace()),
  );

  // ── Run history (EPIC 1) ───────────────────────────────────────────────

  /** Cloud run summaries for the active (deployed) workflow. */
  private readonly cloudRuns = signal<RunRecordSummary[]>([]);
  /** The DO's in-flight run id, when one is executing right now. */
  protected readonly cloudActiveRunId = signal<string | null>(null);
  protected readonly historyLoading = signal(false);
  /** The opened run's full record (detail view), or null for the list. */
  protected readonly selectedRun = signal<RunRecord | null>(null);

  /** Local + cloud summaries for the active workflow, newest first. */
  protected readonly historyRows = computed<HistoryRow[]>(() => {
    const doc = this.workflow.activeDoc();
    const workflowId = doc?.workflowId ?? null;
    const activeCloudRun = this.cloudActiveRunId();
    const local = this.runHistory
      .localRuns()
      .filter(record => record.summary.workflowId === workflowId)
      .map(record => ({ summary: record.summary, live: false }));
    const cloud = this.cloudRuns().map(summary => ({
      summary,
      live: summary.id === activeCloudRun,
    }));
    return [...local, ...cloud].sort((a, b) => b.summary.startedAt - a.summary.startedAt);
  });

  /** The detail view's timeline, rebuilt from the persisted event log. */
  protected readonly selectedTraceGroups = computed<TraceGroup[]>(() => {
    const record = this.selectedRun();
    if (!record) return [];
    const names = new Map(record.graph.nodes.map(node => [node.id, node.name]));
    const entries = traceFromRunLog(record.events, id => names.get(id) ?? id, {
      formatCost: this.runController.formatTraceCost,
    })
      // Negative ids keep detail expansion state disjoint from the live trace.
      .map(entry => ({ ...entry, id: -entry.id }));
    return foldTraceGroups(entries);
  });

  protected async refreshHistory(): Promise<void> {
    this.historyLoading.set(true);
    try {
      await this.runHistory.refresh();
      const workflowId = this.workflow.activeDoc()?.workflowId;
      if (workflowId && this.cloud.configured()) {
        const result = await this.cloud.listRuns(workflowId);
        this.cloudRuns.set(result?.runs ?? []);
        this.cloudActiveRunId.set(result?.activeRunId ?? null);
      } else {
        this.cloudRuns.set([]);
        this.cloudActiveRunId.set(null);
      }
    } finally {
      this.historyLoading.set(false);
    }
  }

  /** Opens a run's detail view (fetches the full record). */
  protected async openRun(row: HistoryRow): Promise<void> {
    if (row.live) {
      // In-flight cloud run: attach the monitor instead — the DO replays the
      // run's events into the live trace and the canvas animates from there.
      await this.attachLive(row);
      return;
    }
    const record =
      row.summary.environment === 'local'
        ? await this.runHistory.getRun(row.summary.id)
        : await this.cloud.fetchRunRecord(row.summary.workflowId ?? '', row.summary.id);
    if (record) this.selectedRun.set(record);
  }

  protected closeRunDetail(): void {
    this.selectedRun.set(null);
  }

  /** Attaches the cloud monitor to the in-flight run ("open live run"). */
  protected async attachLive(row: HistoryRow): Promise<void> {
    await this.cloud.connect(row.summary.workflowId ?? undefined);
  }

  /** Loads the run's graph snapshot + final state onto the canvas. */
  protected bringToCanvas(record: RunRecord): void {
    const startedAt = new Date(record.summary.startedAt);
    // Run graphs originate from the studio, so the loose engine typing
    // (`kind: string`) narrows safely back to the studio's structural model
    // — same pattern as `.phorma.json` import in TauriService.
    this.workflow.openRunSnapshot(
      record.graph as WorkflowGraph,
      `${record.summary.workflowName} — run ${startedAt.toLocaleTimeString()}`,
      record.subWorkflows as unknown as Record<string, EmbeddedWorkflow> | undefined,
    );
    this.runController.loadHistoricalRun(record);
    this.selectedRun.set(null);
  }

  protected async deleteRun(row: HistoryRow, event: Event): Promise<void> {
    event.stopPropagation();
    if (row.summary.environment !== 'local') return;
    await this.runHistory.deleteRun(row.summary.id);
  }

  protected statusIcon(summary: RunRecordSummary): string {
    switch (summary.status) {
      case 'completed':
        return 'ti ti-circle-check';
      case 'failed':
        return 'ti ti-circle-x';
      case 'stopped':
        return 'ti ti-player-stop';
      case 'skipped':
        return 'ti ti-circle-minus';
      case 'running':
        return 'ti ti-loader-2';
    }
  }

  protected sourceIcon(summary: RunRecordSummary): string {
    switch (summary.source) {
      case 'schedule':
        return 'ti ti-clock';
      case 'webhook':
        return 'ti ti-webhook';
      case 'resume':
        return 'ti ti-refresh';
      case 'eval':
        return 'ti ti-flask';
      case 'portal':
        return 'ti ti-world-share';
      default:
        return 'ti ti-hand-click';
    }
  }

  protected duration(summary: RunRecordSummary): string | null {
    if (!summary.endedAt) return null;
    const seconds = (summary.endedAt - summary.startedAt) / 1000;
    if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  }

  /**
   * Logical tool-call count for a group's header. A call and its result are
   * two entries but one step, so we count the calls (this lines up with the
   * "max tool calls" setting). Falls back to entry count if calls are absent.
   */
  protected groupStepCount(group: TraceGroup): number {
    if (group.noun === 'event') return group.entries.length;
    const calls = group.entries.filter(entry => entry.kind === 'tool-call').length;
    return calls || group.entries.length;
  }

  protected groupCountLabel(group: TraceGroup): string {
    const count = this.groupStepCount(group);
    const noun = group.noun ?? 'call';
    return `${count} ${count === 1 ? noun : `${noun}s`}`;
  }

  protected onInput(event: Event): void {
    this.runController.runInput.set((event.target as HTMLTextAreaElement | null)?.value ?? '');
  }

  /**
   * Run — local engine, or the deployed instance while cloud-connected.
   *
   * A Cloud_Library member needs no branch here: `start()` routes to the deployed
   * launcher the shell installed, so this button, the toolbar, F5 and the
   * assistant's `run_start` action all reach the deployed instance rather than
   * three of them starting a local run of a read-only spec.
   */
  protected run(): void {
    if (this.cloud.connected()) {
      this.cloud.triggerRemote(this.runController.runInput().trim());
      return;
    }
    this.runController.start();
  }

  protected stop(): void {
    if (this.cloud.connected()) {
      this.cloud.stopRemote();
      return;
    }
    this.runController.stop();
  }

  protected waitDraft(nodeId: string): string {
    return this.waitDrafts()[nodeId] || '';
  }

  protected onWaitDraft(nodeId: string, event: Event): void {
    const value = (event.target as HTMLTextAreaElement | null)?.value ?? '';
    this.waitDrafts.update(drafts => ({ ...drafts, [nodeId]: value }));
  }

  /** Manually delivers an external event to a suspended Wait-for-Event node. */
  protected injectEvent(nodeId: string): void {
    const payload = this.waitDrafts()[nodeId] ?? '';
    this.waitDrafts.update(drafts => {
      const next = { ...drafts };
      delete next[nodeId];
      return next;
    });
    this.runController.resolveWait(nodeId, payload.trim());
  }

  protected questionDraft(requestId: string): string {
    return this.runController.questionDrafts()[requestId] || '';
  }

  /** Sanitized markdown rendering for a pending Ask-User question. */
  protected renderMarkdown(text: string): SafeHtml {
    const raw = marked.parse(text, { async: false });
    return this.domSanitizer.bypassSecurityTrustHtml(DOMPurify.sanitize(raw));
  }

  protected onQuestionDraft(requestId: string, event: Event): void {
    const value = (event.target as HTMLTextAreaElement | null)?.value ?? '';
    this.runController.setQuestionDraft(requestId, value);
  }

  /** Submits the typed answer to a suspended Ask-User node. */
  protected submitAnswer(requestId: string): void {
    const response = this.questionDraft(requestId).trim();
    if (!response) return;
    this.runController.resolveQuestion(requestId, response);
  }

  protected toggleExpanded(id: number): void {
    this.expanded.update(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  protected isGroupCollapsed(key: string): boolean {
    return this.collapsedGroups().has(key);
  }

  protected toggleGroup(key: string): void {
    this.collapsedGroups.update(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** Toggles the run-history section collapse. */
  protected toggleHistory(): void {
    this.historyCollapsed.update(v => !v);
  }

  /** Copy an entry's payload to the clipboard and flash the green tick. */
  protected async copyDetail(entry: TraceEntry, event: Event): Promise<void> {
    event.stopPropagation();
    if (!entry.detail) return;

    try {
      await navigator.clipboard.writeText(entry.detail);
    } catch {
      // Fallback for insecure contexts where the async clipboard is blocked.
      const textarea = document.createElement('textarea');
      textarea.value = entry.detail;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
      } finally {
        document.body.removeChild(textarea);
      }
    }

    this.copiedId.set(entry.id);
    clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => this.copiedId.set(null), 1500);
  }
}
