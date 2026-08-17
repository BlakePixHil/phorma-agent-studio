import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import {
  BROWSER_CAPABILITIES,
  TAURI_DESKTOP_CAPABILITIES,
  validateAgainstCapabilities,
  type CapabilityFinding,
  type ConnectionSummary,
} from '@phorma/engine';

import { ConnectionStoreService } from './connection-store.service';
import { DEPLOY_TARGETS, type DeployTargetId } from './deploy/deploy-targets';
import { findMcpPreset } from './node-catalog';
import { PhormaCloudService, tierLabel } from './phorma-cloud.service';
import { SettingsService } from './settings.service';
import { TauriService } from './tauri.service';
import { WorkflowService } from './workflow.service';

/**
 * Capability findings for the active graph against the active LOCAL host
 * (Requirements 17.8, 17.9, 17.15) - the shared read used by the canvas node
 * badge and, indirectly, the properties panel's own per-node computed.
 *
 * Deliberately top-level-graph only: the canvas and the properties panel
 * both render the currently open document's graph, never the inside of an
 * embedded sub-workflow (those open as their own read-only tab), so there is
 * no `subWorkflows` traversal here - that full-graph walk belongs to
 * `RunControllerService.start()` before `startRun` (Requirement 17.9's other
 * call site), which validates the complete portable spec including every
 * embedded sub-workflow.
 *
 * The connection inventory is refreshed whenever the graph changes, which is
 * cheap (one IndexedDB + keychain-presence read) and keeps findings accurate
 * as connections are edited or created from the Connections panel while a
 * node is selected. Findings land well inside the 500 ms window Requirement
 * 17.9 allows: this is a plain Angular `computed()`, so a graph edit's
 * change-detection pass on the very next tick recomputes it.
 */
@Injectable({ providedIn: 'root' })
export class CapabilityFindingsService {
  private readonly tauri = inject(TauriService);
  private readonly connectionStore = inject(ConnectionStoreService);
  private readonly workflow = inject(WorkflowService);
  private readonly settings = inject(SettingsService);
  private readonly phormaCloud = inject(PhormaCloudService);

  /** The local host's capability record - Desktop inside Tauri, Browser otherwise. */
  readonly activeHostCapabilities = computed(() =>
    this.tauri.isDesktop ? TAURI_DESKTOP_CAPABILITIES : BROWSER_CAPABILITIES,
  );

  /** Every locally known connection, secret-free. */
  private readonly connectionSummaries = signal<ConnectionSummary[]>([]);

  /** Reloads the connection inventory whenever the active graph changes. */
  private readonly connectionListRefresher = effect(() => {
    this.workflow.graph();
    untracked(() => {
      void this.connectionStore
        .list()
        .then(list => this.connectionSummaries.set(list))
        .catch(() => this.connectionSummaries.set([]));
    });
  });

  /** Every capability finding for the active document's top-level graph. */
  readonly localFindings = computed<CapabilityFinding[]>(() =>
    validateAgainstCapabilities(
      { graph: this.workflow.graph() },
      this.activeHostCapabilities(),
      this.connectionSummaries(),
    ),
  );

  /**
   * The selected deploy target's capability record, resolved from
   * `DEPLOY_TARGETS`. Returns null when no target is chosen.
   */
  private readonly deployCapabilities = computed(() => {
    const provider = this.settings.cloudProvider();
    if (!provider) return null;
    return DEPLOY_TARGETS[provider as DeployTargetId]?.capabilities ?? null;
  });

  /**
   * Findings against the selected DEPLOY target's capability record, reported
   * as warnings with `deployOnly: true`.
   *
   * A workflow can be perfectly runnable locally and still be undeployable -
   * a local stdio MCP server is the canonical case. Validating only the local
   * host meant the author learned that at push time, after building the whole
   * workflow. Downgrading to `warning` is deliberate: these must NOT block a
   * local run, which is exactly what the author is doing while they iterate.
   * The push path re-validates against the same record at `error` severity.
   *
   * Suppressed once the deploy target IS the local host (nothing to warn
   * about) and while no cloud provider has been chosen, so a purely local user
   * never sees cloud vocabulary.
   */
  readonly deployFindings = computed<CapabilityFinding[]>(() => {
    const capabilities = this.deployCapabilities();
    if (!capabilities) return [];
    const local = this.activeHostCapabilities();
    if (local.id === capabilities.id) return [];
    // Findings the local host already reports are shown at their own severity;
    // only the deploy-specific delta belongs here.
    const localMessages = new Set(this.localFindings().map(finding => finding.message));
    return validateAgainstCapabilities(
      { graph: this.workflow.graph() },
      capabilities,
      this.connectionSummaries(),
    )
      .filter(finding => !localMessages.has(finding.message))
      .map(finding => ({
        ...finding,
        severity: 'warning' as const,
        deployOnly: true,
        message: this.withRemedy(finding),
      }));
  });

  /**
   * Appends the concrete fix to a deploy finding when the offending node is a
   * preset with a known remote equivalent. The engine cannot do this itself -
   * `MCP_PRESETS` is studio data and the engine is framework- and
   * catalog-free - and "this cannot be deployed" without a named alternative
   * leaves the author stuck.
   */
  private withRemedy(finding: CapabilityFinding): string {
    if (!finding.nodeId) return finding.message;
    const node = this.workflow.graph().nodes.find(candidate => candidate.id === finding.nodeId);
    const presetId = (node?.data as { presetId?: string } | undefined)?.presetId;
    const alternativeId = presetId ? findMcpPreset(presetId)?.remoteAlternativeId : undefined;
    const alternative = alternativeId ? findMcpPreset(alternativeId) : undefined;
    // An OAuth alternative doesn't actually fix cloud deployability - its
    // signed-in session cannot reach a deployed worker either, so recommending
    // it would just trade this finding for the identical one on the swapped-in
    // node.
    if (!alternative || alternative.authMode === 'oauth') return finding.message;
    return `${finding.message} Swap it for the remote "${alternative.label}" server, listed under Remote MCP in the palette.`;
  }

  /**
   * Tier-driven schedule-budget findings for Phorma Cloud users. The worker's
   * `rescheduleCron` arms schedules in graph order and silently drops the rest
   * once the plan's `schedulesPerWorkflow` budget is spent; this surfaces the
   * drop on the canvas BEFORE the user pushes, on every excess schedule-trigger
   * node (index >= budget, matching the worker's iteration order).
   *
   * Phorma Cloud only: BYO Cloudflare deployments have no schedule cap (the
   * worker sets `scheduleBudget = Infinity` when `!this.hosted`). Suppressed
   * while no cloud provider is chosen, so a purely local user never sees cloud
   * vocabulary. `warning` severity: the excess schedule doesn't block local
   * runs or push - the worker just ignores it, which is degraded but not fatal.
   */
  readonly tierScheduleFindings = computed<CapabilityFinding[]>(() => {
    if (this.settings.cloudProvider() !== 'phorma') return [];
    const budget = this.phormaCloud.schedulesPerWorkflow();
    const scheduleNodes = this.workflow
      .graph()
      .nodes.filter(node => node.kind === 'schedule-trigger');
    if (scheduleNodes.length <= budget) return [];
    const tier = this.phormaCloud.profile()?.tier ?? 'starter';
    const planName = tierLabel(tier).toLowerCase();
    return scheduleNodes.slice(budget).map(node => ({
      severity: 'warning' as const,
      nodeId: node.id,
      nodeName: node.name,
      deployOnly: true,
      message:
        `Your Phorma Cloud plan (${planName}) allows ${budget} schedule ${budget === 1 ? 'trigger' : 'triggers'} ` +
        `per workflow. This schedule will not run in the cloud - the worker arms schedules in order and ` +
        `skips the rest. Upgrade your plan in Settings > Cloud to arm all schedules.`,
    }));
  });

  /**
   * Local findings plus deploy-target findings plus tier-schedule findings -
   * what the canvas badge and the properties panel render.
   */
  readonly findings = computed<CapabilityFinding[]>(() => [
    ...this.localFindings(),
    ...this.deployFindings(),
    ...this.tierScheduleFindings(),
  ]);
}
