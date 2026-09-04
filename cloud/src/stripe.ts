/**
 * Stripe REST access for the billing routes - plain `fetch`, no SDK.
 *
 * Three reasons the SDK stays out (spec `.kiro/specs/stripe-billing/design.md`):
 * `cloud/` already carries `agents` plus `ai` and does not need another large
 * dependency in the bundle; the whole integration is four calls (customer
 * create, customer search, checkout session create, billing portal session
 * create), all trivially form-encoded; and the one place hand-rolling WOULD be
 * a risk - comparing a webhook signature - is `crypto.subtle.verify`, which is
 * constant-time by construction. So the SDK would buy convenience we do not
 * need and cost bundle size we do.
 *
 * What lives here is therefore small and deliberately dull:
 *
 *  - {@link encodeStripeForm} - Stripe's bracket form encoding. The API is
 *    `application/x-www-form-urlencoded` only, so nested parameters travel as
 *    `a[b]=c` and lists as `items[0][price]=x`. Getting this wrong is the single
 *    most likely way a hand-rolled Stripe client breaks, which is why it is a
 *    separate exported function with its own tests rather than string
 *    concatenation at four call sites.
 *  - {@link requireStripeSecret} - the requirement 34 gate: a billing route on a
 *    worker with no Stripe configuration answers **501 naming the missing
 *    secret**, not an opaque 500 and not a crash. A BYO worker binds no Stripe
 *    secrets at all and must stay healthy.
 *  - {@link stripeRequest} - one request path, so no caller can forget the
 *    secret check, the content type, or the API version pin.
 *  - {@link BILLING_LOOKUP_KEYS} and {@link resolveCataloguePrice} - the
 *    catalogue (requirements 5-8). The allowlist is the security boundary for
 *    `/api/checkout`: a client sends a lookup KEY and never a price id, so the
 *    set of things anyone can buy is this literal table rather than "whatever
 *    price id they typed". Tier comes off the price's `metadata.tier`, not the
 *    key string, and `TIERS` in `tenants.ts` stays the only authority on what a
 *    tier may do.
 *  - {@link verifyStripeSignature} - the webhook's front door (requirement 11).
 *    Stripe authenticates itself with an HMAC over the raw body and nothing
 *    else, so this function is the ENTIRE authorization story for
 *    `POST /api/stripe/webhook`. It returns a plain boolean and logs its own
 *    reason, which is what keeps the route's guard impossible to get subtly
 *    wrong.
 *
 * Refusals use the same `{ status, error }` shape as `resolveHostedInference` in
 * `tenants.ts`, so a route reads identically to the ones already there:
 *
 * ```ts
 * const session = await stripeRequest<{ url: string }>(env, '/checkout/sessions', { params });
 * if ('status' in session) return respond({ error: session.error }, session.status);
 * return respond({ url: session.data.url });
 * ```
 *
 * Secrets are read from Worker secrets only and never leave the worker
 * (requirement 33). Nothing here returns a key, echoes one into an error, or
 * logs one.
 */

import { WORKER_BUILD } from './build-info';
// The import edge runs ONE WAY, stripe -> tenants, and must stay that way:
// `tenants.ts` owns `TIERS` and every credits<->USD conversion derived from it,
// this module is the vendor adapter that reads a Stripe price and asks whether
// what it found is something we actually sell. A future `import { ... } from
// './stripe'` inside `tenants.ts` would close a module cycle around two consts
// that are evaluated at load time, so a grant helper belongs THERE and a Stripe
// shape belongs here.
import { grantCostUsd, isKnownTier } from './tenants';

// ── Environment ──────────────────────────────────────────────────────────────

/**
 * The two Stripe secrets. Both OPTIONAL, and that is the whole point: a BYO
 * deployment binds neither, so every field here is absent on the majority of
 * workers running this code and the absence has to be an ordinary, handled state
 * rather than an exception.
 *
 * Folded into `ApiEnv` (`api.ts`), so this interface is the ONE description of
 * the worker's Stripe configuration and no route restates a field. The deployed
 * names are documented in the `wrangler.jsonc` secret header and the local ones
 * in `.dev.vars.example`; nothing checks that pair automatically, so a third
 * secret goes in all three places by hand.
 */
export interface StripeEnv {
  /**
   * Stripe API secret key (`sk_live_*` deployed, `sk_test_*` for a sandbox).
   * Authenticates every call in this module.
   */
  STRIPE_SECRET_KEY?: string;
  /**
   * Webhook endpoint signing secret (`whsec_*`). Used only by the signature
   * verification in task 3.2, and declared here so ONE interface describes the
   * worker's Stripe configuration.
   *
   * Note it is per ENDPOINT, not per account: the Stripe CLI's
   * `stripe listen --forward-to` prints a different `whsec_` than a
   * Dashboard-created endpoint, so a local run and the deployed worker never
   * share this value.
   */
  STRIPE_WEBHOOK_SECRET?: string;
}

/** The secret names this module can report as missing. */
export type StripeSecretName = keyof StripeEnv;

// ── Results ──────────────────────────────────────────────────────────────────

/**
 * A refusal a route can return verbatim. Deliberately the same shape
 * `resolveHostedInference` returns, so `'status' in result` is the discriminator
 * everywhere in the control plane and no route needs a bespoke branch.
 */
export interface StripeRefusal {
  status: number;
  error: string;
}

/** Either the parsed Stripe object, or a refusal to hand straight back. */
export type StripeResult<T> = { data: T } | StripeRefusal;

// ── Form encoding ────────────────────────────────────────────────────────────

/**
 * A value Stripe's form encoding can carry. Recursive: objects nest, lists index.
 *
 * Mutable arrays rather than `readonly` ones on purpose - `Array.isArray` does
 * not narrow a `ReadonlyArray` union member, and the encoder's shape is much
 * easier to trust than a cast would be.
 */
export type StripeParamValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | StripeParams
  | StripeParamValue[];

/** A Stripe request parameter tree. */
export interface StripeParams {
  [key: string]: StripeParamValue;
}

/**
 * Encodes a parameter tree the way the Stripe API expects it:
 * `application/x-www-form-urlencoded` with bracketed paths.
 *
 * ```
 * { metadata: { tier: 'pro' } }                  -> metadata[tier]=pro
 * { line_items: [{ price: 'price_1', quantity: 1 }] }
 *                                                -> line_items[0][price]=price_1
 *                                                   &line_items[0][quantity]=1
 * { expand: ['customer'] }                       -> expand[0]=customer
 * { automatic_tax: { enabled: true } }           -> automatic_tax[enabled]=true
 * ```
 *
 * Rules worth knowing before you pass something unusual:
 *
 *  - `undefined` is SKIPPED. That is what lets a call site write an optional
 *    parameter inline (`customer: existingId ?? undefined`) instead of building
 *    the object conditionally.
 *  - `null` is encoded as an EMPTY VALUE (`key=`), which is how Stripe clears a
 *    field. The asymmetry with `undefined` is deliberate: one means "say
 *    nothing", the other means "say nothing is there".
 *  - An empty object or list contributes NOTHING, because bracket encoding has
 *    no representation for one.
 *  - Booleans and numbers are stringified. A non-finite number THROWS rather
 *    than sending `amount=NaN`, naming the parameter path: that is a bug in our
 *    own call site, and Stripe would otherwise answer with a generic 400 that
 *    says nothing about which field caused it.
 *
 * Keys and values are percent-encoded with `encodeURIComponent`, brackets
 * included (`a%5Bb%5D=c`). That escapes every character with meaning in this
 * format - `&`, `=`, `+`, `%` and space - so a value can never forge a
 * parameter. It leaves a few sub-delimiters (`!'()*`) literal where the official
 * SDKs' encoder escapes them; both decode to identical bytes, and Stripe's
 * customer search syntax is the one place it shows
 * (`query=metadata%5B'clerk_user_id'%5D%3A'user_1'`).
 */
export function encodeStripeForm(params: StripeParams): string {
  const pairs: string[] = [];
  appendParam(pairs, '', params);
  return pairs.join('&');
}

function appendParam(pairs: string[], path: string, value: StripeParamValue): void {
  if (value === undefined) return;
  if (value === null) {
    pairs.push(`${encodeURIComponent(path)}=`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendParam(pairs, `${path}[${index}]`, item));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      // The top-level call arrives with an empty path, so the first level of
      // keys is bare and every level below it is bracketed.
      appendParam(pairs, path ? `${path}[${key}]` : key, inner);
    }
    return;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`Stripe parameter "${path}" is not a finite number.`);
  }
  pairs.push(`${encodeURIComponent(path)}=${encodeURIComponent(String(value))}`);
}

// ── Secrets ──────────────────────────────────────────────────────────────────

/**
 * Resolves one Stripe secret, or the requirement 34 refusal naming it.
 *
 * A blank or whitespace-only value counts as ABSENT. `wrangler secret put` with
 * an accidental empty line stores an empty string, and treating that as
 * configured would send `Authorization: Bearer ` to Stripe and turn a
 * configuration mistake into a 502 that blames the vendor.
 *
 * The message follows the `KEY_ENC_SECRET` precedent in
 * `/api/connection-secrets`: name the secret, give the command that sets it, say
 * a redeploy is needed. The audience is whoever operates the worker - a paying
 * user cannot fix this - so it is written for them rather than softened.
 */
export function requireStripeSecret(
  env: StripeEnv,
  name: StripeSecretName,
): { secret: string } | StripeRefusal {
  const secret = env[name]?.trim();
  if (!secret) {
    return {
      // 501 Not Implemented, not 500: the route is unconfigured, not broken, and
      // the distinction is what keeps a Stripe-less BYO worker healthy instead
      // of looking like it is failing.
      status: 501,
      error:
        `Billing is not configured on this deployment: ${name} is not set. Run ` +
        `\`npx wrangler secret put ${name} --env hosted\`, redeploy, and try again.`,
    };
  }
  return { secret };
}

// ── Requests ─────────────────────────────────────────────────────────────────

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

/**
 * Pinned API version, sent on every call. Without the header Stripe applies the
 * ACCOUNT's default version, so upgrading the account in the Dashboard would
 * silently change what this worker receives - a deploy-free behaviour change,
 * which is the kind of thing that breaks on a weekend. Pinning moves that to a
 * code change with a review.
 *
 * Bump deliberately: read the changelog, then update this constant.
 */
const STRIPE_API_VERSION = '2026-08-26.dahlia';

/**
 * Cloudflare's `fetch` sends no `User-Agent` at all, which leaves Stripe's
 * request log blank about who called. Naming the worker and its build is what
 * makes a Dashboard log line traceable to a release.
 */
const STRIPE_USER_AGENT = `PhormaAgentStudio/${WORKER_BUILD} (+https://phorma-labs.com)`;

export interface StripeRequestInit {
  /**
   * Defaults to `POST`, since every write is one. `GET` moves `params` into the
   * query string (customer search is the one read we make).
   */
  method?: 'GET' | 'POST';
  params?: StripeParams;
  /**
   * Stripe's `Idempotency-Key`. Worth setting on anything that CREATES: without
   * it a retried customer create leaves two customers behind, which requirement
   * 4 exists to prevent.
   */
  idempotencyKey?: string;
}

/**
 * One call against the Stripe REST API.
 *
 * `path` is relative to `/v1` (`'/checkout/sessions'`). Returns the parsed
 * object, or a refusal the route can return unchanged.
 *
 * Two decisions in here are load-bearing:
 *
 * **The secret check happens before the network call**, so an unconfigured
 * worker answers 501 (requirement 34) rather than firing an unauthenticated
 * request and reporting whatever Stripe says about it.
 *
 * **Stripe's status is never mirrored onto our response.** Every upstream
 * failure becomes a 502, because the two status spaces mean different things and
 * copying the number across actively misleads: a Stripe 401 means OUR secret key
 * is wrong, and forwarding it would make the studio think the user's session
 * expired and send them to sign in again. Stripe's 404 means our lookup key is
 * missing, not that the studio called a route that does not exist. The detail
 * that DOES travel back is Stripe's machine-readable `code`/`type` token and
 * nothing else - vendor prose stays in the log, following the same rule the
 * status probes follow.
 */
export async function stripeRequest<T>(
  env: StripeEnv,
  path: string,
  init: StripeRequestInit = {},
): Promise<StripeResult<T>> {
  const key = requireStripeSecret(env, 'STRIPE_SECRET_KEY');
  if ('status' in key) return key;

  const method = init.method ?? 'POST';
  const encoded = init.params ? encodeStripeForm(init.params) : '';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key.secret}`,
    'Stripe-Version': STRIPE_API_VERSION,
    'User-Agent': STRIPE_USER_AGENT,
  };
  if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(
      `${STRIPE_API_BASE}${path}${method === 'GET' && encoded ? `?${encoded}` : ''}`,
      { method, headers, body: method === 'POST' ? encoded : undefined },
    );
  } catch (error) {
    // A Stripe outage or a DNS blip. Caught rather than left to throw, so it
    // reads as an upstream problem instead of arriving as the generic
    // "Unhandled /api error" 500 that `handleApiRequest` produces.
    console.error(
      `Stripe ${method} ${path} did not complete: ${redact(
        error instanceof Error ? error.message : String(error),
        key.secret,
      )}`,
    );
    return { status: 502, error: 'Could not reach Stripe. Try again in a moment.' };
  }

  const text = await response.text().catch(() => '');
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const code = stripeErrorCode(parsed);
    console.error(
      `Stripe ${method} ${path} failed (${response.status}): ` +
        redact(stripeErrorMessage(parsed) || text.slice(0, 200), key.secret),
    );
    return {
      status: 502,
      error: `Stripe rejected the request${code ? ` (${code})` : ''}. Please try again.`,
    };
  }

  if (parsed === null || typeof parsed !== 'object') {
    console.error(`Stripe ${method} ${path} returned an unreadable body.`);
    return { status: 502, error: 'Stripe returned an unreadable response.' };
  }

  return { data: parsed as T };
}

/**
 * Stripe's stable machine token for a failure (`resource_missing`,
 * `api_key_expired`, ...), falling back to the error `type`.
 *
 * Validated against a token shape before it is returned, because this is the one
 * string in this module that crosses from a vendor response into OUR response
 * body: a `code` is documented as a snake_case enum, so anything else is not a
 * code and does not travel.
 */
function stripeErrorCode(parsed: unknown): string | null {
  const error = (parsed as { error?: { code?: unknown; type?: unknown } } | null)?.error;
  for (const candidate of [error?.code, error?.type]) {
    if (typeof candidate === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(candidate)) return candidate;
  }
  return null;
}

/** Stripe's human-readable failure message - for the LOG only, never the response. */
function stripeErrorMessage(parsed: unknown): string {
  const message = (parsed as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === 'string' ? message.slice(0, 200) : '';
}

/**
 * Strips the API key out of anything on its way to a log line.
 *
 * Not paranoia: Stripe's own error prose QUOTES THE KEY BACK at you - an expired
 * or malformed key answers with `Expired API Key provided: sk_test_...`. Stripe
 * masks the middle of it in that message, but the guarantee that a secret never
 * leaves the worker (requirement 33) must not rest on a vendor's masking, and
 * `observability` is enabled on this worker so a log line is durable and
 * readable in the Dashboard. One `split`/`join` makes the guarantee
 * unconditional, and it costs nothing on the overwhelmingly common path where
 * the key does not appear at all.
 */
function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}

// ── Catalogue ────────────────────────────────────────────────────────────────

/**
 * What a catalogue entry sells. Decides the Checkout Session `mode`
 * (`subscription` vs `payment`) and which half of the resolution below runs.
 */
export type BillingProductKind = 'subscription' | 'topup';

/**
 * THE ALLOWLIST (requirement 6). Every lookup key this deployment will check
 * out, and nothing else.
 *
 * This table, not `/api/checkout`'s body validation, is what stops a caller
 * buying a price of their choosing. The route accepts a lookup KEY and never a
 * price id (requirement 5), so the worst a malicious client can do is name one
 * of these six strings. Without it, `/api/checkout` would be a "charge me for
 * any price id in the account" endpoint - including a $0 test price, an archived
 * one, or a price belonging to a different product entirely.
 *
 * Lookup keys rather than price ids for a second reason: sandbox and live ids
 * differ, so a hardcoded id is a value that MUST change between modes and will
 * therefore be wrong in one of them. A lookup key is the only identifier stable
 * across both, which is also why the live catalogue is mirrored BY lookup key
 * (task 9.5).
 *
 * A key maps to a KIND, never to a tier. Requirement 7 puts tier resolution on
 * the price's own `metadata.tier`, so annual pricing is purely additive: one
 * more entry here, no tier mapping to keep in sync, no schema and no route
 * change. Encoding "starter" in this table instead would quietly make the key
 * string a second source of truth about tiers, and the first divergence would be
 * a tenant on the wrong plan.
 *
 * The three `phorma_topup_*` keys are listed BEFORE task 9.1 creates them in
 * Stripe, on purpose. An allowlisted key with no active price resolves to the
 * "not configured" refusal below, which is the honest description of that state
 * and is exactly what a premature studio release would hit.
 *
 * A `Map`, not an object literal, because the key comes from a request body:
 * `record['constructor']` is a truthy inherited value while `map.get(...)` is
 * `undefined`, so the prototype hazard is gone by construction rather than by a
 * `hasOwnProperty` call somebody could forget at a new call site.
 */
export const BILLING_LOOKUP_KEYS: ReadonlyMap<string, BillingProductKind> = new Map<
  string,
  BillingProductKind
>([
  ['phorma_starter_monthly', 'subscription'],
  ['phorma_pro_monthly', 'subscription'],
  ['phorma_team_monthly', 'subscription'],
  ['phorma_topup_small', 'topup'],
  ['phorma_topup_medium', 'topup'],
  ['phorma_topup_large', 'topup'],
]);

/** An allowlisted lookup key and what it sells. */
export interface BillingCatalogueEntry {
  lookupKey: string;
  kind: BillingProductKind;
}

/**
 * The kind an allowlisted lookup key sells, or `null` for anything else -
 * including a non-string, which is what a JSON body can hand over.
 *
 * Exported for the webhook, which meets a price inside an event rather than
 * through a lookup key it asked for, and still has to establish that the price
 * is one of ours before it writes tier or grants credits.
 */
export function billingKindForLookupKey(lookupKey: unknown): BillingProductKind | null {
  if (typeof lookupKey !== 'string') return null;
  return BILLING_LOOKUP_KEYS.get(lookupKey) ?? null;
}

/**
 * The requirement 6 gate: an allowlisted entry, or a 400 to return as-is.
 *
 * 400 rather than 404, because the caller named something that is not on offer -
 * the route exists and is working. The message stays generic and the offending
 * value goes to the log instead of the response body: it is client-supplied, and
 * this is the one place in the billing surface where a caller controls a string
 * that could otherwise be reflected back to another surface.
 *
 * Note what the return value buys everything downstream: once a key is past this
 * function it is one of the six literals above, so later refusals can safely
 * name it (`lookupKey`) without echoing untrusted input.
 */
export function requireAllowedLookupKey(
  lookupKey: unknown,
): { entry: BillingCatalogueEntry } | StripeRefusal {
  // The lookup is inlined rather than routed through
  // `billingKindForLookupKey` so the string narrowing survives to the return: a
  // cast here would be a cast on the value that decides what somebody is
  // charged for.
  if (typeof lookupKey === 'string') {
    const kind = BILLING_LOOKUP_KEYS.get(lookupKey);
    if (kind) return { entry: { lookupKey, kind } };
  }
  console.warn(
    `Checkout refused: ${
      typeof lookupKey === 'string'
        ? `lookup key "${lookupKey.slice(0, 80)}" is not on the billing allowlist`
        : `no lookup key was supplied (received ${typeof lookupKey})`
    }.`,
  );
  return { status: 400, error: 'Unknown product.' };
}

/**
 * The fields this worker reads off a Stripe Price.
 *
 * `metadata` values are `unknown` rather than `string`, which is the one place
 * this interface deliberately declares LESS than Stripe documents. Everything
 * else here is a field Stripe controls and types; metadata is a field an
 * OPERATOR types into a Dashboard form, arriving through `JSON.parse`, and the
 * two things it decides are which tier a subscription grants and how many
 * credits a purchase is worth. Typing it `unknown` makes the `typeof` checks
 * below provably load-bearing instead of defensive noise a reader would delete.
 */
export interface StripePrice {
  id?: string | null;
  active?: boolean | null;
  /** `recurring` for a plan price, `one_time` for a credit pack. */
  type?: string | null;
  lookup_key?: string | null;
  /** ISO 4217, lowercase. `usd` today; see task 9.2b. */
  currency?: string | null;
  /** Smallest currency unit, so `2000` is $20.00. */
  unit_amount?: number | null;
  /** `inclusive` for every price in this catalogue (requirement 46). */
  tax_behavior?: string | null;
  recurring?: { interval?: string | null } | null;
  metadata?: Record<string, unknown> | null;
}

/** A price resolved against the catalogue, ready for a Checkout Session. */
export type ResolvedCataloguePrice =
  | {
      kind: 'subscription';
      lookupKey: string;
      priceId: string;
      /** Checkout Session `mode`. */
      mode: 'subscription';
      /** A tier `TIERS` declares - never a guess, never a default. */
      tier: string;
    }
  | {
      kind: 'topup';
      lookupKey: string;
      priceId: string;
      mode: 'payment';
      /** What the buyer is shown, straight from `metadata.credits`. */
      credits: number;
      /** The real budget it buys, derived from the starter ratio. */
      costUsd: number;
    };

/**
 * A Stripe price id. Bounds the SHAPE rather than modelling Stripe's id
 * alphabet: object ids are documented as opaque, so the job here is to refuse
 * prose, markup or an empty string before it is handed to a Checkout Session,
 * not to be strict enough to reject a real price over an undocumented character.
 */
const STRIPE_PRICE_ID = /^price_[A-Za-z0-9_-]{1,255}$/;

/**
 * A credit count as `metadata.credits` may spell it. Digits only, so `"1e4"`,
 * `"2,500"`, `"500.5"` and `"0x64"` are all refused rather than coerced - a
 * `Number()` on any of those either succeeds with a value nobody typed or yields
 * NaN on its way to a REAL column. Nine digits also keeps the parsed value below
 * 2^53 by construction, so there is no separate safe-integer check to keep in
 * sync with this pattern.
 */
const CREDIT_COUNT = /^[0-9]{1,9}$/;

/**
 * One trimmed, non-empty metadata string, or `null`.
 *
 * Trimmed because these values are typed into a Dashboard form and a trailing
 * space is invisible there; `" pro "` naming a tier that exists must not read as
 * a tier that does not.
 */
function priceMetadata(price: StripePrice, key: string): string | null {
  const value = price.metadata?.[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Short identification of a price FOR A LOG LINE. Never for a response body:
 * both halves are vendor-supplied strings, and the module's rule is that a
 * Stripe body's contents stay in the log.
 */
function describePrice(price: StripePrice): string {
  const lookupKey = typeof price.lookup_key === 'string' ? price.lookup_key.slice(0, 80) : null;
  const id = typeof price.id === 'string' ? price.id.slice(0, 80) : null;
  return lookupKey && id ? `${lookupKey} (${id})` : (lookupKey ?? id ?? 'an unidentifiable price');
}

/**
 * A catalogue entry that exists but cannot be sold as configured.
 *
 * 501, matching {@link requireStripeSecret} rather than a 500, and for the same
 * reason: the route is not broken, this deployment's billing configuration is
 * incomplete. Nobody paying can fix it, so the message is written for whoever
 * operates the worker, and the identifying detail goes to the log where the
 * evidence is.
 */
function refuseMisconfigured(price: StripePrice, problem: string, detail: string): StripeRefusal {
  console.error(`Stripe price ${describePrice(price)} is misconfigured: ${detail}`);
  return {
    status: 501,
    error:
      `Billing is not configured correctly on this deployment: ${problem} ` +
      `Fix the price in Stripe and try again.`,
  };
}

/**
 * The tier a price grants, from `metadata.tier` on the PRICE (requirement 7).
 *
 * Read off the price rather than inferred from the lookup key, so a second
 * price on the same product - the annual price, when it lands - needs no code
 * change here. Validated against `TIERS`, which stays the sole authority on what
 * the tier may actually do (requirement 7 again): Stripe metadata says WHICH
 * tier, never what it is allowed to do, so tier limits cannot acquire a second
 * definition in a Dashboard field nobody diffs.
 *
 * A missing or unknown value is a REFUSAL, never a default. Defaulting to
 * starter would be the worst available failure: silent, plausible, and it sells
 * a real subscription at a tier nobody chose - the customer is charged the Team
 * price and gets Starter limits, and the only trace is a support ticket.
 *
 * Exported because the webhook needs the same mapping for a price arriving
 * inside `customer.subscription.updated`, where there is no checkout to resolve.
 */
export function tierForPrice(price: StripePrice): { tier: string } | StripeRefusal {
  const tier = priceMetadata(price, 'tier');
  if (!tier) {
    return refuseMisconfigured(
      price,
      'a plan price carries no metadata.tier.',
      'metadata.tier is missing or empty, so there is no tier to grant.',
    );
  }
  if (!isKnownTier(tier)) {
    return refuseMisconfigured(
      price,
      'a plan price names a tier this worker does not know.',
      `metadata.tier "${tier.slice(0, 80)}" is not declared in TIERS. Note "plus" was removed - ` +
        `the tiers are starter, pro and team.`,
    );
  }
  return { tier };
}

/**
 * What a top-up price grants: the displayed credit count and the real USD budget
 * behind it (requirements 8, 22).
 *
 * `credits` comes from `metadata.credits` because the pack counts are a PRICING
 * decision that has to be settled in the same place as the money (task 9.2a is
 * still open on the exact numbers), and `costUsd` is derived from the starter
 * ratio in `tenants.ts` so pack margin moves with the tier model instead of
 * drifting from it.
 *
 * The last check is the one that matters most and the one requirement 8 makes
 * possible: a pack may never grant more real inference budget than the customer
 * paid for it. Every top-up's economics live in a Dashboard metadata field, so
 * the realistic failure is not an attack, it is an extra zero - `25000` where
 * `2500` was meant grants $100 of inference for $40. The derived cost basis
 * compared against the amount actually charged catches exactly that class of
 * typo, with no magic ceiling constant to go stale, and it refuses rather than
 * fulfilling a sale that loses money on every unit.
 *
 * Deliberately NOT the 75-80 percent margin floor from requirement 51: that is a
 * pricing policy, decided per pack against a jurisdiction's tax rate, and a
 * worker route is the wrong place to adjudicate it. This is the zero-margin
 * floor - the point past which the number is not a discount, it is a mistake.
 */
export function topUpForPrice(
  price: StripePrice,
): { credits: number; costUsd: number } | StripeRefusal {
  const raw = priceMetadata(price, 'credits');
  if (!raw || !CREDIT_COUNT.test(raw)) {
    return refuseMisconfigured(
      price,
      'a credit pack carries no usable metadata.credits.',
      `metadata.credits ${raw === null ? 'is missing or empty' : `is "${raw.slice(0, 80)}"`}, ` +
        `which is not a plain whole number of credits.`,
    );
  }
  const credits = Number(raw);
  if (credits <= 0) {
    return refuseMisconfigured(
      price,
      'a credit pack grants no credits.',
      'metadata.credits is zero.',
    );
  }

  const costUsd = grantCostUsd(credits);
  if (!(costUsd > 0)) {
    // Unreachable while `TIERS.starter` has a credit allowance, and refused
    // rather than asserted because the alternative is granting a pack with no
    // budget behind it.
    return refuseMisconfigured(
      price,
      'a credit pack has no computable USD budget.',
      'the starter tier ratio yields no budget per credit, so grantCostUsd returned 0.',
    );
  }

  // Only meaningful when the price is denominated in the same currency the gate
  // meters in. Currency is immutable per price and task 9.2b has not settled it,
  // so a non-USD price skips the comparison rather than being refused by a
  // hardcoded assumption about what we sell in.
  const paidUsd =
    price.currency === 'usd' &&
    typeof price.unit_amount === 'number' &&
    Number.isFinite(price.unit_amount)
      ? price.unit_amount / 100
      : null;
  if (paidUsd !== null && costUsd > paidUsd) {
    return refuseMisconfigured(
      price,
      'a credit pack would grant more inference budget than it charges.',
      `${credits} credits is $${costUsd.toFixed(2)} of real inference against $${paidUsd.toFixed(
        2,
      )} charged. Check metadata.credits for an extra digit.`,
    );
  }

  return { credits, costUsd };
}

/**
 * Resolves a client-supplied lookup key into a price this deployment will
 * actually sell (requirements 5, 6, 7, 8).
 *
 * The whole gate, in order: allowlist (400 for anything else), then one Stripe
 * lookup by `lookup_key` filtered to ACTIVE prices, then the structural checks,
 * then the kind-specific metadata. Anything the caller can influence fails at
 * the first step; everything after it is a statement about OUR catalogue and
 * refuses as unconfigured.
 *
 * `active=true` is part of requirement 6 rather than a tidy default: an archived
 * price is still checkout-able by id, which is precisely the "price of their
 * choosing" the allowlist exists to prevent, and a superseded price is the one
 * most likely to be mispriced.
 */
export async function resolveCataloguePrice(
  env: StripeEnv,
  requestedLookupKey: unknown,
): Promise<StripeResult<ResolvedCataloguePrice>> {
  const allowed = requireAllowedLookupKey(requestedLookupKey);
  if ('status' in allowed) return allowed;
  const { lookupKey, kind } = allowed.entry;

  const list = await stripeRequest<{ data?: unknown }>(env, '/prices', {
    method: 'GET',
    // `limit: 2` rather than 1, to DETECT the assumption instead of relying on
    // it. Stripe enforces `lookup_key` uniqueness among active prices, so the
    // list is at most one long - and if that ever stops holding, taking `data[0]`
    // would silently charge whichever price Stripe happened to order first.
    params: { lookup_keys: [lookupKey], active: true, limit: 2 },
  });
  if ('status' in list) return list;

  // `list.data` is this module's own success wrapper; the `.data` inside it is
  // Stripe's list envelope. Unfortunate collision, one line deep.
  const prices = Array.isArray(list.data.data) ? list.data.data : [];
  if (prices.length === 0) {
    console.error(`Stripe has no active price with lookup key "${lookupKey}".`);
    return {
      status: 501,
      error:
        `Billing is not configured on this deployment: Stripe has no active price with lookup ` +
        `key "${lookupKey}". Create it (or mirror it into this mode) and try again.`,
    };
  }
  if (prices.length > 1) {
    console.error(
      `Stripe returned ${prices.length} active prices for lookup key "${lookupKey}"; refusing ` +
        `rather than picking one.`,
    );
    return {
      status: 501,
      error:
        `Billing is not configured correctly on this deployment: more than one active Stripe ` +
        `price carries the lookup key "${lookupKey}". Archive the duplicate and try again.`,
    };
  }

  const candidate = prices[0];
  if (typeof candidate !== 'object' || candidate === null) {
    console.error(`Stripe returned a non-object price for lookup key "${lookupKey}".`);
    return { status: 502, error: 'Stripe returned an unreadable response.' };
  }
  const price = candidate as StripePrice;

  const priceId = typeof price.id === 'string' && STRIPE_PRICE_ID.test(price.id) ? price.id : null;
  if (!priceId) {
    console.error(`Stripe returned a price with no usable id for lookup key "${lookupKey}".`);
    return { status: 502, error: 'Stripe returned an unreadable response.' };
  }
  // Both re-checks of a filter Stripe already applied. They cost nothing and
  // each one guards against selling the WRONG thing rather than against a
  // failure: a price that came back inactive, or under a different lookup key,
  // means the request we built and the object we got do not describe the same
  // product, and one of the two is not what the customer clicked.
  if (price.active !== true) {
    return refuseMisconfigured(
      price,
      `the Stripe price for "${lookupKey}" is archived.`,
      'the active=true filter returned an inactive price.',
    );
  }
  if (price.lookup_key !== lookupKey) {
    return refuseMisconfigured(
      price,
      `the Stripe price returned for "${lookupKey}" carries a different lookup key.`,
      `requested "${lookupKey}".`,
    );
  }

  const expectedType = kind === 'subscription' ? 'recurring' : 'one_time';
  if (price.type !== expectedType) {
    // The reason the allowlist stores a kind at all. A pack accidentally created
    // as a recurring price would otherwise be sold as a subscription that never
    // grants credits, and a plan created as one-time would take $20 once and
    // then expire silently.
    return refuseMisconfigured(
      price,
      `the Stripe price for "${lookupKey}" is not a ${
        kind === 'subscription' ? 'recurring plan' : 'one-time'
      } price.`,
      `expected type "${expectedType}", got "${String(price.type).slice(0, 40)}".`,
    );
  }

  // Not fatal, deliberately. `tax_behavior` is PERMANENT once set, so refusing
  // here would take the catalogue offline for something Stripe cannot fix on an
  // existing price - and requirement 46's enforcement point is price CREATION
  // (tasks 9.1, 9.5). What it must not be is invisible: an inclusive price is
  // what makes the published number the number the customer pays, and the
  // realistic way to lose it is mirroring the catalogue into live mode without
  // it.
  if (price.tax_behavior !== 'inclusive') {
    console.warn(
      `Stripe price ${describePrice(price)} has tax_behavior ` +
        `"${String(price.tax_behavior).slice(0, 40)}", not "inclusive" (requirement 46). The ` +
        `displayed price is no longer what the customer pays.`,
    );
  }

  if (kind === 'subscription') {
    const tier = tierForPrice(price);
    if ('status' in tier) return tier;
    return { data: { kind, lookupKey, priceId, mode: 'subscription', tier: tier.tier } };
  }

  const pack = topUpForPrice(price);
  if ('status' in pack) return pack;
  return {
    data: {
      kind,
      lookupKey,
      priceId,
      mode: 'payment',
      credits: pack.credits,
      costUsd: pack.costUsd,
    },
  };
}

// ── Webhook signatures ───────────────────────────────────────────────────────

/**
 * How far a webhook's own timestamp may sit from this worker's clock, in either
 * direction. Stripe's documented default, and NOT a parameter: a tolerance is
 * the only thing standing between us and a replay of a captured body, so
 * widening it has to be a code change with a review rather than a call-site
 * option someone reaches for while debugging a clock problem.
 *
 * Both directions matter. Rejecting only the past leaves a body signed with a
 * far-FUTURE `t` valid indefinitely, which turns a single captured request into
 * a permanent replay token - and a future `t` is also the signature of a badly
 * skewed clock somewhere, which is worth failing loudly instead of accepting.
 */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * The one scheme we verify. Stripe also emits `v0` on some deliveries (it covers
 * a different payload), and may add schemes later, so anything that is not `v1`
 * is ignored rather than treated as a malformed header.
 */
const STRIPE_SIGNATURE_SCHEME = 'v1';

/** A SHA-256 HMAC in hex: 32 bytes, so exactly 64 hex characters. */
const STRIPE_SIGNATURE_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * How many `v1` candidates we will actually verify.
 *
 * Every candidate costs one HMAC over the WHOLE body, and this endpoint is
 * public and unauthenticated by design - the signature IS the authentication, so
 * the work happens before we know who is calling. Cloudflare allows roughly 16kB
 * of request headers, which is about 240 `v1=<64 hex>` entries, and 240 HMACs
 * over a multi-megabyte body is enough to burn the worker's CPU budget on
 * request the attacker sent for free.
 *
 * An endpoint has at most TWO signing secrets (the rotation window is the only
 * reason for more than one), so eight is four times the headroom Stripe can
 * legitimately need. Extra candidates are DROPPED rather than treated as
 * malformed, for the same reason `v0` is ignored: a genuine delivery is never
 * affected, and only a forged header can reach the cap. When the cap does bite,
 * the `no_match` log says so, so it cannot be misread as a wrong secret.
 */
const STRIPE_SIGNATURE_MAX_CANDIDATES = 8;

/**
 * Unix seconds. Capped at 15 digits so the value is always exactly
 * representable as a JS number (< 2^53); a longer run of digits is not a
 * plausible timestamp and is refused rather than silently rounded.
 */
const STRIPE_SIGNATURE_TIMESTAMP = /^[0-9]{1,15}$/;

export interface StripeSignatureOptions {
  /**
   * Clock override in milliseconds, defaulting to `Date.now()`. Exists so the
   * tolerance BOUNDARY is testable deterministically: asserting that exactly
   * 300s is accepted and 301s is not, against a wall clock that can tick
   * between building the header and checking it, is a flake waiting to happen.
   */
  nowMs?: number;
}

/**
 * Why a delivery was refused. Kept as a stable token in the log line because
 * each one maps to a DIFFERENT operator action, and the mapping is not obvious
 * from a generic "invalid signature":
 *
 *  - `no_secret` / `empty_body` / `missing_header` - the request never looked
 *    like a Stripe delivery, or the endpoint is unconfigured.
 *  - `malformed_header` - a `Stripe-Signature` we could not parse. In practice a
 *    proxy rewriting headers, or something hand-rolling a request.
 *  - `timestamp_out_of_tolerance` - a replay, or a clock problem.
 *  - `no_match` - the single most common REAL failure: the endpoint is holding
 *    the wrong `whsec_`. `stripe listen --forward-to` prints a different secret
 *    than the Dashboard endpoint does, so a local secret deployed (or the
 *    reverse) fails exactly here, with a body that is otherwise perfect.
 *  - `crypto_error` - unreachable in normal operation, and refused rather than
 *    thrown so it cannot become a 500.
 */
type StripeSignatureRejection =
  | 'no_secret'
  | 'empty_body'
  | 'missing_header'
  | 'malformed_header'
  | 'timestamp_out_of_tolerance'
  | 'no_match'
  | 'crypto_error';

/** A parsed `Stripe-Signature` header. */
interface ParsedStripeSignature {
  /**
   * The timestamp EXACTLY as it arrived, because it is part of the signed
   * payload. Re-serializing the parsed number would change the bytes we verify
   * for any spelling other than the canonical one (`t=0123`), and the failure
   * would look like a wrong secret.
   */
  timestamp: string;
  /** The same value as seconds, for the tolerance comparison only. */
  timestampSeconds: number;
  /**
   * The `v1` candidates we will verify, lowercased. More than one during a
   * rotation, and never more than {@link STRIPE_SIGNATURE_MAX_CANDIDATES}.
   */
  signatures: string[];
  /**
   * How many well-formed `v1` entries the header carried in total, which is
   * larger than `signatures.length` only when the cap trimmed it. Logged on a
   * failure so a capped header cannot be mistaken for a wrong secret.
   */
  candidatesSeen: number;
}

/**
 * Verifies a Stripe webhook delivery: `true` only if `header` carries a `v1`
 * HMAC-SHA256 over `${t}.${raw}` under `secret`, with `t` inside
 * {@link STRIPE_SIGNATURE_TOLERANCE_SECONDS} of now (requirement 11).
 *
 * `raw` must be the UNPARSED body - `await request.text()` before anything
 * touches `request.json()`, because the signature covers bytes and a reparsed
 * object does not round-trip to them.
 *
 * Three properties are the whole point of this function:
 *
 * **The comparison is constant-time by construction.** `crypto.subtle.verify`
 * computes the expected MAC and compares it internally; we never decode a
 * candidate and compare it with `===` or a hand-rolled loop, which is the one
 * place a hand-rolled Stripe client genuinely would be a security risk. Every
 * other comparison in here is over data the caller already knows (the shape of
 * a hex string, a timestamp) and reveals nothing about the secret.
 *
 * **It returns a boolean and never throws.** The route's guard is therefore
 * `if (!(await verifyStripeSignature(...))) return 400`, with no shape to
 * misread and no truthy-object trap. Malformed header, missing `t`, missing or
 * non-hex `v1`, empty body, unconfigured secret: all are the same clean
 * refusal. That matters more here than anywhere else in this module, because an
 * exception escaping to the generic 500 would make Stripe retry the delivery
 * for days.
 *
 * **The reason is logged here, not returned.** An operator debugging a webhook
 * that answers 400 needs to know WHICH of those it is, and the route has nothing
 * to add - so the diagnosis lives next to the evidence, and the return value
 * stays a boolean. Logged at warn level on purpose: an unsigned request is
 * untrusted input, not a worker fault, and this endpoint is public enough that
 * internet scanners will reach it.
 *
 * Nothing derived from the secret or the body reaches the log. Timestamps and
 * candidate counts do.
 */
export async function verifyStripeSignature(
  raw: string,
  header: string | null | undefined,
  secret: string | null | undefined,
  options: StripeSignatureOptions = {},
): Promise<boolean> {
  // Trimmed for the same reason `requireStripeSecret` trims: `wrangler secret
  // put` stores the trailing newline you did not mean to paste, and Stripe signs
  // with the secret it issued. Checking the trimmed value but hashing with the
  // padded one would answer `no_match`, which reads as "wrong secret or altered
  // body" and sends an operator looking for the wrong problem entirely.
  const signingSecret = secret?.trim() ?? '';
  // Belt and braces behind `requireStripeSecret`'s 501, and `undefined` is
  // accepted because `StripeEnv.STRIPE_WEBHOOK_SECRET` is optional: an empty HMAC
  // key is a `DataError` from `importKey` in some implementations and a
  // catastrophic accept in any that allowed it, and inside a webhook a throw is a
  // 500 and days of Stripe retries. It never reaches the crypto at all.
  if (!signingSecret) {
    return rejectSignature('no_secret', 'STRIPE_WEBHOOK_SECRET is not configured.');
  }
  // An empty body carries no event to apply, so there is nothing a valid
  // signature over it could authorize.
  if (!raw) return rejectSignature('empty_body', 'the request body was empty.');
  if (!header) return rejectSignature('missing_header', 'no Stripe-Signature header.');

  const parsed = parseStripeSignatureHeader(header);
  if (!parsed) {
    return rejectSignature(
      'malformed_header',
      'the Stripe-Signature header carries no usable t= and v1= pair.',
    );
  }

  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const drift = Math.abs(nowSeconds - parsed.timestampSeconds);
  if (drift > STRIPE_SIGNATURE_TOLERANCE_SECONDS) {
    return rejectSignature(
      'timestamp_out_of_tolerance',
      `t=${parsed.timestamp} is ${drift}s from this worker's clock ` +
        `(tolerance ${STRIPE_SIGNATURE_TOLERANCE_SECONDS}s).`,
    );
  }

  const encoder = new TextEncoder();
  const payload = encoder.encode(`${parsed.timestamp}.${raw}`);
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(signingSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    for (const candidate of parsed.signatures) {
      // Returning on the first match leaks only WHICH of the caller's own
      // candidates matched, which they supplied and already know. The key is
      // imported once because that, not the MAC, is the expensive part.
      if (await crypto.subtle.verify('HMAC', key, hexToBytes(candidate), payload)) return true;
    }
  } catch (error) {
    return rejectSignature(
      'crypto_error',
      redact(error instanceof Error ? error.message : String(error), signingSecret),
    );
  }

  const capped =
    parsed.candidatesSeen > parsed.signatures.length
      ? ` (${parsed.candidatesSeen} present, only the first ${STRIPE_SIGNATURE_MAX_CANDIDATES} are tried)`
      : '';
  return rejectSignature(
    'no_match',
    `${parsed.signatures.length} v1 candidate(s)${capped}, none matching. Either this endpoint ` +
      `holds a different STRIPE_WEBHOOK_SECRET than the one that signed the delivery, or the body ` +
      `was altered in transit.`,
  );
}

/**
 * Splits `t=<unix>,v1=<hex>[,v1=<hex>][,v0=<hex>]` into its parts, or `null`
 * when what is left is not verifiable.
 *
 * Deliberately lenient about what it does not understand and strict about what
 * it does:
 *
 *  - MULTIPLE `v1` entries are normal. An endpoint mid secret-rotation is signed
 *    with both the old and the new secret, so refusing more than one would break
 *    every delivery during exactly the window rotation exists to make safe. Only
 *    the first {@link STRIPE_SIGNATURE_MAX_CANDIDATES} are kept, and the total is
 *    reported separately so a capped header is diagnosable.
 *  - A `v1` that is not 64 hex characters is DROPPED, not fatal, so one junk
 *    candidate cannot invalidate a good one sitting beside it. When it was the
 *    only candidate we end up with an empty list, which is the `null` case.
 *  - `v0` and any future scheme are ignored, as are elements with no `=`. That
 *    is what lets Stripe extend the header without a deploy here.
 *  - A DUPLICATE `t` is fatal. One timestamp has to feed both the tolerance
 *    check and the signed payload or the replay guard is decorative, and picking
 *    one of two silently is a worse answer than refusing.
 */
function parseStripeSignatureHeader(header: string): ParsedStripeSignature | null {
  let timestamp: string | null = null;
  let candidatesSeen = 0;
  const signatures: string[] = [];

  for (const element of header.split(',')) {
    const split = element.indexOf('=');
    if (split < 0) continue;
    // Trimmed because a header rewritten by an intermediary can pick up
    // whitespace around the separators, and a payment webhook is a bad place to
    // be pedantic about a space.
    const scheme = element.slice(0, split).trim();
    const value = element.slice(split + 1).trim();

    if (scheme === 't') {
      if (timestamp !== null) return null;
      if (!STRIPE_SIGNATURE_TIMESTAMP.test(value)) return null;
      timestamp = value;
    } else if (scheme === STRIPE_SIGNATURE_SCHEME && STRIPE_SIGNATURE_HEX.test(value)) {
      candidatesSeen += 1;
      if (signatures.length < STRIPE_SIGNATURE_MAX_CANDIDATES) signatures.push(value.toLowerCase());
    }
  }

  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, timestampSeconds: Number(timestamp), signatures, candidatesSeen };
}

/** Decodes a hex string already validated against {@link STRIPE_SIGNATURE_HEX}. */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Logs the refusal and returns `false`, so every rejection path in
 * {@link verifyStripeSignature} is one `return` and none can forget the log.
 */
function rejectSignature(reason: StripeSignatureRejection, detail: string): false {
  console.warn(`Stripe webhook signature rejected (${reason}): ${detail}`);
  return false;
}
