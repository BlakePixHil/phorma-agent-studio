/**
 * `POST /api/stripe/webhook` - the ONLY writer of subscription state
 * (requirement 10, tasks 5.1 - 5.8).
 *
 * Everything a tenant's plan can become happens here. The checkout redirect is a
 * courtesy the user may never follow; the event is what Stripe guarantees to
 * deliver, so activation, upgrade, dunning, cancellation and credit grants all
 * hang off this one handler and nothing else writes `tier` or `status` on a
 * paying path.
 *
 * ## The pipeline, in the order it has to happen
 *
 * ```
 *  1. method + secret          POST only; 501 naming STRIPE_WEBHOOK_SECRET if unset
 *  2. size ceiling             before any HMAC, because the HMAC is attacker-paid work
 *  3. raw = await request.text()   RAW BYTES - nothing may call request.json() first
 *  4. verifyStripeSignature    the ENTIRE authorization story for this route
 *  5. parse + shape            an unparseable body is 2xx: a retry cannot fix it
 *  6. store.enabled            no D1 -> non-2xx, so Stripe retries until it is bound
 *  7. stripeEventStatus(id)    cheap dedupe for the routine redelivery
 *  8. resolve tenant           client_reference_id | customer.metadata | mapping
 *  9. per-field stale check    created <= the clock of a field this event
 *                              SUPPLIES -> ignored_stale for that field
 * 10. apply                    tier/status write, or a credit grant
 * 11. recordStripeEvent(id)    the authoritative idempotency gate
 * ```
 *
 * ## Why the ORDER of the first four steps is load-bearing
 *
 * The signature covers the raw BYTES of the body. `request.text()` therefore has
 * to be the first thing that touches the body, and a consumed body cannot be
 * re-read - so this route is matched at the TOP of `routeApiRequest`, above every
 * branch that calls `request.json()`. It reads as a stylistic choice and it is
 * not: hoisting a generic body parse above the router would silently break
 * payment processing with no type error and no failing build.
 *
 * The route also sits OUTSIDE `verifyRequest` entirely (requirement 12). Stripe
 * authenticates with an HMAC and has no bearer to present, so putting this behind
 * the Clerk path or the `PHORMA_ADMIN_TOKEN` check would reject every real
 * delivery. {@link verifyStripeSignature} is the whole authorization story, which
 * is why it is a boolean that never throws.
 *
 * ## Why there is a size ceiling
 *
 * This endpoint is public and unauthenticated by construction: the work happens
 * before we know who is calling. `verifyStripeSignature` already caps how many
 * `v1` candidates it will try, which bounds the MULTIPLIER, but one HMAC over a
 * multi-megabyte body is still real CPU an attacker gets for the price of a
 * request. {@link STRIPE_WEBHOOK_MAX_BODY_BYTES} bounds the base, and it is
 * checked from `Content-Length` before the body is read at all so the oversized
 * case costs nothing.
 *
 * ## What answers 2xx, and what does not
 *
 * Stripe retries every non-2xx for days and eventually disables an endpoint that
 * keeps failing - and a disabled endpoint breaks billing for EVERY tenant, not
 * just the event that caused it. So the rule is: 2xx for anything durably
 * recorded, INCLUDING an ignored or unresolved event, and non-2xx reserved for
 * "we genuinely failed and want this again":
 *
 *  - unconfigured secret            501, and no real endpoint points at such a worker
 *  - unreadable / oversized body    4xx: it is not a delivery we can account for
 *  - bad signature                  400, and nothing is recorded
 *  - **no D1 binding**              501 ON PURPOSE. The event is authentic and we
 *                                   cannot record it, so a 2xx would drop real
 *                                   money silently. A retry window is exactly what
 *                                   an operator needs to bind D1 and have the
 *                                   backlog land. (A BYO worker never reaches this:
 *                                   it binds no `STRIPE_WEBHOOK_SECRET`, so step 1
 *                                   already answered 501, and no Stripe endpoint
 *                                   is pointed at it in the first place.)
 *  - Stripe unreachable mid-apply   502, because the same delivery will work later
 *  - a payload defect               **2xx**. A retry can never fix a malformed or
 *                                   unrecognised body, and a permanently failing
 *                                   endpoint costs more than the event is worth.
 *                                   The evidence goes to the log instead.
 *
 * ## Idempotency and ordering are DIFFERENT guards
 *
 * `stripe_events.id` answers "have I seen this MESSAGE". The ordering clocks on
 * `tenants` answer "is this event OLDER than what I already applied to the FIELD
 * it supplies". An event can be new and stale at once, which is the
 * `ignored_stale` status: Stripe does not promise ordering, so a redelivered
 * `subscription.updated` arriving after `subscription.deleted` must not resurrect
 * a cancelled account.
 *
 * ## Ordering is PER FIELD, and that is load-bearing
 *
 * There used to be one clock, `tenants.billing_event_at`, gating every
 * subscription-state write. It cannot work, because the event families do not
 * carry equal information:
 *
 *   SUPPLY a tier   `customer.subscription.created`/`.updated`, and the
 *                   subscription behind a subscription-mode
 *                   `checkout.session.completed`. They carry a price.
 *   RESTATE a tier  `invoice.payment_failed`/`.paid`/`.payment_succeeded` and
 *                   `customer.subscription.deleted`. They carry none, so the tier
 *                   is read off the tenant row and written back.
 *
 * With one clock, a RESTATING event that arrives first advances it and then
 * censors the older, not-yet-delivered SUPPLYING event as stale - so the tier that
 * event would have supplied is lost for good. Measured: `subscription.updated`
 * (pro) plus an `invoice.payment_failed` a second later, delivered backwards, left
 * the tenant `starter`/`past_due` instead of `pro`/`past_due`, breaking
 * requirement 18 on a pairing Stripe emits routinely and orders never.
 *
 * So each field carries its own clock (`billing_tier_at`, `billing_status_at`,
 * `billing_dunning_at`) and each event is measured only against the fields it
 * actually knows. `status` is the FOLD of a lifecycle register and a dunning
 * register, evaluated inside `upsertTenant`'s `ON CONFLICT` clause; the two halves
 * exist because a cancellation has to overrule an invoice carrying a HIGHER
 * timestamp while still losing to a genuine later resubscription, which one clock
 * cannot express. `0004_billing_ordering.sql` is the long version.
 *
 * The consequence for this file: a handler passes a clock ONLY with a field its
 * event supplies. Passing `tierAt` from an invoice, or reusing one clock for two
 * fields, re-introduces the defect with no type error and no failing example test -
 * only the replay-convergence property in `test/stripe-webhook.test.mjs` catches
 * it.
 *
 * The event row is written AFTER the work, not claimed before it, which trades a
 * narrow double-apply for never losing an event to a crash. That trade is only
 * safe because every apply below is independently idempotent: a grant is keyed on
 * the payment id, and a state write SETS a field rather than incrementing it.
 * `upsertTenant`'s `MAX(...)` on every clock makes even a concurrent double-write
 * converge, because it makes each field a last-writer-wins register over the event
 * SET rather than over the delivery order.
 *
 * ## The runtime key rides along, and cannot fail a delivery
 *
 * BOTH money paths reconcile the tenant's OpenRouter runtime key
 * (`reconcileRuntimeKey`): a subscription write, and a TOP-UP. The cap patched onto
 * the key is `runtimeKeyLimitUsd` - the tier allowance PLUS the tenant's unspent
 * grants - which is the same ceiling `resolveHostedInference` enforces, so the key
 * can never refuse a run our own gate allows. A key is minted instead of patched
 * only for a subscriber who holds none.
 *
 * A subscription write runs it AFTER the state write and reads the row back, because
 * the tier the key must follow is the tier the row ended up with rather than the one
 * this event carried. A top-up runs it after the grant, whether or not the grant was
 * new: the patch is idempotent, and a redelivery is the only thing that can heal a
 * patch that failed the first time, since the grant itself never inserts twice.
 *
 * Every failure there is logged and DISCARDED, never thrown and never turned into a
 * `retry`. A vendor outage must not become a non-2xx and an endless redelivery of a
 * write that already landed - and on the grant path that would be unrecoverable
 * rather than merely noisy, because the grant is idempotent on its payment id, so
 * every redelivery would grant nothing and fail again until Stripe disabled the
 * endpoint for every tenant.
 *
 * ## What deliberately is NOT here
 *
 * Consuming a grant is task 6.4; this file only writes one.
 */

import {
  billingKindForLookupKey,
  requireStripeSecret,
  stripeRequest,
  tierForPrice,
  topUpForPrice,
  verifyStripeSignature,
  type StripeEnv,
  type StripePrice,
} from './stripe';
import {
  TenantStore,
  disableTenantRuntimeKey,
  isClerkUserId,
  reconcileRuntimeKey,
  type StripeEventStatus,
  type TenantEnv,
  type TenantRecord,
} from './tenants';

/** Where Stripe posts. Configured on the endpoint in the Stripe Dashboard. */
export const STRIPE_WEBHOOK_PATH = '/api/stripe/webhook';

/**
 * Hard ceiling on the body we will authenticate, in bytes.
 *
 * 1 MiB against real deliveries in the tens of kilobytes - an invoice with an
 * unusual number of lines is the biggest event this catalogue can produce and is
 * nowhere near it. The number exists to bound attacker-controlled CPU on a public
 * route, not to be a tight fit, so it is deliberately generous enough that a
 * genuine delivery can never hit it.
 */
export const STRIPE_WEBHOOK_MAX_BODY_BYTES = 1_048_576;

/** Every binding this handler touches: the Stripe secrets plus the tenant store. */
export type StripeWebhookEnv = StripeEnv & TenantEnv;

/** The JSON responder `routeApiRequest` owns, passed in so CORS stays in one place. */
type Respond = (body: unknown, status?: number) => Response;

// ── Shapes ───────────────────────────────────────────────────────────────────

/**
 * Ids are bounded by SHAPE, never modelled: Stripe documents object ids as
 * opaque, so the job is to refuse prose, markup and empty strings before one
 * becomes a URL path segment or a database key.
 */
const STRIPE_EVENT_ID = /^evt_[A-Za-z0-9_-]{1,255}$/;
const STRIPE_CUSTOMER_ID = /^cus_[A-Za-z0-9_-]{1,255}$/;
const STRIPE_SUBSCRIPTION_ID = /^sub_[A-Za-z0-9_-]{1,255}$/;
const STRIPE_SESSION_ID = /^cs_[A-Za-z0-9_-]{1,255}$/;

/**
 * The identifiers that can stand in for "the money" behind a top-up. A
 * PaymentIntent is the one we expect; the Checkout Session id is the fallback for
 * a session that completed without one (a fully discounted pack).
 */
const STRIPE_PAYMENT_ID = /^(pi|cs|ch|in)_[A-Za-z0-9_-]{1,255}$/;

/**
 * A Stripe event type: lowercase, dot-separated. Bounded because it is written to
 * a column and into log lines.
 */
const STRIPE_EVENT_TYPE = /^[a-z][a-z0-9_.]{0,127}$/;

/*
 * A Clerk user id reaches this file from STRIPE by two paths -
 * `client_reference_id` on a session, `metadata.clerk_user_id` on a customer - and
 * both are checked with `isClerkUserId` from `tenants.ts`.
 *
 * That helper is shared with `/api/provision`, which task 8.4 put behind the same
 * check, and it lives beside the table because `tenants.id` IS a Clerk user id.
 * Two copies of the shape of a primary key is how one writer starts accepting what
 * the other refuses.
 *
 * It is applied to those two Stripe paths only, and NOT to an id read out of our
 * own `tenants` table: `/api/provision` accepted any string for months, so a
 * legacy hand-provisioned row can carry an id the pattern rejects, and refusing to
 * resolve an EXISTING tenant would turn a real payment into an `unresolved` row
 * for no benefit.
 *
 * The value is not untrusted in the usual sense - the signature proves Stripe sent
 * it, and we stamped it ourselves from a verified Clerk `sub`. What the check buys
 * is that a mistake upstream cannot invent a tenant id: this string becomes a
 * PRIMARY KEY in `tenants`, and an `upsertTenant` on a typo creates an orphan row
 * `/api/me` can never find.
 */

/** Longest email we will copy off a Checkout Session onto a tenant row. */
const EMAIL_MAX_CHARS = 320;

/**
 * How many units of one line item we will honour. Our own sessions always send
 * `quantity: 1`, so this only bounds the damage if that ever changes by accident:
 * quantity multiplies GRANTED CREDITS, and an unbounded multiplier read out of a
 * payload is the one number here worth capping.
 */
const MAX_LINE_ITEM_QUANTITY = 100;

/** The event fields this handler reads, after validation. */
interface StripeEvent {
  id: string;
  type: string;
  /**
   * Stripe's own `created`, in epoch SECONDS - the same unit as
   * `tenants.billing_event_at`. Never milliseconds; mixing the two would put a
   * value 1000x too large in the watermark and permanently mark every later event
   * stale.
   *
   * 0 means "no usable timestamp", which is treated as unorderable: the event
   * still applies, and it advances no watermark.
   */
  created: number;
  /** `data.object` - the session, subscription or invoice the event is about. */
  object: Record<string, unknown>;
}

/**
 * What one applied event did. `retry` is the ONLY non-2xx path past signature
 * verification, and it deliberately records nothing, so the redelivery starts
 * clean.
 */
type WebhookOutcome =
  | { status: StripeEventStatus; tenantId: string | null }
  | { retry: { status: number; error: string } };

/** A tenant an event was successfully attached to. */
interface TenantResolution {
  /** The tenant id, which may not have a row yet (a first-time buyer). */
  tenantId: string;
  /** The stored row, or null when this tenant has never been provisioned. */
  tenant: TenantRecord | null;
  /** The Stripe customer the event named, when it named a usable one. */
  customerId: string | null;
}

type TenantResolutionResult =
  | { resolved: TenantResolution }
  /** Genuinely nobody to attach this to. The string is the reason, for the log. */
  | { unresolved: string }
  /** We could not TELL, which is a different thing and wants a redelivery. */
  | { retry: { status: number; error: string } };

// ── Small readers ────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A non-empty, trimmed, bounded string, or null for anything else. */
function asText(value: unknown, max = 255): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

/**
 * An id off a field Stripe may deliver either as a bare string or as an expanded
 * object. Events are not expanded in practice, so the object branch is the cheap
 * insurance rather than the common case.
 */
function asId(value: unknown, pattern: RegExp): string | null {
  const direct = asText(value);
  if (direct) return pattern.test(direct) ? direct : null;
  const expanded = asText(asRecord(value)?.['id']);
  return expanded && pattern.test(expanded) ? expanded : null;
}

/** An error message, without letting a non-Error throw become "[object Object]". */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Stripe's `created`, coerced to the integer epoch-seconds the watermark column
 * holds. Anything else becomes 0, which means "unorderable": the event still
 * applies (losing a real payment to a malformed timestamp would be the worse
 * failure) and `upsertTenant`'s `MAX` leaves the stored watermark alone.
 */
function eventCreatedSeconds(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.floor(seconds);
}

// ── The route ────────────────────────────────────────────────────────────────

/**
 * Handles `POST /api/stripe/webhook`, or returns null when the path is not this
 * one - matching the other route helpers, so `routeApiRequest` can put it first
 * with one `if`.
 *
 * MUST be called before anything reads the request body. See the module header.
 */
export async function handleStripeWebhookRequest(
  request: Request,
  env: StripeWebhookEnv,
  url: URL,
  respond: Respond,
): Promise<Response | null> {
  if (url.pathname !== STRIPE_WEBHOOK_PATH) return null;

  // Answered rather than left to fall through, because falling through would
  // report a 404 for a path that plainly exists and send an operator debugging a
  // delivery in the wrong direction. Stripe only ever sends POST, so anything
  // else is a scanner or a hand-made request.
  if (request.method !== 'POST') {
    return respond({ error: 'Method not allowed. Stripe delivers webhooks with POST.' }, 405);
  }

  // Requirement 34: name the missing secret. Before the body is read, so an
  // unconfigured worker does no work at all.
  const secret = requireStripeSecret(env, 'STRIPE_WEBHOOK_SECRET');
  if ('status' in secret) return respond({ error: secret.error }, secret.status);

  // `Number(null)` and `Number('')` are 0, so an absent header simply does not
  // trip this; a junk header is NaN and is left to the post-read check below.
  const declaredBytes = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > STRIPE_WEBHOOK_MAX_BODY_BYTES) {
    return refuseOversizedBody(respond, `Content-Length declared ${declaredBytes} bytes`);
  }

  // THE RAW BYTES. Everything the signature covers is this string, so nothing
  // above this line may have touched the body and nothing below may re-read it.
  let raw: string;
  try {
    raw = await request.text();
  } catch (error) {
    // A truncated or aborted upload. Non-2xx on purpose: the delivery never
    // arrived intact, so we want Stripe to send it again.
    console.error(`Stripe webhook body could not be read: ${describeError(error)}`);
    return respond({ error: 'Could not read the request body.' }, 400);
  }
  // A JS string counts UTF-16 code units, and a UTF-8 body is never SHORTER than
  // its character count, so this over-length test only fires when the byte count
  // is over too - conservative in the right direction.
  if (raw.length > STRIPE_WEBHOOK_MAX_BODY_BYTES) {
    return refuseOversizedBody(respond, `the body carried ${raw.length} characters`);
  }

  // Requirement 11, and the entire authorization for this route. Logs its own
  // reason (wrong secret, replay, malformed header) and never throws, so there is
  // no shape to misread here.
  const signed = await verifyStripeSignature(
    raw,
    request.headers.get('Stripe-Signature'),
    secret.secret,
  );
  if (!signed) return respond({ error: 'Invalid Stripe signature.' }, 400);

  // Past this line the body is Stripe's. Everything after it is about what to DO
  // with it, and every refusal is 2xx unless a retry could genuinely help.
  const event = parseStripeEvent(raw);
  if (!event) return respond({ received: true, status: 'ignored' });

  const store = new TenantStore(env);
  if (!store.enabled) {
    // Deliberately non-2xx. See the module header: an authentic event we cannot
    // record must not be silently dropped, and asking for a retry is the only way
    // to keep it.
    console.error(
      `Stripe event ${event.id} (${event.type}) cannot be recorded: this worker has no D1 ` +
        `binding. Returning 501 so Stripe retries once the binding is in place.`,
    );
    return respond({ error: 'Control plane unavailable: hosted bindings missing.' }, 501);
  }

  const alreadySeen = await store.stripeEventStatus(event.id);
  if (alreadySeen) {
    // The routine case, not an error: Stripe delivers at least once.
    console.log(
      `Stripe event ${event.id} (${event.type}) was already recorded as "${alreadySeen}"; skipping.`,
    );
    return respond({ received: true, status: alreadySeen, duplicate: true });
  }

  const outcome = await applyStripeEvent(env, store, event);
  if (!outcome) {
    // A type this endpoint is subscribed to but does not act on. No row: the
    // table records the events that CAN change something, and an unhandled type
    // is a Dashboard endpoint configuration to narrow rather than a state to
    // audit.
    console.warn(`Stripe event ${event.id} has unhandled type "${event.type}"; nothing to do.`);
    return respond({ received: true, status: 'ignored' });
  }

  if ('retry' in outcome) {
    console.error(
      `Stripe event ${event.id} (${event.type}) was not applied and is being left for retry: ` +
        `${outcome.retry.error}`,
    );
    return respond({ error: outcome.retry.error }, outcome.retry.status);
  }

  const recorded = await store.recordStripeEvent({
    id: event.id,
    type: event.type,
    tenantId: outcome.tenantId,
    status: outcome.status,
  });
  if (!recorded) {
    // The `INSERT OR IGNORE` did nothing, so a concurrent delivery of the same
    // event recorded it first. Harmless - both passes applied the same idempotent
    // writes - but worth a line, because it is the only way to tell this apart
    // from a lost row.
    console.warn(
      `Stripe event ${event.id} (${event.type}) was recorded by a concurrent delivery; this pass ` +
        `applied the same state.`,
    );
  }
  return respond({ received: true, status: outcome.status });
}

/** Logs the evidence and refuses an oversized body without hashing it. */
function refuseOversizedBody(respond: Respond, detail: string): Response {
  console.warn(
    `Stripe webhook refused before verification: ${detail}, over the ` +
      `${STRIPE_WEBHOOK_MAX_BODY_BYTES} byte ceiling. A real Stripe delivery is orders of ` +
      `magnitude smaller, so this is a malformed or hostile request.`,
  );
  return respond({ error: 'Request body too large.' }, 413);
}

/**
 * Validates the envelope: id, type, `created`, and `data.object`.
 *
 * `id` is checked HERE rather than left to the schema, because `INSERT OR IGNORE`
 * swallows a NOT NULL violation exactly the way it swallows a duplicate - so a
 * missing event id would fail closed and silently, and the idempotency gate would
 * read as "already handled" for every event forever.
 *
 * A valid signature over an unparseable body is close to impossible (it means
 * Stripe signed something we cannot read), so this is a "never happens, but if it
 * does, say so loudly and do not retry" path.
 */
function parseStripeEvent(raw: string): StripeEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`Stripe webhook body passed verification but is not JSON: ${describeError(error)}`);
    return null;
  }

  const envelope = asRecord(parsed);
  const id = asText(envelope?.['id']);
  const type = asText(envelope?.['type'], 128);
  if (!id || !STRIPE_EVENT_ID.test(id) || !type || !STRIPE_EVENT_TYPE.test(type)) {
    console.error(
      'Stripe webhook body passed verification but carries no usable event id and type; ' +
        'it cannot be deduplicated, so nothing was applied.',
    );
    return null;
  }

  const object = asRecord(asRecord(envelope?.['data'])?.['object']);
  if (!object) {
    console.error(`Stripe event ${id} (${type}) carries no data.object; nothing to apply.`);
    return null;
  }

  const created = eventCreatedSeconds(envelope?.['created']);
  if (!created) {
    console.warn(
      `Stripe event ${id} (${type}) carries no usable "created" timestamp, so it cannot be ` +
        `ordered: it will be applied without advancing the tenant's watermark.`,
    );
  }
  return { id, type, created, object };
}

/**
 * Dispatches one verified event. `null` means the type is not one we act on.
 *
 * The four handled families each end in the SAME write
 * ({@link writeSubscriptionState}) or the same grant, which is what keeps 5.5's
 * "activate or upgrade" and 5.6's "sync tier and status" from being two
 * implementations of one rule.
 */
async function applyStripeEvent(
  env: StripeWebhookEnv,
  store: TenantStore,
  event: StripeEvent,
): Promise<WebhookOutcome | null> {
  switch (event.type) {
    case 'checkout.session.completed':
    // A DELAYED PAYMENT METHOD settling. Stripe completes the session first with
    // `payment_status` still unpaid, then sends this when the money actually
    // arrives - and it is the same session object, now paid. Without this case
    // `applyTopUp` correctly refused to grant on the promise and nothing ever
    // followed up, so a customer paying that way was charged and received zero
    // credits, permanently and silently. Requirement 3's principle, exactly.
    //
    // Routed to the SAME handler rather than to a top-up-only path:
    // `applyCheckoutSession` already branches on `mode`, so a pack grants and a
    // subscription activates, and both are idempotent across the two events -
    // `credit_grants.stripe_payment_id` is UNIQUE on the PAYMENT, not the event, so
    // the pack grants exactly once whether one event arrives or both.
    case 'checkout.session.async_payment_succeeded':
      return applyCheckoutSession(env, store, event);
    case 'checkout.session.async_payment_failed':
      return applyFailedAsyncPayment(event);
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      // The subscription object IS the event payload here, so no fetch is needed
      // and `items[].price` is already inline.
      return applySubscriptionEvent(env, store, event, event.object);
    case 'customer.subscription.deleted':
      return applySubscriptionDeleted(env, store, event);
    case 'invoice.payment_failed':
      return applyInvoiceOutcome(env, store, event, 'past_due');
    // Both types describe the same fact and Stripe sends both; handling either is
    // idempotent, so which ones the endpoint subscribes to stops mattering.
    case 'invoice.payment_succeeded':
    case 'invoice.paid':
      return applyInvoiceOutcome(env, store, event, 'active');
    default:
      return null;
  }
}

// ── Tenant resolution (task 5.4, requirement 3) ──────────────────────────────

/**
 * Finds the tenant an event belongs to, in the order requirement 3 specifies:
 * `client_reference_id`, then `customer.metadata.clerk_user_id`, then a
 * `stripe_customer_id` lookup.
 *
 * The ordering is a PRECEDENCE decision, not a cost one - the third path is a
 * local D1 read and the second may cost a Stripe round trip. Stripe's own
 * metadata wins because we stamped it from a verified Clerk `sub` at customer
 * creation, whereas the stored mapping is our bookkeeping about that same fact;
 * when the two disagree, the fact should win over the bookkeeping.
 *
 * The three outcomes are deliberately distinct:
 *
 *  - `resolved`   - an identity, plus the row if one exists. A first-time buyer
 *                   legitimately has an id and NO row, and each caller decides
 *                   whether it can create one (a subscription event can, because
 *                   it carries the tier; an invoice event cannot).
 *  - `unresolved` - resolution ran to completion and found nobody. Requirement 3
 *                   forbids discarding this, so the caller records the row.
 *  - `retry`      - we could not TELL, because the customer read failed and no
 *                   stored mapping covered it. Recording `unresolved` here would
 *                   name a permanent failure for a transient cause, so the event
 *                   is left for redelivery instead.
 */
async function resolveTenant(
  env: StripeWebhookEnv,
  store: TenantStore,
  source: { clientReferenceId?: unknown; customer?: unknown },
): Promise<TenantResolutionResult> {
  const customerId = asId(source.customer, STRIPE_CUSTOMER_ID);
  const resolve = async (tenantId: string): Promise<TenantResolutionResult> => ({
    resolved: { tenantId, tenant: await store.getTenant(tenantId), customerId },
  });

  // ── Path 1: client_reference_id ────────────────────────────────────────────
  // Set by `/api/checkout` to the verified Clerk `sub`, and the ONLY path that
  // works for a brand new buyer whose customer is not mapped yet and whose tenant
  // row does not exist. Present on Checkout Session events only.
  const referenced = asText(source.clientReferenceId);
  if (referenced && isClerkUserId(referenced)) return resolve(referenced);
  if (referenced) {
    console.warn(
      'A Stripe event carried a client_reference_id that is not a Clerk user id shape; ' +
        'falling through to the customer paths.',
    );
  }

  // ── Path 2: customer.metadata.clerk_user_id ────────────────────────────────
  // Independent of our own database, which is the point: it survives a mapping we
  // never got round to writing.
  let customerReadFailed = false;
  if (customerId) {
    const inline = asRecord(source.customer);
    if (inline) {
      // An expanded customer already in the payload. Events are not expanded in
      // practice, so this is a short circuit rather than the normal path - and
      // when it IS present it is authoritative, so no fetch follows it.
      const stamped = clerkUserIdFromCustomer(inline);
      if (stamped) return resolve(stamped);
    } else {
      const fetched = await stripeRequest<Record<string, unknown>>(
        env,
        `/customers/${encodeURIComponent(customerId)}`,
        { method: 'GET' },
      );
      if ('status' in fetched) {
        // Noted rather than fatal: the stored mapping below may answer this
        // anyway, and refusing before trying it would turn a Stripe blip into a
        // failed delivery for an event we could have handled.
        customerReadFailed = true;
        console.warn(
          `Could not read Stripe customer ${customerId} while resolving an event; falling back ` +
            `to the stored mapping.`,
        );
      } else {
        const stamped = clerkUserIdFromCustomer(fetched.data);
        if (stamped) return resolve(stamped);
      }
    }

    // ── Path 3: the stored stripe_customer_id mapping ───────────────────────
    // Written by an earlier event (or by `/api/checkout` for an existing tenant).
    // The record comes back whole, so no second read is needed.
    const mapped = await store.getTenantByStripeCustomer(customerId);
    if (mapped) return { resolved: { tenantId: mapped.id, tenant: mapped, customerId } };
  }

  if (customerReadFailed) {
    return {
      retry: {
        status: 502,
        error: 'Could not reach Stripe to identify the customer behind this event.',
      },
    };
  }
  return {
    unresolved: customerId
      ? `no tenant is mapped to Stripe customer ${customerId}, and its metadata carries no ` +
        `clerk_user_id`
      : 'the event named neither a usable customer nor a client_reference_id',
  };
}

/** `metadata.clerk_user_id` off a customer object, when it is a usable id. */
function clerkUserIdFromCustomer(customer: Record<string, unknown> | null): string | null {
  const stamped = asText(asRecord(customer?.['metadata'])?.['clerk_user_id']);
  if (!stamped) return null;
  if (!isClerkUserId(stamped)) {
    console.warn(
      'A Stripe customer carries a metadata.clerk_user_id that is not a Clerk user id shape; ' +
        'ignoring it.',
    );
    return null;
  }
  return stamped;
}

/**
 * The requirement 3 row: authentic, understood, attached to nobody.
 *
 * `tenantId` is normally null. It is NOT null for the narrower case where an
 * identity resolved but no tenant row exists and the handler cannot invent one -
 * there, the id is the single most useful thing an operator repairing this row
 * can have, so it is recorded rather than left to a log line that ages out.
 */
function unresolved(event: StripeEvent, reason: string, tenantId: string | null): WebhookOutcome {
  console.error(
    `Stripe event ${event.id} (${event.type}) could not be applied to a tenant: ${reason}. ` +
      `Recorded as unresolved - look the event up in Stripe, map the customer to its Clerk user ` +
      `and repair the tenant by hand.`,
  );
  return { status: 'unresolved', tenantId };
}

// ── The ordering guard (task 5.3, requirement 14) ────────────────────────────

/**
 * Whether this event is older than the FIELD's own clock.
 *
 * At-or-below counts as stale, so a redelivery changes nothing even in the window
 * before its event row lands.
 *
 * Two cases are NOT stale by definition: a clock of 0 (nothing has ever been
 * applied to that field, which is also what a brand new tenant row reads) and an
 * event with no usable `created` (unorderable, so applying it is the lesser risk -
 * losing a real payment to a malformed timestamp would be worse).
 *
 * ## Why this takes a FIELD and not just a tenant
 *
 * It used to compare against one scalar, `tenants.billing_event_at`, and that was
 * the defect `0004_billing_ordering.sql` fixes. The event families do not carry
 * equal information: `customer.subscription.created`/`.updated` and a
 * subscription-mode checkout SUPPLY a tier because they carry a price, while
 * `invoice.*` and `customer.subscription.deleted` carry none and RESTATE the tier
 * they read off the row. One scalar let a restating event advance the watermark
 * and then censor an older, not-yet-delivered supplying event, losing the supplied
 * tier for good - measured, on `subscription.updated` (pro) plus
 * `invoice.payment_failed` a second later, delivered backwards, which is a pairing
 * Stripe emits routinely and orders never.
 *
 * So each field has its own clock and each event is only ever measured against the
 * clocks of the fields it actually knows. This is also a decision rather than a
 * storage guarantee: `upsertTenant` independently refuses to write a field whose
 * clock says the value is older. What this answers is whether the handler should
 * do the surrounding WORK at all - fetch, log, disable a runtime key.
 */
function isStaleForField(event: StripeEvent, clock: number): boolean {
  if (event.created <= 0) return false;
  return event.created <= clock;
}

function ignoredStale(event: StripeEvent, tenant: TenantRecord, clock: number): WebhookOutcome {
  console.warn(
    `Stripe event ${event.id} (${event.type}) created ${event.created} is at or below the clock ` +
      `${clock} already recorded for the field it supplies on tenant ${tenant.id}; ignored as ` +
      `stale so it cannot walk subscription state backwards.`,
  );
  return { status: 'ignored_stale', tenantId: tenant.id };
}

// ── The shared subscription state write (tasks 5.5 - 5.8) ────────────────────

/**
 * Stripe subscription status -> our tenant status. The one mapping, so every
 * branch agrees on what a plan state means.
 *
 * `trialing` counts as active: a trial is a subscription we agreed to honour.
 * `past_due`, `unpaid`, `incomplete` and `paused` all become `past_due`, which
 * requirement 18 makes a RETAINING state - tier, data and runtime key stay put -
 * and requirement 17 gives its own refusal, because the remedy is a card update
 * rather than a purchase. `incomplete_expired` is a subscription that never
 * started and never will.
 *
 * `cancel_at_period_end` needs no entry: Stripe keeps such a subscription
 * `active` until the period actually ends and then sends `deleted`, so paying
 * through the end of a cancelled month falls out of this table for free.
 */
const SUBSCRIPTION_STATUS: Record<string, TenantRecord['status']> = {
  active: 'active',
  trialing: 'active',
  past_due: 'past_due',
  unpaid: 'past_due',
  incomplete: 'past_due',
  paused: 'past_due',
  incomplete_expired: 'canceled',
  canceled: 'canceled',
};

/**
 * The tenant status a subscription object implies.
 *
 * An UNKNOWN status becomes `past_due` rather than `active`: a status Stripe adds
 * later must not read as entitlement, and `past_due` is the failure that keeps
 * the tenant's data and is recoverable without a rebuild.
 */
function subscriptionStatus(subscription: Record<string, unknown>, event: StripeEvent): TenantRecord['status'] {
  const raw = asText(subscription['status'], 32);
  const mapped = raw ? SUBSCRIPTION_STATUS[raw] : undefined;
  if (mapped) return mapped;
  console.error(
    `Stripe event ${event.id} carries subscription status "${raw ?? 'none'}", which this worker ` +
      `does not know; treating it as past_due so it cannot read as entitlement.`,
  );
  return 'past_due';
}

/**
 * The tier a subscription grants, or null when it sells something that is not
 * ours.
 *
 * Two gates, in order. `billingKindForLookupKey` establishes that the price is on
 * the catalogue allowlist at all - the webhook meets a price inside an event
 * rather than through a lookup key it asked for, so this is where "is this
 * something we sell" gets answered. Then `tierForPrice` reads `metadata.tier` off
 * the price (requirement 7), with `TIERS` as the only authority on what that tier
 * may do.
 *
 * Null is a deliberate no-op rather than a default. Defaulting to starter would
 * charge somebody the Team price for Starter limits and leave a support ticket as
 * the only evidence.
 */
function subscriptionTier(subscription: Record<string, unknown>, event: StripeEvent): string | null {
  const items = asRecord(subscription['items'])?.['data'];
  const lines = Array.isArray(items) ? items : [];
  for (const line of lines) {
    const price = asRecord(asRecord(line)?.['price']);
    if (!price) continue;
    if (billingKindForLookupKey(price['lookup_key']) !== 'subscription') continue;
    const resolved = tierForPrice(price as StripePrice);
    // `tierForPrice` logs its own reason (missing or unknown metadata.tier).
    if (!('status' in resolved)) return resolved.tier;
  }
  console.error(
    `Stripe event ${event.id} (${event.type}) describes a subscription with no price on this ` +
      `deployment's billing allowlist, so there is no tier to grant and nothing was changed. ` +
      `Check the price's lookup_key and metadata.tier in Stripe.`,
  );
  return null;
}

/**
 * The ONE tenant state write every branch funnels through.
 *
 * `tier` and `status` are stated at every call site because they are the values
 * the candidate row carries, and both columns are `NOT NULL`. What differs
 * between call sites is which CLOCK comes with them, and that is the whole of the
 * ordering contract:
 *
 *   tierAt          only from an event that CARRIES A PRICE. An invoice and a
 *                   cancellation pass the tier they read back with no clock, so
 *                   the write is value-identical and cannot censor a later
 *                   delivery of the event that would have supplied a new one.
 *   statusAt        only from a `customer.subscription.*` event.
 *   dunningStatus   only from an `invoice.*` event, with `dunningAt`.
 *
 * Every other column is omitted-means-unchanged, which is what lets this write a
 * status without unmapping a customer or wiping a runtime key.
 *
 * A COLLIDING customer mapping is handled rather than fatal. The partial unique
 * index means a customer already mapped to a different tenant raises here, and
 * letting that escape would fail the delivery forever over a bookkeeping problem
 * only an operator can fix - while the tier and status in the same call, which
 * are the part the customer paid for, would never land. So the mapping is dropped
 * and the state is written without it.
 *
 * The OpenRouter runtime key is NOT reconciled here, one level up in
 * {@link applySubscriptionState} instead, and the distinction matters: the key has
 * to follow the tier the row ENDS UP with, which is not the tier this record
 * carries whenever the event is stale for that field. So the reconciliation reads
 * the row back after this write rather than trusting the candidate.
 */
async function writeSubscriptionState(
  store: TenantStore,
  record: {
    id: string;
    email?: string | null;
    tier: string;
    status: TenantRecord['status'];
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    billingEventAt: number;
    tierAt?: number;
    statusAt?: number;
    dunningStatus?: 'active' | 'past_due';
    dunningAt?: number;
  },
): Promise<void> {
  try {
    await store.upsertTenant(record);
    return;
  } catch (error) {
    if (!record.stripeCustomerId) throw error;
    console.error(
      `Could not map tenant ${record.id} to Stripe customer ${record.stripeCustomerId} ` +
        `(${describeError(error)}); writing the subscription state without the mapping. Merge or ` +
        `unmap the duplicate customer in Stripe.`,
    );
  }
  await store.upsertTenant({ ...record, stripeCustomerId: undefined });
}

/**
 * Applies a subscription object to a tenant: tier, status, and the two Stripe
 * identity columns. Shared by `checkout.session.completed` in subscription mode
 * (task 5.5) and by `customer.subscription.created`/`.updated` (task 5.6),
 * because "activate or upgrade" and "sync tier and status" are the same write.
 *
 * `resolution` is passed in rather than derived, so the checkout path keeps the
 * `client_reference_id` identity it already established - the only path that
 * works for a buyer with no tenant row and no customer mapping yet.
 */
async function applySubscriptionState(
  env: StripeWebhookEnv,
  store: TenantStore,
  event: StripeEvent,
  subscription: Record<string, unknown>,
  resolution: TenantResolution,
  email?: string | null,
): Promise<WebhookOutcome> {
  const tier = subscriptionTier(subscription, event);
  // Understood, deliberately changed nothing, and the reason is logged. See the
  // module header on why a payload defect answers 2xx. Checked BEFORE any
  // staleness question, because an event that sells something we do not offer
  // supplies no field at all and so has no clock to be measured against.
  if (!tier) return { status: 'applied', tenantId: resolution.tenantId };

  const tenant = resolution.tenant;
  // This event supplies BOTH a tier and a lifecycle status, so it is only stale
  // when both are already known from something newer.
  const stale = tenant
    ? isStaleForField(event, tenant.billingTierAt) &&
      isStaleForField(event, tenant.billingStatusAt)
    : false;

  // THE WRITE STILL HAPPENS WHEN THE EVENT IS STALE, and that is not a
  // contradiction. `upsertTenant` refuses each stale field on its own, so nothing
  // walks backwards; what the call still lands is the fields that carry no clock
  // and are fill-once - the buyer's EMAIL above all, which only a Checkout Session
  // ever supplies and which `COALESCE` writes exactly once. Skipping the write
  // instead is what used to lose that email whenever the checkout event happened
  // to arrive after a newer one.
  await writeSubscriptionState(store, {
    id: resolution.tenantId,
    email,
    tier,
    status: subscriptionStatus(subscription, event),
    stripeCustomerId:
      resolution.customerId ?? asId(subscription['customer'], STRIPE_CUSTOMER_ID) ?? undefined,
    stripeSubscriptionId: asId(subscription['id'], STRIPE_SUBSCRIPTION_ID) ?? undefined,
    billingEventAt: event.created,
    // An event with no usable `created` reads as 0 here, which routes both fields
    // to `upsertTenant`'s unordered branch: applied as stated, advancing nothing.
    tierAt: event.created,
    statusAt: event.created,
  });

  // ── The runtime key follows the tier (task 8.1, requirements 37, 38) ────────
  //
  // Read BACK rather than reconciled against `tier` above, because those two are
  // not the same value: `upsertTenant` refuses a stale tier, so a late event that
  // sells starter must not move a team tenant's spend cap down to $4. The row as
  // it now stands is the only tier the key should carry.
  //
  // Only for a tenant who is ENTITLED. A `canceled` or `past_due` row has already
  // had its key handled by the branch that put it there - re-limiting a cancelled
  // tenant's key would be defeating our own defence in depth, and minting one for
  // them would hand a live key to an account the gate refuses.
  //
  // `reconcileRuntimeKey` never throws, which is what keeps this off the delivery's
  // success path: an OpenRouter outage must not turn into an infinite Stripe retry
  // of a state write that already landed.
  const settled = await store.getTenant(resolution.tenantId);
  if (settled && settled.status === 'active') {
    const outcome = await reconcileRuntimeKey(env, store, settled);
    if (outcome.action === 'minted' || outcome.action === 'limit_updated') {
      console.log(
        `Tenant ${settled.id} is on tier ${settled.tier}; runtime key ${outcome.action} at a ` +
          `${outcome.limitUsd} USD limit` +
          (outcome.supersededKeyDisabled === false
            ? ', but the superseded key could NOT be disabled'
            : '') +
          `.`,
      );
    }
  }

  if (stale && tenant) return ignoredStale(event, tenant, tenant.billingStatusAt);
  return { status: 'applied', tenantId: resolution.tenantId };
}

// ── checkout.session.completed (task 5.5, requirements 10, 21) ───────────────

/**
 * A completed Checkout Session: a new or upgraded subscription, or a credit pack.
 *
 * The mode decides which, and it is read off the SESSION rather than guessed,
 * because the two do fundamentally different things - one writes subscription
 * state, the other writes an immutable grant row.
 *
 * This is the only event with a reliable path back to a FIRST-TIME buyer:
 * `customer.subscription.created` carries a bare customer id, so before this
 * event has run there may be no mapping for it to follow. That is why activation
 * lives here as well as on the subscription events.
 */
async function applyCheckoutSession(
  env: StripeWebhookEnv,
  store: TenantStore,
  event: StripeEvent,
): Promise<WebhookOutcome> {
  const session = event.object;
  const resolution = await resolveTenant(env, store, {
    clientReferenceId: session['client_reference_id'],
    customer: session['customer'],
  });
  if ('retry' in resolution) return resolution;
  if ('unresolved' in resolution) {
    return unresolved(event, `${resolution.unresolved} (a completed checkout)`, null);
  }

  const mode = asText(session['mode'], 32);
  if (mode === 'payment') {
    return applyTopUp(env, store, event, session, resolution.resolved);
  }
  if (mode !== 'subscription') {
    console.error(
      `Stripe event ${event.id} is a completed checkout in mode "${mode ?? 'none'}", which this ` +
        `worker does not sell; nothing was applied.`,
    );
    return { status: 'applied', tenantId: resolution.resolved.tenantId };
  }

  // The session names its subscription but does not carry it, and the tier lives
  // on the subscription's price - so the object is fetched and then goes through
  // exactly the same write as a `customer.subscription.*` event. Reading the
  // subscription rather than our own `metadata.lookup_key` is what keeps
  // requirement 7's "tier comes from metadata.tier on the price" true on this path
  // too.
  const subscriptionId = asId(session['subscription'], STRIPE_SUBSCRIPTION_ID);
  if (!subscriptionId) {
    console.error(
      `Stripe event ${event.id} is a completed subscription checkout with no usable subscription ` +
        `id; no plan was activated.`,
    );
    return { status: 'applied', tenantId: resolution.resolved.tenantId };
  }
  const fetched = await stripeRequest<Record<string, unknown>>(
    env,
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { method: 'GET' },
  );
  if ('status' in fetched) {
    // Worth a redelivery: the subscription exists, we just could not read it, and
    // the alternative is a paid customer left unactivated.
    return {
      retry: { status: 502, error: 'Could not read the new subscription from Stripe.' },
    };
  }

  return applySubscriptionState(
    env,
    store,
    event,
    fetched.data,
    resolution.resolved,
    // Only this path has an email to offer, and only for a row that may not exist
    // yet. `upsertTenant` COALESCEs it, so it fills a blank and never overwrites
    // one - which matters because an operator-set address on an existing tenant
    // should outlive whatever Checkout collected.
    checkoutEmail(session),
  );
}

/**
 * `checkout.session.async_payment_failed` - a delayed payment method that never
 * settled. Logged, recorded, and deliberately no state change.
 *
 * THE DECISION, AND WHY. Nothing was ever granted for this session: `applyTopUp`
 * refuses a `payment_status` that is not paid, so the failing half of a delayed
 * payment has no grant to reverse, no tier to walk back and no key to re-cap. The
 * money did not arrive, and the correct amount of work is none.
 *
 * It answers 2xx because a retry cannot change a settled fact, which is this
 * module's response policy in the ordinary case rather than an exception to it.
 *
 * It is NOT routed to {@link applyCheckoutSession}, and that is the part worth
 * being explicit about. That function branches on `mode`, and in `subscription`
 * mode it WRITES subscription state - so handing it a failed payment would activate
 * a plan nobody paid for. In `payment` mode it would also spend a Stripe round trip
 * reading line items in order to grant nothing. One shared handler for "the payment
 * happened" and "the payment did not" is a category error, not a saving.
 *
 * It does get a `stripe_events` row rather than falling through to the unhandled
 * `default`, because the pairing this completes - a `completed` event that granted
 * nothing followed by a terminal outcome - is precisely the support case where
 * "nothing happened" has to stay distinguishable from "never arrived". `applied`
 * here means handled, which is the same sense `applyTopUp` already uses when it
 * declines to grant on an unpaid session.
 *
 * The tenant is taken from `client_reference_id` when it is there, because
 * `/api/checkout` stamps it from a verified Clerk `sub` and reading it costs
 * nothing. No resolution is attempted beyond that: the fallback paths can cost a
 * Stripe customer read, which can fail, and asking Stripe to redeliver an event we
 * will never act on would be a non-2xx over nothing at all.
 */
function applyFailedAsyncPayment(event: StripeEvent): WebhookOutcome {
  const session = event.object;
  const sessionId = asId(session['id'], STRIPE_SESSION_ID);
  const referenced = asText(session['client_reference_id']);
  const tenantId = referenced && isClerkUserId(referenced) ? referenced : null;
  console.warn(
    `Stripe event ${event.id}: the delayed payment for checkout session ` +
      `${sessionId ?? 'unknown'}${tenantId ? ` (tenant ${tenantId})` : ''} FAILED with ` +
      `payment_status "${asText(session['payment_status'], 32) ?? 'none'}". Nothing was granted ` +
      `for it and nothing is being reversed, because nothing was ever granted.`,
  );
  return { status: 'applied', tenantId };
}

/** The buyer's email off a Checkout Session, for a tenant row that has none. */
function checkoutEmail(session: Record<string, unknown>): string | null {
  const details = asRecord(session['customer_details']);
  const email = asText(details?.['email'], EMAIL_MAX_CHARS);
  // Shape-checked only. This is a display and support field, never an identity -
  // the tenant is always the Clerk `sub`.
  return email && email.includes('@') ? email : null;
}

// ── Top-ups (task 5.5, requirements 21, 22) ─────────────────────────────────

/**
 * Writes the credit grant behind a one-off pack purchase.
 *
 * THE STALE-EVENT GUARD DELIBERATELY DOES NOT APPLY HERE, and that is not an
 * omission. Requirement 14 is about subscription state - a late `updated` must
 * not resurrect a superseded tier - whereas a grant is an immutable purchase with
 * its own idempotency key. Dropping one as "stale" because a plan change happened
 * to arrive first would mean taking money and granting nothing. For the same
 * reason a grant does not ADVANCE the watermark: a pack purchase says nothing
 * about plan ordering, and advancing it would make a legitimate later
 * subscription event look stale.
 *
 * Credits and their USD basis both come from the catalogue
 * ({@link topUpForPrice}), never from arithmetic here, so pack margin stays tied
 * to `TIERS.starter` (requirement 8) and the frozen `cost_usd` is the ratio that
 * was in force at purchase.
 *
 * Task 6.4 owns CONSUMPTION. This function only ever inserts.
 */
async function applyTopUp(
  env: StripeWebhookEnv,
  store: TenantStore,
  event: StripeEvent,
  session: Record<string, unknown>,
  resolution: TenantResolution,
): Promise<WebhookOutcome> {
  const paymentStatus = asText(session['payment_status'], 32);
  if (paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required') {
    // A delayed payment method: the session completed but the money has not
    // arrived, and `checkout.session.async_payment_succeeded` follows if it ever
    // does. Nothing is granted on a promise.
    console.warn(
      `Stripe event ${event.id} is a completed pack checkout with payment_status ` +
        `"${paymentStatus ?? 'none'}"; no credits granted until the payment settles.`,
    );
    return { status: 'applied', tenantId: resolution.tenantId };
  }

  // The PAYMENT identity, not the event id: one payment surfaces in several
  // events, and `credit_grants.stripe_payment_id` is what makes the grant happen
  // once across all of them. The session id is the fallback for a session that
  // completed without a PaymentIntent (a fully discounted pack).
  const paymentId =
    asId(session['payment_intent'], STRIPE_PAYMENT_ID) ?? asId(session['id'], STRIPE_PAYMENT_ID);
  if (!paymentId) {
    console.error(
      `Stripe event ${event.id} is a completed pack checkout with no usable payment or session ` +
        `id, so a grant could not be made idempotent; nothing was granted.`,
    );
    return { status: 'applied', tenantId: resolution.tenantId };
  }

  const sessionId = asId(session['id'], STRIPE_SESSION_ID);
  if (!sessionId) {
    console.error(`Stripe event ${event.id} is a checkout session with no usable id.`);
    return { status: 'applied', tenantId: resolution.tenantId };
  }
  const pack = await resolveTopUp(env, event, sessionId);
  if ('retry' in pack) return pack;
  if (pack.credits <= 0 || pack.costUsd <= 0) {
    // Every reason is already logged by the catalogue or by the loop below.
    return { status: 'applied', tenantId: resolution.tenantId };
  }

  const granted = await store.recordCreditGrant({
    tenantId: resolution.tenantId,
    stripePaymentId: paymentId,
    credits: pack.credits,
    costUsd: pack.costUsd,
  });
  if (granted) {
    console.log(
      `Granted ${pack.credits} credits ($${pack.costUsd.toFixed(2)} of inference budget) to ` +
        `tenant ${resolution.tenantId} for payment ${paymentId}.`,
    );
  } else {
    // Requirement 21 working, not a failure: a second event about the same money.
    console.log(
      `Payment ${paymentId} was already granted to tenant ${resolution.tenantId}; no second grant.`,
    );
  }

  // ── The key's cap has to learn about the pack (requirement 37, for a grant) ──
  //
  // The grant raises OUR ceiling (`effectiveCostUsdLimit`), but the tenant's
  // OpenRouter runtime key still carried the TIER allowance as its own `limit`, and
  // OpenRouter enforces that itself - so the overage the pack was bought to cover
  // was refused by the vendor. `reconcileRuntimeKey` computes the cap as allowance
  // plus unspent pool, so this one call moves it.
  //
  // Deliberately not conditional on `granted`. The patch is idempotent, and running
  // it on a REDELIVERY is what heals a patch that failed the first time - which is
  // the only self-healing this path gets, since the grant itself will never insert
  // again.
  //
  // Only an ACTIVE tenant, and that gate lives here rather than inside
  // `reconcileRuntimeKey`: the patch carries `disabled: false`, so reconciling a
  // cancelled or `past_due` tenant would put a retired key back into service.
  //
  // THE OUTCOME IS LOGGED AND DISCARDED, exactly as the subscription path does it.
  // `reconcileRuntimeKey` never throws, and returning a `retry` from here would be
  // the worst available answer: `recordCreditGrant` is idempotent on
  // `stripe_payment_id`, so a redelivery would grant nothing and fail again, forever,
  // over money that already landed - until Stripe disabled the endpoint for every
  // tenant. A cap that did not move costs a refused overage; a poisoned endpoint
  // costs the whole billing surface.
  const settled = await store.getTenant(resolution.tenantId);
  if (settled && settled.status === 'active') {
    const outcome = await reconcileRuntimeKey(env, store, settled);
    if (outcome.action === 'minted' || outcome.action === 'limit_updated') {
      console.log(
        `Tenant ${settled.id} bought credits; runtime key ${outcome.action} at a ` +
          `${outcome.limitUsd} USD limit (tier allowance plus their unspent grants).`,
      );
    } else {
      console.error(
        `Tenant ${settled.id} bought credits but their OpenRouter runtime key could not be ` +
          `re-capped to ${outcome.limitUsd} USD (${outcome.action}). They are entitled to the ` +
          `overage and the vendor will refuse it until the next reconciliation.`,
      );
    }
  }
  return { status: 'applied', tenantId: resolution.tenantId };
}

/**
 * Totals the credits a completed session actually bought.
 *
 * The session event carries no line items, so they are read back from Stripe -
 * which is also what puts the real PRICE object in reach, and the price is the
 * only place `metadata.credits` lives. Deriving credits from our own
 * `metadata.lookup_key` instead would make the session's copy of the catalogue
 * authoritative over Stripe's.
 *
 * Every line is gated on the allowlist before it grants anything: a price that is
 * not one of ours is skipped rather than trusted, so a session assembled outside
 * `/api/checkout` cannot mint credits. Quantity is honoured (and bounded), because
 * ignoring it would take money for two packs and grant one.
 */
async function resolveTopUp(
  env: StripeWebhookEnv,
  event: StripeEvent,
  sessionId: string,
): Promise<{ credits: number; costUsd: number } | { retry: { status: number; error: string } }> {
  const list = await stripeRequest<{ data?: unknown }>(
    env,
    `/checkout/sessions/${encodeURIComponent(sessionId)}/line_items`,
    { method: 'GET', params: { limit: 100 } },
  );
  if ('status' in list) {
    // The customer has paid. A redelivery is the right answer, not a grant of
    // whatever we managed to read.
    return { retry: { status: 502, error: 'Could not read the purchased line items from Stripe.' } };
  }

  const lines = Array.isArray(list.data.data) ? list.data.data : [];
  let credits = 0;
  let costUsd = 0;
  for (const line of lines) {
    const item = asRecord(line);
    const price = asRecord(item?.['price']);
    if (!price) {
      console.error(
        `Stripe event ${event.id}: a purchased line item carries no price object, so its credits ` +
          `could not be resolved.`,
      );
      continue;
    }
    if (billingKindForLookupKey(price['lookup_key']) !== 'topup') {
      console.warn(
        `Stripe event ${event.id}: a purchased line item is not a catalogue credit pack; it ` +
          `grants nothing.`,
      );
      continue;
    }
    const pack = topUpForPrice(price as StripePrice);
    // `topUpForPrice` logs the specific misconfiguration (missing, non-numeric or
    // implausibly generous `metadata.credits`).
    if ('status' in pack) continue;

    const quantity = Number(item?.['quantity']);
    const units =
      Number.isInteger(quantity) && quantity >= 1 && quantity <= MAX_LINE_ITEM_QUANTITY
        ? quantity
        : 1;
    if (units !== quantity && quantity !== 1) {
      console.warn(
        `Stripe event ${event.id}: line item quantity ${String(item?.['quantity'])} is outside ` +
          `1-${MAX_LINE_ITEM_QUANTITY}; granting one unit.`,
      );
    }
    credits += pack.credits * units;
    costUsd += pack.costUsd * units;
  }

  if (credits <= 0) {
    console.error(
      `Stripe event ${event.id} is a completed pack checkout that resolved to no grantable ` +
        `credits; the buyer has paid and received nothing. Check the price metadata in Stripe.`,
    );
  }
  return { credits, costUsd };
}

// ── customer.subscription.created / .updated (task 5.6) ─────────────────────

/**
 * Syncs tier and status from a subscription event (requirements 10, 14).
 *
 * Resolution has no `client_reference_id` to work with here - the payload names a
 * bare customer - so it leans on the customer's metadata and then the stored
 * mapping. A row is CREATED when none exists, which is what makes this path a
 * safety net for a checkout event that was lost or is still in flight: the
 * subscription carries its own price, so the tier is never invented.
 */
async function applySubscriptionEvent(
  env: StripeWebhookEnv,
  store: TenantStore,
  event: StripeEvent,
  subscription: Record<string, unknown>,
): Promise<WebhookOutcome> {
  const resolution = await resolveTenant(env, store, { customer: subscription['customer'] });
  if ('retry' in resolution) return resolution;
  if ('unresolved' in resolution) {
    return unresolved(event, `${resolution.unresolved} (a subscription change)`, null);
  }
  return applySubscriptionState(env, store, event, subscription, resolution.resolved);
}

// ── customer.subscription.deleted (task 5.8, requirement 16) ────────────────

/**
 * Cancels a tenant and takes their runtime key out of service.
 *
 * The status write happens FIRST and the key disable second, deliberately. The
 * status is what the inference gate reads, so it is the change that actually
 * stops spending, and it is a local durable write that cannot fail on a vendor
 * being down. Disabling the key is defence in depth for exactly the case where our
 * gate is bypassed.
 *
 * A tenant with no row is `unresolved` rather than a silent success: there is
 * nothing to cancel and, more importantly, no `openrouter_key_id` to disable, so
 * a live key could be sitting somewhere this worker cannot see.
 */
async function applySubscriptionDeleted(
  env: StripeWebhookEnv,
  store: TenantStore,
  event: StripeEvent,
): Promise<WebhookOutcome> {
  const subscription = event.object;
  const resolution = await resolveTenant(env, store, { customer: subscription['customer'] });
  if ('retry' in resolution) return resolution;
  if ('unresolved' in resolution) {
    return unresolved(event, `${resolution.unresolved} (a cancellation)`, null);
  }

  const { tenantId, tenant, customerId } = resolution.resolved;
  if (!tenant) {
    return unresolved(
      event,
      `tenant ${tenantId} has no row in this deployment, so there is no subscription to cancel ` +
        `and no runtime key to disable`,
      tenantId,
    );
  }
  // Measured against the LIFECYCLE clock only, which is what lets a cancellation
  // overrule an invoice that carries a higher timestamp while still losing to a
  // genuine later resubscription. Skipped rather than written because this branch
  // has a side effect that is not a column: a stale cancellation must not disable
  // the runtime key of a tenant who has since resubscribed.
  if (isStaleForField(event, tenant.billingStatusAt)) {
    return ignoredStale(event, tenant, tenant.billingStatusAt);
  }

  await writeSubscriptionState(store, {
    // Requirement 18's counterpart: the tier is RESTATED, not cleared. A
    // cancelled tenant keeps their history and their plan on record, and the
    // candidate row needs a non-null tier either way. NO `tierAt` goes with it -
    // a cancellation carries no price, so it must not claim the tier clock and
    // censor a `subscription.updated` still in flight.
    tier: tenant.tier,
    id: tenant.id,
    status: 'canceled',
    stripeCustomerId: customerId ?? undefined,
    stripeSubscriptionId: asId(subscription['id'], STRIPE_SUBSCRIPTION_ID) ?? undefined,
    billingEventAt: event.created,
    statusAt: event.created,
  });

  // Reported, never thrown, and it does not change the outcome: the status write
  // above is what stops the spending, and a cancellation must land even when
  // OpenRouter is down. Requirement 39 lives in `disableTenantRuntimeKey`, which
  // logs the failure as an error so a leaked key is discoverable.
  await disableTenantRuntimeKey(env, tenant, 'cancelled');
  return { status: 'applied', tenantId: tenant.id };
}

// ── Invoice dunning (task 5.7, requirement 15) ──────────────────────────────

/**
 * Moves a tenant between `past_due` and `active` as invoices fail and succeed -
 * the first time dunning has had any behaviour at all.
 *
 * Both directions share this function because they are the same write with a
 * different target status, and because the SUBSCRIPTION LINK check has to happen
 * identically for both: a one-off pack invoice (we enable `invoice_creation` on
 * payment-mode sessions) must never move plan status, and its failure says nothing
 * about the subscription.
 *
 * A missing tenant row is `unresolved` rather than a create. There is no tier to
 * state - the invoice does not carry one - and `upsertTenant` overwrites tier
 * unconditionally, so inventing one would show a plan nobody bought.
 *
 * Restoring `active` from `canceled` is refused. A cancellation is authoritative
 * and a stray successful invoice on a cancelled subscription must not reactivate
 * an account; only the dunning state it was meant for is recoverable this way.
 * The refusal is enforced by the fold in `upsertTenant`, not by this function
 * reading `tenant.status` and returning early - because "what the row says right
 * now" depends on delivery order, and deciding on it made a cancelled tenant read
 * `active` whenever a paid invoice happened to land first.
 */
async function applyInvoiceOutcome(
  env: StripeWebhookEnv,
  store: TenantStore,
  event: StripeEvent,
  target: 'past_due' | 'active',
): Promise<WebhookOutcome> {
  const invoice = event.object;
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    // Checked BEFORE resolution so a pack invoice costs no Stripe round trip.
    console.log(
      `Stripe event ${event.id} (${event.type}) is not attached to a subscription, so it does ` +
        `not change plan status.`,
    );
    return { status: 'applied', tenantId: null };
  }

  const resolution = await resolveTenant(env, store, { customer: invoice['customer'] });
  if ('retry' in resolution) return resolution;
  if ('unresolved' in resolution) {
    return unresolved(event, `${resolution.unresolved} (an invoice ${target} transition)`, null);
  }

  const { tenantId, tenant, customerId } = resolution.resolved;
  if (!tenant) {
    return unresolved(
      event,
      `tenant ${tenantId} has no row in this deployment, and an invoice carries no tier to ` +
        `create one with`,
      tenantId,
    );
  }
  // An invoice supplies exactly ONE field - the dunning half of `status` - so the
  // dunning clock is the only one it can be stale against. It is emphatically NOT
  // measured against the lifecycle clock: an `invoice.payment_failed` a second
  // after a `subscription.updated` is newer information about a different fact,
  // and the two used to share one watermark, which is how a dunning event that
  // arrived first came to censor the upgrade behind it.
  if (isStaleForField(event, tenant.billingDunningAt)) {
    return ignoredStale(event, tenant, tenant.billingDunningAt);
  }

  if (target === 'active' && tenant.status === 'canceled') {
    // Logged here, ENFORCED in the fold: `upsertTenant` refuses to move a
    // cancelled tenant off `canceled` on a dunning write whatever the timestamps
    // say. The register is still recorded rather than dropped, because dropping it
    // would make the stored state depend on whether the cancellation happened to
    // arrive first - which is the same order-dependence in a smaller place.
    console.warn(
      `Stripe event ${event.id} reports a paid subscription invoice for tenant ${tenant.id}, who ` +
        `is cancelled; NOT reactivating. A cancellation is only undone by a new subscription.`,
    );
  }

  const ordered = event.created > 0;
  await writeSubscriptionState(store, {
    id: tenant.id,
    // Restated, not changed, and with NO `tierAt`: requirement 18 keeps a
    // `past_due` tenant's tier, data and runtime key so recovering is a payment
    // rather than a rebuild - and an invoice knows no tier, so it must not claim
    // the tier clock. The value is the one just read, so the column is written
    // back identical to itself.
    tier: tenant.tier,
    // The candidate row's status, and for an unorderable event (no usable
    // `created`, hence no clock to gate on) the effective status itself. That
    // preserves what this handler has always done with such an event: apply it,
    // advance nothing.
    status: ordered ? tenant.status : target,
    dunningStatus: ordered ? target : undefined,
    dunningAt: ordered ? event.created : undefined,
    stripeCustomerId: customerId ?? undefined,
    stripeSubscriptionId: subscriptionId,
    billingEventAt: event.created,
  });
  // The REPORTED transition, not the resulting column: the fold can legitimately
  // keep `canceled`, or prefer a newer lifecycle status, and reading the row back
  // to narrate that would cost a D1 round trip on every dunning event.
  console.log(
    `Stripe event ${event.type} (${event.id}) reported ${target} for tenant ${tenant.id}, who ` +
      `was ${tenant.status}.`,
  );
  return { status: 'applied', tenantId: tenant.id };
}

/**
 * The subscription an invoice belongs to, across both Stripe API shapes.
 *
 * `invoice.subscription` moved to `invoice.parent.subscription_details.subscription`
 * in `2025-03-31.basil`, and this worker pins a version well past that - but the
 * SIGNING version of a delivery follows the ENDPOINT, which the Dashboard can pin
 * independently, so an older-shaped event is a configuration away rather than
 * impossible. Reading both is three lines and removes the whole failure mode,
 * which would otherwise present as dunning that silently never fires.
 */
function invoiceSubscriptionId(invoice: Record<string, unknown>): string | null {
  const legacy = asId(invoice['subscription'], STRIPE_SUBSCRIPTION_ID);
  if (legacy) return legacy;
  const details = asRecord(asRecord(invoice['parent'])?.['subscription_details']);
  return asId(details?.['subscription'], STRIPE_SUBSCRIPTION_ID);
}
