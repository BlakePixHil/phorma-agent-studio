/**
 * The `/api/backups/*` response shapes, plus the local state that tracks what has
 * already been uploaded.
 *
 * Structural twin of `cloud/src/backup-routes.ts`. The studio and the worker each
 * declare this contract independently - `frontend/` cannot import from `cloud/` -
 * so a field added on one side and not the other compiles in one package and
 * breaks the other.
 */

import type { WorkflowSpec } from './workflow.model';

/** One connection a backed-up workflow references (Requirement 19.1). */
export interface BackupConnectionRef {
  id: string;
  /** Display name, so a restore can say what to reconnect by NAME not by id. */
  name: string;
}

/**
 * What one revision stores.
 *
 * ID AND DISPLAY NAME ONLY for connections. There is deliberately no field here a
 * secret could occupy, and the worker rebuilds this list rather than trusting it,
 * so a credential cannot ride along even from a misbehaving client.
 */
export interface BackupBody {
  spec: WorkflowSpec;
  connections: BackupConnectionRef[];
}

/** One backup in the account. */
export interface BackupSummary {
  workflowId: string;
  name: string;
  /** Monotonically increasing from 1. The `If-Match` value for the next upload. */
  revision: number;
  /** `fnv1a(canonicalJson(spec))`, comparable with the deployment registry's. */
  specHash: string;
  sizeBytes: number;
  /** The spec's own timestamp at the last accepted upload. */
  savedAt: string;
  /** When the worker last wrote this row. */
  updatedAt: string;
  /**
   * Non-null means a TOMBSTONE: deleted, bodies retained, still restorable. A
   * local library delete never produces one - only an explicit delete does.
   */
  deletedAt: string | null;
  /** Days until a tombstone is removed; null for a live backup. */
  daysRemaining: number | null;
}

/** `GET /api/backups` body. */
export interface BackupListResponse {
  backups: BackupSummary[];
  /**
   * False while the subscription is lapsed: reads keep working, uploads do not.
   * A lapse must never destroy the copy that exists.
   */
  writable: boolean;
  /** Days of read-only access left after a lapse; null when not applicable. */
  readOnlyDaysRemaining: number | null;
  /** Workflows this plan will back up, and how many are used. */
  cap: number;
  used: number;
  /** Revisions retained per workflow, so the studio can state it accurately. */
  revisionsKept: number;
}

/** `GET /api/backups/{id}/revisions` body. */
export interface BackupRevisionsResponse {
  current: number;
  /** Retained revision numbers, newest first. Read from storage, not a counter. */
  revisions: number[];
}

/** `GET /api/backups/{id}/{revision}` body. */
export interface BackupDownloadResponse {
  workflowId: string;
  revision: number;
  savedAt: string;
  spec: WorkflowSpec;
  connections: BackupConnectionRef[];
}

/** `POST /api/backups/{id}` success body. */
export interface BackupUploadResponse {
  ok: true;
  workflowId: string;
  revision: number;
  specHash: string;
  sizeBytes: number;
  prunedRevisions: number;
}

/**
 * The refusal codes the backup routes send.
 *
 * An APPEND-ONLY wire contract, like the five hosted-inference codes: the studio
 * branches on these, so add one, never rename or repurpose one.
 */
export type BackupRefusalCode =
  /** No plan, or the post-lapse read window has closed. */
  | 'no_subscription'
  /** Another machine wrote a newer revision. Carries the real one. */
  | 'backup_conflict'
  /** At the plan's workflow cap and this workflow is new. */
  | 'backup_cap'
  /** Over the per-spec size limit. Nothing was stored. */
  | 'backup_too_large';

/**
 * Per-workflow local state, in the IndexedDB `workflow-backup-state` store.
 *
 * `lastUploadedHash` is what makes the service quiet: a save that leaves the spec
 * semantically identical uploads nothing, so an editing session with autosave on
 * does not become one request per pause.
 */
export interface WorkflowBackupState {
  /** Store key. */
  workflowId: string;
  /** `fnv1a(canonicalJson(spec))` of the last body the worker ACCEPTED. */
  lastUploadedHash: string;
  /** The revision the worker assigned it - the next upload's `If-Match`. */
  revision: number;
  /** ISO timestamp of that upload, for the settings surface. */
  uploadedAt: string;
}
