/**
 * Cron translation: a workflow's `schedule-trigger` cron to an EventBridge
 * Scheduler `ScheduleExpression` body.
 *
 * This module exists because the two dialects genuinely differ, and the previous
 * arrangement had them backwards. A user types a five-field Unix cron in the
 * properties panel. EventBridge Scheduler takes SIX fields, numbers
 * day-of-week 1-7 with 1 = Sunday rather than Unix's 0-6, and refuses `*` in
 * BOTH the day-of-month and day-of-week fields: whichever one is not being
 * constrained must carry `?`.
 *
 * Together those three rules mean the single most common expression a user can
 * write, `0 12 * * *` (noon daily), becomes `cron(0 12 * * * *)` under a naive
 * "append a year wildcard" translation, and AWS rejects it. The previous
 * validator additionally rejected `?` outright, so an operator who worked out
 * the AWS dialect for themselves was refused before the call was even made.
 * Both directions were closed, which is why no cron ever deployed.
 *
 * The rule set lives here, in `core/`, because it must hold for all inputs and
 * is pure. `aws/scheduler-backend.ts` owns only the `cron(...)` wrapper, which
 * is an API-shape concern.
 *
 * What is accepted:
 *
 * - Five fields, read as Unix: `minute hour day-of-month month day-of-week`.
 *   Day-of-week is remapped from Unix to AWS numbering, a year wildcard is
 *   appended, and the day fields are reconciled as described below.
 * - Six fields, read as already-AWS: `minute hour day-of-month month
 *   day-of-week year`. Numbers pass through unremapped, because an expression
 *   carrying six fields is stating the AWS dialect on purpose.
 *
 * Day-field reconciliation, applied to both arities:
 *
 * | day-of-month | day-of-week | Result |
 * |---|---|---|
 * | `*` | `*` | `*` and `?` - the every-day case, constrained on neither |
 * | `*` | specified | `?` and the value - a weekly schedule |
 * | specified | `*` | the value and `?` - a monthly schedule |
 * | `?` | specified | unchanged |
 * | specified | `?` | unchanged |
 * | specified | specified | rejected, naming both fields |
 * | `?` | `?` | rejected - nothing would ever match |
 *
 * Feature: aws-byo-deploy
 */

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/** A successful translation, carrying the six-field AWS expression body. */
export interface CronTranslationOk {
  readonly ok: true;
  /**
   * The six AWS fields, space separated, with NO `cron(...)` wrapper. The
   * wrapper belongs to the Scheduler API and is added by
   * `aws/scheduler-backend.ts`.
   */
  readonly expression: string;
}

/** A rejected translation. `reason` is operator-facing prose. */
export interface CronTranslationError {
  readonly ok: false;
  readonly reason: string;
}

export type CronTranslation = CronTranslationOk | CronTranslationError;

/**
 * The translation seam. `SchedulerAdapter` takes one so a test can drive the
 * adapter's ordering, retry and rollback paths without also exercising cron
 * semantics.
 */
export type CronTranslator = (cron: string) => CronTranslation;

// ---------------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------------

/** Month names AWS accepts in the month field, index 0 being January. */
export const MONTH_NAMES: readonly string[] = Object.freeze([
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
]);

/**
 * Day names AWS accepts in the day-of-week field, index 0 being Sunday, which
 * is AWS number 1.
 */
export const DAY_NAMES: readonly string[] = Object.freeze([
  'SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT',
]);

interface FieldSpec {
  /** Operator-facing field name, used verbatim in rejection prose. */
  readonly name: string;
  readonly min: number;
  readonly max: number;
  /** Names accepted in place of numbers, lower bound aligned to `min`. */
  readonly names?: readonly string[];
  /** Whether `?` is a legal value for this field. */
  readonly allowQuestion?: boolean;
  /** Whether `L` may appear, alone or as a suffix. */
  readonly allowLast?: boolean;
  /** Whether the `W` nearest-weekday suffix may appear. */
  readonly allowWeekday?: boolean;
  /** Whether the `n#m` nth-weekday-of-month form may appear. */
  readonly allowHash?: boolean;
  /** Whether a `/step` increment may appear. */
  readonly allowStep?: boolean;
}

const MINUTE: FieldSpec = { name: 'minute', min: 0, max: 59, allowStep: true };
const HOUR: FieldSpec = { name: 'hour', min: 0, max: 23, allowStep: true };
const DAY_OF_MONTH: FieldSpec = {
  name: 'day-of-month',
  min: 1,
  max: 31,
  allowQuestion: true,
  allowLast: true,
  allowWeekday: true,
  allowStep: true,
};
const MONTH: FieldSpec = {
  name: 'month',
  min: 1,
  max: 12,
  names: MONTH_NAMES,
  allowStep: true,
};
const DAY_OF_WEEK: FieldSpec = {
  name: 'day-of-week',
  min: 1,
  max: 7,
  names: DAY_NAMES,
  allowQuestion: true,
  allowLast: true,
  allowHash: true,
};
const YEAR: FieldSpec = { name: 'year', min: 1970, max: 2199, allowStep: true };

/** Field order of an AWS six-field cron. */
const AWS_FIELDS: readonly FieldSpec[] = Object.freeze([
  MINUTE, HOUR, DAY_OF_MONTH, MONTH, DAY_OF_WEEK, YEAR,
]);

/** Positions within the six-field form. */
const DOM_INDEX = 2;
const DOW_INDEX = 4;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** A cron field is blank when it is empty or whitespace only. */
export function isBlankCron(cron: string): boolean {
  return cron.trim().length === 0;
}

/**
 * Translate a workflow cron into the AWS six-field form, or explain why it
 * cannot be translated.
 *
 * Total: every input yields a result and nothing throws. A blank expression is
 * rejected here rather than silently skipped, because skipping is a decision for
 * the caller that owns the spec (`SchedulerAdapter.sync` treats blank as "this
 * node is not scheduled") and not for the translator.
 */
export function translateCron(cron: string): CronTranslation {
  const trimmed = cron.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'The cron expression is blank.' };
  }

  // A wrapper is the Scheduler API's shape, not a cron expression. Accepting one
  // here would let a wrapped value reach the backend and be wrapped twice.
  if (/^(cron|rate|at)\s*\(/i.test(trimmed)) {
    return {
      ok: false,
      reason:
        `The cron expression "${trimmed}" carries a cron(...), rate(...) or at(...) wrapper. ` +
        'Supply the fields alone, for example "0 12 * * *".',
    };
  }

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    return {
      ok: false,
      reason:
        `The cron expression "${trimmed}" has ${fields.length} ` +
        `field${fields.length === 1 ? '' : 's'}. Supply 5 Unix fields ` +
        '(minute hour day-of-month month day-of-week) or 6 AWS fields ' +
        '(with a trailing year).',
    };
  }

  // Five fields are Unix, so day-of-week is remapped onto AWS numbering. Six
  // fields are taken as already-AWS and pass through unremapped.
  const isUnix = fields.length === 5;
  const working = isUnix ? [...fields, '*'] : [...fields];

  if (isUnix) {
    const remapped = remapUnixDayOfWeek(working[DOW_INDEX]!);
    if (!remapped.ok) return remapped;
    working[DOW_INDEX] = remapped.expression;
  }

  const reconciled = reconcileDayFields(working[DOM_INDEX]!, working[DOW_INDEX]!);
  if (!reconciled.ok) return reconciled;
  working[DOM_INDEX] = reconciled.dayOfMonth;
  working[DOW_INDEX] = reconciled.dayOfWeek;

  for (let i = 0; i < AWS_FIELDS.length; i++) {
    const reason = validateField(working[i]!, AWS_FIELDS[i]!);
    if (reason !== undefined) return { ok: false, reason };
  }

  return { ok: true, expression: working.join(' ') };
}

// ---------------------------------------------------------------------------
// Unix day-of-week remapping
// ---------------------------------------------------------------------------

/**
 * Unix numbers day-of-week 0-6 from Sunday and also accepts 7 for Sunday. AWS
 * numbers 1-7 from Sunday. So AWS = (Unix mod 7) + 1, which maps both Unix 0
 * and Unix 7 onto AWS 1.
 */
export function unixDayOfWeekToAws(value: number): number {
  return (value % 7) + 1;
}

/**
 * Remap the numbers inside a Unix day-of-week field.
 *
 * A field carrying `L` or `#` is passed through untouched: neither is Unix
 * syntax, so its presence means the operator is writing the AWS dialect in a
 * five-field expression, and remapping `6L` from "Saturday" to "Sunday" would
 * silently move their schedule. Names (`MON`) are also left alone, since both
 * dialects spell them the same way.
 */
function remapUnixDayOfWeek(field: string): CronTranslation {
  if (field === '*' || field === '?') return { ok: true, expression: field };
  if (/[L#]/i.test(field) || /[A-Za-z]/.test(field)) {
    return { ok: true, expression: field };
  }

  const items = field.split(',');
  const mapped: string[] = [];

  for (const item of items) {
    const [base, ...stepRest] = item.split('/');
    if (stepRest.length > 1) {
      return { ok: false, reason: dayOfWeekReason(field, `"${item}" has more than one "/".`) };
    }
    const step = stepRest[0];
    const mappedBase = remapDayOfWeekBase(base ?? '', field);
    if (!mappedBase.ok) return mappedBase;
    mapped.push(step === undefined ? mappedBase.expression : `${mappedBase.expression}/${step}`);
  }

  return { ok: true, expression: mapped.join(',') };
}

function remapDayOfWeekBase(base: string, field: string): CronTranslation {
  if (base === '*') return { ok: true, expression: '*' };

  const range = base.split('-');
  if (range.length === 2) {
    const from = parseUnixDayOfWeek(range[0]!);
    const to = parseUnixDayOfWeek(range[1]!);
    if (from === undefined || to === undefined) {
      return {
        ok: false,
        reason: dayOfWeekReason(field, `"${base}" is not a range of days 0-7.`),
      };
    }
    const mappedFrom = unixDayOfWeekToAws(from);
    const mappedTo = unixDayOfWeekToAws(to);
    if (mappedFrom > mappedTo) {
      // Unix 6-0 (Saturday to Sunday) becomes AWS 7-1, which AWS reads as an
      // empty range rather than a wrap. Rejecting beats silently never firing.
      return {
        ok: false,
        reason: dayOfWeekReason(
          field,
          `"${base}" wraps past Sunday, which AWS cannot express as a range. ` +
            `Write it as a list, for example "${mappedTo},${mappedFrom}" in AWS ` +
            'numbering where 1 is Sunday.',
        ),
      };
    }
    return { ok: true, expression: `${mappedFrom}-${mappedTo}` };
  }
  if (range.length > 2) {
    return { ok: false, reason: dayOfWeekReason(field, `"${base}" has more than one "-".`) };
  }

  const single = parseUnixDayOfWeek(base);
  if (single === undefined) {
    return { ok: false, reason: dayOfWeekReason(field, `"${base}" is not a day 0-7.`) };
  }
  return { ok: true, expression: String(unixDayOfWeekToAws(single)) };
}

/** A Unix day-of-week number is 0-7, where both 0 and 7 mean Sunday. */
function parseUnixDayOfWeek(text: string): number | undefined {
  if (!/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return value >= 0 && value <= 7 ? value : undefined;
}

function dayOfWeekReason(field: string, detail: string): string {
  return `The day-of-week field "${field}" cannot be read as Unix days: ${detail}`;
}

// ---------------------------------------------------------------------------
// Day-field reconciliation
// ---------------------------------------------------------------------------

interface DayFieldsOk {
  readonly ok: true;
  readonly dayOfMonth: string;
  readonly dayOfWeek: string;
}

/**
 * Apply the AWS rule that exactly one of day-of-month and day-of-week is
 * constrained. See the table in the module header.
 */
function reconcileDayFields(
  dayOfMonth: string,
  dayOfWeek: string,
): DayFieldsOk | CronTranslationError {
  const domAny = dayOfMonth === '?';
  const dowAny = dayOfWeek === '?';

  if (domAny && dowAny) {
    return {
      ok: false,
      reason:
        'Both day-of-month and day-of-week are "?", so the schedule would never ' +
        'match a date. Constrain one of them, or use "*" for every day.',
    };
  }

  // One side already defers, so the operator has stated the pairing.
  if (domAny || dowAny) return { ok: true, dayOfMonth, dayOfWeek };

  const domStar = dayOfMonth === '*';
  const dowStar = dayOfWeek === '*';

  // Every day. AWS needs one side to defer, and day-of-month is the one kept
  // open so the expression reads as "every date".
  if (domStar && dowStar) return { ok: true, dayOfMonth: '*', dayOfWeek: '?' };

  // Weekly: the day-of-week carries the constraint.
  if (domStar) return { ok: true, dayOfMonth: '?', dayOfWeek };

  // Monthly: the day-of-month carries the constraint.
  if (dowStar) return { ok: true, dayOfMonth, dayOfWeek: '?' };

  return {
    ok: false,
    reason:
      `Both day-of-month ("${dayOfMonth}") and day-of-week ("${dayOfWeek}") are ` +
      'constrained. AWS accepts only one: set the other to "*" and it will be ' +
      'converted to "?".',
  };
}

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

/** Validate one AWS field. Returns a reason on failure, `undefined` on success. */
function validateField(field: string, spec: FieldSpec): string | undefined {
  if (field.length === 0) return `The ${spec.name} field is empty.`;

  if (field === '?') {
    return spec.allowQuestion
      ? undefined
      : `"?" is not valid in the ${spec.name} field.`;
  }

  for (const item of field.split(',')) {
    const reason = validateItem(item, spec, field);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

function validateItem(item: string, spec: FieldSpec, field: string): string | undefined {
  if (item.length === 0) {
    return `The ${spec.name} field "${field}" has an empty list entry.`;
  }

  const parts = item.split('/');
  if (parts.length > 2) {
    return `The ${spec.name} field "${field}" has more than one "/" in "${item}".`;
  }
  const base = parts[0]!;
  const step = parts[1];

  if (step !== undefined) {
    if (!spec.allowStep) {
      return `A "/" increment is not valid in the ${spec.name} field.`;
    }
    if (!/^\d+$/.test(step) || Number(step) === 0) {
      return `The ${spec.name} step "${step}" must be a positive whole number.`;
    }
  }

  return validateBase(base, spec, field, item);
}

function validateBase(
  base: string,
  spec: FieldSpec,
  field: string,
  item: string,
): string | undefined {
  if (base === '*') return undefined;

  if (base === '?') {
    return spec.allowQuestion
      ? undefined
      : `"?" is not valid in the ${spec.name} field.`;
  }

  // `L` alone: last day of month, or last day of week.
  if (spec.allowLast && /^L$/i.test(base)) return undefined;
  // `LW`: last weekday of the month.
  if (spec.allowLast && spec.allowWeekday && /^LW$/i.test(base)) return undefined;
  // `nL`: the last given weekday of the month, for example `6L`.
  if (spec.allowLast && /^(\d+)L$/i.test(base)) {
    const value = Number(/^(\d+)L$/i.exec(base)![1]);
    return inRange(value, spec) ? undefined : outOfRange(value, spec, field);
  }
  // `nW`: the weekday nearest the nth of the month.
  if (spec.allowWeekday && /^(\d+)W$/i.test(base)) {
    const value = Number(/^(\d+)W$/i.exec(base)![1]);
    return inRange(value, spec) ? undefined : outOfRange(value, spec, field);
  }
  // `n#m`: the mth given weekday of the month, for example `3#2`.
  if (spec.allowHash && base.includes('#')) {
    const hash = /^(\d+)#(\d+)$/.exec(base);
    if (!hash) {
      return `The ${spec.name} entry "${base}" is not of the form "day#occurrence".`;
    }
    const day = Number(hash[1]);
    const occurrence = Number(hash[2]);
    if (!inRange(day, spec)) return outOfRange(day, spec, field);
    if (occurrence < 1 || occurrence > 5) {
      return `The ${spec.name} occurrence "${occurrence}" in "${base}" must be 1-5.`;
    }
    return undefined;
  }

  const range = base.split('-');
  if (range.length === 2) {
    const from = parseValue(range[0]!, spec);
    const to = parseValue(range[1]!, spec);
    if (from === undefined || to === undefined) {
      return `The ${spec.name} range "${base}" is not a range of valid values.`;
    }
    if (!inRange(from, spec)) return outOfRange(from, spec, field);
    if (!inRange(to, spec)) return outOfRange(to, spec, field);
    if (from > to) {
      return `The ${spec.name} range "${base}" runs backwards.`;
    }
    return undefined;
  }
  if (range.length > 2) {
    return `The ${spec.name} entry "${base}" has more than one "-".`;
  }

  const value = parseValue(base, spec);
  if (value === undefined) {
    return `The ${spec.name} entry "${base}" in "${item}" is not a valid value.`;
  }
  return inRange(value, spec) ? undefined : outOfRange(value, spec, field);
}

/** Parse a numeric or named field value into its number. */
function parseValue(text: string, spec: FieldSpec): number | undefined {
  if (/^\d+$/.test(text)) return Number(text);
  if (spec.names) {
    const index = spec.names.indexOf(text.toUpperCase());
    if (index >= 0) return index + spec.min;
  }
  return undefined;
}

function inRange(value: number, spec: FieldSpec): boolean {
  return value >= spec.min && value <= spec.max;
}

function outOfRange(value: number, spec: FieldSpec, field: string): string {
  return (
    `The ${spec.name} value ${value} in "${field}" is outside the accepted ` +
    `range ${spec.min}-${spec.max}.`
  );
}
