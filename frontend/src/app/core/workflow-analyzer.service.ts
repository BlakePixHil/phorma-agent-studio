import { Injectable, inject } from '@angular/core';

import type { RunRecordSummary } from '@phorma/engine';

import { AssistantChatService } from './assistant-chat.service';
import { RunHistoryService } from './run-history.service';
import { WorkflowService } from './workflow.service';
import { buildAnalyzerSystemPrompt } from './workflow-builder-prompt';

/** How many recent runs feed the analyzer's context. */
const ANALYZER_RUNS = 15;

/**
 * The Workflow Analyzer (EPIC 5): assembles the active workflow's graph and
 * recent run history into an analysis request, executed as an Ask-mode chat
 * turn so the report lands in the assistant conversation (streamed,
 * persisted, and followed up on like any other message).
 */
@Injectable({ providedIn: 'root' })
export class WorkflowAnalyzerService {
  private readonly chat = inject(AssistantChatService);
  private readonly runHistory = inject(RunHistoryService);
  private readonly workflow = inject(WorkflowService);

  /** Runs the analyzer against the active workflow. */
  async analyze(): Promise<void> {
    if (this.chat.busy()) return;
    const graph = this.workflow.graph();
    const runContext = this.buildRunContext();

    await this.chat.sendTask({
      label: `Analyze "${this.workflow.activeName()}"`,
      request:
        'Analyze this workflow and its recent runs. Produce the improvement report.',
      system: buildAnalyzerSystemPrompt(graph, runContext),
      mode: 'ask',
    });
  }

  /** Serializes recent local runs for the active workflow (compact). */
  private buildRunContext(): string {
    const workflowId = this.workflow.activeDoc()?.workflowId ?? null;
    const runs = this.runHistory
      .localRuns()
      .map(record => record.summary)
      .filter(summary => summary.workflowId === workflowId)
      .slice(0, ANALYZER_RUNS);
    if (runs.length === 0) return '';
    return runs.map(summary => describeRun(summary)).join('\n');
  }
}

/** One compact line per run for the analyzer's context. */
function describeRun(summary: RunRecordSummary): string {
  const parts = [
    `- ${new Date(summary.startedAt).toISOString()} status=${summary.status}`,
    `source=${summary.source}`,
    `env=${summary.environment}`,
  ];
  if (summary.endedAt) {
    parts.push(`duration=${Math.round((summary.endedAt - summary.startedAt) / 1000)}s`);
  }
  const usage = summary.usage;
  if (usage && (usage.inputTokens || usage.outputTokens)) {
    parts.push(`tokens=${usage.inputTokens ?? 0}in/${usage.outputTokens ?? 0}out`);
    if (usage.costUsd) parts.push(`cost=$${usage.costUsd.toFixed(4)}`);
  }
  if (usage?.byNode) {
    const hot = Object.entries(usage.byNode)
      .sort((a, b) => b[1].costUsd - a[1].costUsd)
      .slice(0, 3)
      .map(([nodeId, bucket]) => `${nodeId}:$${bucket.costUsd.toFixed(4)}`);
    if (hot.length > 0) parts.push(`top-cost-nodes=[${hot.join(', ')}]`);
  }
  if (summary.error) parts.push(`error="${summary.error.slice(0, 160)}"`);
  return parts.join(' ');
}
