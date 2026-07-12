/**
 * Phorma Cloud tenant store — hosted-mode control plane.
 *
 * Owns everything multi-tenant that is NOT run execution:
 *  - tenant records (D1 `tenants` table, KV-cached for the hot path)
 *  - tier definitions + quota math (D1 `quotas` rollup)
 *  - per-run usage ledger writes (D1 `usage` table)
 *  - per-tenant OpenRouter runtime keys: minted through OpenRouter's
 *    provisioning API with a hard credit limit, stored AES-GCM encrypted
 *
 * BYO deployments never bind `DB`/`TENANTS`, so none of this code runs
 * outside Phorma Labs' own deployment.
 */

export interface TenantEnv {
  /** D1 — authoritative tenant/usage/quota store (hosted mode only). */
  DB?: D1Database;
  /** KV — short-TTL cache for tenant rows + quota rollups (hosted mode only). */
  TENANTS?: KVNamespace;
  /** 32-byte base64 secret for AES-GCM encryption of stored runtime keys. */
  KEY_ENC_SECRET?: string;
  /** OpenRouter provisioning (management) key — mints per-tenant runtime keys. */
  OPENROUTER_PROVISIONING_KEY?: string;
  /** Static bearer protecting the admin provisioning endpoints. */
  PHORMA_ADMIN_TOKEN?: string;
}

// ── Tiers ────────────────────────────────────────────────────────────────────

export interface TierLimits {
  /**
   * Monthly usage-credit allowance shown to the user — the ONLY billing unit
   * the UI ever displays. Deliberately a round marketing number that is
   * decoupled from the real inference cost so the underlying spend (and our
   * margin) stays abstract. Higher tiers include a volume bonus: a credit
   * buys progressively more real inference as the tier climbs.
   */
  monthlyCredits: number;
  /**
   * Monthly inference budget (USD) — the real spend cap, mirrored into the
   * OpenRouter key limit. NEVER surfaced to the user; `monthlyCredits` is the
   * public face of this number. The per-tier ratio of credits→USD is the
   * "burn rate" (higher tiers burn slower = the volume bonus).
   */
  monthlyCostUsd: number;
  /** Monthly run count cap. */
  monthlyRuns: number;
  /** Max concurrently running workflows (enforced per-instance for now). */
  concurrentRuns: number;
  /** Max active cron schedules per workflow. */
  schedulesPerWorkflow: number;
}

// Base rate: 125 credits ≈ $1 of real inference ($0.008/credit) with NO bonus
// (starter). Higher tiers keep round credit numbers but a larger USD budget,
// so each credit buys more real inference — the volume bonus. The USD budget
// is deliberately set to ~20% of price (was ~40%) to target a 75-80% gross
// margin on the AI spend line — the only real cost, since Cloudflare infra
// (DO duration/requests + D1 + KV) runs at a small fraction of a cent per run
// and is not a meaningful lever. Prices (margin reference, enforced once
// billing lands): starter $20 (80%), plus $40 (79.6%, +2% bonus), pro $60
// (79%, +5%), team $200 (78%, +10%). Credit numbers are UNCHANGED by this —
// only the internal budget moved, which is the point of the abstraction.
export const TIERS: Record<string, TierLimits> = {
  starter: { monthlyCredits: 1000, monthlyCostUsd: 4, monthlyRuns: 300, concurrentRuns: 1, schedulesPerWorkflow: 1 },
  plus: { monthlyCredits: 2000, monthlyCostUsd: 8.16, monthlyRuns: 1000, concurrentRuns: 2, schedulesPerWorkflow: 3 },
  pro: { monthlyCredits: 3000, monthlyCostUsd: 12.6, monthlyRuns: 2000, concurrentRuns: 3, schedulesPerWorkflow: 5 },
  team: { monthlyCredits: 10000, monthlyCostUsd: 44, monthlyRuns: 10000, concurrentRuns: 10, schedulesPerWorkflow: 20 },
};

export function tierLimits(tier: string): TierLimits {
  return TIERS[tier] ?? TIERS['starter'];
}

/**
 * Converts a real USD inference cost into the tier's display credits. Uses the
 * tier's own credits↔USD ratio so the volume bonus is applied automatically:
 * `credits = round(costUsd / monthlyCostUsd * monthlyCredits)`. Result is
 * clamped at 0. This is the ONLY function that turns dollars into the number
 * the user sees.
 */
export function creditsForTier(tier: string, costUsd: number): number {
  const limits = tierLimits(tier);
  if (limits.monthlyCostUsd <= 0) return 0;
  return Math.max(0, Math.round((costUsd / limits.monthlyCostUsd) * limits.monthlyCredits));
}

/** Credits earned per USD of real inference for a tier (the inverse burn rate). */
export function creditsPerUsd(tier: string): number {
  const limits = tierLimits(tier);
  if (limits.monthlyCostUsd <= 0) return 0;
  return limits.monthlyCredits / limits.monthlyCostUsd;
}

// ── Records ──────────────────────────────────────────────────────────────────

export interface TenantRecord {
  id: string;
  email: string | null;
  tier: string;
  status: 'active' | 'past_due' | 'canceled';
  openrouterKeyId: string | null;
  openrouterKeyEnc: string | null;
}

export interface QuotaSnapshot {
  month: string;
  runsUsed: number;
  costUsdUsed: number;
  limits: TierLimits;
}

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

const TENANT_CACHE_TTL_S = 60;
// Cloudflare KV enforces a 60s minimum expirationTtl — anything lower is
// rejected with a 400 (which previously surfaced to the browser as a bare
// CORS failure, since the unhandled exception replaced our response before
// CORS headers were attached).
const QUOTA_CACHE_TTL_S = 60;

/** Data-access layer over D1 + KV for tenant state. */
export class TenantStore {
  constructor(private readonly env: TenantEnv) {}

  /** True when the hosted bindings are present. */
  get enabled(): boolean {
    return Boolean(this.env.DB);
  }

  private get db(): D1Database {
    if (!this.env.DB) throw new Error('Tenant store requires the DB (D1) binding.');
    return this.env.DB;
  }

  // ── Tenant rows ────────────────────────────────────────────────────────────

  async getTenant(id: string): Promise<TenantRecord | null> {
    const cacheKey = `tenant:${id}`;
    const cached = await this.env.TENANTS?.get(cacheKey, 'json');
    if (cached) return cached as TenantRecord;

    const row = await this.db
      .prepare(
        'SELECT id, email, tier, status, openrouter_key_id, openrouter_key_enc FROM tenants WHERE id = ?',
      )
      .bind(id)
      .first<{
        id: string;
        email: string | null;
        tier: string;
        status: string;
        openrouter_key_id: string | null;
        openrouter_key_enc: string | null;
      }>();
    if (!row) return null;

    const record: TenantRecord = {
      id: row.id,
      email: row.email,
      tier: row.tier,
      status: row.status as TenantRecord['status'],
      openrouterKeyId: row.openrouter_key_id,
      openrouterKeyEnc: row.openrouter_key_enc,
    };
    await this.env.TENANTS?.put(cacheKey, JSON.stringify(record), {
      expirationTtl: TENANT_CACHE_TTL_S,
    });
    return record;
  }

  async upsertTenant(record: {
    id: string;
    email?: string | null;
    tier: string;
    status: string;
    openrouterKeyId?: string | null;
    openrouterKeyEnc?: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO tenants (id, email, tier, status, openrouter_key_id, openrouter_key_enc, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           email = COALESCE(excluded.email, tenants.email),
           tier = excluded.tier,
           status = excluded.status,
           openrouter_key_id = COALESCE(excluded.openrouter_key_id, tenants.openrouter_key_id),
           openrouter_key_enc = COALESCE(excluded.openrouter_key_enc, tenants.openrouter_key_enc),
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.id,
        record.email ?? null,
        record.tier,
        record.status,
        record.openrouterKeyId ?? null,
        record.openrouterKeyEnc ?? null,
        now,
        now,
      )
      .run();
    await this.env.TENANTS?.delete(`tenant:${record.id}`);
  }

  // ── Quotas + usage ledger ──────────────────────────────────────────────────

  async getQuota(tenantId: string, tier: string): Promise<QuotaSnapshot> {
    const month = currentMonth();
    const cacheKey = `quota:${tenantId}:${month}`;
    const limits = tierLimits(tier);

    const cached = await this.env.TENANTS?.get(cacheKey, 'json');
    if (cached) {
      const { runsUsed, costUsdUsed } = cached as { runsUsed: number; costUsdUsed: number };
      return { month, runsUsed, costUsdUsed, limits };
    }

    const row = await this.db
      .prepare('SELECT runs_used, cost_usd_used FROM quotas WHERE tenant_id = ? AND month = ?')
      .bind(tenantId, month)
      .first<{ runs_used: number; cost_usd_used: number }>();
    const snapshot = {
      month,
      runsUsed: row?.runs_used ?? 0,
      costUsdUsed: row?.cost_usd_used ?? 0,
      limits,
    };
    await this.env.TENANTS?.put(
      cacheKey,
      JSON.stringify({ runsUsed: snapshot.runsUsed, costUsdUsed: snapshot.costUsdUsed }),
      { expirationTtl: QUOTA_CACHE_TTL_S },
    );
    return snapshot;
  }

  /** Records one settled run: ledger row + rollup bump + cache bust. */
  async recordRun(entry: {
    tenantId: string;
    runId: string;
    workflowId: string;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
    durationMs?: number;
    /**
     * Whether this bumps the monthly `runs_used` count. True for a deployed
     * workflow execution (the "runs" quota is a per-workflow-run concept).
     * FALSE for local-run `/api/infer` inference calls — those consume
     * credits (cost) but must NOT inflate the run count, otherwise every
     * agent node × tool-call round in a local debug run would each count as a
     * "run". Defaults to true. Cost is always metered regardless.
     */
    countsAsRun?: boolean;
  }): Promise<void> {
    const month = currentMonth();
    const now = new Date().toISOString();
    const runIncrement = entry.countsAsRun === false ? 0 : 1;
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO usage (tenant_id, run_id, workflow_id, month, cost_usd, tokens_in, tokens_out, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          entry.tenantId,
          entry.runId,
          entry.workflowId,
          month,
          entry.costUsd,
          entry.tokensIn,
          entry.tokensOut,
          entry.durationMs ?? null,
          now,
        ),
      this.db
        .prepare(
          `INSERT INTO quotas (tenant_id, month, runs_used, cost_usd_used)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(tenant_id, month) DO UPDATE SET
             runs_used = quotas.runs_used + excluded.runs_used,
             cost_usd_used = quotas.cost_usd_used + excluded.cost_usd_used`,
        )
        .bind(entry.tenantId, month, runIncrement, entry.costUsd),
    ]);
    await this.env.TENANTS?.delete(`quota:${entry.tenantId}:${month}`);
  }

  // ── Runtime key resolution ─────────────────────────────────────────────────

  /** Decrypts a tenant's OpenRouter runtime key (null when not provisioned). */
  async runtimeKey(tenant: TenantRecord): Promise<string | null> {
    if (!tenant.openrouterKeyEnc || !this.env.KEY_ENC_SECRET) return null;
    try {
      return await decryptString(tenant.openrouterKeyEnc, this.env.KEY_ENC_SECRET);
    } catch {
      return null;
    }
  }
}

// ── Hosted inference mapping (shared by the DO + the /api/infer proxy) ───────

/**
 * Maps a node's declared provider to the OpenRouter model-slug prefix. Hosted
 * inference is OpenRouter-only: whatever provider a node declares is rewritten
 * to the equivalent OpenRouter slug and billed against the tenant's runtime
 * key. `null` means the provider has no hosted equivalent (rejected).
 *
 * `phorma-cloud` nodes already store a full OpenRouter slug as their model id
 * (the curated big-name set), so they map with an empty prefix.
 */
export const OPENROUTER_SLUG_PREFIX: Record<string, string | null> = {
  anthropic: 'anthropic/',
  openai: 'openai/',
  gemini: 'google/',
  openrouter: '', // already a full slug
  'phorma-cloud': '', // already a full OpenRouter slug (curated)
  bedrock: null, // BYO-key only — hosted (OpenRouter) inference has no Bedrock path
  ollama: null, // no hosted equivalent — rejected in hosted mode
};

/**
 * Rewrites a provider/model pair to its OpenRouter equivalent. Returns the
 * mapped `{ provider: 'openrouter', model }` or an error string when the
 * provider can't be hosted (Ollama/Bedrock).
 */
export function toOpenRouterModel(
  provider: string,
  model: string,
): { provider: 'openrouter'; model: string } | string {
  const prefix = OPENROUTER_SLUG_PREFIX[provider];
  if (prefix === null) {
    return `Provider "${provider}" is not available on Phorma Cloud. Pick a cloud model.`;
  }
  return { provider: 'openrouter', model: provider === 'openrouter' || provider === 'phorma-cloud' ? model : `${prefix}${model}` };
}

/**
 * Pre-flight quota + subscription gate for a hosted inference call. Returns
 * the decrypted OpenRouter runtime key on success, or a `{ status, error }`
 * response body for the caller to return directly. Mirrors the checks in
 * `WorkflowAgent.trigger()` so local-run proxy calls and deployed-workflow
 * triggers share identical gating.
 */
export async function resolveHostedInference(
  store: TenantStore,
  tenantId: string,
): Promise<{ key: string } | { status: number; error: string }> {
  const tenant = await store.getTenant(tenantId);
  if (!tenant || tenant.status !== 'active') {
    return {
      status: 402,
      error: 'No active Phorma Cloud subscription. Visit Settings → Cloud to subscribe.',
    };
  }
  const quota = await store.getQuota(tenant.id, tenant.tier);
  if (quota.runsUsed >= quota.limits.monthlyRuns) {
    return {
      status: 429,
      error: `Monthly run limit reached (${quota.limits.monthlyRuns}). Resets next month or upgrade your plan.`,
    };
  }
  if (quota.costUsdUsed >= quota.limits.monthlyCostUsd) {
    return {
      status: 402,
      error: 'Monthly credits exhausted. Resets next month or upgrade your plan.',
    };
  }
  const key = await store.runtimeKey(tenant);
  if (!key) {
    return {
      status: 402,
      error: 'Your Phorma Cloud account has no runtime key yet. Contact support.',
    };
  }
  return { key };
}

// ── OpenRouter key provisioning ──────────────────────────────────────────────

const OPENROUTER_KEYS_API = 'https://openrouter.ai/api/v1/keys';

/**
 * Mints a per-tenant OpenRouter runtime key with a hard credit limit.
 * Requires the provisioning (management) key. Returns the key + its hash
 * (used later to disable/rotate).
 */
export async function provisionOpenRouterKey(
  provisioningKey: string,
  tenantId: string,
  creditLimitUsd: number,
): Promise<{ key: string; hash: string }> {
  const response = await fetch(OPENROUTER_KEYS_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provisioningKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: `phorma-tenant-${tenantId}`, limit: creditLimitUsd }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenRouter key provisioning failed (${response.status}): ${detail.slice(0, 200)}`);
  }
  const body = (await response.json()) as { key?: string; data?: { hash?: string } };
  if (!body.key) throw new Error('OpenRouter provisioning response carried no key.');
  return { key: body.key, hash: body.data?.hash ?? '' };
}

/** Disables a previously provisioned runtime key. */
export async function disableOpenRouterKey(
  provisioningKey: string,
  keyHash: string,
): Promise<void> {
  const response = await fetch(`${OPENROUTER_KEYS_API}/${encodeURIComponent(keyHash)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${provisioningKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ disabled: true }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenRouter key disable failed (${response.status}): ${detail.slice(0, 200)}`);
  }
}

// ── AES-GCM string encryption (WebCrypto, no deps) ───────────────────────────

async function importAesKey(secretB64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(secretB64), char => char.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptString(plaintext: string, secretB64: string): Promise<string> {
  const key = await importAesKey(secretB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const packed = new Uint8Array(iv.length + cipher.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(cipher), iv.length);
  return btoa(String.fromCharCode(...packed));
}

export async function decryptString(packedB64: string, secretB64: string): Promise<string> {
  const key = await importAesKey(secretB64);
  const packed = Uint8Array.from(atob(packedB64), char => char.charCodeAt(0));
  const iv = packed.slice(0, 12);
  const cipher = packed.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new TextDecoder().decode(plain);
}
