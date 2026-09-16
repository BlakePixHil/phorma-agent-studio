/**
 * `WorkflowService.restoreSpec` - the identity-preserving rail (Requirement 15).
 *
 * The distinction this suite defends is the reason the method exists at all.
 * `importSpec` is a COPY and mints a fresh id; `restoreSpec` is the SAME workflow
 * arriving from somewhere else and must keep its id, or the restored copy stops
 * addressing its own deployment instance, run history, usage rows and backup
 * revisions - leaving the original deployment exactly as orphaned as it was
 * before the restore.
 *
 * A regression here has no type error and no failing build: both methods put a
 * workflow in front of the user, and only the id tells them apart.
 */

import { TestBed } from '@angular/core/testing';
import fc from 'fast-check';

import { ConfirmDialogService } from '../shared/confirm-dialog/confirm-dialog.service';
import { IndexedDbStorageService } from './indexed-db-storage.service';
import { TauriService } from './tauri.service';
import { WorkflowService } from './workflow.service';
import { WORKFLOW_SPEC_VERSION, type WorkflowSpec } from './workflow.model';

/** An in-memory stand-in for the `workflows` object store. */
class StorageStub {
  readonly saved = new Map<string, WorkflowSpec>();
  listWorkflows = async (): Promise<WorkflowSpec[]> => [...this.saved.values()];
  getWorkflow = async (id: string): Promise<WorkflowSpec | undefined> => this.saved.get(id);
  saveWorkflow = async (spec: WorkflowSpec): Promise<void> => {
    this.saved.set(spec.id, structuredClone(spec));
  };
  removeWorkflow = async (id: string): Promise<void> => {
    this.saved.delete(id);
  };
  listWorkflowVersions = async (): Promise<never[]> => [];
  saveWorkflowVersion = async (): Promise<void> => undefined;
  removeWorkflowVersions = async (): Promise<void> => undefined;
  listDeployedWorkflowIds = async (): Promise<Set<string>> => new Set();
}

function spec(id: string, name = 'Payroll digest'): WorkflowSpec {
  return {
    version: WORKFLOW_SPEC_VERSION,
    id,
    name,
    description: 'Restored from the cloud',
    savedAt: '2026-01-01T00:00:00.000Z',
    graph: {
      nodes: [
        {
          id: 'trigger-1',
          name: 'Start',
          kind: 'manual-trigger',
          category: 'trigger',
          icon: 'ti ti-player-play',
          position: { x: 0, y: 0 },
          ports: [{ id: 'trigger-1-out', name: 'Out', role: 'message-out' }],
          data: {},
        },
        {
          id: 'agent-1',
          name: 'Summarize',
          kind: 'agent',
          category: 'flow',
          icon: 'ti ti-robot',
          position: { x: 240, y: 0 },
          ports: [
            { id: 'agent-1-in', name: 'In', role: 'message-in' },
            { id: 'agent-1-out', name: 'Out', role: 'message-out' },
          ],
          data: { prompt: 'Summarize the input.' },
        },
      ],
      connections: [
        { id: 'edge-1', outputId: 'trigger-1-out', inputId: 'agent-1-in', kind: 'handoff' },
      ],
    },
  };
}

describe('WorkflowService.restoreSpec (Requirement 15)', () => {
  let workflow: WorkflowService;
  let storage: StorageStub;
  let confirmed: boolean;

  beforeEach(() => {
    storage = new StorageStub();
    confirmed = true;
    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: { isDesktop: false } },
        { provide: IndexedDbStorageService, useValue: storage },
        {
          provide: ConfirmDialogService,
          useValue: {
            confirm: async () => confirmed,
            prompt: async () => 'Named by the test',
          },
        },
      ],
    });
    workflow = TestBed.inject(WorkflowService);
  });

  it('keeps the incoming id exactly (15.1)', async () => {
    const incoming = spec('wf-legacy-id-from-2024');
    const outcome = await workflow.restoreSpec(incoming);

    expect(outcome).toBe('restored');
    expect(storage.saved.has('wf-legacy-id-from-2024')).toBeTrue();
    expect(workflow.library().map(item => item.id)).toContain('wf-legacy-id-from-2024');
  });

  it('replaces the local copy when the user confirms (15.3)', async () => {
    await workflow.restoreSpec(spec('wf-dupe', 'Local edit'));
    confirmed = true;

    const outcome = await workflow.restoreSpec(spec('wf-dupe', 'Cloud copy'));

    expect(outcome).toBe('replaced');
    // The id is preserved on BOTH branches - no new id is ever minted here.
    expect([...storage.saved.keys()]).toEqual(['wf-dupe']);
    expect(storage.saved.get('wf-dupe')!.name).toBe('Cloud copy');
  });

  it('keeps the local copy when the user declines, minting no new id (15.3)', async () => {
    await workflow.restoreSpec(spec('wf-dupe', 'Local edit'));
    confirmed = false;

    const outcome = await workflow.restoreSpec(spec('wf-dupe', 'Cloud copy'));

    expect(outcome).toBe('kept-local');
    expect([...storage.saved.keys()]).toEqual(['wf-dupe']);
    expect(storage.saved.get('wf-dupe')!.name).toBe('Local edit');
  });

  it('honours an explicit collision policy without asking', async () => {
    // A restore-all cannot open one dialog per workflow, so the banner passes a
    // policy. The confirm stub would answer `true`, so `skip` proves the dialog
    // was not consulted at all.
    await workflow.restoreSpec(spec('wf-dupe', 'Local edit'));
    confirmed = true;

    expect(await workflow.restoreSpec(spec('wf-dupe', 'Cloud copy'), 'skip')).toBe('kept-local');
    expect(storage.saved.get('wf-dupe')!.name).toBe('Local edit');

    expect(await workflow.restoreSpec(spec('wf-dupe', 'Cloud copy'), 'replace')).toBe('replaced');
    expect(storage.saved.get('wf-dupe')!.name).toBe('Cloud copy');
  });

  it('leaves importSpec minting a fresh id (15.2)', async () => {
    const incoming = spec('wf-from-a-file');
    workflow.importSpec(incoming);
    // An import opens an UNSAVED tab, so nothing is in the library yet.
    expect(workflow.library()).toEqual([]);

    const saved = await workflow.saveActive();
    expect(saved).toBeTruthy();
    expect(saved!.id).not.toBe('wf-from-a-file');
    expect(saved!.id).toMatch(/^wf-[0-9a-z]+-[0-9a-f]{12}$/);
  });

  it('follows an open tab pointing at the restored workflow', async () => {
    await workflow.restoreSpec(spec('wf-open', 'First'));
    workflow.openWorkflow('wf-open');
    workflow.renameActive('Locally renamed');
    expect(workflow.isDirty()).toBeTrue();

    await workflow.restoreSpec(spec('wf-open', 'Cloud copy'), 'replace');

    // Without this the tab keeps editing the copy that was just replaced, and its
    // next save silently undoes the restore.
    expect(workflow.activeName()).toBe('Cloud copy');
    expect(workflow.isDirty()).toBeFalse();
  });

  it('round-trips identity through export and restore (property, 15.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^wf-[a-z0-9]{4,10}$/),
        fc.string({ minLength: 1, maxLength: 30 }),
        async (id, name) => {
          const original = spec(id, name);
          // Export is the serializer the backup and download paths both use.
          workflow.importSpec(original);
          const exported = workflow.exportActiveSpec();
          if (!exported) return false;
          // Import minted a new id; a real export of a SAVED workflow carries its
          // own, so restore the original identity onto the exported body - which
          // is exactly what a backup body holds.
          const body: WorkflowSpec = { ...exported, id: original.id };

          const outcome = await workflow.restoreSpec(body, 'replace');
          if (outcome !== 'restored' && outcome !== 'replaced') return false;

          const stored = storage.saved.get(original.id);
          if (!stored) return false;
          return (
            stored.id === original.id &&
            stored.name === original.name &&
            stored.graph.nodes.map(node => node.id).join(',') ===
              original.graph.nodes.map(node => node.id).join(',') &&
            JSON.stringify(stored.graph.connections) ===
              JSON.stringify(original.graph.connections)
          );
        },
      ),
      { numRuns: 40 },
    );
  });
});
