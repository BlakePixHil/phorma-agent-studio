import { beforeEach, describe, expect, it } from 'vitest';
import {
  IDEMPOTENCY_TTL_SEC,
  STATE_NS,
  STATE_TTL_DEFAULT_SEC,
  STATE_TTL_MAX_SEC,
  STATE_VALUE_MAX_BYTES,
  deltaStateKey,
  idempotencyStateKey,
  isPrunableStateKey,
  oauthStateKey,
  resolveStateTtlSec,
  scopedStateKey,
  utf8ByteLength,
  watermarkStateKey,
} from './state.js';
import { MemoryStateStore } from './test/memory-state-store.js';

/**
 * State retention bounds, TTL resolution and delete semantics
 * (Requirements 12.16, 12.17, 12.18, 12.21, 12.22).
 *
 * The bounds live in `state.ts` and are enforced by each host store; the in-memory
 * store implements the same contract with an injectable clock and injectable
 * bounds, so a retention test does not have to write 50 000 keys and a TTL test
 * does not have to wait 400 days.
 */

const WF = 'wf-1';
const DAY_SEC = 86_400;

/** Test clock, advanced explicitly by the expiry cases. */
let now = 1_700_000_000_000;
const clock = (): number => now;

function scoped(key: string): string {
  return scopedStateKey(WF, key);
}

beforeEach(() => {
  now = 1_700_000_000_000;
});

// ─────────────────────────────────────────────────────────────────────────────
// 12.16 Per-value size limit
// ─────────────────────────────────────────────────────────────────────────────

describe('per-value size limit (12.16)', () => {
  it('accepts a value at exactly the 32768-byte cap', async () => {
    const store = new MemoryStateStore({ now: clock });
    const key = scoped('at-cap');
    const value = 'a'.repeat(STATE_VALUE_MAX_BYTES);

    await store.set(key, value);

    expect(utf8ByteLength(value)).toBe(STATE_VALUE_MAX_BYTES);
    expect((await store.get(key))?.value).toBe(value);
  });

  it('rejects a set above the cap and leaves the stored value unchanged', async () => {
    const store = new MemoryStateStore({ now: clock });
    const key = scoped('over-cap');
    await store.set(key, 'previous');

    await expect(store.set(key, 'a'.repeat(STATE_VALUE_MAX_BYTES + 1))).rejects.toThrow(
      /per-value size limit/i,
    );

    const entry = await store.get(key);
    expect(entry?.value).toBe('previous');
  });

  it('rejects a compareAndSet above the cap and leaves the stored value unchanged', async () => {
    const store = new MemoryStateStore({ now: clock });
    const key = scoped('over-cap-cas');
    await store.set(key, 'previous');

    await expect(
      store.compareAndSet(key, 'previous', 'a'.repeat(STATE_VALUE_MAX_BYTES + 1)),
    ).rejects.toThrow(/per-value size limit/i);

    expect((await store.get(key))?.value).toBe('previous');
    expect(store.writes).toBe(0);
  });

  it('measures UTF-8 bytes, not characters', async () => {
    const store = new MemoryStateStore({ now: clock });
    // 20000 two-byte characters: under the cap by length, over it by bytes.
    const value = 'é'.repeat(20_000);
    expect(value.length).toBeLessThan(STATE_VALUE_MAX_BYTES);
    expect(utf8ByteLength(value)).toBe(40_000);

    await expect(store.set(scoped('multibyte'), value)).rejects.toThrow(/per-value size limit/i);
    expect(await store.get(scoped('multibyte'))).toBeUndefined();
  });

  it('never leaves a rejected write visible to a later read of a fresh key', async () => {
    const store = new MemoryStateStore({ now: clock });
    const key = scoped('fresh');

    await expect(store.set(key, 'x'.repeat(STATE_VALUE_MAX_BYTES + 10))).rejects.toThrow();

    expect(await store.get(key)).toBeUndefined();
    // A rejected write does not poison later operations.
    await store.set(key, 'ok');
    expect((await store.get(key))?.value).toBe('ok');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12.17 Prune-oldest retention
// ─────────────────────────────────────────────────────────────────────────────

describe('prune-oldest retention (12.17)', () => {
  it('deletes entries in ascending updatedAt order when the key bound is reached', async () => {
    const store = new MemoryStateStore({ now: clock, maxKeysPerWorkflow: 3 });

    await store.set(scoped(deltaStateKey('order', 'a')), 'a');
    now += 1_000;
    await store.set(scoped(deltaStateKey('order', 'b')), 'b');
    now += 1_000;
    await store.set(scoped(deltaStateKey('order', 'c')), 'c');
    expect(store.liveKeys()).toHaveLength(3);

    now += 1_000;
    await store.set(scoped(deltaStateKey('order', 'd')), 'd');

    expect(store.liveKeys()).toEqual([
      scoped(deltaStateKey('order', 'b')),
      scoped(deltaStateKey('order', 'c')),
      scoped(deltaStateKey('order', 'd')),
    ]);
    expect(await store.get(scoped(deltaStateKey('order', 'a')))).toBeUndefined();
  });

  it('excludes the wm: and oauth: namespaces from pruning', async () => {
    const store = new MemoryStateStore({ now: clock, maxKeysPerWorkflow: 3 });

    await store.set(scoped(watermarkStateKey('orders')), '2024-01-01T00:00:00Z');
    now += 1_000;
    await store.set(scoped(oauthStateKey('conn-1')), '{"token":"t"}');
    now += 1_000;
    await store.set(scoped(deltaStateKey('order', 'a')), 'a');

    now += 1_000;
    await store.set(scoped(deltaStateKey('order', 'b')), 'b');

    // The two oldest entries are wm:/oauth:, so the delta entry is the victim.
    expect(store.liveKeys()).toEqual([
      scoped(watermarkStateKey('orders')),
      scoped(oauthStateKey('conn-1')),
      scoped(deltaStateKey('order', 'b')),
    ]);
    expect(isPrunableStateKey(scoped(watermarkStateKey('orders')))).toBe(false);
    expect(isPrunableStateKey(scoped(oauthStateKey('conn-1')))).toBe(false);
    expect(isPrunableStateKey(scoped(deltaStateKey('order', 'a')))).toBe(true);
  });

  it('rejects the write with the breached bound when nothing prunable remains', async () => {
    const store = new MemoryStateStore({ now: clock, maxKeysPerWorkflow: 2 });

    await store.set(scoped(watermarkStateKey('orders')), '1');
    await store.set(scoped(oauthStateKey('conn-1')), '{"token":"t"}');

    await expect(store.set(scoped(deltaStateKey('order', 'a')), 'a')).rejects.toThrow(
      /retention bound/i,
    );
    expect(store.liveKeys()).toEqual([
      scoped(watermarkStateKey('orders')),
      scoped(oauthStateKey('conn-1')),
    ]);
  });

  it('prunes on the total-byte bound until the incoming write fits', async () => {
    const store = new MemoryStateStore({ now: clock, maxTotalBytesPerWorkflow: 30 });

    await store.set(scoped(deltaStateKey('bytes', 'a')), 'a'.repeat(10));
    now += 1_000;
    await store.set(scoped(deltaStateKey('bytes', 'b')), 'b'.repeat(10));
    now += 1_000;
    await store.set(scoped(deltaStateKey('bytes', 'c')), 'c'.repeat(10));
    expect(store.liveKeys()).toHaveLength(3);

    now += 1_000;
    await store.set(scoped(deltaStateKey('bytes', 'd')), 'd'.repeat(20));

    // 20 incoming bytes leave room for a single 10-byte entry.
    expect(store.liveKeys()).toEqual([
      scoped(deltaStateKey('bytes', 'c')),
      scoped(deltaStateKey('bytes', 'd')),
    ]);
  });

  it('bounds each workflow separately', async () => {
    const store = new MemoryStateStore({ now: clock, maxKeysPerWorkflow: 2 });

    await store.set(scopedStateKey('wf-a', deltaStateKey('x', '1')), '1');
    now += 1_000;
    await store.set(scopedStateKey('wf-b', deltaStateKey('x', '1')), '1');
    now += 1_000;
    await store.set(scopedStateKey('wf-a', deltaStateKey('x', '2')), '2');
    now += 1_000;
    await store.set(scopedStateKey('wf-a', deltaStateKey('x', '3')), '3');

    // Only wf-a lost its oldest entry; wf-b is untouched.
    expect(store.liveKeys()).toEqual([
      scopedStateKey('wf-b', deltaStateKey('x', '1')),
      scopedStateKey('wf-a', deltaStateKey('x', '2')),
      scopedStateKey('wf-a', deltaStateKey('x', '3')),
    ]);
  });

  it('overwriting an existing key does not prune another entry', async () => {
    const store = new MemoryStateStore({ now: clock, maxKeysPerWorkflow: 2 });

    await store.set(scoped(deltaStateKey('over', 'a')), 'a');
    now += 1_000;
    await store.set(scoped(deltaStateKey('over', 'b')), 'b');
    now += 1_000;
    await store.set(scoped(deltaStateKey('over', 'b')), 'b2');

    expect(store.liveKeys().sort()).toEqual(
      [scoped(deltaStateKey('over', 'a')), scoped(deltaStateKey('over', 'b'))].sort(),
    );
    expect((await store.get(scoped(deltaStateKey('over', 'b'))))?.value).toBe('b2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12.18 TTL defaults, override range and expiry
// ─────────────────────────────────────────────────────────────────────────────

describe('namespace TTL defaults (12.18)', () => {
  it('applies 400 days to delta:, 7 days to idem: and 30 days to fx:', () => {
    expect(resolveStateTtlSec(deltaStateKey('order', '1'))).toBe(400 * DAY_SEC);
    expect(resolveStateTtlSec(idempotencyStateKey('run-1:row-1'))).toBe(7 * DAY_SEC);
    expect(resolveStateTtlSec(`${STATE_NS.fixture}node-1:abcd1234`)).toBe(30 * DAY_SEC);
    expect(STATE_TTL_DEFAULT_SEC[STATE_NS.idempotency]).toBe(IDEMPOTENCY_TTL_SEC);
  });

  it('gives wm:, oauth: and user keys no expiry', () => {
    expect(resolveStateTtlSec(watermarkStateKey('orders'))).toBeUndefined();
    expect(resolveStateTtlSec(oauthStateKey('conn-1'))).toBeUndefined();
    expect(resolveStateTtlSec('cursor')).toBeUndefined();
  });

  it('resolves a workflow-scoped key the same as a bare key', () => {
    expect(resolveStateTtlSec(scoped(deltaStateKey('order', '1')))).toBe(400 * DAY_SEC);
    expect(resolveStateTtlSec(scoped(watermarkStateKey('orders')))).toBeUndefined();
  });

  it('lets an explicit ttlSec in 1…34560000 override the namespace default', () => {
    expect(resolveStateTtlSec(deltaStateKey('order', '1'), 60)).toBe(60);
    expect(resolveStateTtlSec(watermarkStateKey('orders'), 1)).toBe(1);
    expect(resolveStateTtlSec('cursor', STATE_TTL_MAX_SEC)).toBe(STATE_TTL_MAX_SEC);
  });

  it('falls back to the namespace default for an out-of-range or non-integer ttlSec', () => {
    for (const bad of [0, -1, 1.5, STATE_TTL_MAX_SEC + 1, Number.NaN]) {
      expect(resolveStateTtlSec(deltaStateKey('order', '1'), bad)).toBe(400 * DAY_SEC);
      expect(resolveStateTtlSec('cursor', bad)).toBeUndefined();
    }
  });

  it('stamps expiresAt from the namespace default and omits it where none applies', async () => {
    const store = new MemoryStateStore({ now: clock });
    const written = now;

    await store.set(scoped(idempotencyStateKey('row-1')), 'claimed');
    await store.set(scoped(watermarkStateKey('orders')), '2024-01-01T00:00:00Z');

    const idem = await store.get(scoped(idempotencyStateKey('row-1')));
    expect(idem?.updatedAt).toBe(written);
    expect(idem?.expiresAt).toBe(written + 7 * DAY_SEC * 1000);

    const wm = await store.get(scoped(watermarkStateKey('orders')));
    expect(wm?.expiresAt).toBeUndefined();
  });

  it('treats an entry at or past expiresAt as absent for get, list and compareAndSet', async () => {
    const store = new MemoryStateStore({ now: clock });
    const key = scoped(idempotencyStateKey('row-1'));
    await store.set(key, 'claimed');
    const expiresAt = (await store.get(key))?.expiresAt as number;

    // One millisecond before expiry the entry is still live.
    now = expiresAt - 1;
    expect((await store.get(key))?.value).toBe('claimed');
    expect(await store.list(scoped(STATE_NS.idempotency))).toHaveLength(1);

    // At expiresAt it reads as absent everywhere.
    now = expiresAt;
    expect(await store.get(key)).toBeUndefined();
    expect(await store.list(scoped(STATE_NS.idempotency))).toEqual([]);
    expect(await store.compareAndSet(key, 'claimed', 'again')).toBe(false);
    expect(await store.compareAndSet(key, undefined, 'reclaimed')).toBe(true);
    expect((await store.get(key))?.value).toBe('reclaimed');
  });

  it('honours an explicit ttlSec over the namespace default when expiring', async () => {
    const store = new MemoryStateStore({ now: clock });
    const key = scoped(deltaStateKey('order', '1'));
    await store.set(key, 'hash', { ttlSec: 60 });

    now += 59_999;
    expect((await store.get(key))?.value).toBe('hash');
    now += 1;
    expect(await store.get(key)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12.21 compareAndSet mismatch leaves the entry untouched
// ─────────────────────────────────────────────────────────────────────────────

describe('compareAndSet mismatch (12.21)', () => {
  it('resolves false and leaves the value and expiry unchanged on a value mismatch', async () => {
    const store = new MemoryStateStore({ now: clock });
    const key = scoped(deltaStateKey('order', '1'));
    await store.set(key, 'hash-1');
    const before = await store.get(key);

    now += 5_000;
    expect(await store.compareAndSet(key, 'hash-other', 'hash-2')).toBe(false);

    const after = await store.get(key);
    expect(after?.value).toBe('hash-1');
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(after?.expiresAt).toBe(before?.expiresAt);
    expect(store.writes).toBe(0);
  });

  it('resolves false when expected is absent but an unexpired value is held', async () => {
    const store = new MemoryStateStore({ now: clock });
    const key = scoped(idempotencyStateKey('row-1'));
    expect(await store.compareAndSet(key, undefined, 'claimed')).toBe(true);

    expect(await store.compareAndSet(key, undefined, 'stolen')).toBe(false);
    expect((await store.get(key))?.value).toBe('claimed');
    expect(store.writes).toBe(1);
  });

  it('resolves false when expected is present but the key is absent', async () => {
    const store = new MemoryStateStore({ now: clock });
    const key = scoped(deltaStateKey('order', 'missing'));

    expect(await store.compareAndSet(key, 'hash-1', 'hash-2')).toBe(false);
    expect(await store.get(key)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12.22 delete semantics
// ─────────────────────────────────────────────────────────────────────────────

describe('delete semantics (12.22)', () => {
  it('makes a subsequent get report absent and excludes the key from list', async () => {
    const store = new MemoryStateStore({ now: clock });
    const gone = scoped(deltaStateKey('order', '1'));
    const kept = scoped(deltaStateKey('order', '2'));
    await store.set(gone, 'hash-1');
    await store.set(kept, 'hash-2');

    await store.delete(gone);

    expect(await store.get(gone)).toBeUndefined();
    expect((await store.list(scoped(STATE_NS.delta))).map((e) => e.key)).toEqual([kept]);
  });

  it('resolves without an error when the key holds no value, and is idempotent', async () => {
    const store = new MemoryStateStore({ now: clock });
    const key = scoped('never-written');

    await expect(store.delete(key)).resolves.toBeUndefined();

    await store.set(key, 'v');
    await expect(store.delete(key)).resolves.toBeUndefined();
    await expect(store.delete(key)).resolves.toBeUndefined();
    expect(await store.get(key)).toBeUndefined();
  });

  it('frees the deleted key against the retention bounds and allows a re-write', async () => {
    const store = new MemoryStateStore({ now: clock, maxKeysPerWorkflow: 2 });
    const a = scoped(deltaStateKey('order', 'a'));
    const b = scoped(deltaStateKey('order', 'b'));
    await store.set(a, 'a');
    await store.set(b, 'b');

    await store.delete(a);
    now += 1_000;
    await store.set(scoped(deltaStateKey('order', 'c')), 'c');

    expect(store.liveKeys()).toEqual([b, scoped(deltaStateKey('order', 'c'))]);

    // A deleted key can be written again and reads back as a fresh entry.
    now += 1_000;
    await store.delete(b);
    await store.set(a, 'a2');
    const entry = await store.get(a);
    expect(entry?.value).toBe('a2');
    expect(entry?.updatedAt).toBe(now);
  });
});
