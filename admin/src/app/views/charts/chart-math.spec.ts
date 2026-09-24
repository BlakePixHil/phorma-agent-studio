import fc from 'fast-check';

import { compareVersions } from '../format';
import {
  deltaOf,
  donutArcs,
  monotoneSegments,
  niceTicks,
  weekGrid,
  weekdayIndex,
} from './chart-math';

const RUNS = 200;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** Runs a property and records it as a jasmine expectation, so a green run is not an empty spec. */
function holds<T>(property: fc.IProperty<T>, params: fc.Parameters<T>): void {
  expect(() => fc.assert(property, params)).not.toThrow();
}

describe('chart maths', () => {
  it('niceTicks start at zero, ascend evenly, and cover the maximum', () => {
    holds(
      fc.property(fc.double({ min: 0, max: 1e7, noNaN: true }), fc.boolean(), (max, integer) => {
        const ticks = niceTicks(max, 4, integer);
        assert(ticks[0] === 0, `first tick ${ticks[0]}`);
        assert(ticks[ticks.length - 1] >= max - 1e-9, `top ${ticks[ticks.length - 1]} < ${max}`);
        const step = ticks[1] - ticks[0];
        assert(step > 0, 'non-positive step');
        for (let i = 1; i < ticks.length; i += 1) {
          assert(Math.abs(ticks[i] - ticks[i - 1] - step) < step * 1e-6, 'uneven step');
        }
        if (integer) assert(ticks.every(Number.isInteger), `fractional tick in ${ticks}`);
        assert(ticks.length <= 12, `too many ticks: ${ticks.length}`);
        return true;
      }),
      { numRuns: RUNS },
    );
  });

  it('monotone curves never overshoot a segment, so counts never dip below zero', () => {
    holds(
      fc.property(fc.array(fc.nat({ max: 10_000 }), { minLength: 2, maxLength: 40 }), (values) => {
        const points = values.map((y, x) => ({ x: x * 10, y }));
        for (const s of monotoneSegments(points)) {
          const lo = Math.min(s.from.y, s.to.y) - 1e-9;
          const hi = Math.max(s.from.y, s.to.y) + 1e-9;
          for (const c of [s.c1, s.c2]) {
            assert(c.y >= lo && c.y <= hi, `control ${c.y} outside [${lo}, ${hi}]`);
            assert(c.x >= s.from.x && c.x <= s.to.x, 'control x outside segment');
          }
        }
        return true;
      }),
      { numRuns: RUNS },
    );
  });

  it('donut arcs are ordered, non-overlapping, and proportional', () => {
    holds(
      fc.property(fc.array(fc.nat({ max: 1000 }), { minLength: 1, maxLength: 12 }), (values) => {
        const arcs = donutArcs(values, 0);
        const total = values.reduce((a, b) => a + b, 0);
        let cursor = -Math.PI / 2;
        arcs.forEach((arc, i) => {
          assert(arc.end >= arc.start, 'reversed arc');
          assert(arc.start >= cursor - 1e-9, 'overlapping arc');
          const expected = total > 0 ? (values[i] / total) * Math.PI * 2 : 0;
          assert(Math.abs(arc.end - arc.start - expected) < 1e-9, 'disproportionate arc');
          cursor = arc.end;
        });
        return true;
      }),
      { numRuns: RUNS },
    );
  });

  it('deltas are null without a baseline and never infinite', () => {
    expect(deltaOf(10, null)).toBeNull();
    expect(deltaOf(10, undefined)).toBeNull();
    expect(deltaOf(null, 10)).toBeNull();
    expect(deltaOf(10, 0)).toEqual({ kind: 'new', amount: null });
    expect(deltaOf(0, 0)).toEqual({ kind: 'flat', amount: 0 });
    expect(deltaOf(150, 100)).toEqual({ kind: 'up', amount: 50 });
    expect(deltaOf(50, 100)).toEqual({ kind: 'down', amount: -50 });
    expect(deltaOf(60, 58, 'points')).toEqual({ kind: 'up', amount: 2 });
    holds(
      fc.property(fc.integer({ min: -1e6, max: 1e6 }), fc.integer({ min: -1e6, max: 1e6 }), (a, b) => {
        const reading = deltaOf(a, b);
        if (reading === null) throw new Error('null for two finite values');
        assert(reading.amount === null || Number.isFinite(reading.amount), 'infinite delta');
        return true;
      }),
      { numRuns: RUNS },
    );
  });

  it('the week grid places every day once, Monday first, in order', () => {
    const day = fc
      .date({ min: new Date('2025-01-01T00:00:00Z'), max: new Date('2027-12-31T00:00:00Z'), noInvalidDate: true })
      .map((d) => d.toISOString().slice(0, 10));
    holds(
      fc.property(day, fc.nat({ max: 120 }), (from, length) => {
        const to = new Date(Date.parse(`${from}T00:00:00Z`) + length * 86_400_000).toISOString().slice(0, 10);
        const grid = weekGrid(from, to);
        const flat = grid.flat();
        const days = flat.filter((d): d is string => d !== null);
        assert(grid.every((week) => week.length === 7), 'short week');
        assert(days.length === length + 1, `${days.length} days for ${length + 1}`);
        assert(days[0] === from && days[days.length - 1] === to, 'ends misplaced');
        days.forEach((d, i) => i > 0 && assert(d > days[i - 1], 'out of order'));
        assert(flat.indexOf(from) % 7 === weekdayIndex(from), 'first day in the wrong row');
        return true;
      }),
      { numRuns: RUNS },
    );
  });

  it('orders versions with numeric pre-release parts', () => {
    const sorted = ['0.2.0-beta.9', '1.0.0-beta.5', '0.2.0', '1.0.0-beta.10', '1.0.0', '0.10.0'].sort(
      (a, b) => compareVersions(b, a),
    );
    expect(sorted).toEqual(['1.0.0', '1.0.0-beta.10', '1.0.0-beta.5', '0.10.0', '0.2.0', '0.2.0-beta.9']);
  });
});
