/**
 * The Reconciliation_List: every workflow deployed in the signed-in account,
 * including ones with no local copy.
 *
 * ## Why this service exists
 *
 * A user reinstalled the studio and lost the IndexedDB that held their workflow
 * library. One of those workflows was deployed to Phorma Cloud, and that
 * deployment stayed live - cron firing, portal answering, credits spending -
 * with no way to name it, because the only copy of its `workflowId` was in the
 * database that got wiped. This service is the read side of the fix: the worker
 * keeps a registry, and this turns it into something a user can act on.
 *
 * ## Why it does not go through `CloudService`
 *
 * `CloudService.call()` dispatches against `settings.cloudProvider()`. That is
 * correct for a deploy, and wrong here: a subscriber whose deploy target is AWS
 * or their own Cloudflare account still HAS a Phorma Cloud account, and the
 * deployment list of that account lives on the hosted worker. So this pins
 * `DEPLOY_TARGETS.phorma` and reads the hosted base URL from the leaf module.
 *
 * Reaching for `CloudService` would also close the known NG0200 cycle in a new
 * place. The shared dispatcher in `deploy/cloud-dispatch.ts` is what keeps this
 * from becoming a second copy of the request plumbing (Requirement 6.8: every
 * request here goes through a `CloudOperation`, and there is no bespoke fetch).
 *
 * ## Not gated on subscription
 *
 * Deliberately (Requirement 6.6). A lapsed subscriber is precisely the person who
 * needs to find and stop a cron deployment they are still being billed for.
 */

import { Injectable, computed, inject, signal } from '@angular/core';

import { DesktopAuthService } from './desktop-auth.service';
import { PhormaCloudService } from './phorma-cloud.service';
import { WorkflowService } from './workflow.service';
import { ToastService } from '../shared/toast/toast.service';
import { loadPhormaCloudUrl } from './phorma-cloud-url';
import { DEPLOY_TARGETS } from './deploy/deploy-targets';
import {
  dispatchCloudOperation,
  type CloudCallResult,
  type CloudScopeResolver,
} from './deploy/cloud-dispatch';
import type { CloudTransport } from './deploy/cloud-transport';
import type { DeploymentSummary, DeploymentsResponse } from './deployments.model';
import type { WorkflowRestoreOutcome } from './workflow.service';
import type { WorkflowSpec } from './workflow.model';

/** The Phorma Cloud route table. Pinned, never resolved from the deploy target. */
const HOSTED_ENDPOINTS = DEPLOY_TARGETS.phorma.endpoints;

/** One list row, with the local-library comparison the panel renders. */
export interface DeploymentRow extends DeploymentSummary {
  /**
   * True when no local library workflow carries this id - an Orphan.
   *
   * This is the state the whole feature exists for, so it is computed here
   * rather than left to a template: a row the user cannot open, cannot edit and
   * cannot delete locally, that is nonetheless spending their credits.
   */
  orphan: boolean;
  /** The local workflow's name, when there is one and it differs. */
  localName: string | null;
}

@Injectable({ providedIn: 'root' })
export class DeploymentsService {
  // `PhormaCloudService` is safe here: this service sits DOWNSTREAM of it and
  // nothing on the `RunControllerService -> ModelTransportService ->
  // PhormaCloudService -> CloudService` path injects this one. `CloudService`
  // itself is deliberately absent - see the file header.
  private readonly phormaCloud = inject(PhormaCloudService);
  // A DI leaf (`TauriService` + `McpOAuthService`), and the desktop half of the
  // bearer: a packaged build holds no Clerk session at all.
  private readonly desktopAuth = inject(DesktopAuthService);
  private readonly workflow = inject(WorkflowService);
  private readonly toast = inject(ToastService);

  /** Raw rows from the last successful refresh. */
  private readonly rows = signal<DeploymentSummary[]>([]);
  /** The `YYYY-MM` window the credit figures cover. */
  readonly month = signal<string>('');
  /** True while a refresh is in flight. */
  readonly loading = signal(false);
  /** Human-readable failure from the last refresh, or null. */
  readonly error = signal<string | null>(null);
  /** True once a refresh has completed at least once (success or failure). */
  readonly loaded = signal(false);
  /** Workflow id whose row has an action in flight, for per-row spinners. */
  readonly busyWorkflowId = signal<string | null>(null);

  /**
   * The rows the panel renders, joined against the local library.
   *
   * A `computed` over `workflow.library()` rather than a snapshot taken at
   * refresh time, so restoring an orphan clears its badge immediately without a
   * second network round trip.
   */
  readonly deployments = computed<DeploymentRow[]>(() => {
    const library = this.workflow.library();
    return this.rows().map(row => {
      const local = library.find(spec => spec.id === row.workflowId);
      return {
        ...row,
        orphan: local === undefined,
        localName: local && local.name !== row.workflowName ? local.name : null,
      };
    });
  });

  /** How many listed deployments have no local counterpart. */
  readonly orphanCount = computed(() => this.deployments().filter(row => row.orphan).length);

  /** True when at least one listed deployment runs on its own schedule. */
  readonly hasArmedCron = computed(() => this.deployments().some(row => row.cronArmed));

  /**
   * Re-reads the account's deployments.
   *
   * A failure KEEPS the previous rows and records the message, matching
   * `PhormaCloudService.refresh`: going offline must not read as "you have no
   * deployments", which is the one answer that would stop a user looking for the
   * spend they came here about (Requirement 6.7).
   */
  async refresh(): Promise<void> {
    if (!this.phormaCloud.signedIn()) {
      this.rows.set([]);
      this.error.set(null);
      this.loaded.set(true);
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    try {
      const result = await this.call<DeploymentsResponse>('list-deployments', { workflowId: '' });
      if (result.ok === 'unsupported') throw new Error('Phorma Cloud is not configured.');
      if (result.ok === false) throw new Error(result.error);
      this.rows.set(Array.isArray(result.value.deployments) ? result.value.deployments : []);
      this.month.set(result.value.month);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loading.set(false);
      this.loaded.set(true);
    }
  }

  /**
   * The spec that is actually deployed for `workflowId`, or null.
   *
   * Null covers every failure, because both callers (download and restore) can
   * only report it - and it is already toasted here.
   */
  async readDeployedSpec(workflowId: string): Promise<WorkflowSpec | null> {
    try {
      const result = await this.call<WorkflowSpec | null>('read-spec', { workflowId });
      if (result.ok === 'unsupported') throw new Error('Phorma Cloud is not configured.');
      if (result.ok === false) {
        throw new Error(
          result.status === 404
            ? 'Nothing is deployed for this workflow any more.'
            : result.error,
        );
      }
      const spec = result.value;
      if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string') {
        throw new Error('The deployed workflow could not be read.');
      }
      return spec;
    } catch (error) {
      this.toast.error(
        'Could not read the deployed workflow',
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  /**
   * Reads the deployed spec back and writes it into the local library keeping
   * its id, so it addresses its own deployment again (Requirement 7.7).
   */
  async restoreToLibrary(
    workflowId: string,
    collision: 'ask' | 'replace' | 'skip' = 'ask',
  ): Promise<WorkflowRestoreOutcome> {
    this.busyWorkflowId.set(workflowId);
    try {
      const spec = await this.readDeployedSpec(workflowId);
      if (!spec) return 'failed';
      const outcome = await this.workflow.restoreSpec(spec, collision);
      if (outcome === 'restored' || outcome === 'replaced') {
        this.toast.success(
          outcome === 'replaced' ? 'Local copy replaced' : 'Restored to your library',
          `"${spec.name}" is back in your workflow library.`,
        );
      }
      return outcome;
    } finally {
      this.busyWorkflowId.set(null);
    }
  }

  /**
   * Stops a deployment: cron is cancelled and the deployed spec removed, while
   * run history, the usage ledger and connection metadata stay
   * (Requirement 7.1). Reversible by pushing again.
   *
   * Returns true only when the worker accepted it. A run in progress answers 409
   * and its message is surfaced verbatim (Requirement 7.5) - the worker knows
   * why it refused and we should not paraphrase it.
   */
  undeploy(workflowId: string): Promise<boolean> {
    return this.mutate(workflowId, 'undeploy', {
      summary: 'Deployment stopped',
      detail: 'Scheduled runs are cancelled. Run history and usage are kept.',
      failure: 'Could not stop the deployment',
    });
  }

  /**
   * Full teardown: everything undeploy does, plus the published portal goes
   * offline, tracked portal session Durable Objects are purged and every Durable
   * Object table is emptied (Requirement 7.2).
   *
   * Backups are untouched (Requirement 7.8) - this removes what is RUNNING, not
   * the record of what it was.
   */
  purge(workflowId: string): Promise<boolean> {
    return this.mutate(workflowId, 'purge', {
      summary: 'Deployment purged',
      detail: 'The portal is offline and the cloud copy of its history is gone.',
      failure: 'Could not purge the deployment',
    });
  }

  /** Shared body of {@link undeploy} and {@link purge}. */
  private async mutate(
    workflowId: string,
    op: 'undeploy' | 'purge',
    copy: { summary: string; detail: string; failure: string },
  ): Promise<boolean> {
    this.busyWorkflowId.set(workflowId);
    try {
      const result = await this.call(op, { workflowId });
      if (result.ok === 'unsupported') throw new Error('Phorma Cloud is not configured.');
      if (result.ok === false) throw new Error(result.error);
      // Drop the row locally rather than re-listing: the list is the surface a
      // user works through one row at a time, and a full refresh between two
      // clicks reorders it under their cursor (Requirement 7.4).
      this.rows.update(rows => rows.filter(row => row.workflowId !== workflowId));
      this.toast.success(copy.summary, copy.detail);
      return true;
    } catch (error) {
      this.toast.error(copy.failure, error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      this.busyWorkflowId.set(null);
    }
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  /**
   * Bases pinned to Phorma Cloud, never to the chosen deploy target.
   *
   * Read on every call rather than cached: the hosted URL is a (hidden) setting,
   * so a staging override has to take effect without a reload.
   */
  private readonly scope: CloudScopeResolver = {
    root: () => loadPhormaCloudUrl(),
    instance: workflowId => {
      const base = loadPhormaCloudUrl();
      return base ? DEPLOY_TARGETS.phorma.instanceUrl(base, workflowId || 'default') : null;
    },
  };

  /**
   * `fetch` plus the account bearer.
   *
   * The desktop device token comes FIRST for the same measured reason
   * `CloudService.resolveAuthToken` does it: a packaged build never loads a Clerk
   * session, so a Clerk-first order sent every request with no `Authorization`
   * header at all and the hosted worker failed them closed.
   */
  private readonly transport: CloudTransport = {
    id: 'fetch-bearer',
    send: async (url, init) => {
      const token = (await this.desktopAuth.token()) ?? (await this.phormaCloud.sessionToken());
      // Endpoint headers first, so a route table can never override the
      // credential by declaring an `Authorization` of its own.
      const headers: Record<string, string> = {
        ...init.headers,
        'Content-Type': 'application/json',
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const response = await fetch(url, { method: init.method, headers, body: init.body });
      return { status: response.status, ok: response.ok, body: await response.text() };
    },
    // Nothing on this surface opens a socket; the monitor belongs to CloudService.
    monitorSocketUrl: async () => {
      throw new Error('DeploymentsService does not open a monitor socket.');
    },
  };

  private call<T>(
    op: 'list-deployments' | 'read-spec' | 'undeploy' | 'purge',
    ctx: { workflowId: string },
  ): Promise<CloudCallResult<T>> {
    return dispatchCloudOperation<T>(HOSTED_ENDPOINTS, this.transport, this.scope, op, ctx);
  }
}
