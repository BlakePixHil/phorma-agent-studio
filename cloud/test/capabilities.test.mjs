/**
 * The Capability_Contract, both copies of it.
 *
 * Properties covered:
 *
 *  - 12  The level comparison is monotone over capability sets
 *  - 36  The twinned contracts declare identical token sets (capability half)
 *
 * Nothing here needs a Worker, a D1 database or a Clerk session:
 * `cloud/src/capabilities.ts` imports nothing at all, and its studio twin
 * `frontend/src/app/core/capabilities.ts` imports nothing either. That is why
 * this suite is a plain `tsx` script near the FRONT of `test:unit` rather than a
 * miniflare suite in the D1-backed tail - it costs no loopback socket and a
 * contract break is worth hearing about in the first two seconds of the chain.
 *
 * ## Why the twin comparison lives here rather than in a guard script
 *
 * The two modules declare the contract independently - no import crosses the
 * package boundary - so the only way to know they agree is to LOAD both and
 * compare behaviour, which is strictly stronger than a text scan: a guard that
 * diffed token lists would pass two files whose `atLeast` disagreed.
 *
 * ## What this suite deliberately does NOT do
 *
 * It never transcribes `CAPABILITIES_BY_LEVEL` into a local oracle. A mirrored
 * table is a shared-bug tautology: edit the source wrongly, edit the mirror the
 * same way, and every assertion still passes. The oracle for the derived
 * functions is the EXPORTED table read through plain array membership, and every
 * count is derived by calling the function under test rather than written down.
 *
 * Nor does it settle for shape. `capabilitiesOf('builder').size >
 * capabilitiesOf('editor').size` holds for a table that named the wrong
 * capabilities, and every "is a superset" claim holds vacuously for an empty set.
 * So each property is PAIRED with content pins that name the capability
 * distinguishing two levels.
 *
 * Mutation-checked (2026-09-23) against three realistic single-edit bugs, all
 * three caught: dropping `...EDITOR_CAPABILITIES` from the builder array,
 * deleting `'graph.structure'` from it, and reordering `CAPABILITY_LEVELS` to put
 * `builder` ahead of `editor`.
 *
 * Run: npx -y tsx cloud/test/capabilities.test.mjs
 */

import fc from 'fast-check';

import {
  CAPABILITIES_BY_LEVEL,
  CAPABILITY_LEVELS,
  CLERK_ROLE_LEVELS,
  atLeast,
  capabilitiesOf,
  holds,
  isCapabilityLevel,
} from '../src/capabilities.ts';

// `frontend/package.json` declares no `"type": "module"`, so tsx loads the studio
// twin as CJS and its named exports arrive on `default`. The twin imports
// nothing, so it loads with no Angular present.
const studioModule = await import('../../frontend/src/app/core/capabilities.ts');
const studio = studioModule.default ?? studioModule;

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

/** Minimum iterations for every property in this suite. */
const RUNS = { numRuns: 200 };

/** Runs one synchronous property and reports it through the harness. */
function property(name, build) {
  try {
    fc.assert(build(), RUNS);
    check(name, true);
  } catch (error) {
    check(name, false, describeFailure(error));
  }
}

/** The counterexample fast-check reports, flattened onto one line. */
function describeFailure(error) {
  return String(error?.message ?? error)
    .split('\n')
    .slice(0, 8)
    .join(' | ');
}

/** Every declared level, read from the module under test. */
const LEVELS = [...CAPABILITY_LEVELS];

/**
 * Every capability any level declares, deduplicated. A union over the levels
 * rather than a read of `admin`, so it stays correct even while cumulativity is
 * the thing being tested.
 */
const ALL_CAPABILITIES = [...new Set(LEVELS.flatMap(level => [...CAPABILITIES_BY_LEVEL[level]]))];

/**
 * The declared table read through plain array membership.
 *
 * This is the oracle for `capabilitiesOf` / `holds` / `atLeast`: it reads the same
 * exported arrays the implementation reads, but by a different route, so a
 * derivation bug in the Set cache or in the comparison shows up as a mismatch.
 * It is NOT a transcription of the table.
 */
function declares(level, capability) {
  return CAPABILITIES_BY_LEVEL[level].includes(capability);
}

/** True when every capability `b` declares is also declared by `a`. */
function declaresEverythingOf(a, b) {
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

// ── Property 12: the level comparison is monotone over capability sets ───────

console.log('\nProperty 12: the level comparison is monotone over capability sets');

property('atLeast holds exactly when the higher level declares every capability', () =>
  fc.property(fc.constantFrom(...LEVELS), fc.constantFrom(...LEVELS), (a, b) => {
    if (atLeast(a, b) !== declaresEverythingOf(a, b)) {
      throw new Error(`atLeast(${a}, ${b}) = ${atLeast(a, b)}`);
    }
  }),
);

property('holds agrees with the declared table for every level and capability', () =>
  fc.property(
    fc.constantFrom(...LEVELS),
    fc.constantFrom(...ALL_CAPABILITIES),
    (level, capability) => {
      if (holds(level, capability) !== declares(level, capability)) {
        throw new Error(`holds(${level}, ${capability}) = ${holds(level, capability)}`);
      }
      if (capabilitiesOf(level).has(capability) !== declares(level, capability)) {
        throw new Error(`capabilitiesOf(${level}) disagrees on ${capability}`);
      }
    },
  ),
);

property('the display order agrees with the inclusion order', () =>
  fc.property(
    fc.nat({ max: LEVELS.length - 1 }),
    fc.nat({ max: LEVELS.length - 1 }),
    (lower, higher) => {
      fc.pre(lower <= higher);
      const low = LEVELS[lower];
      const high = LEVELS[higher];
      // A later level holds everything an earlier one holds.
      if (!atLeast(high, low)) throw new Error(`atLeast(${high}, ${low}) is false`);
      // And a strictly earlier level does NOT hold everything a later one holds,
      // which is what stops the display order from agreeing vacuously.
      if (lower < higher && atLeast(low, high)) {
        throw new Error(`atLeast(${low}, ${high}) is true`);
      }
    },
  ),
);

property('every adjacent pair is a STRICT superset', () =>
  fc.property(fc.nat({ max: LEVELS.length - 2 }), index => {
    const lower = LEVELS[index];
    const higher = LEVELS[index + 1];
    const lowerSet = capabilitiesOf(lower);
    const higherSet = capabilitiesOf(higher);
    for (const capability of lowerSet) {
      if (!higherSet.has(capability)) {
        throw new Error(`${higher} is missing ${lower}'s ${capability}`);
      }
    }
    const added = [...higherSet].filter(capability => !lowerSet.has(capability));
    if (added.length === 0) throw new Error(`${higher} adds nothing over ${lower}`);
  }),
);

property('a capability held by a level is held by every level above it', () =>
  fc.property(
    fc.constantFrom(...LEVELS),
    fc.constantFrom(...ALL_CAPABILITIES),
    (level, capability) => {
      fc.pre(holds(level, capability));
      for (const candidate of LEVELS) {
        if (atLeast(candidate, level) && !holds(candidate, capability)) {
          throw new Error(`${candidate} is at least ${level} but lacks ${capability}`);
        }
      }
    },
  ),
);

property('atLeast is reflexive, transitive and total over the declared levels', () =>
  fc.property(
    fc.constantFrom(...LEVELS),
    fc.constantFrom(...LEVELS),
    fc.constantFrom(...LEVELS),
    (a, b, c) => {
      if (!atLeast(a, a)) throw new Error(`atLeast(${a}, ${a}) is false`);
      if (atLeast(a, b) && atLeast(b, c) && !atLeast(a, c)) {
        throw new Error(`transitivity broken at ${a} >= ${b} >= ${c}`);
      }
      // Total: any two levels are comparable in at least one direction.
      if (!atLeast(a, b) && !atLeast(b, a)) throw new Error(`${a} and ${b} are incomparable`);
    },
  ),
);

property('a token outside the table fails CLOSED in either position', () =>
  fc.property(nonLevel, fc.constantFrom(...LEVELS), (unknown, level) => {
    fc.pre(!LEVELS.includes(unknown));
    if (isCapabilityLevel(unknown)) throw new Error(`isCapabilityLevel accepted ${unknown}`);
    if (atLeast(unknown, level)) throw new Error(`atLeast(${unknown}, ${level}) admitted`);
    if (atLeast(level, unknown)) throw new Error(`atLeast(${level}, ${unknown}) admitted`);
    if (capabilitiesOf(unknown).size !== 0) throw new Error(`${unknown} holds capabilities`);
  }),
);

// ── Property 12, paired content pins ────────────────────────────────────────
//
// Every property above holds for a table that named the WRONG capabilities, and
// the superset claims hold vacuously for an empty one. These pin the contents by
// name, so the shape claims have something to be true about.

console.log('\nProperty 12 (contents): the capabilities that distinguish the levels');

check('the contract declares exactly four levels', LEVELS.length === 4, LEVELS.join(','));
check(
  'the levels are operator, editor, builder, admin in that order',
  LEVELS.join(',') === 'operator,editor,builder,admin',
  LEVELS.join(','),
);

check('run.trigger is held at EVERY level', LEVELS.every(level => holds(level, 'run.trigger')));
check(
  'run.answer_gate is held at every level, so an operator can answer a gate',
  LEVELS.every(level => holds(level, 'run.answer_gate')),
);
check(
  'every read capability is held at every level',
  LEVELS.every(level =>
    ['read.runs', 'read.traces', 'read.usage', 'read.notifications', 'read.workflows'].every(
      capability => holds(level, capability),
    ),
  ),
);

check('operator holds no edit capability', !holds('operator', 'edit.prompt'));
check(
  'edit.prompt, edit.cron, edit.node_config and edit.connection_secret arrive at editor',
  ['edit.prompt', 'edit.cron', 'edit.node_config', 'edit.connection_secret'].every(
    capability => !holds('operator', capability) && holds('editor', capability),
  ),
);

check('graph.structure is present in builder', holds('builder', 'graph.structure'));
check('graph.structure is ABSENT from editor', !holds('editor', 'graph.structure'));
check('workflow.create is ABSENT from editor', !holds('editor', 'workflow.create'));
check(
  'deploy.push, connection.manage, eval.manage and portal.manage arrive at builder',
  ['deploy.push', 'deploy.delete', 'connection.manage', 'eval.manage', 'portal.manage'].every(
    capability => !holds('editor', capability) && holds('builder', capability),
  ),
);

check(
  'member.manage is held by admin ALONE',
  LEVELS.filter(level => holds(level, 'member.manage')).join(',') === 'admin',
);
check(
  'billing.manage is held by admin ALONE',
  LEVELS.filter(level => holds(level, 'billing.manage')).join(',') === 'admin',
);

// Counts derived by calling the function under test, never written down as a
// second copy of the table.
check(
  'admin adds exactly member.manage and billing.manage over builder',
  (() => {
    const builderSet = capabilitiesOf('builder');
    const added = [...capabilitiesOf('admin')].filter(capability => !builderSet.has(capability));
    return added.sort().join(',') === 'billing.manage,member.manage';
  })(),
);
check(
  'the admin set is the union over every level, so no capability is unreachable',
  capabilitiesOf('admin').size === ALL_CAPABILITIES.length,
  `${capabilitiesOf('admin').size} vs ${ALL_CAPABILITIES.length}`,
);
check(
  'each level adds at least one capability over the one below it',
  LEVELS.slice(1).every((level, index) => {
    const below = capabilitiesOf(LEVELS[index]);
    return [...capabilitiesOf(level)].some(capability => !below.has(capability));
  }),
);
check(
  'no level declares a duplicate capability',
  LEVELS.every(level => CAPABILITIES_BY_LEVEL[level].length === capabilitiesOf(level).size),
  LEVELS.map(level => `${level}:${CAPABILITIES_BY_LEVEL[level].length}`).join(','),
);

// ── Property 36: the twins declare identical token sets ─────────────────────

console.log('\nProperty 36: the twinned contracts declare identical token sets');

check(
  'the studio twin loaded with its named exports',
  typeof studio.atLeast === 'function' &&
    typeof studio.capabilitiesOf === 'function' &&
    typeof studio.holds === 'function' &&
    typeof studio.isCapabilityLevel === 'function' &&
    Array.isArray(studio.CAPABILITY_LEVELS) &&
    typeof studio.CAPABILITIES_BY_LEVEL === 'object',
  Object.keys(studio).join(','),
);

const studioLevels = [...studio.CAPABILITY_LEVELS];

check(
  'both copies declare the same levels in the same display order',
  studioLevels.join(',') === LEVELS.join(','),
  `worker ${LEVELS.join(',')} vs studio ${studioLevels.join(',')}`,
);

check(
  'both copies declare the same capability tokens at every level',
  LEVELS.every(
    level =>
      [...(studio.CAPABILITIES_BY_LEVEL[level] ?? [])].sort().join(',') ===
      [...CAPABILITIES_BY_LEVEL[level]].sort().join(','),
  ),
  LEVELS.map(
    level =>
      `${level}: worker ${CAPABILITIES_BY_LEVEL[level].length} vs studio ${
        (studio.CAPABILITIES_BY_LEVEL[level] ?? []).length
      }`,
  ).join(' | '),
);

property('the two copies answer holds identically for every level and capability', () =>
  fc.property(
    fc.constantFrom(...LEVELS),
    fc.constantFrom(...ALL_CAPABILITIES),
    (level, capability) => {
      if (holds(level, capability) !== studio.holds(level, capability)) {
        throw new Error(`holds(${level}, ${capability}) differs across the twins`);
      }
    },
  ),
);

property('the two copies answer atLeast identically for every level pair', () =>
  fc.property(fc.constantFrom(...LEVELS), fc.constantFrom(...LEVELS), (a, b) => {
    if (atLeast(a, b) !== studio.atLeast(a, b)) {
      throw new Error(`atLeast(${a}, ${b}) differs across the twins`);
    }
  }),
);

property('the two copies classify a level token identically', () =>
  fc.property(fc.oneof(fc.constantFrom(...LEVELS), nonLevel), candidate => {
    if (isCapabilityLevel(candidate) !== studio.isCapabilityLevel(candidate)) {
      throw new Error(`isCapabilityLevel(${JSON.stringify(candidate)}) differs across the twins`);
    }
  }),
);

check(
  'the claim mapping is WORKER-ONLY and is not part of the twin',
  typeof CLERK_ROLE_LEVELS === 'object' && studio.CLERK_ROLE_LEVELS === undefined,
  `studio exports: ${Object.keys(studio).join(',')}`,
);
check(
  'every mapped claim value resolves to a declared level',
  Object.values(CLERK_ROLE_LEVELS).every(level => isCapabilityLevel(level)),
  Object.entries(CLERK_ROLE_LEVELS)
    .map(([claim, level]) => `${claim}=${level}`)
    .join(','),
);

console.log(
  failures === 0 ? '\ncapabilities: all checks passed' : `\ncapabilities: ${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
