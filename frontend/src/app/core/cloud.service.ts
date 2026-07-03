import { Injectable, computed, inject, signal } from '@angular/core';

import type { RunEvent } from '@phorma/engine';

import { RunControllerService } from './run-controller.service';
import { TauriService } from './tauri.service';
import { TerminalOutputService } from './terminal-output.service';
import { WorkflowService } from './workflow.service';
import { loadLayout, saveLayout } from './layout-storage';
import { ToastService } from '../shared/toast/toast.service';

export type CloudConnectionState = 'disconnected' | 'connecting' | 'connected';

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

  /** Worker base URL, e.g. https://phorma-agent-studio-cloud.you.workers.dev */
  readonly workerUrl = signal(loadLayout('cloudWorkerUrl', ''));
  /** Bearer token matching the worker's PHORMA_TOKEN secret (optional). */
  readonly token = signal(loadLayout('cloudToken', ''));
  /** Absolute path of the repo's cloud/ folder (deploy runs wrangler there). */
  readonly cloudFolder = signal(loadLayout('cloudFolder', ''));

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

  // ── Push the active workflow spec ──────────────────────────────────────────

  async pushWorkflow(): Promise<void> {
    const spec = this.workflow.exportActiveSpec();
    if (!spec) return;
    const base = this.instanceUrl(spec.id);
    if (!base) {
      this.toast.warning('Set the worker URL', 'Enter your deployed worker URL first.');
      return;
    }

    try {
      const response = await fetch(`${base}/workflow`, {
        method: 'POST',
        headers: this.headers(),
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

  // ── Monitor (WebSocket → RunControllerService.apply) ───────────────────────

  connect(): void {
    const spec = this.workflow.exportActiveSpec();
    const base = this.instanceUrl(spec?.id ?? '');
    if (!spec || !base) {
      this.toast.warning('Set the worker URL', 'Enter your deployed worker URL first.');
      return;
    }
    this.disconnect();

    const wsUrl = new URL(base.replace(/^http/, 'ws'));
    if (this.token()) wsUrl.searchParams.set('token', this.token());

    this.connection.set('connecting');
    const socket = new WebSocket(wsUrl);
    this.socket = socket;

    socket.onopen = () => {
      this.connection.set('connected');
      this.runController.remoteApprovalSender = (nodeId, approved) =>
        this.approveRemote(nodeId, approved);
      this.terminal.append('run', 'success', `Cloud monitor connected (${spec.name}).`);
    };
    socket.onmessage = message => {
      try {
        const event = JSON.parse(message.data as string) as RunEvent;
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
    socket?.close();
  }

  // ── Remote run control (over the socket) ───────────────────────────────────

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

  // ── Helpers ────────────────────────────────────────────────────────────────

  private send(frame: object): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  /** Instance URL for a workflow id: {worker}/agents/workflow-agent/{id}. */
  private instanceUrl(workflowId: string): string | null {
    const base = this.workerUrl();
    if (!base || !workflowId) return base ? `${base}/agents/workflow-agent/default` : null;
    return `${base}/agents/workflow-agent/${encodeURIComponent(workflowId)}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token()) headers['Authorization'] = `Bearer ${this.token()}`;
    return headers;
  }
}
