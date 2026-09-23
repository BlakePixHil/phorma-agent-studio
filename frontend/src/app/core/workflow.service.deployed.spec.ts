import { TestBed } from '@angular/core/testing';
import fc from 'fast-check';

import { IndexedDbStorageService } from './indexed-db-storage.service';
import { buildNodeFromCatalog, findCatalogEntry } from './node-catalog';
import { TauriService } from './tauri.service';
import { WorkflowService } from './workflow.service';
import { WORKFLOW_SPEC_VERSION, type WorkflowSpec } from './workflow.model';

/**
 * `WorkflowService.openDeployedSpec` - the Cloud_Library open
 * (multi-organisation Requirements 9.2, 9.3, 9.4; Property 18).
 *
 * Two claims, and they pull in opposite directions, which is why both are pinned
 * here:
 *
 * - RESTORE-shaped in IDENTITY. The document carries the DEPLOYED spec's own id,
 *   never a fresh one, because an editor's proposal is keyed on that workflow id
 *   and a builder's publish pushes back to that instance. `importSpec` mints a new
 *   id on collision (a file import is a copy); this must not, even when the local
 *   library already holds the id.
 * - SNAPSHOT-shaped in PERSISTENCE. Nothing is written: no IndexedDB write of any
 *   kind, and no new value in `localStorage`. The stores are workflow-keyed, so
 *   "do not write" is the whole mechanism.
 *
 * The IndexedDB half is asserted by spying on EVERY write method the storage
 * service exposes, discovered from its prototype rather than listed here - a store
 * added later is covered without anybody remembering to extend a list.
 */
describe('WorkflowService.openDeployedSpec (Property 18)', () => {
  /** Write methods on the storage service, by name shape. */
  const WRITE_PREFIXES = ['save', 'remove', 'delete', 'clear', 'put'];

  /** A real catalog entry, so the generated graph is a graph the studio could hold. */
  const transformEntry = findCatalogEntry('data-transform')!;

  let workflow: WorkflowService;
  let storage: IndexedDbStorageService;
  let writeSpies: { name: string; spy: jasmine.Spy }[];
  /** Every `phorma.*` key/value pair at the start of the current assertion. */
  let localSnapshot: Map<string, string>;

  function spec(overrides: Partial<WorkflowSpec> = {}): WorkflowSpec {
    return {
      id: 'wf-deployed-1',
      version: WORKFLOW_SPEC_VERSION,
      name: 'Deployed workflow',
      description: 'Lives in the organisation, not here.',
      graph: { nodes: [], connections: [] },
      savedAt: new Date('2026-09-01T10:00:00.000Z').toISOString(),
      ...overrides,
    };
  }

  function snapshotLocalStorage(): Map<string, string> {
    const entries = new Map<string, string>();
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key === null || !key.startsWith('phorma.')) continue;
      entries.set(key, localStorage.getItem(key) ?? '');
    }
    return entries;
  }

  /**
   * Every `phorma.*` entry still holds the value it held before, and no new one
   * appeared. An IDENTICAL rewrite by the open-tab session effect is fine - what
   * must not happen is a spec, a name or a deployed workflow id appearing here.
   */
  function expectNoLocalStorageWrite(before: Map<string, string>): void {
    const after = snapshotLocalStorage();
    for (const [key, value] of after) {
      expect(before.has(key))
        .withContext(`localStorage gained "${key}" = ${value}`)
        .toBeTrue();
      expect(value)
        .withContext(`localStorage "${key}" changed`)
        .toBe(before.get(key) ?? '');
    }
  }

  function expectNoIndexedDbWrite(): void {
    for (const { name, spy } of writeSpies) {
      expect(spy)
        .withContext(`IndexedDbStorageService.${name} was called`)
        .not.toHaveBeenCalled();
    }
  }

  beforeEach(async () => {
    localStorage.removeItem('phorma.layout.openWorkflows');
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: false } }],
    });
    storage = TestBed.inject(IndexedDbStorageService);

    // Armed BEFORE the service exists, so even a write during startup is caught.
    const prototype = Object.getPrototypeOf(storage) as Record<string, unknown>;
    writeSpies = Object.getOwnPropertyNames(prototype)
      .filter(name => WRITE_PREFIXES.some(prefix => name.startsWith(prefix)))
      .filter(name => typeof (storage as unknown as Record<string, unknown>)[name] === 'function')
      .map(name => ({
        name,
        spy: spyOn(storage as unknown as Record<string, jasmine.Func>, name).and.resolveTo(
          undefined,
        ),
      }));
    expect(writeSpies.length)
      .withContext('no write method was found on the storage service, so the spies prove nothing')
      .toBeGreaterThan(5);

    workflow = TestBed.inject(WorkflowService);
    // The library read is an IndexedDB open plus a cursor, so it settles over
    // SEVERAL turns, not one - and `initialize()` calls `restoreSession()` in the
    // same synchronous tail as `libraryLoadedState.set(true)`, so that signal is
    // the barrier for "the startup tab exists". Waiting a single `setTimeout(0)`
    // here left `documents()` empty and let the startup `newWorkflow()` land in
    // the middle of whatever spec was running.
    for (let turn = 0; turn < 50 && !workflow.libraryLoaded(); turn += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(workflow.libraryLoaded()).withContext('the library never loaded').toBeTrue();
    expect(workflow.documents().length)
      .withContext('startup did not open the untitled tab')
      .toBe(1);
    TestBed.tick();
    writeSpies.forEach(({ spy }) => spy.calls.reset());
    localSnapshot = snapshotLocalStorage();
  });

  afterEach(() => {
    localStorage.removeItem('phorma.layout.openWorkflows');
  });

  it('opens a read-only tab carrying the deployed spec\'s own id and writes nothing', () => {
    const deployed = spec();

    workflow.openDeployedSpec(deployed);
    TestBed.tick();

    const doc = workflow.activeDoc();
    expect(doc).not.toBeNull();
    expect(doc!.workflowId).toBe(deployed.id);
    expect(doc!.readOnly).toBeTrue();
    expect(doc!.dirty).toBeFalse();
    expect(doc!.name).toBe(deployed.name);
    expect(workflow.graph()).toEqual(deployed.graph);
    // Not linked into the library: a Cloud_Library session has none.
    expect(workflow.library().some(item => item.id === deployed.id)).toBeFalse();
    expectNoIndexedDbWrite();
    expectNoLocalStorageWrite(localSnapshot);
  });

  it('refuses every mutation on the opened document, through the existing read-only rail', () => {
    workflow.openDeployedSpec(spec({ graph: { nodes: [], connections: [] } }));
    const before = workflow.activeDoc()!;

    workflow.renameActive('Renamed');
    workflow.describeActive('Described');
    workflow.updateSettings({ timeoutMinutes: 7 });
    workflow.addNodeFromCatalog('agent-blank', { x: 0, y: 0 });

    const after = workflow.activeDoc()!;
    expect(after.name).toBe(before.name);
    expect(after.description).toBe(before.description);
    expect(after.settings).toEqual(before.settings);
    expect(after.graph.nodes.length).toBe(0);
    expect(after.dirty).toBeFalse();
    expectNoIndexedDbWrite();
    expectNoLocalStorageWrite(localSnapshot);
  });

  /**
   * Opening the same deployed workflow twice re-activates the one tab. The
   * property below has to tolerate this, so it is pinned here deterministically
   * rather than left to a duplicate id turning up in a generator.
   */
  it('re-activates the existing tab when the same deployed workflow is opened again', () => {
    const deployed = spec({
      graph: {
        nodes: [buildNodeFromCatalog(transformEntry, { x: 0, y: 0 })],
        connections: [],
      },
    });

    workflow.openDeployedSpec(deployed);
    const first = workflow.activeDoc()!;
    // A second open of the SAME id, carrying a different graph and name.
    workflow.openDeployedSpec(spec({ id: deployed.id, name: 'Renamed upstream' }));
    const second = workflow.activeDoc()!;

    expect(second.docId).withContext('a second tab was opened').toBe(first.docId);
    expect(workflow.documents().filter(doc => doc.workflowId === deployed.id).length).toBe(1);
    // The tab is the one already open, graph and name included.
    expect(second.graph.nodes.length).toBe(1);
    expect(second.name).toBe(deployed.name);
    expectNoIndexedDbWrite();
    expectNoLocalStorageWrite(localSnapshot);
  });

  /**
   * CLOSING, and why these four are here rather than in a general tab suite.
   *
   * A read-only document is IMMUTABLE, not PERMANENT. The tab strip renders a
   * close button on every tab, read-only ones included, so all four of these are
   * ordinary user actions - and every one of them was broken by a `readOnly`
   * filter copied into `closeDocument` from the open-tab session effect in the
   * constructor. That effect's filter is correct and stays: it decides what gets
   * PERSISTED. `closeDocument`'s job is the tab bar, so it reads the full list.
   *
   * They live in this file because the second claim of `openDeployedSpec` has to
   * survive closing too: the harness here proves that nothing about the deployed
   * document reaches IndexedDB or `localStorage`, on the way out as well as in.
   */
  it('closing an ordinary tab leaves a read-only tab open', () => {
    const ordinary = workflow.documents()[0];
    expect(ordinary.readOnly).withContext('the startup tab should be editable').toBeFalsy();

    workflow.openDeployedSpec(spec());
    const deployedDoc = workflow.activeDoc()!;
    workflow.newWorkflow();
    const second = workflow.activeDoc()!;
    TestBed.tick();

    workflow.closeDocument(ordinary.docId);
    TestBed.tick();

    const docs = workflow.documents();
    expect(docs.map(doc => doc.docId)).toEqual([deployedDoc.docId, second.docId]);
    const survivor = docs.find(doc => doc.docId === deployedDoc.docId)!;
    expect(survivor.readOnly).toBeTrue();
    expect(survivor.workflowId).toBe(deployedDoc.workflowId);
    // The closed tab was not the active one, so the active tab does not move.
    expect(workflow.activeDocId()).toBe(second.docId);
    expectNoIndexedDbWrite();
    expectNoLocalStorageWrite(localSnapshot);
  });

  it('closes a read-only tab that is not the active one', () => {
    const ordinary = workflow.documents()[0];
    workflow.openDeployedSpec(spec());
    const deployedDoc = workflow.activeDoc()!;
    workflow.newWorkflow();
    const second = workflow.activeDoc()!;
    TestBed.tick();

    workflow.closeDocument(deployedDoc.docId);
    TestBed.tick();

    const docs = workflow.documents();
    expect(docs.map(doc => doc.docId)).toEqual([ordinary.docId, second.docId]);
    expect(docs.some(doc => doc.readOnly === true))
      .withContext('the read-only tab is still open')
      .toBeFalse();
    expect(workflow.activeDocId()).toBe(second.docId);
    expectNoIndexedDbWrite();
    expectNoLocalStorageWrite(localSnapshot);
  });

  it('closes the ACTIVE read-only tab and activates its left neighbour', () => {
    const ordinary = workflow.documents()[0];
    workflow.openDeployedSpec(spec());
    const deployedDoc = workflow.activeDoc()!;
    workflow.newWorkflow();
    const second = workflow.activeDoc()!;
    // Back to the read-only tab: closing the ACTIVE one is the reselection case.
    workflow.activateDocument(deployedDoc.docId);
    TestBed.tick();
    expect(workflow.activeDocId()).toBe(deployedDoc.docId);

    workflow.closeDocument(deployedDoc.docId);
    TestBed.tick();

    const docs = workflow.documents();
    expect(docs.map(doc => doc.docId)).toEqual([ordinary.docId, second.docId]);
    // The tab to its left, and - the part that matters - a tab that is still open.
    expect(workflow.activeDocId()).toBe(ordinary.docId);
    expect(docs.some(doc => doc.docId === workflow.activeDocId()))
      .withContext('the active document id points at a closed document')
      .toBeTrue();
    expect(workflow.activeDoc()).not.toBeNull();
    expectNoIndexedDbWrite();
    expectNoLocalStorageWrite(localSnapshot);
  });

  it('closes each tab of a mixed strip, ending on a fresh editable document', () => {
    const first = workflow.documents()[0];
    workflow.newWorkflow();
    const secondOrdinary = workflow.activeDoc()!;
    workflow.openDeployedSpec(spec({ id: 'wf-deployed-mixed' }));
    const deployedDoc = workflow.activeDoc()!;
    // A second read-only source: a version snapshot, which carries no workflow id.
    workflow.openVersionSnapshot(spec({ id: 'wf-versioned', name: 'Versioned' }));
    const snapshotDoc = workflow.activeDoc()!;
    expect(snapshotDoc.readOnly).toBeTrue();
    workflow.newWorkflow();
    const thirdOrdinary = workflow.activeDoc()!;
    TestBed.tick();
    expect(workflow.documents().length).toBe(5);

    // An ordinary close in the middle: both read-only tabs stay.
    workflow.closeDocument(secondOrdinary.docId);
    TestBed.tick();
    expect(workflow.documents().map(doc => doc.docId)).toEqual([
      first.docId,
      deployedDoc.docId,
      snapshotDoc.docId,
      thirdOrdinary.docId,
    ]);

    // Then each read-only tab, one at a time.
    workflow.closeDocument(deployedDoc.docId);
    TestBed.tick();
    expect(workflow.documents().map(doc => doc.docId)).toEqual([
      first.docId,
      snapshotDoc.docId,
      thirdOrdinary.docId,
    ]);

    workflow.closeDocument(snapshotDoc.docId);
    TestBed.tick();
    expect(workflow.documents().map(doc => doc.docId)).toEqual([
      first.docId,
      thirdOrdinary.docId,
    ]);

    // And the last two, read-only included, still leave the canvas a document.
    workflow.closeDocument(first.docId);
    workflow.closeDocument(thirdOrdinary.docId);
    TestBed.tick();
    const remaining = workflow.documents();
    expect(remaining.length).toBe(1);
    expect(remaining[0].readOnly).toBeFalsy();
    expect(remaining[0].workflowId).toBeNull();
    expect(workflow.activeDocId()).toBe(remaining[0].docId);
    expectNoIndexedDbWrite();
    expectNoLocalStorageWrite(localSnapshot);
  });

  /**
   * Property 18: for ANY deployed spec, the opened document carries that exact id,
   * is read-only, and no write reaches IndexedDB or `localStorage`.
   *
   * The harness is hoisted out of the property on purpose: jasmine allows `spyOn`
   * for a given property only once per spec, and `TestBed.configureTestingModule`
   * throws once the module is instantiated - so a property that rebuilt either per
   * iteration would report a counterexample that describes the harness.
   *
   * Which means documents ACCUMULATE across iterations, in one session, exactly as
   * they do for a member who opens several deployed workflows. `openDeployedSpec`
   * re-activates the tab it already holds for a workflow id instead of opening a
   * second one, so a REPEATED id is a different claim from a fresh one - and
   * fast-check's string generator draws from a small biased pool (`call`, `key`,
   * `constructor`, `bind`), which makes a repeat inside 60 iterations routine
   * rather than exotic. Asserting the fresh claim on every iteration is what made
   * this property fail at a random late iteration on roughly one full karma run in
   * five, with a shrunk counterexample that described the sequence and not the
   * input. Both branches are now keyed on what this session already opened.
   *
   * **Validates: Requirements 9.2, 9.3, 9.4**
   */
  it('preserves the id and persists nothing, for any deployed spec', async () => {
    /** Deployed id -> the tab this session opened for it, and its node count. */
    const openedById = new Map<string, { docId: string; nodeCount: number }>();

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          id: fc.string({ minLength: 1, maxLength: 40, unit: 'grapheme' }),
          name: fc.string({ maxLength: 60, unit: 'grapheme' }),
          description: fc.option(fc.string({ maxLength: 80, unit: 'grapheme' }), {
            nil: undefined,
          }),
          nodeCount: fc.integer({ min: 0, max: 3 }),
        }),
        async draft => {
          writeSpies.forEach(({ spy }) => spy.calls.reset());
          const before = snapshotLocalStorage();
          const deployed = spec({
            id: draft.id,
            name: draft.name,
            description: draft.description,
            graph: {
              nodes: Array.from({ length: draft.nodeCount }, (_, index) =>
                buildNodeFromCatalog(transformEntry, { x: index * 40, y: 0 }),
              ),
              connections: [],
            },
          });

          workflow.openDeployedSpec(deployed);
          TestBed.tick();

          const doc = workflow.activeDoc();
          if (doc === null) throw new Error('no document was opened');
          if (doc.workflowId !== deployed.id) {
            throw new Error(`id was rewritten: ${String(doc.workflowId)} !== ${deployed.id}`);
          }
          if (doc.readOnly !== true) throw new Error('the document is not read-only');
          const already = openedById.get(deployed.id);
          if (already === undefined) {
            if (doc.graph.nodes.length !== draft.nodeCount) {
              throw new Error('the graph was not carried over');
            }
            openedById.set(deployed.id, { docId: doc.docId, nodeCount: draft.nodeCount });
          } else {
            // Already open in this session: the SAME tab, carrying what it was
            // opened with. A second tab for one workflow id is the failure.
            if (doc.docId !== already.docId) {
              throw new Error(`a second tab was opened for ${deployed.id}`);
            }
            if (doc.graph.nodes.length !== already.nodeCount) {
              throw new Error('the re-activated tab\'s graph changed');
            }
          }
          for (const { name, spy } of writeSpies) {
            if (spy.calls.any()) throw new Error(`a write reached IndexedDB: ${name}`);
          }
          const after = snapshotLocalStorage();
          for (const [key, value] of after) {
            if (before.get(key) !== value) {
              throw new Error(`localStorage "${key}" changed to ${value}`);
            }
          }
          return true;
        },
      ),
      { numRuns: 60 },
    );
  });
});

/**
 * The collision case, in its own suite because it needs a REAL IndexedDB write.
 *
 * `spyOn` over an inherited method installs on the prototype, so the write spies
 * in the suite above would swallow the `saveWorkflow` that sets this case up - and
 * the test would then pass for the wrong reason, against an empty library.
 *
 * The claim: the local library already holding the deployed id changes nothing.
 * `importSpec` mints a fresh id in exactly this situation, because a file import is
 * a copy; an open is the SAME workflow arriving from the cloud, and an
 * import-shaped open would key an editor's proposal on a workflow id the cloud does
 * not have (Requirement 9.3).
 */
describe('WorkflowService.openDeployedSpec with a colliding local copy', () => {
  // Karma runs one browser for the whole suite in a random order, so a persisted
  // key this suite writes has to be cleaned up on both sides of it.
  beforeEach(() => localStorage.removeItem('phorma.layout.openWorkflows'));
  afterEach(() => localStorage.removeItem('phorma.layout.openWorkflows'));

  it('keeps the deployed id and leaves the local copy untouched', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: false } }],
    });
    const storage = TestBed.inject(IndexedDbStorageService);
    const collision: WorkflowSpec = {
      version: WORKFLOW_SPEC_VERSION,
      id: 'wf-collision',
      name: 'Local copy',
      graph: { nodes: [], connections: [] },
      savedAt: new Date('2026-08-01T00:00:00.000Z').toISOString(),
    };
    // Written BEFORE the service is injected: the library is read once, at
    // construction.
    await storage.saveWorkflow(collision);
    try {
      const service = TestBed.inject(WorkflowService);
      // The library read is an IndexedDB open plus a cursor, so it settles over
      // several turns - waiting one is how this test read an empty library and
      // "passed" against nothing.
      for (let turn = 0; turn < 50 && !service.libraryLoaded(); turn += 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(service.libraryLoaded()).withContext('the library never loaded').toBeTrue();
      expect(service.library().some(item => item.id === collision.id))
        .withContext('the collision was not actually set up')
        .toBeTrue();

      service.openDeployedSpec({ ...collision, name: 'Deployed copy' });

      const doc = service.activeDoc();
      expect(doc!.workflowId).toBe(collision.id);
      expect(doc!.name).toBe('Deployed copy');
      expect(doc!.readOnly).toBeTrue();
      // An open is not a restore: the local copy keeps its own name.
      expect(service.library().find(item => item.id === collision.id)!.name).toBe('Local copy');
    } finally {
      await storage.removeWorkflow(collision.id);
    }
  });
});
