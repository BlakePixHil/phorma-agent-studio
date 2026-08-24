-- Phorma Cloud (hosted mode) - anonymous product telemetry store.
--
-- Applied with:  npx wrangler d1 migrations apply phorma-cloud --env hosted
-- BYO deployments never bind D1 and never run these.
--
-- These statements are carried verbatim by TELEMETRY_SCHEMA_STATEMENTS in
-- cloud/src/telemetry.ts, which applies the same DDL from the Worker once per
-- isolate so the tables are self-healing when migrations were never applied.
-- A guard asserts the two cannot drift - edit both or neither.

-- Anonymous product telemetry. One row per install per UTC calendar day.
-- No column here may ever carry user content, a network address, or an
-- account identifier.
CREATE TABLE IF NOT EXISTS telemetry_rollups (
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
);

CREATE INDEX IF NOT EXISTS idx_telemetry_metric_day
  ON telemetry_rollups(metric_day);
CREATE INDEX IF NOT EXISTS idx_telemetry_day_country
  ON telemetry_rollups(metric_day, country_code);

-- Per-install ingest rate window. Pruned by the retention pass.
CREATE TABLE IF NOT EXISTS telemetry_ingest_rate (
  install_id      TEXT    PRIMARY KEY,
  window_start_ms INTEGER NOT NULL,
  request_count   INTEGER NOT NULL
);
