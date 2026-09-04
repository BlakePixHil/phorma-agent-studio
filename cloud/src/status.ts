/**
 * Public service-status routes, served by the same Worker that hosts the
 * workflow runtime.
 *
 *   GET /status.json  -> rollup + one entry per service we depend on
 *   GET /status.svg   -> the same rollup as a badge (docs, README, embeds)
 *
 * Why the Worker aggregates instead of the website: phorma-labs.com is an
 * independent Framer site with no server side, so a browser-only check would
 * have to call Clerk and OpenRouter from every visitor - multiplying vendor
 * requests, leaking visitor IPs to those vendors, relying on their CORS, and
 * duplicating the red/amber rules. Here the fan-out happens once per cache
 * window and the site makes one request.
 *
 * The obvious gap is that this endpoint cannot report its own death. That is
 * closed on the client: a fetch failure, a timeout, or a non-200 renders red.
 * The Framer site therefore stays an honest outside observer.
 *
 * Design notes worth keeping:
 *
 * - CORS is open (`*`), NOT the shared `corsHeaders()` used by `/api/*`.
 *   Adding the marketing origin to `ALLOWED_ORIGINS` would widen the
 *   authenticated surface at the same time, which is not the trade we want for
 *   a public badge.
 * - Cloudflare's own status page is deliberately NOT rolled into the colour.
 *   Its global indicator is almost never "none" (some colo is always degraded),
 *   so trusting it would pin the badge amber forever. Our own functional probes
 *   decide colour for Cloudflare-backed components; the vendor page only
 *   annotates. Clerk's page is narrow enough to trust, so it does set colour.
 * - Probe detail strings are written by hand. A vendor error body or an
 *   internal exception message is never forwarded to this public route.
 * - `unknown` exists for a binding this deployment does not have. A BYO worker
 *   has no D1, KV or R2, and reporting that as red would be a lie.
 */

import { isHosted, type AuthEnv } from './auth';
import { WORKER_BUILD } from './build-info';
import { portalIndex, type PortalIndex } from './portal-registry';
import { secretVault, type SecretVaultEnv } from './secret-vault';
// Type-only, so the billing probe reads the same ONE description of the worker's
// Stripe configuration that `ApiEnv` folds in, without giving this module a
// runtime import edge into `stripe.ts` (and through it into `tenants.ts`).
import type { StripeEnv } from './stripe';
import { ensureTelemetrySchema } from './telemetry';

/** Per-component health. `unknown` means "not part of this deployment". */
export type ComponentStatus = 'operational' | 'degraded' | 'outage' | 'unknown';

/** The single value the website's indicator dot renders. */
export type RollupStatus = 'operational' | 'degraded' | 'outage';

/** Traffic-light colour, so the client never has to map statuses itself. */
export type Indicator = 'green' | 'amber' | 'red';

export interface StatusComponent {
  id: string;
  name: string;
  /** One sentence a non-technical visitor can understand. */
  description: string;
  status: ComponentStatus;
  /** Whether an outage here turns the whole rollup red. */
  critical: boolean;
  /** Round-trip of the probe in ms, or null when it did not run. */
  latencyMs: number | null;
  /** Short, hand-written explanation when not operational. */
  detail: string | null;
  /** Third party this component depends on, for the detail page. */
  vendor: string | null;
}

/** An operator-authored banner, set in KV without a deploy. */
export interface StatusNotice {
  /** Worst state this notice can force. Never improves the rollup. */
  status: 'degraded' | 'outage';
  message: string;
  /** ISO timestamp after which the notice is ignored. */
  until?: string;
}

export interface StatusPayload {
  status: RollupStatus;
  indicator: Indicator;
  summary: string;
  checkedAt: string;
  build: string;
  mode: 'hosted' | 'byo';
  notice: StatusNotice | null;
  components: StatusComponent[];
}

export interface StatusEnv extends AuthEnv, SecretVaultEnv, StripeEnv {
  /**
   * Untyped namespace to match `Env.WorkflowAgent`, then narrowed at the call
   * site - the same pattern `portal.ts` uses for its owner and session stubs.
   */
  WorkflowAgent?: DurableObjectNamespace;
  PortalIndex?: DurableObjectNamespace<PortalIndex>;
  DB?: D1Database;
  TENANTS?: KVNamespace;
  RELEASES?: R2Bucket;
  OPENROUTER_PROVISIONING_KEY?: string;
  PHORMA_ADMIN_TOKEN?: string;
}

const PUBLIC_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * Edge-cache window. Every repeat visitor inside it is served without waking a
 * Durable Object or touching a vendor API, which is what keeps a public,
 * unauthenticated endpoint cheap under marketing-site traffic.
 */
const CACHE_TTL_SECONDS = 30;

/** Ceiling on any single probe. The whole response must beat a client timeout. */
const PROBE_TIMEOUT_MS = 4000;

/** Reserved DO instance names. Kept obviously non-tenant on purpose. */
const RUNTIME_PROBE_INSTANCE = 'phorma-health-probe';
const VAULT_PROBE_OWNER = 'phorma-health-probe';
const PORTAL_PROBE_SLUG = '__phorma-health-probe__';

/** KV keys: the probe target doubles as the operator notice. */
const NOTICE_KEY = 'status:notice';

/** Statuspage JSON for Clerk. Verified shape: `{ status: { indicator } }`. */
const CLERK_STATUS_URL = 'https://status.clerk.com/api/v2/status.json';

/** Clerk Backend API. A 200 here proves both Clerk and our key are healthy. */
const CLERK_PROBE_URL = 'https://api.clerk.com/v1/jwks';

/** Small authenticated OpenRouter read; validates the provisioning key too. */
const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits';

/** Unauthenticated fallback when no provisioning key is bound. */
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

/**
 * Stripe probe target: one page of the price catalogue, capped at a single
 * object.
 *
 * Chosen over the other cheap reads because of what it does NOT touch. `/v1/prices`
 * returns catalogue objects - no customer, no payment, no balance - so an
 * unauthenticated public route can never surface personal or financial data even
 * if a future change started reading the body. `/v1/balance` and
 * `/v1/customers` both fail that test. It is also the exact resource
 * `/api/checkout` reads when it resolves a lookup key, so a 200 here proves the
 * specific credential AND permission a real checkout needs: a restricted key
 * without price read fails this probe, which is the correct signal rather than a
 * false green.
 *
 * `limit=1` keeps it to the smallest page Stripe will serve, and it is a GET, so
 * the probe mutates nothing - no session, no customer, no charge.
 */
const STRIPE_PROBE_URL = 'https://api.stripe.com/v1/prices?limit=1';

/** Sent on every outbound probe. Some public APIs reject UA-less requests. */
const USER_AGENT = `PhormaStatus/${WORKER_BUILD} (+https://phorma-labs.com/status)`;

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Handles the status routes. Returns null when the path is not one of them, so
 * the caller falls through to the rest of the Worker.
 */
export async function handleStatusRequest(
  request: Request,
  env: StatusEnv,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  const isStatusPath = url.pathname === '/status.json' || url.pathname === '/status.svg';
  if (!isStatusPath) return null;

  if (request.method === 'OPTIONS') return new Response(null, { headers: PUBLIC_CORS });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'Method not allowed.' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...PUBLIC_CORS },
    });
  }

  // A cache bypass is admin-gated. Left open it would be a free way to force
  // every probe to run on every request.
  const bypass =
    url.searchParams.has('fresh') &&
    !!env.PHORMA_ADMIN_TOKEN &&
    request.headers.get('Authorization') === `Bearer ${env.PHORMA_ADMIN_TOKEN}`;

  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: 'GET' });
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache && !bypass) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const payload = await collectStatus(env);
  const response =
    url.pathname === '/status.svg' ? badgeResponse(payload) : jsonResponse(payload);

  if (cache) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function jsonResponse(payload: StatusPayload): Response {
  return new Response(JSON.stringify(payload), {
    // Always 200, even during an outage: a non-200 makes generic HTTP monitors
    // and Framer's fetch treat a correctly-reported outage as an unreachable
    // endpoint, which loses the detail we just gathered.
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
      ...PUBLIC_CORS,
    },
  });
}

// ── Aggregation ──────────────────────────────────────────────────────────────

/** Runs every probe concurrently and rolls the results up. */
export async function collectStatus(env: StatusEnv): Promise<StatusPayload> {
  const hosted = isHosted(env);
  const notice = await readNotice(env);

  const [
    runtime,
    database,
    plans,
    vault,
    portals,
    downloads,
    auth,
    inference,
    billing,
    telemetry,
  ] = await Promise.all([
    timed(() => probeRuntime(env)),
    timed(() => probeDatabase(env, hosted)),
    timed(() => probePlanStore(env, hosted)),
    timed(() => probeVault(env, hosted)),
    timed(() => probePortals(env)),
    timed(() => probeDownloads(env, hosted)),
    timed(() => probeAuth(env, hosted)),
    timed(() => probeInference(env, hosted)),
    timed(() => probeBilling(env)),
    timed(() => probeTelemetry(env)),
  ]);

  const components: StatusComponent[] = [
    describe('runtime', 'Workflow runtime', 'Runs your deployed workflows and streams live traces.', true, null, runtime),
    describe('api', 'Studio API', 'Sign-in checks, plan and quota lookups, model proxy.', true, null, database),
    describe('plans', 'Plan and quota store', 'Reads your tier and remaining monthly credits.', true, null, plans),
    describe('vault', 'Credential vault', 'Holds the encrypted keys a deployed workflow needs.', false, null, vault),
    describe('portals', 'Published portals', 'Public chat and form pages you have published.', false, null, portals),
    describe('downloads', 'Downloads and updates', 'Installer downloads and the in-app auto-updater.', false, null, downloads),
    describe('auth', 'Sign-in', 'Account sign-in and session verification.', true, 'Clerk', auth),
    describe('inference', 'Hosted models', 'Model calls billed to your Phorma Cloud credits.', true, 'OpenRouter', inference),
    // `critical: false` is requirement 35 and it is a product statement, not a
    // hedge: Stripe being down stops somebody SUBSCRIBING or buying credits, and
    // stops nobody already subscribed from running a workflow. Entitlement is
    // read from our own D1 row, so a checkout outage cannot touch a running
    // tenant. Amber, therefore, not red - and note the rollup gives a
    // non-critical outage and a non-critical degradation the same amber, which is
    // why this probe does not bother consulting Stripe's status page for nuance
    // it could never colour differently.
    describe('billing', 'Subscriptions and payments', 'Starting a plan, changing it, and buying credit top-ups.', false, 'Stripe', billing),
    describe('telemetry', 'Usage telemetry', 'Anonymous product usage counters.', false, null, telemetry),
  ];

  const status = rollup(components, notice);
  return {
    status,
    indicator: status === 'operational' ? 'green' : status === 'degraded' ? 'amber' : 'red',
    summary: summarize(status, components, notice),
    checkedAt: new Date().toISOString(),
    build: WORKER_BUILD,
    mode: hosted ? 'hosted' : 'byo',
    notice,
    components,
  };
}

/**
 * Rollup rules:
 *   any critical component in outage                      -> outage
 *   any component degraded, or a non-critical outage      -> degraded
 *   otherwise                                             -> operational
 *
 * An operator notice can only make the result worse, never better. `unknown`
 * components are ignored: they are bindings this deployment does not have.
 */
export function rollup(
  components: readonly StatusComponent[],
  notice: StatusNotice | null,
): RollupStatus {
  let worst: RollupStatus = 'operational';
  for (const component of components) {
    if (component.status === 'outage') {
      if (component.critical) return 'outage';
      worst = 'degraded';
    } else if (component.status === 'degraded') {
      worst = 'degraded';
    }
  }
  if (notice?.status === 'outage') return 'outage';
  if (notice) return 'degraded';
  return worst;
}

function summarize(
  status: RollupStatus,
  components: readonly StatusComponent[],
  notice: StatusNotice | null,
): string {
  if (notice) return notice.message;
  if (status === 'operational') return 'All systems operational';
  const affected = components
    .filter(component => component.status === 'degraded' || component.status === 'outage')
    .map(component => component.name);
  const list = affected.join(', ');
  return status === 'outage' ? `Service disruption: ${list}` : `Degraded performance: ${list}`;
}

// ── Probes ───────────────────────────────────────────────────────────────────

interface ProbeResult {
  status: ComponentStatus;
  detail: string | null;
}

const OK: ProbeResult = { status: 'operational', detail: null };

function absent(detail: string): ProbeResult {
  return { status: 'unknown', detail };
}

/** Wraps a probe so a throw or a hang becomes a reported outage, never a 500. */
async function timed(
  probe: () => Promise<ProbeResult>,
): Promise<ProbeResult & { latencyMs: number | null }> {
  const started = Date.now();
  try {
    const result = await withTimeout(probe(), PROBE_TIMEOUT_MS);
    return { ...result, latencyMs: Date.now() - started };
  } catch (error) {
    // The message is deliberately generic: this route is public and an
    // exception string can carry binding names or vendor internals.
    const timedOut = error instanceof Error && error.message === 'phorma-status-timeout';
    return {
      status: 'outage',
      detail: timedOut ? 'Health check timed out.' : 'Health check failed.',
      latencyMs: Date.now() - started,
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('phorma-status-timeout')), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Addresses a reserved `WorkflowAgent` instance and makes its cheapest
 * read-only RPC call. `publishedSpec()` returns null on a fresh instance and
 * `onStart()` has nothing to resume there, so the probe can never start a run.
 */
async function probeRuntime(env: StatusEnv): Promise<ProbeResult> {
  const namespace = env.WorkflowAgent;
  if (!namespace) return absent('No workflow runtime binding on this deployment.');
  const stub = namespace.get(
    namespace.idFromName(RUNTIME_PROBE_INSTANCE),
  ) as unknown as RuntimeProbeStub;
  await stub.publishedSpec();
  return OK;
}

/** The single RPC method the runtime probe needs. */
interface RuntimeProbeStub {
  publishedSpec(): Promise<unknown>;
}

/** D1 reachability. `SELECT 1` touches no application table. */
async function probeDatabase(env: StatusEnv, hosted: boolean): Promise<ProbeResult> {
  if (!env.DB) {
    return hosted
      ? { status: 'outage', detail: 'Account database is not bound.' }
      : absent('This deployment has no account database.');
  }
  const row = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  return row?.ok === 1 ? OK : { status: 'degraded', detail: 'Account database returned no result.' };
}

/**
 * KV reachability. The read target is the operator notice key, so this probe
 * and {@link readNotice} share one round trip.
 */
async function probePlanStore(env: StatusEnv, hosted: boolean): Promise<ProbeResult> {
  if (!env.TENANTS) {
    return hosted
      ? { status: 'outage', detail: 'Plan store is not bound.' }
      : absent('This deployment has no plan store.');
  }
  await env.TENANTS.get(NOTICE_KEY);
  return OK;
}

/**
 * Vault reachability, against an isolated probe owner so no real tenant's
 * entry names are ever listed. `entries()` returns names only by design, and
 * the result is discarded here regardless.
 */
async function probeVault(env: StatusEnv, hosted: boolean): Promise<ProbeResult> {
  if (!env.SecretVault) return absent('This deployment has no credential vault.');
  if (!env.KEY_ENC_SECRET) {
    return hosted
      ? { status: 'outage', detail: 'Vault encryption key is not configured.' }
      : absent('Credential storage is not configured on this deployment.');
  }
  await secretVault(env, VAULT_PROBE_OWNER).entries();
  return OK;
}

/** Portal slug registry. `resolve` is a read against the real singleton. */
async function probePortals(env: StatusEnv): Promise<ProbeResult> {
  const namespace = env.PortalIndex;
  if (!namespace) return absent('This deployment has no portal registry.');
  // Goes through `portalIndex` so the singleton's instance name stays owned by
  // one module rather than being repeated here.
  await portalIndex({ PortalIndex: namespace }).resolve(PORTAL_PROBE_SLUG);
  return OK;
}

/** R2 head on the updater manifest: the object the auto-updater reads first. */
async function probeDownloads(env: StatusEnv, hosted: boolean): Promise<ProbeResult> {
  if (!env.RELEASES) return absent('Installer downloads are served by Phorma Cloud only.');
  const object = await env.RELEASES.head('stable/latest.json');
  if (object) return OK;
  return hosted
    ? { status: 'degraded', detail: 'No published release manifest found.' }
    : absent('No releases published to this bucket.');
}

/**
 * Two signals, because they fail independently: a Clerk Backend API call
 * proves Clerk is up AND our key is valid, and Clerk's status page catches an
 * incident that has not reached our code path yet.
 */
async function probeAuth(env: StatusEnv, hosted: boolean): Promise<ProbeResult> {
  const vendor = await clerkVendorStatus();

  if (!env.CLERK_SECRET_KEY) {
    // BYO deployments legitimately run on PHORMA_TOKEN with no Clerk at all.
    if (!hosted) return absent('This deployment does not use Clerk sign-in.');
    return { status: 'outage', detail: 'Sign-in is not configured.' };
  }

  const response = await fetch(CLERK_PROBE_URL, {
    headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}`, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS - 500),
  });
  await drain(response);

  if (response.status === 401 || response.status === 403) {
    return { status: 'outage', detail: 'Sign-in credentials were rejected.' };
  }
  if (!response.ok) {
    return { status: 'outage', detail: 'Sign-in provider is not responding correctly.' };
  }
  if (vendor) return vendor;
  return OK;
}

/**
 * Clerk's Statuspage indicator, mapped to our vocabulary. A failure to reach
 * the status page is NOT a signal about Clerk itself, so it returns null and
 * the functional probe decides alone.
 */
async function clerkVendorStatus(): Promise<ProbeResult | null> {
  try {
    const response = await fetch(CLERK_STATUS_URL, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) {
      await drain(response);
      return null;
    }
    const body = (await response.json()) as { status?: { indicator?: string } };
    switch (body.status?.indicator) {
      case 'minor':
        return { status: 'degraded', detail: 'Clerk reports a minor incident.' };
      case 'major':
      case 'critical':
        return { status: 'outage', detail: 'Clerk reports a major incident.' };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * OpenRouter has no public status JSON (its status page serves HTML only), so
 * this is a functional probe. With a provisioning key it reads the credit
 * balance, which also proves the key still works; without one it falls back to
 * the public model list. Neither spends credits.
 */
async function probeInference(env: StatusEnv, hosted: boolean): Promise<ProbeResult> {
  if (!hosted && !env.OPENROUTER_PROVISIONING_KEY) {
    return absent('Hosted model billing is a Phorma Cloud feature.');
  }

  const key = env.OPENROUTER_PROVISIONING_KEY;
  const response = await fetch(key ? OPENROUTER_CREDITS_URL : OPENROUTER_MODELS_URL, {
    headers: {
      'User-Agent': USER_AGENT,
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS - 500),
  });
  await drain(response);

  if (response.status === 401 || response.status === 403) {
    return { status: 'outage', detail: 'Model provider credentials were rejected.' };
  }
  if (response.status === 429) {
    return { status: 'degraded', detail: 'Model provider is rate limiting requests.' };
  }
  if (!response.ok) {
    return { status: 'outage', detail: 'Model provider is not responding correctly.' };
  }
  return OK;
}

/**
 * Stripe reachability plus "is our API key still good", for the non-critical
 * billing component (requirement 35).
 *
 * ABSENT KEY IS `unknown` IN BOTH MODES, which deliberately differs from the
 * Clerk probe's hosted branch. A BYO worker binds no `STRIPE_SECRET_KEY` at all
 * and must not read as broken, and a hosted worker without one is a
 * configuration state rather than an outage: the billing routes already answer a
 * precise 501 naming the missing secret (`requireStripeSecret`), which is the
 * signal for whoever operates the worker. Turning a public badge amber because a
 * not-yet-launched catalogue is not configured tells visitors nothing true about
 * the service they are using.
 *
 * WHAT THIS PROBE CANNOT TELL YOU. A 200 proves Stripe is up and that this key is
 * live and permitted to read prices. It does NOT prove the key is the RIGHT key
 * for this deployment: an `sk_test_` key against a sandbox answers 200 exactly
 * like an `sk_live_` key against live, so a test-vs-live mismatch reads as
 * perfectly healthy here. That is the same blind spot the Clerk probe has, and
 * for the same reason - a vendor credential check can only speak about the
 * account the credential belongs to.
 *
 * It is not closed here on purpose. Refusing an `sk_test_` key on a hosted worker
 * would paint the badge amber for the whole sandbox period before the live
 * catalogue is mirrored (task 9.5), and `PHORMA_MODE` cannot distinguish a
 * staging hosted worker from the production one, so the probe has no way to know
 * which mode is correct. The checks that DO prove it are outside a health probe:
 * the `sk_live_` prefix on the deployed secret at go-live, and a real Checkout
 * Session appearing in the live Dashboard.
 */
async function probeBilling(env: StatusEnv): Promise<ProbeResult> {
  // Trimmed, matching `requireStripeSecret`: `wrangler secret put` with a stray
  // newline stores a blank string, and treating that as configured would send
  // `Authorization: Bearer ` and report a rejected credential instead of an
  // unconfigured one.
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) return absent('This deployment does not sell plans or credits.');

  // A direct `fetch` rather than `stripeRequest`, because that helper folds every
  // upstream failure into one 502 for a route to return - exactly the
  // classification this probe needs to keep. Nothing is read off the body.
  const response = await fetch(STRIPE_PROBE_URL, {
    headers: { Authorization: `Bearer ${key}`, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS - 500),
  });
  await drain(response);

  if (response.status === 401 || response.status === 403) {
    return { status: 'outage', detail: 'Payment provider credentials were rejected.' };
  }
  if (response.status === 429) {
    return { status: 'degraded', detail: 'Payment provider is rate limiting requests.' };
  }
  if (!response.ok) {
    return { status: 'outage', detail: 'Payment provider is not responding correctly.' };
  }
  return OK;
}

/**
 * Telemetry_Store reachability. Runs the self-healing schema creation first, so
 * a deployment whose migrations were never applied reports operational rather
 * than "no such table", then reads one row off `telemetry_rollups`. An empty
 * table answers null, which is a normal state and not a fault.
 *
 * `critical: false` at the call site, and `unknown` without `DB`: a BYO Worker
 * collects nothing, and telemetry being down must never turn the badge red.
 */
async function probeTelemetry(env: StatusEnv): Promise<ProbeResult> {
  if (!env.DB) return absent('This deployment does not collect telemetry.');
  await ensureTelemetrySchema(env.DB);
  await env.DB.prepare('SELECT 1 FROM telemetry_rollups LIMIT 1').first<{ ok: number }>();
  return OK;
}

/**
 * Releases a probe response body without reading it. Leaving a body unread in
 * a Worker keeps the connection pinned for the rest of the invocation.
 */
async function drain(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already consumed or closed - nothing to release.
  }
}

/**
 * The operator notice, or null. Set with:
 *   npx wrangler kv key put --binding TENANTS status:notice \
 *     '{"status":"degraded","message":"Scheduled maintenance","until":"..."}' --env hosted
 *
 * A malformed or expired value is ignored rather than fataled: a typo in a
 * maintenance banner must not take the status page down.
 */
async function readNotice(env: StatusEnv): Promise<StatusNotice | null> {
  if (!env.TENANTS) return null;
  try {
    const raw = await env.TENANTS.get(NOTICE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StatusNotice>;
    if (parsed.status !== 'degraded' && parsed.status !== 'outage') return null;
    if (typeof parsed.message !== 'string' || parsed.message.length === 0) return null;
    if (parsed.until) {
      const until = Date.parse(parsed.until);
      if (Number.isFinite(until) && until < Date.now()) return null;
    }
    return {
      status: parsed.status,
      message: parsed.message.slice(0, 280),
      ...(parsed.until ? { until: parsed.until } : {}),
    };
  } catch {
    return null;
  }
}

function describe(
  id: string,
  name: string,
  description: string,
  critical: boolean,
  vendor: string | null,
  result: ProbeResult & { latencyMs: number | null },
): StatusComponent {
  return {
    id,
    name,
    description,
    status: result.status,
    critical,
    latencyMs: result.latencyMs,
    detail: result.detail,
    vendor,
  };
}

// ── Badge ────────────────────────────────────────────────────────────────────

const BADGE_COLOURS: Record<Indicator, string> = {
  green: '#22c55e',
  amber: '#f59e0b',
  red: '#ef4444',
};

const BADGE_LABELS: Record<RollupStatus, string> = {
  operational: 'operational',
  degraded: 'degraded',
  outage: 'outage',
};

/**
 * Shields-style SVG badge. Hand-rolled rather than proxied so the badge cannot
 * become a third-party dependency of our own status reporting.
 */
function badgeResponse(payload: StatusPayload): Response {
  const label = 'phorma cloud';
  const value = BADGE_LABELS[payload.status];
  // 6.5px per character is the usual approximation for 11px DejaVu Sans.
  const labelWidth = Math.round(label.length * 6.5) + 12;
  const valueWidth = Math.round(value.length * 6.5) + 12;
  const total = labelWidth + valueWidth;
  const colour = BADGE_COLOURS[payload.indicator];

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${label}: ${value}">
<title>${label}: ${value}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)">
<rect width="${labelWidth}" height="20" fill="#555"/>
<rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${colour}"/>
<rect width="${total}" height="20" fill="url(#s)"/>
</g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${labelWidth / 2}" y="14">${label}</text>
<text x="${labelWidth + valueWidth / 2}" y="14">${value}</text>
</g>
</svg>`;

  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
      ...PUBLIC_CORS,
    },
  });
}
