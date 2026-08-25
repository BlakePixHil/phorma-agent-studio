/**
 * Schedule trigger: converting between a human schedule ("10:00 on weekdays,
 * Australia/Sydney") and the UTC cron expression the deployed runtimes execute.
 *
 * WHY UTC IS THE STORED FORM: both deployed hosts evaluate cron in UTC - the
 * Cloudflare Durable Object through the agents SDK `schedule()`, and AWS through
 * EventBridge Scheduler with `ScheduleExpressionTimezone: 'UTC'`. So the cron on
 * the node stays the executable UTC truth, and the chosen zone is editor state:
 * it is what lets the panel show the schedule in the user's own time and convert
 * back on every edit.
 *
 * KNOWN LIMIT: the conversion is pinned to the zone's offset at the next fire,
 * so a zone that observes daylight saving drifts by an hour after a transition
 * until the schedule is edited again. Fixing that properly needs the runtime to
 * own the timezone, not the studio. The UI states this outright rather than
 * hiding it, and `nextOccurrences` always renders real fire times so the user
 * can see what will actually happen.
 *
 * Pure module: no Angular, no DOM. Unit-tested in `schedule-cron.spec.ts`.
 */

/** Shape of schedule the visual editor can represent. */
export type ScheduleFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';

/** A schedule as the user authored it, in their chosen zone. */
export interface SchedulePlan {
  frequency: ScheduleFrequency;
  /** 0-59. For `hourly` this is the only field that matters. */
  minute: number;
  /** 0-23, local to the plan's zone. Ignored by `hourly`. */
  hour: number;
  /** 0 = Sunday .. 6 = Saturday, local. Only used by `weekly`. */
  weekdays: number[];
  /** 1-31, local. Only used by `monthly`. */
  dayOfMonth: number;
}

const MINUTES_PER_DAY = 1440;

/** The browser's IANA zone, or UTC when the platform will not say. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Every IANA zone this platform knows, alphabetically. UTC-only fallback. */
export function supportedTimeZones(): string[] {
  const withValues = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  try {
    const zones = withValues.supportedValuesOf?.('timeZone');
    if (zones && zones.length > 0) return [...zones].sort();
  } catch {
    // fall through
  }
  return ['UTC'];
}

/**
 * Minutes a zone is ahead of UTC at a given instant (Sydney in winter = +600).
 *
 * Derived by formatting the instant IN the zone and reading the wall-clock back
 * as if it were UTC: the difference is the offset. This is the only approach
 * that works for every zone without shipping a timezone database, and it picks
 * up daylight saving automatically because the offset is asked for at a specific
 * instant rather than in the abstract.
 */
export function zoneOffsetMinutes(timeZone: string, at: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);

    const read = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find(part => part.type === type)?.value ?? '0');

    const asUtc = Date.UTC(
      read('year'),
      read('month') - 1,
      read('day'),
      read('hour'),
      read('minute'),
      read('second'),
    );
    // The formatter resolves to whole seconds, so truncate the instant to
    // seconds too before differencing - otherwise sub-second drift can round the
    // offset to the wrong minute for the handful of zones on :30 or :45.
    const atWholeSeconds = Math.floor(at.getTime() / 1000) * 1000;
    return Math.round((asUtc - atWholeSeconds) / 60000);
  } catch {
    return 0;
  }
}

/** `UTC+10:00` / `UTC-04:30` / `UTC` for a zone at an instant. */
export function formatZoneOffset(timeZone: string, at: Date = new Date()): string {
  const offset = zoneOffsetMinutes(timeZone, at);
  if (offset === 0) return 'UTC';
  const sign = offset > 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}

/**
 * Whether a zone's offset changes across the coming year - i.e. whether the
 * daylight-saving caveat applies to it at all. Sampling the first of each month
 * is enough: a transition always falls inside one of those gaps.
 */
export function zoneObservesDst(timeZone: string, from: Date = new Date()): boolean {
  const base = zoneOffsetMinutes(timeZone, from);
  for (let month = 1; month <= 12; month += 1) {
    const probe = new Date(from.getTime());
    probe.setUTCMonth(probe.getUTCMonth() + month, 1);
    if (zoneOffsetMinutes(timeZone, probe) !== base) return true;
  }
  return false;
}

// ── Cron field helpers ──────────────────────────────────────────────────────

/** Splits a 5-field cron, or null when it is not 5 fields. */
function cronFields(cron: string): [string, string, string, string, string] | null {
  const parts = cron.trim().split(/\s+/);
  return parts.length === 5 ? (parts as [string, string, string, string, string]) : null;
}

/** A single integer field, or null for anything else (`*`, list, range, step). */
function soleNumber(field: string): number | null {
  return /^\d+$/.test(field) ? Number(field) : null;
}

// Expands a cron field into concrete values within a range: `1-5`, `0,6`, a
// bare number, a wildcard, and step syntax such as `*` followed by `/2`.
// (Written as a line comment on purpose - a literal step token inside a block
// comment closes it early and takes the rest of the file with it.)
function expandField(field: string, min: number, max: number): number[] {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const step = /^(.*)\/(\d+)$/.exec(part);
    const body = step ? step[1] : part;
    const stride = step ? Number(step[2]) : 1;
    if (stride <= 0) continue;

    let lo = min;
    let hi = max;
    if (body !== '*' && body !== '?') {
      const range = /^(\d+)-(\d+)$/.exec(body);
      if (range) {
        lo = Number(range[1]);
        hi = Number(range[2]);
      } else if (/^\d+$/.test(body)) {
        lo = Number(body);
        hi = step ? max : lo;
      } else {
        continue; // unsupported token - contributes nothing
      }
    }
    // A wrapping range (`6-0` for Sat..Sun) walks up and over the top.
    if (lo > hi) {
      for (let v = lo; v <= max; v += stride) out.add(v);
      for (let v = min; v <= hi; v += stride) out.add(v);
      continue;
    }
    for (let v = lo; v <= hi; v += stride) {
      if (v >= min && v <= max) out.add(v);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Weekday list from a cron day-of-week field, normalising cron's 7 to 0. */
function expandWeekdays(field: string): number[] {
  return [...new Set(expandField(field, 0, 7).map(day => day % 7))].sort((a, b) => a - b);
}

// ── UTC cron <-> local plan ─────────────────────────────────────────────────

/** Shifts a local wall-clock time into UTC, reporting the day carry. */
function toUtcTime(
  hour: number,
  minute: number,
  offsetMinutes: number,
): { hour: number; minute: number; dayShift: number } {
  const total = hour * 60 + minute - offsetMinutes;
  const dayShift = Math.floor(total / MINUTES_PER_DAY);
  const within = ((total % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return { hour: Math.floor(within / 60), minute: within % 60, dayShift };
}

/** Shifts a UTC wall-clock time into a zone, reporting the day carry. */
function toLocalTime(
  hour: number,
  minute: number,
  offsetMinutes: number,
): { hour: number; minute: number; dayShift: number } {
  return toUtcTime(hour, minute, -offsetMinutes);
}

/** The default plan for a frequency, used when switching the segmented control. */
export function defaultPlan(frequency: ScheduleFrequency): SchedulePlan {
  return {
    frequency,
    minute: 0,
    hour: 9,
    weekdays: [1, 2, 3, 4, 5],
    dayOfMonth: 1,
  };
}

/**
 * Reads a UTC cron back into a plan expressed in `timeZone`. Returns a
 * `custom` plan for anything the visual editor cannot represent faithfully -
 * showing an approximation of a cron the user hand-wrote would be worse than
 * handing them the raw field.
 */
export function parseSchedule(
  cron: string,
  timeZone: string,
  at: Date = new Date(),
): SchedulePlan {
  const fields = cronFields(cron);
  if (!fields) return { ...defaultPlan('custom') };
  const [minuteField, hourField, domField, monthField, dowField] = fields;

  // Any month restriction is beyond the four visual shapes.
  if (monthField !== '*') return { ...defaultPlan('custom') };

  const minute = soleNumber(minuteField);
  if (minute === null || minute > 59) return { ...defaultPlan('custom') };

  // Hourly: every hour, at a fixed minute.
  if (hourField === '*') {
    if (domField !== '*' || dowField !== '*') return { ...defaultPlan('custom') };
    return { ...defaultPlan('hourly'), minute };
  }

  const utcHour = soleNumber(hourField);
  if (utcHour === null || utcHour > 23) return { ...defaultPlan('custom') };

  const offset = zoneOffsetMinutes(timeZone, at);
  const local = toLocalTime(utcHour, minute, offset);

  // Weekly: a day-of-week restriction, every month, any day-of-month.
  if (dowField !== '*' && domField === '*') {
    const utcDays = expandWeekdays(dowField);
    if (utcDays.length === 0) return { ...defaultPlan('custom') };
    const weekdays = [...new Set(utcDays.map(day => (day + local.dayShift + 7) % 7))].sort(
      (a, b) => a - b,
    );
    return { ...defaultPlan('weekly'), minute: local.minute, hour: local.hour, weekdays };
  }

  // Monthly: a fixed day-of-month.
  if (domField !== '*' && dowField === '*') {
    const utcDom = soleNumber(domField);
    if (utcDom === null || utcDom < 1 || utcDom > 31) return { ...defaultPlan('custom') };
    return {
      ...defaultPlan('monthly'),
      minute: local.minute,
      hour: local.hour,
      dayOfMonth: shiftDayOfMonth(utcDom, local.dayShift),
    };
  }

  // Daily: no day restriction at all.
  if (domField === '*' && dowField === '*') {
    return { ...defaultPlan('daily'), minute: local.minute, hour: local.hour };
  }

  return { ...defaultPlan('custom') };
}

/** Wraps a day-of-month by a +/-1 day carry, staying inside 1-31. */
function shiftDayOfMonth(day: number, shift: number): number {
  const shifted = day + shift;
  if (shifted < 1) return 31;
  if (shifted > 31) return 1;
  return shifted;
}

/**
 * Builds the UTC cron for a plan authored in `timeZone`. `custom` has no
 * representation here - the caller keeps the user's raw expression.
 */
export function buildScheduleCron(
  plan: SchedulePlan,
  timeZone: string,
  at: Date = new Date(),
): string {
  const minute = clamp(plan.minute, 0, 59);

  if (plan.frequency === 'hourly') return `${minute} * * * *`;

  const hour = clamp(plan.hour, 0, 23);
  const offset = zoneOffsetMinutes(timeZone, at);
  const utc = toUtcTime(hour, minute, offset);

  switch (plan.frequency) {
    case 'daily':
      return `${utc.minute} ${utc.hour} * * *`;
    case 'weekly': {
      const days = plan.weekdays.length > 0 ? plan.weekdays : [1];
      const utcDays = [...new Set(days.map(day => (day + utc.dayShift + 7) % 7))].sort(
        (a, b) => a - b,
      );
      return `${utc.minute} ${utc.hour} * * ${utcDays.join(',')}`;
    }
    case 'monthly': {
      const dom = shiftDayOfMonth(clamp(plan.dayOfMonth, 1, 31), utc.dayShift);
      return `${utc.minute} ${utc.hour} ${dom} * *`;
    }
    default:
      return `${minute} ${hour} * * *`;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

// ── Next fire times ─────────────────────────────────────────────────────────

/** Whether a UTC instant satisfies a 5-field cron. */
function matchesCron(cron: string, at: Date): boolean {
  const fields = cronFields(cron);
  if (!fields) return false;
  const [minuteField, hourField, domField, monthField, dowField] = fields;

  if (!expandField(minuteField, 0, 59).includes(at.getUTCMinutes())) return false;
  if (!expandField(hourField, 0, 23).includes(at.getUTCHours())) return false;
  if (!expandField(monthField, 1, 12).includes(at.getUTCMonth() + 1)) return false;

  // Standard cron semantics: with BOTH day fields restricted, either matching is
  // enough; with one restricted, only that one applies.
  const domRestricted = domField !== '*' && domField !== '?';
  const dowRestricted = dowField !== '*' && dowField !== '?';
  const domHit = expandField(domField, 1, 31).includes(at.getUTCDate());
  const dowHit = expandWeekdays(dowField).includes(at.getUTCDay());

  if (domRestricted && dowRestricted) return domHit || dowHit;
  if (domRestricted) return domHit;
  if (dowRestricted) return dowHit;
  return true;
}

/**
 * The next `count` UTC instants a cron fires, walking minute by minute from the
 * next whole minute. Bounded at 400 days of steps so a cron that can never match
 * (29 February in a non-leap window, say) returns what it found instead of
 * spinning - this runs inside a properties panel, not a scheduler.
 */
export function nextOccurrences(
  cron: string,
  count = 3,
  from: Date = new Date(),
): Date[] {
  if (!cronFields(cron)) return [];
  const out: Date[] = [];
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  const limit = 400 * MINUTES_PER_DAY;
  for (let step = 0; step < limit && out.length < count; step += 1) {
    if (matchesCron(cron, cursor)) out.push(new Date(cursor.getTime()));
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return out;
}

/** `Tue 26 Aug, 10:00` for an instant rendered in a zone. */
export function formatInZone(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(at);
  } catch {
    return at.toISOString();
  }
}

/** Short weekday names, Sunday first, matching `SchedulePlan.weekdays`. */
export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Single letters for the day toggles, Sunday first. */
export const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** Plain-English summary of a plan, in its own zone. */
export function describePlan(plan: SchedulePlan, timeZone: string): string {
  const time = `${String(clamp(plan.hour, 0, 23)).padStart(2, '0')}:${String(
    clamp(plan.minute, 0, 59),
  ).padStart(2, '0')}`;
  const zone = timeZone.replace(/_/g, ' ');

  switch (plan.frequency) {
    case 'hourly':
      return `Every hour at :${String(clamp(plan.minute, 0, 59)).padStart(2, '0')}`;
    case 'daily':
      return `Every day at ${time} ${zone}`;
    case 'weekly': {
      const days = [...plan.weekdays].sort((a, b) => a - b);
      if (days.length === 0) return `Pick at least one day`;
      const named =
        days.length === 7
          ? 'every day'
          : days.length === 5 && days.every(d => d >= 1 && d <= 5)
            ? 'weekdays'
            : days.length === 2 && days.includes(0) && days.includes(6)
              ? 'weekends'
              : days.map(d => WEEKDAY_LABELS[d]).join(', ');
      return `At ${time} ${zone}, ${named}`;
    }
    case 'monthly': {
      const day = clamp(plan.dayOfMonth, 1, 31);
      return `Day ${day} of every month at ${time} ${zone}`;
    }
    default:
      return 'Custom cron expression';
  }
}
