/**
 * Cloud backup of the workflow library, for Phorma Cloud subscribers.
 *
 * ## What this is for
 *
 * A user reinstalled the studio and lost the IndexedDB that held every workflow
 * they had built. Local version history went with it, because that lives in the
 * same database. This is the copy that survives the machine.
 *
 * ## Why it watches `library()` instead of hooking `saveActive`
 *
 * `WorkflowService` must not know this service exists (Requirement 12.3). The
 * reason is the NG0200 cycle: `WorkflowService` sits under `CloudService`, which
 * sits under `RunControllerService`, and a dependency pointing the other way would
 * close a loop through the run path. An `effect()` over `library()` observes every
 * persist path - manual save, autosave, rename, restore, background creation -
 * without any of them having to call in.
 *
 * The consequence is that this service sees STATE, not events, so it DIFFS rather
 * than mirrors. That is also what makes the central invariant hold for free: a
 * workflow disappearing from the library is not an upload and not a delete, it is
 * simply nothing to do (Requirement 17.3).
 *
 * ## Default on, for subscribers
 *
 * No opt-in step (Requirement 12.8). Durability that a user has to discover and
 * enable is durability most users will not have on the day they need it. The
 * disclosure and the one-click disable-and-delete-all live in Settings > Cloud.
 */

import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import { canonicalJson, fnv1a } from '@phorma/engine';

import { ConnectionStoreService } from '../connection-store.service';
import { DesktopAuthService } from '../desktop-auth.service';
import { IndexedDbStorageService } from '../indexed-db-storage.service';
import { PhormaCloudService } from '../phorma-cloud.service';
import { SettingsService } from '../settings.service';
import { WorkflowService } from '../workflow.service';
import { ToastService } from '../../shared/toast/toast.service';
import { loadPhormaCloudUrl } from '../phorma-cloud-url';
import { DEPLOY_TARGETS } from '../deploy/deploy-targets';
import {
  dispatchCloudOperation,
  type CloudCallResult,
  type CloudScopeResolver,
} from '../deploy/cloud-dispatch';
import type { CloudTransport } from '../deploy/cloud-transport';
import type {
  BackupBody,
  BackupConnectionRef,
  BackupDownloadResponse,
  BackupListResponse,
  BackupRevisionsResponse,
  BackupSummary,
  BackupUploadResponse,
} from '../backup.model';
import type { WorkflowRestoreOutcome } from '../workflow.service';
import type { WorkflowSpec } from '../workflow.model';

/** The Phorma Cloud route table. Pinned, never resolved from the deploy target. */
const HOSTED_ENDPOINTS = DEPLOY_TARGETS.phorma.endpoints;

/**
 * How long after a library change an upload runs.
 *
 * Longer than autosave's 2s on purpose (Requirement 12.4): an editing session with
 * autosave on must collapse into a handful of uploads, not one per keystroke pause.
 */
const UPLOAD_DEBOUNCE_MS = 8_000;

/** localStorage key for the user's opt-out. */
const DISABLED_KEY = 'backupDisabled';

/** What one upload attempt did, for the settings surface and the specs. */
export type BackupUploadOutcome =
  | 'uploaded'
  | 'unchanged'
  | 'skipped'
  | 'conflict'
  | 'too-large'
  | 'cap-reached'
  | 'read-only'
  | 'failed';

@Injectable({ providedIn: 'root' })
export class WorkflowBackupService {
  // `WorkflowService` is injected HERE and never the other way round - see the
  // file header. Nothing on the run path injects this service, so reaching
  // `PhormaCloudService` for the bearer adds no edge into the NG0200 cycle.
  private readonly workflow = inject(WorkflowService);
  private readonly storage = inject(IndexedDbStorageService);
  private readonly phormaCloud = inject(PhormaCloudService);
  private readonly desktopAuth = inject(DesktopAuthService);
  private readonly settings = inject(SettingsService);
  private readonly connections = inject(ConnectionStoreService);
  private readonly toast = inject(ToastService);

  /** The account's backups, from the last list refresh. */
  private readonly rows = signal<BackupSummary[]>([]);
  /** False while the subscription is lapsed: reads work, uploads do not. */
  readonly writable = signal(true);
  /** Days of read-only access left after a lapse; null when not applicable. */
  readonly readOnlyDaysRemaining = signal<number | null>(null);
  /** Workflows this plan will back up, and how many are used. */
  readonly cap = signal(0);
  readonly used = signal(0);
  /** Revisions retained per workflow, as the worker reports it. */
  readonly revisionsKept = signal(0);
  /** True while a list refresh is in flight. */
  readonly loading = signal(false);
  /** Human-readable failure from the last list refresh, or null. */
  readonly error = signal<string | null>(null);
  /** True once a list refresh has completed at least once. */
  readonly loaded = signal(false);
  /**
   * False when the worker has no backup storage at all (Requirement 24.2).
   *
   * A BYO deployment binds no D1 and no R2, so its whole backup surface answers
   * 501. The studio HIDES the backup controls in that case rather than showing a
   * broken one - and the reconciliation list beside it keeps working, because that
   * reads a Durable Object every deployment has.
   */
  readonly available = signal(true);
  /** True while an upload is running, for a quiet activity indicator. */
  readonly uploading = signal(false);
  /** Workflow ids whose last upload hit a conflict, so the UI can offer a compare. */
  readonly conflicts = signal<ReadonlySet<string>>(new Set());

  /** The user's opt-out. Backup is ON for a subscriber unless this is set. */
  readonly disabled = signal(readDisabled());

  /**
   * Whether backup is running right now.
   *
   * Requires an active subscription AND no opt-out. A `past_due` tenant keeps
   * backing up, because a failed payment costs them hosted runs and nothing else -
   * taking their durability away at the same time would be the wrong lesson.
   */
  readonly active = computed(
    () =>
      !this.disabled() &&
      this.phormaCloud.signedIn() &&
      (this.phormaCloud.subscribed() || this.phormaCloud.pastDue()),
  );

  /** Live backups, newest first. */
  readonly backups = computed(() => this.rows().filter(row => row.deletedAt === null));

  /** Tombstones, which are still restorable until their countdown runs out. */
  readonly tombstones = computed(() => this.rows().filter(row => row.deletedAt !== null));

  /** True when at least one non-purged backup exists, tombstones included. */
  readonly hasAnyBackup = computed(() => this.rows().length > 0);

  private uploadTimer: ReturnType<typeof setTimeout> | null = null;
  private uploadRunning = false;
  /** Workflow ids whose upload failed transiently, retried on the next change. */
  private readonly pending = new Set<string>();

  constructor() {
    // The one hook into the library. Only the two tracked reads are in the effect
    // body; the scheduling is inside `untracked`, because an effect that re-enters
    // its own writes has OOM'd the renderer elsewhere in this codebase.
    effect(() => {
      const armed = this.active();
      const library = this.workflow.library();
      untracked(() => this.schedule(armed, library));
    });

    // Persist the opt-out. A plain effect, matching every other layout setting.
    effect(() => writeDisabled(this.disabled()));

    // A sign-in is when a fresh install first learns it has backups to restore, so
    // the list is read then rather than only when settings opens.
    let lastSignedIn = false;
    effect(() => {
      const signedIn = this.phormaCloud.signedIn();
      if (signedIn === lastSignedIn) return;
      lastSignedIn = signedIn;
      if (signedIn) untracked(() => void this.refresh());
      else untracked(() => this.clearLocalView());
    });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /**
   * Re-reads the account's backups.
   *
   * A failure KEEPS the previous rows, like `PhormaCloudService.refresh`: going
   * offline must not read as "you have no backups", which is the one answer that
   * would stop somebody restoring.
   */
  async refresh(): Promise<void> {
    if (!this.phormaCloud.signedIn()) {
      this.clearLocalView();
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    try {
      const result = await this.call<BackupListResponse>('backup-list', {});
      if (result.ok === 'unsupported') throw new Error('Phorma Cloud is not configured.');
      if (result.ok === false) {
        // 402 is a billing state, not a failure to report as one: a free account
        // simply has no backups, and saying so is the honest empty state.
        if (result.status === 402) {
          this.rows.set([]);
          this.writable.set(false);
          return;
        }
        // 501 means this deployment has no backup storage bound. Not an error to
        // report: there is nothing the user could do about it, and the honest UI is
        // to hide the controls (Requirement 24.2).
        if (result.status === 501) {
          this.available.set(false);
          this.rows.set([]);
          this.writable.set(false);
          return;
        }
        throw new Error(result.error);
      }
      this.available.set(true);
      this.rows.set(Array.isArray(result.value.backups) ? result.value.backups : []);
      this.writable.set(result.value.writable !== false);
      this.readOnlyDaysRemaining.set(result.value.readOnlyDaysRemaining);
      this.cap.set(result.value.cap);
      this.used.set(result.value.used);
      this.revisionsKept.set(result.value.revisionsKept);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loading.set(false);
      this.loaded.set(true);
    }
  }

  /** Retained revision numbers for one workflow, newest first. */
  async revisions(workflowId: string): Promise<BackupRevisionsResponse | null> {
    const result = await this.call<BackupRevisionsResponse>('backup-revisions', { workflowId });
    return result.ok === true ? result.value : null;
  }

  /** One revision's body, or null. Toasts its own failure. */
  async download(workflowId: string, revision: number): Promise<BackupDownloadResponse | null> {
    try {
      const result = await this.call<BackupDownloadResponse>('backup-download', {
        workflowId,
        revision,
      });
      if (result.ok === 'unsupported') throw new Error('Phorma Cloud is not configured.');
      if (result.ok === false) throw new Error(result.error);
      if (!result.value?.spec?.id) throw new Error('The backup could not be read.');
      return result.value;
    } catch (error) {
      this.toast.error(
        'Could not read the backup',
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  // ── Restore ───────────────────────────────────────────────────────────────

  /**
   * Restores one backup into the local library, keeping its id.
   *
   * Returns the outcome plus the connections the restored workflow references but
   * this install does not have (Requirement 19.3). The gap is reported rather than
   * fixed: a connection needs a credential, and a backup deliberately carries none.
   */
  async restore(
    workflowId: string,
    options: { revision?: number; collision?: 'ask' | 'replace' | 'skip' } = {},
  ): Promise<{ outcome: WorkflowRestoreOutcome; missingConnections: string[] }> {
    const revision = options.revision ?? this.rows().find(row => row.workflowId === workflowId)?.revision ?? 1;
    const body = await this.download(workflowId, revision);
    if (!body) return { outcome: 'failed', missingConnections: [] };

    const outcome = await this.workflow.restoreSpec(body.spec, options.collision ?? 'ask');
    if (outcome === 'failed' || outcome === 'kept-local') {
      return { outcome, missingConnections: [] };
    }

    // A restored workflow now matches what the cloud holds, so record it - or the
    // next save would upload with a stale `If-Match` and read as a conflict.
    await this.storage
      .saveBackupState({
        workflowId,
        lastUploadedHash: fnv1a(canonicalJson(body.spec)),
        revision,
        uploadedAt: new Date().toISOString(),
      })
      .catch(() => undefined);

    return { outcome, missingConnections: await this.missingConnections(body.connections) };
  }

  /** Referenced connection names this install does not have locally (19.3). */
  private async missingConnections(refs: readonly BackupConnectionRef[]): Promise<string[]> {
    if (refs.length === 0) return [];
    try {
      const local = new Set((await this.connections.list()).map(entry => entry.id));
      return refs.filter(ref => !local.has(ref.id)).map(ref => ref.name);
    } catch {
      // A failed connection read must not make a successful restore look failed.
      return [];
    }
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  /** Uploads every eligible workflow now, ignoring the debounce. */
  async uploadAll(): Promise<void> {
    await this.runUploads(this.workflow.library());
  }

  /**
   * Deletes one backup. Soft by default: a tombstone whose bodies stay in storage
   * and stay restorable. `purge` destroys it, and the worker refuses a purge that
   * was not preceded by a delete.
   */
  async deleteBackup(workflowId: string, options: { purge?: boolean } = {}): Promise<boolean> {
    try {
      const result = await this.call('backup-delete', { workflowId, purge: options.purge === true });
      if (result.ok === 'unsupported') throw new Error('Phorma Cloud is not configured.');
      if (result.ok === false) throw new Error(result.error);
      if (options.purge) await this.storage.removeBackupState(workflowId).catch(() => undefined);
      await this.refresh();
      return true;
    } catch (error) {
      this.toast.error(
        options.purge ? 'Could not purge the backup' : 'Could not delete the backup',
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  /**
   * Turns backup off and destroys everything stored (Requirement 11.5).
   *
   * The opt-out is set FIRST, so a failure part-way through cannot leave uploads
   * running against data the user asked us to delete.
   */
  async disableAndDeleteAll(): Promise<boolean> {
    this.disabled.set(true);
    try {
      const result = await this.call('backup-delete-all', {});
      if (result.ok === 'unsupported') throw new Error('Phorma Cloud is not configured.');
      if (result.ok === false) throw new Error(result.error);
      await this.storage.clearBackupState().catch(() => undefined);
      this.rows.set([]);
      this.used.set(0);
      this.toast.success('Cloud backup off', 'Every stored copy has been deleted.');
      return true;
    } catch (error) {
      this.toast.error(
        'Could not delete your backups',
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  /** Turns backup back on. Existing workflows upload on the next change. */
  enable(): void {
    this.disabled.set(false);
  }

  // ── The upload loop ───────────────────────────────────────────────────────

  private schedule(armed: boolean, library: readonly WorkflowSpec[]): void {
    if (this.uploadTimer !== null) {
      clearTimeout(this.uploadTimer);
      this.uploadTimer = null;
    }
    if (!armed || library.length === 0) return;
    this.uploadTimer = setTimeout(() => {
      this.uploadTimer = null;
      // Re-check at fire time: the subscription or the opt-out may have changed
      // during the debounce.
      if (!this.active()) return;
      void this.runUploads(this.workflow.library());
    }, UPLOAD_DEBOUNCE_MS);
  }

  private async runUploads(library: readonly WorkflowSpec[]): Promise<void> {
    if (this.uploadRunning || !this.active() || !this.writable()) return;
    this.uploadRunning = true;
    this.uploading.set(true);
    try {
      let capReached = false;
      for (const spec of library) {
        if (capReached) break;
        const outcome = await this.uploadOne(spec);
        // One cap refusal means every OTHER new workflow will be refused too, so
        // stop rather than issuing a request per workflow to be told the same thing.
        if (outcome === 'cap-reached') capReached = true;
        if (outcome === 'read-only') break;
      }
    } finally {
      this.uploading.set(false);
      this.uploadRunning = false;
    }
  }

  /**
   * Uploads one workflow if its spec has changed since the last accepted upload.
   *
   * The hash comparison is what makes this quiet (Requirement 12.6, 12.12): a save
   * that leaves the spec semantically identical issues zero requests.
   */
  async uploadOne(spec: WorkflowSpec): Promise<BackupUploadOutcome> {
    if (!this.active()) return 'skipped';

    // The same serialization the file export uses, so embedded skills and the
    // sub-workflow closure travel with the spec (Requirement 12.5).
    const body = await this.buildBody(spec);
    const hash = fnv1a(canonicalJson(body.spec));

    const state = await this.storage.getBackupState(spec.id).catch(() => undefined);
    if (state && state.lastUploadedHash === hash && !this.pending.has(spec.id)) {
      return 'unchanged';
    }

    const result = await this.call<BackupUploadResponse>(
      'backup-upload',
      { workflowId: spec.id, ifMatch: state?.revision ?? null },
      body,
    ).catch(() => null);

    if (result === null || result.ok === 'unsupported') {
      // A transport failure keeps `lastUploadedHash` as it was and retries on the
      // next change (Requirement 12.10) - never a partial record of an upload that
      // did not land.
      this.pending.add(spec.id);
      return 'failed';
    }

    if (result.ok === false) {
      const code = readCode(result.detail);
      if (code === 'backup_conflict') {
        // Another machine wrote a newer revision. Surfaced rather than resolved:
        // nothing merges two specs, so the user compares and chooses.
        this.conflicts.update(current => new Set([...current, spec.id]));
        const revision = readRevision(result.detail);
        if (revision !== null && state) {
          // Record the real revision so the NEXT attempt is a clean conflict on a
          // true value rather than a repeat of a stale one.
          await this.storage
            .saveBackupState({ ...state, revision })
            .catch(() => undefined);
        }
        return 'conflict';
      }
      if (code === 'backup_too_large') {
        this.pending.delete(spec.id);
        return 'too-large';
      }
      if (code === 'backup_cap') return 'cap-reached';
      if (code === 'no_subscription') {
        this.writable.set(false);
        return 'read-only';
      }
      this.pending.add(spec.id);
      return 'failed';
    }

    this.pending.delete(spec.id);
    this.conflicts.update(current => {
      if (!current.has(spec.id)) return current;
      const next = new Set(current);
      next.delete(spec.id);
      return next;
    });
    await this.storage
      .saveBackupState({
        workflowId: spec.id,
        lastUploadedHash: hash,
        revision: result.value.revision,
        uploadedAt: new Date().toISOString(),
      })
      .catch(() => undefined);
    return 'uploaded';
  }

  /**
   * The body for one workflow: the spec plus the id and display name of every
   * connection it references (Requirement 19.1).
   *
   * No secret value, no token, no credential field - there is no field in
   * {@link BackupBody} that could hold one, and the worker rebuilds the list
   * anyway.
   */
  private async buildBody(spec: WorkflowSpec): Promise<BackupBody> {
    const referenced = referencedConnectionIds(spec);
    if (referenced.size === 0) return { spec, connections: [] };
    try {
      const local = await this.connections.list();
      const byId = new Map(local.map(entry => [entry.id, entry.name]));
      return {
        spec,
        connections: [...referenced].map(id => ({ id, name: byId.get(id) ?? id })),
      };
    } catch {
      // A failed connection read must not stop the spec being backed up: the spec
      // is the thing that cannot be rebuilt.
      return { spec, connections: [...referenced].map(id => ({ id, name: id })) };
    }
  }

  private clearLocalView(): void {
    this.rows.set([]);
    this.error.set(null);
    this.writable.set(true);
    this.readOnlyDaysRemaining.set(null);
    this.used.set(0);
    this.loaded.set(true);
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  /**
   * Bases pinned to Phorma Cloud, never to the chosen deploy target: a subscriber
   * deploying to AWS still backs up to the hosted account.
   */
  private readonly scope: CloudScopeResolver = {
    root: () => loadPhormaCloudUrl(),
    instance: workflowId => {
      const base = loadPhormaCloudUrl();
      return base ? DEPLOY_TARGETS.phorma.instanceUrl(base, workflowId || 'default') : null;
    },
  };

  /** `fetch` plus the account bearer, desktop device token first. */
  private readonly transport: CloudTransport = {
    id: 'fetch-bearer',
    send: async (url, init) => {
      const token = (await this.desktopAuth.token()) ?? (await this.phormaCloud.sessionToken());
      const headers: Record<string, string> = {
        ...init.headers,
        'Content-Type': 'application/json',
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const response = await fetch(url, { method: init.method, headers, body: init.body });
      return { status: response.status, ok: response.ok, body: await response.text() };
    },
    monitorSocketUrl: async () => {
      throw new Error('WorkflowBackupService does not open a monitor socket.');
    },
  };

  private call<T>(
    op:
      | 'backup-list'
      | 'backup-upload'
      | 'backup-revisions'
      | 'backup-download'
      | 'backup-delete'
      | 'backup-delete-all',
    ctx: { workflowId?: string; revision?: number; ifMatch?: number | null; purge?: boolean },
    payload?: unknown,
  ): Promise<CloudCallResult<T>> {
    return dispatchCloudOperation<T>(
      HOSTED_ENDPOINTS,
      this.transport,
      this.scope,
      op,
      { workflowId: '', ...ctx },
      payload,
    );
  }
}

/** Every connection id the spec and its embedded closure reference. */
function referencedConnectionIds(spec: WorkflowSpec): Set<string> {
  const ids = new Set<string>();
  const graphs = [spec.graph, ...Object.values(spec.subWorkflows ?? {}).map(entry => entry.graph)];
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      const connectionId = (node.data as { connectionId?: unknown }).connectionId;
      if (typeof connectionId === 'string' && connectionId.length > 0) ids.add(connectionId);
    }
  }
  return ids;
}

/** The refusal code from a failure body, or null. */
function readCode(detail: unknown): string | null {
  const value = (detail as { code?: unknown } | null | undefined)?.code;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The current revision a conflict body reports, or null. */
function readRevision(detail: unknown): number | null {
  const value = (detail as { revision?: unknown } | null | undefined)?.revision;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * The opt-out, read straight from localStorage rather than through
 * `SettingsService`.
 *
 * Deliberate: this service is constructed at startup and the flag decides whether
 * anything happens at all, so it must not depend on the load order of another
 * service's signal initialisation.
 */
function readDisabled(): boolean {
  try {
    return localStorage.getItem(`phorma.layout.${DISABLED_KEY}`) === 'true';
  } catch {
    return false;
  }
}

function writeDisabled(value: boolean): void {
  try {
    localStorage.setItem(`phorma.layout.${DISABLED_KEY}`, value ? 'true' : 'false');
  } catch {
    // Best-effort, like every other layout write.
  }
}
