import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { CurrencyPipe, DatePipe, DecimalPipe, NgTemplateOutlet } from '@angular/common';

import type { RunRecord, RunRecordSummary } from '@phorma/engine';

import { CloudService } from '../../../core/cloud.service';
import { PhormaCloudService } from '../../../core/phorma-cloud.service';
import { RunControllerService, TraceEntry } from '../../../core/run-controller.service';
import { RunHistoryService } from '../../../core/run-history.service';
import { traceFromRunLog } from '../../../core/run-trace';
import { TerminalOutputService } from '../../../core/terminal-output.service';
import { WorkflowService } from '../../../core/workflow.service';
import type { WorkflowGraph } from '../../../core/workflow.model';
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
}

/**
 * Folds consecutive tool-activity entries into collapsible containers.
 * Shared by the live trace and the run-history detail view.
 */
function foldTraceGroups(entries: TraceEntry[]): TraceGroup[] {
  const groups: TraceGroup[] = [];
  let bucket: TraceEntry[] | null = null;
  for (const entry of entries) {
    if (entry.kind === 'tool-call' || entry.kind === 'tool-result') {
      if (!bucket) {
        bucket = [];
        groups.push({ key: `g${entry.id}`, grouped: true, entries: bucket });
      }
      bucket.push(entry);
    } else {
      bucket = null;
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
  }

  /** Trace entry ids the user has expanded. */
  protected readonly expanded = signal<ReadonlySet<number>>(new Set());

  /** Group keys the user has collapsed (groups start expanded). */
  protected readonly collapsedGroups = signal<ReadonlySet<string>>(new Set());

  /** Trace entry id whose payload was just copied (drives the green tick). */
  protected readonly copiedId = signal<number | null>(null);
  private copyTimer?: ReturnType<typeof setTimeout>;

  /** Draft event payloads per suspended wait node (manual injection). */
  protected readonly waitDrafts = signal<Record<string, string>>({});

  /** Cumulative run usage (tokens + cost when the provider reports it). */
  protected readonly usage = this.runController.runUsage;

  /**
   * The run's cost expressed in abstract usage credits, shown only for runs
   * that used Phorma Cloud (BYO runs keep the raw USD figure). Uses the
   * tenant tier's burn rate; null when the run wasn't on Phorma Cloud or had
   * no reported cost.
   */
  protected readonly usageCredits = computed(() => {
    const u = this.usage();
    if (!u.phormaCloud || u.costUsd <= 0) return null;
    return Math.max(0, Math.round(u.costUsd * this.phormaCloud.creditsPerUsd()));
  });

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
    const entries = traceFromRunLog(record.events, id => names.get(id) ?? id)
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
      default:
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
    const calls = group.entries.filter(entry => entry.kind === 'tool-call').length;
    return calls || group.entries.length;
  }

  protected onInput(event: Event): void {
    this.runController.runInput.set((event.target as HTMLTextAreaElement | null)?.value ?? '');
  }

  /** Run — local engine, or the deployed instance while cloud-connected. */
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
