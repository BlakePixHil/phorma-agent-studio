import { Injectable, computed, inject, signal } from '@angular/core';

import type { RunUsageBucket, UsageLedgerEntry } from '@phorma/engine';

import { CloudService } from './cloud.service';
import { IndexedDbStorageService } from './indexed-db-storage.service';
import { PhormaCloudService } from './phorma-cloud.service';
import { WorkflowService } from './workflow.service';

/** Analytics period presets (days back from now; 0 = current month). */
export type UsagePeriod = '7d' | '30d' | '90d' | 'month';

/** One aggregated model row for the breakdown table. */
export interface ModelUsageRow {
  provider: string;
  model: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  /** BYO share in USD (null when the row is fully cloud-billed). */
  usd: number | null;
  /** Phorma Cloud share in plan credits (null when fully BYO). */
  credits: number | null;
  estimated: boolean;
}

/** One aggregated workflow row. */
export interface WorkflowUsageRow {
  workflowId: string | null;
  workflowName: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
  credits: number | null;
  estimated: boolean;
}

/** One time bucket (day) for the cost-over-time chart. */
export interface DailyUsagePoint {
  /** Day key, YYYY-MM-DD (local time). */
  day: string;
  usd: number;
  credits: number;
  runs: number;
}

/** Grand totals for the selected scope + period. */
export interface UsageTotals {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  /** BYO USD total (never includes the cloud-billed share). */
  usd: number;
  /** Phorma Cloud plan credits total. */
  credits: number;
  estimated: boolean;
}

function periodStart(period: UsagePeriod, now = new Date()): number {
  switch (period) {
    case '7d':
      return now.getTime() - 7 * 86_400_000;
    case '30d':
      return now.getTime() - 30 * 86_400_000;
    case '90d':
      return now.getTime() - 90 * 86_400_000;
    case 'month':
      return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  }
}

function dayKey(at: number): string {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Usage analytics (EPIC 2) — merges the LOCAL usage ledger (IndexedDB) with
 * every deployed workflow's CLOUD ledger (`GET /usage` on its Durable
 * Object) and aggregates per workflow, per model, and per day.
 *
 * Display rule: the Phorma Cloud-billed share of any cost is expressed in
 * plan CREDITS (subscribers buy credits, not inference at cost); only the
 * BYO-key share is expressed in USD, labeled "(est.)" when it came from the
 * pricing table rather than provider accounting.
 */
@Injectable({ providedIn: 'root' })
export class UsageAnalyticsService {
  private readonly storage = inject(IndexedDbStorageService);
  private readonly cloud = inject(CloudService);
  private readonly workflow = inject(WorkflowService);
  private readonly phormaCloud = inject(PhormaCloudService);

  /** Analytics window. */
  readonly period = signal<UsagePeriod>('30d');
  /** Scope: a workflowId, 'draft' for unsaved runs, or null = everything. */
  readonly scope = signal<string | null>(null);
  readonly loading = signal(false);

  private readonly localEntries = signal<UsageLedgerEntry[]>([]);
  private readonly cloudEntries = signal<UsageLedgerEntry[]>([]);

  /** All ledger rows in the period (deduped by runId; cloud wins). */
  readonly entries = computed<UsageLedgerEntry[]>(() =>
    this.entriesIn(periodStart(this.period()), this.scope()),
  );

  /** Grand totals for the current scope + period. */
  readonly totals = computed<UsageTotals>(() => this.totalsOf(this.entries()));

  /** Account-level totals over a fixed 30-day window (Settings → Usage). */
  readonly accountTotals = computed<UsageTotals>(() =>
    this.totalsOf(this.entriesIn(periodStart('30d'), null)),
  );

  /** Account-level per-workflow rows over a fixed 30-day window. */
  readonly accountByWorkflow = computed<WorkflowUsageRow[]>(() =>
    this.workflowRowsOf(this.entriesIn(periodStart('30d'), null)),
  );

  /** Per-day cost/run buckets, oldest first (chart-ready). */
  readonly daily = computed<DailyUsagePoint[]>(() => {
    const rate = this.phormaCloud.creditsPerUsd();
    const byDay = new Map<string, DailyUsagePoint>();
    for (const entry of this.entries()) {
      const key = dayKey(entry.startedAt);
      const point = byDay.get(key) ?? { day: key, usd: 0, credits: 0, runs: 0 };
      const cloudShare = entry.usage.phormaCloudCostUsd ?? 0;
      point.usd += entry.usage.costUsd - cloudShare;
      point.credits += cloudShare * rate;
      point.runs += 1;
      byDay.set(key, point);
    }
    return [...byDay.values()]
      .map(point => ({ ...point, credits: Math.round(point.credits) }))
      .sort((a, b) => a.day.localeCompare(b.day));
  });

  /** Per-model breakdown, most expensive first. */
  readonly byModel = computed<ModelUsageRow[]>(() => {
    const rate = this.phormaCloud.creditsPerUsd();
    const rows = new Map<string, ModelUsageRow & { rank: number }>();
    for (const entry of this.entries()) {
      const buckets = entry.usage.byModel;
      if (buckets && Object.keys(buckets).length > 0) {
        for (const bucket of Object.values(buckets)) this.foldModel(rows, bucket, rate);
      } else {
        // Pre-EPIC-2 rows have no per-model rollup — bucket as "unknown".
        this.foldModel(
          rows,
          {
            provider: (entry.usage.phormaCloudCostUsd ?? 0) > 0 ? 'phorma-cloud' : 'unknown',
            model: 'unknown',
            inputTokens: entry.usage.inputTokens,
            outputTokens: entry.usage.outputTokens,
            costUsd: entry.usage.costUsd,
            estimated: entry.usage.estimated ?? false,
          },
          rate,
        );
      }
    }
    return [...rows.values()]
      .sort((a, b) => b.rank - a.rank)
      .map(({ rank: _rank, ...row }) => ({
        ...row,
        credits: row.credits === null ? null : Math.round(row.credits),
      }));
  });

  /** Per-workflow breakdown, most expensive first. */
  readonly byWorkflow = computed<WorkflowUsageRow[]>(() => this.workflowRowsOf(this.entries()));

  /** Filters + dedupes the merged ledgers for a window and scope. */
  private entriesIn(since: number, scope: string | null): UsageLedgerEntry[] {
    const byRun = new Map<string, UsageLedgerEntry>();
    for (const entry of this.localEntries()) {
      if (entry.startedAt >= since) byRun.set(entry.runId, entry);
    }
    for (const entry of this.cloudEntries()) {
      if (entry.startedAt >= since) byRun.set(entry.runId, entry);
    }
    const rows = [...byRun.values()].filter(
      entry => scope === null || (entry.workflowId ?? 'draft') === scope,
    );
    return rows.sort((a, b) => b.startedAt - a.startedAt);
  }

  private totalsOf(entries: UsageLedgerEntry[]): UsageTotals {
    const totals: UsageTotals = {
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
      credits: 0,
      estimated: false,
    };
    const rate = this.phormaCloud.creditsPerUsd();
    for (const entry of entries) {
      const usage = entry.usage;
      const cloudShare = usage.phormaCloudCostUsd ?? 0;
      totals.runs += 1;
      totals.inputTokens += usage.inputTokens;
      totals.outputTokens += usage.outputTokens;
      totals.usd += usage.costUsd - cloudShare;
      totals.credits += cloudShare * rate;
      totals.estimated ||= usage.estimated ?? false;
    }
    totals.credits = Math.round(totals.credits);
    return totals;
  }

  private workflowRowsOf(entries: UsageLedgerEntry[]): WorkflowUsageRow[] {
    const rate = this.phormaCloud.creditsPerUsd();
    const rows = new Map<string, WorkflowUsageRow & { rank: number }>();
    for (const entry of entries) {
      const key = entry.workflowId ?? 'draft';
      const row = rows.get(key) ?? {
        workflowId: entry.workflowId,
        workflowName: entry.workflowName,
        runs: 0,
        inputTokens: 0,
        outputTokens: 0,
        usd: null,
        credits: null,
        estimated: false,
        rank: 0,
      };
      const cloudShare = entry.usage.phormaCloudCostUsd ?? 0;
      const byoShare = entry.usage.costUsd - cloudShare;
      row.workflowName = entry.workflowName;
      row.runs += 1;
      row.inputTokens += entry.usage.inputTokens;
      row.outputTokens += entry.usage.outputTokens;
      if (byoShare > 0) row.usd = (row.usd ?? 0) + byoShare;
      // Accumulate credits UNROUNDED; rounding happens once in the final
      // projection so per-row and grand totals agree.
      if (cloudShare > 0) row.credits = (row.credits ?? 0) + cloudShare * rate;
      row.estimated ||= entry.usage.estimated ?? false;
      row.rank = (row.usd ?? 0) + ((row.credits ?? 0) / Math.max(rate, 1));
      rows.set(key, row);
    }
    return [...rows.values()]
      .sort((a, b) => b.rank - a.rank)
      .map(({ rank: _rank, ...row }) => ({
        ...row,
        credits: row.credits === null ? null : Math.round(row.credits),
      }));
  }

  /**
   * Refreshes both ledgers. The cloud side asks every library workflow's DO
   * (deploy state is per-workflow) — unpushed workflows 404 and merge empty.
   */
  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      const since = periodStart('90d');
      const local = await this.storage.listUsage(0).catch(() => [] as UsageLedgerEntry[]);
      this.localEntries.set(local);
      if (this.cloud.configured()) {
        const ids = this.workflow
          .library()
          .map(spec => spec.id)
          .filter((id): id is string => !!id);
        const results = await Promise.all(ids.map(id => this.cloud.fetchUsage(id, since)));
        this.cloudEntries.set(results.flatMap(rows => rows ?? []));
      } else {
        this.cloudEntries.set([]);
      }
    } finally {
      this.loading.set(false);
    }
  }

  private foldModel(
    rows: Map<string, ModelUsageRow & { rank: number }>,
    bucket: RunUsageBucket,
    rate: number,
  ): void {
    const key = `${bucket.provider}:${bucket.model}`;
    const row = rows.get(key) ?? {
      provider: bucket.provider,
      model: bucket.model || 'unknown',
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      usd: null,
      credits: null,
      estimated: false,
      rank: 0,
    };
    // One foldModel call per (entry, model) — byModel keys are unique per
    // run — so this correctly counts runs that touched the model.
    row.runs += 1;
    row.inputTokens += bucket.inputTokens;
    row.outputTokens += bucket.outputTokens;
    if (bucket.provider === 'phorma-cloud') {
      // Cloud-billed: credits only, never USD. Accumulate unrounded —
      // byModel rounds once in its final projection.
      row.credits = (row.credits ?? 0) + bucket.costUsd * rate;
    } else if (bucket.costUsd > 0) {
      row.usd = (row.usd ?? 0) + bucket.costUsd;
    }
    row.estimated ||= bucket.estimated;
    row.rank = (row.usd ?? 0) + ((row.credits ?? 0) / Math.max(rate, 1));
    rows.set(key, row);
  }
}
