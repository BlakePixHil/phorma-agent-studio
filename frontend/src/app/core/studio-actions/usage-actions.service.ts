import { Injectable, inject } from '@angular/core';

import { UsageAnalyticsService, type UsagePeriod } from '../usage-analytics.service';
import { WorkflowService } from '../workflow.service';
import {
  actionOk,
  argBool,
  argNum,
  argStr,
  type ActionArgs,
  type ActionResult,
  type StudioAction,
} from './studio-action.model';

const PERIODS: readonly UsagePeriod[] = ['7d', '30d', '90d', '1y', 'all', 'month'];

/** Default hotspot rows returned per call. */
const HOTSPOT_LIMIT = 10;

/**
 * Surface `usage` Studio_Actions (Requirement 2.8).
 *
 * Requirement 6.6: cost is reported split, exactly as the panels render it -
 * `credits` for the Phorma Cloud-billed share, `usd` for the bring-your-own
 * share, with `estimated` flagged when the USD figure came from the pricing
 * table rather than provider accounting. Never a single blended number.
 *
 * Declared minimums (multi-organisation-phorma Requirement 8.1): both reads are
 * operator - `read.usage` is an operator capability and the Usage panel carries no
 * minimum. What a run cost is exactly the thing an operator is answerable for.
 */
@Injectable({ providedIn: 'root' })
export class UsageActionsService {
  private readonly usage = inject(UsageAnalyticsService);
  private readonly workflow = inject(WorkflowService);

  actions(): StudioAction[] {
    return [
      {
        id: 'usage_read_summary',
        label: 'Read the usage summary',
        description:
          'Returns run counts, token totals and cost for a period. Cost is split: plan credits for the Phorma Cloud share, USD for bring-your-own keys.',
        surface: 'usage',
        access: 'read',
        risk: 'silent',
        minLevel: 'operator',
        params: {
          period: {
            type: 'string',
            description: 'Analytics window. Defaults to 30d.',
            enum: PERIODS,
          },
          activeWorkflowOnly: {
            type: 'boolean',
            description: 'Limit to the active workflow. Defaults to false (whole account).',
          },
        },
        activity: () => 'Reading the usage summary',
        run: args => this.readSummary(args),
      },
      {
        id: 'usage_read_hotspots',
        label: 'Read the cost hotspots',
        description:
          'Returns the highest-cost nodes and workflows in a period, most expensive first, with per-model attribution.',
        surface: 'usage',
        access: 'read',
        risk: 'silent',
        minLevel: 'operator',
        params: {
          period: {
            type: 'string',
            description: 'Analytics window. Defaults to 30d.',
            enum: PERIODS,
          },
          activeWorkflowOnly: {
            type: 'boolean',
            description: 'Limit to the active workflow. Defaults to false (whole account).',
          },
          limit: { type: 'number', description: `Rows per table (default ${HOTSPOT_LIMIT}).` },
        },
        activity: () => 'Reading the cost hotspots',
        run: args => this.readHotspots(args),
      },
    ];
  }

  // ── Executors ────────────────────────────────────────────────────────────

  private async readSummary(args: ActionArgs): Promise<ActionResult> {
    const period = await this.applyScope(args);
    const totals = this.usage.totals();
    return actionOk({
      period,
      scope: this.usage.scope() ?? 'all workflows',
      runs: totals.runs,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      usd: round(totals.usd),
      credits: Math.round(totals.credits),
      estimated: totals.estimated,
      daily: this.usage.daily().map(point => ({
        day: point.day,
        runs: point.runs,
        usd: round(point.usd),
        credits: point.credits,
      })),
    });
  }

  private async readHotspots(args: ActionArgs): Promise<ActionResult> {
    const period = await this.applyScope(args);
    const limit = Math.max(1, Math.min(argNum(args, 'limit') ?? HOTSPOT_LIMIT, 25));
    const graph = this.workflow.graph();
    const nodeName = (nodeId: string): string =>
      graph.nodes.find(node => node.id === nodeId)?.name ??
      // Ledgers outlive the graph, so historic rows routinely name deleted nodes.
      `Deleted node - ${nodeId.slice(-6)}`;
    return actionOk({
      period,
      nodes: this.usage
        .byNode()
        .slice(0, limit)
        .map(row => ({
          nodeKey: row.nodeKey,
          nodeId: row.nodeId,
          name: nodeName(row.nodeId),
          provider: row.provider,
          model: row.model,
          runs: row.runs,
          usd: row.usd === null ? null : round(row.usd),
          credits: row.credits,
          estimated: row.estimated,
        })),
      workflows: this.usage
        .byWorkflow()
        .slice(0, limit)
        .map(row => ({
          workflowId: row.workflowId,
          name: row.workflowName,
          runs: row.runs,
          usd: row.usd === null ? null : round(row.usd),
          credits: row.credits,
          estimated: row.estimated,
        })),
      models: this.usage
        .byModel()
        .slice(0, limit)
        .map(row => ({
          provider: row.provider,
          model: row.model,
          runs: row.runs,
          usd: row.usd === null ? null : round(row.usd),
          credits: row.credits,
          estimated: row.estimated,
        })),
    });
  }

  /**
   * Points the analytics service at the requested window and scope, then loads
   * the ledger. The period and scope are panel FILTERS, not studio state
   * covered by Requirement 5.6, and leaving them set means the Usage panel
   * revealed afterwards shows exactly the numbers just reported.
   */
  private async applyScope(args: ActionArgs): Promise<UsagePeriod> {
    const period = (argStr(args, 'period') as UsagePeriod | undefined) ?? '30d';
    this.usage.period.set(period);
    this.usage.scope.set(
      argBool(args, 'activeWorkflowOnly')
        ? (this.workflow.activeDoc()?.workflowId ?? 'draft')
        : null,
    );
    this.usage.clearFacets();
    await this.usage.refresh().catch(() => undefined);
    return period;
  }
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
