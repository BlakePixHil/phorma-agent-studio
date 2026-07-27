/**
 * Portal publishing state (EPIC 9).
 *
 * Owns the studio's view of the active workflow's published endpoint: the
 * publish record, publish readiness, access keys, and portal-sourced runs. All
 * network access goes through {@link CloudService} so authentication, the
 * worker URL and the hosted/BYO provider split stay in one place.
 *
 * Validation runs LOCALLY as well as on the worker. The local pass gives the
 * panel an instant checklist as the user edits the canvas; the worker
 * re-validates at publish time so a stale studio can never publish something
 * broken.
 */

import { Injectable, computed, inject, signal } from '@angular/core';

import { APP_VERSION } from './app-version';
import { CloudService } from './cloud.service';
import { ToastService } from '../shared/toast/toast.service';
import { WorkflowService } from './workflow.service';
import { validatePortal, type PortalValidation, type WorkflowGraph } from '@phorma/engine';
import type { PortalRecord } from './portal.model';
import type { RunRecordSummary } from '@phorma/engine';

/**
 * Validation codes only the worker can produce, because they depend on state
 * the studio has no view of. Everything else is decided locally so the
 * checklist tracks the canvas live.
 */
const REMOTE_ONLY_CODES = new Set(['slug-taken']);

/** Why the panel can't publish right now, when it can't. */
export type PortalBlocker =
  | 'no-provider'
  | 'no-worker-url'
  | 'unsaved'
  | 'read-only'
  | 'invalid'
  | null;

@Injectable({ providedIn: 'root' })
export class PortalService {
  private readonly cloud = inject(CloudService);
  private readonly workflow = inject(WorkflowService);
  private readonly toast = inject(ToastService);

  /** The live publish record for the active workflow, when published. */
  readonly record = signal<PortalRecord | null>(null);
  /** Publish readiness as last reported by the worker (authoritative). */
  readonly remoteValidation = signal<PortalValidation | null>(null);
  /** Portal-sourced runs mirrored to the owner instance. */
  readonly runs = signal<RunRecordSummary[]>([]);
  /** True while any portal request is in flight. */
  readonly busy = signal(false);
  /** True when the worker could not be reached on the last attempt. */
  readonly unreachable = signal(false);
  /**
   * A freshly minted access key. Held only until the user dismisses it - the
   * worker stores a hash, so this is the only chance to copy it.
   */
  readonly mintedSecret = signal<string | null>(null);

  /** Whether the active canvas even declares a portal. */
  readonly hasPortalTrigger = computed(() =>
    this.workflow.graph().nodes.some(node => node.kind === 'portal-trigger'),
  );

  /**
   * Live validation of the canvas as authored. Slugs claimed by other
   * workflows are only known to the worker, so this pass can't see them -
   * `remoteValidation` covers that.
   */
  readonly localValidation = computed<PortalValidation | null>(() => {
    const graph = this.workflow.graph() as WorkflowGraph;
    return this.hasPortalTrigger() ? validatePortal(graph) : null;
  });

  /**
   * The checklist the panel renders.
   *
   * Local graph validation is authoritative for SHAPE (it reflects the canvas
   * as you type, with no round trip). From the worker we merge in only what the
   * studio cannot know by itself: a slug already claimed by another workflow.
   *
   * Deliberately dropped: the worker's `no-workflow` notice ("push this
   * workflow first"). It is true before the first push, but surfacing it as a
   * publish error is a dead end - {@link publish} pushes before it publishes.
   */
  readonly validation = computed<PortalValidation | null>(() => {
    const local = this.localValidation();
    if (!local) return null;
    const remote = this.remoteValidation();
    const remoteOnly = (remote?.errors ?? []).filter(issue => REMOTE_ONLY_CODES.has(issue.code));
    return remoteOnly.length
      ? { ...local, errors: [...local.errors, ...remoteOnly] }
      : local;
  });

  readonly published = computed(() => this.record() !== null);

  /** The public address, once published. */
  readonly url = computed(() => {
    const slug = this.record()?.slug;
    return slug ? this.cloud.portalUrl(slug) : null;
  });

  /** Build stamp reported by the deployed worker (absent on older workers). */
  readonly workerBuild = signal<string | null>(null);

  /**
   * True when the deployed worker is running older code than this studio, so
   * it is missing portal fixes until the owner pulls and deploys again.
   *
   * BYO ONLY. Phorma Cloud users never see this: we deploy their runtime, so it
   * is always current, and telling them to run wrangler would be nonsense.
   * Unknown or unparseable versions are treated as current - a false "out of
   * date" nag is worse than a missed one.
   */
  readonly stale = computed(() => {
    if (this.cloud.provider() === 'phorma') return false;
    const worker = this.workerBuild();
    return !!worker && isOlderVersion(worker, APP_VERSION);
  });

  /** What is stopping a publish, or null when ready. */
  readonly blocker = computed<PortalBlocker>(() => {
    if (!this.cloud.provider()) return 'no-provider';
    if (!this.cloud.configured()) return 'no-worker-url';
    const doc = this.workflow.activeDoc();
    if (doc?.readOnly) return 'read-only';
    if (!doc?.workflowId) return 'unsaved';
    if (this.validation()?.errors.length) return 'invalid';
    return null;
  });

  // ── Operations ─────────────────────────────────────────────────────────────

  /** Loads the publish record + readiness for the active workflow. */
  async refresh(): Promise<void> {
    const workflowId = this.workflow.activeDoc()?.workflowId;
    if (!workflowId) {
      this.record.set(null);
      this.remoteValidation.set(null);
      this.runs.set([]);
      return;
    }
    this.busy.set(true);
    try {
      const status = await this.cloud.fetchPortal(workflowId);
      this.unreachable.set(status === null);
      this.record.set(status?.record ?? null);
      this.remoteValidation.set(status?.validation ?? null);
      this.workerBuild.set(status?.workerBuild ?? null);
      if (status?.record) await this.refreshRuns();
      else this.runs.set([]);
    } catch {
      // A 4xx here means "never pushed" far more often than a real fault, and
      // the panel already renders the blocker - don't toast on a passive load.
      this.record.set(null);
      this.remoteValidation.set(null);
    } finally {
      this.busy.set(false);
    }
  }

  /** Reloads the portal-sourced run list. */
  async refreshRuns(): Promise<void> {
    const workflowId = this.workflow.activeDoc()?.workflowId;
    if (!workflowId) return;
    const runs = await this.cloud.listPortalRuns(workflowId).catch(() => null);
    if (runs) this.runs.set(runs);
  }

  /**
   * Pushes the current spec, then publishes it. Pushing first is deliberate:
   * the worker publishes what it HAS, so publishing without a push would serve
   * a stale portal and silently ignore the user's latest edits.
   */
  async publish(): Promise<boolean> {
    const doc = this.workflow.activeDoc();
    if (doc?.readOnly) {
      this.toast.warning('Preview is read-only', 'Restore this version before publishing it.');
      return false;
    }
    const workflowId = doc?.workflowId;
    if (!workflowId) {
      this.toast.warning('Save this workflow first', 'A portal needs a saved workflow to publish.');
      return false;
    }

    this.busy.set(true);
    try {
      await this.cloud.pushWorkflow();
      const result = await this.cloud.publishPortal(workflowId);
      if (!result) {
        this.toast.error('Worker unreachable', 'Check your worker URL in Settings → Cloud.');
        return false;
      }
      if (!result.ok) {
        this.toast.error('Could not publish', result.error ?? 'The worker refused the portal.');
        if (result.validation) this.remoteValidation.set(result.validation);
        return false;
      }
      this.record.set(result.record ?? null);
      if (result.validation) this.remoteValidation.set(result.validation);
      const url = result.record ? this.cloud.portalUrl(result.record.slug) : null;
      this.toast.success('Portal is live', url ?? 'Your workflow is published.');
      return true;
    } catch (error) {
      this.toast.error('Could not publish', message(error));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  /** Takes the portal offline and releases its address. */
  async unpublish(): Promise<void> {
    const workflowId = this.workflow.activeDoc()?.workflowId;
    if (!workflowId) return;
    this.busy.set(true);
    try {
      const result = await this.cloud.unpublishPortal(workflowId);
      if (!result?.ok) throw new Error('The worker refused the request.');
      this.record.set(null);
      this.runs.set([]);
      this.toast.success('Portal is offline', 'The address no longer serves this workflow.');
    } catch (error) {
      this.toast.error('Could not unpublish', message(error));
    } finally {
      this.busy.set(false);
    }
  }

  /** Mints an access key. The plaintext is exposed via {@link mintedSecret}. */
  async mintToken(label: string): Promise<void> {
    const workflowId = this.workflow.activeDoc()?.workflowId;
    if (!workflowId) return;
    this.busy.set(true);
    try {
      const result = await this.cloud.mintPortalToken(workflowId, label);
      if (!result?.ok || !result.secret) {
        throw new Error(result?.error ?? 'The worker refused the request.');
      }
      this.mintedSecret.set(result.secret);
      await this.refresh();
    } catch (error) {
      this.toast.error('Could not create an access key', message(error));
    } finally {
      this.busy.set(false);
    }
  }

  /** Revokes an access key immediately. */
  async revokeToken(tokenId: string): Promise<void> {
    const workflowId = this.workflow.activeDoc()?.workflowId;
    if (!workflowId) return;
    this.busy.set(true);
    try {
      const result = await this.cloud.revokePortalToken(workflowId, tokenId);
      if (!result?.ok) throw new Error('The worker refused the request.');
      this.toast.success('Access key revoked', 'It can no longer reach this portal.');
      await this.refresh();
    } catch (error) {
      this.toast.error('Could not revoke the key', message(error));
    } finally {
      this.busy.set(false);
    }
  }

  /** Clears the one-time key display. */
  dismissMintedSecret(): void {
    this.mintedSecret.set(null);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Tolerant version comparison for the staleness check.
 *
 * Compares the numeric `major.minor.patch` head and ignores any pre-release
 * suffix: a beta bump is a real release here, but comparing `-beta.10` against
 * `-beta.9` lexically would be wrong, and getting it subtly wrong would nag
 * users who are actually up to date. So the pre-release ordinal IS compared,
 * numerically, and anything unparseable returns false (= not stale).
 */
function isOlderVersion(candidate: string, reference: string): boolean {
  const parts = (version: string): number[] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-[a-z.]*?(\d+))?$/i.exec(version.trim());
    if (!match) return null;
    // A missing pre-release ordinal sorts ABOVE any pre-release of the same
    // version (1.0.0 is newer than 1.0.0-beta.9).
    return [
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      match[4] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[4]),
    ];
  };

  const left = parts(candidate);
  const right = parts(reference);
  if (!left || !right) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  return false;
}
