/**
 * The Library_Exporter - a durable copy of the whole workflow library on disk
 * (Requirement 21).
 *
 * ## Why this exists alongside cloud backup
 *
 * "Bring your own everything" is a product rule, not a marketing line. A user who
 * runs their own Cloudflare or AWS account, or who has no subscription at all, is
 * exposed to exactly the failure that started this feature: a reinstall takes the
 * IndexedDB and the library with it. Telling them the fix is a Phorma
 * subscription would be selling durability we already owe them. So the same
 * release that adds hosted backup adds this: every spec plus a manifest, written
 * to a folder they choose, on hardware they control.
 *
 * ## What lands on disk
 *
 * One `<name>-<id>.phorma.json` per library workflow - the same format the
 * toolbar's Export writes, so a single file can be dragged back in - plus
 * `deployments.json`, which lists what the CONFIGURED deploy target says is
 * running. That manifest is the part a bare folder of specs cannot supply: after
 * a reinstall it is the only local record that a given workflow id is still live
 * somewhere and still spending.
 *
 * ## No secret ever
 *
 * A `WorkflowSpec` carries no credential by construction - provider keys live in
 * the OS keychain, connection secrets in the deployment's vault, and a spec
 * references both by NAME. The export therefore needs no redaction pass, and
 * `library-export.service.spec.ts` asserts that rather than assuming it
 * (Requirement 21.5).
 */

import { Injectable, effect, inject, untracked } from '@angular/core';

import { CloudService } from './cloud.service';
import { SettingsService } from './settings.service';
import { TauriService } from './tauri.service';
import { WorkflowService } from './workflow.service';
import { ToastService } from '../shared/toast/toast.service';
import { WORKFLOW_FILE_EXTENSION, type WorkflowSpec } from './workflow.model';
import type { DeploymentSummary } from './deployments.model';

/**
 * Debounce before a rewrite-on-save export runs.
 *
 * Longer than autosave's 2s on purpose: an autosave burst during an editing
 * session must collapse into ONE folder rewrite, not one per keystroke pause.
 */
const REWRITE_DEBOUNCE_MS = 5_000;

/** The manifest filename, fixed so a restore knows where to look. */
export const DEPLOYMENTS_MANIFEST = 'deployments.json';

/** One deployment as the manifest records it (Requirement 21.2). */
export interface ManifestDeployment {
  workflowId: string;
  name: string;
  /** ISO 8601, converted from the registry's epoch ms for human readability. */
  deployedAt: string;
  /** True when a schedule is armed, so this one runs unattended. */
  cronArmed: boolean;
  /** Published portal address, or null. */
  portalSlug: string | null;
}

/** One library workflow as the manifest indexes it. */
export interface ManifestWorkflow {
  workflowId: string;
  name: string;
  /** Filename inside the export folder. */
  file: string;
  savedAt: string;
}

/** `deployments.json`. */
export interface LibraryManifest {
  exportedAt: string;
  /** The deploy target the deployment list was read from, or null when unset. */
  target: string | null;
  /**
   * What a reader must NOT expect to find here. Stated in the artifact itself
   * because the person opening it a year from now is recovering from a loss and
   * has no other documentation to hand.
   */
  notIncluded: string[];
  deployments: ManifestDeployment[];
  workflows: ManifestWorkflow[];
}

/** The single-file form the browser build writes (Requirement 21.6). */
export interface LibraryBundle extends LibraryManifest {
  /** Every spec by value, since there is no folder to put them in. */
  specs: WorkflowSpec[];
}

/** What one export attempt did. */
export interface LibraryExportResult {
  ok: boolean;
  /** Files written (desktop) or 1 (browser bundle). */
  files: number;
  /** Where it went: a folder path, or a downloaded filename. */
  destination: string;
}

@Injectable({ providedIn: 'root' })
export class LibraryExportService {
  private readonly workflow = inject(WorkflowService);
  private readonly settings = inject(SettingsService);
  // Safe DI direction: nothing on the `RunControllerService ->
  // ModelTransportService -> PhormaCloudService -> CloudService` cycle injects
  // this service, so reaching `CloudService` for the configured target's
  // deployment list adds no edge back into it.
  private readonly cloud = inject(CloudService);
  private readonly tauri = inject(TauriService);
  private readonly toast = inject(ToastService);

  /**
   * How one file reaches disk.
   *
   * A replaceable field rather than an inline `invoke`, following the seam pattern
   * `TelemetryService` uses for `fetch` and `setTimer`: a test that had to stub
   * the Tauri module graph to observe a write would be testing the module loader.
   */
  writeFile: (path: string, content: string) => Promise<void> = async (path, content) => {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('write_workflow_file', { path, content });
  };

  private rewriteTimer: ReturnType<typeof setTimeout> | null = null;
  /** Identity of the library the last rewrite wrote, to skip a no-op. */
  private lastRewriteKey = '';
  /** True while an export is running, so a rewrite cannot overlap a manual one. */
  private running = false;

  constructor() {
    // Rewrite-on-save (Requirement 21.4). Debounced and change-gated: a save that
    // leaves the library semantically identical - which every autosave of an
    // unedited document does - rewrites nothing.
    //
    // Only the tracked reads are in the effect body; the timer and the write are
    // inside `untracked`, because an effect that re-enters its own writes has
    // OOM'd the renderer elsewhere in this codebase.
    effect(() => {
      const enabled = this.settings.libraryExportOnSave();
      const folder = this.settings.libraryExportFolder();
      const key = libraryKey(this.workflow.library());
      untracked(() => this.scheduleRewrite(enabled && folder.length > 0, key));
    });
  }

  /** True when rewrite-on-save has somewhere to write. */
  readonly configured = (): boolean => this.settings.libraryExportFolder().length > 0;

  /**
   * Picks the export folder with the native dialog. Desktop only - the browser
   * build has no folder to write to and takes the bundle path instead.
   */
  async pickFolder(): Promise<string | null> {
    if (!this.tauri.isDesktop) {
      this.toast.warning(
        'Desktop only',
        'In the browser the library exports as a single file instead of a folder.',
      );
      return null;
    }
    try {
      const folder = await this.tauri.selectFolderDialog('Choose a folder for your library export');
      if (folder) this.settings.setLibraryExportFolder(folder);
      return folder;
    } catch (error) {
      this.toast.error(
        'Folder picker unavailable',
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  /**
   * Exports now.
   *
   * `silent` suppresses the success toast, for the rewrite-on-save path: a
   * background write that announces itself after every save is noise, while a
   * FAILURE still speaks up, because silently stopping is how a user discovers
   * months later that their durability was not there.
   */
  async exportNow(options: { silent?: boolean } = {}): Promise<LibraryExportResult> {
    if (this.running) return { ok: false, files: 0, destination: '' };
    this.running = true;
    try {
      const specs = this.workflow.library().map(spec => structuredClone(spec));
      const deployments = await this.cloud.listDeployments();
      const manifest = this.buildManifest(specs, deployments);

      const result = this.tauri.isDesktop
        ? await this.writeFolder(specs, manifest)
        : this.downloadBundle(specs, manifest);

      if (result.ok && !options.silent) {
        this.toast.success(
          'Library exported',
          `${result.files} ${result.files === 1 ? 'file' : 'files'} to ${result.destination}`,
        );
      }
      return result;
    } catch (error) {
      this.toast.error(
        'Library export failed',
        error instanceof Error ? error.message : String(error),
      );
      return { ok: false, files: 0, destination: '' };
    } finally {
      this.running = false;
    }
  }

  /** The manifest for a given library and deployment list. Pure, so it is testable. */
  buildManifest(
    specs: readonly WorkflowSpec[],
    deployments: readonly DeploymentSummary[],
  ): LibraryManifest {
    return {
      exportedAt: new Date().toISOString(),
      target: this.settings.cloudProvider(),
      notIncluded: [
        'Provider API keys and connection secrets - they never leave the OS keychain or the deployment vault.',
        'The prompt library, the skill library and installed connectors.',
        'Run history and usage records.',
      ],
      deployments: deployments.map(entry => ({
        workflowId: entry.workflowId,
        name: entry.workflowName,
        deployedAt: new Date(entry.deployedAt).toISOString(),
        cronArmed: entry.cronArmed,
        portalSlug: entry.portalSlug,
      })),
      workflows: specs.map(spec => ({
        workflowId: spec.id,
        name: spec.name,
        file: exportFilename(spec),
        savedAt: spec.savedAt,
      })),
    };
  }

  // ── Destinations ──────────────────────────────────────────────────────────

  /** One file per spec plus the manifest, into the chosen folder. */
  private async writeFolder(
    specs: readonly WorkflowSpec[],
    manifest: LibraryManifest,
  ): Promise<LibraryExportResult> {
    const folder = this.settings.libraryExportFolder();
    if (!folder) {
      this.toast.warning('Choose a folder first', 'Settings > Cloud > Library export.');
      return { ok: false, files: 0, destination: '' };
    }
    // Match the folder's own separator rather than assuming one.
    const separator = folder.includes('\\') ? '\\' : '/';
    const base = folder.replace(/[\\/]$/, '');
    const write = (name: string, content: string): Promise<void> =>
      this.writeFile(`${base}${separator}${name}`, content);

    for (const spec of specs) {
      await write(exportFilename(spec), JSON.stringify(spec, null, 2));
    }
    // The manifest LAST, so its presence means the export completed. A folder
    // with specs and no manifest is a partial write, and that is worth being able
    // to tell apart.
    await write(DEPLOYMENTS_MANIFEST, JSON.stringify(manifest, null, 2));
    return { ok: true, files: specs.length + 1, destination: base };
  }

  /**
   * Browser parity (Requirement 21.6): one downloaded file carrying the whole
   * library, since a webview cannot write a folder.
   *
   * A JSON bundle rather than a ZIP. The requirement asks for "a single
   * downloadable archive", and one file that carries every spec by value is
   * exactly that - while a ZIP writer would mean either a new dependency or a
   * hand-rolled CRC32 and central directory, for a fallback path whose only
   * consumer is a human with a text editor. Each entry inside is a complete
   * `.phorma.json` body, so extracting one by hand is a copy and paste.
   */
  private downloadBundle(
    specs: readonly WorkflowSpec[],
    manifest: LibraryManifest,
  ): LibraryExportResult {
    const bundle: LibraryBundle = { ...manifest, specs: [...specs] };
    const filename = `phorma-library-${manifest.exportedAt.slice(0, 10)}.json`;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    // Revoking in the same tick can invalidate the blob before the browser has
    // read it, which shows up as an empty download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return { ok: true, files: 1, destination: filename };
  }

  // ── Rewrite-on-save ───────────────────────────────────────────────────────

  private scheduleRewrite(armed: boolean, key: string): void {
    if (this.rewriteTimer !== null) {
      clearTimeout(this.rewriteTimer);
      this.rewriteTimer = null;
    }
    // Nothing to do when the feature is off, when the library is empty, or when
    // this is the same library we already wrote.
    if (!armed || key.length === 0 || key === this.lastRewriteKey) return;
    this.rewriteTimer = setTimeout(() => {
      this.rewriteTimer = null;
      // Re-check at fire time: the folder or the toggle may have changed during
      // the debounce, and a stale rewrite would write to a folder the user has
      // since cleared.
      if (!this.settings.libraryExportOnSave() || !this.configured()) return;
      this.lastRewriteKey = key;
      void this.exportNow({ silent: true });
    }, REWRITE_DEBOUNCE_MS);
  }
}

/** `<safe-name>-<id>.phorma.json` - unique per workflow even on a name clash. */
export function exportFilename(spec: WorkflowSpec): string {
  const cleaned = spec.name
    .trim()
    .replace(/[^A-Za-z0-9 _-]+/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 48);
  const stem = cleaned.length > 0 ? cleaned : 'workflow';
  return `${stem}-${spec.id}.${WORKFLOW_FILE_EXTENSION}`;
}

/**
 * A cheap identity for the whole library, used to skip a no-op rewrite.
 *
 * `savedAt` is included on purpose: two saves that leave the graph identical
 * still move it, and a rewrite that reflected that is harmless. What this exists
 * to prevent is a rewrite triggered by the effect re-running for an unrelated
 * reason (a settings change, a tab switch) with nothing about the library
 * changed at all.
 */
function libraryKey(specs: readonly WorkflowSpec[]): string {
  return specs.map(spec => `${spec.id}@${spec.savedAt}`).join('|');
}
