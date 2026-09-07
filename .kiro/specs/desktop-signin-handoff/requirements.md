# Desktop sign-in handoff

## Problem

**Nobody can sign in to Phorma Cloud from the packaged desktop app, and nobody ever could.** This is
not a regression in `0.2.0-beta.15`. It is a structural incompatibility between Clerk's production
session model and a Tauri webview, and it has been latent since the instance was switched from the
`flowing-seahorse-72` development instance to the `clerk.phorma-labs.com` production one.

The symptom a user sees, after clicking Continue with Google, is the app window replaced by a raw
JSON error page with no way back:

```json
{"errors":[{"message":"Unauthorized request","long_message":"You are not authorized to perform this request","code":"authorization_invalid"}],"clerk_trace_id":"..."}
```

### The mechanism, measured

Reproduced in Chromium at the exact Windows webview origin (`http://tauri.localhost`, port 80),
serving the real production bundle with the real `pk_live_` key, instrumented over the Chrome
DevTools Protocol.

A Clerk **production** instance identifies the browser client with a cookie:

```
__client=<jwt>; Path=/; Domain=clerk.phorma-labs.com; Max-Age=315360000; HttpOnly; Secure; SameSite=Lax
```

`tauri.localhost` and `phorma-labs.com` are different registrable domains, so every request clerk-js
makes to the Frontend API is **cross-site**. Consequently:

1. **Chromium refuses to store the cookie.** CDP reports
   `blockedReasons: ["SchemefulSameSiteLax"]` for `__client`, `__client_uat` and
   `__client_uat_3Vu-UgNi`. The cookie jar for `clerk.phorma-labs.com` ends up holding only
   Cloudflare's `__cf_bm` and `_cfuvid`, and `document.cookie` is empty.
2. **Chromium refuses to send it even when it is planted by hand.** Injecting a valid `__client`
   minted out-of-band via `Network.setCookie` still yields `SchemefulSameSiteLax` on
   `GET /v1/environment` and `GET /v1/client`, and clerk-js is handed a brand new anonymous client
   (injected `client_3IzDLpM7...`, actual `client_3IzDLrQd...`). A `SameSite=Lax` cookie never rides
   a cross-site subresource request; that is the definition of Lax.
3. **So the OAuth callback has no client to attach the attempt to.** Google returns the browser to
   `https://clerk.phorma-labs.com/v1/oauth_callback`, Clerk cannot identify the client that started
   the flow, and answers `301` to `/v1/oauth_callback?err_code=authorization_invalid`, which serves
   `403` with exactly the body above.

The decisive control is in the data already: Cloudflare's `SameSite=None` cookies were stored from
the *same response* in which Clerk's `SameSite=Lax` cookies were rejected. The discriminator is
cross-site-ness, not the scheme.

### Why it always looked fine locally

A Clerk **development** instance is cookieless. `auth_config.cookieless_dev` is `true` and the client
travels in the URL as `__clerk_db_jwt`, so no cross-site cookie is needed. `ng serve` on 7322 and a
`backend/npm run dev` desktop shell both point at the dev instance and both work. The failure is
reachable only from a build carrying the `pk_live_` key, which is to say only from a release.

### Two fixes that are not fixes

Both were investigated and both are dead ends. They are recorded so they are not re-litigated.

- **`Clerk.load({ standardBrowser: false })`.** The non-standard load path does mount the component
  renderer, so the UI would survive - but `@clerk/clerk-js@5.127.2` hardcodes
  `credentials: o.credentials || "include"` for every FAPI request in *both* load paths. The browser
  bundle has no cookie-free transport to switch to. Token transport lives in
  `@clerk/clerk-js/headless` plus a `tokenCache`, which is a different SDK and a bespoke sign-in UI.
- **`app.windows.useHttpsScheme` in `tauri.conf.json`.** Changes the scheme, not the site. See the
  Cloudflare control above.

Clerk's own guidance agrees on the shape of the answer: the Native applications page exists for
exactly this class of client, and `native_settings.api_enabled` is already `true` on the instance.

### What is NOT broken

Ruled out by direct measurement, so none of these should be chased:

- **The keys.** The production bundle contains only `pk_live_Y2xlcmsucGhvcm1hLWxhYnMuY29tJA`; the
  `fileReplacements` swap works. The instance is `instance_environment_type: production`.
- **`allowed_origins`.** `POST /v1/client/sign_ins` answers `422` (form validation, i.e. authorized)
  for `http://tauri.localhost`, `tauri://localhost` and `https://tauri.localhost`.
- **Clerk itself, or the Account Portal.** `https://accounts.phorma-labs.com/sign-in` and `/sign-up`
  both render the full Clerk form, Continue with Google included. A scripted request without a
  browser User-Agent gets `403` from bot protection, which is a false alarm, not an outage.
- **The worker's Clerk configuration.** `/status.json` reports all ten components operational.

Two real but separate defects found while investigating, both tracked here as requirements 9 and 10
because they are cheap and they sit on this path:

- The instance's `home_url`, `after_sign_in_url` and `after_sign_up_url` are all
  `https://app.phorma-labs.com`, and **that host has no DNS record at all**. Nothing resolves it.
- The deployed worker reports `build: 0.2.0-beta.12` while carrying the billing routes that landed
  between beta.13 and beta.14, so the live worker was deployed from a working tree that matches no
  release tag.

## The asset that makes this tractable

`PHORMA_CLOUD_DEFAULT_URL` is `https://cloud.phorma-labs.com`. **The worker is already on a
`phorma-labs.com` subdomain**, which makes it same-site with `clerk.phorma-labs.com`. A page served
by the worker, loaded in the user's real browser, can run clerk-js first-party with cookies that
work. No new DNS record, no new Cloudflare custom domain, and no new Clerk `allowed_origins` entry
(Clerk's Frontend API accepts cross-origin requests from any subdomain of the instance's root
domain).

So the handoff needs a page the worker already knows how to serve and a credential the studio can
hold. It does not need new infrastructure.

## Requirements

### 1. The desktop app can sign in to a Phorma Cloud account

**User story:** As someone who installed the desktop app, I want to sign in to my Phorma account so
that I can deploy and run workflows.

#### Acceptance criteria

1. WHEN a signed-out desktop user starts sign-in THEN the studio SHALL open a Phorma-controlled page
   in the system browser and SHALL NOT navigate its own webview away from the app.
2. WHEN the user completes Clerk sign-in in that browser page THEN the studio SHALL become signed in
   without the user copying, pasting or re-typing anything.
3. WHEN the user already has a live Clerk session in that browser THEN the page SHALL complete
   without asking them to authenticate again.
4. WHEN sign-in completes THEN `PhormaCloudService.signedIn()` SHALL be true and `/api/me` SHALL
   return the tenant profile for that user.
5. The flow SHALL work for Google and for email, because Google is the only social provider enabled
   and email is the only other first factor.

### 2. The studio never depends on a cross-site cookie

#### Acceptance criteria

1. The studio SHALL NOT require any Clerk cookie to be stored or sent from the webview origin.
2. WHEN the app is restarted THEN the session SHALL persist without any Clerk cookie being present.
3. The design SHALL hold for all three webview origins (`http://tauri.localhost`,
   `tauri://localhost`, `https://tauri.localhost`) without enumerating them, since none of them is
   same-site with `phorma-labs.com`.

### 3. The credential is held as a secret, not in the webview

#### Acceptance criteria

1. The long-lived credential SHALL be stored in the OS keychain through `llm.rs`, consistent with the
   existing rule that secrets stay out of the webview.
2. The webview SHALL see at most a short-lived access token and a boolean "signed in", never the
   long-lived credential.
3. The credential SHALL NOT be written to `localStorage`, IndexedDB, the console, telemetry, or any
   log.
4. WHEN the user signs out THEN the credential SHALL be deleted from the keychain AND revoked
   server-side, so a copy taken from a stolen machine stops working.

### 4. The handoff cannot be hijacked

The browser and the app are separate processes with no shared memory, so the join has to be
authenticated in both directions.

#### Acceptance criteria

1. The device code SHALL be generated in the app from a CSPRNG with at least 256 bits of entropy.
2. The app SHALL send only a hash of the device code to the worker when starting the flow, and
   SHALL present the code itself only when redeeming, so a read of worker storage does not yield a
   redeemable code.
3. A pending handoff SHALL expire within 10 minutes.
4. A device code SHALL be redeemable exactly once; a second redemption SHALL be refused.
5. The worker SHALL bind the code to a Clerk `sub` only after verifying a real Clerk session JWT
   through the existing `@clerk/backend` path.
6. Polling SHALL be rate limited, and an unknown, expired or already-redeemed code SHALL be
   indistinguishable in the response from a code that was never issued.
7. The browser page SHALL be served over HTTPS from the worker origin and SHALL NOT accept a
   redirect target supplied by the caller.

### 5. Existing authorization is extended, not loosened

#### Acceptance criteria

1. `verifyBearer` in `cloud/src/auth.ts` SHALL remain the single seam through which every request is
   authorized, and the new credential SHALL be one additional branch in it.
2. A Clerk session JWT SHALL keep working exactly as it does today, so browser parity and the admin
   dashboard are unaffected.
3. Hosted mode SHALL remain fail-closed: an unrecognised bearer SHALL be `null`, never anonymous.
4. BYO mode SHALL be unchanged, including the open-instance and `PHORMA_TOKEN` paths.
5. The new credential SHALL resolve to an `AuthContext` carrying the Clerk user id, so every
   downstream owner check (`ownerId`, `tenants.id`, instance-name prefixes) keeps working untouched.
6. A Phorma-issued credential SHALL NOT be accepted by the admin telemetry routes, which stay
   Clerk-session-only.

### 6. Browser parity is preserved

#### Acceptance criteria

1. WHEN the app runs under `ng serve` THEN sign-in SHALL keep using Clerk's in-app modal, which works
   there.
2. The handoff SHALL be reachable in a browser build for testing, but SHALL NOT be the default path
   there.
3. No Tauri API SHALL be called outside `TauriService` / `isDesktop` guards.

### 7. Failure is legible

The current failure is the worst kind: a dead-end vendor error page in the app window.

#### Acceptance criteria

1. The studio SHALL NEVER navigate its own webview to a Clerk Frontend API URL.
2. WHEN a handoff expires, is refused, or the browser never returns THEN the studio SHALL say so and
   offer to start again.
3. WHEN the worker is unreachable THEN the message SHALL distinguish that from a refused sign-in.
4. A pending handoff SHALL be cancellable from the studio.

### 8. The interim state is honest

Until this ships, the desktop build must not imply it can sign in. (Delivered ahead of this spec.)

#### Acceptance criteria

1. Desktop sign-in SHALL open the Account Portal in the system browser rather than the in-app modal.
2. The studio SHALL state that the desktop app will still show as signed out.
3. WHEN this spec ships THEN that interim copy and its toast SHALL be removed, not left to contradict
   a working flow.

### 9. The Clerk instance's redirect configuration points at a host that exists

#### Acceptance criteria

1. `home_url`, `after_sign_in_url` and `after_sign_up_url` SHALL resolve to a live host.
2. The value SHALL be verified by DNS resolution and an HTTP response, not by reading the Dashboard.

### 10. The deployed worker matches a known build

#### Acceptance criteria

1. `/status.json`'s `build` SHALL match the tag the worker was deployed from.
2. The go-live checklist SHALL include re-deploying the worker after a release bump, so
   `WORKER_BUILD` and the deployed artifact cannot drift again.

## Out of scope

- Replacing Clerk.
- Clerk's `headless` SDK and a bespoke in-app sign-in UI. It would keep sign-in inside the window,
  but it means owning every sign-in, sign-up, MFA and recovery screen, and the Account Portal already
  renders all of them correctly.
- Organizations and multi-session. `single_session_mode` is `true` on the instance.
- Changing how `/api/infer` or the Durable Object authorize. They call `verifyBearer`, so they inherit
  this for free.
