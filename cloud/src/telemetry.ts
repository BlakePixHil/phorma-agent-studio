/**
 * Anonymous usage telemetry, Worker side: the wire model, the validation and
 * sanitization core, the Telemetry_Store schema, and the `POST /telemetry`
 * Ingest_Endpoint.
 *
 * `normalizeRollup` is PURE and total: it either returns a fresh, fully bounded
 * Rollup or `null`, and it never throws for any input. It builds its result from
 * {@link ROLLUP_KEYS} and {@link ENV_KEYS} rather than by spreading the request
 * body, so an unrecognized field is discarded by construction rather than by a
 * deny list (7.6).
 *
 * The {@link Rollup} interface here is a STRUCTURAL TWIN of the studio's
 * (`frontend/src/app/core/telemetry-core.ts`). The two declare the same wire
 * shape independently; there is no import across the package boundary.
 *
 * Nothing in this module reads a network address, a header, a cookie or an
 * account identifier, and the schema below has no column that could hold one.
 */

import { COUNTER_CATALOG, KNOWN_SCHEMA_VERSIONS } from './telemetry-catalog';
import { resolveCoarseGeo } from './telemetry-geo';

// --- Wire model ------------------------------------------------------------

/** Runtime the studio reported executing in. */
export type RuntimeMode = 'desktop' | 'browser';

/** Coarse environment description. Six bounded strings, nothing else. */
export interface ClientEnvironment {
  locale: string;
  timezone: string;
  platform: string;
  osVersion: string;
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
 * The executable statement of the Rollup's closure. {@link normalizeRollup}
 * assembles its result from this list, so a field that is not named here cannot
 * reach the Telemetry_Store.
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

// --- Validation bounds -----------------------------------------------------

/** UUID v4, the only Install_Id shape the Ingest_Endpoint accepts (6.7). */
export const INSTALL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** How far in the past a Metric_Day may sit relative to the request day (6.7). */
export const METRIC_DAY_MAX_AGE_DAYS = 30;

/**
 * How far in the future a Metric_Day may sit. One day, which absorbs a client
 * whose clock or timezone puts it slightly ahead of the Worker (6.7).
 */
export const METRIC_DAY_MAX_FUTURE_DAYS = 1;

/** Every Client_Environment string is truncated to this many code units (6.9). */
export const ENV_FIELD_MAX_LENGTH = 64;

/** Inclusive bounds for a stored Counter value (6.8). */
export const COUNTER_VALUE_MIN = 0;
export const COUNTER_VALUE_MAX = 1_000_000;

/** Stored `runtimeMode` when the reported value is not a known runtime. */
const DEFAULT_RUNTIME_MODE: RuntimeMode = 'browser';

const MS_PER_DAY = 86_400_000;
const METRIC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** `Date` cannot represent an instant beyond this distance from the epoch. */
const MAX_TIME_MS = 8.64e15;

// --- Normalization ---------------------------------------------------------

/**
 * Validates and sanitizes a request body into a Rollup, or returns `null` when
 * the body cannot be stored at all.
 *
 * Rejects (returns `null`) only for the three fields without which a row cannot
 * be keyed or interpreted: a non-UUID v4 `installId`, a `metricDay` that is not
 * a real calendar day inside `[today - 30 days, today + 1 day]`, and a
 * `schemaVersion` outside `KNOWN_SCHEMA_VERSIONS` (6.7).
 *
 * Everything else degrades instead of rejecting. An unusable environment field
 * becomes `''`, and a counter outside the Counter_Catalog or outside
 * `[0, 1000000]` is dropped while its siblings survive (6.8, 6.9). That is
 * deliberate: an older client sending one counter this Worker does not know about
 * should still have the rest of its day recorded.
 */
export function normalizeRollup(body: unknown, nowMs: number): Rollup | null {
  const source = asRecord(body);
  if (source === null) return null;

  const installId = source['installId'];
  if (typeof installId !== 'string' || !INSTALL_ID_PATTERN.test(installId)) return null;

  const metricDay = source['metricDay'];
  if (!isMetricDayInWindow(metricDay, nowMs)) return null;

  const schemaVersion = source['schemaVersion'];
  if (typeof schemaVersion !== 'number' || !KNOWN_SCHEMA_VERSIONS.includes(schemaVersion)) {
    return null;
  }

  const normalized: Rollup = {
    installId: installId.toLowerCase(),
    metricDay,
    env: normalizeEnvironment(source['env']),
    counters: normalizeCounters(source['counters']),
    schemaVersion,
  };
  return pick(normalized, ROLLUP_KEYS);
}

/**
 * The UTC calendar day of `nowMs`, formatted `YYYY-MM-DD`. Non-finite and
 * out-of-range input resolves to the epoch day rather than throwing.
 */
export function metricDayUtc(nowMs: number): string {
  const ms = Number.isFinite(nowMs)
    ? Math.min(Math.max(Math.trunc(nowMs), -MAX_TIME_MS), MAX_TIME_MS)
    : 0;
  return new Date(ms).toISOString().slice(0, 10);
}

/** True when `value` is a real `YYYY-MM-DD` calendar day. */
export function isMetricDay(value: unknown): value is string {
  if (typeof value !== 'string' || !METRIC_DAY_PATTERN.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  // Round-tripping catches `2024-02-30` and friends, which `Date.parse` rolls over.
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

/**
 * True when `value` is a real calendar day inside the accepted ingest window
 * around the request day.
 */
export function isMetricDayInWindow(value: unknown, nowMs: number): value is string {
  if (!isMetricDay(value)) return false;
  const today = Date.parse(`${metricDayUtc(nowMs)}T00:00:00.000Z`);
  const day = Date.parse(`${value}T00:00:00.000Z`);
  return (
    day >= today - METRIC_DAY_MAX_AGE_DAYS * MS_PER_DAY &&
    day <= today + METRIC_DAY_MAX_FUTURE_DAYS * MS_PER_DAY
  );
}

// --- Telemetry_Store schema ------------------------------------------------

/**
 * The Telemetry_Store DDL, one statement per entry, every statement
 * `IF NOT EXISTS` so re-application leaves the schema unchanged (8.4).
 *
 * There is NO column for a city, a postal code, a latitude, a longitude, an
 * autonomous system number, a network address or an account identifier, and none
 * may ever be added (7.4, 7.5).
 *
 * `cloud/migrations/0002_telemetry.sql` carries these statements verbatim and a
 * guard asserts the two cannot drift.
 */
export const TELEMETRY_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS telemetry_rollups (
  install_id     TEXT    NOT NULL,
  metric_day     TEXT    NOT NULL,
  country_code   TEXT    NOT NULL DEFAULT 'XX',
  region         TEXT    NOT NULL DEFAULT 'unknown',
  locale         TEXT    NOT NULL DEFAULT '',
  timezone       TEXT    NOT NULL DEFAULT '',
  platform       TEXT    NOT NULL DEFAULT '',
  os_version     TEXT    NOT NULL DEFAULT '',
  app_version    TEXT    NOT NULL DEFAULT '',
  runtime_mode   TEXT    NOT NULL DEFAULT 'browser',
  counters       TEXT    NOT NULL DEFAULT '{}',
  schema_version INTEGER NOT NULL,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  PRIMARY KEY (install_id, metric_day)
)`,
  `CREATE INDEX IF NOT EXISTS idx_telemetry_metric_day
  ON telemetry_rollups(metric_day)`,
  `CREATE INDEX IF NOT EXISTS idx_telemetry_day_country
  ON telemetry_rollups(metric_day, country_code)`,
  `CREATE TABLE IF NOT EXISTS telemetry_ingest_rate (
  install_id      TEXT    PRIMARY KEY,
  window_start_ms INTEGER NOT NULL,
  request_count   INTEGER NOT NULL
)`,
];

/** Module-level guard: the schema is created at most once per isolate. */
let schemaReady: Promise<void> | null = null;

/**
 * Creates the Telemetry_Store tables and indexes if they are absent, once per
 * isolate.
 *
 * Requirement 8.4 puts schema creation on the Worker, not only on the migration,
 * so a deployment where `wrangler d1 migrations apply` was never run still has
 * self-healing tables. A failed attempt clears the guard, so a transient D1
 * error is retried on the next request instead of being cached for the life of
 * the isolate.
 */
export function ensureTelemetrySchema(db: D1Database): Promise<void> {
  if (schemaReady === null) {
    schemaReady = db
      .batch(TELEMETRY_SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)))
      .then(() => undefined)
      .catch((error: unknown) => {
        schemaReady = null;
        throw error;
      });
  }
  return schemaReady;
}

// --- Ingest route ----------------------------------------------------------

/**
 * The bindings the Ingest_Endpoint touches. `DB` is optional because a BYO
 * deployment has no D1: the route still answers, it just drops the payload
 * (6.12).
 */
export interface TelemetryEnv {
  DB?: D1Database;
}

/** The only path this module owns. */
export const TELEMETRY_PATH = '/telemetry';

/** Largest accepted request body, in bytes. Above this the answer is 413 (6.5). */
export const TELEMETRY_MAX_BODY_BYTES = 16_384;

/** Accepted requests per Install_Id per rolling window before 429 (6.11). */
export const TELEMETRY_RATE_LIMIT = 20;

/** Length of that rolling window. */
export const TELEMETRY_RATE_WINDOW_MS = 3_600_000;

/**
 * CORS for the ingest route, deliberately independent of `ALLOWED_ORIGINS`
 * (6.3). Widening that variable to admit studio origins would widen the
 * authenticated `/api/*` surface at the same time, which is not the trade we
 * want for an anonymous write-only endpoint.
 *
 * An open origin carries nothing here: the route accepts no credentials, reads
 * no cookie, performs no read on the caller's behalf and returns a constant
 * body. There is nothing for a hostile origin to learn.
 */
const TELEMETRY_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

/**
 * The Telemetry_Store upsert.
 *
 * `?13` is bound to the ingest time and fills both timestamp columns, but
 * `first_seen_at` is ABSENT from the `DO UPDATE SET` list, so it survives every
 * replace. Counters and environment are replaced wholesale rather than merged,
 * which is exactly the supersede semantics the cumulative client seal produces
 * (6.10).
 */
export const TELEMETRY_ROLLUP_UPSERT = `INSERT INTO telemetry_rollups (
  install_id, metric_day, country_code, region, locale, timezone, platform,
  os_version, app_version, runtime_mode, counters, schema_version,
  first_seen_at, last_seen_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
ON CONFLICT(install_id, metric_day) DO UPDATE SET
  country_code = excluded.country_code,
  region       = excluded.region,
  locale       = excluded.locale,
  timezone     = excluded.timezone,
  platform     = excluded.platform,
  os_version   = excluded.os_version,
  app_version  = excluded.app_version,
  runtime_mode = excluded.runtime_mode,
  counters     = excluded.counters,
  schema_version = excluded.schema_version,
  last_seen_at = excluded.last_seen_at`;

/**
 * The rate-window upsert. `?1` is the Install_Id, `?2` the ingest time, `?3` the
 * window length.
 *
 * One statement covers both branches: a request that lands after the stored
 * window elapsed starts a fresh window at count 1, and a request inside it
 * increments. Doing it in SQL keeps the whole accepted path to a single
 * `batch()` and leaves no read-modify-write gap between the two rows.
 */
export const TELEMETRY_RATE_UPSERT = `INSERT INTO telemetry_ingest_rate (
  install_id, window_start_ms, request_count
) VALUES (?1, ?2, 1)
ON CONFLICT(install_id) DO UPDATE SET
  window_start_ms = CASE
    WHEN ?2 - telemetry_ingest_rate.window_start_ms >= ?3 THEN ?2
    ELSE telemetry_ingest_rate.window_start_ms
  END,
  request_count = CASE
    WHEN ?2 - telemetry_ingest_rate.window_start_ms >= ?3 THEN 1
    ELSE telemetry_ingest_rate.request_count + 1
  END`;

/**
 * Handles `POST /telemetry`. Returns `null` for any other path, so the caller
 * falls through to the rest of the Worker - the same convention
 * `handleStatusRequest` follows, which keeps `index.ts` a readable ordered
 * chain.
 *
 * Every failure exit answers a FIXED LITERAL body. No response carries request
 * content, an exception message or a binding name (6.13), and the only log line
 * in the module is a fixed string with no request data (7.7). Only `countryCode`
 * and `region` reach a write: the network address, `CF-Connecting-IP`,
 * `X-Forwarded-For`, the city, the postal code, the latitude, the longitude and
 * the ASN are never read and have no column (7.4, 7.5).
 *
 * A throw anywhere inside is caught here and answered `200 {}`. Telemetry is not
 * worth a 500, and a 500 body is one more place an exception message could
 * escape.
 */
export async function handleTelemetryRequest(
  request: Request,
  env: TelemetryEnv,
  _ctx?: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== TELEMETRY_PATH) return null;

  if (request.method === 'OPTIONS') return new Response(null, { headers: TELEMETRY_CORS });
  if (request.method !== 'POST') return ingestError(405, 'Method not allowed.');

  try {
    return await ingest(request, env);
  } catch {
    // Fixed string, no request data, no exception message.
    console.error('telemetry ingest failed');
    return ingestAccepted();
  }
}

/** The eight-step ingest pipeline. Exactly one exit per step. */
async function ingest(request: Request, env: TelemetryEnv): Promise<Response> {
  // 1. No D1 on this deployment: accept and drop, without reading or writing
  //    anything, so a BYO Worker is not a broken endpoint (6.12).
  const db = env.DB;
  if (!db) return ingestAccepted();

  // 2. Size cap, through a reader that stops at the limit so a lying or
  //    oversized `Content-Length` cannot force an unbounded allocation (6.5).
  const raw = await readCappedBody(request);
  if (raw === null) return ingestError(413, 'Payload too large.');

  // 3. Parse and 4. validate collapse into one static 400 (6.6).
  const now = Date.now();
  const rollup = normalizeRollup(parseJson(raw), now);
  if (rollup === null) return ingestError(400, 'Invalid telemetry payload.');

  await ensureTelemetrySchema(db);

  // 5. Rolling per-install window (6.11).
  if (await isRateLimited(db, rollup.installId, now)) {
    return ingestError(429, 'Too many requests.');
  }

  // 6. Coarse geography, the only request metadata that is ever stored (7.4).
  const geo = resolveCoarseGeo(request);

  // 7. One batch: the rollup upsert and the rate-window upsert.
  await db.batch([
    db
      .prepare(TELEMETRY_ROLLUP_UPSERT)
      .bind(
        rollup.installId,
        rollup.metricDay,
        geo.countryCode,
        geo.region,
        rollup.env.locale,
        rollup.env.timezone,
        rollup.env.platform,
        rollup.env.osVersion,
        rollup.env.appVersion,
        rollup.env.runtimeMode,
        JSON.stringify(rollup.counters),
        rollup.schemaVersion,
        now,
      ),
    db
      .prepare(TELEMETRY_RATE_UPSERT)
      .bind(rollup.installId, now, TELEMETRY_RATE_WINDOW_MS),
  ]);

  // 8. Answer.
  return ingestAccepted();
}

/**
 * True when this Install_Id has already had {@link TELEMETRY_RATE_LIMIT}
 * accepted requests inside the current window. A window that has elapsed, a
 * missing row and an unreadable row all read as not limited: the upsert restarts
 * the window on the same request.
 */
async function isRateLimited(db: D1Database, installId: string, nowMs: number): Promise<boolean> {
  const row = await db
    .prepare(
      'SELECT window_start_ms, request_count FROM telemetry_ingest_rate WHERE install_id = ?1',
    )
    .bind(installId)
    .first<{ window_start_ms: number; request_count: number }>();
  if (row === null) return false;
  const windowStart = Number(row.window_start_ms);
  const count = Number(row.request_count);
  if (!Number.isFinite(windowStart) || !Number.isFinite(count)) return false;
  if (nowMs - windowStart >= TELEMETRY_RATE_WINDOW_MS) return false;
  return count >= TELEMETRY_RATE_LIMIT;
}

/** The one success body: an empty JSON object, for every accepted request (6.4). */
function ingestAccepted(): Response {
  return new Response('{}', {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...TELEMETRY_CORS },
  });
}

/**
 * A failure answer. `reason` is always a literal from this module, never derived
 * from the request or from an exception (6.13).
 */
function ingestError(status: number, reason: string): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status,
    headers: { 'Content-Type': 'application/json', ...TELEMETRY_CORS },
  });
}

/** `JSON.parse` that yields `undefined` instead of throwing, so step 3 and step 4 share one exit. */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Reads the body as text, or returns `null` once it exceeds
 * {@link TELEMETRY_MAX_BODY_BYTES}.
 *
 * A declared `Content-Length` above the cap short-circuits, but it is never
 * TRUSTED: the stream is consumed chunk by chunk and abandoned the moment the
 * running total passes the cap, so neither an oversized nor a lying header can
 * force an unbounded allocation. Exactly the cap is accepted; above it is not.
 */
async function readCappedBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > TELEMETRY_MAX_BODY_BYTES) return null;

  const body = request.body;
  if (body === null) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > TELEMETRY_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Invalid UTF-8 decodes to replacement characters, which then fails the parse
  // step as a plain static 400 rather than throwing here.
  return new TextDecoder().decode(merged);
}

// --- Retention -------------------------------------------------------------

/** Maximum age of a stored Rollup row, in days (the Retention_Window, 8.5). */
export const TELEMETRY_RETENTION_DAYS = 400;

/**
 * Maximum age of a `telemetry_ingest_rate` row. The rolling window itself is one
 * hour, so anything older than a day is dead weight the pass reclaims.
 */
export const TELEMETRY_RATE_ROW_MAX_AGE_MS = 24 * 3_600_000;

/** Expired Rollup rows. `?1` is the oldest Metric_Day the window still keeps. */
export const TELEMETRY_ROLLUP_PRUNE = 'DELETE FROM telemetry_rollups WHERE metric_day < ?1';

/** Stale rate windows. `?1` is the oldest `window_start_ms` worth keeping. */
export const TELEMETRY_RATE_PRUNE = 'DELETE FROM telemetry_ingest_rate WHERE window_start_ms < ?1';

/**
 * The scheduled retention pass: deletes every Telemetry_Store row whose
 * Metric_Day is older than the Retention_Window, plus every rate window older
 * than a day (8.5). `scheduled()` in `index.ts` runs it daily (8.6).
 *
 * Returns immediately when `DB` is absent, so a BYO deployment does nothing here
 * - it never had a row to prune.
 *
 * Both deletes go out as ONE `batch()`, which D1 runs as a single transaction:
 * either both prunes commit or neither does, so a failure leaves every existing
 * row exactly where it was (8.7). The pass writes nothing else and holds no
 * module state of its own, so a rejection leaves nothing partial behind for a
 * later Ingest_Endpoint request to trip over. The `.catch()` at the call site is
 * the outer containment: a rejected retention promise must not surface as a
 * Worker error.
 */
export async function runTelemetryRetention(env: TelemetryEnv): Promise<void> {
  const db = env.DB;
  if (!db) return;

  // Self-healing, exactly as on the ingest path: a deployment where migrations
  // were never applied has no table to delete from. A failure here clears the
  // guard rather than caching it, so ingest retries on its next request.
  await ensureTelemetrySchema(db);

  const now = Date.now();
  const oldestDay = metricDayUtc(now - TELEMETRY_RETENTION_DAYS * MS_PER_DAY);
  await db.batch([
    db.prepare(TELEMETRY_ROLLUP_PRUNE).bind(oldestDay),
    db.prepare(TELEMETRY_RATE_PRUNE).bind(now - TELEMETRY_RATE_ROW_MAX_AGE_MS),
  ]);
}

// --- Internals -------------------------------------------------------------

/** Builds a fresh object holding exactly `keys`, in `keys` order. */
function pick<T extends object, K extends readonly (keyof T)[]>(
  source: T,
  keys: K,
): Pick<T, K[number]> {
  const out: Record<PropertyKey, unknown> = {};
  for (const key of keys) out[key as PropertyKey] = source[key];
  return out as unknown as Pick<T, K[number]>;
}

/** The body as a plain record, or `null` for anything else (including arrays). */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * The six environment fields, each coerced, trimmed and truncated, built from
 * {@link ENV_KEYS} so an extra field on the wire has nowhere to land.
 */
function normalizeEnvironment(value: unknown): ClientEnvironment {
  const source = asRecord(value) ?? {};
  const normalized: ClientEnvironment = {
    locale: envString(source['locale']),
    timezone: envString(source['timezone']),
    platform: envString(source['platform']),
    osVersion: envString(source['osVersion']),
    appVersion: envString(source['appVersion']),
    runtimeMode: source['runtimeMode'] === 'desktop' ? 'desktop' : DEFAULT_RUNTIME_MODE,
  };
  return pick(normalized, ENV_KEYS);
}

/**
 * A string, number or boolean trimmed and truncated to 64 code units. Anything
 * else, including an object with a hostile `toString`, becomes `''` - the field
 * is always a bounded string and this never throws.
 */
function envString(value: unknown): string {
  let raw: string;
  if (typeof value === 'string') raw = value;
  else if (typeof value === 'number') raw = Number.isFinite(value) ? String(value) : '';
  else if (typeof value === 'boolean') raw = String(value);
  else return '';
  return raw.trim().slice(0, ENV_FIELD_MAX_LENGTH);
}

/**
 * A fresh counter map holding only Counter_Catalog names with integer values in
 * `[0, 1000000]`. Every other entry is dropped, and dropping never rejects the
 * request.
 */
function normalizeCounters(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const source = asRecord(value);
  if (source === null) return out;
  for (const [name, raw] of Object.entries(source)) {
    if (!COUNTER_CATALOG.has(name)) continue;
    if (typeof raw !== 'number' || !Number.isInteger(raw)) continue;
    if (raw < COUNTER_VALUE_MIN || raw > COUNTER_VALUE_MAX) continue;
    out[name] = raw;
  }
  return out;
}
