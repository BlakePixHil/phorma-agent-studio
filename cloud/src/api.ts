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
  creditsForTier,
  currentMonth,
  disableOpenRouterKey,
  encryptString,
  provisionOpenRouterKey,
  resolveHostedInference,
  toOpenRouterModel,
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
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;

  try {
    return await routeApiRequest(request, env, cors, url, ctx);
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
  ctx: ExecutionContext,
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
        // Usage credits are the only billing unit the UI shows. The USD fields
        // are kept for internal analytics/admin tooling but never displayed.
        creditsUsed: creditsForTier(tenant.tier, quota.costUsdUsed),
        creditsLimit: quota.limits.monthlyCredits,
        costUsdUsed: quota.costUsdUsed,
        costUsdLimit: quota.limits.monthlyCostUsd,
      },
    });
  }

  // ── POST /api/infer — per-request LLM proxy for local runs ───────────────
  // Lets a local run spend the tenant's Phorma Cloud credits: the studio
  // POSTs an OpenRouter-shaped chat/completions request (model already a
  // curated OpenRouter slug), we verify the Clerk JWT, gate on subscription +
  // quota, inject the tenant's runtime key, forward to OpenRouter, stream the
  // SSE response back, and meter usage via recordRun. The tenant key never
  // leaves the worker.
  if (request.method === 'POST' && url.pathname === '/api/infer') {
    const auth = await verifyRequest(env, request);
    if (!auth?.userId) return respond({ error: 'Unauthorized.' }, 401);

    const body = (await request.json().catch(() => null)) as {
      model?: string;
      messages?: unknown[];
      system?: string;
      temperature?: number;
      maxTokens?: number;
      stream?: boolean;
      streamOptions?: unknown;
      usage?: unknown;
      tools?: unknown[];
    } | null;
    if (!body?.model || !Array.isArray(body.messages)) {
      return respond({ error: 'Body must include model + messages.' }, 400);
    }

    const gate = await resolveHostedInference(store, auth.userId);
    if ('status' in gate) return respond({ error: gate.error }, gate.status);
    const tenantKey = gate.key;

    // Rebuild the OpenRouter request body with usage accounting on (so we can
    // meter cost). The studio already sends these fields; we ensure them here
    // so a malformed client can't dodge metering.
    const upstreamBody = JSON.stringify({
      model: body.model,
      stream: true,
      temperature: body.temperature,
      max_tokens: body.maxTokens ?? 4096,
      messages: body.messages,
      stream_options: { include_usage: true },
      usage: { include: true },
      tools: body.tools,
    });

    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantKey}`,
      },
      body: upstreamBody,
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      return respond(
        { error: `OpenRouter request failed (${upstream.status}): ${detail.slice(0, 300)}` },
        upstream.status >= 400 ? upstream.status : 502,
      );
    }

    // Tee the stream: one copy goes to the client, the other is parsed to
    // extract the usage block for billing. We meter the run once the stream
    // ends (best-effort — a ledger failure never breaks a run).
    const [clientStream, meterStream] = upstream.body.tee();
    const runId = `infer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // Meter on the SECOND stream copy. Must run via waitUntil: without it the
    // worker is torn down as soon as the client finishes reading its copy,
    // killing the metering promise before recordRun writes to D1 (usage would
    // silently stay at 0). waitUntil keeps the invocation alive until the
    // ledger write settles. Best-effort — a failure never breaks the run.
    ctx.waitUntil(
      meterInferenceStream(meterStream, store, auth.userId, runId, body.model).catch(
        () => undefined,
      ),
    );

    return new Response(clientStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        ...cors,
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

/**
 * Parses an OpenRouter SSE stream's usage block and records a ledger row +
 * quota rollup for one /api/infer call. Best-effort: a parse or ledger
 * failure never breaks the run (the client already has its stream copy).
 */
async function meterInferenceStream(
  stream: ReadableStream<Uint8Array>,
  store: TenantStore,
  tenantId: string,
  runId: string,
  model: string,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload) as {
          usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | null;
        };
        if (parsed.usage) {
          inputTokens += parsed.usage.prompt_tokens ?? 0;
          outputTokens += parsed.usage.completion_tokens ?? 0;
          costUsd += parsed.usage.cost ?? 0;
        }
      } catch {
        // Partial JSON across chunks — ignore; usage arrives in a complete frame.
      }
    }
  }

  await store.recordRun({
    tenantId,
    runId,
    workflowId: `infer:${model}`,
    costUsd,
    tokensIn: inputTokens,
    tokensOut: outputTokens,
    // Local-run inference consumes credits (cost) but must NOT inflate the
    // monthly run count — "runs" is a deployed-workflow-execution concept.
    // Otherwise every agent node × tool-call round in a local debug run
    // would each count as a "run" against the tenant's allowance.
    countsAsRun: false,
  });
}
