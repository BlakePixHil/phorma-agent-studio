import type { RunLogEvent } from '@phorma/engine';

import type { TraceEntry } from './run-controller.service';

/** The tone/icon/label description of one trace entry (no id/timestamp). */
export interface TraceDescription {
  icon: string;
  label: string;
  detail?: string;
  tone: TraceEntry['tone'];
  kind: TraceEntry['kind'];
}

export interface TraceOptions {
  /**
   * Formats a usage cost for display. Callers supply this so the trace can
   * apply the display rule (Phorma Cloud-billed cost renders as plan
   * credits, BYO cost as USD, estimates labeled) without this pure module
   * knowing the tenant's credit rate. Return null to omit the cost.
   */
  formatCost?: (provider: string, costUsd: number, estimated: boolean) => string | null;
}

/**
 * Maps one run event to its Runs-panel trace entry — the single source of
 * icons, labels, and tones shared by the LIVE trace
 * (`RunControllerService.apply`) and the run-history detail view, so a past
 * run's timeline renders exactly like it did while running.
 *
 * Returns null for events that never produce a trace entry (token streams,
 * usage, pause/resume, coalesced text entries).
 */
export function describeRunEvent(
  event: RunLogEvent,
  nodeName: (nodeId: string) => string,
  options?: TraceOptions,
): TraceDescription | null {
  switch (event.type) {
    case 'node-usage': {
      const usage = event.usage;
      if (usage.inputTokens === undefined && usage.outputTokens === undefined) return null;
      const tokens = `${(usage.inputTokens ?? 0).toLocaleString()} in · ${(usage.outputTokens ?? 0).toLocaleString()} out`;
      const cost =
        usage.costUsd && usage.costUsd > 0 && options?.formatCost
          ? options.formatCost(event.provider, usage.costUsd, usage.costSource === 'estimated')
          : null;
      return {
        icon: 'ti ti-coins',
        label: `${nodeName(event.nodeId)} — ${tokens}${cost ? ` · ${cost}` : ''}`,
        detail: event.model || undefined,
        tone: 'info',
        kind: 'event',
      };
    }
    case 'run-started':
      return { icon: 'ti ti-player-play', label: 'Run started', detail: event.input || undefined, tone: 'info', kind: 'event' };
    case 'node-started':
      return { icon: 'ti ti-loader-2', label: `${event.nodeName} started`, tone: 'info', kind: 'event' };
    case 'node-completed':
      return { icon: 'ti ti-circle-check', label: `${event.nodeName} completed`, detail: event.output || undefined, tone: 'success', kind: 'event' };
    case 'node-failed':
      return { icon: 'ti ti-circle-x', label: `${event.nodeName} failed`, detail: event.error, tone: 'error', kind: 'event' };
    case 'node-retrying':
      return {
        icon: 'ti ti-refresh',
        label: `${event.nodeName} retrying (attempt ${event.attempt + 1}/${event.maxAttempts}) in ${event.delayMs >= 1000 ? `${Math.round(event.delayMs / 1000)}s` : `${event.delayMs}ms`}`,
        detail: event.error,
        tone: 'warning',
        kind: 'event',
      };
    case 'node-fallback':
      return {
        icon: 'ti ti-arrows-exchange',
        label: `${event.nodeName} switched to fallback model ${event.toModel}`,
        detail: `Primary ${event.fromModel} failed: ${event.error}`,
        tone: 'warning',
        kind: 'event',
      };
    case 'node-error-routed':
      return {
        icon: 'ti ti-route',
        label: `${event.nodeName} routed its failure to the error branch`,
        detail: event.error,
        tone: 'warning',
        kind: 'event',
      };
    case 'context-compressed':
      return {
        icon: 'ti ti-arrows-minimize',
        label: `${nodeName(event.nodeId)} — context compressed (~${event.beforeTokens.toLocaleString()} → ~${event.afterTokens.toLocaleString()} tokens)`,
        tone: 'info',
        kind: 'event',
      };
    case 'handoff':
      return {
        icon: 'ti ti-arrow-narrow-right',
        label: `${nodeName(event.fromNodeId)} → ${nodeName(event.toNodeId)}`,
        tone: 'info',
        kind: 'event',
      };
    case 'tool-call':
      return { icon: 'ti ti-tool', label: `Tool call: ${event.name}`, detail: event.arguments, tone: 'info', kind: 'tool-call' };
    case 'tool-result':
      return {
        icon: event.isError ? 'ti ti-alert-triangle' : 'ti ti-tool',
        label: `Tool ${event.isError ? 'error' : 'result'}: ${event.name}`,
        detail: event.result,
        tone: event.isError ? 'error' : 'success',
        kind: 'tool-result',
      };
    case 'approval-required':
      return { icon: 'ti ti-user-check', label: 'Approval required', detail: event.message, tone: 'warning', kind: 'event' };
    case 'approval-resolved':
      return {
        icon: event.approved ? 'ti ti-thumb-up' : 'ti ti-thumb-down',
        label: event.approved ? 'Approved' : 'Rejected',
        tone: event.approved ? 'success' : 'warning',
        kind: 'event',
      };
    case 'loop-started':
      return {
        icon: 'ti ti-repeat',
        label: `${event.nodeName} — ${event.total} item${event.total === 1 ? '' : 's'}`,
        tone: 'info',
        kind: 'event',
      };
    case 'loop-iteration':
      return {
        icon: 'ti ti-repeat-once',
        label: `Item ${event.index + 1}/${event.total}`,
        detail: event.item || undefined,
        tone: 'info',
        kind: 'event',
      };
    case 'loop-completed': {
      const tone = event.failed > 0 ? 'warning' : 'success';
      const summary = `${event.succeeded}/${event.total} succeeded${event.failed > 0 ? `, ${event.failed} failed` : ''}`;
      return { icon: 'ti ti-repeat', label: `Loop finished — ${summary}`, tone, kind: 'event' };
    }
    case 'wait-started':
      return {
        icon: 'ti ti-hourglass-high',
        label: `Waiting for "${event.correlationKey}"`,
        detail: event.message,
        tone: 'warning',
        kind: 'event',
      };
    case 'wait-resolved':
      return {
        icon: 'ti ti-bolt',
        label: `Event "${event.correlationKey}" arrived`,
        detail: event.eventPayload || undefined,
        tone: 'success',
        kind: 'event',
      };
    case 'run-completed':
      return { icon: 'ti ti-flag-check', label: 'Run completed', detail: event.output || undefined, tone: 'success', kind: 'event' };
    case 'run-failed':
      return { icon: 'ti ti-flag-x', label: 'Run failed', detail: event.error, tone: 'error', kind: 'event' };
    case 'run-stopped':
      return { icon: 'ti ti-player-stop', label: 'Run stopped', tone: 'warning', kind: 'event' };
    default:
      // run-paused, run-resumed, node-output-text, node-thinking-text —
      // no trace entry.
      return null;
  }
}

/**
 * Rebuilds a full trace timeline from a persisted run's event log, with the
 * event timestamps preserved. Ids are local to the returned array.
 */
export function traceFromRunLog(
  events: RunLogEvent[],
  nodeName: (nodeId: string) => string,
  options?: TraceOptions,
): TraceEntry[] {
  const entries: TraceEntry[] = [];
  for (const event of events) {
    const desc = describeRunEvent(event, nodeName, options);
    if (!desc) continue;
    entries.push({
      id: entries.length + 1,
      at: 'at' in event ? event.at : Date.now(),
      ...desc,
    });
  }
  return entries;
}
