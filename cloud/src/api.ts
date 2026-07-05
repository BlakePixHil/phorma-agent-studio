/**
 * Phorma Cloud control-plane routes (`/api/*`) — hosted mode only.
 *
 *   GET  /api/me          (Clerk JWT)   → tenant profile + quota snapshot
 *   POST /api/provision   (admin token) → create/upgrade a tenant: mints a
 *                                         limit-capped OpenRouter runtime key
 *   POST /api/deactivate  (admin token) → disable a tenant + its runtime key
 *
 * Provisioning is admin-token-gated for now (manual billing). A Stripe
 * webhook worker can call the same endpoints later without schema changes.
 */

import { verifyRequest, type AuthEnv } from './auth';
import {
  TenantStore,
  currentMonth,
  disableOpenRouterKey,
  encryptString,
  provisionOpenRouterKey,
  tierLimits,
  type TenantEnv,
} from './tenants';

export type ApiEnv = AuthEnv & TenantEnv;

/**
 * Handles /api/* requests. Returns null when the path is not an API route.
 *
 * Any unhandled exception in the inner handler is caught here and returned
 * as a normal JSON response WITH the CORS headers attached. Without this,
 * an uncaught throw lets Cloudflare's own error page replace the response —
 * which carries no CORS headers — and the browser reports it as a CORS
 * failure, hiding the real 500 (see the KV min-TTL incident, 2026-07-05).
 */
export async function handleApiRequest(
  request: Request,
  env: ApiEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;

  try {
    return await routeApiRequest(request, env, cors, url);
  } catch (error) {
    console.error('Unhandled /api error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Internal error.' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...cors } },
    );
  }
}

async function routeApiRequest(
  request: Request,
  env: ApiEnv,
  cors: Record<string, string>,
  url: URL,
): Promise<Response> {
  const respond = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...cors },
    });

  const store = new TenantStore(env);
  if (!store.enabled) {
    return respond({ error: 'Control plane unavailable: hosted bindings missing.' }, 501);
  }

  // ── GET /api/me — the signed-in tenant's profile + quota ──────────────────
  if (request.method === 'GET' && url.pathname === '/api/me') {
    const auth = await verifyRequest(env, request);
    if (!auth?.userId) return respond({ error: 'Unauthorized.' }, 401);

    const tenant = await store.getTenant(auth.userId);
    if (!tenant) {
      return respond({
        id: auth.userId,
        provisioned: false,
        tier: null,
        status: null,
        quota: null,
      });
    }
    const quota = await store.getQuota(tenant.id, tenant.tier);
    return respond({
      id: tenant.id,
      provisioned: true,
      tier: tenant.tier,
      status: tenant.status,
      quota: {
        month: quota.month,
        runsUsed: quota.runsUsed,
        runsLimit: quota.limits.monthlyRuns,
        costUsdUsed: quota.costUsdUsed,
        costUsdLimit: quota.limits.monthlyCostUsd,
      },
    });
  }

  // ── Admin endpoints (manual billing until Stripe lands) ───────────────────
  const adminToken = env.PHORMA_ADMIN_TOKEN;
  const authHeader = request.headers.get('Authorization') ?? '';
  const isAdmin =
    Boolean(adminToken) && authHeader === `Bearer ${adminToken}`;

  if (request.method === 'POST' && url.pathname === '/api/provision') {
    if (!isAdmin) return respond({ error: 'Unauthorized.' }, 401);
    const body = (await request.json().catch(() => null)) as {
      tenantId?: string;
      email?: string;
      tier?: string;
    } | null;
    if (!body?.tenantId) return respond({ error: 'tenantId is required.' }, 400);

    const tier = body.tier ?? 'starter';
    const limits = tierLimits(tier);

    let keyId: string | null = null;
    let keyEnc: string | null = null;
    if (env.OPENROUTER_PROVISIONING_KEY && env.KEY_ENC_SECRET) {
      const minted = await provisionOpenRouterKey(
        env.OPENROUTER_PROVISIONING_KEY,
        body.tenantId,
        limits.monthlyCostUsd,
      );
      keyId = minted.hash || null;
      keyEnc = await encryptString(minted.key, env.KEY_ENC_SECRET);
    }

    await store.upsertTenant({
      id: body.tenantId,
      email: body.email ?? null,
      tier,
      status: 'active',
      openrouterKeyId: keyId,
      openrouterKeyEnc: keyEnc,
    });
    return respond({
      ok: true,
      tenantId: body.tenantId,
      tier,
      month: currentMonth(),
      runtimeKeyProvisioned: keyEnc !== null,
    });
  }

  if (request.method === 'POST' && url.pathname === '/api/deactivate') {
    if (!isAdmin) return respond({ error: 'Unauthorized.' }, 401);
    const body = (await request.json().catch(() => null)) as { tenantId?: string } | null;
    if (!body?.tenantId) return respond({ error: 'tenantId is required.' }, 400);

    const tenant = await store.getTenant(body.tenantId);
    if (!tenant) return respond({ error: 'Unknown tenant.' }, 404);

    if (tenant.openrouterKeyId && env.OPENROUTER_PROVISIONING_KEY) {
      await disableOpenRouterKey(env.OPENROUTER_PROVISIONING_KEY, tenant.openrouterKeyId).catch(
        () => undefined, // key may already be disabled — deactivation still proceeds
      );
    }
    await store.upsertTenant({ ...tenant, status: 'canceled' });
    return respond({ ok: true, tenantId: tenant.id, status: 'canceled' });
  }

  return respond({ error: 'Not found.' }, 404);
}
