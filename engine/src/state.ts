/**
 * Durable workflow state primitives (design §8, P1-8).
 *
 * The store itself is a host capability (`RunOptions.state`); everything in this
 * module is pure, synchronous-where-possible logic that the engine and the three
 * hosts share so a delta hash computed on the desktop matches one computed in the
 * worker byte for byte:
 *
 * - `scopedStateKey` / `STATE_NS` — the key scheme (§8.1). Every key is scoped by
 *   workflow, and the five reserved namespaces keep user keys from colliding with
 *   primitives.
 * - `canonicalJson` + `fnv1a` — the content fingerprint used by delta sync, so
 *   key ordering from a paginated API never fakes a change (§8.2).
 * - `deltaFilter` — classifies a record set into changed and skipped, conserving
 *   the count at every step.
 * - `claimIdempotent` — a single atomic compare-and-set, so exactly one caller
 *   owns a write (§8.3).
 * - `compareWatermark` — the total order watermark writes converge on (§8.4).
 * - Retention constants and TTL defaults (§8.5) hosts enforce at write time.
 *
 * No runtime dependency, no host API: `TextEncoder` is the only global used, and
 * it exists on all three targets.
 */

import type { WorkflowStateStore } from './data-host.js';
import { resolveJsonPath } from './payload.js';

// ─────────────────────────────────────────────────────────────────────────────
// 8.1 Key scheme
// ─────────────────────────────────────────────────────────────────────────────

/** Separator between the workflow scope and the caller's key. */
export const STATE_SCOPE_SEPARATOR = '::';

/** All keys are scoped by workflow. Hosts MUST enforce the prefix. */
export function scopedStateKey(workflowId: string, key: string): string {
  return `${workflowId}${STATE_SCOPE_SEPARATOR}${key}`;
}

/** Reserved namespaces, so user keys cannot collide with primitives. */
export const STATE_NS = {
  delta: 'delta:', // delta:{entity}:{externalId}  -> content hash
  idempotency: 'idem:', // idem:{runScopedKey}          -> 'claimed' | result hash
  watermark: 'wm:', // wm:{stream}                  -> ISO ts or numeric id
  oauth: 'oauth:', // oauth:{connectionId}         -> {token, expiresAt}
  fixture: 'fx:', // fx:{nodeId}:{payloadHash}    -> recorded response (§11)
} as const;

/** `delta:{entity}:{externalId}` — the per-record content-hash key. */
export function deltaStateKey(entity: string, externalId: string): string {
  return `${STATE_NS.delta}${entity}:${externalId}`;
}

/** `idem:{renderedKey}` — the write-claim key. */
export function idempotencyStateKey(renderedKey: string): string {
  return `${STATE_NS.idempotency}${renderedKey}`;
}

/** `wm:{stream}` — the resume watermark key. */
export function watermarkStateKey(stream: string): string {
  return `${STATE_NS.watermark}${stream}`;
}

/** `oauth:{connectionId}` — the cached access-token key. */
export function oauthStateKey(connectionId: string): string {
  return `${STATE_NS.oauth}${connectionId}`;
}

/**
 * Strips the workflow scope from a key, if present. Hosts use this to inspect the
 * namespace of a stored key (`wm:`/`oauth:` are exempt from pruning).
 */
export function unscopeStateKey(key: string): string {
  const at = key.indexOf(STATE_SCOPE_SEPARATOR);
  return at < 0 ? key : key.slice(at + STATE_SCOPE_SEPARATOR.length);
}

/** The reserved namespace prefix a key belongs to, or undefined for a user key. */
export function stateNamespaceOf(key: string): string | undefined {
  const bare = unscopeStateKey(key);
  for (const ns of Object.values(STATE_NS)) {
    if (bare.startsWith(ns)) return ns;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8.5 Retention bounds and TTL defaults
// ─────────────────────────────────────────────────────────────────────────────

/** Per-value UTF-8 byte cap. A larger write is rejected (Requirement 12.16). */
export const STATE_VALUE_MAX_BYTES = 32_768;

/** Keys per workflow before prune-oldest kicks in (Requirement 12.17). */
export const STATE_MAX_KEYS_PER_WORKFLOW = 50_000;

/** Total UTF-8 value bytes per workflow before prune-oldest kicks in. */
export const STATE_MAX_TOTAL_BYTES_PER_WORKFLOW = 33_554_432;

/** `list` returns this many entries when no limit is supplied, and never more. */
export const STATE_LIST_DEFAULT_LIMIT = 1000;

/** Upper clamp for an explicit `list` limit. */
export const STATE_LIST_MAX_LIMIT = 1000;

/** Accepted explicit `ttlSec` range (1 second … 400 days). */
export const STATE_TTL_MIN_SEC = 1;
export const STATE_TTL_MAX_SEC = 34_560_000;

const DAY_SEC = 86_400;

/** Default TTL per reserved namespace. `wm:` and `oauth:` never expire. */
export const STATE_TTL_DEFAULT_SEC: Readonly<Record<string, number | undefined>> = {
  [STATE_NS.delta]: 400 * DAY_SEC,
  [STATE_NS.idempotency]: 7 * DAY_SEC,
  [STATE_NS.fixture]: 30 * DAY_SEC,
  [STATE_NS.watermark]: undefined,
  [STATE_NS.oauth]: undefined,
};

/** TTL applied to an idempotency claim (§8.3). */
export const IDEMPOTENCY_TTL_SEC = 7 * DAY_SEC;

/** True when a key may be evicted by prune-oldest (`wm:`/`oauth:` may not). */
export function isPrunableStateKey(key: string): boolean {
  const ns = stateNamespaceOf(key);
  return ns !== STATE_NS.watermark && ns !== STATE_NS.oauth;
}

/**
 * Resolves the effective TTL for a write: an explicit integer `ttlSec` inside
 * `1 … 34560000` wins, otherwise the namespace default, otherwise no expiry.
 * An out-of-range or non-integer `ttlSec` falls back to the namespace default.
 */
export function resolveStateTtlSec(key: string, ttlSec?: number): number | undefined {
  if (
    typeof ttlSec === 'number' &&
    Number.isInteger(ttlSec) &&
    ttlSec >= STATE_TTL_MIN_SEC &&
    ttlSec <= STATE_TTL_MAX_SEC
  ) {
    return ttlSec;
  }
  const ns = stateNamespaceOf(key);
  return ns === undefined ? undefined : STATE_TTL_DEFAULT_SEC[ns];
}

/** UTF-8 byte length of a string, for the value and total-byte caps. */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical JSON + content hash
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic JSON text: object keys sorted recursively (UTF-16 code-unit
 * order), array order preserved, numbers normalised.
 *
 * `{a:1,b:2}` and `{b:2,a:1}` produce the same string — without that, key
 * ordering from a paginated API would make every record look changed.
 *
 * Total on any JSON-shaped input: `undefined`, a function, `NaN` and `Infinity`
 * render as `null` (matching `JSON.stringify`'s treatment inside arrays), and a
 * `toJSON` method is honoured. Throws only for a circular structure.
 */
export function canonicalJson(value: unknown): string {
  return writeCanonical(value, new Set<object>());
}

function writeCanonical(value: unknown, seen: Set<object>): string {
  const unwrapped = unwrapToJson(value);

  if (unwrapped === null || unwrapped === undefined) return 'null';
  switch (typeof unwrapped) {
    case 'boolean':
      return unwrapped ? 'true' : 'false';
    case 'number':
      return Number.isFinite(unwrapped)
        ? Object.is(unwrapped, -0)
          ? '0'
          : JSON.stringify(unwrapped)
        : 'null';
    case 'string':
      return JSON.stringify(unwrapped);
    case 'bigint':
      return JSON.stringify(unwrapped.toString());
    case 'function':
    case 'symbol':
    case 'undefined':
      return 'null';
    default:
      break;
  }

  const object = unwrapped as object;
  if (seen.has(object)) throw new Error('canonicalJson: circular structure');
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const items = object.map((item) => writeCanonical(item, seen));
      return `[${items.join(',')}]`;
    }
    const entries: string[] = [];
    for (const key of Object.keys(object as Record<string, unknown>).sort()) {
      const child = (object as Record<string, unknown>)[key];
      if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
      entries.push(`${JSON.stringify(key)}:${writeCanonical(child, seen)}`);
    }
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(object);
  }
}

/** Applies a `toJSON()` method the way `JSON.stringify` would. */
function unwrapToJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const toJson = (value as { toJSON?: unknown }).toJSON;
  return typeof toJson === 'function'
    ? (toJson as () => unknown).call(value)
    : value;
}

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;

/**
 * FNV-1a (32-bit) over the UTF-8 bytes of `input`, as 8 lower-case hex digits.
 *
 * Not a cryptographic hash — it is a change detector for delta sync and fixture
 * identity, chosen because it is short, fast and trivially identical across the
 * TypeScript hosts and a future Rust implementation.
 */
export function fnv1a(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let hash = FNV_OFFSET_BASIS_32;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    // Multiply mod 2^32 without losing precision: Math.imul wraps for us.
    hash = Math.imul(hash, FNV_PRIME_32) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Convenience: the content fingerprint of a value, `fnv1a(canonicalJson(v))`. */
export function contentHash(value: unknown): string {
  return fnv1a(canonicalJson(value));
}

// ─────────────────────────────────────────────────────────────────────────────
// 8.4 Watermarks
// ─────────────────────────────────────────────────────────────────────────────

/** A plain numeric literal, the only form compared numerically. */
const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** ISO-8601 instant, compared lexicographically (which is chronological). */
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Total order used for watermark comparison. Numeric when both sides parse as
 * finite numbers; ISO-8601 lexicographic when both are ISO timestamps;
 * otherwise plain string compare. Never throws, for any two strings.
 *
 * Within one class the order is antisymmetric and transitive, so `max` over a set
 * of same-class watermarks is well defined and order-independent — which is what
 * makes `stateSet(semantics: 'watermark')` idempotent and commutative. Mixing
 * classes (a numeric id against a timestamp) falls back to string compare, so
 * streams should keep one watermark shape.
 */
export function compareWatermark(a: string, b: string): -1 | 0 | 1 {
  const left = typeof a === 'string' ? a : String(a ?? '');
  const right = typeof b === 'string' ? b : String(b ?? '');

  if (isNumericWatermark(left) && isNumericWatermark(right)) {
    const an = Number(left);
    const bn = Number(right);
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  }
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** True when the value is a finite plain numeric literal (never `''`). */
export function isNumericWatermark(value: string): boolean {
  if (!NUMERIC_RE.test(value)) return false;
  return Number.isFinite(Number(value));
}

/** True when the value looks like an ISO-8601 date or instant. */
export function isIsoWatermark(value: string): boolean {
  return ISO_RE.test(value);
}

/** The greater of two watermarks under `compareWatermark`. */
export function maxWatermark(a: string, b: string): string {
  return compareWatermark(a, b) >= 0 ? a : b;
}

// ─────────────────────────────────────────────────────────────────────────────
// Store surface these primitives need
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The subset of {@link WorkflowStateStore} these primitives touch, so a caller
 * can pass a narrower test double while every real host store satisfies it.
 * `StateEntry` itself is declared once, in `./data-host.js`.
 */
export type StateStoreLike = Pick<WorkflowStateStore, 'get' | 'set' | 'compareAndSet'>;

/** Optional workflow scope: omit when the caller already scoped its keys. */
export interface StateScopeOptions {
  /** When present, keys are wrapped with `scopedStateKey(workflowId, key)`. */
  readonly workflowId?: string;
}

function scopeIfNeeded(key: string, workflowId?: string): string {
  return workflowId === undefined ? key : scopedStateKey(workflowId, key);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8.2 Delta sync
// ─────────────────────────────────────────────────────────────────────────────

/** One record the delta filter classified as changed. */
export interface DeltaCandidate<T = unknown> {
  /** The record itself, untouched. */
  readonly record: T;
  /** Workflow-scoped key the hash is written to AFTER a successful write. */
  readonly deltaKey: string;
  /** `fnv1a(canonicalJson(record))`. */
  readonly deltaHash: string;
}

export interface DeltaFilterResult<T = unknown> {
  /** Records whose hash is absent or differs, in source order. */
  readonly changed: DeltaCandidate<T>[];
  /** Count of records whose stored hash already matched. */
  readonly skipped: number;
}

/**
 * Splits a record set into the records that changed since the last sync and the
 * count that did not (§8.2).
 *
 * `keyPath` is a dotted path to the record's external id; a record whose delta
 * key is absent or expired counts as changed. The invariant
 * `changed.length + skipped === i` holds after every record and at completion.
 *
 * The hash is deliberately NOT written here — the caller writes it only after the
 * target confirms the write, so a failed write leaves the record classified as
 * changed for the next run.
 */
export async function deltaFilter<T = unknown>(
  records: readonly T[],
  entity: string,
  keyPath: string,
  state: StateStoreLike,
  options: StateScopeOptions = {},
): Promise<DeltaFilterResult<T>> {
  const changed: DeltaCandidate<T>[] = [];
  let skipped = 0;

  for (let i = 0; i < records.length; i++) {
    // Loop invariant: changed.length + skipped === i
    if (changed.length + skipped !== i) {
      throw new Error('deltaFilter: record conservation invariant broken');
    }
    const record = records[i] as T;
    const id = externalIdOf(record, keyPath, i);
    const deltaKey = scopeIfNeeded(deltaStateKey(entity, id), options.workflowId);
    const deltaHash = contentHash(record);
    const previous = await state.get(deltaKey);
    if (previous !== undefined && previous.value === deltaHash) {
      skipped++;
    } else {
      changed.push({ record, deltaKey, deltaHash });
    }
  }

  if (changed.length + skipped !== records.length) {
    throw new Error('deltaFilter: record conservation invariant broken');
  }
  return { changed, skipped };
}

/**
 * The external id used in a record's delta key. A record with no resolvable id at
 * `keyPath` falls back to its content hash, so it is still tracked (and still
 * classified as changed whenever its content changes).
 */
function externalIdOf(record: unknown, keyPath: string, index: number): string {
  const raw = keyPath.trim() ? resolveJsonPath(record, keyPath.trim()) : undefined;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw === 'boolean') return String(raw);
  if (raw !== null && raw !== undefined) return fnv1a(canonicalJson(raw));
  // No id on the record: fall back to the content fingerprint rather than the
  // position, so reordered pages do not shuffle delta keys between records.
  void index;
  return `hash:${contentHash(record)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8.3 Idempotency keys
// ─────────────────────────────────────────────────────────────────────────────

/** Value stored under a claimed idempotency key. */
export const IDEMPOTENCY_CLAIMED = 'claimed';

/**
 * Claims a write. Resolves true when this caller owns it (§8.3).
 *
 * `compareAndSet` is atomic at the host: the DO runs SQLite single-threaded per
 * instance and IndexedDB uses one readwrite transaction, so exactly one of any
 * number of concurrent callers sees `true`. A caller receiving `false` skips the
 * write and increments `SyncSummary.skipped`.
 */
export async function claimIdempotent(
  key: string,
  state: StateStoreLike,
  options: StateScopeOptions & { readonly ttlSec?: number } = {},
): Promise<boolean> {
  const full = scopeIfNeeded(idempotencyStateKey(key), options.workflowId);
  return await state.compareAndSet(full, undefined, IDEMPOTENCY_CLAIMED, {
    ttlSec: options.ttlSec ?? IDEMPOTENCY_TTL_SEC,
  });
}
