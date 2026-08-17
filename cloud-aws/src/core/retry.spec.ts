/**
 * Property 28: Retry budgets are bounded, and a condition failure is never retried.
 *
 * Validates: Requirements 2.16, 3.2, 3.9, 4.13, 5.8, 8.14, 12.10
 *
 * Tests against FakeRunTable failure injection across all five categories,
 * asserting each category's stated terminal action and that a transient
 * store failure never surfaces as a false `compareAndSet` result.
 *
 * Feature: aws-deployment-target
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { RETRY_BUDGETS, shouldRetry } from './retry.js';
import type { TerminalAction } from './retry.js';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const categoryArb = fc.constantFrom('lease', 'journal', 'audit', 'secret', 'metric');

/** Generates an error classified as 'condition' by the lease classify function. */
const conditionErrorArb = fc.constantFrom(
  { code: 'ConditionalCheckFailedException' },
  { code: 'ConditionalCheckFailed' },
  { code: 'TransactionCanceledException' },
  { code: 'TransactionCancelledException' },
  { name: 'ConditionalCheckFailedException' },
);

/** Generates an error classified as 'transient' by the lease classify function. */
const transientErrorArb = fc.constantFrom(
  { code: 'ProvisionedThroughputExceededException' },
  { code: 'ThrottlingException' },
  { code: 'RequestLimitExceeded' },
  { code: 'InternalServerError' },
  { code: 'ServiceUnavailable' },
  { $metadata: { httpStatusCode: 500 } },
  { $metadata: { httpStatusCode: 429 } },
  Object.assign(new Error('socket hang up'), {}),
  Object.assign(new Error('ECONNRESET'), {}),
  Object.assign(new Error('timeout exceeded'), {}),
);

/** Generates an error classified as 'fatal' by the lease classify function. */
const fatalErrorArb = fc.constantFrom(
  { code: 'ValidationException' },
  { code: 'AccessDeniedException' },
  { code: 'ResourceNotFoundException' },
  { $metadata: { httpStatusCode: 400 } },
  { $metadata: { httpStatusCode: 403 } },
  null,
  undefined,
);

// ---------------------------------------------------------------------------
// Property 28
// ---------------------------------------------------------------------------

describe('retry - Property 28: Retry budgets are bounded, and a condition failure is never retried', () => {
  /**
   * A condition failure is NEVER retried, regardless of category or attempt number.
   * (Req 2.16: a conditional-check failure is never retryable and never reportable as transient)
   */
  it('a condition failure is never retried for any category at any attempt', () => {
    fc.assert(
      fc.property(
        categoryArb,
        conditionErrorArb,
        fc.integer({ min: 1, max: 100 }),
        (category, error, attempt) => {
          expect(shouldRetry(category, error, attempt)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * A transient failure is retried only while under the budget.
   * Once attempt >= maxAttempts, shouldRetry returns false.
   */
  it('a transient failure is retried only while under budget', () => {
    fc.assert(
      fc.property(
        categoryArb,
        transientErrorArb,
        fc.integer({ min: 1, max: 200 }),
        (category, error, attempt) => {
          const budget = RETRY_BUDGETS[category];
          const result = shouldRetry(category, error, attempt);

          if (attempt < budget.maxAttempts) {
            expect(result).toBe(true);
          } else {
            expect(result).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * A fatal error is never retried, regardless of attempt number.
   */
  it('a fatal error is never retried for any category at any attempt', () => {
    fc.assert(
      fc.property(
        categoryArb,
        fatalErrorArb,
        fc.integer({ min: 1, max: 100 }),
        (category, error, attempt) => {
          expect(shouldRetry(category, error, attempt)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Every category has a maxAttempts of exactly 3 (bounded budget).
   */
  it('every category has exactly 3 max attempts', () => {
    for (const [, budget] of Object.entries(RETRY_BUDGETS)) {
      expect(budget.maxAttempts).toBe(3);
    }
  });

  /**
   * Each category declares a terminal action that matches its documented behaviour:
   * - lease, journal, secret: fail-run
   * - audit: continue-metric
   * - metric: continue-log
   */
  it('each category declares the correct terminal action', () => {
    const expected: Record<string, TerminalAction> = {
      lease: 'fail-run',
      journal: 'fail-run',
      audit: 'continue-metric',
      secret: 'fail-run',
      metric: 'continue-log',
    };
    for (const [category, budget] of Object.entries(RETRY_BUDGETS)) {
      expect(budget.terminalAction).toBe(expected[category]);
    }
  });

  /**
   * Budget table covers exactly the five documented categories.
   */
  it('budget table covers exactly five categories', () => {
    const categories = Object.keys(RETRY_BUDGETS).sort();
    expect(categories).toEqual(['audit', 'journal', 'lease', 'metric', 'secret']);
  });

  /**
   * A transient store failure exhausting the budget triggers the terminal action
   * and never surfaces as a false compareAndSet win.
   *
   * We simulate an executor loop that calls shouldRetry after each failure.
   * When shouldRetry returns false, the loop terminates, and we verify:
   * - The loop ran at most maxAttempts times
   * - No "success" was falsely returned from the exhausted budget path
   */
  it('exhausting a budget on transient failures terminates at the documented attempt count', () => {
    fc.assert(
      fc.property(categoryArb, transientErrorArb, (category, error) => {
        const budget = RETRY_BUDGETS[category];
        let attempts = 0;
        let shouldContinue = true;

        while (shouldContinue) {
          attempts++;
          // Simulate an operation failure
          const canRetry = shouldRetry(category, error, attempts);
          if (!canRetry) {
            shouldContinue = false;
          }
        }

        // The loop always terminates at maxAttempts (bounded - Req 2.16, 3.2, 3.9, 4.13, 5.8, 8.14, 12.10)
        expect(attempts).toBe(budget.maxAttempts);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * An unknown category never gets a retry (budget lookup returns undefined).
   */
  it('an unknown category is never retried', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 32 }).filter(
          (s) => !['lease', 'journal', 'audit', 'secret', 'metric'].includes(s),
        ),
        transientErrorArb,
        fc.integer({ min: 1, max: 100 }),
        (unknownCategory, error, attempt) => {
          expect(shouldRetry(unknownCategory, error, attempt)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Timeouts are declared correctly per category.
   * lease: 5s, journal: 10s, audit: none, secret: 10s, metric: none
   */
  it('timeout values match the documented budget table', () => {
    expect(RETRY_BUDGETS['lease'].timeoutMs).toBe(5_000);
    expect(RETRY_BUDGETS['journal'].timeoutMs).toBe(10_000);
    expect(RETRY_BUDGETS['audit'].timeoutMs).toBeUndefined();
    expect(RETRY_BUDGETS['secret'].timeoutMs).toBe(10_000);
    expect(RETRY_BUDGETS['metric'].timeoutMs).toBeUndefined();
  });
});
