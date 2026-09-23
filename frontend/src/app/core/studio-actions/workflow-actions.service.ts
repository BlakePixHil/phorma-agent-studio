import { Injectable, inject } from '@angular/core';

import { CloudService } from '../cloud.service';
import { DeploymentsService } from '../deployments.service';
import { TauriService } from '../tauri.service';
import { WorkflowBackupService } from '../cloud/workflow-backup.service';
import { WorkflowService } from '../workflow.service';
import { WorkflowVersionsService } from '../workflow-versions.service';
import { hasPromptField } from './graph-actions.service';
import type { BackupSummary } from '../backup.model';
import {
  actionFail,
  actionOk,
  argBool,
  argNum,
  argStr,
  type ActionArgs,
  type ActionResult,
  type StudioAction,
} from './studio-action.model';

/** Cap on version rows returned by a single list call. */
const VERSION_LIST_LIMIT = 20;

/**
 * Surfaces `workflows`, `versions` and `deploy` (Requirement 2.4).
 *
 * Deleting a workflow or restoring a version replaces state the Edit_Session
 * cannot roll back, so both are confirm-tier and report `revertable: false`
 * (Requirements 6.1, 7.4). Running wrangler needs the desktop shell, so that
 * action is guarded through {@link TauriService} (Requirements 10.4, 10.5).
 *
 * Declared minimums (multi-organisation-phorma Requirement 8.1). Three lines run
 * through this surface, and they are not the same line:
 *
 * - READING is open: listing the library, reading a workflow, listing versions,
 *   reading the deploy state and listing deployments are all `read.workflows` or
 *   `read.runs`. `workflow_open` is here too - opening a document changes
 *   nothing, and a member with no local library simply has nothing to open.
 * - `workflow_save` is EDITOR, not builder. An editor's whole job is changing
 *   values inside an existing graph, and a change they cannot persist is not a
 *   change. Minting a NEW workflow is `workflow_create`, which is builder.
 * - Everything that alters the graph wholesale, ships it, or destroys stored
 *   copies is BUILDER: `version_restore` (a whole-graph replacement),
 *   `deploy_workflow` and `deploy_provision_worker` (`deploy.push`),
 *   `workflow_delete` and `deployment_undeploy` (`deploy.delete`), and the four
 *   backup actions, which read and write the LOCAL library a member working out
 *   of the cloud does not have (Requirement 9.4).
 */
@Injectable({ providedIn: 'root' })
export class WorkflowActionsService {
  private readonly workflow = inject(WorkflowService);
  private readonly versions = inject(WorkflowVersionsService);
  private readonly cloud = inject(CloudService);
  private readonly tauri = inject(TauriService);
  // The recovery surfaces. Both PIN Phorma Cloud rather than the chosen deploy
  // target, and both sit downstream of `CloudService`, so injecting them here adds
  // no edge the action registry does not already have.
  private readonly deployments = inject(DeploymentsService);
  private readonly backup = inject(WorkflowBackupService);

  actions(): StudioAction[] {
    return [
      {
        id: 'workflow_list',
        label: 'List saved workflows',
        description:
          'Lists the saved workflow library with ids, names, descriptions, node counts and which one is active.',
        surface: 'workflows',
        access: 'read',
        risk: 'silent',
        minLevel: 'operator',
        activity: () => 'Listing saved workflows',
        run: () => this.list(),
      },
      {
        id: 'workflow_read_active',
        label: 'Read the active workflow',
        description:
          'Returns the active document: name, description, saved workflow id, dirty state, workflow-level settings and node/connection counts.',
        surface: 'workflows',
        access: 'read',
        risk: 'silent',
        minLevel: 'operator',
        activity: () => 'Reading the active workflow',
        run: () => this.readActive(),
      },
      {
        id: 'workflow_read',
        label: 'Read a workflow',
        description:
          'Returns another workflow in full: every node with its id, kind, name and ports, plus every connection. Set includePrompts to also get the agent prompt bodies. Use this for workflows the user added to the context, or any saved workflow.',
        surface: 'workflows',
        access: 'read',
        risk: 'silent',
        minLevel: 'operator',
        params: {
          workflowId: {
            type: 'string',
            description: 'Library workflow id. Omit to read the active document.',
          },
          name: {
            type: 'string',
            description: 'Display name, for an unsaved draft that has no id.',
          },
          includePrompts: {
            type: 'boolean',
            description: 'Include full markdown prompt bodies. Defaults to false.',
          },
        },
        activity: args => `Reading "${argStr(args, 'name') ?? this.libraryName(argStr(args, 'workflowId'))}"`,
        run: args => this.read(args),
      },
      {
        id: 'workflow_open',
        label: 'Open a workflow',
        description:
          'Opens a saved workflow from the library in a tab and makes it the active document.',
        surface: 'workflows',
        access: 'write',
        risk: 'silent',
        minLevel: 'operator',
        params: {
          workflowId: { type: 'string', description: 'Library workflow id.', required: true },
        },
        activity: args => `Opening "${this.libraryName(argStr(args, 'workflowId'))}"`,
        run: args => this.open(args),
      },
      {
        id: 'workflow_create',
        label: 'Create a workflow',
        description:
          'Opens a fresh empty workflow tab and makes it active. Save it with workflow_save to add it to the library.',
        surface: 'workflows',
        access: 'write',
        risk: 'silent',
        minLevel: 'builder',
        activity: () => 'Creating a new workflow',
        run: () => this.create(),
      },
      {
        id: 'workflow_save',
        label: 'Save the active workflow',
        description:
          'Saves the active document into the library. An unnamed draft prompts the user for a name.',
        surface: 'workflows',
        access: 'write',
        risk: 'silent',
        minLevel: 'editor',
        activity: () => `Saving "${this.workflow.activeName()}"`,
        run: () => this.save(),
      },
      {
        id: 'workflow_delete',
        label: 'Delete a workflow',
        description:
          'Removes a workflow from the library along with its version history. If it is deployed to Phorma Cloud, also tears down its cloud deployment (Durable Object, portal and session instances).',
        surface: 'workflows',
        access: 'write',
        risk: 'confirm',
        minLevel: 'builder',
        params: {
          workflowId: { type: 'string', description: 'Library workflow id.', required: true },
        },
        confirmSummary: args =>
          `Delete "${this.libraryName(argStr(args, 'workflowId'))}" from the library, including its version history? This cannot be undone.`,
        activity: args => `Deleting "${this.libraryName(argStr(args, 'workflowId'))}"`,
        run: args => this.remove(args),
      },
      {
        id: 'version_list',
        label: 'List versions',
        description:
          'Lists saved versions of the active workflow, newest first, with what triggered each save and whether it was deployed.',
        surface: 'versions',
        access: 'read',
        risk: 'silent',
        minLevel: 'operator',
        params: {
          limit: { type: 'number', description: `Maximum rows (default ${VERSION_LIST_LIMIT}).` },
        },
        activity: () => 'Listing workflow versions',
        run: args => this.listVersions(args),
      },
      {
        id: 'version_restore',
        label: 'Restore a version',
        description:
          'Replaces the active workflow with a saved version. The current state is recorded as a version first, so nothing is lost.',
        surface: 'versions',
        access: 'write',
        risk: 'confirm',
        minLevel: 'builder',
        params: {
          versionId: { type: 'string', description: 'Version id.', required: true },
        },
        confirmSummary: args =>
          `Restore "${this.workflow.activeName()}" to the version saved ${this.versionStamp(argStr(args, 'versionId'))}? The current state is saved as a version first.`,
        activity: () => 'Restoring a workflow version',
        run: args => this.restoreVersion(args),
      },
      {
        id: 'deploy_read_state',
        label: 'Read the deployment state',
        description:
          'Returns the cloud provider, whether it is configured, the worker URL, the live monitor connection and whether the active workflow has a deployed version.',
        surface: 'deploy',
        access: 'read',
        risk: 'silent',
        minLevel: 'operator',
        activity: () => 'Reading the deployment state',
        run: () => this.readDeployState(),
      },
      {
        id: 'deploy_workflow',
        label: 'Deploy the active workflow',
        description:
          'Pushes the active workflow to the configured cloud runtime so it can run on triggers and schedules. Requires a saved workflow and a configured provider.',
        surface: 'deploy',
        access: 'write',
        risk: 'confirm',
        minLevel: 'builder',
        confirmSummary: () =>
          `Deploy "${this.workflow.activeName()}" to ${this.cloud.effectiveWorkerUrl() || 'the configured cloud runtime'}? It becomes live for triggers and schedules.`,
        activity: () => `Deploying "${this.workflow.activeName()}"`,
        run: () => this.deployWorkflow(),
      },
      {
        id: 'deploy_provision_worker',
        label: 'Provision the worker',
        description:
          'Runs wrangler to deploy the Cloudflare worker itself (bring-your-own Cloudflare only). Desktop application required.',
        surface: 'deploy',
        access: 'write',
        risk: 'confirm',
        minLevel: 'builder',
        requiresDesktop: true,
        confirmSummary: () =>
          'Run wrangler to deploy the Cloudflare worker from your local cloud/ folder? This changes live infrastructure in your Cloudflare account.',
        activity: () => 'Deploying the Cloudflare worker',
        run: () => this.provisionWorker(),
      },

      // ── Recovery: deployments and cloud backups ────────────────────────────
      //
      // Every executor below DELEGATES to `DeploymentsService`, `WorkflowBackupService`
      // or `WorkflowService`; nothing here reimplements a capability
      // (Requirement 22.3). The two reads are `silent`, and the four writes are
      // `confirm` because each one either destroys something in the cloud or replaces
      // a local workflow the Edit_Session cannot roll back (Requirement 22.2).
      //
      // The data reaches the model through READ ACTIONS, never a system prompt
      // (Requirement 22.4), so prompt size stays flat as an account accumulates
      // deployments and backups.
      {
        id: 'deployment_list',
        label: 'List cloud deployments',
        description:
          "Lists every workflow currently deployed in the user's Phorma Cloud account, with the credits each has spent this month, whether a schedule is armed, any published portal address, and whether a local copy exists. Use this to find a deployment the user cannot account for.",
        surface: 'deploy',
        access: 'read',
        risk: 'silent',
        minLevel: 'operator',
        activity: () => 'Listing cloud deployments',
        run: () => this.listDeployments(),
      },
      {
        id: 'backup_list',
        label: 'List cloud backups',
        description:
          "Lists the workflows in the user's Phorma Cloud backup, with their version number, size and whether they are deleted but still restorable. Use this before offering to restore anything.",
        surface: 'workflows',
        access: 'read',
        risk: 'silent',
        minLevel: 'builder',
        activity: () => 'Listing cloud backups',
        run: () => this.listBackups(),
      },
      {
        id: 'backup_restore',
        label: 'Restore a workflow from backup',
        description:
          'Restores a workflow from the cloud backup into the local library, keeping its original id so it still addresses its own deployment and history. Replaces a local workflow with the same id.',
        surface: 'workflows',
        access: 'write',
        risk: 'confirm',
        minLevel: 'builder',
        params: {
          workflowId: { type: 'string', description: 'Backed-up workflow id.', required: true },
          revision: {
            type: 'number',
            description: 'Version to restore. Omit for the newest.',
          },
        },
        confirmSummary: args =>
          `Restore '${argStr(args, 'workflowId') ?? 'the workflow'}' from your cloud backup? A local workflow with the same id is replaced.`,
        activity: () => 'Restoring from cloud backup',
        run: args => this.restoreBackup(args),
      },
      {
        id: 'deployment_undeploy',
        label: 'Stop a cloud deployment',
        description:
          'Stops a deployed workflow: scheduled runs are cancelled and the deployed copy removed, while run history and usage are kept. Reversible by deploying again.',
        surface: 'deploy',
        access: 'write',
        risk: 'confirm',
        minLevel: 'builder',
        params: {
          workflowId: { type: 'string', description: 'Deployed workflow id.', required: true },
        },
        confirmSummary: args =>
          `Stop the cloud deployment of '${argStr(args, 'workflowId') ?? 'the workflow'}'? Scheduled runs stop and any published page goes offline. Run history is kept.`,
        activity: () => 'Stopping a cloud deployment',
        run: args => this.undeployWorkflow(args),
      },
      {
        id: 'backup_delete',
        label: 'Delete a cloud backup',
        description:
          'Marks a cloud backup deleted. It stays restorable for 30 days, then it is removed. The local workflow is not touched.',
        surface: 'workflows',
        access: 'write',
        risk: 'confirm',
        minLevel: 'builder',
        params: {
          workflowId: { type: 'string', description: 'Backed-up workflow id.', required: true },
        },
        confirmSummary: args =>
          `Delete the cloud backup of '${argStr(args, 'workflowId') ?? 'the workflow'}'? It stays restorable for 30 days. The local copy is not touched.`,
        activity: () => 'Deleting a cloud backup',
        run: args => this.deleteBackup(args, false),
      },
      {
        id: 'backup_purge',
        label: 'Permanently delete a cloud backup',
        description:
          'Destroys every stored copy of a backup immediately, earlier versions included. Only works on a backup that has already been deleted. Cannot be undone.',
        surface: 'workflows',
        access: 'write',
        risk: 'confirm',
        minLevel: 'builder',
        params: {
          workflowId: { type: 'string', description: 'Backed-up workflow id.', required: true },
        },
        confirmSummary: args =>
          `Permanently destroy every stored copy of '${argStr(args, 'workflowId') ?? 'the workflow'}'? This cannot be undone.`,
        activity: () => 'Permanently deleting a cloud backup',
        run: args => this.deleteBackup(args, true),
      },
    ];
  }

  // ── Executors ────────────────────────────────────────────────────────────

  private list(): ActionResult {
    const activeId = this.workflow.activeDoc()?.workflowId ?? null;
    return actionOk({
      workflows: this.workflow.library().map(spec => ({
        id: spec.id,
        name: spec.name,
        description: spec.description,
        nodes: spec.graph.nodes.length,
        savedAt: spec.savedAt,
        active: spec.id === activeId,
      })),
    });
  }

  private readActive(): ActionResult {
    const doc = this.workflow.activeDoc();
    if (!doc) return actionFail('No workflow document is open.');
    return actionOk({
      workflowId: doc.workflowId,
      name: doc.name,
      description: doc.description,
      dirty: doc.dirty,
      readOnly: doc.readOnly ?? false,
      settings: doc.settings,
      nodes: doc.graph.nodes.length,
      connections: doc.graph.connections.length,
    });
  }

  /**
   * Reads any workflow's graph. Resolution order is OPEN TABS first, then the
   * saved library: a tab the user is working in (or added to the assistant's
   * context) carries unsaved edits the library copy does not have, and the tab
   * is what the user means.
   */
  private read(args: ActionArgs): ActionResult {
    const workflowId = argStr(args, 'workflowId');
    const name = argStr(args, 'name');
    const docs = this.workflow.documents();
    const doc =
      workflowId || name
        ? (docs.find(item => workflowId !== undefined && item.workflowId === workflowId) ??
          docs.find(item => name !== undefined && item.name.toLowerCase() === name.toLowerCase()))
        : (this.workflow.activeDoc() ?? undefined);

    const source = doc
      ? { workflowId: doc.workflowId, name: doc.name, graph: doc.graph, open: true }
      : (() => {
          const spec = this.workflow.library().find(item => item.id === workflowId);
          return spec
            ? { workflowId: spec.id, name: spec.name, graph: spec.graph, open: false }
            : null;
        })();
    if (!source) {
      return actionFail(
        `No open tab or saved workflow matches ${workflowId ? `id '${workflowId}'` : `the name "${name ?? ''}"`}.`,
      );
    }

    const includePrompts = argBool(args, 'includePrompts') ?? false;
    return actionOk({
      workflowId: source.workflowId,
      name: source.name,
      open: source.open,
      nodes: source.graph.nodes.map(node => ({
        id: node.id,
        kind: node.kind,
        name: node.name,
        ports: node.ports.map(port => ({ name: port.name, role: port.role })),
        ...promptField(node.data, includePrompts),
      })),
      connections: source.graph.connections.map(conn => ({
        id: conn.id,
        kind: conn.kind,
        outputId: conn.outputId,
        inputId: conn.inputId,
      })),
    });
  }

  private open(args: ActionArgs): ActionResult {
    const workflowId = argStr(args, 'workflowId');
    if (!workflowId) return actionFail('Missing the workflow id.');
    if (!this.workflow.library().some(spec => spec.id === workflowId)) {
      return actionFail(`Workflow '${workflowId}' is not in the library.`);
    }
    this.workflow.openWorkflow(workflowId);
    return actionOk(
      { workflowId, name: this.libraryName(workflowId) },
      { revertable: false },
    );
  }

  private create(): ActionResult {
    this.workflow.newWorkflow();
    return actionOk({ created: true }, { revertable: false });
  }

  private async save(): Promise<ActionResult> {
    const doc = this.workflow.activeDoc();
    if (!doc) return actionFail('No workflow document is open.');
    if (doc.readOnly) return actionFail('This is a read-only preview; restore it before saving.');
    const spec = await this.workflow.saveActive('manual');
    if (!spec) return actionFail('The workflow was not saved.');
    return actionOk({ workflowId: spec.id, name: spec.name }, { revertable: false });
  }

  private async remove(args: ActionArgs): Promise<ActionResult> {
    const workflowId = argStr(args, 'workflowId');
    if (!workflowId) return actionFail('Missing the workflow id.');
    const name = this.libraryName(workflowId);
    if (!this.workflow.library().some(spec => spec.id === workflowId)) {
      return actionFail(`Workflow '${workflowId}' is not in the library.`);
    }
    // Purge the cloud deployment first (best-effort): a deployed workflow's
    // Durable Object, portal and session DOs must be torn down or they
    // outlive the local workflow with no way for the user to remove them. A
    // failure only warns - the local delete still completes.
    await this.cloud.purgeIfDeployed(workflowId).catch(() => undefined);
    await this.workflow.removeFromLibrary(workflowId);
    return actionOk({ workflowId, name }, { revertable: false });
  }

  private async listVersions(args: ActionArgs): Promise<ActionResult> {
    const workflowId = this.workflow.activeDoc()?.workflowId;
    if (!workflowId) {
      return actionFail('Save this workflow before it can have version history.');
    }
    const limit = Math.max(1, Math.min(argNum(args, 'limit') ?? VERSION_LIST_LIMIT, 50));
    const versions = await this.versions.load(workflowId);
    return actionOk({
      workflowId,
      versions: versions.slice(0, limit).map(version => ({
        id: version.id,
        savedAt: version.savedAt,
        trigger: version.trigger,
        deployed: version.deployed ?? false,
        nodes: version.spec.graph.nodes.length,
      })),
    });
  }

  private async restoreVersion(args: ActionArgs): Promise<ActionResult> {
    const versionId = argStr(args, 'versionId');
    if (!versionId) return actionFail('Missing the version id.');
    const workflowId = this.workflow.activeDoc()?.workflowId;
    if (!workflowId) {
      return actionFail('Save this workflow before restoring a version.');
    }
    const versions = await this.versions.load(workflowId);
    const version = versions.find(item => item.id === versionId);
    if (!version) return actionFail(`Version '${versionId}' was not found for this workflow.`);
    const restored = await this.workflow.restoreVersion(version);
    if (!restored) return actionFail('The version was not restored.');
    return actionOk({ versionId, savedAt: version.savedAt }, { revertable: false });
  }

  private readDeployState(): ActionResult {
    const workflowId = this.workflow.activeDoc()?.workflowId ?? null;
    const deployedVersion = this.versions
      .versions()
      .find(version => version.deployed && version.workflowId === workflowId);
    return actionOk({
      provider: this.cloud.provider(),
      configured: this.cloud.configured(),
      workerUrl: this.cloud.effectiveWorkerUrl(),
      monitor: this.cloud.connection(),
      deploying: this.cloud.deploying(),
      workflowId,
      lastDeployedAt: deployedVersion?.savedAt ?? null,
      desktop: this.tauri.isDesktop,
    });
  }

  private async deployWorkflow(): Promise<ActionResult> {
    const doc = this.workflow.activeDoc();
    if (!doc) return actionFail('No workflow document is open.');
    if (doc.readOnly) {
      return actionFail('This is a read-only preview; restore it before deploying.');
    }
    if (!doc.workflowId) return actionFail('Save the workflow before deploying it.');
    if (!this.cloud.provider()) {
      return actionFail('Pick a cloud provider in Settings, Cloud before deploying.');
    }
    if (!this.cloud.configured()) {
      return actionFail('The cloud provider is not configured yet, so there is nowhere to deploy.');
    }
    const pushed = await this.cloud.pushWorkflow();
    if (!pushed) {
      return actionFail('The deploy was rejected; the toast and Problems console have the reason.');
    }
    return actionOk(
      { workflowId: doc.workflowId, workerUrl: this.cloud.effectiveWorkerUrl() },
      { revertable: false },
    );
  }

  private async provisionWorker(): Promise<ActionResult> {
    await this.cloud.deploy();
    return actionOk({ started: true }, { revertable: false });
  }

  // ── Recovery executors ────────────────────────────────────────────────────

  private async listDeployments(): Promise<ActionResult> {
    await this.deployments.refresh();
    const failure = this.deployments.error();
    if (failure && this.deployments.deployments().length === 0) return actionFail(failure);
    return actionOk({
      month: this.deployments.month(),
      // Credits, never dollars - the worker has already converted.
      deployments: this.deployments.deployments().map(row => ({
        workflowId: row.workflowId,
        name: row.workflowName,
        deployedAt: new Date(row.deployedAt).toISOString(),
        cronArmed: row.cronArmed,
        portalSlug: row.portalSlug,
        creditsSpentThisMonth: row.creditsSpent,
        runsThisMonth: row.runsThisMonth,
        // The state worth naming: deployed, spending, and with no local copy.
        hasLocalCopy: !row.orphan,
      })),
    });
  }

  private async listBackups(): Promise<ActionResult> {
    await this.backup.refresh();
    if (!this.backup.available()) {
      return actionFail('This deployment has no cloud backup storage.');
    }
    const failure = this.backup.error();
    if (failure && !this.backup.hasAnyBackup()) return actionFail(failure);
    const project = (row: BackupSummary): Record<string, unknown> => ({
      workflowId: row.workflowId,
      name: row.name,
      revision: row.revision,
      sizeBytes: row.sizeBytes,
      savedAt: row.savedAt,
      deleted: row.deletedAt !== null,
      daysUntilRemoved: row.daysRemaining,
    });
    return actionOk({
      backingUp: this.backup.active(),
      writable: this.backup.writable(),
      readOnlyDaysRemaining: this.backup.readOnlyDaysRemaining(),
      cap: this.backup.cap(),
      backups: this.backup.backups().map(project),
      // Listed separately so the model cannot offer to restore a tombstone without
      // knowing it is one, or forget that it can.
      deletedButRestorable: this.backup.tombstones().map(project),
    });
  }

  private async restoreBackup(args: ActionArgs): Promise<ActionResult> {
    const workflowId = argStr(args, 'workflowId');
    if (!workflowId) return actionFail('Missing the workflow id.');
    const revision = argNum(args, 'revision');
    const result = await this.backup.restore(workflowId, {
      revision: revision === undefined ? undefined : Math.max(1, Math.round(revision)),
      // The confirm tier already asked, so a second dialog would double-prompt.
      collision: 'replace',
    });
    if (result.outcome === 'failed') return actionFail('The backup could not be restored.');
    return actionOk(
      {
        workflowId,
        outcome: result.outcome,
        // Reported, not fixed: a connection needs a credential and a backup carries
        // none, so the user has to reconnect these by hand.
        reconnectRequired: result.missingConnections,
      },
      { revertable: false },
    );
  }

  private async undeployWorkflow(args: ActionArgs): Promise<ActionResult> {
    const workflowId = argStr(args, 'workflowId');
    if (!workflowId) return actionFail('Missing the workflow id.');
    const stopped = await this.deployments.undeploy(workflowId);
    if (!stopped) {
      return actionFail('The deployment was not stopped. A run may still be in progress.');
    }
    return actionOk({ workflowId, stopped: true }, { revertable: false });
  }

  private async deleteBackup(args: ActionArgs, purge: boolean): Promise<ActionResult> {
    const workflowId = argStr(args, 'workflowId');
    if (!workflowId) return actionFail('Missing the workflow id.');
    const done = await this.backup.deleteBackup(workflowId, { purge });
    if (!done) {
      return actionFail(
        purge
          ? 'The backup was not purged. It has to be deleted before it can be purged.'
          : 'The backup was not deleted.',
      );
    }
    return actionOk({ workflowId, purged: purge }, { revertable: false });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private libraryName(workflowId: string | undefined): string {
    if (!workflowId) return 'the workflow';
    return this.workflow.library().find(spec => spec.id === workflowId)?.name ?? workflowId;
  }

  private versionStamp(versionId: string | undefined): string {
    const version = this.versions.versions().find(item => item.id === versionId);
    return version ? new Date(version.savedAt).toLocaleString() : (versionId ?? 'earlier');
  }
}

/**
 * The prompt projection for one node: the full body when asked for, otherwise
 * just its size, so a whole-workflow read stays cheap by default.
 */
function promptField(data: unknown, includePrompts: boolean): Record<string, unknown> {
  if (!hasPromptField(data)) return {};
  return includePrompts
    ? { prompt: data.prompt }
    : { promptChars: data.prompt.length };
}
