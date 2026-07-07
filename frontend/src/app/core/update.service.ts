import { Injectable, inject, signal, computed } from '@angular/core';

import { TauriService } from './tauri.service';
import { SettingsService } from './settings.service';

/**
 * VS Code-style auto-updater for the desktop shell.
 *
 * On launch (and every few hours) the service asks the Tauri updater plugin
 * whether a newer signed bundle is published at the configured endpoint. When
 * automatic updates are on (the default) the new bundle is downloaded in the
 * background and a "restart to update" badge appears in the status bar once
 * it is ready; otherwise the badge appears at the "update available" stage
 * and the user triggers the download explicitly.
 *
 * Web mode (`ng serve`) never executes any of this - every entry point is
 * guarded by `TauriService.isDesktop`, matching the repo convention that
 * native code paths stay dormant in the browser.
 */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  private readonly tauri = inject(TauriService);
  private readonly settings = inject(SettingsService);

  /** Latest available update, or `null` when the app is current. */
  readonly available = signal<{ version: string; date?: string; body?: string } | null>(null);

  /** `true` while a bundle is being downloaded in the background. */
  readonly downloading = signal(false);

  /** Download progress as a 0-1 fraction (best-effort; not all platforms emit). */
  readonly progress = signal(0);

  /** `true` once the new bundle is staged and a restart will install it. */
  readonly readyToRestart = signal(false);

  /** Last error message from check/download, surfaced in the badge tooltip. */
  readonly error = signal<string | null>(null);

  /** Whether the update badge should be visible in the status bar. */
  readonly badgeVisible = computed(
    () => this.available() !== null || this.downloading() || this.readyToRestart(),
  );

  private timer?: ReturnType<typeof setInterval>;
  private activeDownload?: { downloadAndInstall: () => Promise<void> };

  /** Starts the periodic check loop. Safe to call in web mode (no-op). */
  start(): void {
    if (!this.tauri.isDesktop) return;
    void this.check();
    // Re-check every 4 hours; the endpoint is cheap (204 when current).
    this.timer = setInterval(() => void this.check(), 4 * 60 * 60 * 1000);
  }

  /** Stops the periodic check loop (e.g. on app teardown). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Checks the update endpoint for a newer version. When automatic updates
   * are enabled and an update exists, begins downloading immediately.
   */
  async check(): Promise<void> {
    if (!this.tauri.isDesktop) return;
    this.error.set(null);
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (!update) {
        this.available.set(null);
        this.readyToRestart.set(false);
        return;
      }
      this.available.set({
        version: update.version,
        date: update.date,
        body: update.body,
      });
      this.activeDownload = update;
      if (this.settings.autoUpdate()) {
        await this.download();
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Downloads (and, when auto-update is on, stages) the pending update.
   * Emits progress events to {@link progress}. Safe to call from the badge
   * click handler when the user opts in manually.
   */
  async download(): Promise<void> {
    if (!this.activeDownload || this.downloading()) return;
    this.downloading.set(true);
    this.progress.set(0);
    this.error.set(null);
    try {
      // downloadAndInstall stages the bundle; the actual swap happens on relaunch.
      // Progress events are emitted via the plugin's event listener (set up below).
      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen<{ total: number; downloaded: number }>(
        'tauri://update-download-progress',
        e => {
          const { total, downloaded } = e.payload;
          if (total > 0) this.progress.set(Math.min(1, downloaded / total));
        },
      );
      await this.activeDownload.downloadAndInstall();
      unlisten();
      this.progress.set(1);
      this.readyToRestart.set(true);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.downloading.set(false);
    }
  }

  /**
   * Installs the staged update and relaunches the app. Called from the
   * "restart to update" badge action.
   */
  async installAndRelaunch(): Promise<void> {
    if (!this.tauri.isDesktop) return;
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }
}
