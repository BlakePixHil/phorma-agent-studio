# Stripe billing - tasks

Task 1 is first because nothing below can be tested on localhost until it lands. `admin` is already
done (1.3, 1.4); **1.1 and 1.2 are the live blocker** - `frontend/src/environments/clerk.ts` is the
studio's only publishable key and has no `fileReplacements` beside it, so one file has to serve both
targets. Clerk rejects a production publishable key on localhost, so the file has to stay on the
development `pk_test_` key and the production build has no live key to ship.

- [x] 1. Clerk environment split (prerequisite, unblocks local testing)
  - [x] 1.1 `frontend/src/environments/clerk.ts` back to the DEVELOPMENT `pk_test_` key; new
        `frontend/src/environments/clerk.prod.ts` with the `pk_live_` key
    - _Requirements: 41_
  - [x] 1.2 `fileReplacements` entry in `frontend/angular.json`'s production configuration, mirroring
        `admin/angular.json`
    - _Requirements: 41_
  - [x] 1.3 Correct the inversion in `admin`: `environment.ts` to the development key,
        `environment.prod.ts` to the production key (done manually 2026-09-02)
    - _Requirements: 41_
  - [x] 1.4 Rewrite the `flowing-seahorse-72` comments in both admin environment files, which
        asserted the opposite of the keys the files now hold
    - _Requirements: 42_
  - [x] 1.5 `cloud/.dev.vars` documented with the DEVELOPMENT `CLERK_SECRET_KEY` for local
        `wrangler dev`; rotate the deployed hosted secret to the production key
    - _Requirements: 43_
  - [x] 1.6 Add the production origin to `CLERK_AUTHORIZED_PARTIES`
    - _Requirements: 44_
  - [x] 1.7 Confirm the rotation with `/api/me` and a production session token returning 200, NOT with
        `/status.json` (its Clerk probe returns 200 for any valid key)
    - _Requirements: 43, 44_
  - [x] 1.8 Verify no tenant row is keyed to a development Clerk user id
    - _Requirements: 45_

- [x] 2. Schema
  - [x] 2.1 `cloud/migrations/0003_billing.sql` - `stripe_customer_id`, `stripe_subscription_id`,
        `billing_event_at` on `tenants`, partial unique index on the customer id
    - _Requirements: 1, 14_
  - [x] 2.2 `stripe_events` table (id, type, tenant_id, received_at, status)
    - _Requirements: 13, 14_
  - [x] 2.3 `credit_grants` table with `stripe_payment_id UNIQUE`, `credits`, `cost_usd`,
        `cost_usd_consumed`
    - _Requirements: 21, 22, 23_
  - [x] 2.4 `TenantRecord` gains the Stripe fields; `upsertTenant` persists them without clobbering on
        a status-only write
    - _Requirements: 1_

- [x] 3. Stripe primitives (no SDK)
  - [x] 3.1 `cloud/src/stripe.ts` - form-encoded `fetch` helper, 501 when `STRIPE_SECRET_KEY` absent
    - _Requirements: 33, 34_
  - [x] 3.2 `verifyStripeSignature(raw, header, secret)` via `crypto.subtle.verify` HMAC-SHA256, 300s
        timestamp tolerance, constant-time by construction
    - _Requirements: 11_
  - [x] 3.3 `StripeEnv` (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) folded into `ApiEnv`; document
        both in the `wrangler.jsonc` secret header
    - _Requirements: 33, 34_
  - [x] 3.4 Lookup-key allowlist and price-to-tier resolution via `metadata.tier`; `usdPerCredit`
        derived from `TIERS.starter`
    - _Requirements: 5, 6, 7, 8_
  - [x] 3.5 Unit tests: signature accept/reject, expired timestamp, tampered body, malformed header
    - _Requirements: 11_

- [x] 4. Checkout and portal routes
  - [x] 4.1 `POST /api/checkout` - Clerk JWT, lookup key from the allowlist, reuse or create Customer
        with `metadata.clerk_user_id`, `client_reference_id = userId`, subscription or payment mode
        from the price type
    - _Requirements: 2, 4, 5, 6_
  - [x] 4.1a Automatic tax on, billing address collection on, tax id collection on - an inclusive
        price cannot be split into net and tax without a jurisdiction
    - _Requirements: 46, 47, 48_
  - [x] 4.2 `POST /api/billing-portal` - Clerk JWT, returns a portal session URL
    - _Requirements: 28_
  - [x] 4.3 `GET /billing/return` - minimal worker-served completion page (the studio has no
        addressable URL)
    - _Requirements: 27_
  - [x] 4.4 Both routes placed after the `store.enabled` gate and outside the `isAdmin` branch
    - _Requirements: 32_

- [x] 5. Webhook
  - [x] 5.1 `POST /api/stripe/webhook` matched BEFORE any `request.json()` path; raw body read first
    - _Requirements: 11, 12_
  - [x] 5.2 `INSERT OR IGNORE` on `stripe_events.id`, skip when already applied
    - _Requirements: 13_
  - [x] 5.3 Stale-event guard against the `billing_event_at` watermark
    - _Requirements: 14_
  - [x] 5.4 Tenant resolution: `client_reference_id`, then `customer.metadata.clerk_user_id`, then
        `stripe_customer_id`; record `unresolved` rather than discarding
    - _Requirements: 3_
  - [x] 5.5 `checkout.session.completed` - subscription mode activates or upgrades; payment mode
        writes a credit grant
    - _Requirements: 10, 21_
  - [x] 5.6 `customer.subscription.created` / `.updated` - sync tier and status
    - _Requirements: 10, 14_
  - [x] 5.7 `invoice.payment_failed` sets `past_due`; a subsequent success restores `active`
    - _Requirements: 15_
  - [x] 5.8 `customer.subscription.deleted` sets `canceled` and disables the runtime key
    - _Requirements: 16_
  - [x] 5.9 Miniflare suite through `withLoopbackRetry`; property test that replaying any event set in
        any order converges on the same tenant state. No `withLoopbackRetry` in the end: the suite
        takes the D1 binding out of the Miniflare instance with `getD1Database` and calls
        `handleApiRequest` in-process, so no request crosses `dispatchFetch` and there is no loopback
        socket to exhaust
    - _Requirements: 13, 14_
  - [x] 5.10 Register the new suite in `.github/workflows/ci.yml`

- [x] 6. Entitlement
  - [x] 6.1 `resolveHostedInference` returns a stable `code` alongside its message
    - _Requirements: 19_
  - [x] 6.2 `past_due` becomes a distinct refusal (`subscription_past_due`) that retains tier, data
        and key
    - _Requirements: 17, 18_
  - [x] 6.3 Grant-aware ceilings: `effectiveCostUsdLimit` / `effectiveCreditsLimit`, allowance spent
        before grants
    - _Requirements: 22, 24_
  - [x] 6.4 `recordRun` draws `cost_usd_consumed` only past the monthly allowance, idempotently
    - _Requirements: 23, 24_
  - [x] 6.5 `/api/me` exposes grant credits as additive quota fields
    - _Requirements: 25_
  - [x] 6.6 Optional `code` on the `RunEvent` error payload in BOTH `engine/src/types.ts` and
        `engine/src/events.ts` - which lands entirely in `events.ts`, the only declaration site for
        `RunEvent` and `RunFailureCode`. No frontend edit: the studio imports both from
        `@phorma/engine`, and `workflow.model.ts` twins node kinds and `WorkflowSettings`, not run
        events
    - _Requirements: 19_
  - [x] 6.7 Property tests: granting one payment id twice equals once; allowance-before-grants holds
        for any consumption sequence
    - _Requirements: 21, 24_

- [x] 7. Studio surface
  - [x] 7.1 `BillingService` as a DI leaf - `ClerkService` plus `loadPhormaCloudUrl()`, never
        `CloudService` or `PhormaCloudService`
    - _Requirements: 31_
  - [x] 7.2 Replace `openSubscribe()` at all five call sites with real checkout via the existing
        `openExternal` helper
    - _Requirements: 27_
  - [x] 7.3 Plan cards on the Settings > Cloud page; Enterprise is a Contact sales link with no price
    - _Requirements: 9_
  - [x] 7.4 Credits dialog packs become live, gated on `subscribed()`
    - _Requirements: 26_
  - [x] 7.5 Bounded post-checkout `refresh()` poll plus a focus-triggered refresh
    - _Requirements: 29, 30_
  - [x] 7.6 `past_due` renders an update-card action pointing at the portal, never the Subscribe CTA
    - _Requirements: 17_
  - [x] 7.7 Consumers branch on `code` with the existing regex retained as fallback: the two sites are
        `workflow-builder.service.ts` and `RunControllerService`'s `run-failed` handler
    - _Requirements: 19, 20_
  - [x] 7.8 Billing surfaces absent, not broken, on BYO
    - _Requirements: 32_
  - [x] 7.9 Fix the stale header comment in `frontend/src/app/core/credit-packs.ts` (documents
        $9.99/400 while the array is $10/500)

- [x] 8. Provisioning fixes
  - [x] 8.1 Patch the OpenRouter key `limit` on a tier change instead of leaving the old cap
    - _Requirements: 37_
  - [x] 8.2 Disable the superseded key whenever a replacement is minted
    - _Requirements: 38_
  - [x] 8.3 Report a failed disable (`runtimeKeyDisabled: false`) instead of swallowing it
    - _Requirements: 39_
  - [x] 8.4 Validate that a provisioned `tenantId` looks like a Clerk user id, so a typo cannot create
        an orphan row `/api/me` can never find
    - _Requirements: 1_

- [x] 9. Stripe catalogue and status
  - [x] 9.1 Create the three top-up prices in the sandbox with lookup keys
        `phorma_topup_{small,medium,large}`, `metadata.credits` and `tax_behavior: 'inclusive'`, once
        task 2.3 gives grants a home and 9.2a settles the credit counts
    - _Requirements: 8, 21, 46_
  - [x] 9.2 `tax_behavior` decided: INCLUSIVE, and applied to all three subscription prices
        (permanent once set)
    - _Requirements: 46_
  - [x] 9.2a PRICING DECISION: accept 72.5% net margin on the Medium and Large top-up packs, or reduce
        their credit counts (roughly 1,100 and 2,200 restores ~75%). Blocks 9.1
    - _Requirements: 51_
  - [x] 9.2b Confirm currency. GST is an AUD obligation and an inclusive USD price makes the remitted
        amount move with the exchange rate; currency is immutable per price, so a change means
        recreating all of them
  - [x] 9.3 Correct the margin comment block in `cloud/src/tenants.ts` - it states 80/79/78 computed
        on gross, and the real net figures are 78.0/76.9/75.8
    - _Requirements: 49, 50_
  - [x] 9.4 Stripe probe in `cloud/src/status.ts` as a non-critical component
    - _Requirements: 35_
  - [~] 9.5 Mirror the catalogue into live mode at release, by lookup key, with the same
        `tax_behavior: 'inclusive'`
    - _Requirements: 46_
  - [~] 9.6 Enable Stripe Tax and register the AU GST obligation in the Stripe Dashboard, in both
        sandbox and live
    - _Requirements: 47_

- [ ] 10. OpenRouter workspace migration
  - [x] 10.1 INVESTIGATION: determine how `POST /api/v1/keys` targets a workspace, or whether
        association is implied by the minting key
    - _Requirements: 36_
  - [x] 10.2 Re-runnable migration script: mint on the new workspace, store, disable the old key
    - _Requirements: 40_
  - [x] 10.3 Inventory existing tenants first
        (`wrangler d1 execute phorma-cloud --env hosted --command "SELECT id, tier, status FROM tenants"`)
    - _Requirements: 40_
  - [~] 10.4 Manually disable stragglers left on the old workspace, since the new provisioning key
        cannot reach them - which it can: a management key is ACCOUNT-level and reaches keys in every
        workspace (10.1), and `POST /api/v1/keys` takes an optional `workspace_id`, so 10.2's script
        retires the superseded key itself as part of each rotation plus the orphan sweep. What is left
        here is operational: run that script against the live account (dry run, deploy the
        `OPENROUTER_WORKSPACE_ID` var, `--apply`, then re-run to confirm every active tenant reads
        `skip_already_migrated`), and hand-retire only what it reports as `skip_unmanaged` or
        unclaimed - a live key with no stored hash cannot be rotated, so the dashboard is the only way
        to take it out of service
    - _Requirements: 40_

- [x] 11. Documentation
  - [x] 11.1 `cloud-worker` steering: billing routes, the two new secrets, `past_due` semantics
  - [x] 11.2 `product` steering / `agent.md`: subscription and top-up flows are no longer placeholders
  - [x] 11.3 `.github/agent-memory.md`: prune the "STRIPE NOT WIRED UP YET" entry once this ships
  - [x] 11.4 `release` steering: the Clerk dev/prod split and the go-live secret checklist

## Verification

Run after any change: `cd frontend; npm run build` (the only budget check),
`cd frontend; npx ng test --watch=false --browsers=ChromeHeadless`, `cd engine; npm test`,
`cd cloud; npm run test:unit`, `cd cloud; npm run check`, `cd admin; npm run build`,
`cd admin; npx ng test --watch=false --browsers=ChromeHeadless`. Never the
`npm test -- --watch=false` form, which does not forward flags through npm 10 or 11.

## Follow-up, not done here

- Annual prices. Deliberately additive: a second price per product with an `_annual` lookup key, no
  schema or route change, because the price-to-tier map already keys on `metadata.tier`.
- Proration UX. Stripe handles the money on a mid-cycle plan change through the portal, but the studio
  shows nothing about it.
- Enterprise self-serve. Stays sales-led.
- Dunning email. Stripe's own dunning emails cover it initially; an in-app `past_due` banner is the
  cheaper first move and is in task 7.6.
- A tenant admin surface in `admin/`. Provisioning is still curl-only. Note the two authorization
  models differ (telemetry uses the Clerk allowlist, provisioning a static bearer) and
  `scripts/check-telemetry-secrets.mjs` will fail the build if an admin secret reaches the dashboard
  bundle.
