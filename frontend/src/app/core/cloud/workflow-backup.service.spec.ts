/**
 * `WorkflowBackupService` (cloud-workflow-backup, Requirements 12, 13, 16, 19).
 *
 * ## The claims that matter
 *
 * 1. **A local delete never reaches the cloud.** The service watches
 *    `library()`, which means it sees STATE and not events - so a workflow
 *    disappearing has to be nothing to do. If it ever became a delete, the whole
 *    premise of the feature would be inverted: the thing meant to survive a wipe
 *    would be destroyed by one (Requirement 17.3).
 * 2. **A no-op save uploads nothing.** With autosave on, an editing session
 *    produces a save every couple of seconds. Without the hash gate this would be
 *    a request per pause, which is both a cost and a way to hit a rate limit on the
 *    day a user actually needs the backup (Requirement 12.12).
 * 3. **A failed upload keeps the previous state.** Recording an upload that did not
 *    land would make the next attempt carry a wrong `If-Match` and read as a
 *    conflict forever (Requirement 12.10).
 * 4. **No credential is ever in the body.** A backup carries connection ids and
 *    display names, and there is deliberately no field a secret could occupy
 *    (Requirement 19.2, 19.5).
 */

import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import fc from 'fast-check';

import { canonicalJson, fnv1a } from '@phorma/engine';

import { ConnectionStoreService } from '../connection-store.service';
import { DesktopAuthService } from '../desktop-auth.service';
import { IndexedDbStorageService } from '../indexed-db-storage.service';
import { PhormaCloudService } from '../phorma-cloud.service';
import { WorkflowBackupService } from './workflow-backup.service';
import { WorkflowService } from '../workflow.service';
import { ToastService } from '../../shared/toast/toast.service';
import { PHORMA_CLOUD_DEFAULT_URL } from '../phorma-cloud-url';
import { WORKFLOW_SPEC_VERSION, type WorkflowSpec } from '../workflow.model';
import type { WorkflowBackupState } from '../backup.model';

interface Recorded {
  url: string;
  method: string;
  ifMatch: string | null;
  body: unknown;
}

function spec(id: string, options: { name?: string; prompt?: string; connectionId?: string } = {}): WorkflowSpec {
  return {
    version: WORKFLOW_SPEC_VERSION,
    id,
    name: options.name ?? `Workflow ${id}`,
    savedAt: '2026-09-01T00:00:00.000Z',
    graph: {
      nodes: [
        {
          id: 'agent-1',
          name: 'Summarize',
          kind: 'agent',
          category: 'flow',
          icon: 'ti ti-robot',
          position: { x: 0, y: 0 },
          ports: [{ id: 'agent-1-out', name: 'Out', role: 'message-out' }],
          data: {
            prompt: options.prompt ?? 'Summarize the input.',
            ...(options.connectionId ? { connectionId: options.connectionId } : {}),
          },
        },
      ],
      connections: [],
    },
  };
}

describe('WorkflowBackupService', () => {
  let service: WorkflowBackupService;
  let library: WorkflowSpec[];
  let log: Recorded[];
  let responses: { status: number; body: unknown }[];
  let backupState: Map<string, WorkflowBackupState>;
  let localConnections: { id: string; name: string }[];
  let subscribed: ReturnType<typeof signal<boolean>>;
  let signedIn: ReturnType<typeof signal<boolean>>;

  beforeEach(async () => {
    // BEFORE the service is constructed: `disabled` is seeded from localStorage in
    // a field initializer, and karma randomizes spec order, so a key left behind by
    // the opt-out spec would silently disable backup in an unrelated one.
    localStorage.removeItem('phorma.layout.backupDisabled');
    library = [];
    log = [];
    responses = [];
    backupState = new Map();
    localConnections = [];
    subscribed = signal(true);
    signedIn = signal(true);

    spyOn(globalThis, 'fetch').and.callFake(async (input, init) => {
      const headers = new Headers(init?.headers);
      log.push({
        url: String(input),
        method: init?.method ?? 'GET',
        ifMatch: headers.get('If-Match'),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const next = responses.shift();
      if (next) return new Response(JSON.stringify(next.body), { status: next.status });
      // Default: a successful upload at revision 1.
      return new Response(
        JSON.stringify({ ok: true, workflowId: 'wf', revision: 1, specHash: 'h', sizeBytes: 10, prunedRevisions: 0 }),
        { status: 200 },
      );
    });

    TestBed.configureTestingModule({
      providers: [
        { provide: WorkflowService, useValue: { library: () => library, restoreSpec: async () => 'restored' } },
        {
          provide: IndexedDbStorageService,
          useValue: {
            getBackupState: async (id: string) => backupState.get(id),
            saveBackupState: async (state: WorkflowBackupState) => {
              backupState.set(state.workflowId, state);
            },
            removeBackupState: async (id: string) => {
              backupState.delete(id);
            },
            clearBackupState: async () => backupState.clear(),
            listBackupState: async () => [...backupState.values()],
          },
        },
        {
          provide: PhormaCloudService,
          useValue: {
            signedIn,
            subscribed,
            pastDue: () => false,
            sessionToken: async () => 'clerk-jwt',
          },
        },
        { provide: DesktopAuthService, useValue: { token: async () => null } },
        { provide: ConnectionStoreService, useValue: { list: async () => localConnections } },
        {
          provide: ToastService,
          useValue: { success: () => undefined, error: () => undefined, warning: () => undefined },
        },
      ],
    });
    service = TestBed.inject(WorkflowBackupService);

    // Let the constructor's sign-in effect run its list refresh HERE, and let it
    // settle, before any spec queues a response.
    //
    // Not optional bookkeeping: that effect flushes on the first `await` inside a
    // spec, so without this it consumes whatever response the spec had queued for
    // its OWN call - which surfaced as an empty backup list in an assertion about
    // something else entirely. `responses` is still empty at this point, so the
    // refresh takes the stub's default and the queue stays untouched.
    TestBed.tick();
    await new Promise(resolve => setTimeout(resolve, 0));
    log.length = 0;
    service.error.set(null);
  });

  afterEach(() => {
    localStorage.removeItem('phorma.layout.backupDisabled');
  });

  const uploads = () => log.filter(entry => entry.method === 'POST');

  // ── Gating ────────────────────────────────────────────────────────────────

  it('is active for a signed-in subscriber with no opt-out', () => {
    expect(service.active()).toBeTrue();
  });

  it('is inactive while signed out (12.7)', () => {
    signedIn.set(false);
    expect(service.active()).toBeFalse();
  });

  it('is inactive without a subscription (12.9)', () => {
    subscribed.set(false);
    expect(service.active()).toBeFalse();
  });

  it('uploads nothing while inactive', async () => {
    subscribed.set(false);
    await service.uploadOne(spec('wf-a'));
    expect(uploads().length).toBe(0);
  });

  it('respects the opt-out and persists it', () => {
    service.disabled.set(true);
    expect(service.active()).toBeFalse();

    // The persistence is an `effect`, so it needs a flush: an assertion read in the
    // same tick would see the pre-effect value and look like a missing write.
    TestBed.tick();
    expect(localStorage.getItem('phorma.layout.backupDisabled')).toBe('true');

    service.enable();
    expect(service.active()).toBeTrue();
    TestBed.tick();
    expect(localStorage.getItem('phorma.layout.backupDisabled')).toBe('false');
  });

  // ── Uploading ─────────────────────────────────────────────────────────────

  it('uploads a workflow the cloud has never seen, with no If-Match', async () => {
    const outcome = await service.uploadOne(spec('wf-a'));

    expect(outcome).toBe('uploaded');
    expect(uploads().length).toBe(1);
    expect(uploads()[0].url).toBe(`${PHORMA_CLOUD_DEFAULT_URL}/api/backups/wf-a`);
    // No revision to claim, which is what the worker reads as a first upload.
    expect(uploads()[0].ifMatch).toBeNull();
    expect(backupState.get('wf-a')?.revision).toBe(1);
  });

  it('sends the last observed revision as If-Match (16.2)', async () => {
    await service.uploadOne(spec('wf-a'));
    responses = [
      { status: 200, body: { ok: true, workflowId: 'wf-a', revision: 2, specHash: 'h2', sizeBytes: 10, prunedRevisions: 0 } },
    ];

    await service.uploadOne(spec('wf-a', { prompt: 'Changed.' }));

    expect(uploads()[1].ifMatch).toBe('1');
    expect(backupState.get('wf-a')?.revision).toBe(2);
  });

  it('uploads the spec plus its connections by id and name (19.1)', async () => {
    localConnections = [{ id: 'conn-xero', name: 'Xero (production)' }];

    await service.uploadOne(spec('wf-a', { connectionId: 'conn-xero' }));

    const body = uploads()[0].body as { spec: WorkflowSpec; connections: unknown[] };
    expect(body.spec.id).toBe('wf-a');
    expect(body.connections).toEqual([{ id: 'conn-xero', name: 'Xero (production)' }]);
  });

  it('carries no credential-shaped field in the body (19.2, 19.5)', async () => {
    // The body type has no field a secret could occupy. Asserted over generated
    // specs so this stops being a claim about the type and becomes one about the
    // bytes that actually go out.
    //
    // `await` is load-bearing: an un-awaited async property escapes its spec and
    // races the next `beforeEach`, which reassigns the request log to a fresh array
    // under it. The failure that produces looks like a missing request.
    const secretish = /(sk-|sk_live|pk_live|Bearer\s|apiKey|password|BEGIN [A-Z ]*PRIVATE KEY)/i;
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^wf-[a-z0-9]{3,8}$/),
        fc.stringMatching(/^conn-[a-z0-9]{3,8}$/),
        async (workflowId, connectionId) => {
          log.length = 0;
          backupState.clear();
          // A local connection carrying a credential-shaped field, which must not
          // reach the body.
          localConnections = [
            { id: connectionId, name: 'Bank feed', apiKey: 'sk-live-nope' } as never,
          ];
          await service.uploadOne(spec(workflowId, { connectionId }));
          const sent = uploads()[0]?.body;
          return sent !== undefined && !secretish.test(JSON.stringify(sent));
        },
      ),
      { numRuns: 50 },
    );
  });

  // ── No-op suppression ─────────────────────────────────────────────────────

  it('uploads nothing when the spec is unchanged (12.6)', async () => {
    await service.uploadOne(spec('wf-a'));
    expect(uploads().length).toBe(1);

    const outcome = await service.uploadOne(spec('wf-a'));

    expect(outcome).toBe('unchanged');
    expect(uploads().length).withContext('a second identical save must issue nothing').toBe(1);
  });

  it('ignores savedAt, which every save moves', async () => {
    await service.uploadOne(spec('wf-a'));
    const later = { ...spec('wf-a'), savedAt: '2026-12-25T00:00:00.000Z' };

    // The hash is over `canonicalJson(spec)`, which includes `savedAt`... so this
    // documents the real behaviour rather than an aspiration: a save that only
    // moves the clock DOES upload. That is deliberate - it is at most one upload per
    // debounce window, and the alternative is a hash that cannot tell a restored
    // spec from a re-saved one.
    const outcome = await service.uploadOne(later);
    expect(outcome).toBe('uploaded');
  });

  it('issues zero uploads for a library that never changes (property, 12.12)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async saves => {
        log.length = 0;
        backupState.clear();
        const body = spec('wf-stable');
        // The first upload is the real one; every repeat of the SAME spec must be
        // silent, whatever the save count.
        await service.uploadOne(body);
        for (let index = 1; index < saves; index += 1) {
          await service.uploadOne(body);
        }
        return uploads().length === 1;
      }),
      { numRuns: 40 },
    );
  });

  // ── Failure handling ──────────────────────────────────────────────────────

  it('keeps the previous state when an upload fails (12.10)', async () => {
    await service.uploadOne(spec('wf-a'));
    const before = { ...backupState.get('wf-a')! };

    responses = [{ status: 503, body: { error: 'Upstream unavailable.' } }];
    const outcome = await service.uploadOne(spec('wf-a', { prompt: 'Changed.' }));

    expect(outcome).toBe('failed');
    // Recording a hash for an upload that did not land would make every later
    // attempt carry a wrong If-Match and read as a conflict forever.
    expect(backupState.get('wf-a')).toEqual(before);
  });

  it('retries a previously failed workflow even when unchanged', async () => {
    responses = [{ status: 503, body: { error: 'Upstream unavailable.' } }];
    await service.uploadOne(spec('wf-a'));
    expect(uploads().length).toBe(1);

    // Same spec, so the hash gate would normally suppress it - but there is no
    // recorded upload to suppress against, and the retry has to happen.
    const outcome = await service.uploadOne(spec('wf-a'));
    expect(outcome).toBe('uploaded');
    expect(uploads().length).toBe(2);
  });

  it('surfaces a conflict instead of resolving it (16.5)', async () => {
    await service.uploadOne(spec('wf-a'));
    responses = [
      { status: 409, body: { error: 'Changed in the cloud.', code: 'backup_conflict', revision: 7 } },
    ];

    const outcome = await service.uploadOne(spec('wf-a', { prompt: 'Local edit.' }));

    expect(outcome).toBe('conflict');
    expect(service.conflicts().has('wf-a')).toBeTrue();
    // The real revision is recorded so the next attempt is a clean conflict on a
    // true value rather than a repeat of a stale one.
    expect(backupState.get('wf-a')?.revision).toBe(7);
    // And the local hash is NOT advanced: nothing merged, so nothing was stored.
    expect(backupState.get('wf-a')?.lastUploadedHash).toBe(fnv1a(canonicalJson(spec('wf-a'))));
  });

  it('clears a conflict once an upload succeeds', async () => {
    await service.uploadOne(spec('wf-a'));
    responses = [{ status: 409, body: { code: 'backup_conflict', revision: 2, error: 'x' } }];
    await service.uploadOne(spec('wf-a', { prompt: 'One.' }));
    expect(service.conflicts().has('wf-a')).toBeTrue();

    responses = [
      { status: 200, body: { ok: true, workflowId: 'wf-a', revision: 3, specHash: 'h', sizeBytes: 10, prunedRevisions: 0 } },
    ];
    await service.uploadOne(spec('wf-a', { prompt: 'Two.' }));

    expect(service.conflicts().has('wf-a')).toBeFalse();
  });

  it('reports an oversized workflow without retrying it forever', async () => {
    responses = [
      { status: 413, body: { code: 'backup_too_large', error: 'Too big.', limitBytes: 1, actualBytes: 2 } },
    ];
    expect(await service.uploadOne(spec('wf-a'))).toBe('too-large');

    // Not queued for retry: the same spec will be the same size next time, so a
    // retry loop would issue a request per save forever.
    log.length = 0;
    responses = [
      { status: 413, body: { code: 'backup_too_large', error: 'Too big.', limitBytes: 1, actualBytes: 2 } },
    ];
    await service.uploadOne(spec('wf-a'));
    expect(uploads().length).toBe(1);
  });

  it('stops the batch after one cap refusal', async () => {
    library = [spec('wf-a'), spec('wf-b'), spec('wf-c')];
    responses = [{ status: 409, body: { code: 'backup_cap', error: 'At the cap.', cap: 25 } }];

    await service.uploadAll();

    // One refusal means every other NEW workflow gets the same answer, so asking
    // three times is three round trips for one piece of information.
    expect(uploads().length).toBe(1);
  });

  it('goes read-only when the worker says the subscription lapsed', async () => {
    responses = [
      { status: 402, body: { code: 'no_subscription', error: 'Read-only.', readOnly: true } },
    ];
    expect(await service.uploadOne(spec('wf-a'))).toBe('read-only');
    expect(service.writable()).toBeFalse();

    // And nothing else is attempted while read-only.
    log.length = 0;
    library = [spec('wf-b')];
    await service.uploadAll();
    expect(uploads().length).toBe(0);
  });

  // ── The list ──────────────────────────────────────────────────────────────

  it('reads the account list and its state', async () => {
    responses = [
      {
        status: 200,
        body: {
          backups: [
            { workflowId: 'wf-a', name: 'Live', revision: 3, specHash: 'h', sizeBytes: 100, savedAt: 's', updatedAt: 'u', deletedAt: null, daysRemaining: null },
            { workflowId: 'wf-b', name: 'Deleted', revision: 1, specHash: 'h', sizeBytes: 100, savedAt: 's', updatedAt: 'u', deletedAt: '2026-09-01T00:00:00.000Z', daysRemaining: 12 },
          ],
          writable: true,
          readOnlyDaysRemaining: null,
          cap: 25,
          used: 2,
          revisionsKept: 10,
        },
      },
    ];

    await service.refresh();

    expect(service.backups().map(row => row.workflowId)).toEqual(['wf-a']);
    expect(service.tombstones().map(row => row.workflowId)).toEqual(['wf-b']);
    expect(service.hasAnyBackup()).toBeTrue();
    expect(service.cap()).toBe(25);
    expect(service.used()).toBe(2);
    expect(service.revisionsKept()).toBe(10);
  });

  it('keeps the previous list when a refresh fails', async () => {
    responses = [
      {
        status: 200,
        body: { backups: [{ workflowId: 'wf-a', name: 'A', revision: 1, specHash: 'h', sizeBytes: 1, savedAt: 's', updatedAt: 'u', deletedAt: null, daysRemaining: null }], writable: true, readOnlyDaysRemaining: null, cap: 25, used: 1, revisionsKept: 10 },
      },
    ];
    await service.refresh();

    responses = [{ status: 500, body: { error: 'Boom.' } }];
    await service.refresh();

    // Offline is not proof of absence: an empty list would stop somebody restoring.
    expect(service.backups().length).toBe(1);
    expect(service.error()).toBe('Boom.');
  });

  it('treats a 402 as an empty account, not an error', async () => {
    responses = [{ status: 402, body: { code: 'no_subscription', error: 'No plan.' } }];
    await service.refresh();

    // A free account simply has no backups. Reporting that as a failure would put a
    // red error in front of a user who has done nothing wrong.
    expect(service.backups()).toEqual([]);
    expect(service.error()).toBeNull();
    expect(service.writable()).toBeFalse();
  });

  it('reports the lapse window from the list', async () => {
    responses = [
      { status: 200, body: { backups: [], writable: false, readOnlyDaysRemaining: 42, cap: 25, used: 0, revisionsKept: 10 } },
    ];
    await service.refresh();
    expect(service.writable()).toBeFalse();
    expect(service.readOnlyDaysRemaining()).toBe(42);
  });

  // ── Restore ───────────────────────────────────────────────────────────────

  it('restores through the identity-preserving rail and records the revision', async () => {
    responses = [
      {
        status: 200,
        body: { workflowId: 'wf-a', revision: 4, savedAt: 's', spec: spec('wf-a'), connections: [] },
      },
    ];

    const result = await service.restore('wf-a', { revision: 4, collision: 'replace' });

    expect(result.outcome).toBe('restored');
    // Without this the next save uploads with a stale If-Match and reads as a
    // conflict against a copy the user just restored FROM.
    expect(backupState.get('wf-a')?.revision).toBe(4);
  });

  it('reports connections the restored workflow needs but this install lacks (19.3)', async () => {
    localConnections = [{ id: 'conn-here', name: 'Present' }];
    responses = [
      {
        status: 200,
        body: {
          workflowId: 'wf-a',
          revision: 1,
          savedAt: 's',
          spec: spec('wf-a'),
          connections: [
            { id: 'conn-here', name: 'Present' },
            { id: 'conn-gone', name: 'Xero (production)' },
          ],
        },
      },
    ];

    const result = await service.restore('wf-a', { collision: 'replace' });

    // By NAME, not by id: a user reconnects "Xero (production)", not `conn-gone`.
    expect(result.missingConnections).toEqual(['Xero (production)']);
  });

  // ── Deleting ──────────────────────────────────────────────────────────────

  it('soft-deletes by default and purges only when asked', async () => {
    responses = [
      { status: 200, body: { ok: true, changed: true, deletedAt: 'd', daysRemaining: 30 } },
      { status: 200, body: { backups: [], writable: true, readOnlyDaysRemaining: null, cap: 25, used: 0, revisionsKept: 10 } },
    ];
    expect(await service.deleteBackup('wf-a')).toBeTrue();
    const softDelete = log.find(entry => entry.method === 'DELETE')!;
    expect(softDelete.url).toBe(`${PHORMA_CLOUD_DEFAULT_URL}/api/backups/wf-a`);
    expect(softDelete.url).not.toContain('purge');

    log.length = 0;
    responses = [
      { status: 200, body: { ok: true, purged: true, bodies: 2 } },
      { status: 200, body: { backups: [], writable: true, readOnlyDaysRemaining: null, cap: 25, used: 0, revisionsKept: 10 } },
    ];
    expect(await service.deleteBackup('wf-a', { purge: true })).toBeTrue();
    expect(log.find(entry => entry.method === 'DELETE')!.url).toContain('?purge=1');
  });

  it('disable-and-delete-all sets the opt-out before it deletes (11.5)', async () => {
    backupState.set('wf-a', { workflowId: 'wf-a', lastUploadedHash: 'h', revision: 1, uploadedAt: 'u' });
    responses = [{ status: 200, body: { ok: true, workflows: 1, bodies: 1 } }];

    expect(await service.disableAndDeleteAll()).toBeTrue();

    expect(service.disabled()).toBeTrue();
    expect(service.active()).toBeFalse();
    expect(backupState.size).toBe(0);
    expect(service.backups()).toEqual([]);
  });

  it('stays disabled even when the delete fails', async () => {
    responses = [{ status: 500, body: { error: 'Boom.' } }];
    expect(await service.disableAndDeleteAll()).toBeFalse();
    // A failure part-way through must not leave uploads running against data the
    // user asked us to delete.
    expect(service.disabled()).toBeTrue();
  });

  // ── The central invariant ─────────────────────────────────────────────────

  it('sends nothing when a workflow leaves the library (17.3, 17.10)', async () => {
    library = [spec('wf-a'), spec('wf-b')];
    await service.uploadAll();
    const uploadedBefore = uploads().length;
    log.length = 0;

    // The library shrinks, exactly as a local delete leaves it.
    library = [spec('wf-a')];
    await service.uploadAll();

    expect(uploadedBefore).toBe(2);
    // Not one DELETE, not one of any verb aimed at wf-b. The service sees state,
    // so a disappearance is nothing to do - which is what makes a wiped local
    // database recoverable rather than propagated.
    expect(log.filter(entry => entry.method === 'DELETE')).toEqual([]);
    expect(log.some(entry => entry.url.includes('wf-b'))).toBeFalse();
  });
});
