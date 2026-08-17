/**
 * Tests for `core/cron.ts`.
 *
 * The explicit table matters as much as the property here. Three of these cases
 * are the exact expressions that made cron undeployable: the everyday
 * `0 12 * * *`, which the old translation turned into an expression carrying `*`
 * in both day fields; an AWS-native expression with `?`, which the old validator
 * rejected outright; and Unix Sunday `0`, which the old validator accepted and
 * AWS then refused.
 *
 * Feature: aws-byo-deploy
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { isBlankCron, translateCron, unixDayOfWeekToAws } from './cron.js';

/** The translated expression, or a failure with the reason attached. */
function expression(cron: string): string {
  const result = translateCron(cron);
  if (!result.ok) throw new Error(`Expected "${cron}" to translate: ${result.reason}`);
  return result.expression;
}

function rejection(cron: string): string {
  const result = translateCron(cron);
  if (result.ok) {
    throw new Error(`Expected "${cron}" to be rejected, got "${result.expression}"`);
  }
  return result.reason;
}

describe('translateCron - the regression table', () => {
  it('translates the everyday Unix expression AWS used to reject', () => {
    // The bug: appending a year wildcard produced `0 12 * * * *`, which AWS
    // refuses because `*` cannot appear in both day fields.
    expect(expression('0 12 * * *')).toBe('0 12 * * ? *');
  });

  it('accepts an AWS-native six-field expression the old validator rejected', () => {
    // The old `isValidCronItem` ran parseInt('?'), got NaN and returned false,
    // so an operator writing the correct AWS dialect was refused locally.
    expect(expression('0 12 * * ? *')).toBe('0 12 * * ? *');
    expect(expression('15 10 ? * 6L 2022-2023')).toBe('15 10 ? * 6L 2022-2023');
  });

  it('maps Unix Sunday 0 onto AWS 1, which the old validator passed and AWS refused', () => {
    expect(expression('0 0 * * 0')).toBe('0 0 ? * 1 *');
    // Unix accepts 7 for Sunday too, and it lands on the same AWS day.
    expect(expression('0 0 * * 7')).toBe('0 0 ? * 1 *');
  });

  it('shifts a Unix weekday range onto AWS numbering', () => {
    // Unix Mon-Fri is 1-5; AWS Mon-Fri is 2-6.
    expect(expression('30 2 * * 1-5')).toBe('30 2 ? * 2-6 *');
  });

  it('keeps day-of-month constrained for a monthly schedule', () => {
    expect(expression('0 0 1 * *')).toBe('0 0 1 * ? *');
  });

  it('defers day-of-month for a weekly schedule', () => {
    expect(expression('0 9 * * 1')).toBe('0 9 ? * 2 *');
  });

  it('preserves step and list forms', () => {
    expect(expression('*/5 * * * *')).toBe('*/5 * * * ? *');
    expect(expression('0 0,12 * * *')).toBe('0 0,12 * * ? *');
  });

  it('passes month and day names through', () => {
    expect(expression('0 0 1 JAN *')).toBe('0 0 1 JAN ? *');
    expect(expression('0 0 * * MON')).toBe('0 0 ? * MON *');
  });

  it('leaves an L or # day-of-week untouched rather than remapping it', () => {
    // `6L` and `3#2` are AWS syntax, not Unix. Remapping the number would
    // silently move the schedule by a day.
    expect(expression('0 0 * * 6L')).toBe('0 0 ? * 6L *');
    expect(expression('0 0 * * 3#2')).toBe('0 0 ? * 3#2 *');
  });

  it('rejects both day fields being constrained', () => {
    expect(rejection('0 0 1 * 1')).toContain('only one');
  });

  it('rejects both day fields deferring', () => {
    expect(rejection('0 0 ? * ? *')).toContain('never match');
  });

  it('rejects a wrapped expression rather than double-wrapping it', () => {
    expect(rejection('cron(0 12 * * ? *)')).toContain('wrapper');
    expect(rejection('rate(5 minutes)')).toContain('wrapper');
  });

  it('rejects a Unix day-of-week range that wraps past Sunday', () => {
    // Unix 6-0 would become AWS 7-1, which AWS reads as an empty range, so the
    // schedule would silently never fire.
    expect(rejection('0 0 * * 6-0')).toContain('wraps past Sunday');
  });

  it('names the offending field on an out-of-range value', () => {
    expect(rejection('60 * * * *')).toContain('minute');
    expect(rejection('* 25 * * *')).toContain('hour');
    expect(rejection('* * 32 * *')).toContain('day-of-month');
    expect(rejection('* * * 13 *')).toContain('month');
    expect(rejection('* * * * 8')).toContain('day-of-week');
  });

  it('rejects a zero step and a wrong field count', () => {
    expect(rejection('*/0 * * * *')).toContain('positive');
    expect(rejection('* * *')).toContain('field');
    expect(rejection('@invalid')).toContain('field');
  });

  it('treats blank as blank', () => {
    expect(isBlankCron('')).toBe(true);
    expect(isBlankCron('   ')).toBe(true);
    expect(isBlankCron('\t')).toBe(true);
    expect(isBlankCron('0 12 * * *')).toBe(false);
    // The translator rejects blank rather than inventing a schedule for it. The
    // decision to SKIP a blank node belongs to the caller that owns the spec.
    expect(translateCron('').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property: Unix day-of-week remapping is a bijection onto the AWS days
// Feature: aws-byo-deploy
// ---------------------------------------------------------------------------

describe('Property: Unix day-of-week maps onto AWS 1-7 with 0 and 7 both Sunday', () => {
  it('lands every Unix day in the AWS range (min 100 runs)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 7 }), (unix) => {
        const aws = unixDayOfWeekToAws(unix);
        expect(aws).toBeGreaterThanOrEqual(1);
        expect(aws).toBeLessThanOrEqual(7);
      }),
      { numRuns: 100 },
    );
  });

  it('sends Unix 0 and Unix 7 to the same AWS day', () => {
    expect(unixDayOfWeekToAws(0)).toBe(unixDayOfWeekToAws(7));
    expect(unixDayOfWeekToAws(0)).toBe(1);
  });

  it('is injective across Unix 0-6', () => {
    const mapped = new Set([0, 1, 2, 3, 4, 5, 6].map(unixDayOfWeekToAws));
    expect(mapped.size).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Property: every translation output satisfies the AWS day-field rule
// Feature: aws-byo-deploy
// ---------------------------------------------------------------------------

describe('Property: a translated expression always satisfies the AWS day-field rule', () => {
  /** Field generators that stay inside the AWS ranges. */
  const minute = fc.oneof(
    fc.constant('*'),
    fc.integer({ min: 0, max: 59 }).map(String),
    fc.integer({ min: 1, max: 59 }).map((n) => `*/${n}`),
  );
  const hour = fc.oneof(fc.constant('*'), fc.integer({ min: 0, max: 23 }).map(String));
  const dayOfMonth = fc.oneof(fc.constant('*'), fc.integer({ min: 1, max: 31 }).map(String));
  const month = fc.oneof(fc.constant('*'), fc.integer({ min: 1, max: 12 }).map(String));
  const unixDayOfWeek = fc.oneof(fc.constant('*'), fc.integer({ min: 0, max: 7 }).map(String));

  it('emits six fields with exactly one day field deferring (min 100 runs)', () => {
    fc.assert(
      fc.property(
        minute,
        hour,
        dayOfMonth,
        month,
        unixDayOfWeek,
        (min, hr, dom, mon, dow) => {
          const result = translateCron(`${min} ${hr} ${dom} ${mon} ${dow}`);

          // Both day fields constrained is the one legitimate rejection in this
          // generated space, and it must be reported rather than guessed at.
          if (dom !== '*' && dow !== '*') {
            expect(result.ok).toBe(false);
            return;
          }

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const fields = result.expression.split(' ');
          expect(fields).toHaveLength(6);

          // The invariant AWS enforces: exactly one of the two day fields is `?`.
          const deferring = [fields[2], fields[4]].filter((f) => f === '?');
          expect(deferring).toHaveLength(1);

          // Neither day field is ever left as `*` alongside a `?`-free partner.
          expect(fields[2] === '*' && fields[4] === '*').toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('is idempotent: translating a translated expression changes nothing (min 100 runs)', () => {
    fc.assert(
      fc.property(
        minute,
        hour,
        dayOfMonth,
        month,
        unixDayOfWeek,
        (min, hr, dom, mon, dow) => {
          const first = translateCron(`${min} ${hr} ${dom} ${mon} ${dow}`);
          if (!first.ok) return;

          const second = translateCron(first.expression);
          expect(second.ok).toBe(true);
          if (!second.ok) return;
          expect(second.expression).toBe(first.expression);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property: translation is total
// Feature: aws-byo-deploy
// ---------------------------------------------------------------------------

describe('Property: translateCron is total', () => {
  it('never throws and always explains a rejection (min 100 runs)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 64 }), (candidate) => {
        const result = translateCron(candidate);
        if (!result.ok) {
          // A rejection an operator cannot act on is a defect in its own right.
          expect(result.reason.length).toBeGreaterThan(0);
        } else {
          expect(result.expression.split(' ')).toHaveLength(6);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('never throws on arbitrary whitespace-separated field soup (min 100 runs)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 8 }),
        (fields) => {
          expect(() => translateCron(fields.join(' '))).not.toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });
});
