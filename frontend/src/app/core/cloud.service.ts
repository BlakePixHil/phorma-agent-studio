import { Injectable, computed, inject, signal } from '@angular/core';
import { ClerkService } from 'ngx-clerk';
import { firstValueFrom } from 'rxjs';

import {
  CLOUDFLARE_CAPABILITIES,
  validateAgainstCapabilities,
  type ConnectionSummary,
  type RunEvent,
  type RunRecord,
  type RunRecordSummary,
  type UsageLedgerEntry,
} from '@phorma/engine';

import { ConnectionStoreService } from './connection-store.service';
import { DeployConfigService, BYO_CONFIG_FILENAME } from './deploy-config.service';
import { RunControllerService } from './run-controller.service';
import { SettingsService } from './settings.service';
import { SkillsService } from './skills.service';
import { WorkflowVersionsService } from './workflow-versions.service';
import { TauriService } from './tauri.service';
import { TerminalOutputService } from './terminal-output.service';
import { WorkflowService } from './workflow.service';
import { loadLayout, saveLayout } from './layout-storage';
import { loadPhormaCloudUrl, savePhormaCloudUrl } from './phorma-cloud-url';
import { ToastService } from '../shared/toast/toast.service';
import { isAgentNode, type WorkflowSpec } from './workflow.model';
import type {
  PortalMintResponse,
  PortalPublishResponse,
  PortalStatusResponse,
} from './portal.model';

export type CloudConnectionState = 'disconnected' | 'connecting' | 'connected';

/**
 * Drops the local-only projection fields (`secretsPresent`, `usedByWorkflowIds`)
 * from a `ConnectionSummary`, leaving exactly the `Connection` metadata shape
 * the worker's push route accepts. Never carries a secret value either way.
 */
function toConnectionMetadata(
  summary: ConnectionSummary,
): Omit<ConnectionSummary, 'secretsPresent' | 'missingSecretKeys' | 'usedByWorkflowIds'> {
  const { secretsPresent, missingSecretKeys, usedByWorkflowIds, ...metadata } = summary;
  void secretsPresent;
  void missingSecretKeys;
  void usedByWorkflowIds;
  return metadata;
}

// `PHORMA_CLOUD_DEFAULT_URL` and the retired-host migration live in
// `phorma-cloud-url.ts`, a leaf module the run path can import without closing
// the RunController -> ModelTransport -> PhormaCloud -> Cloud DI cycle.

/**
 * The studio's bridge to the deployed cloud runtime.
 *
 * - **Deploy**: streams `npx wrangler deploy` (run by the Rust backend inside
 *   the repo's `cloud/` folder) into the console.
 * - **Push**: uploads the active workflow spec to its WorkflowAgent instance.
 * - **Monitor**: a WebSocket whose RunEvents feed the SAME
 *   `RunControllerService.apply()` path as local runs - cloud runs animate
 *   the canvas identically.
 * - **Trigger/Stop/Approve**: control frames sent over the socket.
 */
@Injectable({ providedIn: 'root' })
export class CloudService {
  private readonly tauri = inject(TauriService);
  private readonly workflow = inject(WorkflowService);
  private readonly runController = inject(RunControllerService);
  private readonly terminal = inject(TerminalOutputService);
  private readonly toast = inject(ToastService);
  private readonly settings = inject(SettingsService);
  private readonly skillsLibrary = inject(SkillsService);
  private readonly versions = inject(WorkflowVersionsService);
  private readonly clerk = inject(ClerkService);
  private readonly deployConfig = inject(DeployConfigService);
  private readonly connectionStore = inject(ConnectionStoreService);

  /** Worker base URL, e.g. https://phorma-agent-studio-cloud.you.workers.dev */
  readonly workerUrl = signal(loadLayout('cloudWorkerUrl', ''));
  /** Bearer token matching the worker's PHORMA_TOKEN secret (optional). */
  readonly token = signal(loadLayout('cloudToken', ''));
  /** Absolute path of the repo's cloud/ folder (deploy runs wrangler there). */
  readonly cloudFolder = signal(loadLayout('cloudFolder', ''));
  /** Phorma Cloud base URL (configurable for staging; defaults to prod). */
  readonly phormaCloudUrl = signal(loadPhormaCloudUrl());

  /** The user's chosen deploy target (null until picked in Settings → Cloud). */
  readonly provider = computed(() => this.settings.cloudProvider());

  /** Base URL actually used for push/monitor, per the chosen provider. */
  readonly effectiveWorkerUrl = computed(() =>
    this.provider() === 'phorma' ? this.phormaCloudUrl() : this.workerUrl(),
  );

  /**
   * Whether the chosen provider has enough configuration for push/monitor.
   * Phorma Cloud needs only the built-in URL (auth is checked at request
   * time); own-Cloudflare needs the user's worker URL.
   */
  readonly configured = computed(() => {
    const provider = this.provider();
    if (provider === 'phorma') return this.phormaCloudUrl().length > 0;
    if (provider === 'cloudflare') return this.workerUrl().length > 0;
    return false;
  });

  readonly connection = signal<CloudConnectionState>('disconnected');
  readonly deploying = signal(false);
  readonly connected = computed(() => this.connection() === 'connected');
  /**
   * Deployment status of the active workflow on the current provider's
   * instance, for the Cloud dialog's status indicator. `null` means unknown
   * (never checked, or the worker was unreachable) - never read as "not
   * deployed".
   */
  readonly deployedStatus = signal<{ hasWorkflow: boolean; savedAt: string | null } | null>(null);
  /**
   * The workflow id the live {@link deployedStatus} was last checked for.
   * Consumers must compare this to the workflow they're interested in before
   * trusting {@link deployedStatus} - otherwise a stale status from a
   * previously-active workflow leaks when the user switches tabs.
   */
  readonly deployedStatusWorkflowId = signal<string | null>(null);
  /** True while {@link refreshStatus} has a request in flight. */
  readonly statusLoading = signal(false);

  private socket: WebSocket | null = null;
  private deployCounter = 0;

  constructor() {
    // Persist connection settings across sessions.
    // (Best-effort localStorage writes; see layout-storage.)
  }

  setWorkerUrl(url: string): void {
    this.workerUrl.set(url.trim().replace(/\/$/, ''));
    saveLayout('cloudWorkerUrl', this.workerUrl());
  }

  setToken(token: string): void {
    this.token.set(token.trim());
    saveLayout('cloudToken', this.token());
  }

  setCloudFolder(path: string): void {
    this.cloudFolder.set(path.trim());
    saveLayout('cloudFolder', this.cloudFolder());
  }

  setPhormaCloudUrl(url: string): void {
    this.phormaCloudUrl.set(savePhormaCloudUrl(url));
  }

  /** Picks the cloud/ folder with the native dialog (desktop only). */
  async pickCloudFolder(): Promise<void> {
    try {
      const folder = await this.tauri.selectFolderDialog('Select the cloud/ folder');
      if (folder) this.setCloudFolder(folder);
    } catch (error) {
      this.toast.error('Folder picker unavailable', error instanceof Error ? error.message : String(error));
    }
  }

  // ── Deploy (desktop only - spawns wrangler via Rust) ───────────────────────

  async deploy(): Promise<void> {
    if (!this.tauri.isDesktop) {
      this.toast.warning('Desktop only', 'Deploying runs wrangler locally - use the desktop app.');
      return;
    }
    const cwd = this.cloudFolder();
    if (!cwd) {
      this.toast.warning('Set the cloud folder', "Pick the repo's cloud/ folder first.");
      return;
    }
    if (!this.deployConfig.valid()) {
      this.toast.warning(
        'Check your Cloud settings',
        'The account id, worker name or portal domain looks wrong.',
      );
      return;
    }
    if (this.deploying()) return;

    this.deploying.set(true);
    this.deployCounter += 1;
    const requestId = `deploy-${this.deployCounter}`;
    this.terminal.open('run');

    // A custom account, worker name or portal domain needs configuration that
    // must NOT be hand-edited into the version-controlled wrangler.jsonc, so
    // the studio writes a gitignored override and deploys with `--config`.
    const args = ['wrangler', 'deploy'];
    if (this.deployConfig.needsOverride()) {
      const written = await this.writeOverrideConfig(cwd);
      if (!written) {
        this.deploying.set(false);
        return;
      }
      args.push('--config', BYO_CONFIG_FILENAME);
    }
    this.terminal.append('run', 'info', `$ npx ${args.join(' ')}`);

    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');

    const unlisten = await listen<{ requestId: string; stream: string; line: string }>(
      'process-output-event',
      event => {
        if (event.payload.requestId !== requestId) return;
        if (event.payload.stream === 'exit') return;
        this.terminal.append(
          'run',
          event.payload.stream === 'stderr' ? 'warning' : 'info',
          event.payload.line,
        );
      },
    );

    try {
      const result = await invoke<{ success: boolean; exitCode: number | null }>(
        'run_streamed_command',
        { requestId, cwd, program: 'npx', args },
      );
      if (result.success) {
        this.toast.success('Deployed', 'Worker published. Push your workflow next.');
      } else {
        this.toast.error('Deploy failed', `wrangler exited with code ${result.exitCode ?? '?'}.`);
      }
    } catch (error) {
      this.toast.error('Deploy failed', error instanceof Error ? error.message : String(error));
    } finally {
      unlisten();
      this.deploying.set(false);
    }
  }

  /**
   * Writes the generated wrangler override into the cloud folder. Returns false
   * (having toasted) when it could not be written, so the caller aborts rather
   * than deploying with stale or default configuration.
   */
  private async writeOverrideConfig(cwd: string): Promise<boolean> {
    // Match the folder's own separator instead of assuming one.
    const separator = cwd.includes('\\') ? '\\' : '/';
    const path = `${cwd.replace(/[\\/]$/, '')}${separator}${BYO_CONFIG_FILENAME}`;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('write_workflow_file', {
        path,
        content: this.deployConfig.buildOverrideConfig(),
      });
      this.terminal.append('run', 'info', `Wrote ${BYO_CONFIG_FILENAME} (generated, gitignored).`);
      return true;
    } catch (error) {
      this.toast.error(
        'Could not write the deploy config',
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  // ── Worker secrets (desktop only - wrangler secret put via Rust) ───────────

  /** Secret name currently being saved (drives per-row button spinners). */
  readonly savingSecret = signal<string | null>(null);

  // ── Connection secrets on the deployed runtime (any provider) ─────────────

  /**
   * Connection-secret entry names the deployed runtime currently holds, as
   * `workerSecretName` produces them. Names only - there is no route that
   * returns a value, by construction.
   *
   * Empty on any failure (unreachable worker, no vault binding, no encryption
   * key): this drives an informational badge, so it must never throw into a
   * caller that is only trying to render.
   */
  async connectionSecretNames(): Promise<string[]> {
    const base = this.effectiveWorkerUrl();
    if (!base) return [];
    try {
      const response = await fetch(`${base}/api/connection-secrets`, {
        headers: await this.headers(),
      });
      if (!response.ok) return [];
      const body = (await response.json()) as { secrets?: { name?: unknown }[] };
      return (body.secrets ?? [])
        .map(entry => entry.name)
        .filter((name): name is string => typeof name === 'string');
    } catch {
      return [];
    }
  }

  /**
   * Stores one connection secret on the deployed runtime, so a deployed run can
   * resolve it (Requirement 3.5 second path).
   *
   * The value goes ONLY here: the studio's own copy lives in the OS keychain,
   * which a worker cannot read, and there is no path that reads either store
   * back. That is why this takes the value the operator is currently typing
   * rather than "syncing" a stored one - a sync would require a read-back that
   * deliberately does not exist.
   *
   * Works for both deploy targets: Phorma Cloud (the tenant's own vault) and
   * own-Cloudflare (the deployment's vault). Resolves false having toasted, so
   * a caller can keep the draft on screen for a retry.
   */
  async putConnectionSecret(connectionId: string, secretKey: string, value: string): Promise<boolean> {
    const base = this.effectiveWorkerUrl();
    if (!base) {
      this.toast.warning('No cloud target', 'Pick a deploy target in Settings > Cloud first.');
      return false;
    }
    if (!value.trim()) {
      this.toast.warning('Empty value', 'Enter the secret value first.');
      return false;
    }
    this.savingSecret.set(`${connectionId}:${secretKey}`);
    try {
      const response = await fetch(`${base}/api/connection-secrets`, {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify({ connectionId, secretKey, value }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
      this.toast.success('Secret sent to the cloud', `${secretKey} is available to deployed runs.`);
      return true;
    } catch (error) {
      this.toast.error('Could not send the secret', error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      this.savingSecret.set(null);
    }
  }

  /** Removes one connection secret from the deployed runtime. Idempotent. */
  async deleteConnectionSecret(connectionId: string, secretKey: string): Promise<boolean> {
    const base = this.effectiveWorkerUrl();
    if (!base) return false;
    try {
      const query = `connectionId=${encodeURIComponent(connectionId)}&secretKey=${encodeURIComponent(secretKey)}`;
      const response = await fetch(`${base}/api/connection-secrets?${query}`, {
        method: 'DELETE',
        headers: await this.headers(),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
      return true;
    } catch (error) {
      this.toast.error('Could not remove the secret', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * Sets a secret on the user's deployed worker via
   * `npx wrangler secret put <NAME>`. The value travels through the Rust
   * backend into wrangler's stdin - never through argv or the console.
   */
  async putWorkerSecret(name: string, value: string): Promise<void> {
    if (!this.tauri.isDesktop) {
      this.toast.warning('Desktop only', 'Setting secrets runs wrangler locally - use the desktop app.');
      return;
    }
    const cwd = this.cloudFolder();
    if (!cwd) {
      this.toast.warning('Set the cloud folder', "Pick the repo's cloud/ folder first.");
      return;
    }
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      this.toast.error('Invalid secret name', name);
      return;
    }
    if (!value.trim()) {
      this.toast.warning('Empty value', 'Paste the secret value first.');
      return;
    }
    if (this.savingSecret()) return;

    this.savingSecret.set(name);
    this.deployCounter += 1;
    const requestId = `secret-${this.deployCounter}`;
    this.terminal.open('run');
    this.terminal.append('run', 'info', `$ npx wrangler secret put ${name}`);

    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');

    const unlisten = await listen<{ requestId: string; stream: string; line: string }>(
      'process-output-event',
      event => {
        if (event.payload.requestId !== requestId) return;
        if (event.payload.stream === 'exit') return;
        this.terminal.append(
          'run',
          event.payload.stream === 'stderr' ? 'warning' : 'info',
          event.payload.line,
        );
      },
    );

    try {
      const result = await invoke<{ success: boolean; exitCode: number | null }>(
        'run_streamed_command',
        {
          requestId,
          cwd,
          program: 'npx',
          args: ['wrangler', 'secret', 'put', name],
          stdinData: value.trim(),
        },
      );
      if (result.success) {
        this.toast.success('Secret saved', `${name} is set on your worker.`);
      } else {
        this.toast.error('Secret failed', `wrangler exited with code ${result.exitCode ?? '?'}.`);
      }
    } catch (error) {
      this.toast.error('Secret failed', error instanceof Error ? error.message : String(error));
    } finally {
      unlisten();
      this.savingSecret.set(null);
    }
  }

  // ── Connection test ─────────────────────────────────────────────────────────

  /** Latest connection-test outcome (drives the status pill in Settings). */
  readonly connectionTest = signal<'untested' | 'testing' | 'ok' | 'auth-failed' | 'unreachable'>(
    'untested',
  );

  /**
   * Probes the configured worker with `GET /status` on the `default`
   * instance. Distinguishes auth failures from unreachable hosts so the
   * settings pill can say something actionable.
   */
  async testConnection(): Promise<void> {
    const base = this.effectiveWorkerUrl();
    if (!base) {
      this.toast.warning('Set the worker URL', 'Enter your deployed worker URL first.');
      return;
    }
    this.connectionTest.set('testing');
    try {
      const response = await fetch(`${base}/agents/workflow-agent/default/status`, {
        headers: await this.headers(),
      });
      if (response.status === 401 || response.status === 403) {
        this.connectionTest.set('auth-failed');
        return;
      }
      this.connectionTest.set(response.ok ? 'ok' : 'unreachable');
    } catch {
      this.connectionTest.set('unreachable');
    }
  }

  // ── Push the active workflow spec ──────────────────────────────────────────

  /**
   * Materializes the application default model into agents that inherit it.
   * The cloud runtime has no access to the studio's settings, so inherited
   * provider/model values are resolved into the spec at push time.
   */
  private materializeDefaults(spec: WorkflowSpec): WorkflowSpec {
    const resolved = structuredClone(spec);
    const graphs = [
      resolved.graph,
      ...Object.values(resolved.subWorkflows ?? {}).map(workflow => workflow.graph),
    ];
    for (const graph of graphs) {
      // Deployed runs can't reach the studio libraries. Refresh skills and
      // materialize inherited models in every graph in the embedded closure.
      this.skillsLibrary.syncAttachedSkills(graph);
      for (const node of graph.nodes) {
        if (!isAgentNode(node)) continue;
        if (!node.data.provider || !node.data.model) {
          node.data.provider = this.settings.defaultProvider();
          node.data.model = this.settings.defaultModel();
          node.data.temperature ??= this.settings.defaultTemperature();
        }
      }
    }
    return resolved;
  }

  /**
   * Uploads the active spec to its WorkflowAgent instance. Resolves true only
   * when the worker accepted it - callers that need the outcome (the studio
   * assistant's deploy action) must not infer success from the absence of a
   * throw, because every failure path here is a toast.
   */
  async pushWorkflow(): Promise<boolean> {
    if (this.workflow.activeDoc()?.readOnly) {
      this.toast.warning('Preview is read-only', 'Restore this version before pushing it to the cloud.');
      return false;
    }
    const rawSpec = this.workflow.exportActiveSpec();
    if (!rawSpec) return false;
    const spec = this.materializeDefaults(rawSpec);
    const base = this.instanceUrl(spec.id);
    if (!base) {
      this.toast.warning('Set the worker URL', 'Enter your deployed worker URL first.');
      return false;
    }

    try {
      // Requirement 3.6: the worker's connection inventory comes ONLY from
      // this dedicated route — names, types and auth modes, never a secret
      // value. Pushed before validation so the Capability_Validator checks
      // the SAME inventory `WorkerConnectionStore` will resolve against.
      await this.pushConnectionMetadata(base);

      // Requirement 17.11: validate against Worker_Host's own capability
      // record and its own connection inventory, after default materialisation
      // and before the deployment request. Any error finding aborts the push.
      const connections = await this.fetchConnectionInventory(base);
      const findings = validateAgainstCapabilities(spec, CLOUDFLARE_CAPABILITIES, connections);
      const errors = findings.filter(finding => finding.severity === 'error');
      if (errors.length > 0) {
        this.reportCapabilityFindings(findings);
        this.toast.error(
          'Push aborted',
          `${errors.length} problem${errors.length === 1 ? '' : 's'} would prevent this workflow ` +
            `from running on ${CLOUDFLARE_CAPABILITIES.label}. See the Problems console.`,
        );
        return false;
      }

      const response = await fetch(`${base}/workflow`, {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify(spec),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `HTTP ${response.status}`);
      }
      await this.versions.recordDeploy(rawSpec).catch(() => undefined);
      this.deployedStatus.set({ hasWorkflow: true, savedAt: new Date().toISOString() });
      this.deployedStatusWorkflowId.set(spec.id);
      this.toast.success('Workflow pushed', `"${spec.name}" is live in the cloud.`);
      return true;
    } catch (error) {
      this.toast.error('Push failed', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * Pushes every locally known connection's METADATA to the worker's
   * dedicated route (Requirements 2.2, 3.6): names, types, non-secret
   * `config` and `secretKeys` NAMES only — never a secret value. The worker
   * pairs each entry with its own `CONN_*` secrets at resolve time.
   */
  private async pushConnectionMetadata(base: string): Promise<void> {
    const summaries = await this.connectionStore.list();
    const connections = summaries.map(toConnectionMetadata);
    const response = await fetch(`${base}/connections`, {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify({ connections }),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(detail?.error ?? `Could not push connection metadata (HTTP ${response.status}).`);
    }
  }

  /**
   * Reads back the Worker_Host connection inventory — the same
   * `ConnectionSummary[]` `WorkerConnectionStore.list()` produces, carrying
   * secret-present counts and no secret value — for push-time validation
   * (Requirement 17.11).
   */
  private async fetchConnectionInventory(base: string): Promise<ConnectionSummary[]> {
    const response = await fetch(`${base}/connections`, { headers: await this.headers() });
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(
        detail?.error ?? `Could not read the worker's connection inventory (HTTP ${response.status}).`,
      );
    }
    const body = (await response.json()) as { connections?: ConnectionSummary[] };
    return Array.isArray(body.connections) ? body.connections : [];
  }

  /** Every returned finding, oldest first, into the Problems console. */
  private reportCapabilityFindings(findings: { severity: 'error' | 'warning'; message: string }[]): void {
    this.terminal.open('problems');
    for (const finding of findings) {
      this.terminal.append('problems', finding.severity === 'error' ? 'error' : 'warning', finding.message);
    }
  }

  // ── Deployment status ─────────────────────────────────────────────────────

  /**
   * Reads whether `workflowId` currently has a deployed spec on the active
   * provider's instance, for the Cloud dialog's status indicator. Leaves
   * {@link deployedStatus} at `null` (unknown) rather than claiming "not
   * deployed" when the worker cannot be reached.
   */
  async refreshStatus(workflowId: string): Promise<void> {
    const base = this.instanceUrl(workflowId);
    if (!base || !this.configured()) {
      this.deployedStatus.set(null);
      this.deployedStatusWorkflowId.set(null);
      return;
    }
    this.statusLoading.set(true);
    try {
      const response = await fetch(`${base}/status`, { headers: await this.headers() });
      if (!response.ok) {
        this.deployedStatus.set(null);
        this.deployedStatusWorkflowId.set(null);
        return;
      }
      const body = (await response.json()) as { hasWorkflow?: boolean; savedAt?: string | null };
      this.deployedStatus.set({ hasWorkflow: body.hasWorkflow === true, savedAt: body.savedAt ?? null });
      this.deployedStatusWorkflowId.set(workflowId);
    } catch {
      this.deployedStatus.set(null);
      this.deployedStatusWorkflowId.set(null);
    } finally {
      this.statusLoading.set(false);
    }
  }

  /**
   * Fully tears down `workflowId`'s deployed instance in Phorma Cloud (the
   * Cloud dialog's "Remove from cloud" action, and the library-delete path).
   * Cancels cron, unpublishes the portal, deletes tracked portal session
   * Durable Objects, wipes every SQLite table (runs, events, usage ledger,
   * workflow state + fixtures) and calls `storage.deleteAll()` so the instance
   * itself can be reclaimed. Connection secrets in the per-tenant vault are
   * untouched (they may be shared across workflows) and D1 usage rows are
   * retained for billing. Returns true on success; surfaces a toast on error.
   */
  async removeWorkflow(workflowId: string): Promise<boolean> {
    const base = this.instanceUrl(workflowId);
    if (!base) return false;
    try {
      const response = await fetch(`${base}/workflow/purge`, {
        method: 'DELETE',
        headers: await this.headers(),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `Could not remove the workflow (HTTP ${response.status}).`);
      }
      this.deployedStatus.set({ hasWorkflow: false, savedAt: null });
      this.deployedStatusWorkflowId.set(workflowId);
      this.versions.unmarkDeployed(workflowId);
      this.toast.success('Removed from cloud', `"${this.workflow.activeName()}" is no longer deployed.`);
      return true;
    } catch (error) {
      this.toast.error('Remove failed', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * Best-effort cloud teardown for the library-delete path. Refreshes the
   * deployment status for `workflowId` and, if the workflow is currently
   * deployed, calls {@link removeWorkflow} to fully purge it. Never throws:
   * a cloud that is unreachable, unconfigured, or returns an error (for example
   * a 409 while a run is in progress) only logs a warning toast so the local
   * delete still completes. Returns true when nothing needed cleanup or
   * cleanup succeeded; false when cleanup was needed but failed (the caller
   * may warn the user to remove the workflow from Phorma Cloud manually).
   */
  async purgeIfDeployed(workflowId: string): Promise<boolean> {
    if (!this.configured()) return true;
    try {
      await this.refreshStatus(workflowId);
    } catch {
      // refreshStatus already swallows errors and sets status to null; reaching
      // here is exceptional and means we cannot determine deployment state.
      return true;
    }
    const status = this.deployedStatus();
    if (!status?.hasWorkflow) return true;
    const removed = await this.removeWorkflow(workflowId);
    if (!removed) {
      this.toast.warning(
        'Cloud cleanup failed',
        `"${this.workflow.activeName()}" could not be removed from Phorma Cloud. Remove it manually from the Cloud dialog.`,
      );
    }
    return removed;
  }

  // ── Run history (EPIC 1) ──────────────────────────────────────────────────

  /**
   * Lists the deployed workflow's persisted runs from its Durable Object.
   * Returns null when the workflow was never pushed (404) or the worker is
   * unreachable - callers render local history only in that case.
   */
  async listRuns(
    workflowId: string,
  ): Promise<{ runs: RunRecordSummary[]; activeRunId: string | null } | null> {
    const base = this.instanceUrl(workflowId);
    if (!base || !this.configured()) return null;
    try {
      const response = await fetch(`${base}/runs`, { headers: await this.headers() });
      if (!response.ok) return null;
      return (await response.json()) as { runs: RunRecordSummary[]; activeRunId: string | null };
    } catch {
      return null;
    }
  }

  /**
   * Fetches the deployed workflow's usage ledger (EPIC 2) - per-run usage
   * rows that survive run-history pruning. Null when unreachable/never
   * pushed, same contract as {@link listRuns}.
   */
  async fetchUsage(workflowId: string, since = 0): Promise<UsageLedgerEntry[] | null> {
    const base = this.instanceUrl(workflowId);
    if (!base || !this.configured()) return null;
    try {
      const response = await fetch(`${base}/usage?since=${since}`, {
        headers: await this.headers(),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { usage?: UsageLedgerEntry[] };
      return body.usage ?? [];
    } catch {
      return null;
    }
  }

  // ── Portal (EPIC 9) ────────────────────────────────────────────────────────

  /**
   * Reads the deployed workflow's publish record and publish-readiness.
   * Returns null when the worker is unreachable or the workflow was never
   * pushed, same contract as {@link listRuns}.
   */
  async fetchPortal(workflowId: string): Promise<PortalStatusResponse | null> {
    return this.portalRequest<PortalStatusResponse>(workflowId, 'portal', 'GET');
  }

  /**
   * Publishes the pushed spec's portal trigger. The worker re-validates, so a
   * stale studio state cannot publish a broken portal.
   */
  async publishPortal(workflowId: string): Promise<PortalPublishResponse | null> {
    return this.portalRequest<PortalPublishResponse>(workflowId, 'publish', 'POST');
  }

  /** Takes the portal offline. The slug is released for reuse. */
  async unpublishPortal(workflowId: string): Promise<{ ok: boolean; removed?: string[] } | null> {
    return this.portalRequest(workflowId, 'unpublish', 'POST');
  }

  /**
   * Mints a scoped access key. The plaintext comes back exactly ONCE - show it
   * to the user immediately, because the worker only stores its hash.
   */
  async mintPortalToken(workflowId: string, label: string): Promise<PortalMintResponse | null> {
    return this.portalRequest<PortalMintResponse>(workflowId, 'portal-tokens', 'POST', { label });
  }

  /** Revokes one access key by id. */
  async revokePortalToken(workflowId: string, tokenId: string): Promise<{ ok: boolean } | null> {
    return this.portalRequest(
      workflowId,
      `portal-tokens/${encodeURIComponent(tokenId)}`,
      'DELETE',
    );
  }

  /**
   * Portal-sourced runs. Portal runs execute in per-visitor session instances,
   * so the owner instance mirrors their summaries here.
   */
  async listPortalRuns(workflowId: string): Promise<RunRecordSummary[] | null> {
    const body = await this.portalRequest<{ runs?: RunRecordSummary[] }>(
      workflowId,
      'portal-runs',
      'GET',
    );
    return body ? (body.runs ?? []) : null;
  }

  /**
   * The public address a published portal is served from.
   *
   * A custom portal domain wins when set. Note this is deliberately NOT the
   * same as {@link effectiveWorkerUrl}, which also carries the PRIVATE control
   * plane (push, monitor, run history) - those must keep using the worker URL
   * so owner traffic never rides a public marketing domain.
   */
  portalUrl(slug: string): string | null {
    if (!slug) return null;
    // Own-Cloudflare only: a Phorma Cloud portal lives on our own host.
    if (this.provider() !== 'phorma') {
      const domain = this.deployConfig.portalDomain();
      if (domain) return `https://${domain}/p/${slug}`;
    }
    const base = this.effectiveWorkerUrl();
    return base ? `${base}/p/${slug}` : null;
  }

  /**
   * Shared plumbing for the owner-side portal routes. Throws with the worker's
   * message on a 4xx/5xx so callers can surface it; returns null only when the
   * worker is unreachable or unconfigured.
   */
  private async portalRequest<T>(
    workflowId: string,
    action: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
  ): Promise<T | null> {
    const base = this.instanceUrl(workflowId);
    if (!base || !this.configured()) return null;
    let response: Response;
    try {
      response = await fetch(`${base}/${action}`, {
        method,
        headers: await this.headers(),
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      });
    } catch {
      return null;
    }
    const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!response.ok) {
      throw new Error(payload?.error ?? `HTTP ${response.status}`);
    }
    return payload;
  }

  /** Fetches one full cloud RunRecord (detail view / Bring to Canvas). */
  async fetchRunRecord(workflowId: string, runId: string): Promise<RunRecord | null> {
    const base = this.instanceUrl(workflowId);
    if (!base) return null;
    try {
      const response = await fetch(`${base}/runs/${encodeURIComponent(runId)}`, {
        headers: await this.headers(),
      });
      if (!response.ok) return null;
      return (await response.json()) as RunRecord;
    } catch {
      return null;
    }
  }

  // ── Monitor (WebSocket → RunControllerService.apply) ───────────────────────

  /**
   * Connects the monitor WebSocket. Defaults to the active workflow; pass a
   * `workflowId` to attach to a specific deployed workflow's live run (the
   * DO replays the in-flight run's events, then sends a `monitor-synced`
   * sentinel before live events continue).
   */
  async connect(workflowId?: string): Promise<void> {
    const spec = this.workflow.exportActiveSpec();
    const targetId = workflowId ?? spec?.id ?? '';
    const targetName = workflowId ?? spec?.name ?? 'workflow';
    const base = this.instanceUrl(targetId);
    if (!targetId || !base) {
      this.toast.warning('Set the worker URL', 'Enter your deployed worker URL first.');
      return;
    }
    this.disconnect();

    const wsUrl = new URL(base.replace(/^http/, 'ws'));
    const authToken = await this.resolveAuthToken();
    if (authToken) wsUrl.searchParams.set('token', authToken);

    this.connection.set('connecting');
    const socket = new WebSocket(wsUrl);
    this.socket = socket;

    socket.onopen = () => {
      this.connection.set('connected');
      this.runController.remoteApprovalSender = (requestId, approved) =>
        this.approveRemote(requestId, approved);
      this.runController.remoteEventSender = (correlationKey, payload) =>
        this.sendEventRemote(correlationKey, payload);
      this.runController.remoteQuestionSender = (requestId, response) =>
        this.answerQuestionRemote(requestId, response);
      this.terminal.append('run', 'success', `Cloud monitor connected (${targetName}).`);
    };
    socket.onmessage = message => {
      try {
        const event = JSON.parse(message.data as string) as RunEvent | { type: 'monitor-synced' };
        // The replay-complete sentinel is monitor plumbing, not a run event.
        if (event.type === 'monitor-synced') return;
        this.runController.apply(event);
      } catch {
        // Ignore non-event frames.
      }
    };
    socket.onclose = event => {
      if (this.socket === socket) {
        this.socket = null;
        this.connection.set('disconnected');
        if (event.code === 4001) {
          this.toast.error('Cloud monitor rejected', 'Token mismatch - check the Cloud dialog.');
        }
      }
    };
    socket.onerror = () => {
      if (this.socket === socket) {
        this.toast.error('Cloud monitor error', 'Could not reach the worker WebSocket.');
      }
    };
  }

  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    this.connection.set('disconnected');
    this.runController.remoteApprovalSender = null;
    this.runController.remoteEventSender = null;
    this.runController.remoteQuestionSender = null;
    socket?.close();
  }

  // ── Remote run control (over the socket) ───────────────────────────────────
  /**
   * Triggers a run over HTTP (no monitor socket required) - used by the
   * eval runner (EPIC 4), which polls `listRuns` for completion instead of
   * listening on the WebSocket. Throws on rejection (409 busy, 402 quota…).
   */
  async triggerHttp(
    workflowId: string,
    input: string,
    source?: 'eval',
  ): Promise<{ runId: string }> {
    const base = this.instanceUrl(workflowId);
    if (!base || !this.configured()) throw new Error('Cloud worker is not configured.');
    const response = await fetch(`${base}/trigger`, {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify({ input, ...(source ? { source } : {}) }),
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      runId?: string;
      error?: string;
    } | null;
    if (!response.ok || !body?.ok || !body.runId) {
      throw new Error(body?.error ?? `Trigger failed (HTTP ${response.status}).`);
    }
    return { runId: body.runId };
  }
  triggerRemote(input: string): void {
    if (!this.send({ type: 'trigger', input })) {
      this.toast.warning('Not connected', 'Connect the cloud monitor first.');
    }
  }

  stopRemote(): void {
    this.send({ type: 'stop' });
  }

  approveRemote(requestId: string, approved: boolean): void {
    this.send({ type: 'approval', requestId, approved });
  }

  /** Answers a suspended Ask-User node over the WebSocket monitor. */
  answerQuestionRemote(requestId: string, response: string): void {
    this.send({ type: 'question', requestId, response });
  }

  /** Delivers an external event to a suspended Wait-for-Event node remotely. */
  sendEventRemote(correlationKey: string, payload: string): void {
    this.send({ type: 'event', correlationKey, payload });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private send(frame: object): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  /** Instance URL for a workflow id: {worker}/agents/workflow-agent/{id}. */
  private instanceUrl(workflowId: string): string | null {
    const base = this.effectiveWorkerUrl();
    if (!base || !workflowId) return base ? `${base}/agents/workflow-agent/default` : null;
    return `${base}/agents/workflow-agent/${encodeURIComponent(workflowId)}`;
  }

  private async headers(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = await this.resolveAuthToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
  }

  /**
   * Resolves the bearer token to send to the cloud worker. Prefers a fresh
   * Clerk session JWT when the user is signed in. Own-Cloudflare deployments
   * may fall back to the static PHORMA_TOKEN; Phorma Cloud is Clerk-only.
   */
  private async resolveAuthToken(): Promise<string | null> {
    const clerk = await firstValueFrom(this.clerk.clerk$);
    const session = await firstValueFrom(this.clerk.session$);
    if (clerk && session) {
      try {
        const jwt = await session.getToken();
        if (jwt) return jwt;
      } catch {
        // Token refresh failed - fall through to static token.
      }
    }
    if (this.provider() === 'phorma') return null; // never send the static token
    return this.token() || null;
  }
}
