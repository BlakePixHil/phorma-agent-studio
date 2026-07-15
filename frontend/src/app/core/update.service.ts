import { Injectable, inject, signal, computed } from '@angular/core';

import { TauriService } from './tauri.service';
import { SettingsService } from './settings.service';
import { ConfirmDialogService } from '../shared/confirm-dialog/confirm-dialog.service';
import { loadLayout, saveLayout } from './layout-storage';

/**
 * Minimal surface of the plugin's `Update` resource that this service uses.
 * Kept as a local type so the plugin module stays a lazy dynamic import.
 */
interface ActiveUpdate {
  version: string;
  date?: string;
  body?: string;
  download(onEvent?: (progress: UpdaterDownloadEvent) => void): Promise<void>;
  install(): Promise<void>;
}

type UpdaterDownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

/** localStorage key (via layout-storage) holding a version string to install silently on next launch. */
const INSTALL_ON_NEXT_LAUNCH_KEY = 'updateOnNextLaunch';

/**
 * VS Code-style auto-updater for the desktop shell.
 *
 * The update lifecycle is deliberately split so the app NEVER surprises the
 * user with an installer window:
 *
 *  1. `check()` (on launch + every 4h) asks the endpoint for a newer signed
 *     bundle. Finding one only flips {@link available} — nothing installs.
 *  2. With auto-update ON, the bundle downloads in the background
 *     (`download()`), then the user is asked: restart now, or install on the
 *     next launch. Install NEVER runs unprompted mid-session.
 *  3. "Restart now" (or the toolbar Update button) runs `install()` +
 *     relaunch. The Windows installer runs in `quiet` mode
 *     (see tauri.conf.json `plugins.updater.windows.installMode`), so there
 *     is no visible installer UI — the app just restarts on the new version.
 *  4. "On next launch" persists the version; the next `check()` at startup
 *     sees the flag, silently downloads + installs, and the app reopens
 *     up-to-date. The toolbar Update button stays visible meanwhile so the
 *     user can update sooner.
 *
 * Web mode (`ng serve`) never executes any of this — every entry point is
 * guarded by `TauriService.isDesktop`, matching the repo convention that
 * native code paths stay dormant in the browser.
 */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  private readonly tauri = inject(TauriService);
  private readonly settings = inject(SettingsService);
  private readonly confirmDialog = inject(ConfirmDialogService);

  /** Latest available update, or `null` when the app is current. */
  readonly available = signal<{ version: string; date?: string; body?: string } | null>(null);

  /** `true` while a bundle is being downloaded in the background. */
  readonly downloading = signal(false);

  /** Download progress as a 0-1 fraction (best-effort; not all platforms emit totals). */
  readonly progress = signal(0);

  /** `true` once the new bundle is downloaded and installing it only needs a restart. */
  readonly readyToRestart = signal(false);

  /** Last error message from check/download, surfaced in badge tooltips. */
  readonly error = signal<string | null>(null);

  /** Whether the update badge/button should be visible in the chrome. */
  readonly badgeVisible = computed(
    () => this.available() !== null || this.downloading() || this.readyToRestart(),
  );

  private timer?: ReturnType<typeof setInterval>;
  private activeUpdate: ActiveUpdate | null = null;
  /** Version we already prompted for this session — never nag twice. */
  private promptedVersion: string | null = null;
  /** Guards against double-triggering install from rapid clicks. */
  private installing = false;

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
   * Checks the update endpoint for a newer version. Never installs directly:
   * with auto-update on it downloads in the background and then ASKS the
   * user; a deferred "on next launch" choice from a previous session is the
   * only path that installs without a prompt (that IS the prompt's answer).
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
        this.activeUpdate = null;
        return;
      }
      this.available.set({
        version: update.version,
        date: update.date,
        body: update.body,
      });
      this.activeUpdate = update;

      // Honour a deferred "install on next launch" choice: silently download
      // and install before the user starts working. The quiet installer
      // shows no UI — the window just reopens on the new version.
      if (loadLayout(INSTALL_ON_NEXT_LAUNCH_KEY, '') === update.version) {
        saveLayout(INSTALL_ON_NEXT_LAUNCH_KEY, '');
        await this.download();
        if (this.readyToRestart()) await this.installAndRelaunch();
        return;
      }

      if (this.settings.autoUpdate()) {
        await this.download();
        if (this.readyToRestart()) await this.promptRestart(update.version);
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Downloads the pending update in the background (no install). Emits
   * progress to {@link progress}; flips {@link readyToRestart} when staged.
   */
  async download(): Promise<void> {
    const update = this.activeUpdate;
    if (!update || this.downloading() || this.readyToRestart()) return;
    this.downloading.set(true);
    this.progress.set(0);
    this.error.set(null);
    try {
      let total = 0;
      let received = 0;
      await update.download(event => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0;
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength;
          if (total > 0) this.progress.set(Math.min(1, received / total));
        } else if (event.event === 'Finished') {
          this.progress.set(1);
        }
      });
      this.readyToRestart.set(true);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.downloading.set(false);
    }
  }

  /**
   * One-click update path for the toolbar button / status-bar badge:
   * ensures the bundle is downloaded, then installs and relaunches.
   */
  async updateNow(): Promise<void> {
    if (!this.tauri.isDesktop) return;
    if (!this.activeUpdate) {
      await this.check();
      if (!this.activeUpdate) return;
    }
    if (!this.readyToRestart()) await this.download();
    if (this.readyToRestart()) await this.installAndRelaunch();
  }

  /**
   * Installs the downloaded update and relaunches. On Windows the plugin
   * exits the app itself and the quiet NSIS installer reopens it (`/S /R`);
   * on macOS/Linux the bundle is swapped in place and we relaunch explicitly.
   */
  async installAndRelaunch(): Promise<void> {
    if (!this.tauri.isDesktop || !this.activeUpdate || this.installing) return;
    this.installing = true;
    try {
      await this.activeUpdate.install();
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
      this.installing = false;
    }
  }

  /**
   * Asks the user whether to restart into the downloaded update now or have
   * it installed silently on the next launch. Only asked once per version
   * per session; the toolbar Update button remains either way.
   */
  private async promptRestart(version: string): Promise<void> {
    if (this.promptedVersion === version) return;
    this.promptedVersion = version;
    const restartNow = await this.confirmDialog.confirm({
      title: 'Update ready',
      message:
        `Phorma Agent Studio ${version} has been downloaded. ` +
        `Restart now to finish updating, or it will be installed automatically the next time you open the app.`,
      confirmLabel: 'Restart now',
      cancelLabel: 'On next launch',
    });
    if (restartNow) {
      await this.installAndRelaunch();
    } else {
      saveLayout(INSTALL_ON_NEXT_LAUNCH_KEY, version);
    }
  }
}
