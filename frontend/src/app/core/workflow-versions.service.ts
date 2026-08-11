import { Injectable, inject, signal } from '@angular/core';

import { IndexedDbStorageService } from './indexed-db-storage.service';
import { workflowSpecsEqual } from './workflow-diff';
import type { WorkflowSpec } from './workflow.model';
import type { WorkflowVersion, WorkflowVersionTrigger } from './workflow-versions.model';

const AUTOSAVE_SESSION_MS = 30 * 60 * 1000;
let versionCounter = 0;

/** Persistence and capture policy for workflow edit history. */
@Injectable({ providedIn: 'root' })
export class WorkflowVersionsService {
  private readonly storage = inject(IndexedDbStorageService);

  readonly versions = signal<WorkflowVersion[]>([]);
  readonly loading = signal(false);
  readonly workflowId = signal<string | null>(null);

  /**
   * The set of library workflow ids that have at least one version snapshot
   * marked `deployed: true`. Backed by a single IndexedDB scan on startup
   * and updated incrementally on deploy / delete, so the library panel and
   * the toolbar cloud icon can show a "deployed" badge with no per-workflow
   * network round-trip. Reflects "has been deployed" (local truth), not
   * "is currently deployed" (live cloud truth) - the Cloud dialog's
   * `refreshStatus` corrects the latter for the active workflow.
   */
  readonly deployedWorkflowIds = signal<ReadonlySet<string>>(new Set());

  constructor() {
    void this.refreshDeployedIds();
  }

  private async refreshDeployedIds(): Promise<void> {
    try {
      this.deployedWorkflowIds.set(await this.storage.listDeployedWorkflowIds());
    } catch {
      // Best-effort: a broken IndexedDB read must not brick the badge.
    }
  }

  async load(workflowId: string): Promise<WorkflowVersion[]> {
    this.workflowId.set(workflowId);
    this.loading.set(true);
    try {
      const versions = await this.storage.listWorkflowVersions(workflowId);
      if (this.workflowId() === workflowId) this.versions.set(versions);
      return versions;
    } finally {
      if (this.workflowId() === workflowId) this.loading.set(false);
    }
  }

  async recordSave(spec: WorkflowSpec, trigger: Exclude<WorkflowVersionTrigger, 'deploy'>): Promise<WorkflowVersion | null> {
    const versions = await this.storage.listWorkflowVersions(spec.id);
    const newest = versions[0];
    if (newest && workflowSpecsEqual(newest.spec, spec)) return newest;

    const now = new Date().toISOString();
    const canCoalesce =
      trigger === 'autosave' &&
      newest?.trigger === 'autosave' &&
      Date.now() - new Date(newest.savedAt).getTime() < AUTOSAVE_SESSION_MS &&
      !newest.deployed;
    const version: WorkflowVersion = {
      id: canCoalesce ? newest.id : makeVersionId(spec.id),
      workflowId: spec.id,
      savedAt: now,
      trigger,
      spec: snapshot(spec, now),
    };
    await this.storage.saveWorkflowVersion(version);
    await this.refreshIfActive(spec.id);
    return version;
  }

  async recordDeploy(spec: WorkflowSpec): Promise<WorkflowVersion> {
    const versions = await this.storage.listWorkflowVersions(spec.id);
    const newest = versions[0];
    if (newest && workflowSpecsEqual(newest.spec, spec)) {
      const deployed = { ...newest, deployed: true, trigger: 'deploy' as const };
      await this.storage.saveWorkflowVersion(deployed);
      this.markDeployed(spec.id);
      await this.refreshIfActive(spec.id);
      return deployed;
    }

    const savedAt = new Date().toISOString();
    const deployed: WorkflowVersion = {
      id: makeVersionId(spec.id),
      workflowId: spec.id,
      savedAt,
      trigger: 'deploy',
      deployed: true,
      spec: snapshot(spec, savedAt),
    };
    await this.storage.saveWorkflowVersion(deployed);
    this.markDeployed(spec.id);
    await this.refreshIfActive(spec.id);
    return deployed;
  }

  async deleteForWorkflow(workflowId: string): Promise<void> {
    await this.storage.removeWorkflowVersions(workflowId);
    this.unmarkDeployed(workflowId);
    if (this.workflowId() === workflowId) this.versions.set([]);
  }

  /** Adds a workflow id to the deployed set (called after a deploy record). */
  private markDeployed(workflowId: string): void {
    const current = this.deployedWorkflowIds();
    if (current.has(workflowId)) return;
    this.deployedWorkflowIds.set(new Set([...current, workflowId]));
  }

  /** Removes a workflow id from the deployed set (called on version delete or cloud purge). */
  unmarkDeployed(workflowId: string): void {
    const current = this.deployedWorkflowIds();
    if (!current.has(workflowId)) return;
    const next = new Set(current);
    next.delete(workflowId);
    this.deployedWorkflowIds.set(next);
  }

  private async refreshIfActive(workflowId: string): Promise<void> {
    if (this.workflowId() !== workflowId) return;
    this.versions.set(await this.storage.listWorkflowVersions(workflowId));
  }
}

function makeVersionId(workflowId: string): string {
  versionCounter += 1;
  return `ver-${workflowId}-${Date.now().toString(36)}-${versionCounter.toString(36)}`;
}

function snapshot(spec: WorkflowSpec, savedAt: string): WorkflowSpec {
  return { ...structuredClone(spec), savedAt };
}
