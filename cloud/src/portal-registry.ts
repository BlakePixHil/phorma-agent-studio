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
  // session DO is initialised; `deleteSessions` returns the instance names
  // and drops the tracking keys so a caller (the workflow DO's purge path)
  // can delete each session DO and the registry does not retain stale
  // references. `unpublish` does NOT clear sessions - the purge path calls
  // `deleteSessions` explicitly after unpublishing, so a transient unpublish
  // (re-publish to a new slug) does not destroy in-flight conversations.

  /** Records a portal session instance so it can be torn down later. Idempotent. */
  async addSession(workflowId: string, sessionId: string, instanceName: string): Promise<void> {
    await this.ctx.storage.put(`session:${workflowId}:${sessionId}`, instanceName);
  }

  /**
   * Returns every tracked session instance name for a workflow and drops the
   * tracking keys. Callers delete each session DO; the registry keeps no
   * stale references. Idempotent.
   */
  async deleteSessions(workflowId: string): Promise<string[]> {
    const map = await this.ctx.storage.list<string>({ prefix: `session:${workflowId}:` });
    const names = [...map.values()];
    for (const key of map.keys()) await this.ctx.storage.delete(key);
    return names;
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
 * The DO instance name a portal's runs execute under.
 *
 * Session scoping is the answer to the single-run concurrency limit: one
 * `WorkflowAgent` refuses concurrent runs (409), so every visitor conversation
 * gets its own instance. `#s` is a separator the studio never produces, so a
 * session instance can never collide with a workflow instance. In hosted mode
 * the owner prefix mirrors the gateway's `{userId}:{workflowId}` scheme, which
 * keeps tenant isolation structural even though the visitor has no JWT.
 */
export function portalSessionInstance(record: PublishRecord, sessionId: string): string {
  const prefix = record.ownerId ? `${record.ownerId}:` : '';
  return `${prefix}${record.workflowId}#s${sessionId}`;
}

/** The owner's primary instance for a published workflow (no session suffix). */
export function portalOwnerInstance(record: PublishRecord): string {
  const prefix = record.ownerId ? `${record.ownerId}:` : '';
  return `${prefix}${record.workflowId}`;
}

/** True when an instance name denotes a portal session, not a workflow. */
export function isPortalSessionInstance(name: string): boolean {
  return name.includes('#s');
}
