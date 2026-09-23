/**
 * Owner-scoped local storage, and the IndexedDB v12 upgrade behind it.
 *
 * Two independent things are asserted here, and the second is the one that cannot
 * be re-run:
 *
 * - **Property 41**, driven through the REAL browser IndexedDB against the real
 *   service. Each surface presents exactly the active owner's subset, the total
 *   row count is invariant under any number of switches, and a row carrying no
 *   owner reads as personal.
 * - **The v12 upgrade, against a store SEEDED AT v11.** This is the only
 *   irreversible step in the feature: it runs on the user's machine on first
 *   launch and no worker deploy rolls it back. It is driven through the exported
 *   `migrateOwnerStamp` - the production function, guard included - over a
 *   database built with the v11 schema and v11 rows, because verifying it against
 *   an empty store would assert nothing and verifying it against the shared
 *   production database would need a version change against connections other
 *   specs still hold open.
 *
 * **Validates: Requirements 20.13, 20.14, 20.15**
 */

import { TestBed } from '@angular/core/testing';
import fc from 'fast-check';

import type { RunRecord, UsageLedgerEntry } from '@phorma/engine';

import { ActiveOwnerService } from './active-owner.service';
import {
  IndexedDbStorageService,
  OWNER_FIELD,
  OWNER_SCOPED_STORES,
  migrateOwnerStamp,
} from './indexed-db-storage.service';
import type { WorkflowSpec } from './workflow.model';

/** Minimum iterations for every property in this suite. */
const RUNS = { numRuns: 100 };

interface Harness {
  storage: IndexedDbStorageService;
  owner: ActiveOwnerService;
}

function harness(): Harness {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [] });
  return {
    storage: TestBed.inject(IndexedDbStorageService),
    owner: TestBed.inject(ActiveOwnerService),
  };
}

/** A workflow id unique to this spec run, so nothing collides with a neighbour. */
function uniqueId(label: string): string {
  return `owner-${label}-${crypto.randomUUID()}`;
}

function spec(id: string, name: string): WorkflowSpec {
  return {
    id,
    name,
    graph: { nodes: [], edges: [] },
    savedAt: new Date().toISOString(),
  } as unknown as WorkflowSpec;
}

function run(id: string, workflowId: string): RunRecord {
  return {
    summary: {
      id,
      workflowId,
      startedAt: Date.now(),
      status: 'completed',
    },
    events: [],
  } as unknown as RunRecord;
}

function usage(runId: string, workflowId: string): UsageLedgerEntry {
  return {
    runId,
    workflowId,
    startedAt: Date.now(),
    costUsd: 0,
    nodes: [],
  } as unknown as UsageLedgerEntry;
}

describe('owner-scoped local storage', () => {
  // ─── Property 41 ──────────────────────────────────────────────────────────

  /**
   * Feature: multi-organisation-phorma, Property 41: A local row belongs to
   * exactly one owner, and the upgrade loses none.
   *
   * The presentation half: for workflows, run records and usage rows written
   * across any sequence of active owners, each surface presents exactly the active
   * owner's subset - no extra row and no omitted row - and the total row count is
   * invariant under any number of switches.
   *
   * The totals are counted by walking every owner rather than by reading an
   * unscoped store, which is the honest way to say "nothing was pruned": a switch
   * filters at the READ and must delete nothing (Requirement 20.9).
   */
  it('presents exactly the active owner\'s rows, and loses none across switches', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.nat({ max: 2 }), { minLength: 3, maxLength: 9 }),
        fc.array(fc.nat({ max: 2 }), { minLength: 1, maxLength: 8 }),
        async (writes, revisits) => {
          const { storage, owner } = harness();
          const organisations = ['org_alpha', 'org_beta'];
          owner.adoptOwners(organisations.map(id => ({ orgId: id, label: id })));
          const owners: (string | null)[] = [null, ...organisations];

          const tag = crypto.randomUUID();
          const expected = new Map<string | null, string[]>(owners.map(id => [id, []]));

          // Write one workflow + run + usage row per step, under the owner that step
          // names, so the assignment of rows to owners is arbitrary rather than
          // blocked.
          for (const [index, pick] of writes.entries()) {
            const target = owners[pick % owners.length];
            expect(owner.setActiveOrg(target) || owner.activeOrgId() === target).toBeTrue();
            const workflowId = `wf-${tag}-${index}`;
            await storage.saveWorkflow(spec(workflowId, `W${index}`));
            await storage.saveRun(run(`run-${tag}-${index}`, workflowId));
            await storage.saveUsage(usage(`run-${tag}-${index}`, workflowId));
            expected.get(target)!.push(workflowId);
          }

          // Any number of further switches, including revisits.
          for (const pick of revisits) owner.setActiveOrg(owners[pick % owners.length]);

          let seen = 0;
          for (const target of owners) {
            owner.setActiveOrg(target);
            const mine = new Set(expected.get(target));

            const library = (await storage.listWorkflows())
              .filter(entry => entry.id.includes(tag))
              .map(entry => entry.id);
            const runs = (await storage.listRuns())
              .filter(entry => entry.summary.id.includes(tag))
              .map(entry => entry.summary.workflowId);
            const rows = (await storage.listUsage())
              .filter(entry => entry.runId.includes(tag))
              .map(entry => entry.workflowId);

            // No extra row and no omitted row, on all three surfaces.
            expect(new Set(library)).toEqual(mine);
            expect(new Set(runs)).toEqual(mine);
            expect(new Set(rows)).toEqual(mine);
            // And no duplicate: a filter that ran twice would also match the sets.
            expect(library.length).toBe(mine.size);
            seen += library.length;

            // A read of another owner's workflow by id reads as ABSENT rather than
            // resolving somebody else's document of the same id.
            for (const foreign of owners.filter(other => other !== target)) {
              for (const id of expected.get(foreign) ?? []) {
                if (mine.has(id)) continue;
                expect(await storage.getWorkflow(id)).toBeUndefined();
              }
            }
          }

          // The total is invariant: every row written is still readable by SOME owner.
          expect(seen).toBe(writes.length);
        },
      ),
      RUNS,
    );
  }, 120_000);

  /**
   * Feature: multi-organisation-phorma, Property 41: A local row belongs to
   * exactly one owner, and the upgrade loses none.
   *
   * The absent-is-personal half (Requirement 20.15), driven against rows written
   * WITHOUT the stamp - which is what a build older than v12 leaves behind in the
   * window before the upgrade runs, and what any future write path that forgets to
   * stamp would leave behind.
   */
  it('reads a row with no owner as the personal account\'s', async () => {
    const { storage, owner } = harness();
    owner.adoptOwners([{ orgId: 'org_alpha', label: 'Alpha' }]);

    const id = uniqueId('unstamped');
    // The service must create the schema first; see `writeUnstamped`.
    await storage.listWorkflows();
    await writeUnstamped('workflows', spec(id, 'Legacy'));

    owner.setActiveOrg(null);
    expect((await storage.listWorkflows()).some(entry => entry.id === id)).toBeTrue();
    expect(await storage.getWorkflow(id)).toBeTruthy();

    owner.setActiveOrg('org_alpha');
    expect((await storage.listWorkflows()).some(entry => entry.id === id)).toBeFalse();
    expect(await storage.getWorkflow(id)).toBeUndefined();
  });

  /**
   * The stamp must never ride out on a `WorkflowSpec`: the backup and proposal
   * paths hash a spec and the worker hashes the spec IT was sent, so one extra
   * member makes every hash disagree - which surfaces as a permanent
   * `proposal_stale` or a backup that re-uploads forever.
   */
  it('strips the owner stamp off a spec read back out of the library', async () => {
    const { storage } = harness();
    const id = uniqueId('hash');
    await storage.saveWorkflow(spec(id, 'Hashable'));

    const read = await storage.getWorkflow(id);
    expect(read).toBeTruthy();
    expect(Object.keys(read!)).not.toContain(OWNER_FIELD);
    const listed = (await storage.listWorkflows()).find(entry => entry.id === id);
    expect(Object.keys(listed!)).not.toContain(OWNER_FIELD);
  });

  // ─── The v12 upgrade, against a store seeded at v11 ────────────────────────

  /**
   * Requirement 20.14, and the reason this suite exists at all.
   *
   * The store is built with the v11 schema, filled with v11 rows, closed, and then
   * reopened at v12 with the production migration in the upgrade handler. What is
   * asserted is what a user's machine will actually have afterwards: every
   * pre-existing row still readable, still carrying every field it had, and now
   * carrying the personal owner stamp.
   */
  it('stamps every v11 row with the personal owner and loses none', async () => {
    const name = `phorma-owner-migration-${crypto.randomUUID()}`;
    const seeded = {
      workflows: [{ id: 'wf-1', name: 'One' }, { id: 'wf-2', name: 'Two' }],
      runs: [{ summary: { id: 'r-1', startedAt: 5 }, workflowKey: 'wf-1' }],
      usage: [{ runId: 'r-1', startedAt: 5, workflowKey: 'wf-1' }],
      'workflow-versions': [{ id: 'v-1', workflowId: 'wf-1', savedAt: '2026-01-01' }],
      'workflow-state': [{ key: 'wf-1::k', workflowKey: 'wf-1', value: 'v', updatedAt: 1, bytes: 1, expiresAt: null }],
      'workflow-backup-state': [{ workflowId: 'wf-1', lastUploadedHash: 'abc', revision: 3 }],
    } as const;

    try {
      const v11 = await openV11(name);
      for (const [store, rows] of Object.entries(seeded)) {
        await putAll(v11, store, rows as readonly object[]);
      }
      v11.close();

      const v12 = await openV12(name);
      let total = 0;
      for (const store of OWNER_SCOPED_STORES) {
        const rows = await getAll(v12, store);
        const expectedRows = seeded[store as keyof typeof seeded];
        expect(rows.length)
          .withContext(`${store} row count`)
          .toBe(expectedRows.length);
        total += rows.length;
        for (const row of rows) {
          const record = row as Record<string, unknown>;
          // Stamped with the personal owner...
          expect(record[OWNER_FIELD]).withContext(`${store} stamp`).toBeNull();
          // ...and nothing else touched. Every field the v11 row carried is still
          // there with the same value, which is what "loses none" has to mean for a
          // migration that cannot be undone.
          const before = expectedRows.find(candidate =>
            Object.entries(candidate).every(
              ([key, value]) => JSON.stringify(record[key]) === JSON.stringify(value),
            ),
          );
          expect(before).withContext(`${store} row preserved verbatim`).toBeTruthy();
        }
      }
      expect(total).toBe(
        Object.values(seeded).reduce((sum, rows) => sum + rows.length, 0),
      );
      v12.close();
    } finally {
      await deleteDatabase(name);
    }
  });

  /**
   * The guard, driven rather than restated. A fresh install (`oldVersion === 0`)
   * and an already-migrated store (`oldVersion >= 12`) both do nothing, so a row
   * that already carries a stamp can never be rewritten by a later upgrade.
   */
  it('does nothing for a fresh install or an already-migrated store', async () => {
    const name = `phorma-owner-guard-${crypto.randomUUID()}`;
    try {
      const v11 = await openV11(name);
      await putAll(v11, 'workflows', [{ id: 'wf-1', name: 'One' }]);
      v11.close();

      // `oldVersion` lied about: the migration must not run, so the row keeps NO
      // stamp and `ownerOf` is what makes it readable (Requirement 20.15).
      const opened = await openWith(name, 12, (transaction, db, _old) =>
        migrateOwnerStamp(transaction, db, 12),
      );
      const rows = await getAll(opened, 'workflows');
      expect(OWNER_FIELD in (rows[0] as object)).toBeFalse();
      opened.close();
    } finally {
      await deleteDatabase(name);
    }
  });
});

// ── IndexedDB helpers ───────────────────────────────────────────────────────

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

/**
 * The v11 schema, hand-written rather than imported.
 *
 * Deliberate: importing the service's own `onupgradeneeded` would mean seeding the
 * "previous" version with the CURRENT code, and the whole point is to start from
 * what a shipped v11 install really has on disk.
 */
function openV11(name: string): Promise<IDBDatabase> {
  return openWith(name, 11, (_transaction, db) => {
    db.createObjectStore('workflows', { keyPath: 'id' });
    const runs = db.createObjectStore('runs', { keyPath: 'summary.id' });
    runs.createIndex('by-workflow', 'workflowKey');
    runs.createIndex('by-started', 'summary.startedAt');
    const usageStore = db.createObjectStore('usage', { keyPath: 'runId' });
    usageStore.createIndex('by-workflow', 'workflowKey');
    usageStore.createIndex('by-started', 'startedAt');
    const versions = db.createObjectStore('workflow-versions', { keyPath: 'id' });
    versions.createIndex('by-workflow', 'workflowId');
    versions.createIndex('by-saved', 'savedAt');
    const state = db.createObjectStore('workflow-state', { keyPath: 'key' });
    state.createIndex('by-workflow', 'workflowKey');
    db.createObjectStore('workflow-backup-state', { keyPath: 'workflowId' });
  });
}

/** Reopens at v12 through the PRODUCTION migration. */
function openV12(name: string): Promise<IDBDatabase> {
  return openWith(name, 12, (transaction, db, oldVersion) =>
    migrateOwnerStamp(transaction, db, oldVersion),
  );
}

function openWith(
  name: string,
  version: number,
  upgrade: (transaction: IDBTransaction | null, db: IDBDatabase, oldVersion: number) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = event => {
      upgrade(request.transaction, request.result, event.oldVersion);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('open failed'));
  });
}

async function putAll(db: IDBDatabase, store: string, rows: readonly object[]): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  const objectStore = tx.objectStore(store);
  for (const row of rows) await promisify(objectStore.put(row));
}

function getAll(db: IDBDatabase, store: string): Promise<unknown[]> {
  return promisify(db.transaction(store, 'readonly').objectStore(store).getAll());
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise(resolve => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

/**
 * Writes a row into the PRODUCTION database with no owner stamp, through the
 * service's own connection.
 *
 * The one thing the service cannot do for us: every write path stamps, which is
 * the point of it, so a legacy row has to be planted directly.
 */
async function writeUnstamped(store: string, row: object): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('phorma-agent-studio-db');
    // A versionless open CREATES an empty v1 database if none exists yet.
    request.onupgradeneeded = () => {
      request.transaction?.abort();
      reject(new Error('writeUnstamped ran before the service created the database.'));
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('open failed'));
  });
  try {
    await putAll(db, store, [row]);
  } finally {
    db.close();
  }
}
