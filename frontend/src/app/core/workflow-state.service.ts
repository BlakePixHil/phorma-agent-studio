import { Injectable, inject } from '@angular/core';

import type { StateEntry, WorkflowStateStore } from '@phorma/engine';

import { IndexedDbStorageService } from './indexed-db-storage.service';

/**
 * The desktop host's {@link WorkflowStateStore} (design §8, Requirement 18.3).
 *
 * Every rule that makes durable state safe — the namespace TTL defaults, the
 * per-value and per-workflow byte caps, prune-oldest eviction and the atomic
 * `compareAndSet` an idempotency claim depends on — lives in the `workflow-state`
 * object store in {@link IndexedDbStorageService}, because that is where the
 * IndexedDB transaction boundary is. This service is deliberately a thin
 * delegate: it exists so the run wiring can hand `RunOptions.state` an object
 * that implements the engine interface exactly, with no storage details leaking
 * into the run controller.
 *
 * Keys arrive already workflow-scoped (`workflowId::key` via the engine's
 * `scopedStateKey`), so nothing here needs to know which workflow is running and
 * a prefix scan can never cross a workflow boundary.
 */
@Injectable({ providedIn: 'root' })
export class WorkflowStateService implements WorkflowStateStore {
  private readonly db = inject(IndexedDbStorageService);

  /** An expired entry reads as absent (Requirement 12.18). */
  get(key: string): Promise<StateEntry | undefined> {
    return this.db.getState(key);
  }

  /** Rejects a value over the per-value cap before touching the stored value. */
  set(key: string, value: string, options?: { ttlSec?: number }): Promise<void> {
    return this.db.setState(key, value, options);
  }

  /** Deleting an absent key resolves without an error (Requirement 12.22). */
  delete(key: string): Promise<void> {
    return this.db.deleteState(key);
  }

  /** Prefix-bounded and clamped to 1-1000 entries (Requirement 12.19). */
  list(prefix: string, limit?: number): Promise<StateEntry[]> {
    return this.db.listState(prefix, limit);
  }

  /**
   * Of any number of concurrent claims for one key exactly one resolves true:
   * the read and the write share a single IndexedDB `readwrite` transaction,
   * which the browser never overlaps for the same store, across tabs included
   * (Requirements 12.13, 12.20).
   */
  compareAndSet(
    key: string,
    expected: string | undefined,
    value: string,
    options?: { ttlSec?: number },
  ): Promise<boolean> {
    return this.db.compareAndSetState(key, expected, value, options);
  }
}
