import { TestBed } from '@angular/core/testing';

import { ConnectionsService, newConnectionId } from './connections.service';
import { ConnectionStoreService } from './connection-store.service';
import { IndexedDbStorageService } from './indexed-db-storage.service';
import { TauriService } from './tauri.service';
import { WorkflowService } from './workflow.service';
import { WORKFLOW_SPEC_VERSION, type WorkflowSpec } from './workflow.model';

/**
 * Requirements 2.1, 2.2, 19.5, 19.6, 19.7, 19.8, 19.9: create/rename/delete
 * over Connection metadata, referencing-workflow detection ahead of a
 * delete, and the secret-entry gate on hosts with no `ConnectionStore`.
 */
describe('ConnectionsService', () => {
  let service: ConnectionsService;
  let db: IndexedDbStorageService;
  const savedConnectionIds: string[] = [];
  const savedWorkflowIds: string[] = [];

  function specWithConnection(connectionId: string): WorkflowSpec {
    return {
      version: WORKFLOW_SPEC_VERSION,
      id: `wf-${newConnectionId()}`,
      name: 'Referencing workflow',
      graph: {
        nodes: [
          {
            id: 'n1',
            name: 'Sync',
            kind: 'http-request',
            category: 'flow',
            icon: 'ti ti-world',
            position: { x: 0, y: 0 },
            ports: [],
            data: { connectionId, method: 'GET', url: '/x' },
          },
        ],
        connections: [],
      },
      savedAt: new Date().toISOString(),
    };
  }

  afterEach(async () => {
    while (savedConnectionIds.length > 0) {
      await db.removeConnection(savedConnectionIds.pop()!);
    }
    while (savedWorkflowIds.length > 0) {
      await db.removeWorkflow(savedWorkflowIds.pop()!);
    }
  });

  describe('on the desktop host', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [{ provide: TauriService, useValue: { isDesktop: true } }],
      });
      service = TestBed.inject(ConnectionsService);
      db = TestBed.inject(IndexedDbStorageService);
    });

    it('creates, renames and deletes a connection', async () => {
      const created = await service.create({ name: 'CRM', type: 'http' });
      savedConnectionIds.push(created.id);
      expect(created.id).toMatch(/^conn-[A-Za-z0-9_-]{1,64}$/);
      expect(service.connections().some(c => c.id === created.id)).toBeTrue();

      const renamed = await service.rename(created.id, 'CRM production');
      expect(renamed.name).toBe('CRM production');
      expect(service.connections().find(c => c.id === created.id)?.name).toBe('CRM production');

      await service.remove(created.id);
      savedConnectionIds.pop();
      expect(service.connections().some(c => c.id === created.id)).toBeFalse();
    });

    it('rejects a rename outside 1-100 characters, leaving the stored connection unchanged', async () => {
      const created = await service.create({ name: 'CRM', type: 'http' });
      savedConnectionIds.push(created.id);

      await expectAsync(service.rename(created.id, '')).toBeRejected();
      await expectAsync(service.rename(created.id, 'x'.repeat(101))).toBeRejected();

      expect(service.connections().find(c => c.id === created.id)?.name).toBe('CRM');
    });

    it('lists every workflow referencing a connection before deletion', async () => {
      const created = await service.create({ name: 'CRM', type: 'http' });
      savedConnectionIds.push(created.id);

      const workflow = TestBed.inject(WorkflowService);
      const spec = specWithConnection(created.id);
      const saved = await workflow.saveNewSpecToLibrary(spec);
      savedWorkflowIds.push(saved!.id);

      const referencing = service.referencingWorkflows(created.id);
      expect(referencing.map(w => w.id)).toContain(saved!.id);

      // A connection nobody references lists nothing.
      const other = await service.create({ name: 'Unused', type: 'http' });
      savedConnectionIds.push(other.id);
      expect(service.referencingWorkflows(other.id)).toEqual([]);
    });

    it('writes a secret directly to the host store and records only the field name', async () => {
      // No real keychain in this environment: stub the host write/presence
      // check so the test exercises `ConnectionsService`'s own contract
      // (never persisting the value, only the field NAME) rather than the
      // Tauri IPC bridge, which `ConnectionStoreService` already covers.
      const connectionStore = TestBed.inject(ConnectionStoreService);
      const writeSpy = spyOn(connectionStore, 'writeSecret').and.resolveTo(undefined);
      spyOn(connectionStore, 'secretPresent').and.resolveTo(true);

      const created = await service.create({ name: 'CRM', type: 'http' });
      savedConnectionIds.push(created.id);

      await service.writeSecret(created.id, 'apiKey', 'super-secret-value');

      expect(writeSpy).toHaveBeenCalledWith(created.id, 'apiKey', 'super-secret-value');
      const stored = service.connections().find(c => c.id === created.id);
      expect(stored?.secretKeys).toContain('apiKey');
      // The value itself never appears anywhere in the metadata record.
      expect(JSON.stringify(stored)).not.toContain('super-secret-value');
      expect(await service.secretPresent(created.id, 'apiKey')).toBeTrue();
    });
  });

  describe('on a host with no ConnectionStore (browser preview)', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [{ provide: TauriService, useValue: { isDesktop: false } }],
      });
      service = TestBed.inject(ConnectionsService);
      db = TestBed.inject(IndexedDbStorageService);
    });

    it('reports secrets as unsupported and rejects a secret write', async () => {
      expect(service.secretsSupported).toBeFalse();

      const created = await service.create({ name: 'CRM', type: 'http' });
      savedConnectionIds.push(created.id);

      await expectAsync(service.writeSecret(created.id, 'apiKey', 'value')).toBeRejected();
      expect(service.connections().find(c => c.id === created.id)?.secretKeys).not.toContain('apiKey');
    });
  });
});
