/**
 * Materializes the deploy runtime that ships inside the installer.
 *
 * A BYO deploy runs a CLI (`wrangler` for Cloudflare, `phorma-aws` for AWS) with
 * its working directory set to a package that carries the runtime source. That
 * package used to have to be a checkout of the Phorma repository, which a
 * production install does not have. It now ships as a Tauri resource:
 * `prepare_deploy_workspace` copies it into the app data folder, and this service
 * installs its npm dependencies the first time, then stamps the app version so an
 * app update reinstalls exactly once.
 *
 * The returned path is what the caller stores as the deploy folder. This service
 * writes no setting itself - `CloudService` and `AwsDeployConfigService` own their
 * own fields, and injecting either here would put a cloud service on a path that
 * has a documented DI cycle hazard.
 */
import { Injectable, computed, inject, signal } from '@angular/core';

import { TauriService } from '../tauri.service';
import { TerminalOutputService } from '../terminal-output.service';
import { ToastService } from '../../shared/toast/toast.service';

/** The two runtime packages the installer carries. */
export type DeployWorkspaceTarget = 'cloud' | 'cloud-aws';

/** Filename of the stamp that records which app version was installed. */
export const RUNTIME_VERSION_STAMP = '.phorma-runtime-version';

/** What `prepare_deploy_workspace` reports back. */
interface PreparedWorkspace {
  path: string;
  version: string;
  dependenciesReady: boolean;
}

@Injectable({ providedIn: 'root' })
export class DeployWorkspaceService {
  private readonly tauri = inject(TauriService);
  private readonly terminal = inject(TerminalOutputService);
  private readonly toast = inject(ToastService);

  /** The target being prepared, or null when idle. */
  readonly preparing = signal<DeployWorkspaceTarget | null>(null);

  /** True while any target is being prepared. */
  readonly busy = computed(() => this.preparing() !== null);

  private commandCounter = 0;

  /**
   * Copies the bundled runtime for `target` into the app data folder and installs
   * its dependencies when they are missing or belong to an older app version.
   *
   * @returns The absolute workspace path, or null when it could not be prepared.
   */
  async prepare(target: DeployWorkspaceTarget): Promise<string | null> {
    if (!this.tauri.isDesktop) {
      this.toast.warning(
        'Desktop only',
        'Setting up the deploy runtime writes to disk and runs npm - use the desktop app.',
      );
      return null;
    }
    if (this.preparing()) return null;

    this.preparing.set(target);
    this.terminal.open('run');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const workspace = await invoke<PreparedWorkspace>('prepare_deploy_workspace', { target });
      this.terminal.append(
        'run',
        'info',
        `Deploy runtime ${workspace.version} unpacked to ${workspace.path}`,
      );

      if (workspace.dependenciesReady) {
        this.toast.success('Deploy runtime ready', 'Dependencies are already installed.');
        return workspace.path;
      }

      return (await this.installDependencies(workspace)) ? workspace.path : null;
    } catch (error) {
      this.toast.error(
        'Could not set up the deploy runtime',
        error instanceof Error ? error.message : String(error),
      );
      return null;
    } finally {
      this.preparing.set(null);
    }
  }

  /**
   * Runs `npm install` in the workspace and, on success, stamps the app version
   * so the next prepare skips it.
   *
   * The stamp is written only AFTER a zero exit: a half-installed tree that
   * claimed to be ready would fail later, inside a deploy, where the cause is far
   * less obvious.
   */
  private async installDependencies(workspace: PreparedWorkspace): Promise<boolean> {
    this.terminal.append('run', 'info', '$ npm install');
    const result = await this.runInstall(workspace.path);
    if (!result.success) {
      this.toast.error(
        'Dependency install failed',
        `npm exited with code ${result.exitCode ?? '?'}. The console has the output.`,
      );
      return false;
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const separator = workspace.path.includes('\\') ? '\\' : '/';
      await invoke('write_workflow_file', {
        path: `${workspace.path}${separator}${RUNTIME_VERSION_STAMP}`,
        content: `${workspace.version}\n`,
      });
    } catch {
      // A missing stamp only costs one redundant install next time, so it is not
      // worth failing a successful setup over.
      this.terminal.append('run', 'warning', 'Could not record the runtime version.');
    }

    this.toast.success('Deploy runtime ready', 'Dependencies installed.');
    return true;
  }

  /** Streams `npm install` output into the run console. */
  private async runInstall(cwd: string): Promise<{ success: boolean; exitCode: number | null }> {
    this.commandCounter += 1;
    const requestId = `deploy-workspace-${this.commandCounter}`;

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
      return await invoke<{ success: boolean; exitCode: number | null }>('run_streamed_command', {
        requestId,
        cwd,
        program: 'npm',
        args: ['install', '--no-audit', '--no-fund'],
      });
    } finally {
      unlisten();
    }
  }
}
