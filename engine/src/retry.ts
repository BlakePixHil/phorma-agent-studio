/**
 * Rate-limit-aware retry classification for non-model steps (design §6, P1-3).
 *
 * The engine's retry loop (`WorkflowRun.withNodeRetry`) owns the awaiting and the
 * event emission; every *decision* lives here, and every decision is pure:
 *
 * - `normalisePolicy` resolves an author-supplied {@link NodeRetryPolicy} into a
 *   fully populated policy, clamping `maxAttempts` into `[1, 5]`.
 * - `parseRetryAfter` reads a `Retry-After` header in either wire form.
 * - `backoffFor` draws a full-jitter exponential delay from an *injected* random
 *   source.
 * - `decideRetry` answers "retry, how long, and why" for one failed attempt.
 *
 * Purity is the point: no ambient clock (`nowMs` is supplied), no ambient random
 * source (`random` is injected), no I/O and no runtime dependency. That makes the
 * whole classifier property-testable and makes a replayed run reproducible.
 *
 * The safety rule that shapes the rest: a step that is not declared `idempotent`
 * is retried ONLY when the transport proves the request never reached the server
 * (connect / DNS / TLS). A 5xx or a timeout on a non-idempotent write may mean
 * the write landed, so repeating it could duplicate it.
 */

import { DataTransportError, HttpStatusError } from './data-host.js';
import { RunStoppedError } from './gate.js';
import type { NodeRetryPolicy } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Bounds and defaults (requirement 11.1, 11.2)
// ─────────────────────────────────────────────────────────────────────────────

/** Attempt floor: every node body runs at least once. */
export const MIN_RETRY_ATTEMPTS = 1;
/** Attempt ceiling, matching the existing engine constant. */
export const MAX_RETRY_ATTEMPTS = 5;
/** Total attempts including the first, when the policy leaves it unset. */
export const DEFAULT_RETRY_ATTEMPTS = 3;
/** Base backoff, doubled per attempt. */
export const DEFAULT_RETRY_BACKOFF_MS = 1_000;
/** Per-attempt backoff ceiling. */
export const DEFAULT_MAX_BACKOFF_MS = 30_000;
/** Ceiling applied to a server-provided `Retry-After`. */
export const DEFAULT_MAX_RETRY_AFTER_MS = 120_000;

/** Statuses that are retryable for an idempotent step. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  408, 425, 429, 500, 502, 503, 504,
]);

/** Header the classifier consults, lower-cased as hosts deliver it. */
const RETRY_AFTER_HEADER = 'retry-after';

// ─────────────────────────────────────────────────────────────────────────────
// Policy normalisation
// ─────────────────────────────────────────────────────────────────────────────

/** A {@link NodeRetryPolicy} with every field resolved. */
export interface NormalisedRetryPolicy {
  /** Integer in `[MIN_RETRY_ATTEMPTS, MAX_RETRY_ATTEMPTS]`. 1 when disabled. */
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs: number;
  maxRetryAfterMs: number;
  retryOn: 'transient' | 'all' | 'none';
  honorRetryAfter: boolean;
  idempotent: boolean;
  disabled: boolean;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

/**
 * Clamps `maxAttempts` and resolves every default.
 *
 * An absent `maxAttempts` becomes {@link DEFAULT_RETRY_ATTEMPTS}; a non-integer
 * or sub-1 value becomes 1 (never retry rather than guess); anything above the
 * ceiling becomes {@link MAX_RETRY_ATTEMPTS}. `disabled` and `retryOn: 'none'`
 * collapse the budget to a single attempt so a caller can bound its loop with
 * `maxAttempts` alone.
 */
export function normalisePolicy(policy: NodeRetryPolicy | undefined): NormalisedRetryPolicy {
  const raw = policy ?? {};
  const retryOn =
    raw.retryOn === 'all' || raw.retryOn === 'none' || raw.retryOn === 'transient'
      ? raw.retryOn
      : 'transient';
  const disabled = raw.disabled === true;

  let maxAttempts: number;
  if (raw.maxAttempts === undefined) {
    maxAttempts = DEFAULT_RETRY_ATTEMPTS;
  } else if (!Number.isInteger(raw.maxAttempts) || raw.maxAttempts < MIN_RETRY_ATTEMPTS) {
    maxAttempts = MIN_RETRY_ATTEMPTS;
  } else {
    maxAttempts = Math.min(raw.maxAttempts, MAX_RETRY_ATTEMPTS);
  }
  if (disabled || retryOn === 'none') maxAttempts = MIN_RETRY_ATTEMPTS;

  return {
    maxAttempts,
    backoffMs: positiveNumber(raw.backoffMs, DEFAULT_RETRY_BACKOFF_MS),
    maxBackoffMs: positiveNumber(raw.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS),
    maxRetryAfterMs: positiveNumber(raw.maxRetryAfterMs, DEFAULT_MAX_RETRY_AFTER_MS),
    retryOn,
    honorRetryAfter: raw.honorRetryAfter !== false,
    idempotent: raw.idempotent === true,
    disabled,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry-After parsing (requirement 11.8)
// ─────────────────────────────────────────────────────────────────────────────

/** Matches the delta-seconds form: a bare non-negative integer count. */
const DELTA_SECONDS = /^\d+$/;

/**
 * Parses `Retry-After` in either wire form and returns the delay in
 * milliseconds, or `undefined` when the value is absent, empty or unparseable.
 *
 * Delta-seconds (`Retry-After: 30`) becomes `30_000`. An HTTP-date becomes the
 * date minus `nowMs`, which is NEGATIVE for a date already in the past — the
 * caller clamps, as a past date still means "you may retry now".
 */
export function parseRetryAfter(
  headerValue: string | undefined,
  nowMs: number,
): number | undefined {
  if (typeof headerValue !== 'string') return undefined;
  const raw = headerValue.trim();
  if (raw.length === 0) return undefined;

  if (DELTA_SECONDS.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds)) return undefined;
    return seconds * 1_000;
  }

  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed - nowMs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backoff (requirement 11.7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full-jitter exponential backoff: a whole number of milliseconds in the
 * inclusive range `[0, min(backoffMs * 2^(attempt-1), maxBackoffMs)]`, drawn
 * from the injected `random` source.
 *
 * Full jitter (rather than jitter around the schedule) is what stops a fleet of
 * retrying runs from re-synchronising into a second thundering herd.
 */
export function backoffFor(
  attempt: number,
  policy: NodeRetryPolicy | NormalisedRetryPolicy,
  random: () => number,
): number {
  const resolved = normalisePolicy(policy);
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  const scheduled = resolved.backoffMs * Math.pow(2, exponent);
  const ceiling = Math.min(
    Number.isFinite(scheduled) ? scheduled : resolved.maxBackoffMs,
    resolved.maxBackoffMs,
  );
  if (!(ceiling > 0)) return 0;

  const drawn = random();
  const unit = Number.isFinite(drawn) ? Math.min(1, Math.max(0, drawn)) : 0;
  return Math.floor(unit * ceiling);
}

// ─────────────────────────────────────────────────────────────────────────────
// The decision (requirements 11.3 - 11.9, 11.14)
// ─────────────────────────────────────────────────────────────────────────────

/** Why the classifier decided as it did, for the `node-retrying` event. */
export type RetryReason = 'status' | 'transport' | 'retry-after' | 'policy-all' | 'not-retryable';

export interface RetryDecision {
  retry: boolean;
  /** Delay before the next attempt. Always 0 when `retry` is false. */
  delayMs: number;
  /** Why, for the `node-retrying` event message. */
  reason: RetryReason;
}

export interface RetryDecisionInput {
  error: unknown;
  /** 1-based: the attempt that just failed. */
  attempt: number;
  policy: NodeRetryPolicy | NormalisedRetryPolicy;
  /** Supplied current time; the classifier reads no ambient clock. */
  nowMs: number;
  /** Injected random source; the classifier reads no ambient randomness. */
  random: () => number;
}

/** A fresh object per call: the caller owns the decision it is handed. */
function noRetry(): RetryDecision {
  return { retry: false, delayMs: 0, reason: 'not-retryable' };
}

/**
 * `instanceof` plus a name check: an error can cross a module or realm boundary
 * (worker bundle, duplicated dependency) and lose its prototype identity while
 * keeping the contract the classifier depends on.
 */
function isTransportError(error: unknown): error is DataTransportError {
  if (error instanceof DataTransportError) return true;
  const candidate = error as { name?: unknown; kind?: unknown } | null;
  return (
    !!candidate &&
    typeof candidate === 'object' &&
    candidate.name === 'DataTransportError' &&
    typeof candidate.kind === 'string'
  );
}

function isStatusError(error: unknown): error is HttpStatusError {
  if (error instanceof HttpStatusError) return true;
  const candidate = error as { name?: unknown; status?: unknown } | null;
  return (
    !!candidate &&
    typeof candidate === 'object' &&
    candidate.name === 'HttpStatusError' &&
    typeof candidate.status === 'number'
  );
}

function isStopped(error: unknown): boolean {
  if (error instanceof RunStoppedError) return true;
  const candidate = error as { name?: unknown } | null;
  return !!candidate && typeof candidate === 'object' && candidate.name === 'RunStoppedError';
}

/** True when the request provably never reached the server. */
function neverSent(error: DataTransportError): boolean {
  if (typeof error.requestNeverSent === 'boolean') return error.requestNeverSent;
  return error.kind === 'connect' || error.kind === 'dns' || error.kind === 'tls';
}

/**
 * Resolves the delay for a decided-to-retry status failure: a parseable
 * `Retry-After` wins outright (clamped to `[0, maxRetryAfterMs]`) and the
 * exponential schedule is ignored for that attempt.
 */
function statusDelay(
  error: HttpStatusError,
  input: RetryDecisionInput,
  policy: NormalisedRetryPolicy,
  fallbackReason: RetryReason,
): RetryDecision {
  if (policy.honorRetryAfter) {
    const headers = (error.headers ?? {}) as Record<string, string>;
    const parsed = parseRetryAfter(headers[RETRY_AFTER_HEADER], input.nowMs);
    if (parsed !== undefined) {
      const delayMs = Math.min(Math.max(0, parsed), policy.maxRetryAfterMs);
      return { retry: true, delayMs, reason: 'retry-after' };
    }
  }
  return {
    retry: true,
    delayMs: backoffFor(input.attempt, policy, input.random),
    reason: fallbackReason,
  };
}

/**
 * Decides whether the attempt that just failed should be retried, after how
 * long, and why.
 *
 * Order matters and is fixed: Stop always wins, then the policy switches, then
 * the attempt budget, then error classification. Same inputs — including the
 * injected `random` — always give the same decision.
 */
export function decideRetry(input: RetryDecisionInput): RetryDecision {
  const { error } = input;

  // Stop always wins: an aborted run never schedules more work.
  if (isStopped(error)) return noRetry();

  // `normalisePolicy` is idempotent, so an already-normalised policy passes
  // through unchanged while a raw one still gets its clamping.
  const policy = normalisePolicy(input.policy);
  if (policy.disabled || policy.retryOn === 'none') return noRetry();

  // `attempt` is the one that just failed, so the budget is exhausted at parity.
  if (!Number.isFinite(input.attempt) || input.attempt >= policy.maxAttempts) return noRetry();

  if (isTransportError(error)) {
    // A non-idempotent step is retried only when the request never landed.
    if (!policy.idempotent && !neverSent(error)) return noRetry();
    return {
      retry: true,
      delayMs: backoffFor(input.attempt, policy, input.random),
      reason: 'transport',
    };
  }

  // Every response-status failure is unsafe to repeat for a non-idempotent step:
  // the server answered, so the write may already have landed.
  if (!policy.idempotent) return noRetry();

  if (isStatusError(error)) {
    if (RETRYABLE_STATUSES.has(error.status)) return statusDelay(error, input, policy, 'status');
    if (policy.retryOn === 'all') return statusDelay(error, input, policy, 'policy-all');
    return noRetry();
  }

  // Anything else (a thrown host error, a model error, a plain Error) is opaque:
  // only an explicit `retryOn: 'all'` opts into repeating it.
  if (policy.retryOn === 'all') {
    return {
      retry: true,
      delayMs: backoffFor(input.attempt, policy, input.random),
      reason: 'policy-all',
    };
  }
  return noRetry();
}
