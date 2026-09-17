/**
 * Phorma Cloud control-plane routes (`/api/*`) — hosted mode only.
 *
 *   GET  /api/me             (Clerk JWT)   → tenant profile + quota snapshot
 *   POST /api/checkout       (Clerk JWT)   → `{ lookupKey }` → Stripe Checkout `{ url }`
 *   POST /api/billing-portal (Clerk JWT)   → Stripe Billing Portal `{ url }`
 *   POST /api/stripe/webhook (HMAC)        → the ONLY writer of subscription state
 *   POST /api/provision      (admin token) → create/upgrade a tenant and bring its
 *                                            OpenRouter runtime key into line with
 *                                            the tier (patch the cap, or mint)
 *   POST /api/deactivate     (admin token) → disable a tenant + its runtime key,
 *                                            REPORTING whether the key was retired
 *
 * The webhook is matched FIRST in {@link routeApiRequest} and lives in
 * `stripe-webhook.ts`. Two reasons it cannot move: it needs the raw body before
 * anything calls `request.json()`, and it authenticates by signature rather than
 * by any `Authorization` header.
 *
 * Plus one route that is deliberately NOT under `/api/`:
 * {@link handleBillingReturnRequest} serves `GET /billing/return`, the page a
 * browser lands on when it comes back from Stripe. `index.ts` calls it with the
 * other public routes.
 *
 * Provisioning is admin-token-gated for now (manual billing). The billing routes
 * replacing it (`.kiro/specs/stripe-billing/`) do NOT reuse these endpoints, as
 * this comment used to claim: a webhook arrives keyed by Stripe customer with no
 * bearer to present, so it needs its own mapping columns (`0003_billing.sql`) and
 * its own signature-verified route.
 */

import { isConnectionId, workerSecretName } from '@phorma/engine';

import { verifyRequest, isHosted, type AuthEnv } from './auth';
import { secretVault, SECRET_VAULT_MAX_VALUE_CHARS, type SecretVaultEnv } from './secret-vault';
import {
  resolveCataloguePrice,
  stripeRequest,
  type StripeEnv,
  type StripeResult,
} from './stripe';
import { handleDeviceAuthApi, type DeviceAuthEnv } from './device-auth-routes';
import { handleDeploymentsRequest, type DeploymentsEnv } from './deployments';
import { handleNotificationsRequest, type NotificationsEnv } from './notifications';
import { handleBackupRequest, type BackupRoutesEnv } from './backup-routes';
import { handleStripeWebhookRequest } from './stripe-webhook';
import {
  BILLING_ADMIN_PREFIX,
  handleBillingAdminRequest,
  type BillingAdminEnv,
} from './billing-admin';
import { BRAND_PAGE_CSP, brandPageDocument } from './brand-page';
import {
  handleTelemetryAdminRequest,
  TELEMETRY_ADMIN_PREFIX,
  type TelemetryAdminEnv,
} from './telemetry-admin';
import {
  TenantStore,
  creditsForTier,
  currentMonth,
  disableTenantRuntimeKey,
  encryptString,
  isClerkUserId,
  reconcileRuntimeKey,
  resolveHostedInference,
  toOpenRouterModel,
  type TenantEnv,
  type TenantRecord,
} from './tenants';

/**
 * Every binding the control plane touches, composed from the slice each module
 * owns rather than restated here - so the interface next to the code that reads
 * a secret stays the one description of it.
 *
 * `StripeEnv` is folded in for the billing routes (requirements 33, 34). Both of
 * its fields are OPTIONAL, which is load-bearing rather than lenient: a BYO
 * worker binds neither Stripe secret and must stay healthy, so an unconfigured
 * billing route answers 501 naming the missing secret (`requireStripeSecret`)
 * and nothing else on this surface notices. Deployed names are documented in the
 * `wrangler.jsonc` secret header, local ones in `.dev.vars.example`; a new secret
 * goes in BOTH.
 */
export type ApiEnv = AuthEnv &
  TenantEnv &
  SecretVaultEnv &
  TelemetryAdminEnv &
  BillingAdminEnv &
  StripeEnv &
  DeviceAuthEnv &
  DeploymentsEnv &
  NotificationsEnv &
  BackupRoutesEnv;

/** JSON responder bound to the current request's CORS headers. */
type Respond = (body: unknown, status?: number) => Response;

/**
 * A `Connection.secretKeys` entry is an operator-typed field name. Bound it
 * before it becomes part of a storage key.
 */
const SECRET_KEY_PATTERN = /^[A-Za-z0-9_.\-]{1,64}$/;

/**
 * `GET | POST | DELETE /api/connection-secrets` — the vault surface.
 *
 *   GET    → `{ secrets: [{ name, updatedAt }] }`, names only. Lets the studio
 *            show which secrets the deployed runtime already holds without any
 *            code path that reads a value back.
 *   POST   → `{ connectionId, secretKey, value }`, encrypted here and stored.
 *   DELETE → `?connectionId=&secretKey=`, idempotent.
 *
 * The owner scope is the VERIFIED identity, never a request field, so one
 * tenant cannot address another's vault (hosted mode). BYO deployments have a
 * single owner and share the default vault.
 */
async function handleConnectionSecretRequest(
  request: Request,
  env: ApiEnv,
  respond: Respond,
): Promise<Response> {
  // An unprotected BYO worker treats every caller as the owner, which is
  // tolerable for triggering a workflow and NOT tolerable for a credential
  // store: a stranger could stash a key and then spend it through a deployed
  // workflow. Vault access therefore requires the deployment to have an
  // authentication credential at all, unlike the rest of the surface.
  if (!isHosted(env) && !env.CLERK_SECRET_KEY && !env.PHORMA_TOKEN) {
    return respond(
      {
        error:
          'Storing credentials requires this worker to be protected. Run ' +
          '`npx wrangler secret put PHORMA_TOKEN`, set the same value in ' +
          'Settings > Cloud, and try again.',
      },
      403,
    );
  }

  const auth = await verifyRequest(env, request);
  if (!auth) return respond({ error: 'Unauthorized.' }, 401);
  // Hosted mode is per-tenant, so an anonymous identity has no vault to address.
  if (isHosted(env) && !auth.userId) return respond({ error: 'Unauthorized.' }, 401);
  if (!env.SecretVault) {
    return respond({ error: 'This deployment has no secret vault binding.' }, 501);
  }
  if (!env.KEY_ENC_SECRET) {
    return respond(
      {
        error:
          'This worker cannot store credentials: KEY_ENC_SECRET is not set. Run ' +
          '`npx wrangler secret put KEY_ENC_SECRET` with a base64 32-byte random value, ' +
          'redeploy, and try again.',
      },
      501,
    );
  }

  const vault = secretVault(env, auth.userId);

  if (request.method === 'GET') {
    return respond({ secrets: await vault.entries() });
  }

  const body =
    request.method === 'POST'
      ? ((await request.json().catch(() => null)) as {
          connectionId?: unknown;
          secretKey?: unknown;
          value?: unknown;
        } | null)
      : null;
  const url = new URL(request.url);
  const connectionId = body ? body.connectionId : url.searchParams.get('connectionId');
  const secretKey = body ? body.secretKey : url.searchParams.get('secretKey');

  if (!isConnectionId(connectionId)) {
    return respond({ error: 'connectionId must be a valid connection id.' }, 400);
  }
  if (typeof secretKey !== 'string' || !SECRET_KEY_PATTERN.test(secretKey)) {
    return respond({ error: 'secretKey must be 1-64 characters of [A-Za-z0-9_.-].' }, 400);
  }
  const name = workerSecretName(connectionId, secretKey);

  if (request.method === 'DELETE') {
    const { removed } = await vault.remove(name);
    return respond({ ok: true, name, removed });
  }

  if (request.method !== 'POST') return respond({ error: 'Method not allowed.' }, 405);

  const value = typeof body?.value === 'string' ? body.value : '';
  if (value.length === 0) return respond({ error: 'value is required.' }, 400);
  if (value.length > SECRET_VAULT_MAX_VALUE_CHARS) {
    return respond({ error: 'value is too large.' }, 413);
  }

  // Encrypted HERE, so the vault only ever holds ciphertext.
  const enc = await encryptString(value, env.KEY_ENC_SECRET);
  const result = await vault.put(name, enc);
  if (!result.ok) return respond({ error: result.error }, 400);
  return respond({ ok: true, name });
}

// ── Billing (tasks 4.1 - 4.4) ────────────────────────────────────────────────

/**
 * Where a browser coming back from Stripe lands. NOT under `/api/`, because it
 * is a top-level navigation rather than an XHR: the studio is a desktop app with
 * no addressable URL of its own and a browser-parity user is on an arbitrary
 * localhost port, so the worker has to own the landing page. See
 * {@link handleBillingReturnRequest}.
 */
export const BILLING_RETURN_PATH = '/billing/return';

/**
 * Path of {@link handleSignedInRequest} - where the Clerk instance sends a
 * browser after sign-in and sign-up.
 *
 * It exists because a Clerk instance MUST name a post-sign-in URL and ours named
 * `https://app.phorma-labs.com`, a host with no DNS record at all. Every social
 * sign-in therefore finished on a browser error page. There is no web app to send
 * anyone to and creating that hostname would mean inventing one, so the honest
 * target is a page on the worker that already serves the studio - no new DNS
 * record, no new certificate, nothing to keep alive separately.
 *
 * This is also the page the desktop sign-in handoff completes on
 * (`.kiro/specs/desktop-signin-handoff/`), so it is a down payment on that work
 * rather than a placeholder to throw away.
 */
export const SIGNED_IN_PATH = '/signed-in';

/**
 * A Stripe Customer id. Bounds the SHAPE only - Stripe documents object ids as
 * opaque - so the job is to refuse prose or an empty string before it is bound
 * into a Checkout Session, not to model Stripe's id alphabet.
 */
const STRIPE_CUSTOMER_ID = /^cus_[A-Za-z0-9_-]{1,255}$/;

/**
 * A tenant id safe to interpolate into a Stripe search query.
 *
 * Stripe's search grammar quotes values with single quotes, so a value
 * containing one would break out of the literal. The id here is a VERIFIED
 * Clerk `sub` rather than a request field, so this is not the primary defence -
 * it is what keeps the query builder honest if Clerk's id format ever widens.
 * A non-matching id skips the search and falls through to create, which is
 * correct behaviour rather than a refusal.
 */
const SEARCHABLE_TENANT_ID = /^[A-Za-z0-9_-]{1,255}$/;

/** Longest URL we will hand back for the studio to open externally. */
const BILLING_URL_MAX_CHARS = 2048;

/** `https://this-worker/billing/return`, derived from the request rather than configured. */
function billingReturnUrl(url: URL): string {
  return `${url.origin}${BILLING_RETURN_PATH}`;
}

/**
 * A hosted Stripe URL the studio may open, or `null`.
 *
 * The scheme check is the point: this value goes to `openExternal`, which on
 * desktop hands it to the OS. Stripe returns an `https://checkout.stripe.com/...`
 * URL today and a custom-domain one when an account configures it, so the HOST
 * is deliberately not constrained - only the scheme, which is what stops
 * anything with a shell or handler meaning from reaching the OS.
 */
function billingSessionUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > BILLING_URL_MAX_CHARS) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The customer id off a Stripe customer object, if it is one we can use. */
function usableCustomerId(value: unknown): string | null {
  if (!isRecord(value) || value['deleted'] === true) return null;
  const id = value['id'];
  return typeof id === 'string' && STRIPE_CUSTOMER_ID.test(id) ? id : null;
}

/**
 * Finds this tenant's Stripe Customer by `metadata.clerk_user_id` - the FALLBACK
 * half of requirement 4, never the primary one.
 *
 * `tenants.stripe_customer_id` is the primary source and this search only runs
 * when that column is empty, for the case it exists to cover: a customer created
 * by a checkout the user abandoned, so the webhook never ran and never stored the
 * mapping. Stripe's search index lags a write by up to a minute, which is
 * exactly why it cannot be the primary source - and why the customer create it
 * guards is separately idempotency-keyed.
 *
 * A miss is `{ data: null }`, not a refusal: not finding a customer is the
 * ordinary state for anyone who has never paid.
 */
async function searchStripeCustomer(
  env: ApiEnv,
  tenantId: string,
): Promise<StripeResult<string | null>> {
  if (!SEARCHABLE_TENANT_ID.test(tenantId)) {
    console.warn('Skipping Stripe customer search: the tenant id is not a searchable shape.');
    return { data: null };
  }

  const found = await stripeRequest<{ data?: unknown }>(env, '/customers/search', {
    method: 'GET',
    // `limit: 2` to DETECT a duplicate rather than assume there is none.
    params: { query: `metadata['clerk_user_id']:'${tenantId}'`, limit: 2 },
  });
  if ('status' in found) return found;

  const matches = Array.isArray(found.data.data) ? found.data.data : [];
  const ids = matches.map(usableCustomerId).filter((id): id is string => id !== null);
  if (ids.length > 1) {
    // Requirement 4 wants one customer per tenant, and the partial unique index
    // on `stripe_customer_id` means only one of these can ever be mapped. Taking
    // the first is the least-harm answer: refusing would block checkout for a
    // duplicate only an operator can merge.
    console.warn(
      `Stripe holds ${ids.length} customers carrying this tenant's clerk_user_id; using the ` +
        `first. Merge the duplicates in the Dashboard.`,
    );
  }
  return { data: ids[0] ?? null };
}

/**
 * Stores the tenant -> customer mapping, best-effort.
 *
 * Two deliberate non-actions.
 *
 * It does NOT create a tenant row. `upsertTenant` always overwrites `tier` and
 * `status`, so writing the mapping for a user who has never been provisioned
 * would mean inventing both - and any value we invented would show up in
 * `/api/me` as a plan the user does not have. Requirement 10 puts subscription
 * state entirely in the webhook's hands, so the mapping for a first-time buyer
 * is written THERE, when the payment actually completes. Until then the customer
 * is still found again: by the metadata search above, and inside 24h by the
 * idempotency key on the create.
 *
 * It does NOT fail the request. A conflict here means the unique index caught a
 * customer already mapped to a DIFFERENT tenant, which is an operator-level
 * mistake; turning it into a 500 would refuse a payment over a bookkeeping
 * problem the webhook resolves through `client_reference_id` anyway. Logged as an
 * error rather than swallowed, so it is discoverable.
 */
async function rememberStripeCustomer(
  store: TenantStore,
  tenant: TenantRecord | null,
  customerId: string,
): Promise<void> {
  if (!tenant || tenant.stripeCustomerId === customerId) return;
  try {
    await store.upsertTenant({
      id: tenant.id,
      // Restated, not changed: both columns are unconditionally overwritten, so
      // a mapping-only write has to hand back the values it just read.
      tier: tenant.tier,
      status: tenant.status,
      stripeCustomerId: customerId,
    });
  } catch (error) {
    console.error(
      `Could not map tenant ${tenant.id} to its Stripe customer: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The Stripe Customer to check out against (requirements 2, 4).
 *
 * Stored mapping, then the metadata search, then create. Requirement 4 is about
 * not accumulating duplicates, and each step exists because the one before it can
 * legitimately come up empty.
 *
 * The create carries two things that make the webhook's job possible:
 * `metadata.clerk_user_id` (requirement 2, one of the two independent paths back
 * to the tenant), and an `Idempotency-Key` derived from the tenant id, so a
 * double-clicked Subscribe button cannot leave two customers behind inside
 * Stripe's 24h idempotency window - the window that matters, because it is
 * exactly the period where the search index may not have caught up yet.
 */
async function resolveStripeCustomer(
  env: ApiEnv,
  store: TenantStore,
  tenantId: string,
  tenant: TenantRecord | null,
): Promise<StripeResult<string>> {
  const mapped = tenant?.stripeCustomerId;
  if (mapped && STRIPE_CUSTOMER_ID.test(mapped)) return { data: mapped };

  const found = await searchStripeCustomer(env, tenantId);
  if ('status' in found) return found;
  if (found.data) {
    await rememberStripeCustomer(store, tenant, found.data);
    return { data: found.data };
  }

  const created = await stripeRequest<{ id?: unknown }>(env, '/customers', {
    params: {
      // Omitted rather than sent empty when we have no email: `undefined` is
      // skipped by the form encoder, and `email=` would store a blank on the
      // customer instead of leaving Checkout to collect a real one.
      email: tenant?.email ?? undefined,
      metadata: { clerk_user_id: tenantId },
    },
    idempotencyKey: `phorma-customer-${tenantId}`,
  });
  if ('status' in created) return created;

  const customerId = usableCustomerId(created.data);
  if (!customerId) {
    console.error('Stripe returned a customer with no usable id.');
    return { status: 502, error: 'Stripe returned an unreadable response.' };
  }
  await rememberStripeCustomer(store, tenant, customerId);
  return { data: customerId };
}

/**
 * `GET /billing/return` - the page a browser lands on coming back from Stripe.
 *
 * PUBLIC and unauthenticated, because the navigation is Stripe redirecting the
 * user's browser: there is no bearer to present and no XHR, so it also needs no
 * CORS headers at all. `index.ts` matches it with the other public routes rather
 * than through `handleApiRequest`, which only handles `/api/*`.
 *
 * It deliberately conveys NO billing state. The webhook is the only writer of
 * subscription state (requirement 10) and may not have landed yet, so a page
 * claiming "you are now on Pro" would be a guess. The studio learns the outcome
 * by polling `/api/me` (requirements 29, 30), which is also why this page needs
 * no script: nothing here has to talk to anything.
 *
 * Self-contained by design - one inline stylesheet, no fonts, no images, no JS -
 * so it renders identically offline, in a webview, and in a hardened browser. The
 * CSP below is the enforcement of that, not decoration.
 *
 * Returns null when the path is not this one, matching the other route helpers.
 */
export function handleBillingReturnRequest(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== BILLING_RETURN_PATH) return null;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // Answered rather than passed through: falling through would land in the
    // agent router and report a confusing 404 for a path that does exist.
    return new Response('Method not allowed.', {
      status: 405,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' },
    });
  }

  // The ONLY thing read off the query string, compared against a literal. No
  // query value is ever interpolated into the markup.
  const cancelled = url.searchParams.get('status') === 'cancelled';
  return new Response(request.method === 'HEAD' ? null : billingReturnPage(cancelled), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // `no-transform` keeps Cloudflare's proxy from injecting the Web Analytics
      // beacon into this HTML, which the CSP below would block and log. See the
      // same header on `GET /auth/device` for the full reasoning.
      'Cache-Control': 'no-store, no-transform',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      // Still "this page loads nothing remote": the exceptions are its own inline
      // stylesheet and its `data:` favicon. `img-src data:` names no host and no
      // scheme, so it cannot become a route to a remote image. See
      // `brand-page.ts` for why the favicon is a data URI at all.
      'Content-Security-Policy': BRAND_PAGE_CSP,
    },
  });
}

/**
 * The markup, from the shared brand shell (`brand-page.ts`).
 *
 * The outcome travels in TWO channels, which is why the state dot is not doing the
 * work alone: the heading says which happened, and the dot colours it. The old
 * version had colour as the only visual difference between "paid" and "cancelled",
 * which is not a distinction a colour-blind reader could make at a glance.
 */
function billingReturnPage(cancelled: boolean): string {
  const title = cancelled ? 'Checkout cancelled' : 'Thanks - payment received';
  return brandPageDocument({
    title,
    state: cancelled ? 'pending' : 'ok',
    body: [
      cancelled
        ? 'Nothing was charged. You can close this tab and pick a plan again whenever you like.'
        : 'You can close this tab now. Phorma Agent Studio updates your plan on its own within a ' +
          'few seconds.',
    ],
  });
}

/**
 * `GET /signed-in` - where the Clerk instance sends a browser after sign-in.
 *
 * PUBLIC and unauthenticated for the same reasons `/billing/return` is: it is a
 * top-level navigation the identity provider performs, there is no bearer to
 * present, no XHR happens, and so no CORS headers are needed. Matched in
 * `index.ts` with the other public routes.
 *
 * It reads NOTHING from the request and conveys NO account state. That is
 * deliberate on both counts. Clerk redirects here with its own query parameters,
 * and a page that echoed any of them back into markup on an unauthenticated route
 * would be a reflected-injection surface for no benefit. And the page cannot
 * honestly claim anything about the account: it holds no session of its own, the
 * one that matters lives in this browser's cookies for `clerk.phorma-labs.com`,
 * and asserting "you are signed in" without checking would be a guess.
 *
 * Self-contained by design - one inline stylesheet, no fonts, no images, no
 * script - so it renders identically offline, in a webview and in a hardened
 * browser. The CSP is the enforcement of that claim, not decoration.
 *
 * Returns null when the path is not this one, matching the other route helpers.
 */
export function handleSignedInRequest(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== SIGNED_IN_PATH) return null;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // Answered rather than passed through: falling through would land in the
    // agent router and report a confusing 404 for a path that does exist.
    return new Response('Method not allowed.', {
      status: 405,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' },
    });
  }

  return new Response(request.method === 'HEAD' ? null : signedInPage(), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // `no-transform` for the same reason as `/billing/return` and
      // `/auth/device`: it stops Cloudflare's proxy rewriting this HTML to add the
      // Web Analytics beacon that the CSP then blocks.
      'Cache-Control': 'no-store, no-transform',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': BRAND_PAGE_CSP,
    },
  });
}

/**
 * The markup. No interpolation of any kind, which is what lets the CSP above be
 * this strict and what keeps the route free of any reflected input.
 *
 * The second paragraph states that the desktop app will still read as signed out.
 * It has to: that is true today, and it is the same sentence
 * `PhormaCloudService.openAccountPortal` puts in its toast. If one of the two is
 * ever softened without the other, the product tells the user two different
 * stories about the same moment - so they change together or not at all.
 */
function signedInPage(): string {
  return brandPageDocument({
    title: "You're signed in",
    state: 'ok',
    body: [
      'Your Phorma account is ready. You can close this tab.',
      'Linking the desktop app to your account is not available yet, so Phorma Agent ' +
        'Studio will still show you as signed out when you switch back to it.',
    ],
  });
}

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

  // ── POST /api/stripe/webhook — the only writer of subscription state ───────
  //
  // MATCHED FIRST, above every other branch, and the position is load-bearing in
  // two independent ways (task 5.1):
  //
  //   1. The signature covers the RAW BYTES of the body, and a consumed body
  //      cannot be re-read. `handleStripeWebhookRequest` does `request.text()`
  //      before anything else touches it, so this branch has to sit above every
  //      path that calls `request.json()`. Hoisting a generic body parse above
  //      this line would break payment processing with no type error and no
  //      failing build. Do not do it.
  //   2. Stripe authenticates by SIGNATURE and carries no bearer, so the route
  //      must never meet `verifyRequest` or the `PHORMA_ADMIN_TOKEN` check
  //      (requirement 12). Sitting here, it meets neither.
  //
  // It is also ABOVE the `store.enabled` gate, unlike `/api/checkout`, because
  // the answer for a worker with no D1 differs: a billing route the studio called
  // should say "hosted bindings missing" and stop, while an AUTHENTIC Stripe event
  // we cannot record has to be RETRIED rather than dropped. The handler owns that
  // decision (and answers 501 for it) once the signature has proved the delivery
  // is real.
  const webhook = await handleStripeWebhookRequest(request, env, url, respond);
  if (webhook) return webhook;

  // ── /api/connection-secrets — credential ingestion for DEPLOYED runs ──────
  // Deliberately ABOVE the hosted-bindings gate: this is the one control-plane
  // surface a BYO deployment needs too, because `wrangler secret put` is a
  // terminal trip and a hosted tenant cannot run it at all.
  if (url.pathname === '/api/connection-secrets') {
    return handleConnectionSecretRequest(request, env, respond);
  }

  // ── /api/auth/device/* — the desktop sign-in handoff ──────────────────────
  //
  // ABOVE the `store.enabled` gate on purpose: these three routes touch KV only,
  // never D1, so a tenant-store outage must not stop a user signing in. Signing in
  // is also the thing they would need to do in order to see anything about that
  // outage.
  //
  // Under `/api/` so they inherit the scoped CORS computed from `ALLOWED_ORIGINS`
  // - the studio calls `start` and `redeem` cross-origin from the webview, and a
  // second CORS implementation is how the two drift apart. The browser PAGE is not
  // under `/api/`; `index.ts` serves it with the other public navigations.
  const deviceAuth = await handleDeviceAuthApi(request, env, url, respond, verifyRequest);
  if (deviceAuth) return deviceAuth;

  // ── GET /api/deployments - what is running in this account ────────────────
  //
  // ABOVE the `store.enabled` gate for a specific reason: the registry it reads
  // lives in the `PortalIndex` Durable Object, which a BYO worker binds too, and
  // Requirement 5.5 wants the list with a NULL spend figure rather than a 501
  // about hosted bindings. "I cannot tell you what it cost" and "I cannot tell
  // you what is running" are different answers, and only the first is acceptable
  // here - this route is how a user finds a deployment they can no longer name.
  //
  // Also deliberately not gated on subscription (Requirement 5.6): a lapsed
  // subscriber is exactly who needs to stop a cron deployment.
  const deployments = await handleDeploymentsRequest(request, env, url, respond);
  if (deployments) return deployments;

  // ── GET /api/notifications - what happened, and what is waiting ────────────
  //
  // Beside `/api/deployments` and ABOVE the `store.enabled` gate for the same
  // reason, plus one of its own: this route reads the deployment registry and
  // then the Durable Objects themselves, and touches no D1 at all. It could not
  // use D1 even if it wanted to - the `usage` table records cost and tokens and
  // has no run OUTCOME column, so a failure is not derivable from it.
  //
  // Not subscription-gated here either. The STUDIO gates polling on an active
  // subscription, which is where that product decision belongs; refusing at the
  // worker would also hide a cron deployment's failures from a lapsed subscriber
  // who is still paying for the runs.
  const notifications = await handleNotificationsRequest(request, env, url, respond);
  if (notifications) return notifications;

  // ── /api/admin/telemetry/* — owner-only telemetry aggregates (9.1) ─────────
  // Also deliberately ABOVE the hosted-bindings gate: this surface carries its
  // own authorization (`verifyRequest` plus the TELEMETRY_ADMIN_USER_IDS
  // allowlist) and its own D1 handling, so a tenant-store outage must not turn
  // an owner's dashboard read into a 501 about bindings it never touches.
  if (url.pathname.startsWith(TELEMETRY_ADMIN_PREFIX)) {
    // The handler re-checks the prefix and answers null on a non-match, which
    // the branch above has already ruled out. `??` keeps the return type honest
    // without a cast rather than pretending that null is reachable.
    return (
      (await handleTelemetryAdminRequest(request, env, url, respond)) ??
      respond({ error: 'Not found.' }, 404)
    );
  }

  // ── /api/admin/billing/* — operator-only cost and revenue ─────────────────
  // Beside the telemetry aggregates and ABOVE the hosted-bindings gate for the
  // same reason: same operator gate (`admin-auth.ts`), and its own D1 handling.
  // An absent `DB` reads as "nothing committed" rather than as a 501 about
  // bindings, because the OpenRouter balance half needs no D1 at all and is the
  // half an operator opens the page for.
  //
  // A SEPARATE prefix from telemetry, not a sixth aggregate route: telemetry
  // bodies carry no install id by construction and fold small groups for
  // anonymity, while these bodies name paying tenants on purpose. Opposite
  // privacy contracts over different tables - see `billing-admin.ts`.
  if (url.pathname.startsWith(BILLING_ADMIN_PREFIX)) {
    return (
      (await handleBillingAdminRequest(request, env, url, respond)) ??
      respond({ error: 'Not found.' }, 404)
    );
  }

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
    // Two independent reads, so they run together: the monthly rollup is KV
    // cached, the grant pool is a small indexed D1 sum.
    const [quota, grants] = await Promise.all([
      store.getQuota(tenant.id, tenant.tier),
      store.grantPool(tenant.id),
    ]);
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
        // ── Purchased top-up balance (requirement 25) ─────────────────────────
        // ADDITIVE, not folded into `creditsLimit`. Two reasons, and both are
        // about the studio being able to tell the two apart:
        //
        //  - The allowance RESETS monthly and the balance does not
        //    (requirement 23), so a credits bar that showed one merged ceiling
        //    would tell a user their purchased credits reset too.
        //  - The remedies differ. Out of allowance with a balance left is fine;
        //    out of both is the only state that earns a Buy credits action.
        //
        // The effective ceiling is therefore `creditsLimit +
        // grantCreditsRemaining`, which is the same sum
        // `effectiveCreditsLimit` computes worker-side. The studio adds, it never
        // converts: the credit figure arrives already valued at each grant's own
        // purchase-time ratio, so no pack arithmetic ever runs client-side and
        // requirement 25's credits-only rule cannot be broken by accident.
        grantCreditsRemaining: grants.creditsRemaining,
        costUsdUsed: quota.costUsdUsed,
        costUsdLimit: quota.limits.monthlyCostUsd,
        // The USD twin of the field above, analytics-only like its neighbours and
        // never rendered.
        grantCostUsdRemaining: grants.costUsdRemaining,
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
    // `code` travels in the body alongside the message (requirement 19). It is
    // additive - a studio that predates it still reads `error` and still matches
    // its existing prose regex (requirement 20) - and it is what lets a newer
    // studio pick the right call to action without parsing English.
    if ('status' in gate) return respond({ error: gate.error, code: gate.code }, gate.status);
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
      meterInferenceStream(
        meterStream,
        store,
        auth.userId,
        // The tier the gate just resolved, not a second read: `recordRun` needs it
        // to know which monthly allowance this cost is measured against before it
        // draws on any purchased grant (requirement 24).
        gate.tenant.tier,
        runId,
        body.model,
      ).catch(() => undefined),
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

  // ── /api/backups/* — hosted workflow backup ───────────────────────────────
  //
  // BELOW the `store.enabled` gate, unlike `/api/deployments` above it. The
  // asymmetry is the point: the deployment registry lives in a Durable Object a
  // BYO worker binds too, while backup needs the hosted D1 and R2. So this whole
  // surface is ABSENT on a BYO deployment rather than broken, and those users get
  // the file-based library export instead.
  const backups = await handleBackupRequest(request, env, url, respond);
  if (backups) return backups;

  // ── POST /api/checkout — start a Stripe Checkout Session ──────────────────
  // Placed HERE deliberately (task 4.4): after the `store.enabled` gate, so a BYO
  // worker with no `DB` binding answers the same 501 about missing hosted
  // bindings as every other tenant route rather than reaching Stripe, and BEFORE
  // the `isAdmin` block below, so nothing about it depends on
  // `PHORMA_ADMIN_TOKEN`. Billing is a hosted-only surface and a paying user is
  // not an operator.
  if (request.method === 'POST' && url.pathname === '/api/checkout') {
    const auth = await verifyRequest(env, request);
    // Requirement 2: the tenant is the VERIFIED Clerk `sub` and nothing else.
    // There is no tenantId field on this route on purpose - one would be a
    // "charge someone else's account" parameter.
    if (!auth?.userId) return respond({ error: 'Unauthorized.' }, 401);

    const body = (await request.json().catch(() => null)) as { lookupKey?: unknown } | null;

    // The whole catalogue gate: allowlist, then one active price by lookup key,
    // then the metadata that decides tier or credits (requirements 5, 6, 7, 8).
    // A client sends a KEY, never a price id, and `resolveCataloguePrice` refuses
    // anything off the six-entry allowlist before a Stripe call happens.
    const price = await resolveCataloguePrice(env, body?.lookupKey);
    if ('status' in price) return respond({ error: price.error }, price.status);

    const tenant = await store.getTenant(auth.userId);
    const customer = await resolveStripeCustomer(env, store, auth.userId, tenant);
    if ('status' in customer) return respond({ error: customer.error }, customer.status);

    const returnUrl = billingReturnUrl(url);
    const session = await stripeRequest<{ url?: unknown }>(env, '/checkout/sessions', {
      params: {
        // `subscription` for a plan, `payment` for a credit pack, taken from the
        // price TYPE rather than from anything the caller said.
        mode: price.data.mode,
        customer: customer.data,
        // Requirement 2's second path back to the tenant, independent of the
        // customer's metadata so the webhook can resolve one even if the other is
        // missing.
        client_reference_id: auth.userId,
        line_items: [{ price: price.data.priceId, quantity: 1 }],
        success_url: `${returnUrl}?status=complete`,
        cancel_url: `${returnUrl}?status=cancelled`,
        // ── Tax (task 4.1a, requirements 46, 47, 48) ───────────────────────
        // Every price is `tax_behavior: 'inclusive'`, so the published number is
        // what the customer pays and the tax component is CARVED OUT of it. That
        // carve is impossible without a jurisdiction, which makes the next three
        // parameters load-bearing rather than polite: automatic tax does the
        // decomposition, the billing address is what establishes where, and tax
        // id collection is what lets a business supply an ABN or VAT id and get a
        // compliant invoice.
        automatic_tax: { enabled: true },
        billing_address_collection: 'required',
        tax_id_collection: { enabled: true },
        // REQUIRED by Stripe once automatic tax runs against an EXISTING
        // customer: without `address: 'auto'` the session is rejected, because
        // Stripe will not silently prefer a stale saved address over the one just
        // entered. `name: 'auto'` is the tax-id half of the same idea - the legal
        // entity name collected beside the tax id has to reach the customer or
        // the invoice carries the wrong name.
        customer_update: { address: 'auto', name: 'auto' },
        // Subscription mode always produces an invoice; one-time payments produce
        // only a receipt unless asked. A credit pack buyer who supplied a tax id
        // needs the invoice, so requirement 48 applies to both modes.
        invoice_creation: price.data.mode === 'payment' ? { enabled: true } : undefined,
        metadata: { clerk_user_id: auth.userId, lookup_key: price.data.lookupKey },
      },
      // No idempotency key, deliberately. Each click is a genuinely new session,
      // and reusing a key would replay a stale (possibly expired) Checkout URL
      // instead of issuing a fresh one. Requirement 4's idempotency belongs on
      // the CUSTOMER create, where a duplicate is permanent.
    });
    if ('status' in session) return respond({ error: session.error }, session.status);

    const sessionUrl = billingSessionUrl(session.data.url);
    if (!sessionUrl) {
      console.error('Stripe returned a Checkout Session with no usable https URL.');
      return respond({ error: 'Stripe returned an unreadable response.' }, 502);
    }
    return respond({ url: sessionUrl });
  }

  // ── POST /api/billing-portal — cancel, change plan, card, invoices ────────
  // Requirement 28: one route, and Stripe owns every one of those surfaces, so
  // the payment UI we build and maintain stays this small.
  if (request.method === 'POST' && url.pathname === '/api/billing-portal') {
    const auth = await verifyRequest(env, request);
    if (!auth?.userId) return respond({ error: 'Unauthorized.' }, 401);

    const tenant = await store.getTenant(auth.userId);
    const mapped = tenant?.stripeCustomerId;
    let customerId = mapped && STRIPE_CUSTOMER_ID.test(mapped) ? mapped : null;
    if (!customerId) {
      // Same fallback as checkout, and NO create: a portal for a customer that
      // does not exist yet would be an empty page about nothing.
      const found = await searchStripeCustomer(env, auth.userId);
      if ('status' in found) return respond({ error: found.error }, found.status);
      customerId = found.data;
      if (customerId) await rememberStripeCustomer(store, tenant, customerId);
    }
    if (!customerId) {
      return respond(
        { error: 'There is no billing account to manage yet. Choose a plan first.' },
        404,
      );
    }

    const session = await stripeRequest<{ url?: unknown }>(env, '/billing_portal/sessions', {
      params: { customer: customerId, return_url: billingReturnUrl(url) },
    });
    if ('status' in session) return respond({ error: session.error }, session.status);

    const portalUrl = billingSessionUrl(session.data.url);
    if (!portalUrl) {
      console.error('Stripe returned a billing portal session with no usable https URL.');
      return respond({ error: 'Stripe returned an unreadable response.' }, 502);
    }
    return respond({ url: portalUrl });
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
      rotateKey?: boolean;
    } | null;
    if (!body?.tenantId) return respond({ error: 'tenantId is required.' }, 400);
    // Requirement 1, task 8.4. `tenants.id` IS the Clerk user id, so a typo here
    // creates a row `/api/me` can never find - and nothing downstream notices,
    // because an orphan tenant is indistinguishable from a user who has not signed
    // in yet. Refused on this WRITE path only; a read never re-validates an id,
    // since a legacy row provisioned before this check may hold one that fails it.
    if (!isClerkUserId(body.tenantId)) {
      return respond(
        {
          error:
            'tenantId must be a Clerk user id (user_...). It is the tenant primary key, so a ' +
            'value of any other shape would create an account nobody can reach.',
        },
        400,
      );
    }

    const tier = body.tier ?? 'starter';

    // The ROW first, the key second. That ordering is what makes re-running this
    // endpoint an upgrade rather than a re-provision: `reconcileRuntimeKey` reads
    // the row it is reconciling, so it sees the new tier and patches the existing
    // key's USD limit (requirement 37) instead of minting a second key and leaking
    // the first (requirement 38). `rotateKey: true` is the deliberate override, for
    // a workspace migration or a compromised key.
    await store.upsertTenant({
      id: body.tenantId,
      email: body.email ?? null,
      tier,
      status: 'active',
    });
    const tenant = await store.getTenant(body.tenantId);
    if (!tenant) {
      // The row was written a statement ago, so this is a D1 fault rather than a
      // caller error, and reporting it beats minting a key with nowhere to live.
      console.error(`Tenant ${body.tenantId} was provisioned but could not be read back.`);
      return respond({ error: 'The tenant was written but could not be read back.' }, 500);
    }
    const key = await reconcileRuntimeKey(env, store, tenant, { rotate: body.rotateKey === true });

    return respond({
      ok: true,
      tenantId: tenant.id,
      tier,
      month: currentMonth(),
      // Reported rather than assumed. A mint or a limit patch can fail while the
      // tenant row is perfectly written, and the operator running this curl is the
      // only one who can act on that.
      runtimeKeyProvisioned: key.keyPresent,
      runtimeKeyAction: key.action,
      runtimeKeyLimitUsd: key.limitUsd,
      // Requirements 38 and 39: null when there was no superseded key, false when
      // one is still live because retiring it failed.
      supersededKeyDisabled: key.supersededKeyDisabled,
      ...(key.detail ? { runtimeKeyDetail: key.detail } : {}),
    });
  }

  if (request.method === 'POST' && url.pathname === '/api/deactivate') {
    if (!isAdmin) return respond({ error: 'Unauthorized.' }, 401);
    const body = (await request.json().catch(() => null)) as { tenantId?: string } | null;
    if (!body?.tenantId) return respond({ error: 'tenantId is required.' }, 400);

    const tenant = await store.getTenant(body.tenantId);
    if (!tenant) return respond({ error: 'Unknown tenant.' }, 404);

    // Requirement 39. This used to be `.catch(() => undefined)` with a comment
    // saying the key "may already be disabled", which reported a successful
    // deactivation whether the key was retired or still live and spending -
    // indistinguishable from the outside, and invisible in the logs.
    // `disableTenantRuntimeKey` logs the failure and hands back a boolean.
    const runtimeKeyDisabled = await disableTenantRuntimeKey(env, tenant, 'deactivated');
    // Deactivation still proceeds either way: the status is what the inference gate
    // reads, so it is the change that actually stops the spending, and refusing to
    // cancel because a vendor call failed would leave the account fully live.
    await store.upsertTenant({ ...tenant, status: 'canceled' });
    return respond({ ok: true, tenantId: tenant.id, status: 'canceled', runtimeKeyDisabled });
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
  tier: string,
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
    tier,
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
