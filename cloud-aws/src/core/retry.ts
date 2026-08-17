/**
 * Per-category retry budgets and failure classification.
 *
 * One table of attempt budgets so a budget cannot drift per call site.
 * A condition-check failure is never retried and never reported as transient.
 *
 * Feature: aws-deployment-target
 * Requirements: 2.16, 3.2, 3.9, 4.13, 5.8, 8.14, 12.10
 */

import { classify } from './lease.js';

// ---------------------------------------------------------------------------
// Terminal actions
// ---------------------------------------------------------------------------

/**
 * What happens when the retry budget is exhausted.
 *
 * - 'fail-run': the run terminates with a `run-failed` RunEvent.
 * - 'continue-metric': the run continues and a dropped-audit-write metric is published.
 * - 'continue-log': the run continues with a log line naming the metric that failed.
 */
export type TerminalAction = 'fail-run' | 'continue-metric' | 'continue-log';

// ---------------------------------------------------------------------------
// Budget entry shape
// ---------------------------------------------------------------------------

export interface RetryBudget {
  /** Maximum number of attempts (including the initial try). */
  maxAttempts: number;
  /** Total timeout in milliseconds, or undefined when no timeout constraint applies. */
  timeoutMs: number | undefined;
  /** What to do when the budget is exhausted. */
  terminalAction: TerminalAction;
}

// ---------------------------------------------------------------------------
// Budget table
// ---------------------------------------------------------------------------

/**
 * Per-category attempt budgets.
 *
 * - lease:   3 attempts, 5s total, fail run on exhaustion (Req 2.16)
 * - journal: 3 attempts, 10s total, fail run on exhaustion (Req 3.2, 3.9)
 * - audit:   3 attempts, no timeout, continue + metric on exhaustion (Req 4.13)
 * - secret:  3 attempts, 10s total, fail run on exhaustion (Req 8.14, 5.8)
 * - metric:  3 attempts, no timeout, continue + log on exhaustion (Req 12.10)
 */
export const RETRY_BUDGETS: Record<string, RetryBudget> = {
  lease: { maxAttempts: 3, timeoutMs: 5_000, terminalAction: 'fail-run' },
  journal: { maxAttempts: 3, timeoutMs: 10_000, terminalAction: 'fail-run' },
  audit: { maxAttempts: 3, timeoutMs: undefined, terminalAction: 'continue-metric' },
  secret: { maxAttempts: 3, timeoutMs: 10_000, terminalAction: 'fail-run' },
  metric: { maxAttempts: 3, timeoutMs: undefined, terminalAction: 'continue-log' },
};

// ---------------------------------------------------------------------------
// Retry decision
// ---------------------------------------------------------------------------

/**
 * Determine whether a failed operation should be retried.
 *
 * Returns `false` immediately for condition failures - these indicate another
 * Runner holds the lease and must never be retried or reported as transient
 * (Req 2.16).
 *
 * Returns `true` when the error is transient and the attempt count has not
 * reached the category's budget.
 *
 * Returns `false` when the budget is exhausted or the error is fatal.
 *
 * @param category - The budget category (lease, journal, audit, secret, metric)
 * @param error - The error from the failed operation
 * @param attempt - The 1-based attempt number that just failed
 */
export function shouldRetry(category: string, error: unknown, attempt: number): boolean {
  const classification = classify(error);

  // Condition failures are never retried (Req 2.16)
  if (classification === 'condition') return false;

  // Fatal errors are never retried
  if (classification === 'fatal') return false;

  // Transient errors: retry if budget remains
  const budget = RETRY_BUDGETS[category];
  if (!budget) return false;

  return attempt < budget.maxAttempts;
}
