/**
 * Pure state algebra for anonymous usage telemetry.
 *
 * This module is a LEAF: no Angular, no services, no DOM beyond ambient types,
 * no clock and no I/O. Every decision the telemetry feature makes lives here as
 * a total function over plain data, so `telemetry.service.ts` can stay a thin
 * shell that owns the clock, the storage adapter and `fetch`.
 *
 * Totality is a hard rule in this file. No exported function throws for any
 * input, however malformed: each one degrades to a documented default instead.
 * Telemetry must never be able to break the surface that reports to it.
 */

import {
  COUNTER_CATALOG,
  CURRENT_DISCLOSURE_VERSION,
  TELEMETRY_SCHEMA_VERSION,
} from './telemetry-catalog';

// ─── Wire model: the only object this feature ever sends off the machine ─────

/** Runtime the studio is executing in. */
export type RuntimeMode = 'desktop' | 'browser';

export interface ClientEnvironment {
  /** `navigator.language`. */
  locale: string;
  /** `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
  timezone: string;
  /** `'windows' | 'macos' | 'linux' | 'other'`, kept as a string on the wire. */
  platform: string;
  /** `TauriService.osVersion()` on desktop, the UA platform string in a browser. */
  osVersion: string;
  /** `APP_VERSION`. */
  appVersion: string;
  runtimeMode: RuntimeMode;
}

/** The Rollup payload for one Install_Id and one Metric_Day. */
export interface Rollup {
  /** Client UUID v4. No relationship to any account, machine or address. */
  installId: string;
  /** UTC calendar day, `YYYY-MM-DD`. */
  metricDay: string;
  env: ClientEnvironment;
  /** Counter_Catalog names only, cumulative-to-date for `metricDay`. */
  counters: Record<string, number>;
  schemaVersion: number;
}

/**
 * The executable statement of the Rollup's closure. {@link sealRollup} builds
 * its result from this list rather than by spreading a source object, so a field
 * that is not named here cannot reach the wire, and a property asserts key-set
 * equality against it.
 */
export const ROLLUP_KEYS = ['installId', 'metricDay', 'env', 'counters', 'schemaVersion'] as const;

/** The same closure statement for {@link ClientEnvironment}. */
export const ENV_KEYS = [
  'locale',
  'timezone',
  'platform',
  'osVersion',
  'appVersion',
  'runtimeMode',
] as const;

// ─── Local persisted models (`localStorage`, `phorma.telemetry.*`) ───────────

export interface ConsentState {
  enabled: boolean;
  /** The disclosure version this install has been shown. */
  disclosureVersion: number;
  /** ISO timestamp. Never formatted for display, never uploaded. */
  decidedAt: string;
}

export interface Accumulator {
  /** UTC `YYYY-MM-DD`. */
  metricDay: string;
  /** Counter_Catalog names only, cumulative for {@link Accumulator.metricDay}. */
  counters: Record<string, number>;
  /** Epoch ms of the last seal. Drives the 6 hour interim seal. */
  lastSealAt: number;
}

/**
 * Queue envelope. `sealedAt` sits OUTSIDE the Rollup so the wire shape stays
 * exactly the five fields Requirement 4.5 permits, while the cap and the dedupe
 * still have an ordering key.
 */
export interface QueueEntry {
  sealedAt: number;
  rollup: Rollup;
}

export interface UploadState {
  /** The single rate gate: no request is issued before this instant. */
  nextAttemptAt: number;
  /** Consecutive failures, drives {@link backoffMs}. */
  failureCount: number;
  /** Local diagnostic only, surfaced in the Privacy section, never uploaded. */
  rejectedCount: number;
}

/** The three derived values a consent or install-id transition clears. */
export interface TelemetryState {
  accumulator: Accumulator;
  queue: QueueEntry[];
  upload: UploadState;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Minimum spacing between ingest requests, and the base of the backoff curve. */
export const UPLOAD_INTERVAL_MS = 15 * 60_000;

/** Ceiling for the retry backoff. */
export const MAX_BACKOFF_MS = 24 * 60 * 60_000;

/** Elapsed time since the last seal that makes an interim seal due. */
export const INTERIM_SEAL_INTERVAL_MS = 6 * 60 * 60_000;

/** Maximum Rollups held locally while awaiting upload. */
export const QUEUE_CAP = 30;

/** Path appended to the Phorma Cloud base URL to reach the Ingest_Endpoint. */
export const INGEST_PATH = '/telemetry';

/** Client-side truncation of every Client_Environment string field. */
export const ENV_FIELD_MAX_LENGTH = 64;

/** Stand-in for a Client_Environment field that could not be resolved. */
export const UNKNOWN_ENV_VALUE = 'unknown';

/** The only hostnames allowed to serve the Ingest_Endpoint over `http:`. */
export const LOCAL_INGEST_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1'];

/** `Date` cannot represent an instant beyond this distance from the epoch. */
const MAX_TIME_MS = 8.64e15;

const METRIC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ─── Metric_Day ─────────────────────────────────────────────────────────────

/**
 * The UTC calendar day of `now`, formatted `YYYY-MM-DD`. Non-finite and
 * out-of-range input resolves to the epoch day rather than throwing.
 */
export function metricDayUtc(now: number | Date): string {
  const raw = now instanceof Date ? now.getTime() : now;
  const ms = Number.isFinite(raw)
    ? Math.min(Math.max(Math.trunc(raw), -MAX_TIME_MS), MAX_TIME_MS)
    : 0;
  return new Date(ms).toISOString().slice(0, 10);
}

/** True when `value` is a real `YYYY-MM-DD` calendar day. */
export function isMetricDay(value: unknown): value is string {
  if (typeof value !== 'string' || !METRIC_DAY_PATTERN.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

// ─── Consent bootstrap ──────────────────────────────────────────────────────

/**
 * Parses a persisted `consent` value. Returns `null` when nothing usable was
 * persisted, which is what a fresh install looks like.
 * A partially malformed record is salvaged rather than discarded: a boolean
 * `enabled` is preserved, and an unusable disclosure version reads as `0`, so a
 * bumped policy version is re-stamped and consent survives.
 */
export function readConsent(raw: unknown): ConsentState | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const version = record['disclosureVersion'];
  return {
    enabled: typeof record['enabled'] === 'boolean' ? record['enabled'] : true,
    disclosureVersion: Number.isFinite(version) ? Math.trunc(version as number) : 0,
    decidedAt: typeof record['decidedAt'] === 'string' ? record['decidedAt'] : '',
  };
}

/**
 * The consent record to persist for the disclosure version this build presents:
 * the existing consent value when there is one, enabled by default, stamped with
 * the current disclosure version. Never flips an existing choice.
 *
 * The version field is the record of WHICH policy version an install has
 * acknowledged. There is no in-app gate reading it any more - the disclosure is
 * made on the download page before the installer is fetched - but it stays
 * persisted so a future policy change has something to pair with.
 */
export function acknowledgeDisclosure(
  stored: ConsentState | null,
  nowIso: string,
  current: number = CURRENT_DISCLOSURE_VERSION,
): ConsentState {
  const version = Number.isFinite(current) ? Math.trunc(current) : CURRENT_DISCLOSURE_VERSION;
  return {
    enabled: stored?.enabled ?? true,
    disclosureVersion: version,
    decidedAt: typeof nowIso === 'string' && nowIso.length > 0 ? nowIso : stored?.decidedAt ?? '',
  };
}

// ─── Accumulation ───────────────────────────────────────────────────────────

/** An accumulator with every counter at zero for `metricDay`. */
export function emptyAccumulator(metricDay: string, now: number): Accumulator {
  return {
    metricDay: isMetricDay(metricDay) ? metricDay : metricDayUtc(now),
    counters: {},
    lastSealAt: safeTime(now),
  };
}

/**
 * The upload record for a start with no persisted attempt history.
 *
 * `nextAttemptAt` is `now`, NOT `now + UPLOAD_INTERVAL_MS`. The interval is the
 * minimum spacing between REQUESTS, and this record describes a client that has
 * made none, so there is nothing to space from. Arming it one interval out
 * instead made the gate a cold-start delay, and because `upload` is only
 * persisted once an attempt has produced an outcome, every restart re-armed it:
 * an install used in sessions shorter than 15 minutes uploaded literally never,
 * however long its queue sat there. The gate is re-armed after every attempt, so
 * Requirements 4.3 and 5.4 still hold from the first request onward.
 */
export function defaultUploadState(now: number): UploadState {
  return { nextAttemptAt: safeTime(now), failureCount: 0, rejectedCount: 0 };
}

/**
 * Adds `amount` to the `name` counter and returns the next accumulator.
 *
 * Accepts only a Counter_Catalog name and a positive safe integer amount. Any
 * other report leaves the accumulator exactly as it was, returned unchanged, so
 * a caller cannot smuggle a dimension, a payload or a decrement through here.
 */
export function applyIncrement(acc: Accumulator, name: string, amount = 1): Accumulator {
  if (typeof name !== 'string' || !COUNTER_CATALOG.has(name)) return acc;
  if (!Number.isSafeInteger(amount) || amount <= 0) return acc;
  const counters = sanitizeCounters(acc?.counters);
  const current = counters[name] ?? 0;
  counters[name] = current + amount;
  return {
    metricDay: typeof acc?.metricDay === 'string' ? acc.metricDay : '',
    counters,
    lastSealAt: safeTime(acc?.lastSealAt),
  };
}

/** Sum of every counter in `acc`. Used to decide whether a seal is worth making. */
export function counterTotal(acc: Accumulator): number {
  let total = 0;
  for (const value of Object.values(sanitizeCounters(acc?.counters))) total += value;
  return total;
}

// ─── Seal ───────────────────────────────────────────────────────────────────

/**
 * Builds the Rollup for `acc`.
 *
 * The result is assembled from {@link ROLLUP_KEYS} and {@link ENV_KEYS} rather
 * than by spreading, so the field set is closed by construction. Counters carry
 * the accumulator's CUMULATIVE totals for the day, never a delta: that is what
 * makes the server's blind replace correct, and it means a lost upload costs
 * freshness and nothing else.
 */
export function sealRollup(acc: Accumulator, installId: string, env: ClientEnvironment): Rollup {
  const source: Rollup = {
    installId: typeof installId === 'string' ? installId : '',
    metricDay: typeof acc?.metricDay === 'string' ? acc.metricDay : '',
    env: sealEnvironment(env),
    counters: sanitizeCounters(acc?.counters),
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
  };
  return pick(source, ROLLUP_KEYS);
}

/** A queue envelope for `rollup`, sealed at `now`. */
export function sealEntry(rollup: Rollup, now: number): QueueEntry {
  return { sealedAt: safeTime(now), rollup };
}

// ─── Upload queue ───────────────────────────────────────────────────────────

/**
 * Appends `entry`, dropping any earlier entry for the same
 * `(installId, metricDay)` pair and then capping the queue.
 *
 * Dedupe runs BEFORE the cap on purpose: dedupe can only shrink the queue, so
 * doing it first means a repeated interim seal for today never evicts a
 * genuinely distinct older day. Eviction always takes the oldest entry by seal
 * time and leaves the surviving order untouched.
 */
export function appendToQueue(
  queue: readonly QueueEntry[],
  entry: QueueEntry,
  cap = QUEUE_CAP,
): QueueEntry[] {
  const limit = Number.isSafeInteger(cap) && cap > 0 ? cap : QUEUE_CAP;
  const source = Array.isArray(queue) ? queue : [];
  const deduped = source.filter(
    (e) =>
      e?.rollup?.installId !== entry?.rollup?.installId ||
      e?.rollup?.metricDay !== entry?.rollup?.metricDay,
  );
  const next = [...deduped, entry];
  if (next.length <= limit) return next;
  const oldestFirst = next
    .map((e, index) => ({ index, sealedAt: safeTime(e?.sealedAt) }))
    .sort((a, b) => a.sealedAt - b.sealedAt || a.index - b.index);
  const evicted = new Set(oldestFirst.slice(0, next.length - limit).map((e) => e.index));
  return next.filter((_, index) => !evicted.has(index));
}

// ─── Ingest outcome ─────────────────────────────────────────────────────────

export type IngestOutcome = 'accepted' | 'retry' | 'rejected';

/**
 * Partitions the whole HTTP status space. A network error or an abort is not a
 * status, so the caller reports it as `'retry'` directly.
 *
 * A 4xx other than 429 is `'rejected'` and the Rollup is dropped: the payload
 * will never be accepted, and retrying it would block the queue forever behind a
 * permanently invalid entry.
 */
export function classifyIngestStatus(status: number): IngestOutcome {
  if (status === 200) return 'accepted';
  if (status === 429 || status >= 500) return 'retry';
  if (status >= 400) return 'rejected';
  // 1xx, other 2xx and 3xx are not answers we asked for, so treat them as transient.
  return 'retry';
}

/**
 * `min(15 minutes * 2^(failureCount - 1), 24 hours)`, and exactly 15 minutes for
 * a clean record. Zero, fractional, negative and non-finite input all resolve to
 * a defined wait, so a corrupted persisted failure count cannot produce a
 * `NaN` deadline that would either hammer the endpoint or wedge the queue.
 */
export function backoffMs(failureCount: number): number {
  const failures = Number.isFinite(failureCount) ? Math.max(0, Math.floor(failureCount)) : 0;
  if (failures === 0) return UPLOAD_INTERVAL_MS;
  return Math.min(UPLOAD_INTERVAL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
}

/**
 * Folds an attempt outcome for the HEAD of the queue into the next state.
 *
 * `nextAttemptAt` is reset after every attempt, which is why "at most one
 * request per 15 minutes" and the failure backoff are one mechanism rather than
 * two competing timers.
 */
export function applyIngestOutcome(
  state: TelemetryState,
  outcome: IngestOutcome,
  now: number,
): TelemetryState {
  const at = safeTime(now);
  const upload = state.upload;
  if (outcome === 'retry') {
    const failureCount = Math.max(0, Math.floor(safeCount(upload?.failureCount))) + 1;
    return {
      ...state,
      upload: {
        nextAttemptAt: at + backoffMs(failureCount),
        failureCount,
        rejectedCount: safeCount(upload?.rejectedCount),
      },
    };
  }
  const rejectedCount = safeCount(upload?.rejectedCount) + (outcome === 'rejected' ? 1 : 0);
  return {
    ...state,
    queue: state.queue.slice(1),
    upload: { nextAttemptAt: at + backoffMs(0), failureCount: 0, rejectedCount },
  };
}

// ─── Day roll, interim seal, and the reset path ─────────────────────────────

/**
 * Seals the old day and zeroes the new one when the UTC day has changed.
 * Returns `state` untouched while the accumulator is already on `currentDay`.
 * A previous accumulator carrying no valid Metric_Day is discarded rather than
 * sealed, since a Rollup without a day would only be rejected at ingest.
 */
export function rollDayIfNeeded(
  state: TelemetryState,
  currentDay: string,
  installId: string,
  env: ClientEnvironment,
  now: number,
): TelemetryState {
  const day = isMetricDay(currentDay) ? currentDay : metricDayUtc(now);
  const previous = state.accumulator;
  if (previous?.metricDay === day) return state;
  const accumulator = emptyAccumulator(day, now);
  if (!isMetricDay(previous?.metricDay)) return { ...state, accumulator };
  const entry = sealEntry(sealRollup(previous, installId, env), now);
  return { ...state, accumulator, queue: appendToQueue(state.queue, entry) };
}

/**
 * Queues an interim Rollup once 6 hours have passed since the last seal and the
 * day has something to report. The accumulator is KEPT so the day keeps
 * accumulating; because every seal is cumulative, the next interim seal simply
 * replaces the queued entry for the same day.
 */
export function sealInterimIfDue(
  state: TelemetryState,
  installId: string,
  env: ClientEnvironment,
  now: number,
): TelemetryState {
  const at = safeTime(now);
  const acc = state.accumulator;
  if (at - safeTime(acc?.lastSealAt) < INTERIM_SEAL_INTERVAL_MS) return state;
  if (counterTotal(acc) <= 0) return state;
  const entry = sealEntry(sealRollup(acc, installId, env), at);
  return {
    ...state,
    accumulator: { ...acc, lastSealAt: at },
    queue: appendToQueue(state.queue, entry),
  };
}

/**
 * The state a consent flip or an Install_Id reset converges on: an empty
 * accumulator for the current day, an empty queue, and a clean upload record.
 *
 * All three transitions (disable, re-enable, reset install id) call this, which
 * is why disabling discards pending data inside the same user interaction and
 * re-enabling can never resurrect a previous accumulation.
 */
export function resetDerivedState(metricDay: string, now: number): TelemetryState {
  return {
    accumulator: emptyAccumulator(metricDay, now),
    queue: [],
    upload: defaultUploadState(now),
  };
}

// ─── Ingest URL ─────────────────────────────────────────────────────────────

/**
 * The Ingest_Endpoint URL for a configured Phorma Cloud base URL, or `null` when
 * the base URL must not be used.
 *
 * HTTPS is mandatory. `localhost` and `127.0.0.1` over `http:` are the only
 * exceptions, and they exist for local Worker development. A refusal returns
 * `null` and the caller skips the upload; there is no downgrade path.
 */
export function resolveIngestUrl(baseUrl: string): string | null {
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) return null;
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const localHttp = url.protocol === 'http:' && LOCAL_INGEST_HOSTNAMES.includes(host);
  if (url.protocol !== 'https:' && !localHttp) return null;
  const base = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${base}${INGEST_PATH}`;
}

// ─── Internals ──────────────────────────────────────────────────────────────

/** Builds a fresh object holding exactly `keys`, in `keys` order. */
function pick<T extends object, K extends readonly (keyof T)[]>(
  source: T,
  keys: K,
): Pick<T, K[number]> {
  const out: Record<PropertyKey, unknown> = {};
  for (const key of keys) out[key as PropertyKey] = source[key];
  return out as unknown as Pick<T, K[number]>;
}

/** Every Client_Environment field as a bounded, non-empty string. */
function sealEnvironment(env: ClientEnvironment | null | undefined): ClientEnvironment {
  const source: ClientEnvironment = {
    locale: envString(env?.locale),
    timezone: envString(env?.timezone),
    platform: envString(env?.platform),
    osVersion: envString(env?.osVersion),
    appVersion: envString(env?.appVersion),
    runtimeMode: env?.runtimeMode === 'desktop' ? 'desktop' : 'browser',
  };
  return pick(source, ENV_KEYS);
}

function envString(value: unknown): string {
  if (typeof value !== 'string') return UNKNOWN_ENV_VALUE;
  const trimmed = value.trim();
  if (trimmed.length === 0) return UNKNOWN_ENV_VALUE;
  return trimmed.slice(0, ENV_FIELD_MAX_LENGTH);
}

/**
 * A fresh counter map holding only Counter_Catalog names with positive safe
 * integer values. Anything else is dropped, so a hand-edited `localStorage`
 * value cannot put an unknown name or a non-number on the wire.
 */
function sanitizeCounters(counters: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (counters === null || typeof counters !== 'object' || Array.isArray(counters)) return out;
  for (const [name, value] of Object.entries(counters as Record<string, unknown>)) {
    if (!COUNTER_CATALOG.has(name)) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) continue;
    out[name] = value;
  }
  return out;
}

function safeTime(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function safeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}
