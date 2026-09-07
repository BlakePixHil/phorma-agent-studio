# Desktop sign-in handoff - tasks

Order matters: the worker can be built and tested with no studio changes at all, and the studio
cannot be tested until the worker answers. Tasks 1-4 are shippable on their own and change nothing
a user sees.

## 0. Operator prerequisites (no code, do these first)

- [ ] 0.1 Point the Clerk instance's `home_url`, `after_sign_in_url` and `after_sign_up_url` at a
      host that resolves. `app.phorma-labs.com` has no DNS record. Verify with a DNS lookup and an
      HTTP response, not by reading the Dashboard. _Requirements: 9_
- [ ] 0.2 Generate `PHORMA_AUTH_SECRET` (32 random bytes, base64) and set it with
      `npx wrangler secret put PHORMA_AUTH_SECRET --env hosted`. Do not commit it, and do not put it
      in `.dev.vars.example` - only its name and shape. _Requirements: 3, 4_
- [ ] 0.3 Redeploy the worker from a clean release checkout so `/status.json`'s `build` matches a tag.
      It currently reports `0.2.0-beta.12` while carrying beta.14's billing routes.
      _Requirements: 10_

## 1. Worker: storage and tokens

- [ ] 1.1 Add `cloud/migrations/0005_desktop_auth.sql` with the `device_credentials` table.
      `token_hash TEXT PRIMARY KEY NOT NULL` - the explicit `NOT NULL` is load-bearing, a bare
      `TEXT PRIMARY KEY` accepts NULL and NULLs compare distinct. _Requirements: 3.4_
- [ ] 1.2 New `cloud/src/device-auth.ts`: `mintAccessToken`, `verifyDeviceAccessToken` (HMAC-SHA256
      over `{sub, exp, jti, v}`, `phd_` prefix checked first), `mintRefreshToken`,
      `hashToken`. Pure, no bindings, so it is unit-testable without Miniflare.
      _Requirements: 4.1, 4.2_
- [ ] 1.3 Declare `PHORMA_AUTH_SECRET` (and `PHORMA_AUTH_SECRET_PREVIOUS`) on the env interfaces as
      OPTIONAL, and document both in the `wrangler.jsonc` header and `cloud/.dev.vars.example`. A BYO
      worker binds neither. _Requirements: 5.4_
- [ ] 1.4 `DeviceCredentialStore` on `TenantStore`'s pattern: `create`, `findActive`,
      `touchLastUsed`, `revoke`, `revokeAllForTenant`. _Requirements: 3.4_

## 2. Worker: the authorization branch

- [ ] 2.1 Add the branch to `verifyBearer` in `cloud/src/auth.ts`, positioned after the Clerk attempt
      and before the hosted fail-closed return. Skip it entirely when `PHORMA_AUTH_SECRET` is unset.
      _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_
- [ ] 2.2 Make the admin telemetry gate reject a device credential, so an access token is never an
      operator credential. This needs `verifyBearer` to report the credential KIND, not just the id.
      _Requirements: 5.6_
- [ ] 2.3 `cloud/test/auth-device.test.mjs`: device token accepted; Clerk JWT still accepted; garbage
      refused; hosted stays fail-closed; BYO open-instance and `PHORMA_TOKEN` paths unchanged; a
      device token refused by the admin route. Mint the Clerk JWT locally against a `CLERK_JWT_KEY`
      PEM as `billing-routes.test.mjs` does, so authorization is never stubbed.
      _Requirements: 5_
- [ ] 2.4 Register the suite in `cloud/package.json` `test:unit` and in `.github/workflows/ci.yml`,
      placed with the fetch property suites near the FRONT of the chain, away from the D1-heavy
      billing suites. _Requirements: none - repo rule_

## 3. Worker: the four routes

- [ ] 3.1 `POST /auth/device/start` - store `authdev:<sha256(code)>` in `TENANTS` KV,
      `expirationTtl: 600`. Never store the code. _Requirements: 4.2, 4.3_
- [ ] 3.2 `POST /auth/device/claim` - verify a real Clerk session JWT, then bind the pending record to
      the verified `sub`. Refuse an unknown or expired code. _Requirements: 4.5_
- [ ] 3.3 `POST /auth/device/redeem` - one-shot: delete the KV record before minting, so a race
      cannot redeem twice. Mint the pair, insert the refresh hash. An unknown, expired or spent code
      SHALL be indistinguishable from one never issued. Rate limit. _Requirements: 4.4, 4.6_
- [ ] 3.4 `POST /auth/device/refresh` and `POST /auth/device/revoke`. _Requirements: 3.4_
- [ ] 3.5 `GET /auth/device` - the HTML page, wired in `index.ts` next to `handleBillingReturnRequest`
      (public, no CORS, top-level navigation). It accepts NO caller-supplied redirect target.
      _Requirements: 1.2, 1.3, 4.7_
- [ ] 3.6 Property test the one-shot and expiry invariants over the real routes with `dispatchFetch`.
      _Requirements: 4.3, 4.4, 4.6_
- [ ] 3.7 Add `email` and `name` to `GET /api/me`. Keep it to those two; do not mirror the Clerk user
      object. _Requirements: 1.4_

## 4. Rust: keychain custody

- [ ] 4.1 Add `phorma-auth:` to `validate_secret_key`'s allowlist in `backend/src-tauri/src/llm.rs`.
      It currently permits only `mcp:` and `conn:`. _Requirements: 3.1_
- [ ] 4.2 New `backend/src-tauri/src/auth.rs` with `phorma_auth_store`, `phorma_auth_clear` and
      `phorma_auth_access_token`. Only the last returns anything to the webview, and only the ACCESS
      token. Do not add a command that returns the refresh token. _Requirements: 3.1, 3.2_
- [ ] 4.3 Cache the access token with its expiry behind a `Mutex`, so a burst of studio calls costs
      one round trip. _Requirements: none - cost_
- [ ] 4.4 `cargo test` coverage: the prefix allowlist accepts `phorma-auth:refresh` and still rejects
      an unprefixed key, and a rejected key leaves no keychain entry behind (the existing tests in
      `llm.rs` already assert that shape). _Requirements: 3.1_

## 5. Studio: the handoff

- [ ] 5.1 New `frontend/src/app/core/desktop-auth.service.ts`. It injects `TauriService` ONLY and
      reads the base URL with `loadPhormaCloudUrl()`. It must not inject `PhormaCloudService`,
      `CloudService` or `RunControllerService` - `PhormaCloudService` injects it, and that path closes
      NG0200. _Requirements: 2, 6.3_
- [ ] 5.2 `begin()`: `crypto.getRandomValues` for the code, `crypto.subtle.digest` for the hash,
      `openExternal` through `McpOAuthService`, then poll `redeem` on `BILLING_POLL_CONFIG`'s shape
      including the focus-triggered attempt. `cancel()` abandons it. _Requirements: 1.1, 7.4_
- [ ] 5.3 Store the refresh token through `phorma_auth_store` and never keep it in a signal, in
      `localStorage`, in IndexedDB, or in telemetry. _Requirements: 3.2, 3.3_
- [ ] 5.4 Point `PhormaCloudService.sessionToken()` at the device access token on desktop. This one
      seam is what leaves `ModelTransportService`, `BillingService` and `/api/infer` untouched.
      _Requirements: 1.4_
- [ ] 5.5 Make `signedIn` / `user` / `email` a union of Clerk (browser) and device auth plus `/api/me`
      identity (desktop). _Requirements: 1.4, 2.2_
- [ ] 5.6 `signOut()` clears the keychain entry AND calls `/auth/device/revoke`. A local-only sign-out
      leaves a working credential on disk. _Requirements: 3.4_
- [ ] 5.7 Remove the interim Account Portal branch, its toast, and the settings note added ahead of
      this spec. Leaving them would contradict a working flow. _Requirements: 8.3_

## 6. Studio: surfaces and failure

- [ ] 6.1 Settings > Cloud signed-out state gains a pending state ("Waiting for your browser...",
      with Cancel), following the pattern the Stripe checkout wait already uses. No new dialog.
      _Requirements: 7.4_
- [ ] 6.2 Distinguish expired / refused / worker-unreachable in the copy, and always offer to start
      again. _Requirements: 7.2, 7.3_
- [ ] 6.3 Assert the studio never navigates its own webview to a Clerk FAPI URL. _Requirements: 7.1_
- [ ] 6.4 Extend `frontend/src/app/core/phorma-cloud.service.spec.ts` to the new two-sided property:
      desktop takes the handoff and never calls `clerk.openSignIn`; a browser build does the reverse.
      _Requirements: 6.1, 6.2_

## 7. Ship

- [ ] 7.1 Full verify chain: `frontend` production build, `npx ng test`, `cloud` `npm run check` and
      `npm test`, `cargo check` and `cargo test`. _Requirements: none - repo rule_
- [ ] 7.2 Manual end-to-end in a PACKAGED build against the PRODUCTION instance. A development
      instance is cookieless and cannot reproduce the bug this spec exists to fix, so a dev-instance
      pass proves nothing here. Test Google and email, a restart (session persists), and sign-out
      (credential gone and revoked). _Requirements: 1, 2.2, 3.4_
- [ ] 7.3 Append the outcome to `.github/agent-memory.md` under the auth heading, and update the
      `product` feature-gating notes if the sign-in copy changed. _Requirements: none - repo rule_
