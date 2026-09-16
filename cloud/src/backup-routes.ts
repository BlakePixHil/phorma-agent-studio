/**
 * `/api/backups/*` - the hosted workflow backup surface.
 *
 *   GET    /api/backups                          -> the account's backups + state
 *   POST   /api/backups/{workflowId}              -> upload a revision (If-Match)
 *   GET    /api/backups/{workflowId}/revisions    -> retained revision numbers
 *   GET    /api/backups/{workflowId}/{revision}   -> one body
 *   DELETE /api/backups/{workflowId}              -> soft delete (tombstone)
 *   DELETE /api/backups/{workflowId}?purge=1      -> destroy one tombstone
 *   DELETE /api/backups                           -> destroy everything (opt out)
 *
 * ## Placement
 *
 * Mounted BELOW the `store.enabled` gate in `routeApiRequest`, unlike
 * `/api/deployments`. That asymmetry is deliberate: the deployment registry lives
 * in a Durable Object a BYO worker binds too, while backup needs D1 and R2 that
 * only the hosted deployment has. On a BYO worker this whole surface is ABSENT
 * rather than broken, and those users get the file-based library export instead.
 *
 * ## Reads and writes are gated differently
 *
 * Writing needs an ACTIVE subscription. Reading survives a lapse for 90 days
 * (Requirement 20), because a subscription ending must not destroy the copy that
 * exists - the entire premise here is that a backup outlives the thing that
 * created it. `past_due` keeps both, matching requirement 18's rule that a failed
 * payment costs a tenant nothing but hosted runs.
 *
 * ## A backup is not a mirror
 *
 * The studio sends NO delete when a workflow leaves the local library. An explicit
 * delete here sets a tombstone whose bodies stay in R2 and stay restorable for 30
 * days. Exactly three paths destroy data - the revision prune, an explicit purge
 * of a tombstone, and delete-all - and each one is named in the code below so a
 * fourth cannot appear by accident.
 */

import { canonicalJson, fnv1a, type WorkflowSpec } from '@phorma/engine';

import { verifyRequest, type AuthEnv } from './auth';
import {
  BackupStore,
  MAX_SPEC_BYTES,
  REVISIONS_KEPT,
  lapseReadAccess,
  tombstoneDaysRemaining,
  type BackupRecord,
} from './backups';
import { BackupBodyStore, type BackupBodyEnv } from './backup-store';
import { TenantStore, tierLimits, type TenantEnv, type TenantRecord } from './tenants';

/** Prefix this module answers. */
export const BACKUPS_PREFIX = '/api/backups';

/** Bindings the backup surface needs. */
export type BackupRoutesEnv = AuthEnv & TenantEnv & BackupBodyEnv;

/**
 * A workflow id, as an R2 key segment.
 *
 * Bounded HARD, because this value becomes a path segment in
 * `backup/{tenant}/{workflowId}/{revision}`: a `/` would forge a nested key, `..`
 * would be read as traversal by anything later that resolves the path, and a `:`
 * would collide with the deployment registry's separator. Every id this product
 * mints is `wf-<base36>-<hex>`, so the pattern is generous rather than tight - it
 * has to keep accepting legacy `wf-<base36>` ids too.
 */
const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function isBackupWorkflowId(value: unknown): value is string {
  return typeof value === 'string' && WORKFLOW_ID_PATTERN.test(value);
}

/**
 * One connection a backed-up workflow references (Requirement 19.1).
 *
 * ID AND DISPLAY NAME ONLY. A restore needs to tell the user which connections to
 * reconnect, and it needs nothing else to do that - so there is no field here a
 * secret could occupy, and {@link readConnections} discards anything extra rather
 * than storing it.
 */
export interface BackupConnectionRef {
  id: string;
  name: string;
}

/** What one stored revision contains. */
export interface BackupBody {
  spec: WorkflowSpec;
  connections: BackupConnectionRef[];
}

/**
 * One backup in a list response. Structural twin of `BackupSummary` in
 * `frontend/src/app/core/backup.model.ts`.
 */
export interface BackupSummary {
  workflowId: string;
  name: string;
  revision: number;
  specHash: string;
  sizeBytes: number;
  savedAt: string;
  updatedAt: string;
  /** Non-null means a tombstone, still restorable. */
  deletedAt: string | null;
  /** Days until a tombstone is removed; null for a live backup. */
  daysRemaining: number | null;
}

/** `GET /api/backups` body. */
export interface BackupListResponse {
  backups: BackupSummary[];
  /** False while the subscription is lapsed: reads work, uploads do not. */
  writable: boolean;
  /** Days of read-only access left after a lapse; null when not applicable. */
  readOnlyDaysRemaining: number | null;
  /** Workflows this plan will back up, and how many are used. */
  cap: number;
  used: number;
  /** Revisions retained per workflow, so the studio can say so accurately. */
  revisionsKept: number;
}

type Respond = (body: unknown, status?: number) => Response;

/**
 * Answers anything under `/api/backups`, or null when the path is for another
 * module.
 */
export async function handleBackupRequest(
  request: Request,
  env: BackupRoutesEnv,
  url: URL,
  respond: Respond,
): Promise<Response | null> {
  if (url.pathname !== BACKUPS_PREFIX && !url.pathname.startsWith(`${BACKUPS_PREFIX}/`)) {
    return null;
  }

  const auth = await verifyRequest(env, request);
  if (!auth?.userId) return respond({ error: 'Unauthorized.' }, 401);
  const tenantId = auth.userId;

  const tenants = new TenantStore(env);
  const meta = new BackupStore(env);
  const bodies = new BackupBodyStore(env);

  // The two bindings this surface cannot work without, named separately so an
  // operator is sent to the right place (Requirement 9.3, 11.2).
  if (!meta.enabled) {
    return respond({ error: 'Backup is not available on this deployment.' }, 501);
  }
  const missing = bodies.unavailable();
  if (missing) {
    return respond(
      {
        error:
          missing.reason === 'no-bucket'
            ? 'Backup is not available on this deployment: no backup storage is bound.'
            : 'Backup is not available on this deployment: KEY_ENC_SECRET is not set, and a ' +
              'backup is never stored unencrypted.',
      },
      501,
    );
  }

  const tenant = await tenants.getTenant(tenantId);
  // No tenant row means no plan has ever existed, so there is nothing to read and
  // nothing to write. Deliberately 402 rather than 403: this is a billing state.
  if (!tenant) {
    return respond(
      { error: 'Cloud backup needs a Phorma Cloud plan. Visit Settings > Cloud to subscribe.', code: 'no_subscription' },
      402,
    );
  }
  const access = lapseReadAccess(tenant);
  if (!access.allowed) {
    return respond(
      {
        error:
          'Your Phorma Cloud backups are no longer available: the read-only window after a ' +
          'cancelled subscription has closed. Renew to start backing up again.',
        code: 'no_subscription',
      },
      402,
    );
  }

  const tail = url.pathname.slice(BACKUPS_PREFIX.length).replace(/^\//, '');
  const segments = tail.length > 0 ? tail.split('/') : [];

  // ── GET /api/backups - the account's backups and its backup state ─────────
  if (request.method === 'GET' && segments.length === 0) {
    const records = await meta.list(tenantId);
    return respond({
      backups: records.map(toSummary),
      writable: tenant.status === 'active' || tenant.status === 'past_due',
      readOnlyDaysRemaining: access.daysRemaining,
      cap: tierLimits(tenant.tier).backupWorkflows,
      used: records.length,
      revisionsKept: REVISIONS_KEPT,
    } satisfies BackupListResponse);
  }

  // ── DELETE /api/backups - disable and delete everything ───────────────────
  //
  // One of the three paths that destroys backup data, and the only one a user
  // reaches on privacy grounds (Requirement 11.5, 11.6). Metadata rows carry the
  // only index of which R2 objects belong to a tenant, so the ids come back BEFORE
  // the rows go - and the body sweep is a prefix scan anyway, so an object whose
  // row was already gone still goes.
  if (request.method === 'DELETE' && segments.length === 0) {
    const ids = await meta.deleteAllForTenant(tenantId);
    const removedBodies = await bodies.deleteTenant(tenantId);
    return respond({ ok: true, workflows: ids.length, bodies: removedBodies });
  }

  if (!isBackupWorkflowId(segments[0])) {
    return respond({ error: 'The workflow id is not a valid backup key.' }, 400);
  }
  const workflowId = segments[0];

  // ── GET /api/backups/{id}/revisions ───────────────────────────────────────
  if (request.method === 'GET' && segments.length === 2 && segments[1] === 'revisions') {
    const record = await meta.get(tenantId, workflowId);
    if (!record) return respond({ error: 'No backup exists for this workflow.' }, 404);
    // From R2, not from the D1 counter: R2 is the authority on which bodies exist,
    // so a half-completed prune cannot make this promise a body it cannot serve.
    return respond({
      workflowId,
      current: record.revision,
      revisions: await bodies.revisions(tenantId, workflowId),
    });
  }

  // ── GET /api/backups/{id}/{revision} - one body ───────────────────────────
  if (request.method === 'GET' && segments.length === 2) {
    const revision = Number(segments[1]);
    if (!Number.isInteger(revision) || revision < 1) {
      return respond({ error: 'The revision must be a positive integer.' }, 400);
    }
    const record = await meta.get(tenantId, workflowId);
    if (!record) return respond({ error: 'No backup exists for this workflow.' }, 404);

    let json: string | null;
    try {
      json = await bodies.get(tenantId, workflowId, revision);
    } catch (error) {
      // Decryption failed on an object that IS there. Distinct from a 404 on
      // purpose - this is an incident, not a missing revision - and the vendor
      // detail stays in the log.
      console.error(`Backup body ${tenantId}/${workflowId}/${revision} could not be read:`, error);
      return respond({ error: 'This backup revision could not be decrypted.' }, 500);
    }
    if (json === null) return respond({ error: 'That revision is no longer retained.' }, 404);

    const parsed = parseBody(json);
    if (!parsed) {
      console.error(`Backup body ${tenantId}/${workflowId}/${revision} is not a valid body.`);
      return respond({ error: 'This backup revision could not be read.' }, 500);
    }
    return respond({
      workflowId,
      revision,
      savedAt: record.savedAt,
      spec: parsed.spec,
      connections: parsed.connections,
    });
  }

  // ── POST /api/backups/{id} - upload a revision ────────────────────────────
  if (request.method === 'POST' && segments.length === 1) {
    return uploadRevision(request, { meta, bodies }, tenant, workflowId, respond);
  }

  // ── DELETE /api/backups/{id} - tombstone, or purge one ────────────────────
  if (request.method === 'DELETE' && segments.length === 1) {
    const record = await meta.get(tenantId, workflowId);
    if (!record) return respond({ error: 'No backup exists for this workflow.' }, 404);

    if (url.searchParams.get('purge') === '1') {
      // The second of the three destroying paths. Only a TOMBSTONE may be purged:
      // requiring the soft delete first means one mis-aimed request cannot take out
      // a live backup, and the studio's own flow already has the user delete before
      // purging.
      if (record.deletedAt === null) {
        return respond(
          { error: 'Delete this backup before purging it. A purge cannot be undone.' },
          409,
        );
      }
      const removedBodies = await bodies.deleteWorkflow(tenantId, workflowId);
      await meta.hardDelete(tenantId, workflowId);
      return respond({ ok: true, purged: true, bodies: removedBodies });
    }

    const changed = await meta.softDelete(tenantId, workflowId);
    const after = await meta.get(tenantId, workflowId);
    return respond({
      ok: true,
      // Idempotent: re-deleting reports no change and does NOT extend the window,
      // so a retry cannot keep a tombstone alive forever.
      changed,
      deletedAt: after?.deletedAt ?? record.deletedAt,
      daysRemaining: after?.deletedAt ? tombstoneDaysRemaining(after.deletedAt) : 0,
    });
  }

  return respond({ error: 'Not found.' }, 404);
}

/**
 * `POST /api/backups/{workflowId}`.
 *
 * Ordered so that nothing is stored unless every gate passes: subscription, size,
 * shape, then the D1 revision claim (which is also the concurrency gate and the
 * workflow-count cap), and only then the body. A refused upload leaves the
 * previous revision and every stored body exactly as they were.
 */
async function uploadRevision(
  request: Request,
  stores: { meta: BackupStore; bodies: BackupBodyStore },
  tenant: TenantRecord,
  workflowId: string,
  respond: Respond,
): Promise<Response> {
  // Writing needs a live plan. Reading does not - see the file header.
  if (tenant.status !== 'active' && tenant.status !== 'past_due') {
    const access = lapseReadAccess(tenant);
    return respond(
      {
        error:
          'Your Phorma Cloud backups are read-only until the subscription is renewed.' +
          (access.daysRemaining !== null
            ? ` You can still download them for ${access.daysRemaining} more ${access.daysRemaining === 1 ? 'day' : 'days'}.`
            : ''),
        code: 'no_subscription',
        readOnly: true,
        readOnlyDaysRemaining: access.daysRemaining,
      },
      402,
    );
  }

  // Content-Length FIRST, before the body is read, so an oversized upload costs
  // us nothing to refuse - the same ordering the Stripe webhook uses for its cap.
  const declared = Number(request.headers.get('Content-Length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_SPEC_BYTES) {
    return respond(sizeRefusal(declared), 413);
  }

  const raw = await request.text();
  // The authoritative check: `Content-Length` is a claim, this is the measurement.
  const actual = new TextEncoder().encode(raw).length;
  if (actual > MAX_SPEC_BYTES) return respond(sizeRefusal(actual), 413);

  const parsed = parseBody(raw);
  if (!parsed) {
    return respond({ error: 'Body must be { spec, connections } with a version-1 spec.' }, 400);
  }
  if (parsed.spec.id !== workflowId) {
    // The path is authoritative, so a mismatch is a client bug rather than
    // something to silently resolve one way or the other.
    return respond(
      { error: `The spec id "${parsed.spec.id}" does not match the workflow id in the path.` },
      400,
    );
  }

  // `If-Match` carries the revision the client last saw. Absent means "I have
  // none", which `claimRevision` accepts only for a workflow with no row.
  const ifMatch = request.headers.get('If-Match');
  const expected = readIfMatch(ifMatch);
  if (expected === 'invalid') {
    return respond({ error: 'If-Match must be a non-negative integer.' }, 400);
  }

  const canonical = JSON.stringify({ spec: parsed.spec, connections: parsed.connections });
  const claim = await stores.meta.claimRevision(tenant.id, workflowId, expected, {
    name: parsed.spec.name,
    // Hashed over the SPEC alone, with the same `fnv1a(canonicalJson(...))` the
    // deployment registry uses, so a client can compare the two without a download.
    specHash: fnv1a(canonicalJson(parsed.spec)),
    sizeBytes: actual,
    savedAt: typeof parsed.spec.savedAt === 'string' ? parsed.spec.savedAt : new Date().toISOString(),
  });

  if (claim.ok === false) {
    if (claim.reason === 'workflow-cap') {
      return respond(
        {
          error:
            `Your plan backs up ${claim.cap} workflows and you are at the limit. ` +
            `Existing backups keep updating; upgrade your plan or delete a backup to add this one.`,
          code: 'backup_cap',
          cap: claim.cap,
        },
        409,
      );
    }
    // 409 with the CURRENT revision, so the loser can re-read and decide rather
    // than guess. Nothing here merges two specs (Requirement 16.6).
    return respond(
      {
        error:
          'This workflow changed in the cloud since your last upload. Compare the two versions ' +
          'and choose which to keep.',
        code: 'backup_conflict',
        revision: claim.revision,
      },
      409,
    );
  }

  const revision = claim.record.revision;
  try {
    await stores.bodies.put(tenant.id, workflowId, revision, canonical);
  } catch (error) {
    // The revision is claimed but its body is missing. Reported rather than
    // rolled back: the next upload claims revision+1 and stores correctly, and
    // `revisions()` reads R2 so the list never offers this number.
    console.error(`Backup body write failed for ${tenant.id}/${workflowId}/${revision}:`, error);
    return respond({ error: 'The backup could not be stored. Try again.' }, 502);
  }

  // The first of the three destroying paths, and the only automatic one.
  // Best-effort: a failed prune costs storage, not correctness.
  const pruned = await stores.bodies
    .prune(tenant.id, workflowId, REVISIONS_KEPT)
    .catch(() => [] as number[]);

  return respond({
    ok: true,
    workflowId,
    revision,
    specHash: claim.record.specHash,
    sizeBytes: actual,
    prunedRevisions: pruned.length,
  });
}

/** The 413 body, naming both the limit and what actually arrived (10.8). */
function sizeRefusal(bytes: number): { error: string; code: string; limitBytes: number; actualBytes: number } {
  return {
    error:
      `This workflow is ${Math.round(bytes / 1024)} kB, over the ${Math.round(MAX_SPEC_BYTES / 1024)} kB ` +
      `backup limit. Nothing was stored, and your previous backup is untouched.`,
    code: 'backup_too_large',
    limitBytes: MAX_SPEC_BYTES,
    actualBytes: bytes,
  };
}

/** `If-Match` as a revision, `null` for absent, `'invalid'` for unparseable. */
function readIfMatch(header: string | null): number | null | 'invalid' {
  if (header === null) return null;
  const trimmed = header.trim().replace(/^"|"$/g, '');
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0) return 'invalid';
  return value;
}

/**
 * Parses a stored or uploaded body, or null.
 *
 * `connections` is REBUILT rather than passed through, so anything beyond
 * `{id, name}` is discarded here instead of being stored and hoped about
 * (Requirement 19.2). That is the one field of this body a secret could ride in,
 * so the narrowing is the guard.
 */
function parseBody(raw: string): BackupBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = parsed as { spec?: unknown; connections?: unknown } | null;
  const spec = record?.spec as WorkflowSpec | undefined;
  if (
    !spec ||
    typeof spec !== 'object' ||
    spec.version !== 1 ||
    typeof spec.id !== 'string' ||
    typeof spec.name !== 'string' ||
    !Array.isArray((spec.graph as { nodes?: unknown } | undefined)?.nodes)
  ) {
    return null;
  }
  return { spec, connections: readConnections(record?.connections) };
}

/** Id and display name only, from whatever shape arrived. */
function readConnections(value: unknown): BackupConnectionRef[] {
  if (!Array.isArray(value)) return [];
  const out: BackupConnectionRef[] = [];
  for (const entry of value.slice(0, 200)) {
    const item = entry as { id?: unknown; name?: unknown } | null;
    if (typeof item?.id !== 'string' || item.id.length === 0) continue;
    out.push({
      id: item.id.slice(0, 128),
      name: typeof item.name === 'string' ? item.name.slice(0, 200) : item.id.slice(0, 128),
    });
  }
  return out;
}

/** Projects a stored record into a list row, with the tombstone countdown. */
function toSummary(record: BackupRecord): BackupSummary {
  return {
    workflowId: record.workflowId,
    name: record.name,
    revision: record.revision,
    specHash: record.specHash,
    sizeBytes: record.sizeBytes,
    savedAt: record.savedAt,
    updatedAt: record.updatedAt,
    deletedAt: record.deletedAt,
    daysRemaining: record.deletedAt ? tombstoneDaysRemaining(record.deletedAt) : null,
  };
}

// ── Retention sweep ──────────────────────────────────────────────────────────

/**
 * Removes tombstones past their 30 day window, bodies and all
 * (Requirement 17.8) - the third and last path that destroys backup data.
 *
 * Rides the hosted `scheduled()` pass beside `runTelemetryRetention`, and is a
 * no-op wherever either binding is absent, so a BYO worker with a cron never
 * touches it.
 *
 * Bodies go BEFORE the metadata row: the row is the only index of which R2 objects
 * belong to a tenant, so the reverse order would orphan every object it was
 * supposed to remove. A body delete that fails therefore leaves the row in place
 * and the next pass retries it, which is the safe direction to fail in.
 */
export async function runBackupRetention(
  env: BackupRoutesEnv,
): Promise<{ swept: number; failed: number }> {
  const meta = new BackupStore(env);
  const bodies = new BackupBodyStore(env);
  if (!meta.enabled || !bodies.enabled) return { swept: 0, failed: 0 };

  const expired = await meta.expiredTombstones();
  let swept = 0;
  let failed = 0;
  for (const entry of expired) {
    try {
      await bodies.deleteWorkflow(entry.tenantId, entry.workflowId);
      await meta.hardDelete(entry.tenantId, entry.workflowId);
      swept += 1;
    } catch (error) {
      failed += 1;
      console.error(
        `Backup retention could not sweep ${entry.tenantId}/${entry.workflowId}:`,
        error,
      );
    }
  }
  return { swept, failed };
}
