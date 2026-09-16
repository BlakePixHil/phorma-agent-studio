/**
 * What a deploy will put live, derived from the spec alone.
 *
 * Pure and Angular-free so the dialog's "what am I about to deploy" block is
 * unit-testable without TestBed. Walks the top-level graph AND every embedded
 * sub-workflow, because the push sends the whole closure.
 */

import { describePlan, localTimeZone, parseSchedule } from '../../../core/schedule-cron';
import type {
  ScheduleTriggerData,
  WorkflowGraph,
  WorkflowSpec,
} from '../../../core/workflow.model';

/** One armed schedule, described in the zone it was authored in. */
export interface ScheduleSummary {
  nodeId: string;
  nodeName: string;
  /** e.g. "Weekdays at 09:00 (Australia/Sydney)", or the raw cron when unset. */
  description: string;
}

/** Everything a push makes reachable or self-starting. */
export interface DeploySummary {
  agents: number;
  schedules: ScheduleSummary[];
  /** Portal trigger slugs, empty when the workflow declares no portal. */
  portalSlugs: string[];
  /** Webhook trigger count - each one becomes a callable HTTP endpoint. */
  webhooks: number;
  /** Embedded sub-workflows travelling with the spec. */
  subWorkflows: number;
}

/** Every graph in the pushed closure, top level first. */
function graphs(spec: WorkflowSpec): WorkflowGraph[] {
  return [spec.graph, ...Object.values(spec.subWorkflows ?? {}).map(entry => entry.graph)];
}

export function summarizeDeploySpec(spec: WorkflowSpec): DeploySummary {
  const summary: DeploySummary = {
    agents: 0,
    schedules: [],
    portalSlugs: [],
    webhooks: 0,
    subWorkflows: Object.keys(spec.subWorkflows ?? {}).length,
  };

  for (const graph of graphs(spec)) {
    for (const node of graph.nodes) {
      switch (node.kind) {
        case 'agent':
          summary.agents += 1;
          break;
        case 'schedule-trigger': {
          const data = node.data as ScheduleTriggerData;
          const cron = data?.cron?.trim();
          // A blank cron arms nothing, so it is not something going live.
          if (!cron) break;
          summary.schedules.push({
            nodeId: node.id,
            nodeName: node.name,
            description: describeCron(cron, data.timezone),
          });
          break;
        }
        case 'portal-trigger':
          summary.portalSlugs.push((node.data as { slug?: string })?.slug ?? '');
          break;
        case 'webhook-trigger':
          summary.webhooks += 1;
          break;
        default:
          break;
      }
    }
  }

  return summary;
}

/** The stored cron is UTC; `timezone` is the zone it was authored in. */
function describeCron(cron: string, timezone: string | undefined): string {
  const zone = timezone || localTimeZone();
  try {
    const plan = parseSchedule(cron, zone);
    return plan.frequency === 'custom' ? `Cron ${cron} (UTC)` : describePlan(plan, zone);
  } catch {
    return `Cron ${cron} (UTC)`;
  }
}

/** True when a deploy would make this workflow reachable or self-starting. */
export function deployGoesLive(summary: DeploySummary): boolean {
  return summary.schedules.length > 0 || summary.portalSlugs.length > 0 || summary.webhooks > 0;
}
