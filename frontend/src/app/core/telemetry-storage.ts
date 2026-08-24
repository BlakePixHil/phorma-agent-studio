/**
 * `localStorage`-backed persistence for anonymous usage telemetry.
 *
 * Keys are namespaced under `phorma.telemetry.` so they never collide with
 * layout state (`phorma.layout.*`) or any other Phorma storage, and so the whole
 * feature can be located, inspected, or wiped by prefix.
 *
 * Follows `core/layout-storage.ts`: every access is wrapped in try/catch, so a
 * corrupted entry, a full quota, or a locked-down storage (private mode, a
 * hardened webview) degrades to the fallback instead of throwing. Nothing in
 * telemetry is allowed to break the surface that reports to it.
 *
 * The backend is a parameter rather than a hard reference to `localStorage`, so
 * tests can round-trip against a fake store without touching global state.
 */

import type { Accumulator, ConsentState, QueueEntry, UploadState } from './telemetry-core';

/** Namespace every telemetry entry shares. */
export const TELEMETRY_STORAGE_PREFIX = 'phorma.telemetry.';

/**
 * The persisted shape behind each key. Documentation and a type-level guard: a
 * caller cannot pass a key this feature does not own.
 */
export interface TelemetryStored {
  /** UUID v4 Install_Id. */
  installId: string;
  consent: ConsentState;
  accumulator: Accumulator;
  queue: QueueEntry[];
  upload: UploadState;
}

/** The five keys this feature persists, in initialization order. */
export const TELEMETRY_STORAGE_KEYS = [
  'installId',
  'consent',
  'accumulator',
  'queue',
  'upload',
] as const;

export type TelemetryStorageKey = (typeof TELEMETRY_STORAGE_KEYS)[number];

/**
 * The slice of the DOM `Storage` interface telemetry uses. `localStorage`
 * satisfies it structurally, and so does a plain `Map`-backed fake.
 */
export interface TelemetryStorageBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The three accessors bound to one backend. */
export interface TelemetryStorage {
  load<T>(key: TelemetryStorageKey, fallback: T): T;
  save(key: TelemetryStorageKey, value: unknown): void;
  remove(key: TelemetryStorageKey): void;
}

/**
 * `localStorage` when it is reachable, otherwise `null`. Reading the property
 * itself can throw when storage is disabled by policy, so even the lookup is
 * guarded.
 */
export function defaultTelemetryBackend(): TelemetryStorageBackend | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Reads and parses the `key` entry, returning `fallback` when nothing usable is
 * stored. A malformed or `null` JSON value reads as absent; repair to a valid
 * default happens on the next write.
 */
export function loadTelemetry<T>(
  key: TelemetryStorageKey,
  fallback: T,
  backend: TelemetryStorageBackend | null = defaultTelemetryBackend(),
): T {
  if (backend === null) return fallback;
  try {
    const raw = backend.getItem(TELEMETRY_STORAGE_PREFIX + key);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as T | null | undefined;
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** Serializes `value` under `key`. Best-effort: quota and policy errors are swallowed. */
export function saveTelemetry(
  key: TelemetryStorageKey,
  value: unknown,
  backend: TelemetryStorageBackend | null = defaultTelemetryBackend(),
): void {
  if (backend === null) return;
  try {
    backend.setItem(TELEMETRY_STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    // Ignore quota / private-mode / unserializable-value errors - telemetry
    // persistence is best-effort and never worth an exception.
  }
}

/** Deletes the `key` entry. Absent entries and unavailable storage are no-ops. */
export function removeTelemetry(
  key: TelemetryStorageKey,
  backend: TelemetryStorageBackend | null = defaultTelemetryBackend(),
): void {
  if (backend === null) return;
  try {
    backend.removeItem(TELEMETRY_STORAGE_PREFIX + key);
  } catch {
    // Ignore private-mode errors.
  }
}

/**
 * Binds the three accessors to one backend, so a caller (the service) resolves
 * storage once, and a test can supply a fake without global state.
 */
export function createTelemetryStorage(
  backend: TelemetryStorageBackend | null = defaultTelemetryBackend(),
): TelemetryStorage {
  return {
    load: (key, fallback) => loadTelemetry(key, fallback, backend),
    save: (key, value) => saveTelemetry(key, value, backend),
    remove: (key) => removeTelemetry(key, backend),
  };
}
