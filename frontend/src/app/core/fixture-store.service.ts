import { Injectable, inject } from '@angular/core';

import { FIXTURE_MAX_BYTES, type FixtureStore } from '@phorma/engine';

import { IndexedDbStorageService } from './indexed-db-storage.service';

/**
 * The desktop host's {@link FixtureStore} (design §11, Requirements 16.10, 18.3).
 *
 * Fixtures share the durable `workflow-state` object store with the state
 * primitives, under the engine's reserved `fx:` namespace and behind the same
 * `workflowId::` scope the engine already applies through `workflowFixtureKey`.
 * Three consequences, all of them deliberate:
 *
 * 1. **Fixtures never travel with a workflow.** They are not part of
 *    `WorkflowSpec`, so an export, a version snapshot and a push payload carry
 *    none of them — a recorded response is a local development artefact, not
 *    workflow content.
 * 2. **Fixtures are not run history.** They live outside the `runs` store, so
 *    run-history retention (`keepRuns`, `maxAgeDays`) neither prunes a fixture
 *    nor is made larger by one. A recorded fixture expires on the `fx:`
 *    namespace TTL instead, and is prunable under the state store's own
 *    per-workflow bounds.
 * 3. **A fixture may be far larger than a state value.** A recorded HTTP page or
 *    result set routinely exceeds the 32 KB state cap, so writes go through
 *    `writeState` with {@link FIXTURE_MAX_BYTES} in place of that cap. The
 *    engine already refuses to serialise anything past that bound and reports it
 *    as a warning rather than a failure.
 */
@Injectable({ providedIn: 'root' })
export class FixtureStoreService implements FixtureStore {
  private readonly db = inject(IndexedDbStorageService);

  /**
   * The recorded fixture for `key`, or undefined when nothing was recorded or
   * the entry has aged out of the `fx:` namespace TTL. A miss is never an error:
   * `replay` turns it into a node failure naming the node, and
   * `replay-or-record` falls through to the live call.
   */
  async read(key: string): Promise<string | undefined> {
    return (await this.db.getState(key))?.value;
  }

  /**
   * Records a fixture, overwriting any previous value for the same key. Rejects
   * when the fixture is over {@link FIXTURE_MAX_BYTES} or the store is at its
   * retention bound; the engine reports either as a warning and returns the live
   * response, so a failed recording never fails a run (Requirement 16.12).
   */
  write(key: string, value: string): Promise<void> {
    // The TTL is left to the engine's `fx:` namespace default rather than named
    // here, so one definition governs fixture lifetime on every host.
    return this.db.writeState(key, value, undefined, FIXTURE_MAX_BYTES);
  }
}
