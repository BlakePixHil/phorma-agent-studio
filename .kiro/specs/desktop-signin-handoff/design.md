# Desktop sign-in handoff - design

## Shape

The desktop app stops trying to hold a Clerk session and instead holds a **Phorma-issued
credential**, obtained by a browser handoff. Clerk stays the identity provider and the only thing
that ever authenticates a human; the worker becomes the issuer of the credential the desktop app
carries.

```
studio (tauri://localhost)                worker (cloud.phorma-labs.com)        Clerk
──────────────────────────                ──────────────────────────────        ─────
1. code = random 256 bits
   hash = sha256(code)
2. POST /auth/device/start {hash} ──────▶  KV authdev:<hash> = pending, TTL 10m
3. openExternal(/auth/device?c=code) ───▶  GET /auth/device
                                             serves a page that runs clerk-js
                                             FIRST-PARTY on phorma-labs.com ──▶ sign in (cookies
                                                                                 work here)
                                           page POSTs {code, clerkSessionJwt}
4.                                         POST /auth/device/claim
                                             verifyToken(clerkSessionJwt) ─────▶ verified sub
                                             KV authdev:<hash> = {sub}
5. POST /auth/device/redeem {code} ─────▶  one-shot: delete KV, mint
   (polled)                                  refresh token + access token
6. refresh token ──▶ OS keychain via Rust
   access token ──▶ webview memory only
7. Authorization: Bearer <access> ──────▶  verifyBearer: new branch
```

Step 3 is the whole trick, and it is available only because
`PHORMA_CLOUD_DEFAULT_URL = 'https://cloud.phorma-labs.com'`. That page is same-site with
`clerk.phorma-labs.com`, so the `SameSite=Lax` `__client` cookie that the webview can never hold
works there without any special handling.

## Why a Phorma credential and not a Clerk one

Every alternative that keeps a *Clerk* credential in the app fails on the same cookie:

- A Clerk **session JWT** lives ~60 seconds and refreshing it requires the client cookie.
- A Clerk **sign-in token** (`strategy: 'ticket'`) has to be redeemed by clerk-js in the webview,
  which needs the client cookie.
- Clerk's **Native API** with `Authorization: Bearer` is real, but `@clerk/clerk-js`'s browser bundle
  hardcodes `credentials: 'include'` and has no token transport. Reaching it means
  `@clerk/clerk-js/headless` plus owning every sign-in screen, which requirement "out of scope"
  rejects.

So the credential the app holds has to be ours. That is a change to the authorization boundary, which
is why this is a spec.

## Worker

### Routes

All four are new, all public (they are the thing that establishes identity, so they cannot require
it), and all matched in `index.ts` alongside `/billing/return` - which is the existing precedent for
"a browser lands here with no bearer to present".

| Route | Auth | Purpose |
|---|---|---|
| `POST /auth/device/start` | none | Registers `sha256(code)` as pending. Returns nothing but `{ ok: true }`. |
| `GET /auth/device?c=<code>` | none | The HTML page. Runs clerk-js first-party, then claims. |
| `POST /auth/device/claim` | Clerk session JWT | Binds the pending code to the verified `sub`. |
| `POST /auth/device/redeem` | none (bearer is the code) | One-shot exchange for the token pair. |

`/auth/device` is deliberately NOT under `/api/`, for the same reason `GET /billing/return` is not:
it is a top-level browser navigation, it carries no CORS headers, and it must not fall into the
`/api/*` auth branch.

### Storage

Pending handoffs go in the existing `TENANTS` KV namespace under `authdev:<sha256(code)>`, with
`expirationTtl: 600`. KV, not D1, because the record is short-lived, single-key, and read once -
which is what KV is for - and because it must expire on its own rather than need a sweep.

The record holds `{ status: 'pending' | 'claimed', sub?: string, createdAt: number }` and nothing
else. **The code itself is never stored**, only its hash, so a dump of KV yields nothing redeemable
(requirement 4.2).

### Tokens

Two tokens with different jobs:

- **Access token.** Short-lived (15 minutes), *signed* rather than opaque: HMAC-SHA256 over
  `{ sub, exp, jti, v }`, base64url, using a new `PHORMA_AUTH_SECRET` worker secret. Signed and not
  opaque because `verifyBearer` is on the hot path for `/api/infer` *and* for every Durable Object
  request, and a storage read there is exactly what `CLERK_JWT_KEY` exists to avoid on DO cold start.
  The cost of that choice is that an access token cannot be revoked mid-life; the 15-minute TTL is
  the bound, and it is the same trade Clerk's own session JWTs make.
- **Refresh token.** Long-lived, **opaque**, 256 bits of CSPRNG. Stored server-side as
  `sha256` only, in a new D1 table, so it is revocable and enumerable per user. D1 and not KV because
  it needs "list and revoke every credential for this user" for sign-out (requirement 3.4).

```sql
-- cloud/migrations/0005_desktop_auth.sql
CREATE TABLE IF NOT EXISTS device_credentials (
  token_hash   TEXT PRIMARY KEY NOT NULL,   -- NOT NULL: a bare TEXT PRIMARY KEY accepts NULL and
                                            -- NULLs compare distinct, which defeated the
                                            -- stripe_events idempotency gate the same way.
  tenant_id    TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_device_credentials_tenant ON device_credentials(tenant_id);
```

`PHORMA_AUTH_SECRET` is a new secret and must be added in both places the `cloud-worker` steering
requires: the `wrangler.jsonc` header comment and `cloud/.dev.vars.example`. It is optional in BYO
mode, and when it is absent the new `verifyBearer` branch is skipped entirely, which keeps a BYO
worker's behaviour byte-identical.

### The `verifyBearer` branch

One added branch, placed **after** the Clerk attempt and **before** the hosted fail-closed return, so
requirement 5 holds by construction:

```ts
// after the existing CLERK_SECRET_KEY block, before `if (isHosted(env)) return null;`
if (env.PHORMA_AUTH_SECRET) {
  const sub = await verifyDeviceAccessToken(env, token);   // pure crypto, no I/O
  if (sub) return { userId: sub };
}
```

It returns the Clerk `sub` as `userId`, so `tenants.id`, `ownerId` stamping and the
`{userId}:{workflowId}` instance-name prefix all keep working with no further change (requirement
5.5).

Two guards that are easy to get wrong:

- The token format must be **unambiguous**: prefix it `phd_` and check that before anything else, so
  a malformed Clerk JWT can never be mistaken for a device token or vice versa.
- The admin telemetry routes must reject it. `handleTelemetryAdminRequest` gates on
  `TELEMETRY_ADMIN_USER_IDS` against a Clerk session; requirement 5.6 says a device credential is not
  an operator credential, so that route checks the credential *kind*, not just the id.

### The handoff page

Static HTML+JS built into the worker as a string, in the same spirit as `handleBillingReturnRequest`.
It loads clerk-js from the instance, and:

1. If there is no session, it calls `Clerk.redirectToSignIn({ signInForceRedirectUrl: <itself> })`.
   The Account Portal is first-party here, so Google works.
2. Once signed in, it takes `await Clerk.session.getToken()` and POSTs `{ code, token }` to
   `/auth/device/claim`.
3. It then renders a plain "you can close this tab and return to Phorma" page.

The `code` never leaves the URL fragment-free query on a page the worker itself serves, and the page
accepts **no** caller-supplied redirect target (requirement 4.7).

`app.phorma-labs.com` still needs fixing on the instance (requirement 9), but this page does not
depend on it: it passes its own URL explicitly, the same reasoning as the existing
`forceRedirectUrl`.

## Rust

The refresh token must never be readable by the webview, and the existing keychain surface already
enforces that shape: `set_secret` and `has_secret` are `#[tauri::command]`, while `get_secret` is
`pub(crate)` and has no command binding. So the exchange happens in Rust.

Three commands in a new `backend/src-tauri/src/auth.rs`:

| Command | Does | Returns to the webview |
|---|---|---|
| `phorma_auth_store(refresh)` | writes the keychain entry | `()` |
| `phorma_auth_clear()` | deletes the entry | `()` |
| `phorma_auth_access_token(base_url)` | reads the entry, POSTs `/auth/device/refresh`, returns the access token | the **access** token only |

`validate_secret_key` in `llm.rs` currently allows only the `mcp:` and `conn:` prefixes, so it needs
`phorma-auth:` added to the allowlist. The single entry is `phorma-auth:refresh`.

`phorma_auth_access_token` caches the access token in a `Mutex` with its expiry so a burst of studio
calls costs one round trip, mirroring how `ACTIVE_STREAMS` is held.

## Studio

### New service

`core/desktop-auth.service.ts`, and it **must be a DI leaf**. It injects `TauriService` only. It must
not inject `PhormaCloudService`, `CloudService` or `RunControllerService`: `PhormaCloudService` will
inject *it*, and `PhormaCloudService` already sits on the
`RunControllerService -> ModelTransportService -> PhormaCloudService` path where a `CloudService` edge
closes NG0200. It reads the base URL with `loadPhormaCloudUrl()` for the same reason
`PhormaCloudService` does.

Surface: `state()` (`'signed-out' | 'pending' | 'signed-in'`), `begin()`, `cancel()`,
`accessToken()`, `signOut()`.

`begin()` generates the code with `crypto.getRandomValues`, hashes it with `crypto.subtle.digest`,
POSTs `/auth/device/start`, hands the URL to `McpOAuthService.openExternal`, then polls
`/auth/device/redeem`. The poll reuses `BILLING_POLL_CONFIG`'s shape (24 attempts, 5s apart, plus a
focus-triggered attempt), because that is the established rail for "the user is off in a browser and
will come back" and it already handles the focus case.

### Changes to `PhormaCloudService`

The point of this design is that these are small and every consumer downstream is untouched.

- `sessionToken()` returns the device access token on desktop and the Clerk JWT in a browser. This is
  the seam that makes `ModelTransportService`, `BillingService` and `/api/infer` work with no edits.
- `signedIn` / `user` / `email` currently derive from `clerk.user$`, which is permanently null on
  desktop. They become a union: Clerk in a browser, `DesktopAuthService.state()` plus the identity
  fields from `/api/me` on desktop.
- `/api/me` therefore has to return display identity (`email`, and `name` when Clerk has one).
  Today the studio gets that from the Clerk user object in the webview, which will not exist.
- `signIn()` loses the interim Account Portal branch and the toast (requirement 8.3) and calls
  `desktopAuth.begin()` instead.
- `signOut()` clears the keychain entry and calls a new `POST /auth/device/revoke`.

### UI

No new dialog. The Settings > Cloud signed-out state gains a pending state ("Waiting for your
browser..." with Cancel), which is the same pattern the checkout flow already uses while a Stripe tab
is open. The interim note added ahead of this spec is deleted.

## Verification

Cheapest level that proves each claim, per the `testing` steering:

| Claim | Where |
|---|---|
| `verifyBearer` accepts a device token, still accepts Clerk, still fails closed, BYO unchanged | `cloud/test/auth-device.test.mjs`, Miniflare + a locally minted RS256 JWT against a `CLERK_JWT_KEY` PEM, exactly as `billing-routes.test.mjs` does |
| one-shot redemption, expiry, unknown-code indistinguishability | property test over the route with real KV |
| refresh revocation and per-user listing | real local D1 via `getD1Database`, like `tenant-billing` |
| the token is opaque to the webview | frontend spec: `phorma_auth_access_token` is the only `invoke` the studio makes, and no spec can read `phorma-auth:refresh` |
| desktop takes the handoff and never `clerk.openSignIn`; browser the reverse | extend `frontend/src/app/core/phorma-cloud.service.spec.ts`, which already asserts exactly this two-sided property for the interim behaviour |
| end to end | manual, and it must be run against the **production** instance in a packaged build, because a development instance cannot reproduce the bug this spec exists to fix |

Add `auth-device` to `cloud/package.json`'s `test:unit` and to `.github/workflows/ci.yml` in the same
change, and keep it away from the D1-heavy billing suites at the end of the chain (the loopback socket
note in the `cloud-worker` steering).

New sockets caveat: the KV-backed property test uses `dispatchFetch`, so it belongs with the fetch
property suites near the front of `test:unit`, not after `stripe-webhook`.

## Risks

- **`PHORMA_AUTH_SECRET` rotation signs out every desktop install at once**, because access tokens
  stop verifying and refresh tokens are exchanged through the same secret. Mitigation: accept two
  secrets during a rotation window (`PHORMA_AUTH_SECRET` plus `PHORMA_AUTH_SECRET_PREVIOUS`), the
  same shape Stripe uses for webhook secret rolls.
- **A device credential is a long-lived bearer on the user's disk.** It is keychain-stored and
  revocable, which is strictly better than the status quo of no sign-in at all, but it is a new
  durable secret and the sign-out path is the only thing that retires it. Requirement 3.4 is
  therefore not optional polish.
- **`/api/me` gaining identity fields widens what the control plane returns.** Keep it to email and
  display name; do not mirror the Clerk user object.
