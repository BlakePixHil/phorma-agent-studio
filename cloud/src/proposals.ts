/**
 * Workflow proposals - the D1 half of the proposal queue, plus every pure
 * decision behind it (multi-organisation-phorma, Requirement 11, design
 * section 9).
 *
 * ## What a proposal is
 *
 * An editor may change a prompt, a cron expression or a node's configuration,
 * but may not deploy. Their save becomes a PROPOSAL: a spec body in R2, one row
 * here, and a builder's publish is what moves the deployed graph. So the
 * central promise of this file is the negative one - **creating a proposal
 * cannot change what is running** - and the way it is kept is structural:
 * nothing in this module or in `proposal-routes.ts` imports, addresses or
 * reaches a `WorkflowAgent` (Requirement 11.10).
 *
 * ## Why this is not `workflow_backups`
 *
 * The two look similar and are structurally opposite. `workflow_backups` has
 * PK `(tenant_id, workflow_id)`: exactly ONE row per workflow, which is what
 * makes its concurrency check a single-row conditional update. A proposal store
 * is a QUEUE - many rows per workflow, at most one of them pending - so the key
 * that makes backup correct makes proposals impossible. Five more reasons are in
 * design section 9.6, and any one of them is sufficient; the decisive one is
 * that a restore must never restore a proposal and a proposal review must never
 * show a backup. Two tables and two R2 prefixes make that an unreachable key
 * rather than a filter somebody has to remember to write.
 *
 * ## The single-pending invariant is a DATABASE constraint
 *
 * `idx_proposals_pending` (migration `0006_organisations.sql`) is a PARTIAL
 * unique index on `(owner_id, workflow_id) WHERE status = 'pending'`. So
 * {@link ProposalStore.create} can supersede and insert in ONE `DB.batch`,
 * which D1 runs in one implicit transaction: if two creations race, the loser's
 * insert violates the index and its whole batch rolls back. "At most one
 * pending proposal per workflow at every observable read" is therefore enforced
 * by the database rather than by the order of two statements.
 *
 * ## Every transition is a conditional update
 *
 * `UPDATE ... WHERE status = '<expected>' AND revision = ?`, with `meta.changes`
 * as the single-winner signal - the same idiom `BackupStore.claimRevision` and
 * `TenantStore.recordRun` use, and for the same reason: a read-then-write lets
 * both concurrent callers through. Zero changed rows is a 409 carrying the
 * CURRENT revision, so the loser retries against a truth rather than guessing.
 *
 * ## `id` versus `proposal_id`
 *
 * `id` is the rowid: monotonic per insert, never reused (AUTOINCREMENT keeps a
 * high-water mark in `sqlite_sequence`), so `ORDER BY id` is stable FIFO and the
 * retention prune orders by it and NEVER by `created_at` - which is a TEXT ISO
 * string whose values tie to the millisecond for two rows written by one pass.
 * `proposal_id` is what travels on the wire, so a client never sees a rowid and
 * a rowid is never part of a URL.
 */

import {
  canonicalJson,
  fnv1a,
  type WorkflowConnection,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowSpec,
} from '@phorma/engine';

import type { TenantEnv } from './tenants';

// ── The wire contract ────────────────────────────────────────────────────────

/**
 * The four states a proposal can be in (Requirement 11.2).
 *
 * APPEND-ONLY, and named tokens rather than a numeric ladder: a status is
 * persisted in a D1 row and rendered by a studio that may be three versions old,
 * so an ordinal would renumber itself the day a state is inserted.
 *
 * `published`, `rejected` and `superseded` are TERMINAL. Every transition is
 * guarded on the status it expects, so a terminal row cannot be revived.
 */
export type ProposalStatus = 'pending' | 'published' | 'rejected' | 'superseded';

/** Display order only. Never an ordering for a comparison. */
export const PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  'pending',
  'published',
  'rejected',
  'superseded',
];

/** True when a value is one of the four declared statuses. */
export function isProposalStatus(value: unknown): value is ProposalStatus {
  return typeof value === 'string' && (PROPOSAL_STATUSES as readonly string[]).includes(value);
}

/** True when a status can never transition again (design section 9.5). */
export function isTerminalStatus(status: ProposalStatus): boolean {
  return status !== 'pending';
}

/**
 * The proposal refusal codes. ONE append-only set (Requirements 11.7, 16.2): a
 * released token is never renamed or repurposed, and a studio that does not know
 * one renders its prose.
 *
 * Two of the four are answered by this task's routes:
 *
 *  - `proposal_conflict` - a conditional update changed no row, so somebody else
 *    moved this proposal first. Carries the CURRENT revision.
 *  - `proposal_unencrypted` - no `KEY_ENC_SECRET` is bound, so the body could
 *    only be stored in the clear. Nothing is stored.
 *
 * The other two are declared here, with the set, because the set is declared
 * once. They are answered by the propose-and-publish task:
 *
 *  - `proposal_scope` - an editor's submission changed the graph STRUCTURE.
 *  - `proposal_stale` - the live spec moved since the proposal was created.
 */
export type ProposalRefusalCode =
  | 'proposal_scope'
  | 'proposal_stale'
  | 'proposal_conflict'
  | 'proposal_unencrypted';

/**
 * One proposal as the studio sees it. Structural twin of `ProposalSummary` in
 * `frontend/src/app/core/proposals.model.ts` (Requirement 16.3).
 *
 * Deliberately carries NEITHER the rowid nor the body key: `proposal_id` is the
 * wire identity, and where the body physically lives is a storage detail the
 * client has no use for and must not be able to name.
 */
export interface ProposalSummary {
  proposalId: string;
  workflowId: string;
  /** The member who submitted it. Never the resolved owner. */
  authorUserId: string;
  status: ProposalStatus;
  /** The conditional-update guard. A transition must send the value it read. */
  revision: number;
  /** `fnv1a(canonicalJson(spec))` of the PROPOSED spec. */
  specHash: string;
  /** The deployed spec's hash when this proposal was created. Frozen. */
  liveSpecHash: string;
  /** An optional rejection reason. */
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One decided proposal, as the AUTHOR's notification feed reports it
 * (Requirement 12.11).
 *
 * Carried as an ADDITIVE field on `NotificationsResponse` rather than as a fifth
 * Durable Object fan-out, because the fact lives in D1: `workflow_proposals`
 * already records who submitted a proposal and when its status last moved, so a
 * feed read is one indexed query rather than one subrequest per deployment. An
 * older studio ignores the field and a BYO worker never sends one.
 *
 * Only an OUTCOME is reported. A `superseded` row is the author's own second
 * submission replacing their first, and `pending` is not news.
 */
export interface ProposalNotice {
  proposalId: string;
  workflowId: string;
  status: 'published' | 'rejected';
  /** The reviewer's reason, when a rejection carried one. */
  reason: string | null;
  /** Epoch ms of the transition, from `updated_at`. */
  at: number;
}

/**
 * One connection a proposed workflow references.
 *
 * ID AND DISPLAY NAME ONLY, exactly as `BackupConnectionRef` is and for exactly
 * the same reason: a reviewer needs to know which connections a change touches
 * and needs nothing else to know it, so there is no field here a secret could
 * occupy. {@link parseProposalBody} rebuilds rather than trusts.
 */
export interface ProposalConnectionRef {
  id: string;
  name: string;
}

/** What one stored proposal body contains. */
export interface ProposalBody {
  spec: WorkflowSpec;
  connections: ProposalConnectionRef[];
}

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Non-pending proposals retained per workflow (Requirement 11.11).
 *
 * Deliberately NOT `REVISIONS_KEPT` from `backups.ts`, although both are ten
 * today. That one counts REVISIONS of one backup row and always retains the
 * newest regardless of the cap; this one counts terminal rows in a queue and
 * must never touch the pending one. One number cannot carry both rules, and
 * importing it would make a change to backup retention silently change this.
 */
export const PROPOSALS_KEPT = 10;

/**
 * Largest proposal body we accept, in bytes.
 *
 * Restated rather than imported from `backups.ts` for the same reason
 * {@link PROPOSALS_KEPT} is: the numbers agreeing today is not a reason to make
 * one of them govern the other. The cap exists so an unbounded write cannot be
 * paid for by us; it answers 413 and carries no refusal code, because the four
 * proposal codes are a closed set and a size refusal is an HTTP fact.
 */
export const MAX_PROPOSAL_BYTES = 2 * 1024 * 1024;

/**
 * A workflow id, as an R2 key segment and a registry segment.
 *
 * The same pattern `backup-routes.ts` and `ownership-claim.ts` use, bounded for
 * the same reasons: a `/` would forge a nested key, a `:` would collide with the
 * deployment registry separator, and `#` is the portal session separator.
 */
const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** True when a workflow id is safe as a key and registry segment. */
export function isProposalWorkflowId(value: unknown): value is string {
  return typeof value === 'string' && WORKFLOW_ID_PATTERN.test(value);
}

/**
 * A proposal id, as a key segment.
 *
 * Narrower than the workflow pattern because every value this worker ever
 * accepts here was minted by {@link newProposalId}: a client only ever echoes
 * back an id it was given.
 */
const PROPOSAL_ID_PATTERN = /^prop-[A-Za-z0-9-]{1,64}$/;

/** True when a value has the shape of a minted proposal id. */
export function isProposalId(value: unknown): value is string {
  return typeof value === 'string' && PROPOSAL_ID_PATTERN.test(value);
}

/**
 * A fresh wire id, `prop-{base36 millis}-{hex}`.
 *
 * Time-ordered prefix so a human reading a bucket listing or a log can tell
 * roughly when one was made, and a random tail so two creations in the same
 * millisecond cannot collide. Ordering for the prune still comes from the rowid;
 * this prefix is for eyes, never for a comparison.
 */
export function newProposalId(now = Date.now()): string {
  const random = crypto.getRandomValues(new Uint8Array(8));
  const tail = [...random].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `prop-${now.toString(36)}-${tail}`;
}

// ── R2 keys ──────────────────────────────────────────────────────────────────

/**
 * The prefix EVERY proposal body lives under, and the reason a proposal body is
 * out of reach of every backup destroy path BY CONSTRUCTION (Requirement 11.3).
 *
 * `BackupBodyStore.deleteTenant` scans `backup/{tenantId}/`, and its `prune` and
 * `deleteWorkflow` enumerate `bodyPrefix(tenant, workflow)`, which is also under
 * `backup/`. So no backup path can list, read or delete a `proposal/` object,
 * and no proposal read can serve a backup body. That is why both concerns share
 * the existing `BACKUPS` bucket with NO new binding: the prefix is the isolation.
 */
export const PROPOSAL_KEY_PREFIX = 'proposal/';

/** `proposal/{ownerId}/{workflowId}/` - the prefix one workflow's bodies share. */
export function proposalBodyPrefix(ownerId: string, workflowId: string): string {
  return `${PROPOSAL_KEY_PREFIX}${ownerId}/${workflowId}/`;
}

/**
 * The one place a proposal body key is shaped:
 * `proposal/{ownerId}/{workflowId}/{proposalId}`.
 *
 * Stored in `workflow_proposals.body_key` as the FULL key rather than derived at
 * read time, so an ownership transfer can move `owner_id` without rewriting or
 * re-uploading a single R2 object - the same reason `workflow_backups.body_key`
 * exists. Unlike that column this one is `NOT NULL`: proposals are newer than
 * the column, so there is no legacy row to derive for.
 */
export function proposalBodyKey(
  ownerId: string,
  workflowId: string,
  proposalId: string,
): string {
  return `${proposalBodyPrefix(ownerId, workflowId)}${proposalId}`;
}

// ── Pure decisions ───────────────────────────────────────────────────────────

/**
 * Parses a submitted or stored proposal body, or null.
 *
 * Mirrors `parseBody` in `backup-routes.ts` exactly, including the part that
 * matters: `connections` is REBUILT to `{id, name}` rather than passed through,
 * so the one field of this body a secret could ride in is narrowed rather than
 * trusted (Requirement 11.9). Everything else is shape-checked, and a body that
 * fails the check is refused before anything is claimed or stored.
 */
export function parseProposalBody(raw: string): ProposalBody | null {
  return parseProposalSubmission(raw)?.body ?? null;
}

/**
 * What one SUBMISSION carries: the body to store, plus the live spec the author
 * was editing when they made it.
 *
 * `liveSpec` is read but never STORED - {@link ProposalBody} is exactly what goes
 * into R2, so a submission field cannot smuggle a second spec into the stored
 * object. It exists for the scope check (Requirement 12.2), and it is
 * TRUSTWORTHY without being trusted: the route only uses it after confirming that
 * its {@link canonicalSpecHashOf} equals the hash the deployment REGISTRY holds,
 * and the registry is written by `WorkflowAgent` alone. So a client cannot forge a
 * live spec that the check will accept, and the worker stays the boundary without
 * having to wake a deployed instance to ask (Requirement 11.10).
 */
export function parseProposalSubmission(
  raw: string,
): { body: ProposalBody; liveSpec: WorkflowSpec | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = parsed as { spec?: unknown; connections?: unknown; liveSpec?: unknown } | null;
  const spec = readSpecShape(record?.spec);
  if (!spec) return null;
  return {
    body: { spec, connections: readConnections(record?.connections) },
    liveSpec: readSpecShape(record?.liveSpec),
  };
}

/** A value shaped like a version-1 `WorkflowSpec`, or null. */
function readSpecShape(value: unknown): WorkflowSpec | null {
  const spec = value as WorkflowSpec | undefined;
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
  return spec;
}

/** Id and display name only, from whatever shape arrived. */
function readConnections(value: unknown): ProposalConnectionRef[] {
  if (!Array.isArray(value)) return [];
  const out: ProposalConnectionRef[] = [];
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

/**
 * The Canonical_Spec_Hash of a spec, as this worker computes it
 * (Requirement 12.3).
 *
 * The SAME expression `WorkflowAgent.syncDeployment` writes into
 * `DeploymentRecord.specHash`, which is what makes the three hashes this feature
 * compares - a proposal's `spec_hash`, its frozen `live_spec_hash`, and the
 * registry's current `specHash` - directly comparable.
 *
 * The worker never MATERIALIZES defaults, and does not need to: it has no access
 * to a studio's settings, that is the reason the studio does it at push time, and
 * so every spec that reaches here already carries explicit providers and models.
 * The one transform runs once, on a studio (`frontend/src/app/core/spec-defaults.ts`),
 * so both sides of every comparison are hashes of a materialized spec.
 */
export function canonicalSpecHashOf(spec: WorkflowSpec): string {
  return fnv1a(canonicalJson(spec));
}

// ── Scope: what an editor may and may not change ─────────────────────────────

/**
 * How many violations one refusal names.
 *
 * A rewired graph produces one violation per changed edge, and a reviewer needs
 * to know WHICH change was disallowed rather than all of them - so the list is
 * capped and the count is reported alongside it. An unbounded list would put an
 * arbitrarily large body on a refusal.
 */
export const SCOPE_VIOLATIONS_REPORTED = 10;

/**
 * Everything an editor's proposal may NOT change, named
 * (Requirement 12.2, design section 9.5).
 *
 * PURE, and the four things it compares are the definition of STRUCTURE:
 *
 *  1. the node id set,
 *  2. each surviving node's `kind`,
 *  3. the edge set WITH its port wiring, and
 *  4. the sub-workflow id set, plus the same three rules inside each
 *     sub-workflow graph that exists on both sides.
 *
 * Everything else is in scope for an editor: prompt text, a cron expression, any
 * node `data`, a node's name, description or position, the workflow name, the
 * workflow settings, and the connection references. That is the whole product
 * claim - an editor tunes what a graph DOES and a builder decides what the graph
 * IS.
 *
 * Empty means the change is in scope. A non-empty result is the
 * `proposal_scope` refusal's body (Requirement 12.2), which is why every entry is
 * a sentence naming the specific change rather than a code: the author has to be
 * able to undo it without guessing which of their edits was the structural one.
 *
 * Note what is NOT structure here on purpose: a connection's `id` or `label`, and
 * the ORDER of nodes and edges within a graph. Those are serialization facts
 * rather than wiring, and treating them as structure would refuse a proposal for
 * a change nobody made.
 *
 * `live` may be null, which is the "nothing is deployed yet" case: there is no
 * structure to preserve, so nothing can violate it.
 */
export function scopeViolations(
  live: WorkflowSpec | null | undefined,
  proposed: WorkflowSpec,
): string[] {
  if (!live) return [];
  const violations = compareGraphStructure(live.graph, proposed.graph, null);

  const liveSubIds = subWorkflowIds(live);
  const proposedSubIds = subWorkflowIds(proposed);
  for (const id of proposedSubIds) {
    if (!liveSubIds.has(id)) violations.push(`the sub-workflow "${id}" was added`);
  }
  for (const id of liveSubIds) {
    if (!proposedSubIds.has(id)) violations.push(`the sub-workflow "${id}" was removed`);
  }
  for (const id of liveSubIds) {
    if (!proposedSubIds.has(id)) continue;
    const before = live.subWorkflows?.[id]?.graph;
    const after = proposed.subWorkflows?.[id]?.graph;
    if (!before || !after) continue;
    violations.push(...compareGraphStructure(before, after, id));
  }
  return violations;
}

/** The sub-workflow registry's key set, as the closure declares it. */
function subWorkflowIds(spec: WorkflowSpec): Set<string> {
  return new Set(Object.keys(spec.subWorkflows ?? {}));
}

/**
 * The three structural rules over one pair of graphs.
 *
 * `where` names the sub-workflow a violation happened in, or null for the root
 * graph, so a message is unambiguous in a spec whose sub-workflow reuses a node
 * id.
 */
function compareGraphStructure(
  live: WorkflowGraph,
  proposed: WorkflowGraph,
  where: string | null,
): string[] {
  const suffix = where ? ` in the sub-workflow "${where}"` : '';
  const violations: string[] = [];

  const liveNodes = new Map(live.nodes.map(node => [node.id, node]));
  const proposedNodes = new Map(proposed.nodes.map(node => [node.id, node]));

  for (const [id, node] of proposedNodes) {
    if (!liveNodes.has(id)) violations.push(`the ${node.kind} step "${nameOf(node)}" was added${suffix}`);
  }
  for (const [id, node] of liveNodes) {
    if (!proposedNodes.has(id)) {
      violations.push(`the ${node.kind} step "${nameOf(node)}" was removed${suffix}`);
    }
  }
  for (const [id, node] of liveNodes) {
    const after = proposedNodes.get(id);
    if (!after || after.kind === node.kind) continue;
    // A kind change with the same id is the subtle one: the node looks like the
    // same step and executes as something else entirely.
    violations.push(
      `the step "${nameOf(node)}" changed from ${node.kind} to ${after.kind}${suffix}`,
    );
  }

  const liveEdges = new Set(live.connections.map(edgeKey));
  const proposedEdges = new Set(proposed.connections.map(edgeKey));
  for (const key of proposedEdges) {
    if (!liveEdges.has(key)) violations.push(`the connection ${key} was added${suffix}`);
  }
  for (const key of liveEdges) {
    if (!proposedEdges.has(key)) violations.push(`the connection ${key} was removed${suffix}`);
  }
  return violations;
}

/** A node's authored name, or its id when it has none worth showing. */
function nameOf(node: WorkflowNode): string {
  return node.name && node.name.trim().length > 0 ? node.name : node.id;
}

/**
 * One edge's identity for the comparison: its PORT WIRING and its kind, never
 * its own `id`.
 *
 * Re-saving a spec can mint a new connection id for the same wiring, and
 * refusing a proposal over that would refuse a change nobody made. The wiring is
 * the thing that decides what runs after what.
 */
function edgeKey(edge: WorkflowConnection): string {
  return `${edge.outputId} -> ${edge.inputId} (${edge.kind})`;
}

/**
 * Which rows the retention prune destroys: everything past the newest `keep`
 * NON-PENDING rows (Requirement 11.11).
 *
 * Pure, so the rule is testable without D1 and the SQL above it only has to
 * READ. Two properties it exists to hold:
 *
 *  - A `pending` row is never returned, whatever `keep` is. A pending proposal
 *    is the live one; pruning it would delete work nobody has reviewed.
 *  - Ordering is by `id` DESCENDING and never by `created_at`, for the reason in
 *    this file's header.
 *
 * Note the contrast with `BackupBodyStore.prune`, which clamps `keep` to at
 * least 1 because a backup row with no body would be a metadata row promising a
 * body it cannot serve. Here a `keep` of 0 is meaningful and legal: every
 * terminal row may go, and the pending one still survives by construction.
 */
export function doomedProposals<T extends { id: number; status: ProposalStatus }>(
  rows: readonly T[],
  keep: number,
): T[] {
  return rows
    .filter(row => row.status !== 'pending')
    .slice()
    .sort((a, b) => b.id - a.id)
    .slice(Math.max(0, keep));
}

// ── The D1 store ─────────────────────────────────────────────────────────────

/** One proposal row, as the store holds it. */
export interface ProposalRecord extends ProposalSummary {
  /** The rowid. Internal ordering only - never on the wire, never in a URL. */
  id: number;
  /** Whose queue this is: the RESOLVED owner, never the author. */
  ownerId: string;
  /** The full R2 object key of the body. */
  bodyKey: string;
}

/** What one creation attempt did. */
export type ProposalCreateResult =
  | { ok: true; record: ProposalRecord }
  /**
   * Another creation won the pending slot. Carries the revision of the row that
   * holds it, so the loser retries against a truth (Requirement 11.7).
   */
  | { ok: false; reason: 'conflict'; revision: number };

/** What one transition attempt did. */
export type ProposalTransitionResult =
  | { ok: true; record: ProposalRecord }
  /**
   * The conditional update changed no row: the status or the revision moved
   * first. Carries the CURRENT revision, or 0 when the row is gone entirely.
   */
  | { ok: false; reason: 'conflict'; revision: number };

/**
 * The proposal store. Constructed per request, like every other store here, and
 * gated the same way: `enabled` is `Boolean(env.DB)`, so nothing in it is
 * reachable on a BYO worker.
 */
export class ProposalStore {
  constructor(private readonly env: TenantEnv) {}

  /** True when the hosted D1 binding is present. */
  get enabled(): boolean {
    return Boolean(this.env.DB);
  }

  private get db(): D1Database {
    if (!this.env.DB) throw new Error('The proposal store requires the DB (D1) binding.');
    return this.env.DB;
  }

  /**
   * Supersedes any pending proposal for this workflow and inserts the new one,
   * as ONE `DB.batch` (Requirement 11.6, 12.5).
   *
   * The two statements are in one implicit transaction, and the partial unique
   * index is what makes that safe rather than merely ordered: if two creations
   * race, one batch's supersede finds nothing to supersede, its insert violates
   * `idx_proposals_pending`, and the whole batch rolls back. So the supersede
   * lands in the same update pass as the accept, and there is no observable
   * moment with two pending rows or none.
   *
   * Called BEFORE the body is written, so a refused creation stores nothing.
   */
  async create(input: {
    proposalId: string;
    ownerId: string;
    workflowId: string;
    authorUserId: string;
    specHash: string;
    liveSpecHash: string;
    bodyKey: string;
  }): Promise<ProposalCreateResult> {
    const now = new Date().toISOString();
    const db = this.db;
    try {
      const [, inserted] = await db.batch([
        db
          .prepare(
            `UPDATE workflow_proposals
                SET status = 'superseded', revision = revision + 1, updated_at = ?
              WHERE owner_id = ? AND workflow_id = ? AND status = 'pending'`,
          )
          .bind(now, input.ownerId, input.workflowId),
        db
          .prepare(
            `INSERT INTO workflow_proposals
               (proposal_id, owner_id, workflow_id, author_user_id, status, revision,
                spec_hash, live_spec_hash, body_key, reason, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'pending', 1, ?, ?, ?, NULL, ?, ?)`,
          )
          .bind(
            input.proposalId,
            input.ownerId,
            input.workflowId,
            input.authorUserId,
            input.specHash,
            input.liveSpecHash,
            input.bodyKey,
            now,
            now,
          ),
      ]);
      if (Number(inserted?.meta?.changes ?? 0) !== 1) {
        // Belt and braces: D1 reports a failed batch by throwing, so this branch
        // is not expected to be reachable. It answers as a conflict rather than
        // as a success, because the one thing that must never happen is reporting
        // a proposal that is not in the table.
        return { ok: false, reason: 'conflict', revision: await this.pendingRevision(input) };
      }
      const record = await this.get(input.ownerId, input.proposalId);
      if (record) return { ok: true, record };
      return { ok: false, reason: 'conflict', revision: await this.pendingRevision(input) };
    } catch (error) {
      // The expected shape of a lost race: the index refused the second pending
      // row and D1 rolled the batch back. Only treated as a conflict when there
      // really IS a pending row now - anything else is a genuine failure and is
      // rethrown, because swallowing it would report a lost race for a broken
      // database.
      const revision = await this.pendingRevision(input).catch(() => 0);
      if (revision > 0) return { ok: false, reason: 'conflict', revision };
      throw error;
    }
  }

  /**
   * Moves one proposal from `from` to `to`, guarded on its revision
   * (Requirement 11.6).
   *
   * The conditional `UPDATE ... WHERE status = ? AND revision = ?` is the
   * single-winner signal: for two concurrent transitions carrying the same
   * revision, exactly one reports a changed row. A read-then-write here would
   * let both through, mark the proposal twice and - once publish runs a push -
   * deploy the same spec twice.
   *
   * `reason` is only ever written, never cleared: a rejection's reason outlives
   * the row's status.
   */
  async transition(
    ownerId: string,
    proposalId: string,
    change: { from: ProposalStatus; to: ProposalStatus; revision: number; reason?: string | null },
  ): Promise<ProposalTransitionResult> {
    const now = new Date().toISOString();
    const result = await this.db
      .prepare(
        `UPDATE workflow_proposals
            SET status = ?, revision = revision + 1, updated_at = ?,
                reason = COALESCE(?, reason)
          WHERE owner_id = ? AND proposal_id = ? AND status = ? AND revision = ?`,
      )
      .bind(
        change.to,
        now,
        change.reason ?? null,
        ownerId,
        proposalId,
        change.from,
        change.revision,
      )
      .run();

    if (Number(result.meta?.changes ?? 0) === 0) {
      const current = await this.get(ownerId, proposalId);
      return { ok: false, reason: 'conflict', revision: current?.revision ?? 0 };
    }
    const record = await this.get(ownerId, proposalId);
    // A row that changed and then cannot be read is a database fault, not a
    // conflict, so it is reported as one rather than as a lost race.
    if (!record) throw new Error(`Proposal ${proposalId} vanished after a successful transition.`);
    return { ok: true, record };
  }

  /** One proposal by its wire id, scoped to an owner, or null. */
  async get(ownerId: string, proposalId: string): Promise<ProposalRecord | null> {
    const row = await this.db
      .prepare(`${SELECT_COLUMNS} WHERE owner_id = ? AND proposal_id = ?`)
      .bind(ownerId, proposalId)
      .first<ProposalRow>();
    return row ? toRecord(row) : null;
  }

  /** The pending proposal for one workflow, or null. At most one can exist. */
  async pending(ownerId: string, workflowId: string): Promise<ProposalRecord | null> {
    const row = await this.db
      .prepare(
        `${SELECT_COLUMNS} WHERE owner_id = ? AND workflow_id = ? AND status = 'pending'`,
      )
      .bind(ownerId, workflowId)
      .first<ProposalRow>();
    return row ? toRecord(row) : null;
  }

  /**
   * One workflow's proposals, newest first.
   *
   * `ORDER BY id DESC`, which `idx_proposals_workflow` supplies with no temp
   * B-tree because every SQLite index appends the rowid to its key.
   */
  async list(ownerId: string, workflowId: string, limit = 50): Promise<ProposalRecord[]> {
    const rows = await this.db
      .prepare(`${SELECT_COLUMNS} WHERE owner_id = ? AND workflow_id = ? ORDER BY id DESC LIMIT ?`)
      .bind(ownerId, workflowId, Math.max(1, Math.min(200, limit)))
      .all<ProposalRow>();
    return (rows.results ?? []).map(toRecord);
  }

  /**
   * One author's DECIDED proposals since `since`, newest first
   * (Requirement 12.11).
   *
   * Scoped by owner AND author: the owner keeps one organisation's queue out of
   * another's, and the author is what makes this the submitter's feed rather than
   * a broadcast - a reviewer's decision is news for the person who asked for it.
   *
   * `since` is epoch ms and `updated_at` is an ISO 8601 string, so the bound is
   * converted rather than compared across types. Both sides are produced by
   * `toISOString()`, so a lexicographic comparison is a chronological one.
   *
   * Only `published` and `rejected` are reported. `superseded` is the author
   * replacing their own submission, and `pending` is not an outcome.
   */
  async outcomesForAuthor(
    ownerId: string,
    authorUserId: string,
    since: number,
    limit = 20,
  ): Promise<ProposalNotice[]> {
    const bound = new Date(Math.max(0, since)).toISOString();
    const rows = await this.db
      .prepare(
        `SELECT proposal_id, workflow_id, status, reason, updated_at
           FROM workflow_proposals
          WHERE owner_id = ? AND author_user_id = ?
            AND status IN ('published', 'rejected')
            AND updated_at > ?
          ORDER BY id DESC LIMIT ?`,
      )
      .bind(ownerId, authorUserId, bound, Math.max(1, Math.min(100, limit)))
      .all<Pick<ProposalRow, 'proposal_id' | 'workflow_id' | 'status' | 'reason' | 'updated_at'>>();
    return (rows.results ?? []).map(row => ({
      proposalId: row.proposal_id,
      workflowId: row.workflow_id,
      status: row.status as 'published' | 'rejected',
      reason: row.reason ?? null,
      at: Date.parse(row.updated_at) || 0,
    }));
  }

  /**
   * The rows retention destroys: every non-pending row past the newest `keep`.
   *
   * A READ. The decision is {@link doomedProposals}, so the rule lives in one
   * pure function and this method cannot quietly disagree with it.
   */
  async beyondRetention(
    ownerId: string,
    workflowId: string,
    keep = PROPOSALS_KEPT,
  ): Promise<ProposalRecord[]> {
    const rows = await this.db
      .prepare(
        `${SELECT_COLUMNS}
          WHERE owner_id = ? AND workflow_id = ? AND status != 'pending'
          ORDER BY id DESC`,
      )
      .bind(ownerId, workflowId)
      .all<ProposalRow>();
    return doomedProposals((rows.results ?? []).map(toRecord), keep);
  }

  /**
   * Removes rows by rowid. The CALLER deletes their bodies FIRST.
   *
   * That order is not a preference: the row is the only index of which R2 object
   * belongs to which proposal, so dropping it first orphans an object nothing can
   * ever name again. Same rule the backup retention sweep follows.
   */
  async deleteRows(ids: readonly number[]): Promise<number> {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(', ');
    const result = await this.db
      .prepare(`DELETE FROM workflow_proposals WHERE id IN (${placeholders})`)
      .bind(...ids)
      .run();
    return Number(result.meta?.changes ?? 0);
  }

  /** The revision of the pending row for a workflow, or 0 when there is none. */
  private async pendingRevision(input: {
    ownerId: string;
    workflowId: string;
  }): Promise<number> {
    const row = await this.pending(input.ownerId, input.workflowId);
    return row?.revision ?? 0;
  }
}

/** Projects a record into the wire shape, dropping the rowid and the body key. */
export function toProposalSummary(record: ProposalRecord): ProposalSummary {
  return {
    proposalId: record.proposalId,
    workflowId: record.workflowId,
    authorUserId: record.authorUserId,
    status: record.status,
    revision: record.revision,
    specHash: record.specHash,
    liveSpecHash: record.liveSpecHash,
    reason: record.reason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Written once, so every read selects the same columns in the same order. */
const SELECT_COLUMNS = `SELECT id, proposal_id, owner_id, workflow_id, author_user_id, status,
                               revision, spec_hash, live_spec_hash, body_key, reason,
                               created_at, updated_at
                          FROM workflow_proposals`;

/** The stored row shape, before it becomes a {@link ProposalRecord}. */
interface ProposalRow {
  id: number;
  proposal_id: string;
  owner_id: string;
  workflow_id: string;
  author_user_id: string;
  status: string;
  revision: number;
  spec_hash: string;
  live_spec_hash: string;
  body_key: string;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: ProposalRow): ProposalRecord {
  return {
    id: Number(row.id ?? 0),
    proposalId: row.proposal_id,
    ownerId: row.owner_id,
    workflowId: row.workflow_id,
    authorUserId: row.author_user_id,
    // A status read back OUT of a row is never re-validated, the same asymmetry
    // `isClerkUserId` documents: a row written by a newer worker may carry a
    // token this build does not know, and refusing to project it would strand a
    // real proposal. The guard belongs on the write path.
    status: row.status as ProposalStatus,
    revision: Number(row.revision ?? 0),
    specHash: row.spec_hash,
    liveSpecHash: row.live_spec_hash,
    bodyKey: row.body_key,
    reason: row.reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
