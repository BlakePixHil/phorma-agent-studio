import {
  buildScheduleCron,
  defaultPlan,
  describePlan,
  formatZoneOffset,
  nextOccurrences,
  parseSchedule,
  zoneObservesDst,
  zoneOffsetMinutes,
  type SchedulePlan,
} from './schedule-cron';

/**
 * The schedule editor authors in a zone; the runtime executes UTC. Every claim
 * here is about that boundary, because getting it wrong means a job that fires
 * at the wrong hour - the exact bug a user hit asking for "10am AEST".
 *
 * Fixed instants, never `new Date()`: a test that silently changes meaning at a
 * DST transition is worse than no test.
 */

/** Southern-hemisphere DST: +10:00 in July (AEST), +11:00 in January (AEDT). */
const SYDNEY = 'Australia/Sydney';
/** Northern-hemisphere DST, and a zone west of UTC. */
const NEW_YORK = 'America/New_York';
/** A half-hour zone, which catches minute-level rounding in the offset maths. */
const KOLKATA = 'Asia/Kolkata';
/** No DST at all. */
const BRISBANE = 'Australia/Brisbane';

const JULY = new Date('2026-07-15T00:00:00Z');
const JANUARY = new Date('2026-01-15T00:00:00Z');

function plan(overrides: Partial<SchedulePlan>): SchedulePlan {
  return { ...defaultPlan('daily'), ...overrides };
}

describe('zoneOffsetMinutes', () => {
  it('reads whole-hour offsets on both sides of UTC', () => {
    expect(zoneOffsetMinutes(SYDNEY, JULY)).toBe(600);
    expect(zoneOffsetMinutes(NEW_YORK, JULY)).toBe(-240);
    expect(zoneOffsetMinutes('UTC', JULY)).toBe(0);
  });

  it('reads half-hour offsets exactly', () => {
    expect(zoneOffsetMinutes(KOLKATA, JULY)).toBe(330);
  });

  it('follows daylight saving, per hemisphere', () => {
    expect(zoneOffsetMinutes(SYDNEY, JANUARY)).toBe(660);
    expect(zoneOffsetMinutes(NEW_YORK, JANUARY)).toBe(-300);
  });

  it('falls back to UTC for an unknown zone instead of throwing', () => {
    expect(zoneOffsetMinutes('Not/AZone', JULY)).toBe(0);
  });
});

describe('formatZoneOffset', () => {
  it('renders sign, hours and minutes', () => {
    expect(formatZoneOffset(SYDNEY, JULY)).toBe('UTC+10:00');
    expect(formatZoneOffset(NEW_YORK, JULY)).toBe('UTC-04:00');
    expect(formatZoneOffset(KOLKATA, JULY)).toBe('UTC+05:30');
  });

  it('renders plain UTC with no offset', () => {
    expect(formatZoneOffset('UTC', JULY)).toBe('UTC');
  });
});

describe('zoneObservesDst', () => {
  it('is true for a zone that shifts and false for one that does not', () => {
    expect(zoneObservesDst(SYDNEY, JULY)).toBe(true);
    expect(zoneObservesDst(NEW_YORK, JULY)).toBe(true);
    expect(zoneObservesDst(BRISBANE, JULY)).toBe(false);
    expect(zoneObservesDst('UTC', JULY)).toBe(false);
  });
});

describe('buildScheduleCron', () => {
  it('converts a local daily time into UTC', () => {
    // 10:00 Sydney in July (+10) is 00:00 UTC the same day.
    expect(buildScheduleCron(plan({ hour: 10, minute: 0 }), SYDNEY, JULY)).toBe('0 0 * * *');
  });

  it('carries the date backwards when the local time is before the offset', () => {
    // 08:00 Sydney (+10) is 22:00 UTC the PREVIOUS day.
    expect(buildScheduleCron(plan({ hour: 8, minute: 0 }), SYDNEY, JULY)).toBe('0 22 * * *');
  });

  it('carries the date forwards for a zone west of UTC', () => {
    // 21:00 New York (-4) is 01:00 UTC the NEXT day.
    expect(buildScheduleCron(plan({ hour: 21, minute: 0 }), NEW_YORK, JULY)).toBe('0 1 * * *');
  });

  it('handles a half-hour zone', () => {
    // 10:00 Kolkata (+5:30) is 04:30 UTC.
    expect(buildScheduleCron(plan({ hour: 10, minute: 0 }), KOLKATA, JULY)).toBe('30 4 * * *');
  });

  it('rotates weekdays when the UTC time lands on the previous day', () => {
    // 08:00 Mon-Fri Sydney becomes 22:00 Sun-Thu UTC.
    const cron = buildScheduleCron(
      plan({ frequency: 'weekly', hour: 8, minute: 0, weekdays: [1, 2, 3, 4, 5] }),
      SYDNEY,
      JULY,
    );
    expect(cron).toBe('0 22 * * 0,1,2,3,4');
  });

  it('leaves weekdays alone when the day does not carry', () => {
    const cron = buildScheduleCron(
      plan({ frequency: 'weekly', hour: 12, minute: 30, weekdays: [1, 5] }),
      SYDNEY,
      JULY,
    );
    expect(cron).toBe('30 2 * * 1,5');
  });

  it('ignores the hour for an hourly schedule', () => {
    expect(buildScheduleCron(plan({ frequency: 'hourly', minute: 15, hour: 9 }), SYDNEY, JULY)).toBe(
      '15 * * * *',
    );
  });

  it('shifts the day of month with the date carry', () => {
    // Day 1 at 08:00 Sydney is day 31 (previous month) at 22:00 UTC.
    expect(
      buildScheduleCron(plan({ frequency: 'monthly', dayOfMonth: 1, hour: 8 }), SYDNEY, JULY),
    ).toBe('0 22 31 * *');
    expect(
      buildScheduleCron(plan({ frequency: 'monthly', dayOfMonth: 10, hour: 12 }), SYDNEY, JULY),
    ).toBe('0 2 10 * *');
  });

  it('clamps out-of-range input rather than emitting a broken cron', () => {
    expect(buildScheduleCron(plan({ hour: 99, minute: -5 }), 'UTC', JULY)).toBe('0 23 * * *');
    expect(
      buildScheduleCron(plan({ frequency: 'monthly', dayOfMonth: 99, hour: 0 }), 'UTC', JULY),
    ).toBe('0 0 31 * *');
  });

  it('falls back to at least one day when a weekly plan has none selected', () => {
    const cron = buildScheduleCron(
      plan({ frequency: 'weekly', weekdays: [], hour: 12 }),
      'UTC',
      JULY,
    );
    expect(cron).toBe('0 12 * * 1');
  });
});

describe('parseSchedule', () => {
  it('round-trips every visual frequency through UTC and back', () => {
    const cases: SchedulePlan[] = [
      plan({ frequency: 'hourly', minute: 20 }),
      plan({ frequency: 'daily', hour: 10, minute: 0 }),
      plan({ frequency: 'daily', hour: 8, minute: 45 }),
      plan({ frequency: 'weekly', hour: 8, minute: 0, weekdays: [1, 2, 3, 4, 5] }),
      plan({ frequency: 'weekly', hour: 23, minute: 30, weekdays: [0, 6] }),
      plan({ frequency: 'monthly', hour: 8, minute: 0, dayOfMonth: 10 }),
    ];

    for (const zone of [SYDNEY, NEW_YORK, KOLKATA, 'UTC']) {
      for (const original of cases) {
        const cron = buildScheduleCron(original, zone, JULY);
        const parsed = parseSchedule(cron, zone, JULY);
        expect(parsed.frequency).toBe(original.frequency);
        if (original.frequency !== 'hourly') expect(parsed.hour).toBe(original.hour);
        expect(parsed.minute).toBe(original.minute);
        if (original.frequency === 'weekly') {
          expect(parsed.weekdays).toEqual([...original.weekdays].sort((a, b) => a - b));
        }
        if (original.frequency === 'monthly') {
          expect(parsed.dayOfMonth).toBe(original.dayOfMonth);
        }
      }
    }
  });

  it('reads a UTC cron into the local hour', () => {
    // 00:00 UTC is 10:00 Sydney in July.
    const parsed = parseSchedule('0 0 * * *', SYDNEY, JULY);
    expect(parsed.frequency).toBe('daily');
    expect(parsed.hour).toBe(10);
    expect(parsed.minute).toBe(0);
  });

  // Anything the four visual shapes cannot express must fall through to the raw
  // cron field: showing an approximation of a hand-written expression, then
  // rewriting it on the next edit, would silently destroy the user's schedule.
  const customCases = [
    '*/5 * * * *', // step minutes
    '0 9-17 * * *', // hour range
    '0 9 * 1 *', // month restriction
    '0 9 1 * 1', // both day fields
    '0 9 * *', // too few fields
    'not a cron',
    '',
  ];

  for (const cron of customCases) {
    it(`treats "${cron}" as custom`, () => {
      expect(parseSchedule(cron, SYDNEY, JULY).frequency).toBe('custom');
    });
  }
});

describe('nextOccurrences', () => {
  it('returns ascending future instants that match the cron', () => {
    const from = new Date('2026-07-15T09:17:30Z');
    const times = nextOccurrences('0 0 * * *', 3, from);
    expect(times.length).toBe(3);
    expect(times.map(t => t.toISOString())).toEqual([
      '2026-07-16T00:00:00.000Z',
      '2026-07-17T00:00:00.000Z',
      '2026-07-18T00:00:00.000Z',
    ]);
  });

  it('honours a weekday restriction', () => {
    // 2026-07-15 is a Wednesday; Sunday-only fires on the 19th.
    const times = nextOccurrences('0 12 * * 0', 2, new Date('2026-07-15T00:00:00Z'));
    expect(times.map(t => t.toISOString())).toEqual([
      '2026-07-19T12:00:00.000Z',
      '2026-07-26T12:00:00.000Z',
    ]);
  });

  it('honours a day-of-month restriction across a month boundary', () => {
    const times = nextOccurrences('0 22 31 * *', 2, new Date('2026-07-15T00:00:00Z'));
    expect(times.map(t => t.toISOString())).toEqual([
      '2026-07-31T22:00:00.000Z',
      '2026-08-31T22:00:00.000Z',
    ]);
  });

  it('expands step and list fields', () => {
    const times = nextOccurrences('*/15 * * * *', 3, new Date('2026-07-15T09:02:00Z'));
    expect(times.map(t => t.toISOString())).toEqual([
      '2026-07-15T09:15:00.000Z',
      '2026-07-15T09:30:00.000Z',
      '2026-07-15T09:45:00.000Z',
    ]);
  });

  it('returns nothing for a malformed cron instead of throwing', () => {
    expect(nextOccurrences('nonsense', 3, JULY)).toEqual([]);
    expect(nextOccurrences('', 3, JULY)).toEqual([]);
  });

  it('gives up within its bound on a cron that cannot match', () => {
    // 30 February never occurs, so the walk must terminate empty.
    expect(nextOccurrences('0 0 30 2 *', 1, new Date('2026-03-01T00:00:00Z'))).toEqual([]);
  });
});

describe('describePlan', () => {
  it('names the common weekday and weekend sets', () => {
    expect(describePlan(plan({ frequency: 'weekly', weekdays: [1, 2, 3, 4, 5] }), 'UTC')).toContain(
      'weekdays',
    );
    expect(describePlan(plan({ frequency: 'weekly', weekdays: [0, 6] }), 'UTC')).toContain(
      'weekends',
    );
    expect(
      describePlan(plan({ frequency: 'weekly', weekdays: [0, 1, 2, 3, 4, 5, 6] }), 'UTC'),
    ).toContain('every day');
  });

  it('pads the time and names the zone', () => {
    expect(describePlan(plan({ hour: 9, minute: 5 }), SYDNEY)).toBe(
      'Every day at 09:05 Australia/Sydney',
    );
  });

  it('asks for a day when a weekly plan has none', () => {
    expect(describePlan(plan({ frequency: 'weekly', weekdays: [] }), 'UTC')).toBe(
      'Pick at least one day',
    );
  });
});
