/**
 * Property 12 for the studio copy of the Capability_Contract.
 *
 * The ordering that matters is DERIVED from the capability sets, not from an
 * index into `CAPABILITY_LEVELS`, so the claims worth testing are about set
 * inclusion: `atLeast(a, b)` exactly when every capability of `b` is a capability
 * of `a`, the display order agreeing with that inclusion order, and every
 * adjacent pair being a STRICT superset.
 *
 * Two disciplines this suite holds to, both learned the hard way in this repo:
 *
 * - The declared table is never transcribed into a local oracle. A mirrored table
 *   is a shared-bug tautology - edit the source wrongly, edit the mirror the same
 *   way, and every assertion still passes. The oracle for the derived functions is
 *   the exported table read through plain array membership, and every count is
 *   derived by calling the function under test.
 * - Every shape claim is PAIRED with a content pin. `capabilitiesOf('builder').size
 *   > capabilitiesOf('editor').size` holds for a table that named the wrong
 *   capabilities, and every superset claim holds vacuously for an empty set, so the
 *   capability that distinguishes two levels is named: `graph.structure` present in
 *   `builder` and absent from `editor`, `member.manage` in `admin` alone,
 *   `run.trigger` at every level.
 *
 * The twin comparison against `cloud/src/capabilities.ts` is NOT here: karma
 * cannot reach outside `frontend/src`, and a text diff would pass two files whose
 * `atLeast` disagreed. `cloud/test/capabilities.test.mjs` loads both modules and
 * compares behaviour instead (Property 36).
 *
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.11**
 */

import fc from 'fast-check';

import {
  CAPABILITIES_BY_LEVEL,
  CAPABILITY_LEVELS,
  atLeast,
  capabilitiesOf,
  holds,
  isCapabilityLevel,
  type Capability,
  type CapabilityLevel,
} from './capabilities';

/** Minimum iterations for every property in this suite. */
const RUNS = { numRuns: 200 };

/** Every declared level, read from the module under test. */
const LEVELS = [...CAPABILITY_LEVELS];

/**
 * Every capability any level declares, deduplicated. A union over the levels
 * rather than a read of `admin`, so it stays correct even while cumulativity is
 * the thing being tested.
 */
const ALL_CAPABILITIES: readonly Capability[] = [
  ...new Set(LEVELS.flatMap(level => [...CAPABILITIES_BY_LEVEL[level]])),
];

/**
 * The declared table read through plain array membership. The same exported
 * arrays the implementation reads, reached by a different route, so a derivation
 * bug in the set cache or in the comparison shows up as a mismatch.
 */
function declares(level: CapabilityLevel, capability: Capability): boolean {
  return CAPABILITIES_BY_LEVEL[level].includes(capability);
}

/** True when every capability `b` declares is also declared by `a`. */
function declaresEverythingOf(a: CapabilityLevel, b: CapabilityLevel): boolean {
  return CAPABILITIES_BY_LEVEL[b].every(capability => declares(a, capability));
}

/** Tokens that are NOT levels, kept close to the real ones. */
const nonLevel = fc.oneof(
  fc.string(),
  fc.constantFrom(...LEVELS).chain(level =>
    fc.oneof(
      fc.constant(level.toUpperCase()),
      fc.constant(` ${level}`),
      fc.constant(`${level} `),
      fc.constant(level.slice(0, -1)),
      fc.constant(`${level}s`),
    ),
  ),
  fc.constantFrom('member', 'owner', 'viewer', 'superadmin', 'org:admin', '3', ''),
);

describe('capability contract', () => {
  // ─── Property 12: the comparison ──────────────────────────────────────────

  // Feature: multi-organisation-phorma, Property 12: The level comparison is monotone over capability sets
  it('holds atLeast exactly when the higher level declares every capability', () => {
    fc.assert(
      fc.property(fc.constantFrom(...LEVELS), fc.constantFrom(...LEVELS), (a, b) => {
        expect(atLeast(a, b)).toBe(declaresEverythingOf(a, b));
      }),
      RUNS,
    );
  });

  // Feature: multi-organisation-phorma, Property 12: The level comparison is monotone over capability sets
  it('agrees with the declared table for every level and capability', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LEVELS),
        fc.constantFrom(...ALL_CAPABILITIES),
        (level, capability) => {
          expect(holds(level, capability)).toBe(declares(level, capability));
          expect(capabilitiesOf(level).has(capability)).toBe(declares(level, capability));
        },
      ),
      RUNS,
    );
  });

  // Feature: multi-organisation-phorma, Property 12: The level comparison is monotone over capability sets
  it('agrees the display order with the inclusion order', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: LEVELS.length - 1 }),
        fc.nat({ max: LEVELS.length - 1 }),
        (lower, higher) => {
          fc.pre(lower <= higher);
          expect(atLeast(LEVELS[higher], LEVELS[lower])).toBe(true);
          // The strict half, which is what stops the agreement from being vacuous.
          if (lower < higher) {
            expect(atLeast(LEVELS[lower], LEVELS[higher])).toBe(false);
          }
        },
      ),
      RUNS,
    );
  });

  // Feature: multi-organisation-phorma, Property 12: The level comparison is monotone over capability sets
  it('makes every adjacent pair a strict superset', () => {
    fc.assert(
      fc.property(fc.nat({ max: LEVELS.length - 2 }), index => {
        const lower = capabilitiesOf(LEVELS[index]);
        const higher = capabilitiesOf(LEVELS[index + 1]);
        for (const capability of lower) {
          expect(higher.has(capability)).toBe(true);
        }
        expect([...higher].some(capability => !lower.has(capability))).toBe(true);
      }),
      RUNS,
    );
  });

  // Feature: multi-organisation-phorma, Property 12: The level comparison is monotone over capability sets
  it('carries a capability upward to every level above the one holding it', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LEVELS),
        fc.constantFrom(...ALL_CAPABILITIES),
        (level, capability) => {
          fc.pre(holds(level, capability));
          for (const candidate of LEVELS) {
            if (atLeast(candidate, level)) {
              expect(holds(candidate, capability)).toBe(true);
            }
          }
        },
      ),
      RUNS,
    );
  });

  // Feature: multi-organisation-phorma, Property 12: The level comparison is monotone over capability sets
  it('is reflexive, transitive and total over the declared levels', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LEVELS),
        fc.constantFrom(...LEVELS),
        fc.constantFrom(...LEVELS),
        (a, b, c) => {
          expect(atLeast(a, a)).toBe(true);
          if (atLeast(a, b) && atLeast(b, c)) {
            expect(atLeast(a, c)).toBe(true);
          }
          expect(atLeast(a, b) || atLeast(b, a)).toBe(true);
        },
      ),
      RUNS,
    );
  });

  // Feature: multi-organisation-phorma, Property 12: The level comparison is monotone over capability sets
  it('fails closed on a token outside the table, in either position', () => {
    fc.assert(
      fc.property(nonLevel, fc.constantFrom(...LEVELS), (unknown, level) => {
        fc.pre(!(LEVELS as readonly string[]).includes(unknown));
        expect(isCapabilityLevel(unknown)).toBe(false);
        const token = unknown as CapabilityLevel;
        expect(atLeast(token, level)).toBe(false);
        expect(atLeast(level, token)).toBe(false);
        expect(capabilitiesOf(token).size).toBe(0);
      }),
      RUNS,
    );
  });

  // ─── Property 12, paired content pins ─────────────────────────────────────

  it('declares exactly four levels, in display order', () => {
    expect(LEVELS).toEqual(['operator', 'editor', 'builder', 'admin']);
  });

  it('grants the operator level trigger, monitor, gate answers and every read', () => {
    for (const level of LEVELS) {
      expect(holds(level, 'run.trigger')).toBe(true);
      expect(holds(level, 'run.monitor')).toBe(true);
      expect(holds(level, 'run.answer_gate')).toBe(true);
      expect(holds(level, 'read.runs')).toBe(true);
      expect(holds(level, 'read.traces')).toBe(true);
      expect(holds(level, 'read.usage')).toBe(true);
      expect(holds(level, 'read.notifications')).toBe(true);
      expect(holds(level, 'read.workflows')).toBe(true);
    }
  });

  it('grants the operator level nothing beyond trigger, monitor, gate answers and reads', () => {
    // A content pin, named rather than derived: answering a gate is the only
    // write an operator holds, so every edit, structural, management and billing
    // token must be absent here.
    expect([...capabilitiesOf('operator')].sort()).toEqual([
      'read.notifications',
      'read.runs',
      'read.traces',
      'read.usage',
      'read.workflows',
      'run.answer_gate',
      'run.monitor',
      'run.trigger',
    ]);
  });

  it('introduces the four value edits at editor and no structural change', () => {
    for (const capability of [
      'edit.prompt',
      'edit.cron',
      'edit.node_config',
      'edit.connection_secret',
    ] as const) {
      expect(holds('operator', capability)).toBe(false);
      expect(holds('editor', capability)).toBe(true);
    }
    expect(holds('editor', 'graph.structure')).toBe(false);
    expect(holds('editor', 'workflow.create')).toBe(false);
  });

  it('introduces graph structure, creation, deploy and management at builder', () => {
    for (const capability of [
      'workflow.create',
      'graph.structure',
      'deploy.push',
      'deploy.delete',
      'connection.manage',
      'eval.manage',
      'portal.manage',
    ] as const) {
      expect(holds('editor', capability)).toBe(false);
      expect(holds('builder', capability)).toBe(true);
    }
  });

  it('holds member management and billing at admin alone', () => {
    expect(LEVELS.filter(level => holds(level, 'member.manage'))).toEqual(['admin']);
    expect(LEVELS.filter(level => holds(level, 'billing.manage'))).toEqual(['admin']);
  });

  it('adds exactly member.manage and billing.manage from builder to admin', () => {
    const builder = capabilitiesOf('builder');
    const added = [...capabilitiesOf('admin')].filter(capability => !builder.has(capability));
    expect(added.sort()).toEqual(['billing.manage', 'member.manage']);
  });

  it('reaches every declared capability from the admin level', () => {
    expect(capabilitiesOf('admin').size).toBe(ALL_CAPABILITIES.length);
  });

  it('declares no duplicate capability at any level', () => {
    for (const level of LEVELS) {
      expect(CAPABILITIES_BY_LEVEL[level].length).toBe(capabilitiesOf(level).size);
    }
  });
});
