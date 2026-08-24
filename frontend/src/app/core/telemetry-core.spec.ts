/**
 * Properties 1, 2, 6, 8, 9, 10, 11, 12, 13 and 16 for the pure telemetry state
 * algebra in `telemetry-core.ts`.
 *
 * Every exported function in that module is total, so the generators here are
 * deliberately hostile: non-finite numbers, non-integers, malformed persisted
 * records, junk counter names and arbitrary strings all go straight in.
 *
 * Each property compares the module against an INDEPENDENT derivation rather than
 * a restatement of the implementation:
 *
 * - the disclosure gate is driven as a two-start bootstrap chain, so the claim is
 *   "the notice fires once per disclosure version and consent survives", not
 *   "the parser parses";
 * - counter accumulation is folded into a plain `Map` by a generator that tags
 *   each report as kept or dropped when it is built, so the oracle is told what
 *   should survive instead of re-deriving the guard;
 * - Metric_Day arithmetic uses `new Date(ms).toISOString().slice(0, 10)` written
 *   out locally rather than `metricDayUtc`;
 * - the backoff curve is derived by repeated doubling rather than by `2 ** n`;
 * - the upload queue is checked against a one-eviction-at-a-time model that scans
 *   for its victim instead of sorting.
 */

import fc from 'fast-check';

import {
  COUNTER_CATALOG,
  CURRENT_DISCLOSURE_VERSION,
  TELEMETRY_SCHEMA_VERSION,
} from './telemetry-catalog';
import {
  ENV_KEYS,
  INTERIM_SEAL_INTERVAL_MS,
  LOCAL_INGEST_HOSTNAMES,
  MAX_BACKOFF_MS,
  QUEUE_CAP,
  ROLLUP_KEYS,
  UPLOAD_INTERVAL_MS,
  acknowledgeDisclosure,
  appendToQueue,
  applyIncrement,
  applyIngestOutcome,
  backoffMs,
  classifyIngestStatus,
  counterTotal,
  defaultUploadState,
  emptyAccumulator,
  isMetricDay,
  metricDayUtc,
  readConsent,
  resetDerivedState,
  resolveIngestUrl,
  rollDayIfNeeded,
  sealEntry,
  sealInterimIfDue,
  sealRollup,
  shouldShowNotice,
  type Accumulator,
  type ClientEnvironment,
  type IngestOutcome,
  type QueueEntry,
  type RuntimeMode,
  type TelemetryState,
} from './telemetry-core';

/** Minimum iterations for every property in this suite. */
const RUNS = { numRuns: 200 };

// ─── Independent day arithmetic ─────────────────────────────────────────────

const DAY_MS = 86_400_000;
const BASE_DAY_MS = Date.UTC(2019, 0, 1);

/** The UTC calendar day of `ms`, derived without touching the module. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A real `YYYY-MM-DD` day somewhere in 2019 to 2035. */
const metricDayArb = fc.integer({ min: 0, max: 6_000 }).map(offset => utcDay(BASE_DAY_MS + offset * DAY_MS));

/** Values that look like a day but are not one. */
const junkDayArb = fc.oneof(
  fc.constantFrom(
    '',
    'today',
    '2024-13-01',
    '2024-02-30',
    '20240101',
    '2024-1-1',
    '2024-01-01T00:00:00.000Z',
    ' 2024-01-01',
    '2024-01-01 ',
  ),
  fc.string(),
);

/** A finite epoch-ms instant inside the same window as {@link metricDayArb}. */
const nowArb = fc
  .tuple(fc.integer({ min: 0, max: 6_000 }), fc.integer({ min: 0, max: DAY_MS - 1 }))
  .map(([days, within]) => BASE_DAY_MS + days * DAY_MS + within);

// ─── Counter generators ─────────────────────────────────────────────────────

const CATALOG_NAMES = [...COUNTER_CATALOG].sort();
const catalogNameArb = fc.constantFrom(...CATALOG_NAMES);

/** Positive safe integers: the only amount an increment may carry. */
const validAmountArb = fc.integer({ min: 1, max: 5_000 });

/** Everything an amount must not be. */
const invalidAmountArb = fc.oneof(
  fc.constantFrom(
    0,
    -0,
    -1,
    -7,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    1e21,
  ),
  fc.integer({ min: -5_000, max: 0 }),
  fc
    .double({ min: -1_000, max: 1_000, noNaN: true, noDefaultInfinity: true })
    .filter(value => !Number.isSafeInteger(value)),
);

/** Names outside the Counter_Catalog, kept close to the real ones. */
const nonCatalogNameArb = fc
  .oneof(
    fc.string(),
    fc.constantFrom(
      '',
      'node.created',
      'error',
      'panel.opened',
      'session.started ',
      'run.started:extra',
      'usage.read',
      'toString',
      'constructor',
    ),
    catalogNameArb.map(name => `${name}:x`),
    catalogNameArb.map(name => name.toUpperCase()),
  )
  .filter(name => !COUNTER_CATALOG.has(name));

/** A clean counter map: catalog names, positive safe integer values. */
const counterMapArb = fc
  .array(fc.tuple(catalogNameArb, validAmountArb), { maxLength: 6 })
  .map(pairs => Object.fromEntries(pairs) as Record<string, number>);

/** One counter map entry, tagged at construction time with whether it survives. */
interface TaggedEntry {
  key: string;
  value: unknown;
  kept: boolean;
}

const keptEntryArb: fc.Arbitrary<TaggedEntry> = fc
  .tuple(catalogNameArb, validAmountArb)
  .map(([key, value]) => ({ key, value: value as unknown, kept: true }));

const droppedEntryArb: fc.Arbitrary<TaggedEntry> = fc
  .oneof(
    fc.tuple(nonCatalogNameArb, fc.oneof(validAmountArb, invalidAmountArb) as fc.Arbitrary<unknown>),
    fc.tuple(catalogNameArb, invalidAmountArb as fc.Arbitrary<unknown>),
    fc.tuple(
      catalogNameArb,
      fc.constantFrom<unknown>('5', null, undefined, true, {}, [], '  '),
    ),
  )
  .map(([key, value]) => ({ key, value, kept: false }));

/** A hostile counter map plus the entries that must survive sanitization. */
const taggedCounterMapArb = fc
  .array(fc.oneof(keptEntryArb, droppedEntryArb), { maxLength: 8 })
  .map(entries => {
    // Last write wins, exactly as an object literal would resolve it.
    const byKey = new Map<string, TaggedEntry>();
    for (const entry of entries) byKey.set(entry.key, entry);
    const counters: Record<string, unknown> = {};
    const expected: Record<string, number> = {};
    for (const entry of byKey.values()) {
      counters[entry.key] = entry.value;
      if (entry.kept) expected[entry.key] = entry.value as number;
    }
    return { counters, expected };
  });

// ─── Environment and identity generators ────────────────────────────────────

const installIdArb = fc.constantFrom(
  '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  '11111111-2222-4333-9444-555555555555',
);

const envArb: fc.Arbitrary<ClientEnvironment> = fc.record({
  locale: fc.constantFrom('en-US', 'de-DE', 'ja-JP', 'fr'),
  timezone: fc.constantFrom('UTC', 'Europe/Berlin', 'America/New_York'),
  platform: fc.constantFrom('windows', 'macos', 'linux', 'other'),
  osVersion: fc.constantFrom('10.0.19045', '14.4.1', '6.8.0-generic', 'unknown'),
  appVersion: fc.constantFrom('0.2.0-beta.10', '1.0.0'),
  runtimeMode: fc.constantFrom<RuntimeMode>('desktop', 'browser'),
});

const queueEntryArb: fc.Arbitrary<QueueEntry> = fc.record({
  sealedAt: fc.integer({ min: 0, max: 10_000 }),
  rollup: fc.record({
    installId: installIdArb,
    metricDay: metricDayArb,
    env: envArb,
    counters: counterMapArb,
    schemaVersion: fc.constant(TELEMETRY_SCHEMA_VERSION),
  }),
});

/** A queue whose entries are all older than any {@link nowArb} instant. */
const queueArb = fc.array(queueEntryArb, { maxLength: 8 });

// ─── Small independent helpers ──────────────────────────────────────────────

function sumValues(map: Record<string, number>): number {
  return Object.values(map).reduce((total, value) => total + value, 0);
}

function sealTime(entry: QueueEntry): number {
  const raw = entry?.sealedAt;
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : 0;
}

function pairOf(entry: QueueEntry): string {
  return `${entry.rollup.installId}\u0000${entry.rollup.metricDay}`;
}

// ─── Property 1: Disclosure gate decision ───────────────────────────────────

/**
 * A persisted `consent` value together with what it MEANS, decided when the case
 * is built rather than re-derived from the value afterwards.
 *
 * `isRecord` is whether anything usable was persisted at all, `enabled` is the
 * consent value the record carries (`null` when it carries none), and `version`
 * is the disclosure version it carries (`null` when unusable, which must read as
 * version 0 and therefore re-show the notice).
 */
interface ConsentCase {
  raw: unknown;
  isRecord: boolean;
  enabled: boolean | null;
  version: number | null;
}

const absentConsentArb: fc.Arbitrary<ConsentCase> = fc
  .constantFrom<unknown>(null, undefined, 'consent', 7, true, [], [{ enabled: true }], NaN)
  .map(raw => ({ raw, isRecord: false, enabled: null, version: null }));

const persistedConsentArb: fc.Arbitrary<ConsentCase> = fc
  .tuple(
    fc.option(fc.boolean(), { nil: undefined }),
    fc.oneof(
      fc.integer({ min: -5, max: 9 }).map(value => ({ value: value as unknown, version: value as number | null })),
      fc
        .constantFrom<unknown>('3', null, undefined, true, NaN, Number.POSITIVE_INFINITY, {}, [1])
        .map(value => ({ value, version: null as number | null })),
      fc
        .double({ min: -5, max: 9, noNaN: true, noDefaultInfinity: true })
        .filter(value => !Number.isInteger(value))
        .map(value => ({ value: value as unknown, version: Math.trunc(value) as number | null })),
    ),
    fc.option(fc.string(), { nil: undefined }),
  )
  .map(([enabled, version, decidedAt]) => ({
    raw: {
      ...(enabled === undefined ? {} : { enabled }),
      ...(version.value === undefined ? {} : { disclosureVersion: version.value }),
      ...(decidedAt === undefined ? {} : { decidedAt }),
    } as unknown,
    isRecord: true,
    enabled: enabled ?? null,
    version: version.version,
  }));

const consentCaseArb = fc.oneof(absentConsentArb, persistedConsentArb);

describe('telemetry disclosure gate', () => {
  // Feature: telemetry-phone-home, Property 1: Disclosure gate decision
  it('shows the notice once per disclosure version and never flips a persisted consent value', () => {
    fc.assert(
      fc.property(
        consentCaseArb,
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 0, max: 20 }),
        nowArb,
        (probe, current, bump, decidedAtMs) => {
          const nowIso = new Date(decidedAtMs).toISOString();
          const stored = readConsent(probe.raw);

          // Nothing usable persisted reads as "no record", which is what fires
          // the notice on a fresh install.
          expect(stored === null).toBe(!probe.isRecord);

          // FIRST START. The notice fires when no record was persisted, or when
          // the persisted version is below the current one. An unusable version
          // counts as 0.
          const persistedVersion = probe.isRecord ? probe.version ?? 0 : null;
          const expectedFirstShow = persistedVersion === null || persistedVersion < current;
          expect(shouldShowNotice(stored, current)).toBe(expectedFirstShow);

          // The record written after presenting the disclosure keeps the user's
          // choice and defaults an absent one to enabled.
          const expectedEnabled = probe.enabled ?? true;
          const acknowledged = acknowledgeDisclosure(stored, nowIso, current);
          expect(acknowledged.enabled).toBe(expectedEnabled);
          expect(acknowledged.disclosureVersion).toBe(current);
          expect(acknowledged.decidedAt).toBe(nowIso);

          // SECOND START, same disclosure version: the notice stays hidden and
          // consent is unchanged. No dismissal flag is needed for this.
          const reread = readConsent(JSON.parse(JSON.stringify(acknowledged)));
          expect(reread).not.toBeNull();
          expect(reread!.enabled).toBe(expectedEnabled);
          expect(shouldShowNotice(reread, current)).toBe(false);

          // SECOND START, bumped disclosure version: the notice returns exactly
          // when the version actually moved, and consent still survives.
          expect(shouldShowNotice(reread, current + bump)).toBe(bump > 0);
          const reacknowledged = acknowledgeDisclosure(reread, nowIso, current + bump);
          expect(reacknowledged.enabled).toBe(expectedEnabled);
          expect(reacknowledged.disclosureVersion).toBe(current + bump);
          expect(shouldShowNotice(reacknowledged, current + bump)).toBe(false);
        },
      ),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 1: Disclosure gate decision
  it('parses any persisted value without throwing, and only a plain object at all', () => {
    fc.assert(
      fc.property(fc.anything(), raw => {
        const stored = readConsent(raw);
        const isPlainObject = typeof raw === 'object' && raw !== null && !Array.isArray(raw);
        expect(stored === null).toBe(!isPlainObject);
        if (stored !== null) {
          expect(typeof stored.enabled).toBe('boolean');
          expect(Number.isFinite(stored.disclosureVersion)).toBe(true);
          expect(typeof stored.decidedAt).toBe('string');
        }
        // Totality: the gate answers for anything, and defaults to showing the
        // notice when nothing usable was persisted.
        expect(typeof shouldShowNotice(stored, CURRENT_DISCLOSURE_VERSION)).toBe('boolean');
        expect(() => acknowledgeDisclosure(stored, '', CURRENT_DISCLOSURE_VERSION)).not.toThrow();
      }),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 1: Disclosure gate decision
  it('falls back to the shipped disclosure version when the ceiling is unusable', () => {
    fc.assert(
      fc.property(
        consentCaseArb,
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        (probe, ceiling) => {
          const stored = readConsent(probe.raw);
          expect(shouldShowNotice(stored, ceiling)).toBe(
            shouldShowNotice(stored, CURRENT_DISCLOSURE_VERSION),
          );
          expect(acknowledgeDisclosure(stored, '2024-01-01T00:00:00.000Z', ceiling).disclosureVersion).toBe(
            CURRENT_DISCLOSURE_VERSION,
          );
        },
      ),
      RUNS,
    );
  });
});

// ─── Property 2: Consent and reset transitions clear derived state ──────────

describe('telemetry consent and reset transitions', () => {
  // Feature: telemetry-phone-home, Property 2: Consent and reset transitions clear derived state
  it('leaves the accumulator empty on the current day and the queue empty on every path', () => {
    fc.assert(
      fc.property(
        counterMapArb,
        queueArb,
        metricDayArb,
        metricDayArb,
        nowArb,
        fc.integer({ min: 0, max: 9 }),
        (counters, queue, priorDay, currentDay, now, failures) => {
          const prior: TelemetryState = {
            accumulator: { metricDay: priorDay, counters, lastSealAt: now - 60_000 },
            queue,
            upload: { nextAttemptAt: now + 1, failureCount: failures, rejectedCount: failures },
          };

          // The three transitions the design says converge here: disable
          // consent, re-enable consent, reset the Install_Id.
          const disabled = resetDerivedState(currentDay, now);
          const reEnabled = resetDerivedState(currentDay, now);
          const installIdReset = resetDerivedState(currentDay, now);
          expect(reEnabled).toEqual(disabled);
          expect(installIdReset).toEqual(disabled);

          for (const next of [disabled, reEnabled, installIdReset]) {
            expect(next.queue).toEqual([]);
            expect(next.accumulator.counters).toEqual({});
            expect(counterTotal(next.accumulator)).toBe(0);
            expect(next.accumulator.metricDay).toBe(currentDay);
            expect(next.accumulator.lastSealAt).toBe(now);
            expect(next.upload).toEqual({
              nextAttemptAt: now + UPLOAD_INTERVAL_MS,
              failureCount: 0,
              rejectedCount: 0,
            });

            // Nothing derived from the pre-transition state survives.
            for (const name of Object.keys(prior.accumulator.counters)) {
              expect(name in next.accumulator.counters).toBe(false);
            }
            for (const entry of prior.queue) {
              expect(next.queue).not.toContain(entry);
            }
          }

          // Re-enabling restarts from zero rather than restoring a previous
          // accumulation: the first increment after the flip IS the total.
          const name = CATALOG_NAMES[0];
          const resumed = applyIncrement(reEnabled.accumulator, name, 3);
          expect(resumed.counters).toEqual({ [name]: 3 });
        },
      ),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 2: Consent and reset transitions clear derived state
  it('resets onto the current UTC day when the supplied day is unusable', () => {
    fc.assert(
      fc.property(junkDayArb, nowArb, (day, now) => {
        fc.pre(!isMetricDay(day));
        const next = resetDerivedState(day, now);
        expect(next.accumulator.metricDay).toBe(utcDay(now));
        expect(next.queue).toEqual([]);
        expect(next.accumulator.counters).toEqual({});
      }),
      RUNS,
    );
  });
});

// ─── Property 6: Counter accumulation is exact and monotone ─────────────────

/** One increment report, tagged at construction with whether it must count. */
interface Report {
  name: string;
  amount: number;
  counts: boolean;
}

const reportArb: fc.Arbitrary<Report> = fc.oneof(
  fc.tuple(catalogNameArb, validAmountArb).map(([name, amount]) => ({ name, amount, counts: true })),
  fc
    .tuple(nonCatalogNameArb, fc.oneof(validAmountArb, invalidAmountArb))
    .map(([name, amount]) => ({ name, amount, counts: false })),
  fc
    .tuple(catalogNameArb, invalidAmountArb)
    .map(([name, amount]) => ({ name, amount, counts: false })),
);

describe('telemetry counter accumulation', () => {
  // Feature: telemetry-phone-home, Property 6: Counter accumulation is exact and monotone
  it('sums exactly the catalog reports carrying a positive integer amount', () => {
    fc.assert(
      fc.property(
        fc.array(reportArb, { minLength: 1, maxLength: 20 }),
        metricDayArb,
        nowArb,
        (reports, day, now) => {
          // The oracle: a plain running sum over the reports the generator
          // already declared countable.
          const expected = new Map<string, number>();
          let acc = emptyAccumulator(day, now);

          for (const report of reports) {
            const before = acc;
            acc = applyIncrement(acc, report.name, report.amount);

            if (report.counts) {
              expected.set(report.name, (expected.get(report.name) ?? 0) + report.amount);
            } else {
              // A rejected report leaves the stored map exactly as it was.
              expect(acc).toEqual(before);
            }

            // Monotone: no counter ever decreases, step by step.
            for (const [name, value] of Object.entries(before.counters)) {
              expect(acc.counters[name] ?? 0).toBeGreaterThanOrEqual(value);
            }
            expect(acc.metricDay).toBe(day);
          }

          expect(acc.counters).toEqual(Object.fromEntries(expected));
          expect(counterTotal(acc)).toBe(
            [...expected.values()].reduce((total, value) => total + value, 0),
          );
        },
      ),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 6: Counter accumulation is exact and monotone
  it('defaults an omitted amount to one', () => {
    fc.assert(
      fc.property(catalogNameArb, fc.integer({ min: 1, max: 8 }), metricDayArb, nowArb, (name, times, day, now) => {
        let acc = emptyAccumulator(day, now);
        for (let i = 0; i < times; i++) acc = applyIncrement(acc, name);
        expect(acc.counters).toEqual({ [name]: times });
      }),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 6: Counter accumulation is exact and monotone
  it('leaves a hostile persisted accumulator untouched for a rejected report', () => {
    fc.assert(
      fc.property(
        taggedCounterMapArb,
        fc.oneof(
          fc.tuple(nonCatalogNameArb, fc.oneof(validAmountArb, invalidAmountArb)),
          fc.tuple(catalogNameArb, invalidAmountArb),
          fc.tuple(fc.constantFrom('__proto__', 'prototype', 'hasOwnProperty'), validAmountArb),
        ),
        metricDayArb,
        nowArb,
        (map, [name, amount], day, now) => {
          const acc = {
            metricDay: day,
            counters: map.counters,
            lastSealAt: now,
          } as unknown as Accumulator;
          const next = applyIncrement(acc, name, amount);
          expect(next).toEqual(acc);
          expect(next.counters).toEqual(acc.counters);
        },
      ),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 6: Counter accumulation is exact and monotone
  it('keeps only catalog counters with positive integer values once a report lands', () => {
    fc.assert(
      fc.property(taggedCounterMapArb, catalogNameArb, validAmountArb, metricDayArb, nowArb, (map, name, amount, day, now) => {
        const acc = {
          metricDay: day,
          counters: map.counters,
          lastSealAt: now,
        } as unknown as Accumulator;
        const next = applyIncrement(acc, name, amount);
        const expected = { ...map.expected };
        expected[name] = (expected[name] ?? 0) + amount;
        expect(next.counters).toEqual(expected);
        for (const [key, value] of Object.entries(next.counters)) {
          expect(COUNTER_CATALOG.has(key)).toBe(true);
          expect(Number.isSafeInteger(value) && value > 0).toBe(true);
        }
      }),
      RUNS,
    );
  });
});

// ─── Property 8: The Rollup field set is closed (client side) ───────────────

/** Marker planted only in fields the Rollup is not allowed to carry. */
const MARKER = 'PHORMA_LEAK_MARKER_9f3c';

const hostileEnvArb = fc
  .record(
    {
      locale: fc.oneof(fc.string(), fc.constantFrom<unknown>(null, undefined, 42, {}, [])),
      timezone: fc.oneof(fc.string(), fc.constantFrom<unknown>(null, undefined, true)),
      platform: fc.oneof(fc.string(), fc.constantFrom<unknown>(null, 7)),
      osVersion: fc.oneof(fc.string({ maxLength: 200 }), fc.constantFrom<unknown>(null, undefined)),
      appVersion: fc.oneof(fc.string(), fc.constantFrom<unknown>(null, undefined, 1)),
      runtimeMode: fc.oneof(
        fc.constantFrom<unknown>('desktop', 'browser', 'DESKTOP', 'server', '', null, undefined, 3),
        fc.string(),
      ),
      // Fields nobody declared. They must not reach the wire.
      promptText: fc.constant(`${MARKER}-prompt`),
      workflowName: fc.constant(`${MARKER}-workflow`),
      filePath: fc.constant(`${MARKER}-path`),
    },
    { requiredKeys: ['promptText', 'workflowName', 'filePath'] },
  )
  .map(env => env as unknown as ClientEnvironment);

describe('telemetry rollup seal', () => {
  // Feature: telemetry-phone-home, Property 8: The Rollup field set is closed (client side)
  it('builds exactly the declared Rollup and Client_Environment field sets', () => {
    fc.assert(
      fc.property(
        taggedCounterMapArb,
        hostileEnvArb,
        fc.oneof(installIdArb, fc.string(), fc.constant('')),
        metricDayArb,
        nowArb,
        (map, env, installId, day, now) => {
          const acc = {
            metricDay: day,
            counters: map.counters,
            lastSealAt: now,
            // An undeclared field on the accumulator must not travel either.
            notes: `${MARKER}-notes`,
          } as unknown as Accumulator;

          const rollup = sealRollup(acc, installId, env);

          expect(Object.keys(rollup).sort()).toEqual([...ROLLUP_KEYS].sort());
          expect(Object.keys(rollup.env).sort()).toEqual([...ENV_KEYS].sort());
          expect(rollup.installId).toBe(installId);
          expect(rollup.metricDay).toBe(day);
          expect(rollup.schemaVersion).toBe(TELEMETRY_SCHEMA_VERSION);
          expect(rollup.counters).toEqual(map.expected);

          for (const [key, value] of Object.entries(rollup.counters)) {
            expect(COUNTER_CATALOG.has(key)).toBe(true);
            expect(Number.isSafeInteger(value) && value > 0).toBe(true);
          }
          for (const key of ENV_KEYS) {
            const value = rollup.env[key];
            expect(typeof value).toBe('string');
            expect(value.length).toBeGreaterThan(0);
            expect(value.length).toBeLessThanOrEqual(64);
          }
          expect(['desktop', 'browser']).toContain(rollup.env.runtimeMode);

          // The serialized payload survives a JSON round trip with the same
          // shape, and carries no undeclared field.
          const wire = JSON.stringify(rollup);
          expect(wire).not.toContain(MARKER);
          const parsed = JSON.parse(wire) as Record<string, unknown>;
          expect(Object.keys(parsed).sort()).toEqual([...ROLLUP_KEYS].sort());
          expect(parsed).toEqual(rollup as unknown as Record<string, unknown>);
        },
      ),
      RUNS,
    );
  });
});

// ─── Property 9: A Metric_Day change seals the old day and zeroes the new one ─

describe('telemetry Metric_Day roll', () => {
  // Feature: telemetry-phone-home, Property 9: A Metric_Day change seals the old day and zeroes the new one
  it('appends the pre-roll totals for the old day and zeroes the new day', () => {
    fc.assert(
      fc.property(
        metricDayArb,
        metricDayArb,
        counterMapArb,
        queueArb,
        installIdArb,
        envArb,
        nowArb,
        (oldDay, newDay, counters, queue, installId, env, now) => {
          fc.pre(oldDay !== newDay);
          const state: TelemetryState = {
            accumulator: { metricDay: oldDay, counters, lastSealAt: now - 60_000 },
            queue,
            upload: defaultUploadState(now),
          };

          const rolled = rollDayIfNeeded(state, newDay, installId, env, now);

          // The new day starts at zero.
          expect(rolled.accumulator.metricDay).toBe(newDay);
          expect(rolled.accumulator.counters).toEqual({});
          expect(counterTotal(rolled.accumulator)).toBe(0);

          // The old day is queued exactly once, carrying the pre-roll totals.
          const sealed = rolled.queue.filter(
            entry => entry.rollup.metricDay === oldDay && entry.rollup.installId === installId,
          );
          expect(sealed.length).toBe(1);
          expect(sealed[0].sealedAt).toBe(now);
          expect(sealed[0].rollup.counters).toEqual(counters);
          expect(sumValues(sealed[0].rollup.counters)).toBe(sumValues(counters));

          // Every other queued day survives the roll untouched.
          const untouched = queue.filter(entry => pairOf(entry) !== pairOf(sealed[0]));
          for (const entry of untouched) expect(rolled.queue).toContain(entry);
        },
      ),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 9: A Metric_Day change seals the old day and zeroes the new one
  it('does nothing while the accumulator is already on the current day', () => {
    fc.assert(
      fc.property(metricDayArb, counterMapArb, queueArb, installIdArb, envArb, nowArb, (day, counters, queue, installId, env, now) => {
        const state: TelemetryState = {
          accumulator: { metricDay: day, counters, lastSealAt: now },
          queue,
          upload: defaultUploadState(now),
        };
        expect(rollDayIfNeeded(state, day, installId, env, now)).toEqual(state);
      }),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 9: A Metric_Day change seals the old day and zeroes the new one
  it('discards an accumulator carrying no usable Metric_Day rather than sealing it', () => {
    fc.assert(
      fc.property(junkDayArb, counterMapArb, queueArb, installIdArb, envArb, nowArb, (junk, counters, queue, installId, env, now) => {
        fc.pre(!isMetricDay(junk));
        const state: TelemetryState = {
          accumulator: { metricDay: junk, counters, lastSealAt: now },
          queue,
          upload: defaultUploadState(now),
        };
        const rolled = rollDayIfNeeded(state, utcDay(now), installId, env, now);
        expect(rolled.accumulator.metricDay).toBe(utcDay(now));
        expect(rolled.accumulator.counters).toEqual({});
        expect(rolled.queue).toEqual(queue);
      }),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 9: A Metric_Day change seals the old day and zeroes the new one
  it('removes exactly the uploaded Rollup on an accepted answer', () => {
    fc.assert(
      fc.property(
        fc.array(queueEntryArb, { minLength: 1, maxLength: 8 }),
        nowArb,
        fc.integer({ min: 0, max: 9 }),
        fc.integer({ min: 0, max: 9 }),
        metricDayArb,
        (queue, now, failures, rejections, day) => {
          const state: TelemetryState = {
            accumulator: emptyAccumulator(day, now),
            queue,
            upload: { nextAttemptAt: now, failureCount: failures, rejectedCount: rejections },
          };
          expect(classifyIngestStatus(200)).toBe('accepted');
          const next = applyIngestOutcome(state, 'accepted', now);

          expect(next.queue.length).toBe(queue.length - 1);
          expect(next.queue).toEqual(queue.slice(1));
          expect(next.queue.every((entry, index) => entry === queue[index + 1])).toBe(true);
          expect(next.upload.failureCount).toBe(0);
          expect(next.upload.rejectedCount).toBe(rejections);
          expect(next.upload.nextAttemptAt).toBe(now + UPLOAD_INTERVAL_MS);
          expect(next.accumulator).toEqual(state.accumulator);
        },
      ),
      RUNS,
    );
  });
});

// ─── Property 10: Rollups are cumulative-to-date ────────────────────────────

type DayOp = { kind: 'count'; name: string; amount: number } | { kind: 'advance'; ms: number };

const dayOpArb: fc.Arbitrary<DayOp> = fc.oneof(
  fc
    .tuple(catalogNameArb, validAmountArb)
    .map(([name, amount]) => ({ kind: 'count' as const, name, amount })),
  fc
    .constantFrom(
      0,
      60_000,
      INTERIM_SEAL_INTERVAL_MS / 2,
      INTERIM_SEAL_INTERVAL_MS - 1,
      INTERIM_SEAL_INTERVAL_MS,
      INTERIM_SEAL_INTERVAL_MS + 1_000,
      2 * INTERIM_SEAL_INTERVAL_MS,
    )
    .map(ms => ({ kind: 'advance' as const, ms })),
);

describe('telemetry cumulative seals', () => {
  // Feature: telemetry-phone-home, Property 10: Rollups are cumulative-to-date, so the latest supersedes every earlier one
  it('carries the full-day totals in the latest seal and keeps accumulating after an interim seal', () => {
    fc.assert(
      fc.property(
        fc.array(dayOpArb, { minLength: 1, maxLength: 14 }),
        metricDayArb,
        installIdArb,
        envArb,
        nowArb,
        (ops, day, installId, env, start) => {
          let now = start;
          let state: TelemetryState = {
            accumulator: emptyAccumulator(day, now),
            queue: [],
            upload: defaultUploadState(now),
          };

          // Independent model: running totals, plus the instant of the last seal.
          const totals = new Map<string, number>();
          let modelLastSeal = now;
          const sealedSnapshots: Record<string, number>[] = [];

          for (const op of ops) {
            if (op.kind === 'count') {
              state = { ...state, accumulator: applyIncrement(state.accumulator, op.name, op.amount) };
              totals.set(op.name, (totals.get(op.name) ?? 0) + op.amount);
            } else {
              now += op.ms;
              const total = [...totals.values()].reduce((sum, value) => sum + value, 0);
              const sealDue = now - modelLastSeal >= INTERIM_SEAL_INTERVAL_MS && total > 0;

              state = sealInterimIfDue(state, installId, env, now);

              expect(state.accumulator.lastSealAt !== modelLastSeal).toBe(sealDue);
              if (sealDue) {
                modelLastSeal = now;
                sealedSnapshots.push(Object.fromEntries(totals));
                // The accumulator is retained, so the day keeps accumulating.
                expect(state.accumulator.counters).toEqual(Object.fromEntries(totals));
                expect(state.accumulator.metricDay).toBe(day);
              }
            }

            // The day is never queued twice: the newest seal supersedes.
            const forDay = state.queue.filter(
              entry => entry.rollup.installId === installId && entry.rollup.metricDay === day,
            );
            expect(forDay.length).toBeLessThanOrEqual(1);
          }

          // The queued Rollup is the most recent seal, and it carries the
          // cumulative totals reported up to that seal.
          const queued = state.queue.filter(
            entry => entry.rollup.installId === installId && entry.rollup.metricDay === day,
          );
          if (sealedSnapshots.length === 0) {
            expect(queued.length).toBe(0);
          } else {
            expect(queued.length).toBe(1);
            expect(queued[0].sealedAt).toBe(modelLastSeal);
            expect(queued[0].rollup.counters).toEqual(sealedSnapshots[sealedSnapshots.length - 1]);
          }

          // Each seal supersedes the one before it: totals never decrease.
          for (let i = 1; i < sealedSnapshots.length; i++) {
            for (const [name, value] of Object.entries(sealedSnapshots[i - 1])) {
              expect(sealedSnapshots[i][name] ?? 0).toBeGreaterThanOrEqual(value);
            }
          }

          // A further increment after the last seal still lands on the retained
          // accumulator rather than on a zeroed one.
          const name = CATALOG_NAMES[1];
          const resumed = applyIncrement(state.accumulator, name, 2);
          expect(resumed.counters[name]).toBe((totals.get(name) ?? 0) + 2);
        },
      ),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 10: Rollups are cumulative-to-date, so the latest supersedes every earlier one
  it('never seals an empty day, however long it has been idle', () => {
    fc.assert(
      fc.property(metricDayArb, installIdArb, envArb, nowArb, fc.integer({ min: 1, max: 40 }), (day, installId, env, start, days) => {
        const state: TelemetryState = {
          accumulator: emptyAccumulator(day, start),
          queue: [],
          upload: defaultUploadState(start),
        };
        const later = sealInterimIfDue(state, installId, env, start + days * DAY_MS);
        expect(later).toEqual(state);
      }),
      RUNS,
    );
  });
});

// ─── Property 11: Upload queue invariants ───────────────────────────────────

/**
 * An independent queue model: drop any entry sharing the incoming pair, append,
 * then evict one entry at a time by scanning for the smallest seal time. It never
 * sorts, so it agrees with the module only if both implement the same rule.
 */
function modelAppend(queue: readonly QueueEntry[], entry: QueueEntry, cap: number): QueueEntry[] {
  const next = queue.filter(existing => pairOf(existing) !== pairOf(entry));
  next.push(entry);
  while (next.length > cap) {
    let victim = 0;
    for (let i = 1; i < next.length; i++) {
      if (sealTime(next[i]) < sealTime(next[victim])) victim = i;
    }
    next.splice(victim, 1);
  }
  return next;
}

/** Queue entries drawn from a pool wide enough to overflow the cap of 30. */
const appendEntryArb: fc.Arbitrary<QueueEntry> = fc.record({
  sealedAt: fc.oneof(
    fc.integer({ min: -5_000, max: 5_000 }),
    fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.5),
  ),
  rollup: fc.record({
    installId: fc.constantFrom(...['a', 'b', 'c'].map(c => `${c.repeat(8)}-bbbb-4ccc-8ddd-eeeeeeeeeeee`)),
    metricDay: fc.integer({ min: 0, max: 19 }).map(offset => utcDay(BASE_DAY_MS + offset * DAY_MS)),
    env: envArb,
    counters: counterMapArb,
    schemaVersion: fc.constant(TELEMETRY_SCHEMA_VERSION),
  }),
});

describe('telemetry upload queue', () => {
  // Feature: telemetry-phone-home, Property 11: Upload queue invariants
  it('caps at 30, holds one entry per install and day, and evicts the oldest seal', () => {
    fc.assert(
      // 60 appends over a pool of 60 distinct pairs, so the cap of 30 is
      // routinely exceeded and eviction is actually exercised.
      fc.property(fc.array(appendEntryArb, { minLength: 1, maxLength: 60 }), generated => {
        // Distinct references, so identity comparisons below mean what they say.
        const entries = generated.map(entry => ({ sealedAt: entry.sealedAt, rollup: entry.rollup }));
        let queue: QueueEntry[] = [];
        let model: QueueEntry[] = [];
        const appended: QueueEntry[] = [];

        for (const entry of entries) {
          const before = queue;
          queue = appendToQueue(queue, entry);
          model = modelAppend(model, entry, QUEUE_CAP);
          appended.push(entry);

          expect(queue).toEqual(model);
          expect(queue.length).toBeLessThanOrEqual(QUEUE_CAP);

          // One entry per (installId, metricDay), and it is the one just
          // appended for that pair.
          const pairs = queue.map(pairOf);
          expect(new Set(pairs).size).toBe(pairs.length);
          expect(queue.filter(e => e === entry).length).toBe(1);

          // Eviction takes the oldest by seal time: nothing dropped is newer
          // than anything kept.
          const kept = new Set(queue);
          const superseded = before.filter(e => pairOf(e) === pairOf(entry));
          const evictedByCap = [...before, entry].filter(
            e => !kept.has(e) && !superseded.includes(e),
          );
          expect(evictedByCap.length).toBeLessThanOrEqual(1);
          for (const evicted of evictedByCap) {
            for (const survivor of queue) {
              expect(sealTime(evicted)).toBeLessThanOrEqual(sealTime(survivor));
            }
          }

          // Nothing is invented, and the surviving order follows append order.
          const order = queue.map(e => appended.indexOf(e));
          expect(order.every(index => index >= 0)).toBe(true);
          expect([...order].sort((a, b) => a - b)).toEqual(order);
        }
      }),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 11: Upload queue invariants
  it('keeps every distinct day when a repeated seal for one day arrives at the cap', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5_000 }), { minLength: QUEUE_CAP, maxLength: QUEUE_CAP }),
        fc.integer({ min: 0, max: QUEUE_CAP - 1 }),
        nowArb,
        envArb,
        (sealTimes, repeatIndex, now, env) => {
          // A full queue of 30 distinct (installId, metricDay) pairs.
          const full = sealTimes.map((sealedAt, index) =>
            sealEntry(
              {
                installId: `1111111${index % 10}-2222-4333-9444-555555555555`,
                metricDay: utcDay(BASE_DAY_MS + index * DAY_MS),
                env,
                counters: {},
                schemaVersion: TELEMETRY_SCHEMA_VERSION,
              },
              sealedAt,
            ),
          );
          let queue: QueueEntry[] = [];
          for (const entry of full) queue = appendToQueue(queue, entry);
          expect(queue.length).toBe(QUEUE_CAP);

          const repeated = queue[repeatIndex];
          const others = queue.filter(entry => entry !== repeated);
          const resealed = sealEntry(repeated.rollup, now);
          const next = appendToQueue(queue, resealed);

          // Dedupe runs before the cap, so a repeated seal for one day never
          // evicts a genuinely distinct older day.
          expect(next.length).toBe(QUEUE_CAP);
          for (const other of others) expect(next).toContain(other);
          expect(next).toContain(resealed);
          expect(next.filter(entry => pairOf(entry) === pairOf(resealed)).length).toBe(1);
          expect(next.map(pairOf).sort()).toEqual(queue.map(pairOf).sort());

          // A genuinely NEW day at the cap does evict, and it takes the oldest
          // seal rather than the head of the array.
          const fresh = sealEntry(
            {
              installId: '99999999-2222-4333-9444-555555555555',
              metricDay: utcDay(BASE_DAY_MS + (QUEUE_CAP + 5) * DAY_MS),
              env,
              counters: {},
              schemaVersion: TELEMETRY_SCHEMA_VERSION,
            },
            now,
          );
          const capped = appendToQueue(queue, fresh);
          expect(capped.length).toBe(QUEUE_CAP);
          expect(capped).toContain(fresh);
          const oldest = Math.min(...queue.map(sealTime));
          const survivors = new Set(capped);
          const evicted = queue.filter(entry => !survivors.has(entry));
          expect(evicted.length).toBe(1);
          expect(sealTime(evicted[0])).toBe(oldest);
        },
      ),
      RUNS,
    );
  });
});

// ─── Property 12: Ingest status classification ──────────────────────────────

/** The partition the requirements describe, written out independently. */
function expectedOutcome(status: number): IngestOutcome {
  if (status === 200) return 'accepted';
  if (status >= 400 && status <= 499 && status !== 429) return 'rejected';
  return 'retry';
}

const statusArb = fc.oneof(
  fc.integer({ min: 100, max: 599 }),
  fc.constantFrom(0, 200, 204, 301, 399, 400, 401, 418, 428, 429, 430, 499, 500, 503, 599, 600, 999, -1),
  fc.integer({ min: -1_000, max: 1_000 }),
);

describe('telemetry ingest status classification', () => {
  // Feature: telemetry-phone-home, Property 12: Ingest status classification partitions the status space
  it('classifies every status into exactly one outcome', () => {
    fc.assert(
      fc.property(statusArb, status => {
        const outcome = classifyIngestStatus(status);
        expect(outcome).toBe(expectedOutcome(status));
        expect(['accepted', 'retry', 'rejected']).toContain(outcome);
      }),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 12: Ingest status classification partitions the status space
  it('retains the Rollup on retry and drops it on rejection, counting rejections once', () => {
    fc.assert(
      fc.property(
        statusArb,
        fc.array(queueEntryArb, { minLength: 1, maxLength: 6 }),
        nowArb,
        fc.integer({ min: 0, max: 9 }),
        fc.integer({ min: 0, max: 9 }),
        metricDayArb,
        (status, queue, now, failures, rejections, day) => {
          const state: TelemetryState = {
            accumulator: emptyAccumulator(day, now),
            queue,
            upload: { nextAttemptAt: now, failureCount: failures, rejectedCount: rejections },
          };
          const outcome = classifyIngestStatus(status);
          const next = applyIngestOutcome(state, outcome, now);

          if (outcome === 'retry') {
            expect(next.queue).toEqual(queue);
            expect(next.upload.failureCount).toBe(failures + 1);
            expect(next.upload.rejectedCount).toBe(rejections);
            expect(next.upload.nextAttemptAt).toBe(now + expectedBackoff(failures + 1));
          } else {
            expect(next.queue).toEqual(queue.slice(1));
            expect(next.upload.failureCount).toBe(0);
            expect(next.upload.nextAttemptAt).toBe(now + UPLOAD_INTERVAL_MS);
            expect(next.upload.rejectedCount).toBe(rejections + (outcome === 'rejected' ? 1 : 0));
          }
        },
      ),
      RUNS,
    );
  });
});

// ─── Property 13: Retry backoff is bounded and monotone ─────────────────────

/** `15 min * 2^(n - 1)` capped at 24 hours, derived by doubling rather than `**`. */
function expectedBackoff(failureCount: number): number {
  const failures = Number.isFinite(failureCount) ? Math.max(0, Math.floor(failureCount)) : 0;
  if (failures === 0) return UPLOAD_INTERVAL_MS;
  let wait = UPLOAD_INTERVAL_MS;
  for (let step = 1; step < failures; step++) {
    wait *= 2;
    if (wait >= MAX_BACKOFF_MS) return MAX_BACKOFF_MS;
  }
  return wait;
}

const failureCountArb = fc.oneof(
  fc.integer({ min: 0, max: 40 }),
  fc.integer({ min: -50, max: 50 }),
  fc.constantFrom(0, 1, 7, 8, 1e6, Number.MAX_SAFE_INTEGER, -1, -0.5, 0.5, 1.9, 2.999),
  fc.double({ min: -10, max: 60, noNaN: true, noDefaultInfinity: true }),
);

describe('telemetry retry backoff', () => {
  // Feature: telemetry-phone-home, Property 13: Retry backoff is bounded and monotone
  it('equals the capped doubling curve and stays inside 15 minutes to 24 hours', () => {
    fc.assert(
      fc.property(failureCountArb, failures => {
        const wait = backoffMs(failures);
        expect(wait).toBe(expectedBackoff(failures));
        expect(Number.isFinite(wait)).toBe(true);
        expect(wait).toBeGreaterThanOrEqual(UPLOAD_INTERVAL_MS);
        expect(wait).toBeLessThanOrEqual(MAX_BACKOFF_MS);
      }),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 13: Retry backoff is bounded and monotone
  it('is monotone non-decreasing in the failure count', () => {
    fc.assert(
      fc.property(failureCountArb, failureCountArb, (a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        expect(backoffMs(low)).toBeLessThanOrEqual(backoffMs(high));
      }),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 13: Retry backoff is bounded and monotone
  it('treats a non-finite failure count as a clean record', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        failures => {
          expect(backoffMs(failures)).toBe(UPLOAD_INTERVAL_MS);
        },
      ),
      RUNS,
    );
  });
});

// ─── Property 16: Rollups leave the machine over HTTPS only ─────────────────

const SCHEMES = ['https:', 'http:', 'ftp:', 'ws:', 'wss:', 'file:', 'HTTP:', 'HTTPS:'];
const HOSTS = [
  'localhost',
  'LOCALHOST',
  '127.0.0.1',
  '127.0.0.2',
  '0.0.0.0',
  '[::1]',
  'example.com',
  'api.phorma.dev',
  'localhost.evil.com',
  'notlocalhost',
];

const baseUrlArb = fc.oneof(
  fc
    .tuple(
      fc.constantFrom(...SCHEMES),
      fc.constantFrom(...HOSTS),
      fc.option(fc.constantFrom(':7322', ':8787', ':443'), { nil: '' }),
      fc.constantFrom('', '/', '//', '/api', '/api/', '/api//', '/nested/path'),
    )
    .map(([scheme, host, port, path]) => `${scheme}//${host}${port}${path}`),
  fc.constantFrom('', '   ', 'phorma.dev', '//phorma.dev', 'javascript:alert(1)', 'data:text/plain,x'),
  fc.string(),
  fc.webUrl(),
);

describe('telemetry ingest URL', () => {
  // Feature: telemetry-phone-home, Property 16: Rollups leave the machine over HTTPS only
  it('resolves to an HTTPS ingest URL, a local http exception, or nothing at all', () => {
    fc.assert(
      fc.property(baseUrlArb, base => {
        const resolved = resolveIngestUrl(base);
        if (resolved === null) return;

        const url = new URL(resolved);
        expect(url.pathname.endsWith('/telemetry')).toBe(true);
        if (url.protocol === 'http:') {
          // The only documented exception, and it is exact rather than a suffix
          // or substring match.
          expect(LOCAL_INGEST_HOSTNAMES).toContain(url.hostname);
        } else {
          expect(url.protocol).toBe('https:');
        }
      }),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 16: Rollups leave the machine over HTTPS only
  it('accepts exactly https, plus http on localhost and 127.0.0.1', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SCHEMES),
        fc.constantFrom(...HOSTS),
        fc.constantFrom('', '/', '/api', '/api/'),
        (scheme, host, path) => {
          const base = `${scheme}//${host}${path}`;
          const resolved = resolveIngestUrl(base);
          const normalizedScheme = scheme.toLowerCase();
          const isLocal = LOCAL_INGEST_HOSTNAMES.includes(host.toLowerCase());
          const allowed =
            normalizedScheme === 'https:' || (normalizedScheme === 'http:' && isLocal);

          expect(resolved === null).toBe(!allowed);
          if (allowed) {
            // Independent construction of the expected URL.
            const parsed = new URL(base);
            const trimmedPath = parsed.pathname.replace(/\/+$/, '');
            expect(resolved).toBe(`${parsed.origin}${trimmedPath}/telemetry`);
          }
        },
      ),
      RUNS,
    );
  });

  it('decides the same way for every scheme and host pair, exhaustively', () => {
    // The random property above samples this space; this walks all of it, so a
    // substring or suffix host match cannot slip through unsampled.
    for (const scheme of SCHEMES) {
      for (const host of HOSTS) {
        const allowed =
          scheme.toLowerCase() === 'https:' ||
          (scheme.toLowerCase() === 'http:' && LOCAL_INGEST_HOSTNAMES.includes(host.toLowerCase()));
        expect(resolveIngestUrl(`${scheme}//${host}/api`) === null).toBe(!allowed);
      }
    }
  });

  it('never throws and never downgrades for arbitrary input', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.webUrl(), baseUrlArb), base => {
        const resolved = resolveIngestUrl(base);
        if (resolved === null) return;
        const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(resolved);
        expect(resolved.startsWith('https://') || local).toBe(true);
      }),
      RUNS,
    );
  });

  it('agrees with independent UTC day arithmetic for any sane instant', () => {
    fc.assert(
      fc.property(nowArb, now => {
        expect(metricDayUtc(now)).toBe(utcDay(now));
        expect(metricDayUtc(new Date(now))).toBe(utcDay(now));
        expect(isMetricDay(metricDayUtc(now))).toBe(true);
      }),
      RUNS,
    );
  });
});
