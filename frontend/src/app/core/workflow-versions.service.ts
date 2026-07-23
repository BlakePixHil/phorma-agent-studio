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
    await this.refreshIfActive(spec.id);
    return deployed;
  }

  async deleteForWorkflow(workflowId: string): Promise<void> {
    await this.storage.removeWorkflowVersions(workflowId);
    if (this.workflowId() === workflowId) this.versions.set([]);
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
