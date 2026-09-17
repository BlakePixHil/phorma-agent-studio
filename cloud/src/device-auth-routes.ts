/**
 * The desktop sign-in handoff - three JSON routes plus the browser page that
 * joins them.
 *
 * ## The problem being solved
 *
 * The studio's webview cannot hold a Clerk session against a production instance
 * (`device-auth.ts` explains why). But the user's REAL browser can, because
 * `cloud.phorma-labs.com` is same-site with `clerk.phorma-labs.com`, so Clerk's
 * `SameSite=Lax` `__client` cookie travels there normally. So the browser does the
 * authenticating and hands a credential back to the app.
 *
 * ## The flow
 *
 * ```
 *  studio                                  worker                        Clerk
 *  ------                                  ------                        -----
 *  code = 32 CSPRNG bytes
 *  POST /api/auth/device/start  ────────▶  KV authdev:<sha256(code)>
 *    { codeHash }                            = { at }, TTL 10 min
 *  openExternal(/auth/device?c=code) ────▶  serves the page below
 *                                            page runs clerk-js FIRST-PARTY ──▶ sign in
 *                                            page POSTs { code, token }
 *                                          POST /api/auth/device/claim
 *                                            verifyRequest -> Clerk sub
 *                                            KV entry += { sub }
 *  POST /api/auth/device/redeem ────────▶  one-shot: KV delete, then mint
 *    { code }        (polled)               { token } (30d, HMAC signed)
 *  token -> OS keychain
 * ```
 *
 * ## Why these three are under `/api/` and the page is not
 *
 * The three JSON routes are XHR from the studio, so they need the scoped CORS that
 * `handleApiRequest` already computes from `ALLOWED_ORIGINS` - reimplementing that
 * for a second route family is how the two drift apart. The page is a top-level
 * navigation with no bearer and no XHR, so it needs no CORS at all and is wired in
 * `index.ts` beside `/billing/return` and `/signed-in`, which are the same shape.
 *
 * ## Authorization, per route
 *
 * - `start` is PUBLIC. It registers a hash of a secret the caller already knows;
 *   there is nothing to authorize yet and nothing is granted.
 * - `claim` requires a real CLERK SESSION, and that is the only place identity
 *   enters the flow. It must not accept a device token: that would let one machine
 *   mint a second credential for itself forever without a human ever signing in
 *   again. `auth.kind` is what enforces it.
 * - `redeem` is PUBLIC, because the device code IS the credential. The code never
 *   leaves the studio except into the URL it hands the browser, and it is only
 *   redeemable in a 10-minute window, once.
 *
 * ## Known lean-v1 limit, stated rather than hidden
 *
 * KV has no compare-and-swap, so `redeem` reads, deletes, then mints. Two
 * simultaneous redemptions of the same code can both read before either deletes
 * and both mint. Both tokens belong to the same `sub` - the legitimate user who
 * started the handoff - so the impact is a duplicate credential for that user, not
 * a cross-tenant leak. Closing it properly needs the D1 record that lean v1
 * deliberately dropped.
 */

import type { AuthContext, AuthEnv } from './auth';
import { BRAND_HEADING_TEXT_CLASS, BRAND_PAGE_CSP, brandPageDocument } from './brand-page';
import {
  DEVICE_CODE_TTL_SECONDS,
  deviceCodeKey,
  hashDeviceCode,
  isPlausibleDeviceCode,
  mintDeviceToken,
  sanitizeClaimedEmail,
  sanitizeClaimedImageUrl,
  type PendingHandoff,
} from './device-auth';
/** Path of the browser page. Public, top-level navigation, no CORS. */
export const DEVICE_PAGE_PATH = '/auth/device';

/** Prefix of the three JSON routes. */
const DEVICE_API_PREFIX = '/api/auth/device/';

export interface DeviceAuthEnv extends AuthEnv {
  /** KV holding pending handoffs (shared with the tenant cache). */
  TENANTS?: KVNamespace;
  /**
   * Clerk PUBLISHABLE key for the instance this worker verifies against.
   *
   * A `var` in `wrangler.jsonc`, not a secret and not a source constant: it is a
   * public value by design, it differs between the hosted worker and a local
   * `wrangler dev`, and pairing it with `CLERK_SECRET_KEY` is the whole point -
   * the page must sign the user in to the SAME instance the worker verifies. A
   * source constant would have to be edited and released to change it.
   */
  CLERK_PUBLISHABLE_KEY?: string;
}

type Respond = (body: unknown, status: number) => Response;

/**
 * Handles the three JSON routes, or returns null when the path is not one.
 *
 * `verify` is injected rather than imported so the caller keeps ownership of the
 * one authorization seam, matching how the rest of `api.ts` is arranged.
 */
export async function handleDeviceAuthApi(
  request: Request,
  env: DeviceAuthEnv,
  url: URL,
  respond: Respond,
  verify: (env: AuthEnv, request: Request) => Promise<AuthContext | null>,
): Promise<Response | null> {
  if (!url.pathname.startsWith(DEVICE_API_PREFIX)) return null;

  // Every route here needs both bindings. Answered as a 501 naming what is
  // missing, the same way the billing routes do, rather than a 500 from a
  // property access on undefined.
  if (!env.PHORMA_AUTH_SECRET || !env.TENANTS) {
    return respond({ error: 'Desktop sign-in is not configured on this deployment.' }, 501);
  }
  if (request.method !== 'POST') {
    return respond({ error: 'Method not allowed.' }, 405);
  }

  const route = url.pathname.slice(DEVICE_API_PREFIX.length);
  const body = await readJsonBody(request);
  if (body === null) return respond({ error: 'Expected a JSON object.' }, 400);

  if (route === 'start') return await handleStart(env, body, respond);
  if (route === 'claim') return await handleClaim(request, env, body, respond, verify);
  if (route === 'redeem') return await handleRedeem(env, body, respond);
  return respond({ error: 'Not found.' }, 404);
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * `POST /api/auth/device/start` - registers a pending handoff.
 *
 * Takes the HASH, never the code (requirement 4.2): the worker never needs the
 * code to complete the flow, so holding it would be storing a redeemable secret
 * for no reason. A 64-char hex string is the only thing accepted, so this cannot
 * be used to park arbitrary values in KV.
 */
async function handleStart(
  env: DeviceAuthEnv,
  body: Record<string, unknown>,
  respond: Respond,
): Promise<Response> {
  const codeHash = body['codeHash'];
  if (typeof codeHash !== 'string' || !/^[0-9a-f]{64}$/.test(codeHash)) {
    return respond({ error: 'Expected codeHash to be a SHA-256 hex digest.' }, 400);
  }
  const pending: PendingHandoff = { at: Date.now() };
  await env.TENANTS!.put(deviceCodeKey(codeHash), JSON.stringify(pending), {
    expirationTtl: DEVICE_CODE_TTL_SECONDS,
  });
  return respond({ ok: true, expiresInSeconds: DEVICE_CODE_TTL_SECONDS }, 200);
}

/**
 * `POST /api/auth/device/claim` - binds a pending handoff to a signed-in user.
 *
 * Called by the browser page, same-origin, carrying a Clerk session JWT. This is
 * the ONLY point at which a human identity enters the flow, which is why it
 * insists on `kind === 'clerk'`: accepting a device token here would let a machine
 * that already holds one mint further credentials for itself indefinitely without
 * anyone signing in again.
 *
 * An unknown or expired code is 404 and says nothing more. The page shows that as
 * "start again in the app", and a caller probing codes learns only that one
 * particular 256-bit string was not pending.
 */
async function handleClaim(
  request: Request,
  env: DeviceAuthEnv,
  body: Record<string, unknown>,
  respond: Respond,
  verify: (env: AuthEnv, request: Request) => Promise<AuthContext | null>,
): Promise<Response> {
  const auth = await verify(env, request);
  if (!auth?.userId) return respond({ error: 'Unauthorized.' }, 401);
  if (auth.kind !== 'clerk') {
    return respond({ error: 'A browser sign-in is required to authorize a device.' }, 403);
  }

  const code = body['code'];
  if (!isPlausibleDeviceCode(code)) return respond({ error: 'Invalid device code.' }, 400);

  const key = deviceCodeKey(await hashDeviceCode(code));
  const raw = await env.TENANTS!.get(key);
  if (!raw) return respond({ error: 'This sign-in request has expired.' }, 404);

  let pending: PendingHandoff;
  try {
    pending = JSON.parse(raw) as PendingHandoff;
  } catch {
    return respond({ error: 'This sign-in request has expired.' }, 404);
  }

  // Re-put with the SAME remaining window rather than a fresh one: claiming must
  // not extend how long a code stays redeemable.
  const elapsed = Math.floor((Date.now() - (pending.at ?? Date.now())) / 1000);
  const remaining = Math.max(30, DEVICE_CODE_TTL_SECONDS - elapsed);
  const claimed: PendingHandoff = {
    ...pending,
    sub: auth.userId,
    // Display only, and sanitized for size and control characters rather than
    // validated as an address - see `sanitizeClaimedEmail`.
    email: sanitizeClaimedEmail(body['email']),
    // Display only as well, but held to a host allowlist rather than a size
    // bound, because the studio renders it as an `<img src>` - see
    // `sanitizeClaimedImageUrl`.
    imageUrl: sanitizeClaimedImageUrl(body['imageUrl']),
  };
  await env.TENANTS!.put(key, JSON.stringify(claimed), { expirationTtl: remaining });

  return respond({ ok: true }, 200);
}

/**
 * `POST /api/auth/device/redeem` - exchanges a claimed code for a token.
 *
 * Public: the code is the credential. Three outcomes the studio branches on, and
 * they are deliberately distinguishable from each other but not from a code that
 * was never issued:
 *
 * - `202` with `{ status: 'pending' }` - registered, nobody has signed in yet.
 *   The studio keeps polling.
 * - `200` with `{ token, userId, email, imageUrl }` - done, and the code is now
 *   spent. The last two are display-only and may be null.
 * - `404` - unknown, expired, or already redeemed. All three are the same answer,
 *   because telling them apart would confirm that a given code once existed.
 *
 * The KV entry is deleted BEFORE the token is minted, so a mint failure cannot
 * leave a code that is both spent and unredeemed.
 */
async function handleRedeem(
  env: DeviceAuthEnv,
  body: Record<string, unknown>,
  respond: Respond,
): Promise<Response> {
  const code = body['code'];
  if (!isPlausibleDeviceCode(code)) return respond({ error: 'Invalid device code.' }, 400);

  const key = deviceCodeKey(await hashDeviceCode(code));
  const raw = await env.TENANTS!.get(key);
  if (!raw) return respond({ error: 'Not found.' }, 404);

  let pending: PendingHandoff;
  try {
    pending = JSON.parse(raw) as PendingHandoff;
  } catch {
    await env.TENANTS!.delete(key);
    return respond({ error: 'Not found.' }, 404);
  }

  if (!pending.sub) return respond({ status: 'pending' }, 202);

  await env.TENANTS!.delete(key);
  const token = await mintDeviceToken(env.PHORMA_AUTH_SECRET!, pending.sub, Date.now() / 1000);
  return respond(
    {
      token,
      userId: pending.sub,
      email: pending.email ?? null,
      imageUrl: pending.imageUrl ?? null,
    },
    200,
  );
}

/**
 * `GET /auth/device?c=<code>` - the page that does the actual signing in.
 *
 * Public and CORS-free for the same reasons `/billing/return` and `/signed-in`
 * are: a top-level navigation the studio sent the browser to.
 *
 * Unlike those two, this page DOES run script - it has to, because loading
 * clerk-js first-party is the entire point. So the CSP is widened by exactly what
 * that needs and nothing else: script and connections to the Clerk instance host,
 * plus the inline bootstrap, plus `worker-src blob:` because clerk-js runs its
 * timers in a `Worker` built from a blob URL. No styles from anywhere, no fonts,
 * and frames only for the Clerk host.
 *
 * `worker-src` is NOT optional and its absence is not a cosmetic warning. With it
 * missing the browser falls back to `script-src`, which does not admit `blob:`, so
 * the console shows "Creating a worker from 'blob:...' violates the following
 * Content Security Policy directive" on every load. It is listed explicitly rather
 * than by widening `script-src` with `blob:`, which would also let a blob become a
 * top-level script on the page that handles sign-in.
 *
 * The device code is read from the query string and passed to `fetch` as a JSON
 * VALUE - it is never interpolated into markup. The one thing embedded in the
 * document is a `<meta>` holding the publishable key, which is a public value by
 * design.
 *
 * Returns null when the path is not this one.
 */
export function handleDeviceAuthPage(request: Request, env: DeviceAuthEnv): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== DEVICE_PAGE_PATH) return null;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed.', {
      status: 405,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' },
    });
  }

  // Answered rather than thrown: a deployment that never configured desktop
  // sign-in should say so in words the user can act on, not render a page whose
  // script cannot possibly work.
  const publishableKey = env.CLERK_PUBLISHABLE_KEY ?? '';
  const clerkHost = clerkHostFromPublishableKey(publishableKey);
  if (!clerkHost || !env.PHORMA_AUTH_SECRET || !env.TENANTS) {
    return new Response(unavailablePage(), {
      status: 503,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        // Shared with `/billing/return` and `/signed-in`: loads nothing remote, and
        // `img-src data:` is what admits the inline favicon. This page runs no
        // script at all, so it does not need the wider policy the device page
        // below builds for clerk-js.
        'Content-Security-Policy': BRAND_PAGE_CSP,
      },
    });
  }

  return new Response(request.method === 'HEAD' ? null : devicePage(clerkHost, publishableKey), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // `no-transform` is the half that matters beyond caching: the zone is
      // proxied through Cloudflare with Web Analytics on automatic setup, which
      // REWRITES any HTML response to inject `static.cloudflareinsights.com/
      // beacon.min.js`. The CSP below (correctly) blocks it, so every load of
      // this page logged a violation for a script we never asked for. Cloudflare
      // documents `no-transform` as the opt-out that stops the proxy modifying
      // the payload, which is the right fix here - widening `script-src` to admit
      // an analytics CDN on the page that handles sign-in is not.
      'Cache-Control': 'no-store, no-transform',
      'X-Content-Type-Options': 'nosniff',
      // The code is in this URL, so it must not travel onward in a Referer.
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'unsafe-inline' https://${clerkHost}`,
        // clerk-js spawns a Worker from a blob URL. Without this the browser
        // falls back to `script-src`, blocks it, and logs a CSP violation.
        "worker-src blob:",
        `connect-src https://${clerkHost} 'self'`,
        "style-src 'unsafe-inline'",
        'img-src data: https:',
        `frame-src https://${clerkHost}`,
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    },
  });
}

/**
 * The Frontend API host encoded in a publishable key.
 *
 * A Clerk publishable key is `pk_live_` / `pk_test_` followed by base64 of
 * `<frontend-api-host>$`. Derived rather than configured so the host cannot drift
 * from the key it must match.
 */
export function clerkHostFromPublishableKey(key: string): string {
  const body = key.replace(/^pk_(live|test)_/, '');
  try {
    const decoded = atob(body.replace(/-/g, '+').replace(/_/g, '/'));
    const host = decoded.replace(/\$+$/, '');
    return /^[a-z0-9.-]+$/i.test(host) ? host : '';
  } catch {
    return '';
  }
}

/**
 * Shown when this deployment has no desktop sign-in configured (e.g. BYO).
 *
 * Carries the mark but NO state dot: it is a statement about the deployment rather
 * than the outcome of a request, so there is no pending, success or failure for a
 * dot to report. It was previously the only one of these pages with no visual
 * identity at all, which made a BYO user's first Phorma-served page the least
 * recognisable one.
 */
function unavailablePage(): string {
  return brandPageDocument({
    title: 'Sign-in unavailable',
    heading: 'Sign-in is not available here',
    state: 'none',
    // A NON-BREAKING hyphen in "sign-in". Browsers break a line at an ordinary
    // hyphen, and at this column that split the word across two lines as "sign-" /
    // "in.", which reads as a typo on the one page a BYO user sees.
    body: [
      'This deployment is not configured for Phorma account sign&#8209;in. You can close this tab.',
    ],
  });
}

function devicePage(clerkHost: string, publishableKey: string): string {
  // No interpolation of REQUEST data anywhere in here. `clerkHost` is derived from
  // the publishable key and validated by the regex in
  // `clerkHostFromPublishableKey`; `publishableKey` is a deploy-time var and a
  // public value. The device code is NOT here - the script reads it from
  // `location.search` and only ever sends it as a JSON value.
  // The state dot swaps at runtime, so `show()` writes `<main>`'s class. It also
  // rewrites the heading, so the outcome never depends on the dot's colour alone.
  return brandPageDocument({
    title: 'Sign in to Phorma Agent Studio',
    heading: 'Signing you in',
    state: 'pending',
    rootId: 'root',
    headingId: 'title',
    bodyId: 'detail',
    body: ['One moment.'],
    extraHead: `<script src="https://${clerkHost}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"
        data-clerk-publishable-key="${publishableKey}" crossorigin="anonymous"></script>`,
    extraBody: `<script>
(async function () {
  var root = document.getElementById('root');
  function show(state, title, detail) {
    root.className = state;
    // Target the heading TEXT span by class, never \`#title span\`: the <h1> also
    // contains the state dot as its FIRST span, so the loose selector writes the
    // heading into the dot and turns an 8px circle into overflowing text. It looks
    // correct in the markup and is only visible in a screenshot.
    document.querySelector('#title .${BRAND_HEADING_TEXT_CLASS}').textContent = title;
    document.getElementById('detail').textContent = detail;
  }
  // The code arrives in the query string and is only ever sent as a JSON value.
  var code = new URLSearchParams(location.search).get('c') || '';
  if (!code) {
    show('bad', 'Nothing to authorize', 'Start the sign-in again from Phorma Agent Studio.');
    return;
  }
  try {
    await window.Clerk.load({});
    if (!window.Clerk.user) {
      // First-party here, so cookies work and the Account Portal round trip
      // returns cleanly. Coming back re-runs this script with the code intact.
      window.Clerk.redirectToSignIn({ signInForceRedirectUrl: location.href });
      return;
    }
    var token = await window.Clerk.session.getToken();
    // The email is sent for DISPLAY only - the worker binds the credential to the
    // verified sub in the token above and never to this. It travels here because a
    // brand new account has no tenant row for the worker to read it from, and the
    // alternative is a Clerk Backend API call on every /api/me.
    var email = '';
    try { email = window.Clerk.user.primaryEmailAddress.emailAddress || ''; } catch (e) {}
    // Same channel, same display-only status: this is how a Google (or any other
    // provider) profile photo reaches a desktop install, which has no Clerk
    // session of its own to read one from. Clerk serves \`imageUrl\` from its own
    // image CDN whatever the provider, and asks for scaling through query
    // parameters - 64px covers the 28px toolbar avatar at 2x.
    var imageUrl = '';
    try {
      if (window.Clerk.user.hasImage) {
        imageUrl = window.Clerk.user.imageUrl || '';
        if (imageUrl) imageUrl += (imageUrl.indexOf('?') === -1 ? '?' : '&') + 'width=64&height=64&fit=crop&quality=85';
      }
    } catch (e) {}
    var res = await fetch('/api/auth/device/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ code: code, email: email, imageUrl: imageUrl })
    });
    if (res.ok) {
      show('ok', "You're signed in", 'You can close this tab and return to Phorma Agent Studio.');
    } else if (res.status === 404) {
      show('bad', 'This request expired', 'Start the sign-in again from Phorma Agent Studio.');
    } else {
      show('bad', 'Could not authorize this device', 'Start the sign-in again from Phorma Agent Studio.');
    }
  } catch (e) {
    show('bad', 'Could not authorize this device', 'Start the sign-in again from Phorma Agent Studio.');
  }
})();
</script>`,
  });
}
