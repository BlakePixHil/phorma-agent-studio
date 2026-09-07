/**
 * Anonymous usage telemetry: consent, install identity, counter accumulation,
 * daily Rollups, and the slow uploader.
 *
 * ## This service is a DI LEAF, deliberately
 *
 * It injects `TauriService` and nothing else, and it reads the ingest base URL
 * through `loadPhormaCloudUrl()`, a leaf module rather than a service. The known
 * NG0200 cycle is
 * `RunControllerService -> ModelTransportService -> PhormaCloudService ->
 * CloudService -> RunControllerService`, and three of those services are counter
 * call sites: any of them may inject this service, so this service may inject
 * none of them. It also injects no `ToastService` and no console service, which
 * is how "telemetry never addresses the user" is enforced structurally rather
 * than by convention, and nothing on the usage path, which is how "telemetry
 * never reads the credit or usage stores" is enforced the same way.
 *
 * `scripts/check-telemetry-isolation.mjs` asserts the import list of this file
 * stays inside `{telemetry-catalog, telemetry-core, telemetry-storage,
 * app-version, phorma-cloud-url, tauri.service, @angular/core}`. Adding an
 * import here is a CI failure, not a review comment.
 *
 * ## Every public method is total and silent
 *
 * Nothing here throws for any input or any environment: no `localStorage`, no
 * `crypto.randomUUID`, no `requestIdleCallback`, a hostile stored value, a
 * refused ingest URL and a dead network all degrade to a documented no-op.
 * Every decision is delegated to `telemetry-core`, so this file owns only the
 * clock, the storage adapter, `fetch` and the timer.
 */

import { Injectable, computed, inject, signal } from '@angular/core';

import { APP_VERSION } from './app-version';
import { loadPhormaCloudUrl } from './phorma-cloud-url';
import { TauriService } from './tauri.service';
import { CURRENT_DISCLOSURE_VERSION, type ErrorCategory, counterName } from './telemetry-catalog';
import {
  type Accumulator,
  type ClientEnvironment,
  type ConsentState,
  type IngestOutcome,
  type QueueEntry,
  type Rollup,
  type RuntimeMode,
  type TelemetryState,
  type UploadState,
  UNKNOWN_ENV_VALUE,
  acknowledgeDisclosure,
  applyIncrement,
  applyIngestOutcome,
  backoffMs,
  classifyIngestStatus,
  defaultUploadState,
  emptyAccumulator,
  metricDayUtc,
  readConsent,
  resetDerivedState,
  resolveIngestUrl,
  rollDayIfNeeded,
  sealInterimIfDue,
  sealRollup,
} from './telemetry-core';
import {
  type TelemetryStorage,
  type TelemetryStorageBackend,
  createTelemetryStorage,
} from './telemetry-storage';

/** Scheduler period. Every tick is cheap and most do no work at all. */
export const TELEMETRY_TICK_INTERVAL_MS = 60_000;

/** An ingest request that has not completed by then is aborted (5.6). */
export const TELEMETRY_UPLOAD_TIMEOUT_MS = 10_000;

/** The subset of `RequestInit` the uploader sends. */
export interface TelemetryUploadRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

/** The subset of `fetch` the uploader needs: a status, or a rejection. */
export type TelemetryFetch = (
  url: string,
  init: TelemetryUploadRequest,
) => Promise<{ status: number }>;

/** Opaque timer handle, so the timer seam is not tied to `setTimeout`. */
export type TelemetryTimerHandle = unknown;

/**
 * The four runtime edges this service owns: the clock, storage, `fetch` and the
 * schedulers. Substituting them is the ONLY way to drive the service
 * deterministically, and it is reachable only through
 * {@link TELEMETRY_TEST_SEAM} - a symbol a production caller has no reason to
 * import, cannot reach from a template, and cannot hit by autocomplete.
 */
export interface TelemetrySeams {
  now: () => number;
  fetch: TelemetryFetch;
  scheduleIdle: (run: () => void) => void;
  setTimer: (run: () => void, delayMs: number) => TelemetryTimerHandle;
  randomUuid: () => string;
}

/** {@link TelemetrySeams} plus the storage backend, which is bound separately. */
export interface TelemetrySeamOverrides extends Partial<TelemetrySeams> {
  storageBackend?: TelemetryStorageBackend | null;
}

/**
 * Direct handles on the two async bodies, so a spec can run initialization and
 * an individual tick to completion without a real timer, a real idle callback or
 * a real network.
 */
export interface TelemetryHarness {
  /** The body `bootstrap()` defers. Never rejects. */
  initialize(): Promise<void>;
  /** One scheduler tick, without rescheduling. Never rejects. */
  tick(): Promise<void>;
  /** The live accumulator, queue and upload record. */
  state(): TelemetryState;
  /** The resolved Client_Environment, or `null` before initialization. */
  environment(): ClientEnvironment | null;
}

/** Test-only entry point. See {@link TelemetrySeams}. */
export const TELEMETRY_TEST_SEAM = Symbol('phorma.telemetry.testSeam');

@Injectable({ providedIn: 'root' })
export class TelemetryService {
  private readonly tauri = inject(TauriService);

  /** False until initialization succeeds, and false forever if it throws. */
  readonly active = signal(false);

  /** Consent_State. `setEnabled` is the only way to change it. */
  readonly enabled = signal(true);

  readonly installId = signal('');

  private readonly env = signal<ClientEnvironment | null>(null);

  private readonly state = signal<TelemetryState>({
    accumulator: emptyAccumulator('', 0),
    queue: [],
    upload: defaultUploadState(0),
  });

  /**
   * Exactly what the uploader would send next: the head of the queue when there
   * is one, otherwise the seal of the day accumulated so far. `null` while
   * consent is disabled or before initialization resolves, because then nothing
   * is pending.
   */
  readonly pendingRollup = computed<Rollup | null>(() => {
    if (!this.enabled()) return null;
    const env = this.env();
    const id = this.installId();
    if (env === null || id.length === 0) return null;
    const current = this.state();
    const head = current.queue[0];
    return head ? head.rollup : sealRollup(current.accumulator, id, env);
  });

  readonly queueLength = computed(() => this.state().queue.length);

  /** Local diagnostic for the Privacy section. Never uploaded. */
  readonly rejectedCount = computed(() => this.state().upload.rejectedCount);

  private seams: TelemetrySeams = {
    now: () => Date.now(),
    fetch: (url, init) => fetch(url, init as RequestInit),
    scheduleIdle: (run) => defaultScheduleIdle(run),
    setTimer: (run, delayMs) => setTimeout(run, delayMs),
    randomUuid: () => randomUuidV4(),
  };

  private storage: TelemetryStorage = createTelemetryStorage();

  private consent: ConsentState | null = null;
  private bootstrapped = false;
  private uploading = false;

  // ─── Public surface ───────────────────────────────────────────────────────

  /**
   * Schedules initialization and returns immediately, before any awaited work,
   * so nothing telemetry does is on the first-paint path (4.9). Repeat calls are
   * no-ops. Any throw leaves `active()` false and startup continues (5.7).
   */
  bootstrap(): void {
    if (this.bootstrapped) return;
    this.bootstrapped = true;
    try {
      this.seams.scheduleIdle(() => void this.initialize());
    } catch {
      // A hostile scheduler is still not worth breaking startup over.
    }
  }

  /**
   * The only increment API. A name outside the Counter_Catalog, an amount that
   * is not a positive integer, disabled consent and an inactive service all take
   * the same path: return, write nothing (3.3, 3.4, 3.7).
   */
  count(name: string, amount = 1): void {
    if (!this.active() || !this.enabled()) return;
    this.increment(name, amount);
  }

  /**
   * A category from the closed set, and nothing else. There is no overload
   * taking an `Error`, a message or a stack, so the excluded data has no
   * parameter to travel in (11.3).
   */
  recordError(category: ErrorCategory): void {
    this.count(counterName('error', category));
  }

  /**
   * The single control over Consent_State. Disabling discards the accumulator
   * and the queue inside this synchronous call, so the interaction that flipped
   * the toggle has already thrown the data away by the time it returns (1.5).
   * Enabling resumes from zero on today's Metric_Day and never restores a
   * previous accumulation (1.7).
   */
  setEnabled(next: boolean): void {
    const enabled = next === true;
    const now = this.nowMs();
    this.enabled.set(enabled);
    this.consent = {
      enabled,
      disclosureVersion: CURRENT_DISCLOSURE_VERSION,
      decidedAt: safeIso(now),
    };
    this.state.set(resetDerivedState(metricDayUtc(now), now));
    this.storage.save('consent', this.consent);
    this.writeDerivedState();
  }

  /** Mints a new Install_Id and discards everything derived from the old one (2.4). */
  resetInstallId(): void {
    const now = this.nowMs();
    const id = this.mintInstallId();
    this.installId.set(id);
    this.storage.save('installId', id);
    this.state.set(resetDerivedState(metricDayUtc(now), now));
    this.writeDerivedState();
  }

  // ─── Initialization ───────────────────────────────────────────────────────

  /**
   * The deferred body. Wrapped whole: any failure at any step leaves `active()`
   * false, and the returned promise never rejects (5.7).
   */
  private async initialize(): Promise<void> {
    try {
      const now = this.nowMs();

      // 1. Consent. Read before any write, so an existing choice is never
      //    flipped, and stamp the disclosure version this build presents. The
      //    disclosure itself lives on the download page, not in the app.
      const stored = readConsent(this.storage.load<unknown>('consent', null));
      const consent = acknowledgeDisclosure(stored, safeIso(now));
      this.consent = consent;
      this.enabled.set(consent.enabled);
      if (stored === null || stored.disclosureVersion !== consent.disclosureVersion) {
        this.storage.save('consent', consent);
      }

      // 2. Install identity.
      const storedId = this.storage.load<unknown>('installId', null);
      if (isUuidV4(storedId)) {
        this.installId.set(storedId);
      } else {
        const minted = this.mintInstallId();
        this.installId.set(minted);
        if (consent.enabled) this.storage.save('installId', minted);
      }

      // 3. Client_Environment. The only awaited step, and it cannot reject.
      this.env.set(await this.resolveEnvironment());

      // 4. Derived state. Nothing persisted is trusted: every value is repaired
      //    to its default. While consent is disabled nothing is loaded and
      //    nothing is written (1.6).
      const day = metricDayUtc(now);
      this.state.set(
        consent.enabled ? this.loadDerivedState(day, now) : resetDerivedState(day, now),
      );

      // 5. Roll the day, so a restart on a later day seals the previous one.
      if (consent.enabled) {
        const env = this.env();
        const id = this.installId();
        if (env !== null && id.length > 0) {
          this.commit(rollDayIfNeeded(this.state(), day, id, env, now));
        }
        // 6. One session per app start.
        this.increment(counterName('session.started'), 1);
      }

      // 7. Live.
      this.active.set(true);
      this.scheduleTick();
    } catch {
      // Leaves `active()` false. Telemetry is off for this session and the
      // studio never hears about it.
    }
  }

  private loadDerivedState(day: string, now: number): TelemetryState {
    const stored = this.storage.load<unknown>('accumulator', null);
    const accumulator = repairAccumulator(stored, day, now);
    const queue = repairQueue(this.storage.load<unknown>('queue', null));
    const upload = repairUpload(this.storage.load<unknown>('upload', null), now);
    return { accumulator, queue, upload };
  }

  /**
   * `TauriService.osVersion()` on desktop, the user agent platform string in a
   * browser (3.8). Every field degrades to a string, so the seal never throws.
   */
  private async resolveEnvironment(): Promise<ClientEnvironment> {
    const runtimeMode: RuntimeMode = this.tauri.isDesktop ? 'desktop' : 'browser';
    let osVersion = UNKNOWN_ENV_VALUE;
    try {
      osVersion = await this.tauri.osVersion();
    } catch {
      osVersion = UNKNOWN_ENV_VALUE;
    }
    return {
      locale: readLocale(),
      timezone: readTimezone(),
      platform: readPlatform(),
      osVersion,
      appVersion: APP_VERSION,
      runtimeMode,
    };
  }

  // ─── Scheduler ────────────────────────────────────────────────────────────

  private scheduleTick(): void {
    try {
      this.seams.setTimer(() => {
        void this.runTick().then(() => this.scheduleTick());
      }, TELEMETRY_TICK_INTERVAL_MS);
    } catch {
      // Without a timer the service still accumulates and still persists; it
      // just seals and uploads on the next start instead.
    }
  }

  /**
   * Roll the day, seal an interim Rollup once one is due, then upload the head
   * of the queue once the single rate gate has expired. Disabled consent exits
   * before any read, so no tick can write or issue a request (1.6).
   */
  private async runTick(): Promise<void> {
    try {
      if (!this.active() || !this.enabled()) return;
      const env = this.env();
      const id = this.installId();
      if (env === null || id.length === 0) return;

      const now = this.nowMs();
      let next = rollDayIfNeeded(this.state(), metricDayUtc(now), id, env, now);
      next = sealInterimIfDue(next, id, env, now);
      this.commit(next);

      const current = this.state();
      if (current.queue.length === 0) return;
      if (now < current.upload.nextAttemptAt) return;
      await this.attemptUpload();
    } catch {
      // A tick failure costs one period and nothing else.
    }
  }

  // ─── Upload ───────────────────────────────────────────────────────────────

  /**
   * One JSON `POST` of the head entry, aborted at 10 seconds, with the outcome
   * routed through `classifyIngestStatus`. `nextAttemptAt` is re-armed after
   * EVERY attempt, which is why "at most one request per 15 minutes" and the
   * failure backoff are one mechanism rather than two competing timers.
   */
  private async attemptUpload(): Promise<void> {
    if (this.uploading) return;
    const head = this.state().queue[0];
    if (head === undefined) return;

    const url = resolveIngestUrl(loadPhormaCloudUrl());
    if (url === null) {
      // Refused, not downgraded (11.5). Treated as a transient failure so the
      // Rollup survives a misconfigured base URL.
      this.commit(applyIngestOutcome(this.state(), 'retry', this.nowMs()));
      return;
    }

    this.uploading = true;
    let outcome: IngestOutcome = 'retry';
    try {
      const response = await this.seams.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(head.rollup),
        signal: uploadTimeoutSignal(),
      });
      const status = typeof response?.status === 'number' ? response.status : 0;
      outcome = classifyIngestStatus(status);
    } catch {
      // A network error and an abort are the same thing here (5.1, 5.6).
      outcome = 'retry';
    } finally {
      this.uploading = false;
    }

    const now = this.nowMs();
    const current = this.state();
    if (current.queue[0] !== head) {
      // The queue moved under the in-flight request (a consent reset, or a seal
      // that superseded the head). The outcome no longer describes anything in
      // it, so only re-arm the rate gate.
      this.commit({
        ...current,
        upload: { ...current.upload, nextAttemptAt: now + backoffMs(0) },
      });
      return;
    }
    this.commit(applyIngestOutcome(current, outcome, now));
  }

  // ─── State plumbing ───────────────────────────────────────────────────────

  /** The increment path itself, past the public gate, so bootstrap can use it. */
  private increment(name: string, amount: number): void {
    if (!this.enabled()) return;
    const current = this.state();
    const accumulator = applyIncrement(current.accumulator, name, amount);
    if (accumulator === current.accumulator) return;
    this.commit({ ...current, accumulator });
  }

  /**
   * Publishes `next` and persists only the parts that actually changed, so a
   * counter increment writes one key rather than three. Writes nothing at all
   * while consent is disabled.
   */
  private commit(next: TelemetryState): void {
    const previous = this.state();
    if (next === previous) return;
    this.state.set(next);
    if (!this.enabled()) return;
    if (next.accumulator !== previous.accumulator) {
      this.storage.save('accumulator', next.accumulator);
    }
    if (next.queue !== previous.queue) this.storage.save('queue', next.queue);
    if (next.upload !== previous.upload) this.storage.save('upload', next.upload);
  }

  /** Persists all three derived keys, or removes them when consent is off. */
  private writeDerivedState(): void {
    if (!this.enabled()) {
      this.storage.remove('accumulator');
      this.storage.remove('queue');
      this.storage.remove('upload');
      return;
    }
    const current = this.state();
    this.storage.save('accumulator', current.accumulator);
    this.storage.save('queue', current.queue);
    this.storage.save('upload', current.upload);
  }

  private mintInstallId(): string {
    try {
      const minted = this.seams.randomUuid();
      return isUuidV4(minted) ? minted : randomUuidV4();
    } catch {
      return randomUuidV4();
    }
  }

  private nowMs(): number {
    try {
      const now = this.seams.now();
      return Number.isFinite(now) ? Math.trunc(now) : Date.now();
    } catch {
      return Date.now();
    }
  }

  // ─── Test seam ────────────────────────────────────────────────────────────

  /**
   * Substitutes the runtime edges and hands back direct control of the two async
   * bodies. Test-only: reachable only by importing {@link TELEMETRY_TEST_SEAM}.
   *
   * @internal
   */
  [TELEMETRY_TEST_SEAM](overrides: TelemetrySeamOverrides): TelemetryHarness {
    const { storageBackend, ...seams } = overrides;
    this.seams = { ...this.seams, ...seams };
    if ('storageBackend' in overrides) {
      this.storage = createTelemetryStorage(storageBackend ?? null);
    }
    return {
      initialize: () => this.initialize(),
      tick: () => this.runTick(),
      state: () => this.state(),
      environment: () => this.env(),
    };
  }
}

// ─── Module-local helpers ───────────────────────────────────────────────────

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

/** `crypto.randomUUID()` where it exists, otherwise a v4 built from CSPRNG bytes. */
function randomUuidV4(): string {
  try {
    const source = globalThis.crypto as
      { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } | undefined;
    if (typeof source?.randomUUID === 'function') {
      const uuid = source.randomUUID();
      if (isUuidV4(uuid)) return uuid;
    }
    if (typeof source?.getRandomValues === 'function') {
      const bytes = source.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      return (
        `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
        `${hex.slice(16, 20)}-${hex.slice(20)}`
      );
    }
  } catch {
    // Fall through to the empty identity below.
  }
  // No secure random source. An empty Install_Id is refused at ingest, which is
  // the correct outcome: telemetry is not worth a predictable identifier.
  return '';
}

function defaultScheduleIdle(run: () => void): void {
  const idle = (
    globalThis as unknown as {
      requestIdleCallback?: (cb: () => void, options?: { timeout?: number }) => number;
    }
  ).requestIdleCallback;
  if (typeof idle === 'function') {
    idle(() => run(), { timeout: 2_000 });
    return;
  }
  setTimeout(run, 0);
}

/** `AbortSignal.timeout` where it exists, otherwise no client-side deadline. */
function uploadTimeoutSignal(): AbortSignal | undefined {
  try {
    const timeout = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout;
    return typeof timeout === 'function'
      ? timeout.call(AbortSignal, TELEMETRY_UPLOAD_TIMEOUT_MS)
      : undefined;
  } catch {
    return undefined;
  }
}

function safeIso(now: number): string {
  try {
    return new Date(now).toISOString();
  } catch {
    return '';
  }
}

function readLocale(): string {
  try {
    return typeof navigator === 'undefined' ? UNKNOWN_ENV_VALUE : navigator.language;
  } catch {
    return UNKNOWN_ENV_VALUE;
  }
}

function readTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return UNKNOWN_ENV_VALUE;
  }
}

/** `windows` | `macos` | `linux` | `other`, from the user agent only. */
function readPlatform(): string {
  let source = '';
  try {
    if (typeof navigator !== 'undefined') {
      const hint = (navigator as Navigator & { userAgentData?: { platform?: unknown } })
        .userAgentData?.platform;
      source = typeof hint === 'string' && hint.trim() ? hint : navigator.userAgent;
    }
  } catch {
    source = '';
  }
  const ua = typeof source === 'string' ? source.toLowerCase() : '';
  if (ua.includes('android')) return 'other';
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac') || ua.includes('darwin')) return 'macos';
  if (ua.includes('linux') || ua.includes('x11')) return 'linux';
  return 'other';
}

/**
 * A persisted accumulator, repaired. A value for a different Metric_Day is kept
 * as-is so the tick's day roll can seal it; only an unusable shape is replaced.
 */
function repairAccumulator(raw: unknown, day: string, now: number): Accumulator {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return emptyAccumulator(day, now);
  }
  const record = raw as Partial<Accumulator>;
  if (typeof record.metricDay !== 'string') return emptyAccumulator(day, now);
  const counters = record.counters;
  return {
    metricDay: record.metricDay,
    // `applyIncrement` and `sealRollup` both sanitize the map, so an unusable
    // entry is dropped at use rather than trusted here.
    counters:
      counters !== null && typeof counters === 'object' && !Array.isArray(counters)
        ? (counters as Record<string, number>)
        : {},
    lastSealAt: Number.isFinite(record.lastSealAt) ? Math.trunc(record.lastSealAt as number) : now,
  };
}

function repairQueue(raw: unknown): QueueEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isQueueEntry);
}

function isQueueEntry(value: unknown): value is QueueEntry {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Partial<QueueEntry>;
  const rollup = entry.rollup as Partial<Rollup> | undefined;
  if (rollup === null || typeof rollup !== 'object') return false;
  return typeof rollup?.installId === 'string' && typeof rollup?.metricDay === 'string';
}

function repairUpload(raw: unknown, now: number): UploadState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaultUploadState(now);
  }
  const record = raw as Partial<UploadState>;
  return {
    nextAttemptAt: Number.isFinite(record.nextAttemptAt)
      ? Math.trunc(record.nextAttemptAt as number)
      : now,
    failureCount: positiveCount(record.failureCount),
    rejectedCount: positiveCount(record.rejectedCount),
  };
}

function positiveCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
