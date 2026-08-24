/**
 * Property 7 for the telemetry storage adapter in `telemetry-storage.ts`.
 *
 * The round trip is the point: counters accumulated during a session only
 * survive a Studio restart inside the same Metric_Day if what is written comes
 * back equal. The same claim is made for all five persisted shapes, since the
 * accumulator alone is useless without the consent record, the queue and the
 * upload record surviving with it.
 *
 * The other half of this suite is the degradation contract, which is what keeps
 * telemetry from ever breaking the app: a corrupted entry, a backend that throws
 * on read, a backend that throws on write (quota, private mode) and an entirely
 * absent backend must all degrade to the documented fallback rather than throw.
 *
 * Everything runs against a `Map`-backed fake. No real `localStorage` is touched
 * anywhere in this file, so the suite cannot leak state into another spec.
 */

import fc from 'fast-check';

import { COUNTER_CATALOG } from './telemetry-catalog';
import type { Accumulator, ConsentState, QueueEntry, UploadState } from './telemetry-core';
import {
  TELEMETRY_STORAGE_KEYS,
  TELEMETRY_STORAGE_PREFIX,
  createTelemetryStorage,
  loadTelemetry,
  removeTelemetry,
  saveTelemetry,
  type TelemetryStorageBackend,
  type TelemetryStorageKey,
} from './telemetry-storage';

/** Minimum iterations for every property in this suite. */
const RUNS = { numRuns: 200 };

// ─── Fake backends ──────────────────────────────────────────────────────────

interface FakeStorage extends TelemetryStorageBackend {
  /** The raw store, so a property can inspect the key namespace directly. */
  readonly entries: Map<string, string>;
}

/** A working backend. `localStorage` semantics, minus the browser. */
function fakeStorage(seed: ReadonlyMap<string, string> = new Map()): FakeStorage {
  const entries = new Map(seed);
  return {
    entries,
    getItem: (key) => (entries.has(key) ? (entries.get(key) as string) : null),
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
}

/** A backend whose every write throws, the way a full quota behaves. */
function writeHostileStorage(reason: string): TelemetryStorageBackend {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error(reason);
    },
    removeItem: () => {
      throw new Error(reason);
    },
  };
}

/** A backend whose every read throws, the way a policy-locked store behaves. */
function readHostileStorage(reason: string): TelemetryStorageBackend {
  return {
    getItem: () => {
      throw new Error(reason);
    },
    setItem: () => undefined,
    removeItem: () => undefined,
  };
}

// ─── Generators for the five persisted shapes ───────────────────────────────

const DAY_MS = 86_400_000;
const BASE_DAY_MS = Date.UTC(2019, 0, 1);

/** A real `YYYY-MM-DD` UTC day, derived without touching the module under test. */
const metricDayArb = fc
  .integer({ min: 0, max: 6_000 })
  .map((offset) => new Date(BASE_DAY_MS + offset * DAY_MS).toISOString().slice(0, 10));

const CATALOG_NAMES = [...COUNTER_CATALOG].sort();

/** A counter map holding only catalog names with positive integer values. */
const countersArb = fc.dictionary(
  fc.constantFrom(...CATALOG_NAMES),
  fc.integer({ min: 1, max: 1_000_000 }),
);

const instantArb = fc.integer({ min: 0, max: 4_000_000_000_000 });

const accumulatorArb: fc.Arbitrary<Accumulator> = fc.record({
  metricDay: metricDayArb,
  counters: countersArb,
  lastSealAt: instantArb,
});

const consentArb: fc.Arbitrary<ConsentState> = fc.record({
  enabled: fc.boolean(),
  disclosureVersion: fc.integer({ min: 0, max: 50 }),
  decidedAt: fc.oneof(
    fc.constant(''),
    instantArb.map((ms) => new Date(ms).toISOString()),
  ),
});

const uploadArb: fc.Arbitrary<UploadState> = fc.record({
  nextAttemptAt: instantArb,
  failureCount: fc.integer({ min: 0, max: 40 }),
  rejectedCount: fc.integer({ min: 0, max: 40 }),
});

/**
 * Environment strings stay printable here. The wire-level sanitizing of hostile
 * values is Property 8's job; this suite is only about JSON fidelity.
 */
const envStringArb = fc.string({ minLength: 1, maxLength: 64 });

const queueEntryArb: fc.Arbitrary<QueueEntry> = fc.record({
  sealedAt: instantArb,
  rollup: fc.record({
    installId: fc.uuid({ version: 4 }),
    metricDay: metricDayArb,
    env: fc.record({
      locale: envStringArb,
      timezone: envStringArb,
      platform: envStringArb,
      osVersion: envStringArb,
      appVersion: envStringArb,
      runtimeMode: fc.constantFrom('desktop' as const, 'browser' as const),
    }),
    counters: countersArb,
    schemaVersion: fc.integer({ min: 0, max: 5 }),
  }),
});

const queueArb = fc.array(queueEntryArb, { maxLength: 30 });

/** One `(key, value)` pair per persisted shape, so all five are covered at once. */
const storedPairArb: fc.Arbitrary<{ key: TelemetryStorageKey; value: unknown }> = fc.oneof(
  fc.record({ key: fc.constant('installId' as const), value: fc.uuid({ version: 4 }) }),
  fc.record({ key: fc.constant('consent' as const), value: consentArb }),
  fc.record({ key: fc.constant('accumulator' as const), value: accumulatorArb }),
  fc.record({ key: fc.constant('queue' as const), value: queueArb }),
  fc.record({ key: fc.constant('upload' as const), value: uploadArb }),
);

const storageKeyArb = fc.constantFrom(...TELEMETRY_STORAGE_KEYS);

/** Stored text that must read as absent: unparseable, or a parsed `null`. */
const corruptedRawArb = fc.oneof(
  fc.constantFrom(
    '',
    '{',
    '[1,',
    '{"metricDay":}',
    "{'metricDay':'2024-01-01'}",
    'undefined',
    'NaN',
    '\u0000',
    'null',
  ),
  fc.string().filter((raw) => {
    try {
      return JSON.parse(raw) === null;
    } catch {
      return true;
    }
  }),
);

/** A fallback value distinguishable from anything the generators produce. */
const FALLBACK = { fallback: true } as const;

describe('telemetry storage round trip', () => {
  // Feature: telemetry-phone-home, Property 7: Accumulated counters round-trip through storage
  it('reads back an equal value with a fresh reader, for every persisted shape', () => {
    fc.assert(
      fc.property(storedPairArb, ({ key, value }) => {
        const backend = fakeStorage();

        createTelemetryStorage(backend).save(key, value);

        // A fresh reader over the same backend: this is the restart.
        const restored = createTelemetryStorage(backend).load(key, FALLBACK as unknown);

        expect(restored).toEqual(value as never);
      }),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 7: Accumulated counters round-trip through storage
  it('preserves every accumulated counter total across the round trip', () => {
    fc.assert(
      fc.property(accumulatorArb, (accumulator) => {
        const backend = fakeStorage();
        saveTelemetry('accumulator', accumulator, backend);

        const restored = loadTelemetry<Accumulator | null>('accumulator', null, backend);

        expect(restored).not.toBeNull();
        expect(restored?.metricDay).toBe(accumulator.metricDay);
        expect(restored?.lastSealAt).toBe(accumulator.lastSealAt);
        // Compared name by name, not as one object, so a dropped or renamed
        // counter is reported as the counter it is.
        const names = Object.keys(accumulator.counters).sort();
        expect(Object.keys(restored?.counters ?? {}).sort()).toEqual(names);
        for (const name of names) {
          expect(restored?.counters[name]).toBe(accumulator.counters[name]);
        }
      }),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 7: Accumulated counters round-trip through storage
  it('keeps the shapes independent, so writing one key cannot disturb another', () => {
    fc.assert(
      fc.property(accumulatorArb, consentArb, uploadArb, queueArb, (acc, consent, upload, queue) => {
        const backend = fakeStorage();
        const storage = createTelemetryStorage(backend);

        storage.save('accumulator', acc);
        storage.save('consent', consent);
        storage.save('upload', upload);
        storage.save('queue', queue);
        storage.remove('upload');

        expect(storage.load('accumulator', FALLBACK as unknown)).toEqual(acc as never);
        expect(storage.load('consent', FALLBACK as unknown)).toEqual(consent as never);
        expect(storage.load('queue', FALLBACK as unknown)).toEqual(queue as never);
        expect(storage.load('upload', FALLBACK as unknown)).toEqual(FALLBACK as never);
      }),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 7: Accumulated counters round-trip through storage
  it('namespaces every key under the telemetry prefix', () => {
    fc.assert(
      fc.property(storedPairArb, ({ key, value }) => {
        const backend = fakeStorage(new Map([['phorma.layout.leftWidth', '320']]));
        saveTelemetry(key, value, backend);

        const written = [...backend.entries.keys()].filter((k) => k !== 'phorma.layout.leftWidth');
        expect(written).toEqual([TELEMETRY_STORAGE_PREFIX + key]);
        expect(written.every((k) => k.startsWith(TELEMETRY_STORAGE_PREFIX))).toBeTrue();
        // The layout entry is a bystander and must stay exactly as it was.
        expect(backend.entries.get('phorma.layout.leftWidth')).toBe('320');
      }),
      RUNS,
    );
  });
});

describe('telemetry storage degradation', () => {
  // Feature: telemetry-phone-home, Property 7: Accumulated counters round-trip through storage
  it('reads a corrupted or unparseable entry as the fallback rather than throwing', () => {
    fc.assert(
      fc.property(storageKeyArb, corruptedRawArb, (key, raw) => {
        const backend = fakeStorage(new Map([[TELEMETRY_STORAGE_PREFIX + key, raw]]));

        expect(loadTelemetry(key, FALLBACK as unknown, backend)).toEqual(FALLBACK as never);
      }),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 7: Accumulated counters round-trip through storage
  it('repairs a corrupted entry on the next write', () => {
    fc.assert(
      fc.property(corruptedRawArb, accumulatorArb, (raw, accumulator) => {
        const backend = fakeStorage(new Map([[`${TELEMETRY_STORAGE_PREFIX}accumulator`, raw]]));
        const storage = createTelemetryStorage(backend);

        expect(storage.load('accumulator', FALLBACK as unknown)).toEqual(FALLBACK as never);
        storage.save('accumulator', accumulator);
        expect(storage.load('accumulator', FALLBACK as unknown)).toEqual(accumulator as never);
      }),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 7: Accumulated counters round-trip through storage
  it('swallows a backend that throws on write', () => {
    fc.assert(
      fc.property(storedPairArb, fc.string({ maxLength: 40 }), ({ key, value }, reason) => {
        const backend = writeHostileStorage(reason);
        const storage = createTelemetryStorage(backend);

        expect(() => storage.save(key, value)).not.toThrow();
        expect(() => storage.remove(key)).not.toThrow();
        expect(() => saveTelemetry(key, value, backend)).not.toThrow();
        expect(() => removeTelemetry(key, backend)).not.toThrow();
        expect(storage.load(key, FALLBACK as unknown)).toEqual(FALLBACK as never);
      }),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 7: Accumulated counters round-trip through storage
  it('swallows a backend that throws on read and answers the fallback', () => {
    fc.assert(
      fc.property(storageKeyArb, fc.string({ maxLength: 40 }), (key, reason) => {
        const storage = createTelemetryStorage(readHostileStorage(reason));

        let restored: unknown;
        expect(() => (restored = storage.load(key, FALLBACK as unknown))).not.toThrow();
        expect(restored).toEqual(FALLBACK as never);
      }),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 7: Accumulated counters round-trip through storage
  it('treats an unavailable backend as an empty store that accepts writes silently', () => {
    fc.assert(
      fc.property(storedPairArb, ({ key, value }) => {
        const storage = createTelemetryStorage(null);

        expect(() => storage.save(key, value)).not.toThrow();
        expect(() => storage.remove(key)).not.toThrow();
        expect(storage.load(key, FALLBACK as unknown)).toEqual(FALLBACK as never);
        // And the module-level accessors agree.
        expect(loadTelemetry(key, FALLBACK as unknown, null)).toEqual(FALLBACK as never);
      }),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 7: Accumulated counters round-trip through storage
  it('swallows a value that cannot be serialized', () => {
    const backend = fakeStorage();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    expect(() => saveTelemetry('accumulator', cyclic, backend)).not.toThrow();
    expect(backend.entries.size).toBe(0);
    expect(loadTelemetry('accumulator', FALLBACK as unknown, backend)).toEqual(FALLBACK as never);
  });
});
