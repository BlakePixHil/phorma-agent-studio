/**
 * Properties 3, 4, 14 and 15 for `TelemetryService`, plus example tests for the
 * scheduling and environment branches.
 *
 * Nothing real is involved: the service exposes `TELEMETRY_TEST_SEAM`, which
 * substitutes the clock, the storage backend, `fetch`, the idle callback and the
 * timer, and hands back direct control of the two async bodies. So every test
 * here drives initialization and individual ticks to completion with no real
 * `localStorage`, no real network, no real timer and no waiting.
 *
 * The claims are about the SERVICE rather than the pure core (which
 * `telemetry-core.spec.ts` covers): what it writes, what it sends, where it
 * sends it, and what it never does. Two of them are structural claims proven by
 * absence - the service injects neither `ToastService` nor
 * `TerminalOutputService`, so both are injected HERE and spied on, and a call
 * would have to appear on one of those spies for the silence claim to fail.
 */

import { TestBed } from '@angular/core/testing';
import fc from 'fast-check';

import { ToastService } from '../shared/toast/toast.service';
import { TauriService } from './tauri.service';
import { TerminalOutputService } from './terminal-output.service';
import { loadPhormaCloudUrl } from './phorma-cloud-url';
import {
  COUNTER_CATALOG,
  CURRENT_DISCLOSURE_VERSION,
  ERROR_CATEGORIES,
  type ErrorCategory,
  counterName,
} from './telemetry-catalog';
import {
  UNKNOWN_ENV_VALUE,
  backoffMs,
  resolveIngestUrl,
  type Rollup,
} from './telemetry-core';
import {
  TELEMETRY_STORAGE_PREFIX,
  type TelemetryStorageBackend,
  type TelemetryStorageKey,
} from './telemetry-storage';
import {
  TELEMETRY_TEST_SEAM,
  TELEMETRY_TICK_INTERVAL_MS,
  TELEMETRY_UPLOAD_TIMEOUT_MS,
  TelemetryService,
  type TelemetryFetch,
  type TelemetryHarness,
  type TelemetryUploadRequest,
} from './telemetry.service';

/** Minimum iterations for every property in this suite. */
const RUNS = { numRuns: 120 };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A fixed, comfortably mid-day UTC instant, so a day roll needs a real advance. */
const START_MS = Date.UTC(2026, 4, 12, 9, 30, 0);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The Phorma Cloud override, cleared per test so the ingest URL is deterministic. */
const CLOUD_URL_KEY = 'phorma.layout.phormaCloudUrl';

// ─── Fakes ──────────────────────────────────────────────────────────────────

/**
 * A `Map`-backed storage backend that logs every write and removal, and can be
 * told to throw on a chosen read or on every write.
 */
class FakeStorage implements TelemetryStorageBackend {
  readonly entries = new Map<string, string>();
  readonly writes: { key: string; value: string }[] = [];
  readonly removals: string[] = [];
  readonly failedReads = new Set<string>();
  failWrites = false;

  getItem(key: string): string | null {
    if (this.failedReads.has(key)) throw new Error('storage read denied');
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('storage write denied');
    this.writes.push({ key, value });
    this.entries.set(key, value);
  }

  removeItem(key: string): void {
    this.removals.push(key);
    this.entries.delete(key);
  }

  /** Pre-populates a telemetry key, without logging it as a service write. */
  seed(key: TelemetryStorageKey, value: unknown): void {
    this.entries.set(TELEMETRY_STORAGE_PREFIX + key, JSON.stringify(value));
  }

  read<T>(key: TelemetryStorageKey): T | null {
    const raw = this.entries.get(TELEMETRY_STORAGE_PREFIX + key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }

  failReadOf(key: TelemetryStorageKey): void {
    this.failedReads.add(TELEMETRY_STORAGE_PREFIX + key);
  }

  clearLog(): void {
    this.writes.length = 0;
    this.removals.length = 0;
  }
}

/**
 * The only service `TelemetryService` injects. `isDesktop` is a getter so a test
 * can make environment resolution - the one initialization step with no local
 * guard - throw.
 */
class TauriStub {
  isDesktopValue = false;
  isDesktopThrows = false;
  osVersionImpl: () => Promise<string> = () => Promise.resolve('stub-os 1.0');

  get isDesktop(): boolean {
    if (this.isDesktopThrows) throw new Error('tauri bridge unavailable');
    return this.isDesktopValue;
  }

  osVersion(): Promise<string> {
    return this.osVersionImpl();
  }
}

interface RecordedRequest {
  url: string;
  init: TelemetryUploadRequest;
}

interface RigOptions {
  storage?: FakeStorage;
  start?: number;
  randomUuid?: () => string;
  respond?: TelemetryFetch;
  failClock?: boolean;
  failTimer?: boolean;
}

interface Rig {
  service: TelemetryService;
  harness: TelemetryHarness;
  storage: FakeStorage;
  requests: RecordedRequest[];
  idle: Array<() => void>;
  timers: Array<{ run: () => void; delayMs: number }>;
  now: () => number;
  advance: (ms: number) => void;
}

let uuidCounter = 0;

/** A deterministic, well formed UUID v4 for the `randomUuid` seam. */
function stubUuid(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${uuidCounter.toString(16).padStart(12, '0')}`;
}

/**
 * A fresh service instance with every runtime edge substituted. Instances are
 * built with `new` inside an injection context rather than through
 * `TestBed.inject`, so one test can restart the service against the same storage
 * as many times as it likes.
 */
function createRig(options: RigOptions = {}): Rig {
  const storage = options.storage ?? new FakeStorage();
  const requests: RecordedRequest[] = [];
  const idle: Array<() => void> = [];
  const timers: Array<{ run: () => void; delayMs: number }> = [];
  let clock = options.start ?? START_MS;
  const respond: TelemetryFetch = options.respond ?? (() => Promise.resolve({ status: 200 }));

  const service = TestBed.runInInjectionContext(() => new TelemetryService());
  const harness = service[TELEMETRY_TEST_SEAM]({
    now: () => {
      if (options.failClock === true) throw new Error('clock unavailable');
      return clock;
    },
    fetch: (url, init) => {
      requests.push({ url, init });
      return respond(url, init);
    },
    scheduleIdle: (run) => {
      idle.push(run);
    },
    setTimer: (run, delayMs) => {
      if (options.failTimer === true) throw new Error('timer unavailable');
      timers.push({ run, delayMs });
      return timers.length;
    },
    randomUuid: options.randomUuid ?? stubUuid,
    storageBackend: storage,
  });

  return {
    service,
    harness,
    storage,
    requests,
    idle,
    timers,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
  };
}

// ─── Operation script ───────────────────────────────────────────────────────

type Op =
  | { kind: 'count'; name: string; amount: number }
  | { kind: 'error'; category: ErrorCategory }
  | { kind: 'tick' }
  | { kind: 'advance'; ms: number };

const CATALOG_NAMES = [...COUNTER_CATALOG].sort();
const catalogNameArb = fc.constantFrom(...CATALOG_NAMES);

/** Names that are not in the catalog, including near misses. */
const junkNameArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 24 }),
  fc.constantFrom(
    '',
    'run.started ',
    'RUN.STARTED',
    'node.created',
    'error:',
    'session.started:extra',
    '__proto__',
    'toString',
  ),
  catalogNameArb.map((name) => `${name}:extra`),
);

const amountArb = fc.oneof(
  fc.integer({ min: 1, max: 50 }),
  fc.constantFrom(0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2),
);

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('count' as const),
    name: fc.oneof(
      { weight: 3, arbitrary: catalogNameArb },
      { weight: 1, arbitrary: junkNameArb },
    ),
    amount: amountArb,
  }),
  fc.record({
    kind: fc.constant('error' as const),
    category: fc.constantFrom(...ERROR_CATEGORIES),
  }),
  fc.record({ kind: fc.constant('tick' as const) }),
  fc.record({
    kind: fc.constant('advance' as const),
    ms: fc.integer({ min: 0, max: 30 * HOUR_MS }),
  }),
);

const opsArb = fc.array(opArb, { minLength: 1, maxLength: 14 });

async function runOps(rig: Rig, ops: readonly Op[]): Promise<void> {
  for (const op of ops) {
    if (op.kind === 'count') rig.service.count(op.name, op.amount);
    else if (op.kind === 'error') rig.service.recordError(op.category);
    else if (op.kind === 'advance') rig.advance(op.ms);
    else await rig.harness.tick();
  }
}

/** Every telemetry key the service could have touched. */
function telemetryWrites(storage: FakeStorage): string[] {
  return storage.writes
    .map((entry) => entry.key)
    .filter((key) => key.startsWith(TELEMETRY_STORAGE_PREFIX));
}

describe('TelemetryService', () => {
  let tauriStub: TauriStub;
  let toast: ToastService;
  let terminal: TerminalOutputService;
  let toastShow: jasmine.Spy;
  let terminalAppend: jasmine.Spy;
  let savedCloudUrl: string | null;
  let ingestUrl: string;

  beforeEach(() => {
    savedCloudUrl = localStorage.getItem(CLOUD_URL_KEY);
    localStorage.removeItem(CLOUD_URL_KEY);

    tauriStub = new TauriStub();
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: tauriStub as unknown as TauriService }],
    });

    // Injected here precisely BECAUSE the service does not inject them: a call
    // on either spy would mean telemetry found a path to the user.
    toast = TestBed.inject(ToastService);
    terminal = TestBed.inject(TerminalOutputService);
    toastShow = spyOn(toast, 'show').and.callThrough();
    terminalAppend = spyOn(terminal, 'append').and.callThrough();

    const resolved = resolveIngestUrl(loadPhormaCloudUrl());
    expect(resolved).not.toBeNull();
    ingestUrl = resolved ?? '';
  });

  afterEach(() => {
    if (savedCloudUrl !== null) localStorage.setItem(CLOUD_URL_KEY, savedCloudUrl);
  });

  // ─── Property 3 ───────────────────────────────────────────────────────────

  /**
   * Total silence while consent is off: not one storage key, not one request.
   * Both directions are covered - an install that starts disabled, and a session
   * that is disabled mid-flight while it already holds counters, a sealed Rollup
   * and an upload record.
   *
   * **Validates: Requirements 1.6, 3.7**
   */
  describe('disabled consent', () => {
    // Feature: telemetry-phone-home, Property 3: Disabled consent silences the service completely
    it('writes nothing and issues no request for any script of increments and ticks', async () => {
      await fc.assert(
        fc.asyncProperty(opsArb, fc.integer({ min: 0, max: 4 }), async (ops, staleVersions) => {
          const storage = new FakeStorage();
          storage.seed('consent', {
            enabled: false,
            disclosureVersion: CURRENT_DISCLOSURE_VERSION - staleVersions,
            decidedAt: '2026-01-01T00:00:00.000Z',
          });
          const rig = createRig({ storage });

          await rig.harness.initialize();

          // The disclosure record is the ONLY thing a disabled install may
          // persist during initialization: no install id, no accumulator, no
          // queue, no upload record.
          expect(
            telemetryWrites(storage).every((key) => key === `${TELEMETRY_STORAGE_PREFIX}consent`),
          ).toBeTrue();
          expect(rig.service.enabled()).toBeFalse();
          storage.clearLog();

          await runOps(rig, ops);

          expect(storage.writes.length).toBe(0);
          expect(storage.removals.length).toBe(0);
          expect(rig.requests.length).toBe(0);
          expect(rig.harness.state().accumulator.counters).toEqual({});
          expect(rig.harness.state().queue).toEqual([]);
          expect(rig.service.pendingRollup()).toBeNull();
        }),
        RUNS,
      );
    });

    // Feature: telemetry-phone-home, Property 3: Disabled consent silences the service completely
    it('goes silent from the moment the toggle flips, discarding what it had', async () => {
      await fc.assert(
        fc.asyncProperty(opsArb, async (ops) => {
          const rig = createRig();
          await rig.harness.initialize();

          // An enabled session that has something to lose: counters, a sealed
          // Rollup in the queue, and at least one upload attempt.
          rig.service.count('run.started', 3);
          rig.service.recordError('network');
          rig.advance(7 * HOUR_MS);
          await rig.harness.tick();
          expect(rig.requests.length).toBeGreaterThan(0);

          rig.service.setEnabled(false);

          // Requirement 1.5: discarded inside the same interaction.
          expect(rig.harness.state().accumulator.counters).toEqual({});
          expect(rig.harness.state().queue).toEqual([]);
          expect(rig.storage.removals).toContain(`${TELEMETRY_STORAGE_PREFIX}accumulator`);
          expect(rig.storage.removals).toContain(`${TELEMETRY_STORAGE_PREFIX}queue`);
          expect(rig.storage.removals).toContain(`${TELEMETRY_STORAGE_PREFIX}upload`);

          const requestsBefore = rig.requests.length;
          rig.storage.clearLog();

          await runOps(rig, ops);

          expect(rig.storage.writes.length).toBe(0);
          expect(rig.storage.removals.length).toBe(0);
          expect(rig.requests.length).toBe(requestsBefore);
          expect(rig.harness.state().accumulator.counters).toEqual({});
          expect(rig.harness.state().queue).toEqual([]);
        }),
        RUNS,
      );
    });
  });

  // ─── Property 4 ───────────────────────────────────────────────────────────

  /**
   * One UUID v4 per install, persisted under the `phorma.telemetry.` prefix,
   * reused across restarts, stamped on every Rollup, and sent to exactly one
   * destination. The `randomUuid` seam is deliberately hostile (junk, empty, a v1
   * shape, a throw) because the shape claim must hold through the fallback too.
   *
   * **Validates: Requirements 2.1, 2.2, 2.5**
   */
  describe('install identity', () => {
    // Feature: telemetry-phone-home, Property 4: Install identity is a stable UUID v4 that travels only to the ingest endpoint
    it('mints a UUID v4 under a phorma.telemetry key and reuses it across restarts', async () => {
      const hostileUuidArb = fc.oneof(
        fc.constant<(() => string) | null>(null),
        fc.constant(() => 'not-a-uuid'),
        fc.constant(() => ''),
        fc.constant(() => {
          throw new Error('no secure random source');
        }),
        fc.constant(() => '00000000-0000-1000-8000-000000000000'),
      );

      await fc.assert(
        fc.asyncProperty(
          hostileUuidArb,
          fc.integer({ min: 1, max: 4 }),
          async (randomUuid, restarts) => {
            const storage = new FakeStorage();
            const ids: string[] = [];

            for (let restart = 0; restart < restarts; restart += 1) {
              const rig = createRig({
                storage,
                randomUuid: randomUuid ?? undefined,
                start: START_MS + restart * DAY_MS,
              });
              await rig.harness.initialize();
              ids.push(rig.service.installId());
            }

            // Requirement 2.1: a UUID v4, however hostile the seam, because the
            // service falls back to its own CSPRNG derivation.
            expect(ids.every((id) => UUID_V4.test(id))).toBeTrue();
            // Requirement 2.2: one identity for the install, not one per start.
            expect(new Set(ids).size).toBe(1);
            expect(storage.read<string>('installId')).toBe(ids[0]);
            expect(
              [...storage.entries.keys()].every((key) =>
                key.startsWith(TELEMETRY_STORAGE_PREFIX),
              ),
            ).toBeTrue();
          },
        ),
        RUNS,
      );
    });

    // Feature: telemetry-phone-home, Property 4: Install identity is a stable UUID v4 that travels only to the ingest endpoint
    it('stamps every Rollup with that id and aims every request at the ingest endpoint', async () => {
      const statusArb = fc.constantFrom(200, 204, 400, 413, 429, 500, 503);

      await fc.assert(
        fc.asyncProperty(
          opsArb,
          fc.array(statusArb, { minLength: 1, maxLength: 6 }),
          async (ops, statuses) => {
            let attempt = 0;
            const rig = createRig({
              respond: () => {
                const status = statuses[attempt % statuses.length];
                attempt += 1;
                return Promise.resolve({ status });
              },
            });
            await rig.harness.initialize();
            const installId = rig.service.installId();
            expect(UUID_V4.test(installId)).toBeTrue();

            // Guarantee at least one seal and one attempt on top of the script.
            rig.service.count('session.started');
            rig.advance(7 * HOUR_MS);
            await rig.harness.tick();
            await runOps(rig, ops);

            expect(rig.harness.state().queue.every((e) => e.rollup.installId === installId))
              .toBeTrue();
            expect(rig.requests.length).toBeGreaterThan(0);
            for (const request of rig.requests) {
              // Requirement 2.5: the id travels to exactly one destination.
              expect(request.url).toBe(ingestUrl);
              expect(request.init.method).toBe('POST');
              expect(request.init.headers['Content-Type']).toBe('application/json');
              const sent = JSON.parse(request.init.body) as Rollup;
              expect(sent.installId).toBe(installId);
            }
            expect(new Set(rig.requests.map((request) => request.url)).size).toBe(1);
          },
        ),
        RUNS,
      );
    });
  });

  // ─── Property 14 ──────────────────────────────────────────────────────────

  /**
   * A failure is injected at each initialization step in turn - the consent read,
   * the install id read, the accumulator, queue and upload reads, every write,
   * `crypto.randomUUID`, the clock, the timer, and environment resolution - on top
   * of malformed values in all five persisted keys and an arbitrary sequence of
   * upload outcomes. Initialization never rejects, the toast and console spies
   * stay untouched, and a genuinely failed initialization reports itself inactive
   * and issues nothing.
   *
   * **Validates: Requirements 5.1, 5.7, 5.8**
   */
  describe('silence and startup safety', () => {
    type Injection =
      | 'none'
      | 'consent-read'
      | 'install-read'
      | 'accumulator-read'
      | 'queue-read'
      | 'upload-read'
      | 'writes'
      | 'uuid'
      | 'clock'
      | 'timer'
      | 'environment';

    const injectionArb = fc.constantFrom<Injection>(
      'none',
      'consent-read',
      'install-read',
      'accumulator-read',
      'queue-read',
      'upload-read',
      'writes',
      'uuid',
      'clock',
      'timer',
      'environment',
    );

    /** A persisted value that is unusable in some way, including invalid JSON. */
    const malformedArb = fc.oneof(
      fc.json(),
      fc.constantFrom('not json', 'null', '[]', '0', '"text"', '{"metricDay":7}'),
    );

    type Outcome = { kind: 'status'; status: number } | { kind: 'throw' };

    const outcomeArb: fc.Arbitrary<Outcome> = fc.oneof(
      fc.record({
        kind: fc.constant('status' as const),
        status: fc.integer({ min: 100, max: 599 }),
      }),
      fc.record({ kind: fc.constant('throw' as const) }),
    );

    // Feature: telemetry-phone-home, Property 14: Telemetry never addresses the user and never breaks startup
    it('never rejects, never speaks, and reports itself inactive when initialization failed', async () => {
      await fc.assert(
        fc.asyncProperty(
          injectionArb,
          fc.array(malformedArb, { minLength: 5, maxLength: 5 }),
          fc.array(outcomeArb, { minLength: 1, maxLength: 5 }),
          opsArb,
          async (injection, malformed, outcomes, ops) => {
            const storage = new FakeStorage();
            const keys: TelemetryStorageKey[] = [
              'installId',
              'consent',
              'accumulator',
              'queue',
              'upload',
            ];
            keys.forEach((key, index) => {
              storage.entries.set(TELEMETRY_STORAGE_PREFIX + key, malformed[index]);
            });

            if (injection === 'consent-read') storage.failReadOf('consent');
            if (injection === 'install-read') storage.failReadOf('installId');
            if (injection === 'accumulator-read') storage.failReadOf('accumulator');
            if (injection === 'queue-read') storage.failReadOf('queue');
            if (injection === 'upload-read') storage.failReadOf('upload');
            if (injection === 'writes') storage.failWrites = true;
            tauriStub.isDesktopThrows = injection === 'environment';

            let attempt = 0;
            const rig = createRig({
              storage,
              failClock: injection === 'clock',
              failTimer: injection === 'timer',
              randomUuid:
                injection === 'uuid'
                  ? () => {
                      throw new Error('crypto.randomUUID unavailable');
                    }
                  : undefined,
              respond: () => {
                const outcome = outcomes[attempt % outcomes.length];
                attempt += 1;
                return outcome.kind === 'throw'
                  ? Promise.reject(new TypeError('Failed to fetch'))
                  : Promise.resolve({ status: outcome.status });
              },
            });

            let rejected = false;
            await rig.harness.initialize().catch(() => {
              rejected = true;
            });
            expect(rejected).toBeFalse();

            // Requirement 5.7: a failed initialization leaves the service inactive
            // and the studio running. Environment resolution is the one step with
            // no local guard, so it is the injection that must produce it.
            if (injection === 'environment') expect(rig.service.active()).toBeFalse();

            rig.service.count('run.started', 2);
            rig.service.recordError('storage');
            rig.advance(7 * HOUR_MS);
            await runOps(rig, [...ops, { kind: 'tick' }, { kind: 'tick' }]);

            // Requirement 5.8: nothing telemetry does reaches the user, on any
            // path, for any outcome.
            expect(toastShow).not.toHaveBeenCalled();
            expect(terminalAppend).not.toHaveBeenCalled();
            expect(toast.entries().length).toBe(0);
            expect(terminal.entries().length).toBe(0);

            if (!rig.service.active()) {
              expect(rig.requests.length).toBe(0);
              expect(rig.harness.state().accumulator.counters).toEqual({});
            }
          },
        ),
        RUNS,
      );
    });

    // Feature: telemetry-phone-home, Property 14: Telemetry never addresses the user and never breaks startup
    it('retains the Rollup and raises nothing for any failing upload outcome', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(outcomeArb, { minLength: 1, maxLength: 8 }),
          async (outcomes) => {
            let attempt = 0;
            const rig = createRig({
              respond: () => {
                const outcome = outcomes[attempt % outcomes.length];
                attempt += 1;
                return outcome.kind === 'throw'
                  ? Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
                  : Promise.resolve({ status: outcome.status });
              },
            });
            await rig.harness.initialize();
            rig.service.count('run.completed');

            let rejected = false;
            for (let index = 0; index < outcomes.length; index += 1) {
              rig.advance(25 * HOUR_MS);
              await rig.harness.tick().catch(() => {
                rejected = true;
              });
            }

            expect(rejected).toBeFalse();
            expect(rig.service.active()).toBeTrue();
            expect(toastShow).not.toHaveBeenCalled();
            expect(terminalAppend).not.toHaveBeenCalled();

            // A transient outcome keeps the Rollup; a 4xx drops it and counts a
            // local rejection. Either way the queue stays bounded and quiet.
            const state = rig.harness.state();
            expect(state.queue.length).toBeLessThanOrEqual(30);
            expect(state.upload.rejectedCount).toBeGreaterThanOrEqual(0);
          },
        ),
        RUNS,
      );
    });
  });

  // ─── Property 15 ──────────────────────────────────────────────────────────

  /**
   * Unique markers are planted in prompt text, a workflow name, a node name, node
   * configuration, a connection name and a file path, plus an error message and a
   * stack frame, and then pushed through every route the public API offers:
   * `count` names, `count` dimensions, and `recordError`. Note that `recordError`
   * has no parameter a message or a stack could travel in, which is the point -
   * the casts here are the closest a caller can even get.
   *
   * **Validates: Requirements 11.1, 11.3, 11.6**
   */
  describe('content exclusion', () => {
    const markersArb = fc.uniqueArray(
      fc.uuid().map((tail) => `MARKER${tail.replace(/-/g, '').toUpperCase()}`),
      { minLength: 8, maxLength: 8 },
    );

    // Feature: telemetry-phone-home, Property 15: A Rollup carries no workflow content
    it('carries no marker from any workflow surface and no error message or stack', async () => {
      await fc.assert(
        fc.asyncProperty(
          markersArb,
          fc.constantFrom(...ERROR_CATEGORIES),
          async (markers, category) => {
            const [prompt, workflowName, nodeName, nodeConfigValue, connectionName, fileName, message, frame] =
              markers;
            const workflow = {
              promptText: `# ${prompt}\nAlways answer as ${prompt}.`,
              workflowName,
              nodeName,
              nodeConfig: { endpoint: `https://api.internal/${nodeConfigValue}`, key: nodeConfigValue },
              connectionName,
              filePath: `C:/Users/owner/Documents/${fileName}.phorma.json`,
              errorMessage: `Request failed: ${message}`,
              errorStack: `Error: ${message}\n    at handler (${frame}.ts:42:7)`,
            };

            const rig = createRig();
            await rig.harness.initialize();

            // Every route content could take through the public API. All of these
            // are outside the Counter_Catalog, so all of them are discarded.
            rig.service.count(workflow.promptText);
            rig.service.count(workflow.workflowName, 4);
            rig.service.count(workflow.filePath);
            rig.service.count(workflow.connectionName, Number.NaN);
            rig.service.count(JSON.stringify(workflow.nodeConfig));
            rig.service.count(counterName('node.created', workflow.nodeName));
            rig.service.count(counterName('panel.opened', workflow.filePath));
            rig.service.count(counterName('error', workflow.errorMessage));
            // `recordError` takes a category and nothing else, so a message or a
            // stack cast into it still resolves to a name outside the catalog.
            rig.service.recordError(workflow.errorMessage as ErrorCategory);
            rig.service.recordError(workflow.errorStack as ErrorCategory);

            // Legitimate reports, so the Rollup is not vacuously empty.
            rig.service.count('run.started', 2);
            rig.service.count(counterName('node.created', 'agent'));
            rig.service.recordError(category);

            rig.advance(7 * HOUR_MS);
            const preview = JSON.parse(JSON.stringify(rig.service.pendingRollup())) as Rollup;
            await rig.harness.tick();

            expect(rig.requests.length).toBe(1);
            const sentRaw = rig.requests[0].init.body;
            const sent = JSON.parse(sentRaw) as Rollup;

            // Requirement 11.6: the Privacy preview IS the payload.
            expect(sent).toEqual(preview);

            // Requirement 11.1 and 11.3: no marker anywhere on the wire.
            const surfaces = [sentRaw, JSON.stringify(preview), rig.requests[0].url];
            for (const marker of markers) {
              for (const surface of surfaces) {
                expect(surface.includes(marker)).toBeFalse();
              }
            }

            // Requirement 11.2: only catalog names, and error counters only ever
            // carry a member of the closed category set.
            const names = Object.keys(sent.counters);
            expect(names.length).toBeGreaterThan(0);
            for (const name of names) {
              expect(COUNTER_CATALOG.has(name)).toBeTrue();
              if (name.startsWith('error:')) {
                expect(ERROR_CATEGORIES as readonly string[]).toContain(name.slice('error:'.length));
              }
            }
            expect(sent.counters[counterName('error', category)]).toBe(1);
          },
        ),
        RUNS,
      );
    });
  });

  // ─── Scheduling and environment examples ──────────────────────────────────

  /**
   * Example tests, not properties: the non-blocking bootstrap return, the 10
   * second abort folded in as a network failure, and the desktop versus browser
   * `osVersion` branch.
   *
   * Validates: Requirements 3.8, 4.9, 5.6
   */
  describe('bootstrap scheduling', () => {
    it('returns before any awaited work and schedules initialization once', async () => {
      const rig = createRig();

      rig.service.bootstrap();

      // Requirement 4.9: nothing has happened yet. No storage write, no request,
      // no install id, and the service is not active.
      expect(rig.idle.length).toBe(1);
      expect(rig.service.active()).toBeFalse();
      expect(rig.service.installId()).toBe('');
      expect(rig.storage.writes.length).toBe(0);
      expect(rig.requests.length).toBe(0);
      expect(rig.timers.length).toBe(0);

      // Repeat calls from a second shell hook must not schedule twice.
      rig.service.bootstrap();
      expect(rig.idle.length).toBe(1);

      rig.idle[0]();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(rig.service.active()).toBeTrue();
      expect(UUID_V4.test(rig.service.installId())).toBeTrue();
      // The 60 second tick is armed only once initialization has finished.
      expect(rig.timers.length).toBe(1);
      expect(rig.timers[0].delayMs).toBe(TELEMETRY_TICK_INTERVAL_MS);
    });

    it('survives a scheduler that throws, leaving the service inactive', () => {
      const rig = createRig();
      const service = rig.service;
      service[TELEMETRY_TEST_SEAM]({
        scheduleIdle: () => {
          throw new Error('no idle callback');
        },
      });

      expect(() => service.bootstrap()).not.toThrow();
      expect(service.active()).toBeFalse();
    });
  });

  describe('upload abort', () => {
    it('treats the 10 second abort as a network failure and keeps the Rollup', async () => {
      const rig = createRig({
        respond: () => Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
      });
      await rig.harness.initialize();
      rig.service.count('run.started');

      rig.advance(7 * HOUR_MS);
      await rig.harness.tick();

      // Requirement 5.6: the deadline is a real 10 second abort signal on the
      // request, and its rejection is folded in as a transient failure.
      expect(TELEMETRY_UPLOAD_TIMEOUT_MS).toBe(10_000);
      expect(rig.requests.length).toBe(1);
      const signal = rig.requests[0].init.signal;
      expect(signal instanceof AbortSignal).toBeTrue();
      expect(signal?.aborted).toBeFalse();

      const state = rig.harness.state();
      expect(state.queue.length).toBe(1);
      expect(state.upload.failureCount).toBe(1);
      expect(state.upload.rejectedCount).toBe(0);
      expect(state.upload.nextAttemptAt).toBe(rig.now() + backoffMs(1));
    });
  });

  describe('osVersion branch', () => {
    it('reads the native version through TauriService on desktop', async () => {
      tauriStub.isDesktopValue = true;
      tauriStub.osVersionImpl = () => Promise.resolve('Windows 11 Pro (22631)');
      const rig = createRig();

      await rig.harness.initialize();

      const env = rig.harness.environment();
      expect(env?.runtimeMode).toBe('desktop');
      expect(env?.osVersion).toBe('Windows 11 Pro (22631)');
    });

    it('reads the user agent platform string in a browser', async () => {
      tauriStub.isDesktopValue = false;
      tauriStub.osVersionImpl = () => Promise.resolve('Win32');
      const rig = createRig();

      await rig.harness.initialize();

      const env = rig.harness.environment();
      expect(env?.runtimeMode).toBe('browser');
      expect(env?.osVersion).toBe('Win32');
    });

    it('falls back to unknown when the lookup rejects', async () => {
      tauriStub.isDesktopValue = true;
      tauriStub.osVersionImpl = () => Promise.reject(new Error('command not found'));
      const rig = createRig();

      await rig.harness.initialize();

      const env = rig.harness.environment();
      expect(env?.runtimeMode).toBe('desktop');
      expect(env?.osVersion).toBe(UNKNOWN_ENV_VALUE);
      expect(rig.service.active()).toBeTrue();
    });
  });
});

/**
 * The browser half of Requirement 3.8, against the REAL `TauriService`: karma
 * runs outside the desktop shell, so `isDesktop` is false and `osVersion()` must
 * resolve to the user agent platform string with no native call.
 */
describe('TauriService.osVersion in a browser', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
  });

  it('resolves the user agent platform string and caches it', async () => {
    const tauri = TestBed.inject(TauriService);
    const hint = (navigator as Navigator & { userAgentData?: { platform?: unknown } }).userAgentData
      ?.platform;
    const candidate = typeof hint === 'string' && hint.trim() ? hint : navigator.platform;
    const expected = (typeof candidate === 'string' ? candidate.trim() : '') || 'unknown';

    expect(tauri.isDesktop).toBeFalse();
    expect(await tauri.osVersion()).toBe(expected);
    expect(await tauri.osVersion()).toBe(expected);
  });
});
