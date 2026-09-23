/**
 * Portal registry (EPIC 9) - slug resolution, publish records, rate limits.
 *
 * A visitor arrives at `/p/{slug}` with no credentials and no idea which
 * Durable Object instance holds the workflow. Something has to map the slug
 * to `{ownerId, workflowId}` before any DO is addressed. In hosted mode that
 * mapping is also the tenant boundary, so it must not be guessable or
 * spoofable from the request.
 *
 * `PortalIndex` is a single Durable Object (`idFromName('portal-index')`) that
 * owns:
 *  - the slug -> publish-record table (the source of truth in BOTH modes),
 *  - a token-bucket rate limiter per slug and per visitor IP,
 *  - hit counters for the owner's Portal panel.
 *
 * Why one DO instead of KV or D1: a BYO user deploys with a single
 * `wrangler deploy` and no dashboard steps. Requiring them to create a KV
 * namespace or a D1 database to publish a page would violate "defaults must
 * be runnable" - and the DO gives us strongly consistent slug uniqueness for
 * free, which KV's eventual consistency does not. Hosted mode mirrors rows
 * into D1 for analytics (see `mirrorPortalToD1`), but resolution always reads
 * the DO.
 *
 * Plain `DurableObject` on purpose: this must NEVER extend the `agents` SDK's
 * `Agent`, whose state broadcast would expose the whole table to any
 * connected socket.
 */

import { DurableObject } from 'cloudflare:workers';

import type { PortalTokenRecord } from './portal-auth';
import type { PortalAccess, PortalField, PortalMode } from '@phorma/engine';

/** Everything the worker needs to serve and run one published surface. */
export interface PublishRecord {
  slug: string;
  /** Library workflow id - the DO instance name, before owner prefixing. */
  workflowId: string;
  /** Clerk userId in hosted mode; null in BYO (single-tenant). */
  ownerId: string | null;
  workflowName: string;
  mode: PortalMode;
  access: PortalAccess;
  title: string;
  greeting?: string;
  fields: PortalField[];
  /** Node whose tokens/output the visitor may see; null = joined final output. */
  responderNodeId: string | null;
  rateLimitPerMin: number;
  theme: 'auto' | 'light' | 'dark';
  showBranding: boolean;
  /** True when other sites may frame this portal (see `frame-ancestors`). */
  embedEnabled?: boolean;
  /** Normalized origins allowed to frame it. Empty + enabled = any site. */
  embedOrigins?: string[];
  /** Launcher bubble label for the embed loader. */
  embedLabel?: string;
  /** Scoped access keys (hashes only - see portal-auth.ts). */
  tokens: PortalTokenRecord[];
  publishedAt: number;
  updatedAt: number;
  /** Total visitor messages accepted, for the owner's Portal panel. */
  hits: number;
  /** Epoch ms of the most recent visitor message. */
  lastHitAt?: number;
}

/** Owner-facing view: the record plus counters, minus nothing (owner sees all). */
export interface PortalStatus {
  record: PublishRecord | null;
}

// ── Deployment registry (cloud-workflow-backup Phase 1) ─────────────────────

/**
 * Owner segment used by a single-tenant BYO deployment, where `ownerId` is
 * null everywhere else in this file.
 *
 * A literal rather than an empty segment so the key shape stays uniform
 * (`deploy:{owner}:{workflowId}` always has three parts) and a prefix scan
 * cannot accidentally match every owner (Requirement 1.5).
 */
export const DEFAULT_DEPLOYMENT_OWNER = 'default';

/**
 * One live deployment, as the Deployment_Registry holds it.
 *
 * Deliberately NOT a workflow spec and never a secret (Requirement 1.6): this
 * is the answer to "what is running in my account", which has to survive the
 * loss of the local library, and every field here is already visible to the
 * owner somewhere else.
 *
 * Timestamps are epoch ms, matching `PublishRecord.publishedAt` rather than the
 * spec's ISO `savedAt`, so one DO does not hold two time formats. The backfill
 * converts (see `WorkflowAgent.backfillDeployment`).
 */
export interface DeploymentRecord {
  /** Library workflow id - the DO instance name, before owner prefixing. */
  workflowId: string;
  /** Clerk userId in hosted mode; {@link DEFAULT_DEPLOYMENT_OWNER} in BYO. */
  ownerId: string;
  workflowName: string;
  /** First time this workflow was seen deployed. Preserved across re-pushes. */
  deployedAt: number;
  /** Most recent push (or backfill) that wrote this record. */
  updatedAt: number;
  /** `fnv1a(canonicalJson(spec))` - lets a client spot a drifted local copy. */
  specHash: string;
  /** True when a schedule trigger is armed on this deployment. */
  cronArmed: boolean;
  /** Published portal address, or null when nothing is published. */
  portalSlug: string | null;
}

/**
 * A registry key component may not contain the separator.
 *
 * This is an isolation guard, not tidiness. `listDeployments` is a prefix scan
 * over `deploy:{owner}:`, so a workflowId carrying a colon could produce a key
 * that reads as a DIFFERENT owner's record - `deploy:a:b:wf` is inside both
 * `deploy:a:` and (as far as string matching cares) an owner literally named
 * `a:b`. Ids in this product never contain one (`wf-...` and Clerk's
 * `user_...`), so refusing is free and keeps the scan sound if that ever
 * changes.
 */
function isRegistrySegment(value: string): boolean {
  return value.length > 0 && !value.includes(':');
}

/** Verdict from the rate limiter. */
export interface RateVerdict {
  allowed: boolean;
  /** Seconds until the caller may retry. Only meaningful when denied. */
  retryAfter: number;
}

/** Per-slug ceiling regardless of how many distinct visitors show up. */
const SLUG_CEILING_PER_MIN = 60;

/** Sliding window for both buckets. */
const WINDOW_MS = 60_000;

/** Buckets are pruned once the table exceeds this many entries. */
const MAX_BUCKETS = 5_000;

interface Bucket {
  /** Timestamps (epoch ms) of accepted requests inside the window. */
  hits: number[];
}

/**
 * The slug registry + rate limiter. One instance per worker
 * (`idFromName('portal-index')`).
 */
export class PortalIndex extends DurableObject {
  /** In-memory rate buckets. Deliberately NOT persisted: losing them on
   *  eviction only forgives a minute of traffic, and writing every request to
   *  storage would cost more than the abuse it prevents. */
  private readonly buckets = new Map<string, Bucket>();

  // ── Slug table ────────────────────────────────────────────────────────────

  /** Resolves a slug. Returns null when unpublished or revoked. */
  async resolve(slug: string): Promise<PublishRecord | null> {
    return (await this.ctx.storage.get<PublishRecord>(`portal:${slug}`)) ?? null;
  }

  /**
   * Claims or updates a slug. Fails when another WORKFLOW already holds it -
   * re-publishing the same workflow to the same slug is an update, not a
   * conflict.
   */
  async publish(record: PublishRecord): Promise<{ ok: true } | { ok: false; error: string }> {
    const existing = await this.resolve(record.slug);
    if (existing && existing.workflowId !== record.workflowId) {
      return { ok: false, error: `The address "${record.slug}" is already taken.` };
    }
    // Any slug this workflow used previously must be released, or renaming a
    // portal would leave the old address live and serving stale config.
    for (const stale of await this.slugsForWorkflow(record.workflowId)) {
      if (stale !== record.slug) await this.ctx.storage.delete(`portal:${stale}`);
    }
    await this.ctx.storage.put(`portal:${record.slug}`, {
      ...record,
      // Counters survive re-publishing so the owner keeps their history.
      hits: existing?.hits ?? record.hits ?? 0,
      lastHitAt: existing?.lastHitAt ?? record.lastHitAt,
      publishedAt: existing?.publishedAt ?? record.publishedAt,
      updatedAt: Date.now(),
    });
    return { ok: true };
  }

  /** Removes every slug owned by a workflow. Idempotent. */
  async unpublish(workflowId: string): Promise<{ removed: string[] }> {
    const removed = await this.slugsForWorkflow(workflowId);
    for (const slug of removed) await this.ctx.storage.delete(`portal:${slug}`);
    return { removed };
  }

  // ── Portal session registry ───────────────────────────────────────────────
  //
  // A published portal spawns one `WorkflowAgent` instance per visitor
  // conversation, named `{ownerId}:{workflowId}#s{sessionId}` (see
  // `portalSessionInstance`). Those instances are never enumerable from the
  // DO namespace, so without a registry a workflow delete / unpublish would
  // orphan every visitor's session DO - its transcript and journaled state
  // would live in storage until Cloudflare evicted the instance.
  //
  // The registry stores the session INSTANCE NAME (already tenant-prefixed)
  // under `session:{workflowId}:{sessionId}`. `addSession` is called when a
  // session DO is initialised. Teardown is deliberately TWO calls -
  // `listSessions` then `forgetSessions` - because this registry holds the only
  // reference to a session instance that exists anywhere: a Durable Object
  // namespace cannot be enumerated. Dropping a key before its DO is actually
  // purged would orphan that instance permanently, so the purge path forgets
  // only the sessions it managed to purge and leaves the rest for a retry.
  //
  // `unpublish` does NOT clear sessions - the purge path handles them
  // explicitly, so a transient unpublish (re-publish to a new slug) does not
  // destroy in-flight conversations.

  /** Records a portal session instance so it can be torn down later. Idempotent. */
  async addSession(workflowId: string, sessionId: string, instanceName: string): Promise<void> {
    await this.ctx.storage.put(`session:${workflowId}:${sessionId}`, instanceName);
  }

  /**
   * Every session this workflow has tracked, as `{sessionId, instanceName}`
   * pairs. Read-only: pass the ids of the ones you purged to
   * {@link forgetSessions}.
   */
  async listSessions(workflowId: string): Promise<{ sessionId: string; instanceName: string }[]> {
    const prefix = `session:${workflowId}:`;
    const map = await this.ctx.storage.list<string>({ prefix });
    return [...map].map(([key, instanceName]) => ({
      sessionId: key.slice(prefix.length),
      instanceName,
    }));
  }

  /** Drops the tracking keys for sessions whose DOs are gone. Idempotent. */
  async forgetSessions(workflowId: string, sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      await this.ctx.storage.delete(`session:${workflowId}:${sessionId}`);
    }
  }

  // ── Deployment registry ───────────────────────────────────────────────────
  //
  // The third key space in this DO, `deploy:{ownerId}:{workflowId}`, holding one
  // {@link DeploymentRecord} per live deployment.
  //
  // It lives here for the same reason the slug table does: a Durable Object
  // NAMESPACE CANNOT BE ENUMERATED. Without a registry, the only handle on a
  // deployed workflow is its id, and the only copy of that id was in the user's
  // local IndexedDB - so a reinstall left a deployment running cron, answering a
  // portal and spending credits with no way for its owner to name it, let alone
  // remove it.
  //
  // Writes come from `WorkflowAgent` alone (Requirement 2.4), which is what makes
  // the list correct for a client that crashed, was uninstalled, or is an old
  // version. Adding it to `PortalIndex` rather than a fourth DO class is
  // deliberate: no new binding, no migration tag, no `renamed_classes`, and it
  // exists in hosted AND BYO shape because this class already does
  // (Requirements 1.3, 1.4).

  /**
   * Creates or updates one deployment record.
   *
   * `deployedAt` is PRESERVED from any existing record and `updatedAt` is taken
   * from the caller (Requirement 2.7), which is also what makes a repeated write
   * of the same record byte-identical rather than merely equivalent
   * (Requirement 1.7).
   */
  async registerDeployment(
    record: DeploymentRecord,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isRegistrySegment(record.ownerId) || !isRegistrySegment(record.workflowId)) {
      return { ok: false, error: 'A deployment owner and workflow id must not contain ":".' };
    }
    const key = deploymentKey(record.ownerId, record.workflowId);
    const existing = await this.ctx.storage.get<DeploymentRecord>(key);
    await this.ctx.storage.put(key, {
      ...record,
      deployedAt: existing?.deployedAt ?? record.deployedAt,
    } satisfies DeploymentRecord);
    return { ok: true };
  }

  /** Removes one deployment record. Idempotent (Requirement 1.8). */
  async deregisterDeployment(ownerId: string, workflowId: string): Promise<{ removed: boolean }> {
    if (!isRegistrySegment(ownerId) || !isRegistrySegment(workflowId)) {
      return { removed: false };
    }
    return { removed: await this.ctx.storage.delete(deploymentKey(ownerId, workflowId)) };
  }

  /** One deployment record, or null. */
  async getDeployment(ownerId: string, workflowId: string): Promise<DeploymentRecord | null> {
    if (!isRegistrySegment(ownerId) || !isRegistrySegment(workflowId)) return null;
    return (await this.ctx.storage.get<DeploymentRecord>(deploymentKey(ownerId, workflowId))) ?? null;
  }

  /**
   * Every deployment for one owner, newest first.
   *
   * The trailing colon in the prefix is load-bearing: without it an owner named
   * `user_a` would also match `user_ab`'s records. Same trap the
   * `{workflowId}::` state scope separator exists to avoid.
   */
  async listDeployments(ownerId: string): Promise<DeploymentRecord[]> {
    if (!isRegistrySegment(ownerId)) return [];
    const map = await this.ctx.storage.list<DeploymentRecord>({
      prefix: `deploy:${ownerId}:`,
    });
    return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** The record for a workflow, whatever slug it currently holds. */
  async statusFor(workflowId: string): Promise<PortalStatus> {
    for (const record of await this.allRecords()) {
      if (record.workflowId === workflowId) return { record };
    }
    return { record: null };
  }

  /**
   * Slugs claimed by OTHER workflows - what the studio's validator needs to
   * warn about a collision before the owner hits publish.
   */
  async takenSlugs(exceptWorkflowId: string): Promise<string[]> {
    return (await this.allRecords())
      .filter(record => record.workflowId !== exceptWorkflowId)
      .map(record => record.slug);
  }

  /** Replaces a portal's access-key list (mint and revoke both land here). */
  async setTokens(
    workflowId: string,
    tokens: PortalTokenRecord[],
  ): Promise<{ ok: boolean }> {
    const { record } = await this.statusFor(workflowId);
    if (!record) return { ok: false };
    await this.ctx.storage.put(`portal:${record.slug}`, {
      ...record,
      tokens,
      updatedAt: Date.now(),
    });
    return { ok: true };
  }

  /**
   * How many portals an owner currently has published, excluding one workflow
   * (so re-publishing an existing portal never trips the tier cap).
   */
  async countForOwner(ownerId: string, exceptWorkflowId: string): Promise<number> {
    return (await this.allRecords()).filter(
      record => record.ownerId === ownerId && record.workflowId !== exceptWorkflowId,
    ).length;
  }

  /** Bumps the visit counter (and a key's `lastUsedAt`, when one was used). */
  async recordHit(slug: string, tokenId?: string): Promise<void> {
    const record = await this.resolve(slug);
    if (!record) return;
    const tokens = tokenId
      ? record.tokens.map(token =>
          token.id === tokenId ? { ...token, lastUsedAt: Date.now() } : token,
        )
      : record.tokens;
    await this.ctx.storage.put(`portal:${slug}`, {
      ...record,
      tokens,
      hits: (record.hits ?? 0) + 1,
      lastHitAt: Date.now(),
    });
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────

  /**
   * Token-bucket check for one visitor message. Two windows are enforced:
   * per-visitor (the portal's own setting) and per-slug (a hard ceiling that
   * stops a botnet from spending the owner's model budget through one page).
   */
  async checkRate(slug: string, visitor: string, perMin: number): Promise<RateVerdict> {
    const now = Date.now();
    const visitorVerdict = this.consume(`v:${slug}:${visitor}`, Math.max(1, perMin), now);
    if (!visitorVerdict.allowed) return visitorVerdict;

    const slugVerdict = this.consume(`s:${slug}`, SLUG_CEILING_PER_MIN, now);
    if (!slugVerdict.allowed) {
      // Refund the visitor's slot: they were not the one over budget, and
      // charging them twice would compound into a much longer lockout.
      this.refund(`v:${slug}:${visitor}`);
      return slugVerdict;
    }
    return { allowed: true, retryAfter: 0 };
  }

  private consume(key: string, limit: number, now: number): RateVerdict {
    const bucket = this.buckets.get(key) ?? { hits: [] };
    bucket.hits = bucket.hits.filter(at => now - at < WINDOW_MS);
    if (bucket.hits.length >= limit) {
      const oldest = bucket.hits[0];
      this.buckets.set(key, bucket);
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000)) };
    }
    bucket.hits.push(now);
    this.buckets.set(key, bucket);
    this.pruneBuckets(now);
    return { allowed: true, retryAfter: 0 };
  }

  private refund(key: string): void {
    const bucket = this.buckets.get(key);
    bucket?.hits.pop();
  }

  /** Drops buckets whose window has fully elapsed once the table grows big. */
  private pruneBuckets(now: number): void {
    if (this.buckets.size <= MAX_BUCKETS) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.hits.every(at => now - at >= WINDOW_MS)) this.buckets.delete(key);
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async allRecords(): Promise<PublishRecord[]> {
    const map = await this.ctx.storage.list<PublishRecord>({ prefix: 'portal:' });
    return [...map.values()];
  }

  private async slugsForWorkflow(workflowId: string): Promise<string[]> {
    return (await this.allRecords())
      .filter(record => record.workflowId === workflowId)
      .map(record => record.slug);
  }
}

/** The one place the deployment key shape is written. */
function deploymentKey(ownerId: string, workflowId: string): string {
  return `deploy:${ownerId}:${workflowId}`;
}

/**
 * The owner segment for a deployment key: the verified Clerk userId in hosted
 * mode, the {@link DEFAULT_DEPLOYMENT_OWNER} literal in BYO.
 *
 * Every caller goes through this so "BYO has one owner" is stated once rather
 * than re-derived from a nullable field at each call site.
 */
export function deploymentOwner(ownerId: string | null | undefined): string {
  return ownerId && ownerId.length > 0 ? ownerId : DEFAULT_DEPLOYMENT_OWNER;
}

// ── Accessor ────────────────────────────────────────────────────────────────

/** Env slice needed to reach the registry. */
export interface PortalRegistryEnv {
  PortalIndex: DurableObjectNamespace<PortalIndex>;
}

/**
 * The registry stub. Every caller goes through this so the singleton name
 * exists in exactly one place.
 */
export function portalIndex(env: PortalRegistryEnv): DurableObjectStub<PortalIndex> {
  return env.PortalIndex.get(env.PortalIndex.idFromName('portal-index'));
}

/**
 * The Durable Object name the GATEWAY gives one owner's workflow instance
 * (Requirement 2.1).
 *
 * THE ENCODING IS LOAD-BEARING, and it is not obvious. `index.ts` builds
 * `{ownerId}:{workflowId}` and then writes it into the path as
 * `encodeURIComponent(scoped)`, while partyserver's `routePartykitRequest` takes
 * the instance name straight out of `pathname.split('/')` WITHOUT decoding it. So
 * the name workerd actually hashes is the percent-encoded one - `org_a%3Awf-x`,
 * never `org_a:wf-x` - and `idFromName` of the two strings yields two DIFFERENT
 * Durable Objects. Measured against the real deploy bundle, not inferred.
 *
 * Anything that reaches an owner's instance BY NAME rather than through the
 * gateway therefore has to go through here, or it silently addresses a blank
 * instance: no error, no log line, just an empty answer.
 *
 * In BYO mode there is no owner prefix and so nothing to encode, which is why
 * this has never mattered there.
 */
export function workflowAgentInstance(ownerId: string | null, workflowId: string): string {
  return ownerId ? encodeURIComponent(`${ownerId}:${workflowId}`) : workflowId;
}

/**
 * The DO instance name a portal's runs execute under.
 *
 * Session scoping is the answer to the single-run concurrency limit: one
 * `WorkflowAgent` refuses concurrent runs (409), so every visitor conversation
 * gets its own instance. `#s` is a separator the studio never produces, so a
 * session instance can never collide with a workflow instance. In hosted mode
 * the owner prefix mirrors the gateway's `{userId}:{workflowId}` scheme, which
 * keeps tenant isolation structural even though the visitor has no JWT.
 *
 * NOTE, and do not "tidy" this into {@link workflowAgentInstance}: this name is
 * UNENCODED, so in hosted mode it does not agree with the name the gateway gives
 * the owner's own instance. A session instance is only ever reached by this
 * function and by `purgeSessionInstance`, which are consistent with each other, so
 * sessions work - but the same is not true of `portalOwnerInstance` below. See the
 * note there.
 *
 * Renaming these would move which Durable Object a live hosted portal session
 * reads, so it is not a drive-by change. The third call site that built the raw
 * form, `askInstance` in `notifications.ts`, WAS fixed - it is reached only by a
 * poll that returns a fresh answer every tick, so there was no live state to move.
 */
export function portalSessionInstance(record: PublishRecord, sessionId: string): string {
  const prefix = record.ownerId ? `${record.ownerId}:` : '';
  return `${prefix}${record.workflowId}#s${sessionId}`;
}

/**
 * The owner's primary instance for a published workflow (no session suffix).
 *
 * KNOWN DISCREPANCY, left as it is rather than changed here: in HOSTED mode this
 * returns the unencoded `{ownerId}:{workflowId}`, which is not the name the gateway
 * gave that instance (see {@link workflowAgentInstance}). Anything reaching the
 * owner's instance through this name therefore finds a blank one.
 *
 * `askInstance` in `notifications.ts` had the same defect and is now fixed. This
 * one is NOT, and the difference is what is at stake: the notification fan-out is
 * a poll whose answer is re-derived every tick, so correcting its name changed
 * nothing but which instance it reads; a PUBLISHED PORTAL is live, and the
 * instance this function names is where a visitor's conversation is already
 * running. Moving it needs its own reproduction, its own tests and a decision
 * about sessions in flight, so it needs its own task rather than a drive-by fix.
 * BYO is unaffected: with no owner prefix there is nothing to encode.
 */
export function portalOwnerInstance(record: PublishRecord): string {
  const prefix = record.ownerId ? `${record.ownerId}:` : '';
  return `${prefix}${record.workflowId}`;
}

/** True when an instance name denotes a portal session, not a workflow. */
export function isPortalSessionInstance(name: string): boolean {
  return name.includes('#s');
}
