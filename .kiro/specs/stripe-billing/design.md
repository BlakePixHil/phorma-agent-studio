# Stripe billing - design

## Shape

```
studio                          worker (hosted only)                     Stripe
------                          --------------------                     ------
BillingService.startCheckout
  POST /api/checkout ---------> verify Clerk JWT -> userId
    { lookupKey }                resolve price by lookup_key (allowlist)
                                 reuse or create Customer
                                   metadata.clerk_user_id = userId
                                 create Checkout Session ------------->  hosted page
                                   client_reference_id = userId
  <-- { url } ----------------- return session.url
  openExternal(url)  ........................................ user pays here
                                                                          |
                                 POST /api/stripe/webhook <---------------'
                                   1. raw = await request.text()
                                   2. crypto.subtle.verify HMAC-SHA256
                                   3. INSERT OR IGNORE stripe_events(id)   <- idempotency
                                   4. resolve tenant (3 paths)
                                   5. apply: tier/status | credit grant
                                        |
  poll refresh() ---------------> GET /api/me <-- reads tenants + quotas + grants

BillingService.openBillingPortal
  POST /api/billing-portal ----> create billing_portal.Session --------> hosted portal
  <-- { url } ----------------- (cancel, change plan, card, invoices)
```

The webhook is the only writer of subscription state. The redirect is a courtesy, not a signal: the
user may close the tab, and Stripe still delivers the event.

## No Stripe SDK

The worker talks to Stripe with `fetch` and form-encoded bodies, and verifies signatures with
`crypto.subtle.verify('HMAC', key, sig, payload)`. Three reasons. `cloud/` already carries `agents`
plus `ai` and does not need another large dependency in the bundle. We make only four API calls
(customer create, customer search, checkout session create, billing portal session create), all of
them trivially form-encoded. And `crypto.subtle.verify` is constant-time by construction, which is
the property that actually matters here, so the usual argument for reaching for the audited SDK path
does not apply: hand-rolling a byte comparison would be the risk, and we are not doing that.

The signature check is therefore: split `Stripe-Signature` into `t=` and the `v1=` entries, reject
when `|now - t| > 300s`, then `verify` over `${t}.${raw}` against each `v1` candidate. Timestamp
tolerance is what stops a captured-and-replayed body, so it is not optional.

## Schema

Migration `0003_billing.sql`, additive only.

```sql
ALTER TABLE tenants ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE tenants ADD COLUMN stripe_subscription_id TEXT;
CREATE UNIQUE INDEX idx_tenants_stripe_customer ON tenants(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;          -- partial: existing rows are NULL
ALTER TABLE tenants ADD COLUMN billing_event_at INTEGER NOT NULL DEFAULT 0;  -- ordering watermark

CREATE TABLE stripe_events (                      -- idempotency, mirrors recordRun's discipline
  id TEXT PRIMARY KEY,                            -- Stripe event id
  type TEXT NOT NULL,
  tenant_id TEXT,                                 -- NULL when unresolvable
  received_at TEXT NOT NULL,
  status TEXT NOT NULL                            -- applied | ignored_stale | unresolved
);

CREATE TABLE credit_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  stripe_payment_id TEXT NOT NULL UNIQUE,         -- one grant per payment, forever
  credits INTEGER NOT NULL,                       -- what the user is shown
  cost_usd REAL NOT NULL,                         -- the real budget it buys
  cost_usd_consumed REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_grants_tenant ON credit_grants(tenant_id);
```

Then `0004_billing_ordering.sql`, also additive, plus one idempotent backfill:

```sql
ALTER TABLE tenants ADD COLUMN billing_tier_at INTEGER NOT NULL DEFAULT 0;      -- clock for tier
ALTER TABLE tenants ADD COLUMN billing_status_at INTEGER NOT NULL DEFAULT 0;    -- lifecycle status
ALTER TABLE tenants ADD COLUMN billing_dunning_status TEXT;                     -- active | past_due
ALTER TABLE tenants ADD COLUMN billing_dunning_at INTEGER NOT NULL DEFAULT 0;   -- clock for it
UPDATE tenants SET billing_tier_at = billing_event_at, billing_status_at = billing_event_at
 WHERE billing_event_at > 0;                     -- keep whatever the old scalar protected
```

The partial unique index matters: a plain `UNIQUE` would still permit many NULLs in SQLite, but being
explicit documents that every pre-existing tenant is legitimately unmapped until they buy something.

## Out-of-order delivery: one clock per FIELD

Stripe events carry a `created` timestamp and no ordering guarantee, so a write has to refuse to walk
subscription state backwards. `0003` gave that job to one scalar, `billing_event_at`, and that does
not work, because the event families do not carry equal information:

| Family | Tier |
|---|---|
| `customer.subscription.created` / `.updated`, subscription-mode `checkout.session.completed` | SUPPLIED, off the price |
| `invoice.payment_failed` / `.paid` / `.payment_succeeded`, `customer.subscription.deleted` | RESTATED, read off the tenant row |

With one scalar, a RESTATING event that arrives first advances it and then censors the older,
not-yet-delivered SUPPLYING event as stale, so the supplied tier is lost for good. Measured on
`subscription.updated` (pro) plus an `invoice.payment_failed` a second later, delivered backwards:
the tenant ended `starter`/`past_due` instead of `pro`/`past_due`, breaking requirement 18 on a
pairing Stripe emits routinely. The same censoring lost the buyer's email, which only a Checkout
Session supplies.

So every field carries its own clock, each event is measured only against the fields it actually
knows, and each field becomes a last-writer-wins register over the event SET rather than over the
delivery order. `status` is the FOLD of two registers, evaluated inside `upsertTenant`'s
`ON CONFLICT` clause so two concurrent deliveries still converge:

```
status = 'canceled'         when the newest LIFECYCLE fact is a cancellation
       = the invoice value  when the newest INVOICE fact is newer than the newest lifecycle one
       = the lifecycle value  otherwise
```

Status needs two clocks and not one because a cancellation must overrule an invoice carrying a HIGHER
timestamp - an `invoice.paid` for a subscription that is gone entitles nobody - while still losing to
a genuine later resubscription. That is a two-dimensional comparison. With one clock, the same pair
delivered in the two orders ended `canceled` one way and `active` the other.

`ignored_stale` keeps its meaning: an event whose every supplied field is at or below that field's
clock. Note it does not mean the handler skips the write - a stale event still lands the fill-once
columns (the buyer's email above all), and the clocks refuse the stale fields individually.
`billing_event_at` survives as an AUDIT column only: the newest event that wrote anything. Nothing
may gate on it again.

Grants stay outside every clock: a pack purchase is an immutable payment keyed on
`stripe_payment_id`, it says nothing about plan ordering, and advancing a clock on one would make a
legitimate later subscription event look stale.

## Where top-up credits live, and why a ledger

Credits are derived, not stored, so the honest place to put a purchase is a grant ledger rather than
a balance column. A balance column would need the same careful increment-once discipline plus a
reconciliation story when it disagrees with Stripe; a ledger keyed on `stripe_payment_id` is
self-reconciling and auditable.

Grants raise the effective ceiling rather than reducing usage:

```
effectiveCostUsdLimit  = tierLimits.monthlyCostUsd + grantPoolRemaining
effectiveCreditsLimit  = tierLimits.monthlyCredits + grantCreditsRemaining
grantPoolRemaining     = SUM(cost_usd - cost_usd_consumed)
```

Ordering follows requirement 24: the monthly allowance is spent first, and `recordRun` only draws
`cost_usd_consumed` once `quotas.cost_usd_used` has passed `monthlyCostUsd`. A tenant who never
exceeds their plan keeps the pack indefinitely, which is the behaviour the pricing page implies by
calling it a balance.

Both grant sums are exposed on `/api/me`'s quota block as additive fields, so the credits bar can
render allowance and top-up separately without the studio doing pack arithmetic.

The USD side of a grant is derived once, at purchase, from the starter ratio:

```
usdPerCredit = TIERS.starter.monthlyCostUsd / TIERS.starter.monthlyCredits   // 4 / 1000 = 0.004
grant.cost_usd = credits * usdPerCredit
```

Tying it to `TIERS` rather than a literal is requirement 8: if the starter economics ever move, pack
margin moves with them instead of quietly diverging.

## Routes

All three sit AFTER the `store.enabled` hosted gate, because billing is meaningless on a BYO
deployment, and none of them use the `isAdmin` branch.

| Route | Auth | Notes |
|---|---|---|
| `POST /api/checkout` | Clerk JWT | `{ lookupKey }`, returns `{ url }` |
| `POST /api/billing-portal` | Clerk JWT | returns `{ url }` |
| `POST /api/stripe/webhook` | `Stripe-Signature` | raw body, no bearer |

The webhook must be matched before any code path that calls `request.json()`, since consuming the
body destroys the bytes the signature covers. `handleApiRequest`'s existing try/catch already returns
JSON 500 with CORS headers, which the webhook does not need but is harmless.

`success_url` and `cancel_url` point at a small worker-served page (`/billing/return`) rather than at
the studio, because the studio is a desktop app with no addressable URL and browser-parity users are
on an arbitrary localhost port. The page says the purchase is complete and the window can be closed.

Missing `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` answers 501 naming the secret, matching the
`KEY_ENC_SECRET` precedent in `/api/connection-secrets` rather than surfacing an opaque 500.

## Entitlement and the machine code

`resolveHostedInference` currently returns `{ key } | { status, error }`. It gains a `code`:

```
no_subscription | subscription_past_due | runs_exhausted | credits_exhausted | no_runtime_key
```

`past_due` becomes a distinct refusal (requirement 17) with `subscription_past_due`, and the tenant
keeps their tier, data and key (requirement 18). This is a deliberate tradeoff: blocking on the first
failed invoice is stricter than a grace period, but hosted inference is real money leaving through
OpenRouter, and Stripe's retry window is long enough that a soft block plus a clear "update your
card" path costs the user less than a surprise bill costs us. The recovery UX carries the decision:
`past_due` renders an update-card action pointing at the Billing_Portal, never the generic Subscribe
CTA.

The code has to reach the studio through the engine, whose `node-failed` and `run-failed` events
carry strings. `RunEvent`'s error payload gains an optional `code`, typed as `RunFailureCode`. That is
a one-file change: `RunEvent` and `RunFailureCode` are declared only in `engine/src/events.ts` and the
studio imports them from `@phorma/engine`, so run events are NOT a structural twin -
`workflow.model.ts` twins node kinds and `WorkflowSettings`, nothing on the run wire. Consumers branch on
`code` first and fall back to the existing regex (requirement 20), so a studio talking to a worker
that predates this change keeps its CTAs. The two regex sites -
`workflow-builder.service.ts` and `RunControllerService`'s `run-failed` handler - are the only ones
to touch.

## Studio surface

`BillingService` is a DI leaf: `ClerkService` for the token, `loadPhormaCloudUrl()` for the base.
It deliberately does not inject `PhormaCloudService` or `CloudService`. `PhormaCloudService` would
work today, but `BillingService` will be consumed from the settings dialog and the credits dialog,
and keeping it a leaf means it can never become the edge that closes
`RunControllerService -> ModelTransportService -> PhormaCloudService -> CloudService -> RunControllerService`.

Post-checkout refresh (requirements 29, 30) cannot rely on a redirect, so it polls: after
`openExternal`, call `phormaCloud.refresh()` on an interval, stop on `subscribed()` flipping true or
after a bounded number of attempts, whichever comes first. Also refresh on window focus, which
catches the common case of the user tabbing back immediately.

Plan selection reuses the Settings > Cloud page rather than introducing a modal, since a new required
dialog before a user can pay works against the "defaults must be runnable, a new modal is suspect"
product rule. Three plan cards with a Choose action; Enterprise is a Contact sales link with no
price (requirement 9). The credits dialog keeps its existing layout and only swaps
`[disabled]="true"` / "Coming soon" for a live action, gated on `subscribed()` per requirement 26.

Every new control carries an explicit `size="small"`, solid buttons carry
`class="phorma-btn-content"`, icons are `ti ti-*`, and any confirmation goes through
`ConfirmDialogService`. No `p-dialog`.

## Provisioning fixes

Three changes in `cloud/src/tenants.ts`, all of which the self-serve upgrade path forces:

`upsertTenant`'s `COALESCE` on the key columns stays, because a status-only write must not wipe a
key, but tier changes no longer go through it blindly. A tier change now runs a key reconciliation:
patch the existing OpenRouter key's `limit` to the new tier's `monthlyCostUsd` (requirement 37), and
only mint a replacement when there is no usable key. When a replacement IS minted, the old
`openrouter_key_id` is disabled first (requirement 38).

`disableOpenRouterKey`'s swallowed failure becomes a reported one (requirement 39). Deactivation
still proceeds - a tenant must be cancellable even when OpenRouter is down - but the response carries
`runtimeKeyDisabled: false` and the event row records it, so a leaked key is discoverable instead of
invisible.

The workspace question (requirement 36) is genuinely open. The management key is account-bound and
appears reusable across the new multi-workspace model, so the investigation is narrow: determine
whether `POST /api/v1/keys` accepts a workspace selector, or whether workspace association is
implied by which key mints it. The migration (requirement 40) is a re-runnable script: for each
tenant, mint on the new workspace, store, then disable the old key, driven off
`stripe_events`-style idempotency so a partial run resumes safely.

## Release configuration

`admin` is already in the target shape: `environment.ts` holds the development key,
`environment.prod.ts` holds the production key, and `admin/angular.json` swaps them. Its doc comments
have been corrected to match (requirement 42) - `environment.prod.ts` previously carried the
development key and a comment defending that as deliberate, so the production dashboard build shipped
a `pk_test_` key.

`frontend` still needs the same pattern: `src/environments/clerk.ts` stays on the DEVELOPMENT key, a
new `src/environments/clerk.prod.ts` holds the production key, and `frontend/angular.json`'s
production configuration gains a `fileReplacements` entry. This is the only arrangement that
satisfies both Clerk's rule that production keys are rejected on localhost and the need for a signed
production build. Two keys in two files beats any runtime origin sniffing, because the build already
knows which target it is producing.

Local testing (requirement 43) runs `wrangler dev` with a `.dev.vars` carrying the DEVELOPMENT
`CLERK_SECRET_KEY`, while the deployed hosted worker holds the production one. `.dev.vars` is already
gitignored by `cloud/.gitignore`. This is what makes end-to-end Stripe sandbox testing possible at all
on localhost, and it is why the frontend split is a prerequisite task rather than a cleanup.

Note that `/status.json` cannot verify the production rotation: its Clerk probe hits the Clerk Backend
API, and any valid key returns 200 regardless of instance. The check that actually proves it is a
`/api/me` call with a production session token returning 200 rather than 401.

## Tax

Prices are inclusive, so `$20` is what the customer pays whoever they are, and the GST component is
carved out of it rather than added on top. Stripe needs two things to do that carve: automatic tax
enabled on the Checkout Session, and a billing address to establish jurisdiction. Address collection
is therefore not optional politeness, it is what makes an inclusive price computable. Tax id
collection is enabled alongside it so a business customer can present an ABN and get a compliant
invoice.

The consequence worth writing down is that revenue per customer now varies by country. An Australian
customer at $20 yields $18.18 net with $1.82 remitted; a customer in a jurisdiction where we have no
registration yields the full $20. Inclusive pricing trades predictable revenue for a predictable
price tag, which is the right trade for a published pricing page but it does move the margin figures.

Recomputed at a 10 percent GST rate against net revenue:

| Plan | Displayed | Net | Cost cap | Net margin | Previously claimed |
|---|---|---|---|---|---|
| Starter | $20 | $18.18 | $4.00 | 78.0% | 80% |
| Pro | $60 | $54.55 | $12.60 | 76.9% | 79% |
| Team | $200 | $181.82 | $44.00 | 75.8% | 78% |

All three hold inside the 75 to 80 percent target, so the decision costs about two points and
requires no repricing. The comment block in `cloud/src/tenants.ts` that states the old gross-based
figures is now incorrect and is corrected as part of this work (requirement 49).

The top-up packs do not hold:

| Pack | Displayed | Net | Cost basis | Net margin | Previously claimed |
|---|---|---|---|---|---|
| Small | $10 | $9.09 | $2.00 | 78.0% | 80% |
| Medium | $20 | $18.18 | $5.00 | 72.5% | 75% |
| Large | $40 | $36.36 | $10.00 | 72.5% | 75% |

Medium and Large land 2.5 points under the documented floor, because `credit-packs.ts` had already
spent the margin headroom deliberately: its header records the choice to price those two at
$0.016/credit, below the subscription rate, to make top-ups feel generous. GST-inclusive pricing
consumes what was left. This is a pricing decision rather than an engineering one, so requirement 51
forces it to be made rather than resolved here. Reducing Medium to 1,100 credits and Large to 2,200
would restore roughly 75 percent if that is the preferred direction.

Note this only bites for customers in a jurisdiction where tax is charged. A pack sold into an
untaxed jurisdiction still returns the original margin, so the blended figure depends on customer
mix and the table above is the worst case.

Whether an inclusive price should be denominated in USD at all is a live question, since GST is an
AUD obligation and an inclusive USD price makes the remitted amount move with the exchange rate. That
is bookkeeping rather than code, and it belongs with an accountant, but it is the reason task 9.2
still lists currency as unresolved.

## Testing

Signature verification, event idempotency, stale-event rejection, tenant resolution across all three
paths, and grant arithmetic are pure enough for unit tests plus fast-check properties: granting the
same payment id twice must equal granting it once, and monthly-allowance-before-grants must hold for
any consumption sequence.

The routes get a Miniflare-backed suite alongside the existing four, but they take the D1 binding out
of the instance with `getD1Database` and call `handleApiRequest` in-process rather than going through
`dispatchFetch`. That keeps the real migrations and real SQL under test while costing no loopback
socket per request, so `withLoopbackRetry` (`cloud/test/miniflare-loopback.mjs`) and the Windows
ephemeral-port exhaustion it guards against do not apply here.

Live-ish verification uses the installed Stripe CLI: `stripe listen --forward-to` against
`wrangler dev` plus `stripe trigger` for `checkout.session.completed`,
`customer.subscription.updated`, `invoice.payment_failed` and `customer.subscription.deleted`.

Any new cloud suite is added to `.github/workflows/ci.yml` in the same change.
