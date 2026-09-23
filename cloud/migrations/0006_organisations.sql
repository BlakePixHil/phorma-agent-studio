-- Phorma Cloud (hosted mode) - organisations, capability levels, proposals,
-- impersonation audit and the backup body-key column.
--
-- Applied with:  npx wrangler d1 migrations apply phorma-cloud --env hosted --remote
-- BYO deployments never bind D1 and never run these.
--
-- Additive only: four new tables, two indexes each at most, and ONE new column
-- that existing rows read as NULL. Nothing rewrites and nothing drops, so the
-- currently deployed worker keeps working after this is applied and the deploy
-- can follow the migration rather than having to land with it.
--
-- 0006, not 0005. 0005 is the workflow backup schema and is applied remotely;
-- a number already taken would be recorded as done and silently never run.
--
-- Like 0003 and unlike 0001/0002 this file is NOT self-healing: SQLite has no
-- `ADD COLUMN IF NOT EXISTS`, so re-running the ALTER below errors rather than
-- no-opping, and wrangler's `d1_migrations` bookkeeping is the only thing that
-- stops a second application. Never hand-run this file through `d1 execute`.
--
-- Feature: multi-organisation-phorma, Requirements 4, 5, 11, 13, 14.

-- ── Capability level per member, per organisation ───────────────────────────
--
-- The AUTHORITATIVE source for `resolveRole` (design section 2.5). A `device`
-- credential carries no Clerk role claim at all, so for that credential kind
-- this table is the only source; the `CLERK_ROLE_LEVELS` claim mapping survives
-- as an OPTIMISATION for a `clerk` credential. Read behind the same 60s KV cache
-- `TenantStore.getTenant` uses, so it is not a per-request D1 hit.
--
-- It is also what a named organisation is confirmed against: `X-Phorma-Owner`
-- names an organisation, and the membership row here is what lets it resolve, so
-- a revoked membership bites on the NEXT request rather than when a credential
-- expires (Requirements 20.10, 20.11).
--
-- `level` is a TEXT token and not an integer: an ordinal persisted here means
-- something different the day a level is inserted between two existing ones,
-- silently, with no type error. Append-only vocabulary (Requirement 5.11).
--
-- No CHECK constraint on the vocabulary, for 0003's reason: SQLite would enforce
-- it, but adding a fifth level later would then need a table rebuild in a file
-- whose whole premise is that it is additive, and the only writer is one
-- server-side handler.
CREATE TABLE IF NOT EXISTS org_members (
  org_id     TEXT NOT NULL,              -- `org_...`, an Owner_Id
  user_id    TEXT NOT NULL,              -- `user_...`, a Clerk user id
  level      TEXT NOT NULL,              -- operator|editor|builder|admin
  invited_by TEXT,                       -- acting user id, audit only
  created_at TEXT NOT NULL,              -- ISO 8601 UTC
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

-- One member's level across every organisation they belong to. The PK serves the
-- hot read (`org_id` + `user_id`); this serves "which organisations am I in",
-- which the studio needs to offer an organisation switcher.
CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);

-- ── Proposals ───────────────────────────────────────────────────────────────
--
-- METADATA ONLY. The body is a gzipped, encrypted object in R2 under
-- `proposal/{owner_id}/{workflow_id}/{proposal_id}` (Requirement 11.3), for the
-- same reason a backup body is: a workflow graph is the wrong shape for a D1
-- row, and D1 is shared with the billing tables that gate every hosted run.
--
-- `id INTEGER PRIMARY KEY AUTOINCREMENT` plus a separate TEXT `proposal_id` is
-- the `credit_grants` shape, and it is deliberate. `id` is an alias for the
-- rowid, so it is monotonic per insert, never reused after a delete
-- (AUTOINCREMENT keeps a high-water mark in `sqlite_sequence`), and `ORDER BY id`
-- is stable FIFO. The retention prune MUST order by it and NEVER by `created_at`:
-- `created_at` is a TEXT ISO string and 0003 already recorded that two rows
-- written by one pass tie to the millisecond, which makes the draw order
-- arbitrary. `proposal_id` is what travels on the wire, so a client never sees a
-- rowid and a rowid is never part of a URL.
--
-- `live_spec_hash` is the Canonical_Spec_Hash of the DEPLOYED spec at creation
-- time, frozen in a column for the same reason `credit_grants.cost_usd` is
-- frozen: it records the fact that was true when the row was written, and
-- recomputing it at read time would silently re-answer the staleness question
-- against a spec that has since changed.
--
-- `body_key` is stored rather than derived, so an ownership transfer changes
-- `owner_id` without rewriting or re-uploading an R2 object - the same reason
-- `workflow_backups.body_key` exists below.
CREATE TABLE IF NOT EXISTS workflow_proposals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id    TEXT NOT NULL UNIQUE,   -- wire id, `prop-...`
  owner_id       TEXT NOT NULL,          -- `org_...` or `user_...`
  workflow_id    TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  status         TEXT NOT NULL,          -- pending|published|rejected|superseded
  revision       INTEGER NOT NULL DEFAULT 1,  -- the conditional-update guard
  spec_hash      TEXT NOT NULL,          -- fnv1a(canonicalJson(proposed spec))
  live_spec_hash TEXT NOT NULL,          -- the deployed hash when this was made
  body_key       TEXT NOT NULL,          -- full R2 object key
  reason         TEXT,                   -- optional rejection reason
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- THE SINGLE-PENDING INVARIANT, enforced by the database rather than by the
-- order of two statements (Requirement 12.5).
--
-- PARTIAL, so it constrains only `pending` rows and leaves any number of
-- terminal ones. A second pending proposal for the same workflow is a
-- constraint violation, which is what makes the supersede-and-insert batch
-- atomic-or-nothing: if the supersede does not land, the insert cannot.
--
-- Note the contrast with 0003's `idx_tenants_stripe_customer`, where the WHERE
-- clause was documentation because SQLite already treats NULLs as distinct. Here
-- `status` is NOT NULL, so the WHERE clause is the enforcement.
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_pending
  ON workflow_proposals(owner_id, workflow_id)
  WHERE status = 'pending';

-- The list read ("this workflow's proposals, newest first") and the prune read
-- ("non-pending rows past the tenth"). Both are per (owner, workflow), both run
-- on a route a human is waiting on, and both need the `id` ordering. `id` is the
-- rowid, and every SQLite index appends the rowid to its key, so this index
-- physically IS `(owner_id, workflow_id, status, id)` and supplies the ordering
-- with no temp B-tree. Verify with EXPLAIN QUERY PLAN before assuming it still
-- does: the control that proves the planner is not skipping a cheap sort is that
-- `ORDER BY created_at` over the same rows adds `USE TEMP B-TREE FOR ORDER BY`.
CREATE INDEX IF NOT EXISTS idx_proposals_workflow
  ON workflow_proposals(owner_id, workflow_id, status);

-- ── Ownership claims (Requirement 3.9) ──────────────────────────────────────
--
-- Append-only. No UPDATE and no DELETE statement exists for this table anywhere
-- in the worker, and there is no retention sweep: it grows by one row per claim,
-- and a claim happens once per pre-pivot deployment, ever.
CREATE TABLE IF NOT EXISTS ownership_claims (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id       TEXT NOT NULL,
  previous_owner_id TEXT NOT NULL,
  new_owner_id      TEXT NOT NULL,
  acting_user_id    TEXT NOT NULL,
  at                TEXT NOT NULL        -- ISO 8601 UTC
);

CREATE INDEX IF NOT EXISTS idx_claims_new_owner ON ownership_claims(new_owner_id, id);

-- ── Impersonation audit (Requirement 14.8) ──────────────────────────────────
--
-- Append-only, same rules, and one more: `path` is stored WITHOUT the query
-- string. A query string carries cursors and, on some routes, values that have no
-- business being copied into a second table - the same reasoning that kept a raw
-- payload column out of `stripe_events`.
--
-- No retention sweep, deliberately: an audit you prune is an audit with a hole,
-- and impersonation is a support action measured in dozens per day.
CREATE TABLE IF NOT EXISTS impersonation_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  acting_user_id TEXT NOT NULL,          -- the operator
  owner_id       TEXT NOT NULL,          -- who they read as
  method         TEXT NOT NULL,
  path           TEXT NOT NULL,          -- no query string
  at             TEXT NOT NULL           -- ISO 8601 UTC
);

CREATE INDEX IF NOT EXISTS idx_impersonation_owner ON impersonation_audit(owner_id, id);

-- ── The backup body key (Requirement 4.7) ───────────────────────────────────
--
-- `bodyKey()` puts the tenant FIRST (`backup/{tenant}/{workflow}/{revision}`),
-- which is what makes a per-tenant prefix scan possible and also what would force
-- copying every object on an ownership change. Storing the prefix in force for
-- this row means a transfer changes `tenant_id` and leaves the objects exactly
-- where they are.
--
-- NULLABLE, and a NULL reads as the derived legacy value, so no backfill is
-- needed and every row written before this column existed keeps resolving.
ALTER TABLE workflow_backups ADD COLUMN body_key TEXT;

-- END OF THE ORGANISATION SCHEMA.
--
-- Per the header: wrangler records a migration as applied by FILENAME, so
-- anything appended below this line after 0006 has been applied to the remote
-- database would silently never run. Every further schema change belongs in 0007.
