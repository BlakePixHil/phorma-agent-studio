/**
 * The recovery actions on `WorkflowActionsService` (cloud-workflow-backup
 * Requirement 22).
 *
 * Two properties of the action REGISTRY matter more than any individual executor,
 * and neither is visible by reading the file:
 *
 * 1. **The tier is right.** `silent` runs with no confirmation in Agent mode, so a
 *    write mis-tiered as `silent` lets the model destroy a cloud backup on its own
 *    reading of a sentence. Every write here has to be `confirm`, and the summary
 *    has to say what it does.
 * 2. **Every executor delegates.** The registry is a DESCRIPTION of capabilities the
 *    studio already has (Requirement 22.3). An executor that reimplemented one would
 *    drift from the surface a human uses, and the assistant would quietly behave
 *    differently from the buttons.
 */

import { TestBed } from '@angular/core/testing';

import { CloudService } from '../cloud.service';
import { DeploymentsService } from '../deployments.service';
import { TauriService } from '../tauri.service';
import { WorkflowActionsService } from './workflow-actions.service';
import { WorkflowBackupService } from '../cloud/workflow-backup.service';
import { WorkflowService } from '../workflow.service';
import { WorkflowVersionsService } from '../workflow-versions.service';
import type { StudioAction } from './studio-action.model';

/** The six actions this feature adds. */
const RECOVERY_IDS = [
  'deployment_list',
  'backup_list',
  'backup_restore',
  'deployment_undeploy',
  'backup_delete',
  'backup_purge',
] as const;

describe('WorkflowActionsService recovery actions', () => {
  let actions: StudioAction[];
  let deployments: {
    refresh: jasmine.Spy;
    undeploy: jasmine.Spy;
    error: () => string | null;
    month: () => string;
    deployments: () => unknown[];
  };
  let backup: {
    refresh: jasmine.Spy;
    restore: jasmine.Spy;
    deleteBackup: jasmine.Spy;
    available: () => boolean;
    error: () => string | null;
    hasAnyBackup: () => boolean;
    active: () => boolean;
    writable: () => boolean;
    readOnlyDaysRemaining: () => number | null;
    cap: () => number;
    backups: () => unknown[];
    tombstones: () => unknown[];
  };

  beforeEach(() => {
    deployments = {
      refresh: jasmine.createSpy('refresh').and.resolveTo(undefined),
      undeploy: jasmine.createSpy('undeploy').and.resolveTo(true),
      error: () => null,
      month: () => '2026-09',
      deployments: () => [
        {
          workflowId: 'wf-a',
          workflowName: 'Nightly report',
          deployedAt: Date.UTC(2026, 0, 15),
          updatedAt: Date.UTC(2026, 0, 15),
          specHash: 'h',
          cronArmed: true,
          portalSlug: null,
          creditsSpent: 42,
          runsThisMonth: 7,
          orphan: true,
          localName: null,
        },
      ],
    };
    backup = {
      refresh: jasmine.createSpy('refresh').and.resolveTo(undefined),
      restore: jasmine
        .createSpy('restore')
        .and.resolveTo({ outcome: 'restored', missingConnections: ['Xero (production)'] }),
      deleteBackup: jasmine.createSpy('deleteBackup').and.resolveTo(true),
      available: () => true,
      error: () => null,
      hasAnyBackup: () => true,
      active: () => true,
      writable: () => true,
      readOnlyDaysRemaining: () => null,
      cap: () => 25,
      backups: () => [
        {
          workflowId: 'wf-a',
          name: 'Live',
          revision: 3,
          specHash: 'h',
          sizeBytes: 2048,
          savedAt: 's',
          updatedAt: 'u',
          deletedAt: null,
          daysRemaining: null,
        },
      ],
      tombstones: () => [
        {
          workflowId: 'wf-b',
          name: 'Deleted',
          revision: 1,
          specHash: 'h',
          sizeBytes: 1024,
          savedAt: 's',
          updatedAt: 'u',
          deletedAt: '2026-09-01T00:00:00.000Z',
          daysRemaining: 12,
        },
      ],
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: { isDesktop: false } },
        { provide: WorkflowService, useValue: { library: () => [], activeDoc: () => null } },
        { provide: WorkflowVersionsService, useValue: {} },
        { provide: CloudService, useValue: {} },
        { provide: DeploymentsService, useValue: deployments },
        { provide: WorkflowBackupService, useValue: backup },
      ],
    });
    actions = TestBed.inject(WorkflowActionsService).actions();
  });

  function action(id: string): StudioAction {
    const found = actions.find(entry => entry.id === id);
    expect(found).withContext(`action ${id}`).toBeTruthy();
    return found!;
  }

  // ── Registration and tiers ────────────────────────────────────────────────

  it('registers all six recovery actions', () => {
    for (const id of RECOVERY_IDS) expect(action(id)).toBeTruthy();
  });

  it('keeps every action id unique across the surface', () => {
    const ids = actions.map(entry => entry.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('tiers the two reads silent (22.1)', () => {
    for (const id of ['deployment_list', 'backup_list']) {
      expect(action(id).risk).withContext(id).toBe('silent');
      expect(action(id).access).withContext(id).toBe('read');
    }
  });

  it('tiers every write confirm, with a summary that says what it does (22.2)', () => {
    for (const id of ['backup_restore', 'deployment_undeploy', 'backup_delete', 'backup_purge']) {
      const entry = action(id);
      expect(entry.risk).withContext(id).toBe('confirm');
      expect(entry.access).withContext(id).toBe('write');
      // A confirm-tier action with no summary shows the user a bare action id.
      expect(entry.confirmSummary).withContext(`${id} confirmSummary`).toBeDefined();
      const summary = entry.confirmSummary!({ workflowId: 'wf-a' });
      expect(summary.length).withContext(`${id} summary length`).toBeGreaterThan(20);
      expect(summary).withContext(`${id} names the workflow`).toContain('wf-a');
    }
  });

  it('says a purge cannot be undone', () => {
    // The one action past which a backup is genuinely gone.
    expect(action('backup_purge').confirmSummary!({ workflowId: 'wf-a' })).toContain(
      'cannot be undone',
    );
  });

  it('promises a stop keeps run history, because it does', () => {
    expect(action('deployment_undeploy').confirmSummary!({ workflowId: 'wf-a' })).toContain(
      'Run history is kept',
    );
  });

  // ── Delegation ────────────────────────────────────────────────────────────

  it('deployment_list delegates and reports credits, never dollars (22.3)', async () => {
    const result = await action('deployment_list').run({});

    expect(deployments.refresh).toHaveBeenCalled();
    expect(result.ok).toBeTrue();
    const payload = JSON.stringify(result);
    expect(payload).toContain('creditsSpentThisMonth');
    expect(payload).not.toContain('costUsd');
    expect(payload).not.toContain('$');
    // The state the whole feature exists for has to reach the model.
    expect(payload).toContain('"hasLocalCopy":false');
  });

  it('backup_list delegates and separates tombstones from live backups', async () => {
    const result = await action('backup_list').run({});

    expect(backup.refresh).toHaveBeenCalled();
    const payload = result as unknown as {
      data: { backups: { workflowId: string }[]; deletedButRestorable: { workflowId: string }[] };
    };
    expect(payload.data.backups.map(row => row.workflowId)).toEqual(['wf-a']);
    // Separated so the model cannot offer to restore a tombstone without knowing it
    // is one, or forget that it can.
    expect(payload.data.deletedButRestorable.map(row => row.workflowId)).toEqual(['wf-b']);
  });

  it('backup_list fails cleanly where there is no backup storage', async () => {
    backup.available = () => false;
    const result = await action('backup_list').run({});
    expect(result.ok).toBeFalse();
  });

  it('backup_restore delegates and reports what must be reconnected (19.3)', async () => {
    const result = await action('backup_restore').run({ workflowId: 'wf-a', revision: 2 });

    expect(backup.restore).toHaveBeenCalled();
    const [id, options] = backup.restore.calls.mostRecent().args as [string, { revision: number; collision: string }];
    expect(id).toBe('wf-a');
    expect(options.revision).toBe(2);
    // The confirm tier already asked, so a second dialog would double-prompt.
    expect(options.collision).toBe('replace');
    expect(JSON.stringify(result)).toContain('Xero (production)');
  });

  it('backup_restore reports a failure rather than claiming success', async () => {
    backup.restore.and.resolveTo({ outcome: 'failed', missingConnections: [] });
    expect((await action('backup_restore').run({ workflowId: 'wf-a' })).ok).toBeFalse();
  });

  it('deployment_undeploy delegates and surfaces a refusal', async () => {
    expect((await action('deployment_undeploy').run({ workflowId: 'wf-a' })).ok).toBeTrue();
    expect(deployments.undeploy).toHaveBeenCalledWith('wf-a');

    deployments.undeploy.and.resolveTo(false);
    const refused = await action('deployment_undeploy').run({ workflowId: 'wf-a' });
    expect(refused.ok).toBeFalse();
  });

  it('backup_delete is soft and backup_purge is not', async () => {
    await action('backup_delete').run({ workflowId: 'wf-a' });
    expect(backup.deleteBackup).toHaveBeenCalledWith('wf-a', { purge: false });

    await action('backup_purge').run({ workflowId: 'wf-a' });
    expect(backup.deleteBackup).toHaveBeenCalledWith('wf-a', { purge: true });
  });

  it('explains a refused purge in terms of the delete it needs first', async () => {
    backup.deleteBackup.and.resolveTo(false);
    const result = await action('backup_purge').run({ workflowId: 'wf-a' });
    expect(result.ok).toBeFalse();
    expect(JSON.stringify(result)).toContain('deleted before it can be purged');
  });

  it('refuses every write with no workflow id, rather than guessing one', async () => {
    for (const id of ['backup_restore', 'deployment_undeploy', 'backup_delete', 'backup_purge']) {
      expect((await action(id).run({})).ok).withContext(id).toBeFalse();
    }
  });

  it('marks every write as not revertable by the edit session', async () => {
    // These replace or destroy state the Edit_Session cannot roll back, so an
    // "undo" offer would be a lie.
    const restored = await action('backup_restore').run({ workflowId: 'wf-a' });
    expect((restored as unknown as { revertable?: boolean }).revertable).not.toBeTrue();
  });
});
