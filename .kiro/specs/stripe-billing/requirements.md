# Stripe billing - requirements

## Problem

Phorma Cloud has a complete pricing page, a complete tier model, a complete usage ledger, and no way
to take money. The "Subscribe" CTA at five call sites only calls
`dialog.activePageId.set('cloud')`, which switches a settings page. All three credit packs in
`CreditsDialog` render `[disabled]="true"` with the label "Coming soon". The only way a tenant
becomes `active` is an operator running curl against the `PHORMA_ADMIN_TOKEN`-gated
`POST /api/provision`.

So the observable state is: a user can sign in, see their plan, see a credits bar, click Subscribe,
and land on a page that tells them nothing and charges nothing. Every hosted run they attempt fails
with `402 No active Phorma Cloud subscription. Visit Settings > Cloud to subscribe.` and that
instruction is a dead end.

Four structural gaps sit behind this, none of them cosmetic:

- **Nothing maps a payment to a tenant.** `tenants.id` is the Clerk userId. A Stripe webhook arrives
  keyed by Stripe customer. There is no `stripe_customer_id` column, so an event cannot find its
  tenant. The comment at `cloud/src/api.ts:9-11` claiming a webhook "can call the same endpoints
  later without schema changes" is wrong.
- **Purchased credits have nowhere to live.** Credits are never stored; they are derived on every
  read by `creditsForTier(tier, costUsd)` from `quotas.cost_usd_used`. The only levers are the tier
  constant and consumption, so a top-up currently has no representation at all.
- **Prices are prose.** Tier prices exist solely as a code comment in `cloud/src/tenants.ts`.
  Nothing machine-readable maps a Stripe price to a tier.
- **`past_due` is decorative.** It is in the type union and the schema comment, nothing writes it,
  and neither `subscribed()` nor `resolveHostedInference` accepts it.

Two live defects in the provisioning path will be hit constantly once upgrades are self-serve rather
than manual. `upsertTenant`'s `COALESCE(excluded.openrouter_key_id, tenants.openrouter_key_id)`
means a tier change moves `tier`, and therefore the displayed credit allowance and the quota cap,
while the old OpenRouter key keeps its old USD limit, so the real ceiling does not follow the
upgrade. And when a new key is minted, the previous one is never disabled, so every upgrade leaks a
live key.

One defect is a tripwire for future edits: "credits exhausted" is detected by matching worker prose.
`workflow-builder.service.ts` uses `/\(402\)|credits exhausted|subscription/i` and
`RunControllerService` matches `/credits exhausted/i` to raise the "Buy credits" toast. Rewording a
worker error string silently removes the upsell.

Finally, the release itself is blocked. Clerk was switched to a production instance
(`clerk.phorma-labs.com`) mid-flight, and the switch is only half applied.

`admin` is now correct: `environment.ts` holds the development `pk_test_` key and
`environment.prod.ts` holds `pk_live_`, swapped by the `fileReplacements` entry that
`admin/angular.json` already has.

`frontend` is not. `frontend/src/environments/clerk.ts` is the only place the studio's publishable
key lives and `frontend/angular.json` has no `fileReplacements` at all, so that single file has to
serve both development and production builds. It cannot: Clerk rejects a production publishable key
on localhost, so a `pk_live_` value there would stop `ng serve` on port 7322 from signing in - and
that is the environment the Stripe sandbox has to be tested from. The file therefore still holds the
development `pk_test_` key, which means there is no signed production build to ship.

## Requirements

### Identity and mapping

1. THE Tenant_Store SHALL persist `stripe_customer_id` and `stripe_subscription_id` on `tenants`,
   with a UNIQUE index on `stripe_customer_id`, so a webhook keyed by Stripe customer can resolve
   exactly one tenant and a duplicate customer is a database error rather than a silent double
   account.
2. THE Checkout_Route SHALL derive the tenant id from the VERIFIED Clerk `userId` only, never from a
   request field, and SHALL stamp it on the Stripe Customer as `metadata.clerk_user_id` and on the
   Checkout Session as `client_reference_id`, so the webhook has two independent paths back to the
   tenant and neither depends on a client-supplied value.
3. THE Webhook_Route SHALL resolve a tenant by trying `client_reference_id`, then
   `customer.metadata.clerk_user_id`, then a `stripe_customer_id` lookup, and SHALL record an
   unresolvable event as a named failure rather than discarding it, because a payment that cannot
   find its account is money taken for nothing.
4. THE Checkout_Route SHALL reuse an existing Stripe Customer when the tenant already has one, so a
   returning buyer does not accumulate duplicate customers and their invoice history stays whole.

### Catalogue and prices

5. THE Checkout_Route SHALL resolve a price by Stripe `lookup_key`, never by a hardcoded price id,
   because sandbox and live ids differ and the lookup key is the only identifier stable across both.
6. THE Checkout_Route SHALL accept only lookup keys on a server-side allowlist, so a caller cannot
   check out an arbitrary or archived price of their choosing.
7. THE Billing_Catalogue SHALL map a Stripe price to a tier through `metadata.tier` on the price,
   and SHALL treat `TIERS` in `cloud/src/tenants.ts` as the sole authority for what that tier is
   allowed to do, so tier limits never acquire a second source of truth in Stripe metadata.
8. THE Billing_Catalogue SHALL derive a top-up pack's real USD cost basis from the starter tier's own
   credits-to-USD ratio rather than a separate constant, so pack margin cannot silently drift away
   from the tier model it is priced against.
9. THE Studio SHALL NOT offer self-serve checkout for the Enterprise tier, which stays a sales-led
   "Contact sales" action with no Stripe price.

### Subscription lifecycle

10. THE Webhook_Route SHALL be the ONLY writer of subscription state, so activation cannot diverge
    between a redirect the user may never follow and an event Stripe guarantees to deliver.
11. THE Webhook_Route SHALL verify the `Stripe-Signature` HMAC over the RAW request body before
    parsing anything, SHALL reject a signature older than a five minute tolerance to defeat replay,
    and SHALL perform the comparison in constant time.
12. THE Webhook_Route SHALL be exempt from the `Authorization` header path and from the
    `PHORMA_ADMIN_TOKEN` check entirely, because Stripe authenticates by signature and has no bearer
    to present.
13. THE Webhook_Route SHALL be idempotent per Stripe event id, so Stripe's at-least-once retries
    cannot double-grant credits or double-provision a key.
14. THE Webhook_Route SHALL NOT let an event walk subscription state BACKWARDS, because Stripe does
    not guarantee ordering and a late `subscription.updated` must not resurrect a superseded tier.
    The comparison SHALL be made PER FIELD, against the newest event that supplied THAT field, and
    never against a single per-tenant watermark. The event families do not carry equal information -
    a subscription event supplies a tier because it carries a price, while an invoice event and a
    cancellation restate the tier they read off the row - so one watermark lets a restating event
    censor an older event that would have supplied a tier, and the supplied value is then lost
    permanently. Requirement 14 is therefore "a stale event must not move a field to an older
    value", not "a stale event must do nothing": an event that is stale for one field may still be
    the newest thing known about another, and may still fill a write-once column.
15. THE Webhook_Route SHALL set `status = 'past_due'` on a failed invoice and SHALL restore
    `status = 'active'` on a subsequent successful payment, giving dunning real behaviour for the
    first time.
16. THE Webhook_Route SHALL set `status = 'canceled'` and disable the tenant's OpenRouter runtime key
    when a subscription is deleted, so a cancelled account cannot keep spending.

### Entitlement

17. THE Inference_Gate SHALL refuse hosted inference for a `past_due` tenant with a distinct reason
    from an unsubscribed one, because the remedy differs: one updates a card, the other buys a plan.
18. THE Tenant_Store SHALL retain a `past_due` tenant's data, tier and runtime key rather than
    deprovisioning, so recovering from a failed card is a payment, not a rebuild.
19. THE Inference_Gate SHALL return a STABLE MACHINE CODE alongside its human message, and every
    consumer SHALL branch on that code rather than on message prose, so rewording an error cannot
    remove a purchase CTA.
20. THE Inference_Gate SHALL keep honouring the existing prose match as a fallback while a deployed
    worker may predate the code, so the CTA does not disappear during deploy lag.

### Top-ups

21. THE Grant_Ledger SHALL record one row per completed top-up purchase, keyed uniquely on the
    Stripe payment identifier, so a retried webhook grants credits once.
22. THE Grant_Ledger SHALL hold both the displayed credit count and the real USD budget the grant
    buys, because the gate compares USD and the UI shows credits, and deriving one from the other at
    read time would re-run the pack's margin maths on every request.
23. THE Grant_Ledger SHALL NOT expire a grant at month end, so a pack bought on the 28th is not
    mostly wasted, and SHALL therefore survive the monthly reset that `quotas` performs.
24. THE Inference_Gate SHALL consume the tier's monthly allowance BEFORE drawing on grants, so a
    tenant never loses purchased credits they did not need that month.
25. THE Studio SHALL display a grant's contribution in credits only, never in dollars, per the
    existing credits-not-dollars product rule.
26. THE Studio SHALL offer top-ups only to a tenant with an active subscription, matching the
    pricing page's stated terms.

### Studio surface

27. THE Studio SHALL turn every "Subscribe" placeholder into a real checkout that opens the Stripe
    Session URL through the existing `openExternal` helper, so desktop and browser behave the same
    and no second link helper appears.
28. THE Studio SHALL offer a Billing_Portal action for cancel, change plan, update card and invoice
    history, rather than building any of those surfaces, so the payment UI we own stays small.
29. THE Studio SHALL refresh the account profile after a checkout returns, because checkout completes
    in an external browser and nothing currently re-reads `/api/me` except a sign-in transition.
30. THE Studio SHALL stop polling for that refresh on a bounded timer, so an abandoned checkout does
    not leave a request loop running.
31. THE Billing_Service SHALL be a DI leaf that reads the base URL via `loadPhormaCloudUrl()` and
    takes its token from `ClerkService` directly, so it cannot close the known NG0200 cycle through
    `CloudService`.
32. THE Studio SHALL keep every billing surface absent rather than broken on a BYO deployment, which
    binds no D1 and must never require Stripe configuration.

### Secrets and configuration

33. THE Worker SHALL read `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` from Worker secrets only,
    and the webview SHALL never receive either, per the existing secrets-out-of-the-webview rule.
34. THE Worker SHALL answer 501 naming the missing secret when a billing route is called without
    Stripe configured, rather than failing as an opaque 500.
35. THE Status_Page SHALL probe Stripe as a non-critical component, because a Stripe outage stops new
    signups but does not stop existing tenants running workflows.

### OpenRouter workspace migration

36. THE Provisioner SHALL mint runtime keys into the dedicated Phorma Cloud OpenRouter workspace.
    The mechanism for targeting a workspace on key creation is an open question and SHALL be
    established by investigation before the migration runs.
37. THE Provisioner SHALL update the OpenRouter key's USD limit when a tenant's tier changes, so the
    real spend ceiling follows an upgrade instead of staying at the old tier's cap.
38. THE Provisioner SHALL disable the superseded key whenever it mints a replacement, so an upgrade
    stops leaking a live key.
39. THE Provisioner SHALL surface a failed key disable rather than swallowing it, because the current
    `.catch(() => undefined)` reports a successful deactivation while the key stays live and spending.
40. THE Migration SHALL re-provision existing tenants onto the new workspace and disable their old
    keys, and SHALL be safe to re-run, since it operates on live paid accounts.

### Release configuration

41. THE Release_Config SHALL supply the Clerk development publishable key to development builds and
    the production key to production builds, in BOTH `frontend` and `admin`, because Clerk production
    keys do not work on localhost and a single-file key cannot serve both.
42. THE Release_Config SHALL keep every environment file's doc comment consistent with the key it
    actually holds, because a comment asserting the opposite of its own value is what let the
    `admin` inversion survive review in the first place.
43. THE Release_Config SHALL let a local `wrangler dev` verify DEVELOPMENT Clerk tokens via
    `.dev.vars` while the deployed hosted Worker verifies PRODUCTION ones, since one Worker holds one
    `CLERK_SECRET_KEY` and local testing must not require the live instance.
44. THE Release_Config SHALL include the production origin in `CLERK_AUTHORIZED_PARTIES`, or live
    tokens fail the `azp` check and every request reads 401.
45. THE Release_Config SHALL treat tenant rows keyed to development Clerk user ids as unrecoverable,
    because Clerk cannot migrate users from a development instance to a production one, and SHALL
    ensure no paid tenant is created against the development instance.

### Tax (GST inclusive)

Decision, 2026-09-02: displayed prices are TAX INCLUSIVE. The three sandbox prices have been set to
`tax_behavior: 'inclusive'`, which Stripe treats as permanent, so this is settled rather than
proposed.

46. THE Billing_Catalogue SHALL mark every price `tax_behavior: 'inclusive'`, so the number on the
    pricing page is the number the customer pays in every jurisdiction and the tax component is
    derived from it rather than added to it.
47. THE Checkout_Route SHALL enable Stripe automatic tax and SHALL collect a billing address, because
    an inclusive price cannot be decomposed into net and tax without knowing the customer's
    jurisdiction.
48. THE Checkout_Route SHALL offer tax id collection, so a business customer can supply an ABN or VAT
    id and receive a compliant invoice.
49. THE Billing_Catalogue SHALL treat NET revenue, not the displayed price, as the basis for the
    margin figures documented against `TIERS`, because the tax portion is remitted and was never
    ours. The existing comment in `cloud/src/tenants.ts` claiming 80/79/78 percent is computed on the
    gross price and is now wrong.
50. THE Billing_Catalogue SHALL keep every subscription tier's net margin inside the stated 75 to 80
    percent target band. Verified at a 10 percent GST rate: Starter 78.0, Pro 76.9, Team 75.8. No
    repricing is required.
51. THE Billing_Catalogue SHALL resolve the top-up pack margin shortfall before the packs go on sale.
    At a 10 percent GST rate the Medium and Large packs fall to 72.5 percent net margin, below the
    75 percent floor, because their credit-per-dollar was already the most generous in the catalogue.
    Either accept 72.5 percent explicitly or reduce the pack credit counts; leaving the documented
    floor contradicting the actual number is not an option.
