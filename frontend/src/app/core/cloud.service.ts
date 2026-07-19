import { Injectable, computed, inject, signal } from '@angular/core';
import { ClerkService } from 'ngx-clerk';
import { firstValueFrom } from 'rxjs';

import type { RunEvent, RunRecord, RunRecordSummary, UsageLedgerEntry } from '@phorma/engine';

import { RunControllerService } from './run-controller.service';
import { SettingsService } from './settings.service';
import { TauriService } from './tauri.service';
import { TerminalOutputService } from './terminal-output.service';
import { WorkflowService } from './workflow.service';
import { loadLayout, saveLayout } from './layout-storage';
import { ToastService } from '../shared/toast/toast.service';
import { isAgentNode, type WorkflowSpec } from './workflow.model';

export type CloudConnectionState = 'disconnected' | 'connecting' | 'connected';

/** Default Phorma Cloud runtime URL (override via the hidden setting). */
export const PHORMA_CLOUD_DEFAULT_URL = 'https://dev.phoma-labs.com';

/**
 * The studio's bridge to the deployed cloud runtime.
 *
 * - **Deploy**: streams `npx wrangler deploy` (run by the Rust backend inside
 *   the repo's `cloud/` folder) into the console.
 * - **Push**: uploads the active workflow spec to its WorkflowAgent instance.
 * - **Monitor**: a WebSocket whose RunEvents feed the SAME
 *   `RunControllerService.apply()` path as local runs — cloud runs animate
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
  private readonly clerk = inject(ClerkService);

  /** Worker base URL, e.g. https://phorma-agent-studio-cloud.you.workers.dev */
  readonly workerUrl = signal(loadLayout('cloudWorkerUrl', ''));
  /** Bearer token matching the worker's PHORMA_TOKEN secret (optional). */
  readonly token = signal(loadLayout('cloudToken', ''));
  /** Absolute path of the repo's cloud/ folder (deploy runs wrangler there). */
  readonly cloudFolder = signal(loadLayout('cloudFolder', ''));
  /** Phorma Cloud base URL (configurable for staging; defaults to prod). */
  readonly phormaCloudUrl = signal(loadLayout('phormaCloudUrl', PHORMA_CLOUD_DEFAULT_URL));

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
    this.phormaCloudUrl.set(url.trim().replace(/\/$/, '') || PHORMA_CLOUD_DEFAULT_URL);
    saveLayout('phormaCloudUrl', this.phormaCloudUrl());
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

  // ── Deploy (desktop only — spawns wrangler via Rust) ───────────────────────

  async deploy(): Promise<void> {
    if (!this.tauri.isDesktop) {
      this.toast.warning('Desktop only', 'Deploying runs wrangler locally — use the desktop app.');
      return;
    }
    const cwd = this.cloudFolder();
    if (!cwd) {
      this.toast.warning('Set the cloud folder', "Pick the repo's cloud/ folder first.");
      return;
    }
    if (this.deploying()) return;

    this.deploying.set(true);
    this.deployCounter += 1;
    const requestId = `deploy-${this.deployCounter}`;
    this.terminal.open('run');
    this.terminal.append('run', 'info', '$ npx wrangler deploy');

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
        { requestId, cwd, program: 'npx', args: ['wrangler', 'deploy'] },
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

  // ── Worker secrets (desktop only — wrangler secret put via Rust) ───────────

  /** Secret name currently being saved (drives per-row button spinners). */
  readonly savingSecret = signal<string | null>(null);

  /**
   * Sets a secret on the user's deployed worker via
   * `npx wrangler secret put <NAME>`. The value travels through the Rust
   * backend into wrangler's stdin — never through argv or the console.
   */
  async putWorkerSecret(name: string, value: string): Promise<void> {
    if (!this.tauri.isDesktop) {
      this.toast.warning('Desktop only', 'Setting secrets runs wrangler locally — use the desktop app.');
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
    for (const node of resolved.graph.nodes) {
      if (!isAgentNode(node)) continue;
      if (!node.data.provider || !node.data.model) {
        node.data.provider = this.settings.defaultProvider();
        node.data.model = this.settings.defaultModel();
        node.data.temperature ??= this.settings.defaultTemperature();
      }
    }
    return resolved;
  }

  async pushWorkflow(): Promise<void> {
    const rawSpec = this.workflow.exportActiveSpec();
    if (!rawSpec) return;
    const spec = this.materializeDefaults(rawSpec);
    const base = this.instanceUrl(spec.id);
    if (!base) {
      this.toast.warning('Set the worker URL', 'Enter your deployed worker URL first.');
      return;
    }

    try {
      const response = await fetch(`${base}/workflow`, {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify(spec),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `HTTP ${response.status}`);
      }
      this.toast.success('Workflow pushed', `"${spec.name}" is live in the cloud.`);
    } catch (error) {
      this.toast.error('Push failed', error instanceof Error ? error.message : String(error));
    }
  }

  // ── Run history (EPIC 1) ──────────────────────────────────────────────────

  /**
   * Lists the deployed workflow's persisted runs from its Durable Object.
   * Returns null when the workflow was never pushed (404) or the worker is
   * unreachable — callers render local history only in that case.
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
   * Fetches the deployed workflow's usage ledger (EPIC 2) — per-run usage
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
      this.runController.remoteApprovalSender = (nodeId, approved) =>
        this.approveRemote(nodeId, approved);
      this.runController.remoteEventSender = (correlationKey, payload) =>
        this.sendEventRemote(correlationKey, payload);
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
          this.toast.error('Cloud monitor rejected', 'Token mismatch — check the Cloud dialog.');
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
    socket?.close();
  }

  // ── Remote run control (over the socket) ───────────────────────────────────
  /**
   * Triggers a run over HTTP (no monitor socket required) — used by the
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

  approveRemote(nodeId: string, approved: boolean): void {
    this.send({ type: 'approval', nodeId, approved });
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
        // Token refresh failed — fall through to static token.
      }
    }
    if (this.provider() === 'phorma') return null; // never send the static token
    return this.token() || null;
  }
}
