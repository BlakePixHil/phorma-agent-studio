/**
 * Workflow backup metadata - the D1 half of hosted backup.
 *
 * ## The split, and why
 *
 * Metadata here, bodies in R2 (`backup-store.ts`). A workflow graph is the wrong
 * shape for a D1 row, and D1 is shared with the billing tables that gate every
 * hosted run - so a library of 2MB specs living beside them would put recovery
 * traffic on the same database as entitlement. What this table holds is what a
 * restore needs in order to LIST what is available before downloading anything.
 *
 * ## The invariant this file exists to protect
 *
 * **A backup is not a mirror.** A local delete never propagates. The studio sends
 * no delete of any kind when a workflow leaves the library, and an EXPLICIT
 * delete sets `deleted_at` rather than removing a row - a tombstone whose bodies
 * are still in R2 and still restorable for 30 days. Losing a laptop,
 * uninstalling, or deleting a workflow locally are all recoverable events
 * (Requirement 17).
 *
 * Exactly three paths destroy backup data, and they are all deliberate: the
 * revision retention prune, an explicit purge of a tombstone, and
 * disable-and-delete-all.
 *
 * ## Concurrency
 *
 * `revision` is a per-row counter and the `If-Match` value. Because the primary
 * key is `(tenant_id, workflow_id)` there is exactly one row per workflow, so the
 * concurrency check is a conditional `UPDATE ... WHERE revision = ?` whose
 * `meta.changes` is the single-winner signal - the same idiom `recordRun` uses
 * for its idempotency gate, and for the same reason: a gate computed any other
 * way double-applies on a retry.
 */

import { TIERS, tierLimits, type TenantEnv, type TenantRecord } from './tenants';

/** How long a tombstone stays restorable (Requirement 17.4). */
export const TOMBSTONE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a LAPSED tenant keeps read access to their backups
 * (Requirement 20.1).
 *
 * Deliberately a different number from {@link TOMBSTONE_WINDOW_MS}: one is about
 * a workflow the user deleted, the other about a subscription that stopped
 * paying, and making them equal would invite a future change to one from moving
 * the other.
 */
export const LAPSE_READ_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** Revisions retained per workflow (Requirement 10.7). */
export const REVISIONS_KEPT = 10;

/** Largest uncompressed spec we accept, in bytes (Requirement 10.8). */
export const MAX_SPEC_BYTES = 2 * 1024 * 1024;

/** One backed-up workflow, as the metadata store holds it. */
export interface BackupRecord {
  tenantId: string;
  workflowId: string;
  name: string;
  /** Monotonically increasing from 1. The `If-Match` value. */
  revision: number;
  specHash: string;
  /** Uncompressed JSON byte length of the newest revision. */
  sizeBytes: number;
  /** The spec's own timestamp, from the client. */
  savedAt: string;
  /** When the worker last wrote this row. */
  updatedAt: string;
  /** Non-null means a tombstone: bodies retained, still restorable. */
  deletedAt: string | null;
}

/** What one upload attempt did. */
export type BackupWriteResult =
  | { ok: true; record: BackupRecord }
  /** `If-Match` did not equal the stored revision. Carries the real one. */
  | { ok: false; reason: 'conflict'; revision: number }
  /** The tenant is at their tier's workflow cap and this workflow is new. */
  | { ok: false; reason: 'workflow-cap'; cap: number };

/**
 * The metadata store. Constructed per request, like `TenantStore`, and gated the
 * same way: `enabled` is `Boolean(env.DB)` and nothing here is reachable on a BYO
 * worker (Requirement 9.2).
 */
export class BackupStore {
  constructor(private readonly env: TenantEnv) {}

  /** True when the hosted D1 binding is present. */
  get enabled(): boolean {
    return Boolean(this.env.DB);
  }

  private get db(): D1Database {
    if (!this.env.DB) throw new Error('The backup store requires the DB (D1) binding.');
    return this.env.DB;
  }

  /**
   * One tenant's backups, live rows first and tombstones after, each group
   * newest-first.
   *
   * Tombstones are INCLUDED (Requirement 17.5, 17.9): they are restorable for 30
   * days, and a user needs to see the countdown to act on it. A caller that wants
   * only live rows filters on `deletedAt`.
   */
  async list(tenantId: string): Promise<BackupRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT tenant_id, workflow_id, name, revision, spec_hash, size_bytes,
                saved_at, updated_at, deleted_at
           FROM workflow_backups
          WHERE tenant_id = ?
          ORDER BY deleted_at IS NOT NULL, updated_at DESC`,
      )
      .bind(tenantId)
      .all<BackupRow>();
    return (rows.results ?? []).map(toRecord);
  }

  /** One backup row, tombstone included, or null. */
  async get(tenantId: string, workflowId: string): Promise<BackupRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT tenant_id, workflow_id, name, revision, spec_hash, size_bytes,
                saved_at, updated_at, deleted_at
           FROM workflow_backups
          WHERE tenant_id = ? AND workflow_id = ?`,
      )
      .bind(tenantId, workflowId)
      .first<BackupRow>();
    return row ? toRecord(row) : null;
  }

  /** How many workflows this tenant currently has backed up, tombstones included. */
  async count(tenantId: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM workflow_backups WHERE tenant_id = ?`)
      .bind(tenantId)
      .first<{ n: number | null }>();
    return Number(row?.n ?? 0);
  }

  /**
   * Claims the next revision for one workflow, or refuses.
   *
   * Called BEFORE the body is written, so a refused upload stores nothing
   * (Requirements 10.10, 16.4). The revision it returns is the R2 key segment the
   * caller then writes to.
   *
   * `expectedRevision` is the client's `If-Match`:
   *  - a number must equal the stored revision, or this is a conflict;
   *  - `null` means "I have no revision" and is accepted only for a workflow with
   *    no row yet, so a client that lost its local state cannot silently
   *    overwrite a newer cloud copy.
   *
   * An upload for a TOMBSTONE revives it. That is intentional: the workflow is
   * back in the user's library and being saved, which is a clearer statement of
   * intent than any undelete button, and the tombstone's bodies were never
   * removed.
   */
  async claimRevision(
    tenantId: string,
    workflowId: string,
    expectedRevision: number | null,
    next: { name: string; specHash: string; sizeBytes: number; savedAt: string },
  ): Promise<BackupWriteResult> {
    const now = new Date().toISOString();
    const existing = await this.get(tenantId, workflowId);

    if (!existing) {
      if (expectedRevision !== null && expectedRevision !== 0) {
        // The client believes it has revision N of something this account has
        // never stored. Treat it as a conflict rather than silently starting at 1:
        // the likely cause is a wrong workflow id or a wiped account, and either
        // way the client should re-read before writing.
        return { ok: false, reason: 'conflict', revision: 0 };
      }
      const cap = await this.workflowCap(tenantId);
      if ((await this.count(tenantId)) >= cap) {
        return { ok: false, reason: 'workflow-cap', cap };
      }
      // `INSERT ... ON CONFLICT DO NOTHING` plus a `changes` check, so two
      // simultaneous first uploads cannot both believe they created revision 1.
      const insert = await this.db
        .prepare(
          `INSERT INTO workflow_backups
             (tenant_id, workflow_id, name, revision, spec_hash, size_bytes, saved_at, updated_at, deleted_at)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL)
           ON CONFLICT(tenant_id, workflow_id) DO NOTHING`,
        )
        .bind(tenantId, workflowId, next.name, next.specHash, next.sizeBytes, next.savedAt, now)
        .run();
      if ((insert.meta?.changes ?? 0) === 0) {
        // Somebody else got there first. Report the row they created, so the
        // loser retries against a real revision instead of guessing.
        const winner = await this.get(tenantId, workflowId);
        return { ok: false, reason: 'conflict', revision: winner?.revision ?? 1 };
      }
      return {
        ok: true,
        record: {
          tenantId,
          workflowId,
          name: next.name,
          revision: 1,
          specHash: next.specHash,
          sizeBytes: next.sizeBytes,
          savedAt: next.savedAt,
          updatedAt: now,
          deletedAt: null,
        },
      };
    }

    if (expectedRevision !== null && expectedRevision !== existing.revision) {
      return { ok: false, reason: 'conflict', revision: existing.revision };
    }
    // A null `If-Match` on an EXISTING row is also a conflict: the client is
    // saying it has no revision for a workflow the account already backs up, so
    // accepting it would be last-write-wins over a copy it has never seen
    // (Requirement 16.6 - nothing here merges).
    if (expectedRevision === null) {
      return { ok: false, reason: 'conflict', revision: existing.revision };
    }

    // The conditional UPDATE is the concurrency gate. `meta.changes` is 1 for
    // exactly one of two concurrent uploads carrying the same `If-Match`
    // (Requirement 16.8), because the second one's `WHERE revision = ?` no longer
    // matches. A read-then-write would let both through.
    const update = await this.db
      .prepare(
        `UPDATE workflow_backups
            SET name = ?, revision = revision + 1, spec_hash = ?, size_bytes = ?,
                saved_at = ?, updated_at = ?, deleted_at = NULL
          WHERE tenant_id = ? AND workflow_id = ? AND revision = ?`,
      )
      .bind(
        next.name,
        next.specHash,
        next.sizeBytes,
        next.savedAt,
        now,
        tenantId,
        workflowId,
        expectedRevision,
      )
      .run();
    if ((update.meta?.changes ?? 0) === 0) {
      const current = await this.get(tenantId, workflowId);
      return { ok: false, reason: 'conflict', revision: current?.revision ?? existing.revision };
    }
    return {
      ok: true,
      record: {
        ...existing,
        name: next.name,
        revision: existing.revision + 1,
        specHash: next.specHash,
        sizeBytes: next.sizeBytes,
        savedAt: next.savedAt,
        updatedAt: now,
        deletedAt: null,
      },
    };
  }

  /**
   * Soft-deletes one backup: sets `deleted_at`, retains every body
   * (Requirement 17.4). Idempotent, and it never moves an existing tombstone's
   * clock - re-deleting must not extend the window.
   */
  async softDelete(tenantId: string, workflowId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE workflow_backups
            SET deleted_at = ?, updated_at = ?
          WHERE tenant_id = ? AND workflow_id = ? AND deleted_at IS NULL`,
      )
      .bind(new Date().toISOString(), new Date().toISOString(), tenantId, workflowId)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /** Removes one metadata row outright. The caller deletes its bodies. */
  async hardDelete(tenantId: string, workflowId: string): Promise<boolean> {
    const result = await this.db
      .prepare(`DELETE FROM workflow_backups WHERE tenant_id = ? AND workflow_id = ?`)
      .bind(tenantId, workflowId)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Removes every metadata row for one tenant, returning the workflow ids so the
   * caller can delete their bodies (Requirement 11.6).
   *
   * The ids come back BEFORE the delete for exactly that reason: this table is
   * the only index of which R2 keys belong to a tenant, so dropping the rows
   * first would orphan every object.
   */
  async deleteAllForTenant(tenantId: string): Promise<string[]> {
    const ids = (await this.list(tenantId)).map(record => record.workflowId);
    if (ids.length === 0) return [];
    await this.db.prepare(`DELETE FROM workflow_backups WHERE tenant_id = ?`).bind(tenantId).run();
    return ids;
  }

  /**
   * Tombstones whose 30 day window has elapsed, for the retention sweep
   * (Requirement 17.8). Bounded, so one pass cannot become an unbounded read.
   */
  async expiredTombstones(
    now = Date.now(),
    limit = 500,
  ): Promise<{ tenantId: string; workflowId: string }[]> {
    const cutoff = new Date(now - TOMBSTONE_WINDOW_MS).toISOString();
    const rows = await this.db
      .prepare(
        `SELECT tenant_id, workflow_id
           FROM workflow_backups
          WHERE deleted_at IS NOT NULL AND deleted_at <= ?
          LIMIT ?`,
      )
      .bind(cutoff, limit)
      .all<{ tenant_id: string; workflow_id: string }>();
    return (rows.results ?? []).map(row => ({
      tenantId: row.tenant_id,
      workflowId: row.workflow_id,
    }));
  }

  /** This tenant's workflow-count cap, from their tier. */
  private async workflowCap(tenantId: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT tier FROM tenants WHERE id = ?`)
      .bind(tenantId)
      .first<{ tier: string | null }>();
    return tierLimits(row?.tier ?? 'starter').backupWorkflows;
  }
}

// ── Pure helpers, testable without D1 ────────────────────────────────────────

/**
 * Days left before a tombstone is removed, for the studio's countdown
 * (Requirement 17.9). Clamped at 0 - a tombstone past its window reads as "today"
 * rather than as a negative number, because the sweep is a cron and may not have
 * run yet.
 */
export function tombstoneDaysRemaining(deletedAt: string, now = Date.now()): number {
  const deleted = Date.parse(deletedAt);
  if (!Number.isFinite(deleted)) return 0;
  const remaining = deleted + TOMBSTONE_WINDOW_MS - now;
  return Math.max(0, Math.ceil(remaining / (24 * 60 * 60 * 1000)));
}

/**
 * Whether a lapsed tenant may still READ their backups, and for how long
 * (Requirement 20).
 *
 * The lapse clock is `billingStatusAt` - the `created` of the newest
 * subscription-lifecycle event applied, which for a cancellation IS the
 * cancellation time. It is the honest available clock and needs no new column.
 *
 * When it reads 0 the tenant was deactivated by a hand-run `/api/deactivate`,
 * which is an unordered write and supplies no clock. There is then no date to
 * count from, so reads stay ALLOWED with no expiry: refusing on a missing
 * timestamp would destroy access on the strength of a value we never recorded,
 * and this feature exists to prevent exactly that class of loss.
 */
export function lapseReadAccess(
  tenant: Pick<TenantRecord, 'status' | 'billingStatusAt'>,
  now = Date.now(),
): { allowed: boolean; daysRemaining: number | null } {
  if (tenant.status === 'active') return { allowed: true, daysRemaining: null };
  // `past_due` keeps everything: the tenant has a plan whose payment failed, and
  // requirement 18 keeps their tier, data and runtime key.
  if (tenant.status === 'past_due') return { allowed: true, daysRemaining: null };

  const lapsedAt = tenant.billingStatusAt > 0 ? tenant.billingStatusAt * 1000 : 0;
  if (lapsedAt === 0) return { allowed: true, daysRemaining: null };

  const remaining = lapsedAt + LAPSE_READ_WINDOW_MS - now;
  if (remaining <= 0) return { allowed: false, daysRemaining: 0 };
  return { allowed: true, daysRemaining: Math.ceil(remaining / (24 * 60 * 60 * 1000)) };
}

/** Every tier's backup workflow cap, for the studio's own display. */
export function backupWorkflowCaps(): Record<string, number> {
  return Object.fromEntries(
    Object.entries(TIERS).map(([tier, limits]) => [tier, limits.backupWorkflows]),
  );
}

/** The stored row shape, before it becomes a {@link BackupRecord}. */
interface BackupRow {
  tenant_id: string;
  workflow_id: string;
  name: string;
  revision: number;
  spec_hash: string;
  size_bytes: number;
  saved_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toRecord(row: BackupRow): BackupRecord {
  return {
    tenantId: row.tenant_id,
    workflowId: row.workflow_id,
    name: row.name,
    revision: Number(row.revision ?? 0),
    specHash: row.spec_hash,
    sizeBytes: Number(row.size_bytes ?? 0),
    savedAt: row.saved_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}
