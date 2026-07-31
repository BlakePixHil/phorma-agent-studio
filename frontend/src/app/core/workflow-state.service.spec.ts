import { TestBed } from '@angular/core/testing';

import { scopedStateKey, type StateEntry } from '@phorma/engine';

import { WorkflowStateService } from './workflow-state.service';

/**
 * `WorkflowStateService` is a thin delegate over the IndexedDB `workflow-state`
 * store (Requirements 12.1-12.22), so these tests exercise it through the real
 * browser IndexedDB rather than a mock — the guarantees that matter (TTL
 * expiry, the `list` clamp, workflow isolation and atomic `compareAndSet`) all
 * live in the IndexedDB transaction boundary itself.
 */
describe('WorkflowStateService', () => {
  let service: WorkflowStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(WorkflowStateService);
  });

  /** A fresh, collision-free workflow id per test/case. */
  function uniqueWorkflowId(label: string): string {
    return `wf-${label}-${crypto.randomUUID()}`;
  }

  /**
   * Requirements 12.18, 12.20: a value written through `set` reads back
   * byte-identical right up until its TTL, and reads as absent once
   * `expiresAt` is at or before "now".
   */
  it('reads a value back until its TTL and as absent once expired', async () => {
    let now = 1_700_000_000_000;
    spyOn(Date, 'now').and.callFake(() => now);

    const workflowId = uniqueWorkflowId('ttl');
    const key = scopedStateKey(workflowId, 'ttl-key');

    await service.set(key, 'still-fresh', { ttlSec: 1 });

    // Still inside the 1-second TTL: byte-identical and present.
    const fresh = await service.get(key);
    expect(fresh?.value).toBe('still-fresh');
    expect(fresh?.updatedAt).toBe(now);

    // Exactly at expiresAt (writeTime + 1000ms): the entry counts as absent.
    now += 1000;
    expect(await service.get(key)).toBeUndefined();
  });

  /**
   * Requirement 12.19: `list` returns at most the supplied limit, treats an
   * absent limit as 1000, clamps an above-bound limit down to 1000 and
   * clamps a below-bound limit up to 1 — regardless of how many entries
   * actually exist under the scope.
   */
  it('clamps list() to the documented 1-1000 bound', async () => {
    const workflowId = uniqueWorkflowId('list-clamp');
    const prefix = scopedStateKey(workflowId, '');
    const total = 1005;

    await Promise.all(
      Array.from({ length: total }, (_, i) =>
        service.set(scopedStateKey(workflowId, `k${i}`), String(i)),
      ),
    );

    // Absent limit resolves to the documented default of 1000, even though
    // 1005 entries exist under this scope.
    const defaultLimited = await service.list(prefix);
    expect(defaultLimited.length).toBe(1000);

    // A limit above 1000 clamps down to 1000, never returning every entry.
    const aboveBound = await service.list(prefix, 5000);
    expect(aboveBound.length).toBe(1000);

    // A limit of 0 or negative clamps up to 1, never to zero entries.
    const zeroLimit = await service.list(prefix, 0);
    expect(zeroLimit.length).toBe(1);
    const negativeLimit = await service.list(prefix, -10);
    expect(negativeLimit.length).toBe(1);

    // Every returned entry still starts with the requested prefix.
    for (const entry of defaultLimited) {
      expect(entry.key.startsWith(prefix)).toBeTrue();
    }
  }, 60_000);

  /**
   * Requirement 12.2: every state key is scoped by `workflowId`, so a read or
   * prefix scan under one workflow never observes an entry written under
   * another, even when both use the identical unscoped key.
   */
  it('isolates get/list between two workflow scopes sharing the same unscoped key', async () => {
    const workflowA = uniqueWorkflowId('isolation-a');
    const workflowB = uniqueWorkflowId('isolation-b');
    const keyA = scopedStateKey(workflowA, 'shared-key');
    const keyB = scopedStateKey(workflowB, 'shared-key');

    await service.set(keyA, 'value-a');
    await service.set(keyB, 'value-b');

    // Each workflow reads only its own value under the identical unscoped key.
    expect((await service.get(keyA))?.value).toBe('value-a');
    expect((await service.get(keyB))?.value).toBe('value-b');

    // A prefix scan for one workflow returns only that workflow's entries.
    const listA = await service.list(scopedStateKey(workflowA, ''));
    const listB = await service.list(scopedStateKey(workflowB, ''));
    expect(listA.map(entry => entry.key)).toEqual([keyA]);
    expect(listB.map(entry => entry.key)).toEqual([keyB]);
  });

  /**
   * Requirement 12.13: of any number of concurrent claims on the same key
   * with `expected: undefined`, exactly one resolves true, and the winning
   * value is the one that ends up stored.
   */
  it('resolves compareAndSet true for exactly one of several concurrent claimants', async () => {
    const workflowId = uniqueWorkflowId('cas-race');
    const key = scopedStateKey(workflowId, 'claim-key');
    const callers = 8;

    const outcomes: boolean[] = await Promise.all(
      Array.from({ length: callers }, (_, i) =>
        service.compareAndSet(key, undefined, `claim-${i}`),
      ),
    );

    expect(outcomes.filter(Boolean).length).toBe(1);

    const winnerIndex = outcomes.indexOf(true);
    const entry: StateEntry | undefined = await service.get(key);
    expect(entry?.value).toBe(`claim-${winnerIndex}`);
  });
});
