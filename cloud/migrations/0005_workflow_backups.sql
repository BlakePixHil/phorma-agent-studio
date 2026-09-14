-- Phorma Cloud (hosted mode) - workflow backup metadata.
--
-- Applied with:  npx wrangler d1 migrations apply phorma-cloud --env hosted
-- BYO deployments never bind D1 and never run these.
--
-- Additive only: one new table and its indexes, nothing altered and nothing
-- dropped, so the currently deployed worker keeps working after this is applied
-- and the deploy can follow the migration rather than having to land with it.
--
-- 0005, not 0003. Wrangler records a migration as applied by FILENAME, so a
-- number that is already taken would be recorded as done and silently never run.
-- 0003 is the Stripe billing schema and 0004 the per-field billing clocks; both
-- are applied remotely (verified 2026-09-09).
--
-- Feature: cloud-workflow-backup, Requirement 9.

-- ── One row per backed-up workflow ──────────────────────────────────────────
--
-- METADATA ONLY. The spec itself is a gzipped, encrypted object in R2 at
-- `backup/{tenant_id}/{workflow_id}/{revision}` (Requirement 9.4), because a
-- workflow graph is the wrong shape for a D1 row and because D1 is shared with
-- the billing tables that gate every hosted run. What lives here is what a
-- restore needs in order to LIST what is available before downloading anything.
--
-- The primary key is `(tenant_id, workflow_id)` and not an autoincrement id:
-- there is exactly one row per workflow per tenant, and `revision` counts up
-- inside it. That shape is what makes the optimistic-concurrency check a
-- conditional UPDATE on a single row rather than a read-then-write race
-- (Requirement 16).
CREATE TABLE IF NOT EXISTS workflow_backups (
  -- Clerk user id, matching `tenants.id`.
  tenant_id TEXT NOT NULL,
  -- Library workflow id. Also the R2 key segment and the DO instance name.
  workflow_id TEXT NOT NULL,
  -- Display name at the last accepted upload, so a restore list reads as names
  -- rather than ids without fetching a single body.
  name TEXT NOT NULL,
  -- Monotonically increasing per row, starting at 1. The `If-Match` value.
  revision INTEGER NOT NULL DEFAULT 0,
  -- `fnv1a(canonicalJson(spec))` of the newest revision. Lets a client tell a
  -- drifted local copy from an identical one with no download.
  spec_hash TEXT NOT NULL,
  -- Uncompressed JSON byte length of the newest revision, for the 2MB cap and
  -- for showing a user what their backups actually weigh.
  size_bytes INTEGER NOT NULL DEFAULT 0,
  -- ISO 8601. `saved_at` is the spec's own timestamp from the client;
  -- `updated_at` is when this row was last written by the worker. They differ,
  -- and conflating them would make a clock skew look like a lost upload.
  saved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- SOFT DELETE (Requirement 17). Non-null means a tombstone: the bodies are
  -- still in R2 and still restorable for 30 days. This column is the whole
  -- reason a local delete can never destroy a backup - the studio sends no
  -- delete at all, and an explicit one sets this rather than removing anything.
  deleted_at TEXT,
  PRIMARY KEY (tenant_id, workflow_id)
);

-- The list query: one tenant's backups, tombstones last. Covers both the
-- "what can I restore" read and the per-tenant workflow-count cap.
CREATE INDEX IF NOT EXISTS idx_backups_tenant
  ON workflow_backups(tenant_id, deleted_at);

-- The retention sweep: every tombstone past its 30 day window, across tenants.
-- PARTIAL, so it indexes only rows the sweep can possibly act on - which is a
-- small minority of the table and stays that way.
CREATE INDEX IF NOT EXISTS idx_backups_tombstones
  ON workflow_backups(deleted_at)
  WHERE deleted_at IS NOT NULL;
