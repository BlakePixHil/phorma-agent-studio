import { Injectable, computed, inject, signal, type WritableSignal } from '@angular/core';

import type { RunUsageBucket, UsageLedgerEntry } from '@phorma/engine';

import { CloudService } from './cloud.service';
import { IndexedDbStorageService } from './indexed-db-storage.service';
import { PhormaCloudService } from './phorma-cloud.service';
import { WorkflowService } from './workflow.service';

/** Analytics period presets (days back from now; 0 = current month). */
export type UsagePeriod = '7d' | '30d' | '90d' | '1y' | 'all' | 'month';

/** Trigger source of a run, as recorded on every ledger entry. */
export type UsageSource = UsageLedgerEntry['source'];
/** Terminal status of a run, as recorded on every ledger entry. */
export type UsageStatus = UsageLedgerEntry['status'];
/** Where a run executed. */
export type UsageEnvironment = UsageLedgerEntry['environment'];

/** One aggregated node row - from the per-run `usage.byNode` rollup. */
export interface NodeUsageRow {
  /** Scoped node key: `nodeId`, or `frameId/nodeId` inside a sub-workflow. */
  nodeKey: string;
  /** Bare node id (the part after the last `/`), for canvas selection. */
  nodeId: string;
  provider: string;
  model: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
  credits: number | null;
  estimated: boolean;
}

/** A generic "group by one ledger field" row (source / status / environment). */
export interface UsageGroupRow {
  key: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
  credits: number | null;
}

/** Per-day cost for one model - the per-model time series. */
export interface ModelDailyPoint {
  day: string;
  /** Cost in USD for BYO models, or credit-equivalent USD for cloud ones. */
  costUsd: number;
}

/** Duration statistics over the filtered ledger. */
export interface UsageDurations {
  /** Every settled run's wall-clock duration in milliseconds. */
  values: number[];
  p50: number;
  p95: number;
  mean: number;
}

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
    case '1y':
      return now.getTime() - 365 * 86_400_000;
    case 'all':
      // The ledger prunes at 366 days, so 0 really is "everything kept".
      return 0;
    case 'month':
      return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  }
}

/** Linear-interpolated percentile; 0 for an empty sample. */
function percentileOf(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const position = Math.min(Math.max(p, 0), 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
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

  /**
   * Facet filters, all "empty set = no filter". Every field they filter on is
   * recorded on each ledger entry already, so these cost nothing to collect.
   */
  readonly sources = signal<ReadonlySet<UsageSource>>(new Set());
  readonly statuses = signal<ReadonlySet<UsageStatus>>(new Set());
  readonly environments = signal<ReadonlySet<UsageEnvironment>>(new Set());

  /** Clears every facet filter (the scope and period are left alone). */
  clearFacets(): void {
    this.sources.set(new Set());
    this.statuses.set(new Set());
    this.environments.set(new Set());
  }

  /** Toggles one value of a facet filter. */
  toggleFacet(facet: 'sources' | 'statuses' | 'environments', value: string): void {
    const target = this[facet] as WritableSignal<ReadonlySet<string>>;
    target.update(current => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  /** True while any facet filter is narrowing the ledger. */
  readonly facetsActive = computed(
    () =>
      this.sources().size > 0 || this.statuses().size > 0 || this.environments().size > 0,
  );

  private readonly localEntries = signal<UsageLedgerEntry[]>([]);
  private readonly cloudEntries = signal<UsageLedgerEntry[]>([]);

  /**
   * All ledger rows in the period and scope, before facet filters. The
   * unfiltered set is what the facet chips count against, so toggling a chip
   * never hides the option that would let you undo it.
   */
  readonly scopedEntries = computed<UsageLedgerEntry[]>(() =>
    this.entriesIn(periodStart(this.period()), this.scope()),
  );

  /** All ledger rows in the period, scope AND facet filters. */
  readonly entries = computed<UsageLedgerEntry[]>(() => {
    const sources = this.sources();
    const statuses = this.statuses();
    const environments = this.environments();
    if (sources.size === 0 && statuses.size === 0 && environments.size === 0) {
      return this.scopedEntries();
    }
    return this.scopedEntries().filter(
      entry =>
        (sources.size === 0 || sources.has(entry.source)) &&
        (statuses.size === 0 || statuses.has(entry.status)) &&
        (environments.size === 0 || environments.has(entry.environment)),
    );
  });

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

  /**
   * Per-node breakdown from the `usage.byNode` rollup every recorder writes,
   * most expensive first. Keys are scope-aware (`frameId/nodeId` inside
   * sub-workflows) so a shared agent used in two places reports separately.
   */
  readonly byNode = computed<NodeUsageRow[]>(() => {
    const rate = this.phormaCloud.creditsPerUsd();
    const rows = new Map<string, NodeUsageRow & { rank: number }>();
    for (const entry of this.entries()) {
      const buckets = entry.usage.byNode;
      if (!buckets) continue;
      for (const [nodeKey, bucket] of Object.entries(buckets)) {
        const row = rows.get(nodeKey) ?? {
          nodeKey,
          nodeId: nodeKey.slice(nodeKey.lastIndexOf('/') + 1),
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
        // The newest run wins the model label: nodes get re-pointed over time
        // and the current model is the useful one to show.
        row.provider = bucket.provider;
        row.model = bucket.model || row.model;
        row.runs += 1;
        row.inputTokens += bucket.inputTokens;
        row.outputTokens += bucket.outputTokens;
        if (bucket.provider === 'phorma-cloud') {
          row.credits = (row.credits ?? 0) + bucket.costUsd * rate;
        } else if (bucket.costUsd > 0) {
          row.usd = (row.usd ?? 0) + bucket.costUsd;
        }
        row.estimated ||= bucket.estimated;
        row.rank = (row.usd ?? 0) + (row.credits ?? 0) / Math.max(rate, 1);
        rows.set(nodeKey, row);
      }
    }
    return [...rows.values()]
      .sort((a, b) => b.rank - a.rank)
      .map(({ rank: _rank, ...row }) => ({
        ...row,
        credits: row.credits === null ? null : Math.round(row.credits),
      }));
  });

  /** Spend grouped by trigger source (manual, schedule, webhook, eval, …). */
  readonly bySource = computed<UsageGroupRow[]>(() =>
    this.groupBy(this.entries(), entry => entry.source),
  );

  /** Spend grouped by run status - surfaces money burnt on failures. */
  readonly byStatus = computed<UsageGroupRow[]>(() =>
    this.groupBy(this.entries(), entry => entry.status),
  );

  /** Spend grouped by execution environment (local vs cloud). */
  readonly byEnvironment = computed<UsageGroupRow[]>(() =>
    this.groupBy(this.entries(), entry => entry.environment),
  );

  /**
   * Per-model daily cost series. The map key is `provider:model`; the value is
   * every day in the period (zero-filled) so all series share an x axis.
   */
  readonly dailyByModel = computed<Map<string, ModelDailyPoint[]>>(() => {
    const days = this.daily().map(point => point.day);
    const dayIndex = new Map(days.map((day, index) => [day, index]));
    const series = new Map<string, number[]>();

    for (const entry of this.entries()) {
      const index = dayIndex.get(dayKey(entry.startedAt));
      if (index === undefined) continue;
      const buckets = entry.usage.byModel;
      if (!buckets) continue;
      for (const bucket of Object.values(buckets)) {
        const key = `${bucket.provider}:${bucket.model || 'unknown'}`;
        const values = series.get(key) ?? new Array<number>(days.length).fill(0);
        values[index] += bucket.costUsd;
        series.set(key, values);
      }
    }

    const result = new Map<string, ModelDailyPoint[]>();
    for (const [key, values] of series) {
      result.set(
        key,
        values.map((costUsd, index) => ({ day: days[index], costUsd })),
      );
    }
    return result;
  });

  /** Wall-clock duration statistics over the settled runs in the period. */
  readonly durations = computed<UsageDurations>(() => {
    const values: number[] = [];
    for (const entry of this.entries()) {
      if (entry.endedAt === undefined) continue;
      const duration = entry.endedAt - entry.startedAt;
      // Clock skew between the local machine and a DO can produce negatives.
      if (duration > 0) values.push(duration);
    }
    const mean =
      values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : 0;
    return {
      values,
      p50: percentileOf(values, 0.5),
      p95: percentileOf(values, 0.95),
      mean,
    };
  });

  /** Cost incurred by runs that did not complete - pure waste. */
  readonly failedSpend = computed<UsageTotals>(() =>
    this.totalsOf(this.entries().filter(entry => entry.status === 'failed' || entry.status === 'stopped')),
  );

  /**
   * Plan credits per USD. Re-exported so views can convert credits back to a
   * comparable magnitude for ranking and chart axes without reaching into
   * PhormaCloudService themselves.
   */
  readonly creditsPerUsd = computed(() => this.phormaCloud.creditsPerUsd());

  /** Share of runs in the period that completed successfully, 0..1. */
  readonly successRate = computed(() => {
    const entries = this.entries();
    if (entries.length === 0) return 0;
    return entries.filter(entry => entry.status === 'completed').length / entries.length;
  });

  /** Average BYO USD + credits per run in the period. */
  readonly perRunAverage = computed(() => {
    const totals = this.totals();
    if (totals.runs === 0) return { usd: 0, credits: 0 };
    return { usd: totals.usd / totals.runs, credits: totals.credits / totals.runs };
  });

  /** Distinct facet values present in the scoped ledger, for the filter chips. */
  readonly availableSources = computed(() => this.distinct(entry => entry.source));
  readonly availableStatuses = computed(() => this.distinct(entry => entry.status));
  readonly availableEnvironments = computed(() => this.distinct(entry => entry.environment));

  private distinct(pick: (entry: UsageLedgerEntry) => string): string[] {
    const values = new Set<string>();
    for (const entry of this.scopedEntries()) values.add(pick(entry));
    return [...values].sort((a, b) => a.localeCompare(b));
  }

  /** Groups entries by a string field, most expensive first. */
  private groupBy(
    entries: readonly UsageLedgerEntry[],
    pick: (entry: UsageLedgerEntry) => string,
  ): UsageGroupRow[] {
    const rate = this.phormaCloud.creditsPerUsd();
    const rows = new Map<string, UsageGroupRow & { rank: number }>();
    for (const entry of entries) {
      const key = pick(entry);
      const row = rows.get(key) ?? {
        key,
        runs: 0,
        inputTokens: 0,
        outputTokens: 0,
        usd: null,
        credits: null,
        rank: 0,
      };
      const cloudShare = entry.usage.phormaCloudCostUsd ?? 0;
      const byoShare = entry.usage.costUsd - cloudShare;
      row.runs += 1;
      row.inputTokens += entry.usage.inputTokens;
      row.outputTokens += entry.usage.outputTokens;
      if (byoShare > 0) row.usd = (row.usd ?? 0) + byoShare;
      // Credits accumulate unrounded; the final projection rounds once.
      if (cloudShare > 0) row.credits = (row.credits ?? 0) + cloudShare * rate;
      row.rank = (row.usd ?? 0) + (row.credits ?? 0) / Math.max(rate, 1);
      rows.set(key, row);
    }
    return [...rows.values()]
      .sort((a, b) => b.rank - a.rank || b.runs - a.runs)
      .map(({ rank: _rank, ...row }) => ({
        ...row,
        credits: row.credits === null ? null : Math.round(row.credits),
      }));
  }

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
      // Fetch at least the selected window; never less than 90 days so that
      // widening the period doesn't require a round trip. `all` fetches
      // everything the DO still keeps.
      const selected = periodStart(this.period());
      const since = selected === 0 ? 0 : Math.min(selected, periodStart('90d'));
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
