/**
 * Property tests for the PURE halves of the telemetry feature on the Worker side:
 * the Counter_Catalog twin, the geo resolver, the ingest validation and
 * sanitization core, and the three admin decision functions.
 *
 * Nothing here needs a Worker, a D1 database or a Clerk session. Every module
 * under test is a leaf or close to one, which is exactly why these seven
 * properties can live in one plain `tsx` script instead of a miniflare suite.
 *
 * Properties covered:
 *
 *  -  5  The Counter_Catalog is closed and complete (twin identity half)
 *  - 18  Ingest rejection is exact (`normalizeRollup` half - see the note below)
 *  - 19  Ingest sanitization is exact
 *  - 24  Geo resolution is total
 *  - 27  Admin authorization decides on exactly four outcomes
 *  - 28  Date range parsing and capping are exact
 *  - 30  The k-anonymity floor holds and conserves metrics
 *
 * WHERE THE OTHER HALVES LIVE. Two of these properties straddle the HTTP
 * boundary and are deliberately split rather than duplicated:
 *
 *  - Property 18's "413 above 16 kilobytes" and "nothing is written in any
 *    rejecting case" halves belong to `handleTelemetryRequest`: the size cap sits
 *    in the capped body reader and the write is a `D1Database.batch`. Both need a
 *    `Request` with a real body stream and a `d1Databases` binding, so they are
 *    asserted in `cloud/test/telemetry-ingest.test.mjs` on miniflare. Here the
 *    same rejection RULE is pinned one layer down, on `normalizeRollup`, whose
 *    `null` return is the only thing that reaches the 400 branch.
 *  - Property 27's authorized 200 answer needs a token `verifyRequest` resolves
 *    to a non-null Clerk user id, which cannot be minted without a Clerk
 *    instance. `cloud/test/telemetry-admin.test.mjs` covers it. Here every
 *    verification outcome reachable without Clerk is driven through the real
 *    handler (absent token, rejected token, verified-with-null-id), and the
 *    allowlist decision itself - including the substring case - is exhausted on
 *    the pure `isTelemetryAdmin`.
 *
 * Run: npx -y tsx cloud/test/telemetry.test.mjs
 */

import fc from 'fast-check';

import {
  COUNTED_ASSISTANT_MODES,
  COUNTED_DEPLOY_TARGETS,
  COUNTED_NODE_KINDS,
  COUNTED_PANEL_IDS,
  COUNTER_CATALOG,
  CURRENT_DISCLOSURE_VERSION,
  DIMENSIONED_COUNTER_FAMILIES,
  DIMENSIONLESS_COUNTER_FAMILIES,
  ERROR_CATEGORIES,
  KNOWN_SCHEMA_VERSIONS,
  TELEMETRY_SCHEMA_VERSION,
  counterName,
} from '../src/telemetry-catalog.ts';
import {
  COUNTRY_REGION,
  TELEMETRY_REGIONS,
  UNKNOWN_COUNTRY_CODE,
  resolveCoarseGeo,
} from '../src/telemetry-geo.ts';
import {
  COUNTER_VALUE_MAX,
  COUNTER_VALUE_MIN,
  ENV_FIELD_MAX_LENGTH,
  ENV_KEYS,
  METRIC_DAY_MAX_AGE_DAYS,
  METRIC_DAY_MAX_FUTURE_DAYS,
  ROLLUP_KEYS,
  normalizeRollup,
} from '../src/telemetry.ts';
import {
  INVALID_RANGE_ERROR,
  K_ANONYMITY_FLOOR,
  K_ANONYMITY_OTHER_LABEL,
  TELEMETRY_RANGE_DEFAULT_DAYS,
  TELEMETRY_RANGE_MAX_DAYS,
  applyKAnonymity,
  handleTelemetryAdminRequest,
  isTelemetryAdmin,
  parseDateRange,
} from '../src/telemetry-admin.ts';

// `frontend/package.json` declares no `"type": "module"`, so tsx loads the
// studio twin as CJS and the named exports arrive on `default`. Its own imports
// are type-only, so the catalog leaf loads with no Angular present.
const frontendModule = await import('../../frontend/src/app/core/telemetry-catalog.ts');
const studio = frontendModule.default ?? frontendModule;

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

/** Runs one asynchronous property and reports it through the harness. */
async function asyncProperty(name, build) {
  try {
    await fc.assert(build(), RUNS);
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

const MS_PER_DAY = 86_400_000;

function hexString(length) {
  return fc
    .array(fc.constantFrom(...'0123456789abcdef'), { minLength: length, maxLength: length })
    .map(chars => chars.join(''));
}

function dayOffsetFrom(nowMs, offsetDays) {
  const today = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00.000Z`);
  return new Date(today + offsetDays * MS_PER_DAY).toISOString().slice(0, 10);
}

// ── Property 5: the Counter_Catalog twin ─────────────────────────────────────
//
// `cloud/src/telemetry-catalog.ts` and `frontend/src/app/core/telemetry-catalog.ts`
// declare the same catalog INDEPENDENTLY - no import crosses the package
// boundary - so the only way to know they agree is to load both and compare.
//
// The completeness half against `WorkflowNodeKind`, `AssistantMode` and
// `DeployTargetId` is compile-enforced in the studio twin (`AssertCovered`) and
// asserted in `frontend/src/app/core/telemetry-catalog.spec.ts`. Those unions do
// not exist at runtime here, so this file pins the part that a compiler cannot
// see: the two modules expand to the same 56 names, over the same five dimension
// lists, at the same schema version.

console.log('\nProperty 5: the Counter_Catalog is closed and complete (twin identity)');

/**
 * An independent re-expansion of a catalog module's declared families. Joins
 * with a literal `':'` rather than calling `counterName`, so the separator is
 * pinned rather than assumed.
 */
function expandCatalog(module) {
  const names = [];
  for (const family of module.DIMENSIONLESS_COUNTER_FAMILIES) names.push(family);
  for (const [family, dimensions] of Object.entries(module.DIMENSIONED_COUNTER_FAMILIES)) {
    for (const dimension of dimensions) names.push(`${family}:${dimension}`);
  }
  return names;
}

const workerNames = [...COUNTER_CATALOG].sort();
const studioNames = [...studio.COUNTER_CATALOG].sort();
const workerExpansion = expandCatalog({
  DIMENSIONLESS_COUNTER_FAMILIES,
  DIMENSIONED_COUNTER_FAMILIES,
}).sort();
const studioExpansion = expandCatalog(studio).sort();

check(
  'the studio twin loaded with its named exports',
  typeof studio.COUNTER_CATALOG?.has === 'function' && typeof studio.counterName === 'function',
  Object.keys(studio).join(','),
);
check(
  'the two catalogs hold exactly the same names',
  workerNames.join('\n') === studioNames.join('\n'),
  `worker ${workerNames.length} vs studio ${studioNames.length}`,
);
check('the catalog holds 56 names', workerNames.length === 56, String(workerNames.length));
check(
  'the Worker catalog is exactly its own family expansion',
  workerNames.join('\n') === workerExpansion.join('\n'),
);
check(
  'the studio catalog is exactly its own family expansion',
  studioNames.join('\n') === studioExpansion.join('\n'),
);
check(
  'the schema version is identical',
  TELEMETRY_SCHEMA_VERSION === studio.TELEMETRY_SCHEMA_VERSION,
  `${TELEMETRY_SCHEMA_VERSION} vs ${studio.TELEMETRY_SCHEMA_VERSION}`,
);
check(
  'the shipped schema version is an accepted one',
  KNOWN_SCHEMA_VERSIONS.includes(TELEMETRY_SCHEMA_VERSION),
  KNOWN_SCHEMA_VERSIONS.join(','),
);
check(
  'the disclosure version is identical',
  CURRENT_DISCLOSURE_VERSION === studio.CURRENT_DISCLOSURE_VERSION,
  `${CURRENT_DISCLOSURE_VERSION} vs ${studio.CURRENT_DISCLOSURE_VERSION}`,
);

for (const [label, worker, front] of [
  ['node kinds', COUNTED_NODE_KINDS, studio.COUNTED_NODE_KINDS],
  ['panel ids', COUNTED_PANEL_IDS, studio.COUNTED_PANEL_IDS],
  ['assistant modes', COUNTED_ASSISTANT_MODES, studio.COUNTED_ASSISTANT_MODES],
  ['deploy targets', COUNTED_DEPLOY_TARGETS, studio.COUNTED_DEPLOY_TARGETS],
  ['error categories', ERROR_CATEGORIES, studio.ERROR_CATEGORIES],
  ['dimensionless families', DIMENSIONLESS_COUNTER_FAMILIES, studio.DIMENSIONLESS_COUNTER_FAMILIES],
]) {
  check(
    `the ${label} list is identical, in the same order`,
    [...worker].join(',') === [...front].join(','),
    `${[...worker].join(',')} vs ${[...front].join(',')}`,
  );
}
check(
  'the dimensioned family names are identical, in the same order',
  Object.keys(DIMENSIONED_COUNTER_FAMILIES).join(',') ===
    Object.keys(studio.DIMENSIONED_COUNTER_FAMILIES).join(','),
);

// Plausible-but-wrong names: cross-family pairings, a dimensionless family
// carrying a dimension, a dimensioned family with its dimension dropped, single
// character mutations of a valid name, and arbitrary strings.
const dimensionedFamilies = Object.keys(DIMENSIONED_COUNTER_FAMILIES);
const allDimensions = Object.values(DIMENSIONED_COUNTER_FAMILIES).flatMap(list => [...list]);
const candidateName = fc.oneof(
  fc.constantFrom(...workerExpansion),
  fc
    .tuple(fc.constantFrom(...dimensionedFamilies), fc.constantFrom(...allDimensions))
    .map(([family, dimension]) => `${family}:${dimension}`),
  fc
    .tuple(fc.constantFrom(...DIMENSIONLESS_COUNTER_FAMILIES), fc.constantFrom(...allDimensions))
    .map(([family, dimension]) => `${family}:${dimension}`),
  fc.constantFrom(...dimensionedFamilies),
  fc
    .tuple(fc.constantFrom(...workerExpansion), fc.string({ minLength: 1, maxLength: 3 }))
    .map(([name, suffix]) => `${name}${suffix}`),
  fc.constantFrom(...workerExpansion).map(name => name.toUpperCase()),
  fc.constantFrom(...workerExpansion).map(name => name.replace(':', '.')),
  fc.string({ maxLength: 40 }),
);

// Feature: telemetry-phone-home, Property 5: The Counter_Catalog is closed and complete
property('a name is in the Worker catalog exactly when it is in the studio catalog', () =>
  fc.property(candidateName, name => {
    const inWorker = COUNTER_CATALOG.has(name);
    const inStudio = studio.COUNTER_CATALOG.has(name);
    const inExpansion = workerExpansion.includes(name);
    if (inWorker !== inStudio) {
      throw new Error(`disagreement on "${name}": worker ${inWorker}, studio ${inStudio}`);
    }
    if (inWorker !== inExpansion) {
      throw new Error(`"${name}" is ${inWorker ? 'in' : 'not in'} the catalog but the reverse in the expansion`);
    }
    return true;
  }),
);

// Feature: telemetry-phone-home, Property 5: The Counter_Catalog is closed and complete
property('both modules build the same name for the same family and dimension', () =>
  fc.property(
    fc.oneof(
      fc.constantFrom(...DIMENSIONLESS_COUNTER_FAMILIES).map(family => [family, undefined]),
      fc
        .tuple(fc.constantFrom(...dimensionedFamilies), fc.constantFrom(...allDimensions))
        .map(([family, dimension]) => [family, dimension]),
    ),
    ([family, dimension]) => {
      const worker = counterName(family, dimension);
      const front = studio.counterName(family, dimension);
      const expected = dimension === undefined ? family : `${family}:${dimension}`;
      return worker === front && worker === expected;
    },
  ),
);

// ── Property 24: geo resolution is total ─────────────────────────────────────
//
// `resolveCoarseGeo` reads `cf.country` and nothing else. The claim is totality:
// whatever arrives - an absent `cf`, an absent country, a non-string, a
// malformed code, a Cloudflare pseudo-country or an ISO code the map has not
// caught up with - the answer is a two-letter code plus a region from the closed
// set, and `XX`/`unknown` appears exactly when no usable code was available.

console.log('\nProperty 24: geo resolution is total');

const MAPPED_CODES = Object.keys(COUNTRY_REGION);

/** A `Request` carrying the given Cloudflare properties, or none at all. */
function requestWithCf(cf) {
  const request = new Request('https://cloud.example.test/telemetry', { method: 'POST' });
  if (cf !== undefined) {
    Object.defineProperty(request, 'cf', { value: cf, configurable: true });
  }
  return request;
}

/**
 * The reference rule, written from Requirement 7.2 rather than from the
 * implementation: a country is usable when it is a string that trims and
 * uppercases to two letters and is neither the `XX` placeholder nor Cloudflare's
 * `T1` Tor pseudo-country.
 */
function usableCountry(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  if (code === 'XX' || code === 'T1') return null;
  return code;
}

const countryValue = fc.oneof(
  fc.constantFrom(...MAPPED_CODES),
  fc.constantFrom(...MAPPED_CODES).map(code => code.toLowerCase()),
  fc.constantFrom(...MAPPED_CODES).map(code => `  ${code} `),
  // Well-formed but unassigned or reserved, so the map cannot carry them.
  fc.constantFrom('XX', 'xx', 'T1', 't1', 'ZZ', 'QQ', 'AA', 'OO'),
  // Malformed shapes.
  fc.constantFrom('', ' ', 'U', 'USA', '12', 'U1', '-', 'US-CA', 'ÜS'),
  // Not a string at all.
  fc.constantFrom(null, undefined, 42, true, false, {}, [], ['US'], { country: 'US' }),
  fc.string({ maxLength: 6 }),
);

const cfValue = fc.oneof(
  fc.constant(undefined), // no `cf` on the request at all
  fc.constant({}), // `cf` present, country absent
  countryValue.map(country => ({ country })),
  countryValue.map(country => ({ country, city: 'Springfield', asn: 64512, postalCode: '99999' })),
);

// Feature: telemetry-phone-home, Property 24: Geo resolution is total
property('answers a two-letter code and a closed-set region for any request', () =>
  fc.property(cfValue, cf => {
    const geo = resolveCoarseGeo(requestWithCf(cf));
    if (!/^[A-Z]{2}$/.test(geo.countryCode)) {
      throw new Error(`countryCode "${geo.countryCode}" is not two uppercase letters`);
    }
    if (!TELEMETRY_REGIONS.includes(geo.region)) {
      throw new Error(`region "${geo.region}" is outside the closed set`);
    }
    const expected = usableCountry(cf?.country);
    const isUnknown = geo.countryCode === UNKNOWN_COUNTRY_CODE && geo.region === 'unknown';
    if (isUnknown !== (expected === null)) {
      throw new Error(
        `unknown answer ${isUnknown} for country ${JSON.stringify(cf?.country)} (usable ${expected})`,
      );
    }
    if (expected !== null && geo.countryCode !== expected) {
      throw new Error(`countryCode "${geo.countryCode}" for usable code "${expected}"`);
    }
    return true;
  }),
);

// Feature: telemetry-phone-home, Property 24: Geo resolution is total
property('is deterministic for a given input', () =>
  fc.property(cfValue, cf => {
    const first = resolveCoarseGeo(requestWithCf(cf));
    const second = resolveCoarseGeo(requestWithCf(cf));
    return JSON.stringify(first) === JSON.stringify(second);
  }),
);

// Feature: telemetry-phone-home, Property 24: Geo resolution is total
property('maps a country code to exactly one region, whatever its case or padding', () =>
  fc.property(
    fc.constantFrom(...MAPPED_CODES),
    fc.constantFrom('', ' ', '  ', '\t'),
    fc.boolean(),
    (code, padding, lower) => {
      const raw = `${padding}${lower ? code.toLowerCase() : code}${padding}`;
      const geo = resolveCoarseGeo(requestWithCf({ country: raw }));
      return geo.countryCode === code && geo.region === COUNTRY_REGION[code];
    },
  ),
);

check(
  'every mapped code carries exactly one region from the closed set',
  MAPPED_CODES.every(code => TELEMETRY_REGIONS.includes(COUNTRY_REGION[code])),
  MAPPED_CODES.filter(code => !TELEMETRY_REGIONS.includes(COUNTRY_REGION[code])).join(','),
);
check(
  'a request with no cf at all resolves to XX/unknown',
  (() => {
    const geo = resolveCoarseGeo(requestWithCf(undefined));
    return geo.countryCode === UNKNOWN_COUNTRY_CODE && geo.region === 'unknown';
  })(),
);
check(
  'a well-formed but unmapped code keeps its country and loses its region',
  (() => {
    const geo = resolveCoarseGeo(requestWithCf({ country: 'ZZ' }));
    return geo.countryCode === 'ZZ' && geo.region === 'unknown';
  })(),
);

// ── Property 18: ingest rejection is exact ───────────────────────────────────
//
// `normalizeRollup` returns `null` for EXACTLY three reasons - the three fields
// without which a row cannot be keyed or interpreted - and degrades everything
// else. Rather than re-deriving the rule from the generated body (which would
// re-implement the validator and prove nothing), each case is generated from a
// FACT about the field, and the expectation is read off the facts.
//
// The 413 size cap and the "nothing is written" half live in
// `cloud/test/telemetry-ingest.test.mjs`: both need a real request body stream
// and a D1 binding. At this layer, `null` IS "nothing written" - it is the only
// value that reaches the 400 branch, and the write is downstream of it.

console.log('\nProperty 18: ingest rejection is exact');

const VALID_ID_KINDS = ['valid', 'validUpper'];
const REJECTING_DAY_KINDS = ['stale', 'future', 'nonCalendar', 'badShape', 'nonString'];

const validUuid = fc
  .tuple(hexString(8), hexString(4), hexString(3), fc.constantFrom('8', '9', 'a', 'b'), hexString(3), hexString(12))
  .map(([a, b, c, variant, d, e]) => `${a}-${b}-4${c}-${variant}${d}-${e}`);

/** An Install_Id plus the fact that decides whether it rejects. */
const installIdCase = fc.oneof(
  validUuid.map(id => ['valid', id]),
  validUuid.map(id => ['validUpper', id.toUpperCase()]),
  // Version nibble is not 4.
  fc
    .tuple(hexString(8), hexString(4), fc.constantFrom('1', '2', '3', '5', '0'), hexString(3), fc.constantFrom('8', '9', 'a', 'b'), hexString(3), hexString(12))
    .map(([a, b, version, c, variant, d, e]) => ['badVersion', `${a}-${b}-${version}${c}-${variant}${d}-${e}`]),
  // Variant nibble is outside 8..b.
  fc
    .tuple(hexString(8), hexString(4), hexString(3), fc.constantFrom('0', '1', '5', 'c', 'd', 'e', 'f'), hexString(3), hexString(12))
    .map(([a, b, c, variant, d, e]) => ['badVariant', `${a}-${b}-4${c}-${variant}${d}-${e}`]),
  validUuid.map(id => ['truncated', id.slice(0, -1)]),
  validUuid.map(id => ['padded', ` ${id} `]),
  validUuid.map(id => ['undashed', id.replaceAll('-', '')]),
  fc.string({ maxLength: 40 }).map(id => ['arbitrary', id]),
  fc.constantFrom(null, undefined, 7, true, {}, [], ['a']).map(id => ['nonString', id]),
);

/** A Metric_Day plus the fact that decides whether it rejects. */
function metricDayCase(nowMs) {
  return fc.oneof(
    fc.constant(['today', dayOffsetFrom(nowMs, 0)]),
    fc
      .integer({ min: -METRIC_DAY_MAX_AGE_DAYS, max: METRIC_DAY_MAX_FUTURE_DAYS })
      .map(offset => ['inWindow', dayOffsetFrom(nowMs, offset)]),
    fc
      .integer({ min: -400, max: -(METRIC_DAY_MAX_AGE_DAYS + 1) })
      .map(offset => ['stale', dayOffsetFrom(nowMs, offset)]),
    fc
      .integer({ min: METRIC_DAY_MAX_FUTURE_DAYS + 1, max: 400 })
      .map(offset => ['future', dayOffsetFrom(nowMs, offset)]),
    fc
      .constantFrom('2026-02-30', '2025-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-32')
      .map(day => ['nonCalendar', day]),
    fc
      .constantFrom('2026-1-1', '26-01-01', '2026/01/01', '', 'not-a-day', '2026-01-01T00:00:00Z', ' 2026-01-01')
      .map(day => ['badShape', day]),
    fc.constantFrom(null, undefined, 20260101, true, {}, []).map(day => ['nonString', day]),
  );
}

/** A schema version plus the fact that decides whether it rejects. */
const schemaVersionCase = fc.oneof(
  fc.constantFrom(...KNOWN_SCHEMA_VERSIONS).map(version => ['known', version]),
  fc
    .integer({ min: -20, max: 20 })
    .filter(version => !KNOWN_SCHEMA_VERSIONS.includes(version))
    .map(version => ['unknown', version]),
  fc.constantFrom(1.5, Number.NaN, Number.POSITIVE_INFINITY).map(version => ['unknown', version]),
  fc.constantFrom('1', null, undefined, true, {}, []).map(version => ['nonNumber', version]),
);

const wellFormedEnv = {
  locale: 'en-GB',
  timezone: 'Europe/London',
  platform: 'windows',
  osVersion: '10.0.26100',
  appVersion: '0.2.0-beta.10',
  runtimeMode: 'desktop',
};

const nowMsArb = fc.integer({ min: Date.parse('2001-01-01T00:00:00Z'), max: Date.parse('2099-01-01T00:00:00Z') });

/** One generated body plus the three facts that decide its fate. */
const rejectionCase = nowMsArb.chain(nowMs =>
  fc.record({
    nowMs: fc.constant(nowMs),
    id: installIdCase,
    day: metricDayCase(nowMs),
    schema: schemaVersionCase,
    // A body that also carries junk, so a rejection cannot be an artefact of a
    // minimal payload and an acceptance cannot depend on a pristine one.
    extra: fc.option(fc.constant({ ip: '203.0.113.7', nested: { deep: [1, 2] } }), {
      nil: undefined,
    }),
  }),
);

// Feature: telemetry-phone-home, Property 18: Ingest rejection is exact
property('rejects exactly for a bad Install_Id, Metric_Day or schema version', () =>
  fc.property(rejectionCase, ({ nowMs, id, day, schema, extra }) => {
    const [idKind, installId] = id;
    const [dayKind, metricDay] = day;
    const [schemaKind, schemaVersion] = schema;

    const body = { installId, metricDay, schemaVersion, env: wellFormedEnv, counters: {}, ...extra };
    const result = normalizeRollup(body, nowMs);

    const shouldReject =
      !VALID_ID_KINDS.includes(idKind) ||
      REJECTING_DAY_KINDS.includes(dayKind) ||
      schemaKind !== 'known';

    if (shouldReject !== (result === null)) {
      throw new Error(
        `id ${idKind} day ${dayKind} schema ${schemaKind}: expected ${shouldReject ? 'null' : 'a Rollup'}, got ${JSON.stringify(result)}`,
      );
    }
    if (result !== null) {
      // An accepted Rollup carries the key fields verbatim, lowercased id aside.
      if (result.installId !== installId.toLowerCase()) {
        throw new Error(`installId "${result.installId}" for submitted "${installId}"`);
      }
      if (result.metricDay !== metricDay) {
        throw new Error(`metricDay "${result.metricDay}" for submitted "${metricDay}"`);
      }
      if (result.schemaVersion !== schemaVersion) {
        throw new Error(`schemaVersion ${result.schemaVersion} for submitted ${schemaVersion}`);
      }
    }
    return true;
  }),
);

// Feature: telemetry-phone-home, Property 18: Ingest rejection is exact
property('rejects any body that is not a plain object', () =>
  fc.property(
    fc.oneof(
      fc.constantFrom(null, undefined, true, false, 0, 1, -1, '', 'null', '{}'),
      fc.array(fc.integer(), { maxLength: 3 }),
      fc.double(),
      // `noInvalidDate` because `fc.date()` generates an Invalid Date by default
      // and `toISOString()` THROWS on one (`RangeError: Invalid time value`).
      // That surfaced as a rare, seed-dependent failure of this property with no
      // counterexample attached - the generator crashed before `normalizeRollup`
      // was ever called, so the flake said nothing about the code under test.
      fc.date({ noInvalidDate: true }).map(date => date.toISOString()),
    ),
    body => normalizeRollup(body, Date.now()) === null,
  ),
);

// The window edges, spelled out. Off-by-one here is the whole requirement.
{
  const nowMs = Date.parse('2026-06-15T11:30:00Z');
  const at = offset => ({
    installId: '3f2a1b4c-5d6e-4f70-8123-456789abcdef',
    metricDay: dayOffsetFrom(nowMs, offset),
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    env: wellFormedEnv,
    counters: {},
  });
  check('a Metric_Day exactly 30 days old is accepted', normalizeRollup(at(-30), nowMs) !== null);
  check('a Metric_Day 31 days old is rejected', normalizeRollup(at(-31), nowMs) === null);
  check('a Metric_Day 1 day ahead is accepted', normalizeRollup(at(1), nowMs) !== null);
  check('a Metric_Day 2 days ahead is rejected', normalizeRollup(at(2), nowMs) === null);
  check(
    'an unparseable body never reaches normalization',
    (() => {
      let parsed;
      try {
        parsed = JSON.parse('{"installId":');
      } catch {
        parsed = undefined;
      }
      return normalizeRollup(parsed, nowMs) === null;
    })(),
  );
}

// ── Property 19: ingest sanitization is exact ────────────────────────────────
//
// The three claims: the normalized object's key set is EXACTLY the declared one
// (so an unrecognized field has nowhere to land), every environment string is at
// most 64 characters and a prefix of what was submitted, and the surviving
// counter set is exactly the catalog names carrying an integer in range.
//
// Note on "prefix of the submitted value": the implementation trims before it
// truncates, so the prefix relation is against the TRIMMED submission. That is
// the stronger reading anyway - leading whitespace is not information - and it is
// asserted as an equality whenever the trimmed value already fits.

console.log('\nProperty 19: ingest sanitization is exact');

const envValue = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.string({ minLength: 65, maxLength: 300 }),
  fc.string({ maxLength: 80 }).map(text => `   ${text}   `),
  fc.constantFrom('en-GB', 'Europe/London', 'windows', 'desktop', 'browser', '', '   '),
  fc.integer(),
  fc.constantFrom(1.5, Number.NaN, Number.POSITIVE_INFINITY),
  fc.boolean(),
  fc.constantFrom(null, undefined, {}, [], ['a'], { valueOf: 1 }),
  // An object whose `toString` throws: the field must still resolve, which is
  // only true because the coercion never calls it.
  fc.constant({
    toString() {
      throw new Error('hostile toString');
    },
  }),
);

const envArb = fc.dictionary(
  fc.constantFrom(...ENV_KEYS, 'ipAddress', 'city', 'asn', 'userName', 'latitude'),
  envValue,
  { maxKeys: 11 },
);

const counterKey = fc.oneof(
  fc.constantFrom(...workerNames),
  fc.constantFrom(
    'node.created:not-a-kind',
    'panel.opened:nope',
    'error:boom',
    'run.started ',
    'RUN.STARTED',
    'session.started:extra',
    '',
  ),
  fc.string({ maxLength: 14 }),
);

const counterValue = fc.oneof(
  fc.integer({ min: COUNTER_VALUE_MIN, max: COUNTER_VALUE_MAX }),
  fc.integer({ min: COUNTER_VALUE_MAX + 1, max: COUNTER_VALUE_MAX * 4 }),
  fc.integer({ min: -1000, max: -1 }),
  fc.constantFrom(
    COUNTER_VALUE_MIN,
    COUNTER_VALUE_MAX,
    COUNTER_VALUE_MAX + 1,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ),
  fc.constantFrom('5', null, undefined, true, false, {}, []),
);

const countersArb = fc.dictionary(counterKey, counterValue, { maxKeys: 14 });

const unknownTopLevel = fc.dictionary(
  fc.constantFrom('ip', 'cfConnectingIp', 'stack', 'promptText', 'workflowName', 'userId', 'extra'),
  fc.oneof(fc.string({ maxLength: 30 }), fc.integer(), fc.constant(null)),
  { maxKeys: 5 },
);

const sanitizationCase = nowMsArb.chain(nowMs =>
  fc.record({
    nowMs: fc.constant(nowMs),
    metricDay: fc
      .integer({ min: -METRIC_DAY_MAX_AGE_DAYS, max: METRIC_DAY_MAX_FUTURE_DAYS })
      .map(offset => dayOffsetFrom(nowMs, offset)),
    installId: validUuid,
    env: fc.oneof(envArb, fc.constantFrom(null, undefined, 'nope', 42, [])),
    counters: fc.oneof(countersArb, fc.constantFrom(null, undefined, 'nope', 42, [])),
    junk: unknownTopLevel,
  }),
);

/** What a 64-code-unit truncation of a coerced scalar has to look like. */
function expectedEnvString(submitted) {
  if (typeof submitted === 'string') return submitted.trim();
  if (typeof submitted === 'number') return Number.isFinite(submitted) ? String(submitted).trim() : '';
  if (typeof submitted === 'boolean') return String(submitted);
  return '';
}

// Feature: telemetry-phone-home, Property 19: Ingest sanitization is exact
property('normalizes to exactly the declared Rollup and Client_Environment key sets', () =>
  fc.property(sanitizationCase, ({ nowMs, installId, metricDay, env, counters, junk }) => {
    const body = {
      ...junk,
      installId,
      metricDay,
      env,
      counters,
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
    };
    const result = normalizeRollup(body, nowMs);
    if (result === null) throw new Error('a well-keyed Rollup was rejected');

    const keys = Object.keys(result).join(',');
    if (keys !== [...ROLLUP_KEYS].join(',')) {
      throw new Error(`rollup keys "${keys}" instead of "${[...ROLLUP_KEYS].join(',')}"`);
    }
    const envKeys = Object.keys(result.env).join(',');
    if (envKeys !== [...ENV_KEYS].join(',')) {
      throw new Error(`env keys "${envKeys}" instead of "${[...ENV_KEYS].join(',')}"`);
    }
    return true;
  }),
);

// Feature: telemetry-phone-home, Property 19: Ingest sanitization is exact
property('bounds every environment string to 64 characters and a prefix of the submission', () =>
  fc.property(sanitizationCase, ({ nowMs, installId, metricDay, env, counters, junk }) => {
    const result = normalizeRollup(
      { ...junk, installId, metricDay, env, counters, schemaVersion: TELEMETRY_SCHEMA_VERSION },
      nowMs,
    );
    if (result === null) throw new Error('a well-keyed Rollup was rejected');

    const submittedEnv = env !== null && typeof env === 'object' && !Array.isArray(env) ? env : {};
    for (const key of ENV_KEYS) {
      const stored = result.env[key];
      if (typeof stored !== 'string') throw new Error(`env.${key} is ${typeof stored}`);
      if (stored.length > ENV_FIELD_MAX_LENGTH) {
        throw new Error(`env.${key} is ${stored.length} characters`);
      }
      if (key === 'runtimeMode') {
        const expected = submittedEnv[key] === 'desktop' ? 'desktop' : 'browser';
        if (stored !== expected) throw new Error(`runtimeMode "${stored}" instead of "${expected}"`);
        continue;
      }
      const trimmed = expectedEnvString(submittedEnv[key]);
      if (!trimmed.startsWith(stored)) {
        throw new Error(`env.${key} "${stored}" is not a prefix of "${trimmed}"`);
      }
      if (trimmed.length <= ENV_FIELD_MAX_LENGTH && stored !== trimmed) {
        throw new Error(`env.${key} "${stored}" was altered although "${trimmed}" already fits`);
      }
      if (trimmed.length > ENV_FIELD_MAX_LENGTH && stored.length !== ENV_FIELD_MAX_LENGTH) {
        throw new Error(`env.${key} truncated to ${stored.length} instead of ${ENV_FIELD_MAX_LENGTH}`);
      }
    }
    return true;
  }),
);

// Feature: telemetry-phone-home, Property 19: Ingest sanitization is exact
property('keeps exactly the catalog counters carrying an integer in range', () =>
  fc.property(sanitizationCase, ({ nowMs, installId, metricDay, env, counters, junk }) => {
    const result = normalizeRollup(
      { ...junk, installId, metricDay, env, counters, schemaVersion: TELEMETRY_SCHEMA_VERSION },
      nowMs,
    );
    if (result === null) throw new Error('a well-keyed Rollup was rejected');

    const submitted =
      counters !== null && typeof counters === 'object' && !Array.isArray(counters) ? counters : {};
    const expected = Object.entries(submitted).filter(
      ([name, value]) =>
        COUNTER_CATALOG.has(name) &&
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= COUNTER_VALUE_MIN &&
        value <= COUNTER_VALUE_MAX,
    );

    const storedKeys = Object.keys(result.counters).sort().join(',');
    const expectedKeys = expected.map(([name]) => name).sort().join(',');
    if (storedKeys !== expectedKeys) {
      throw new Error(`stored counters "${storedKeys}" instead of "${expectedKeys}"`);
    }
    for (const [name, value] of expected) {
      if (result.counters[name] !== value) {
        throw new Error(`counter ${name} stored as ${result.counters[name]} instead of ${value}`);
      }
    }
    return true;
  }),
);

// ── Property 27: admin authorization decides on exactly four outcomes ────────
//
// Two independent facts, never merged: is the caller verified, and is the
// verified identity on the Owner_Allowlist. The allowlist half is exhausted on
// the pure `isTelemetryAdmin` - absent, empty, whitespace-only and padded
// entries, and the substring case that a naive `includes()` on the raw secret
// would get wrong. The HTTP half is driven through the real handler for every
// verification outcome reachable without a Clerk instance:
//
//   | env                          | Authorization        | verifyRequest    | status |
//   |------------------------------|----------------------|------------------|--------|
//   | BYO + PHORMA_TOKEN           | absent / blank       | not consulted    | 401    |
//   | BYO + PHORMA_TOKEN           | wrong token          | null             | 401    |
//   | hosted, no Clerk key         | any token            | null             | 401    |
//   | BYO + PHORMA_TOKEN           | the shared token     | { userId: null } | 403    |
//   | BYO, no secrets at all       | any token            | { userId: null } | 403    |
//
// The 200 answer needs a token that resolves to a non-null Clerk user id, which
// cannot be minted here; `cloud/test/telemetry-admin.test.mjs` owns it.

console.log('\nProperty 27: admin authorization decides on exactly four outcomes');

const USER_IDS = ['user_2abcDEF', 'user_123', 'user_1234', 'user_zzz', 'user_2abcDEFG'];

/** An allowlist secret plus the exact ids it is meant to admit. */
const allowlistCase = fc
  .array(
    fc.record({
      id: fc.constantFrom(...USER_IDS),
      lead: fc.constantFrom('', ' ', '  ', '\t'),
      trail: fc.constantFrom('', ' ', '  ', '\n'),
    }),
    { maxLength: 4 },
  )
  .chain(entries =>
    fc.record({
      entries: fc.constant(entries),
      // Empty segments a hand-edited secret routinely grows.
      blanks: fc.array(fc.constantFrom('', ' ', '   '), { maxLength: 3 }),
      shuffle: fc.boolean(),
    }),
  )
  .map(({ entries, blanks, shuffle }) => {
    const segments = [...entries.map(e => `${e.lead}${e.id}${e.trail}`), ...blanks];
    if (shuffle) segments.reverse();
    return { secret: segments.join(','), admitted: entries.map(e => e.id) };
  });

const userIdCase = fc.oneof(
  fc.constantFrom(...USER_IDS),
  fc.constantFrom(null),
  fc.constantFrom(' user_123', 'user_123 ', 'USER_123', 'user_12', 'user_', ''),
  fc.string({ maxLength: 12 }),
);

// Feature: telemetry-phone-home, Property 27: Admin authorization decides on exactly four outcomes
property('admits exactly the trimmed allowlist entries, and only a non-null id', () =>
  fc.property(allowlistCase, userIdCase, ({ secret, admitted }, userId) => {
    const expected = userId !== null && admitted.includes(userId);
    const actual = isTelemetryAdmin(secret, userId);
    if (actual !== expected) {
      throw new Error(
        `secret ${JSON.stringify(secret)} with id ${JSON.stringify(userId)}: expected ${expected}, got ${actual}`,
      );
    }
    return true;
  }),
);

// Feature: telemetry-phone-home, Property 27: Admin authorization decides on exactly four outcomes
property('refuses every caller while the allowlist is absent, empty or whitespace-only', () =>
  fc.property(
    fc.constantFrom(undefined, '', ' ', '   ', '\t', '\n', ',', ',,', ' , , '),
    userIdCase,
    (secret, userId) => isTelemetryAdmin(secret, userId) === false,
  ),
);

// Feature: telemetry-phone-home, Property 27: Admin authorization decides on exactly four outcomes
property('never authorizes an id that is merely a substring or superstring of an entry', () =>
  fc.property(
    fc.constantFrom(...USER_IDS),
    fc.integer({ min: 1, max: 4 }),
    fc.string({ minLength: 1, maxLength: 3 }),
    (entry, cut, suffix) => {
      const shorter = entry.slice(0, Math.max(1, entry.length - cut));
      const longer = `${entry}${suffix}`;
      return (
        isTelemetryAdmin(entry, shorter) === false &&
        isTelemetryAdmin(entry, longer) === false &&
        isTelemetryAdmin(entry, entry) === true
      );
    },
  ),
);

check(
  'user_123 does not authorize user_1234',
  isTelemetryAdmin('user_123', 'user_1234') === false,
);
check(
  'user_1234 does not authorize user_123',
  isTelemetryAdmin('user_1234', 'user_123') === false,
);
check(
  'a padded entry still authorizes its trimmed id',
  isTelemetryAdmin('  user_123 , user_zzz  ', 'user_123') === true,
);
check('a null user id is never a member', isTelemetryAdmin('user_123', null) === false);

/** The JSON responder `routeApiRequest` hands the admin handler. */
function respond(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function adminRequest(authorization) {
  const headers = authorization === undefined ? {} : { Authorization: authorization };
  return new Request('https://cloud.example.test/api/admin/telemetry/summary', { headers });
}

async function adminStatus(env, authorization) {
  const request = adminRequest(authorization);
  const url = new URL(request.url);
  const response = await handleTelemetryAdminRequest(request, env, url, respond);
  return response === null ? 'null' : response.status;
}

const SHARED_TOKEN = 'byo-shared-token';

// Feature: telemetry-phone-home, Property 27: Admin authorization decides on exactly four outcomes
await asyncProperty('answers 401 for an absent or rejected credential, 403 for a null identity', () =>
  fc.asyncProperty(
    fc.oneof(allowlistCase.map(c => c.secret), fc.constantFrom(undefined, '', '   ')),
    fc.constantFrom('absent', 'blank', 'notBearer', 'wrongToken', 'sharedToken', 'openInstance', 'hostedNoClerk'),
    async (secret, shape) => {
      const byo = { PHORMA_TOKEN: SHARED_TOKEN, TELEMETRY_ADMIN_USER_IDS: secret };
      const cases = {
        absent: [byo, undefined, 401],
        blank: [byo, 'Bearer    ', 401],
        notBearer: [byo, `Basic ${SHARED_TOKEN}`, 401],
        wrongToken: [byo, 'Bearer not-the-shared-token', 401],
        sharedToken: [byo, `Bearer ${SHARED_TOKEN}`, 403],
        openInstance: [{ TELEMETRY_ADMIN_USER_IDS: secret }, 'Bearer anything', 403],
        hostedNoClerk: [
          { PHORMA_MODE: 'hosted', TELEMETRY_ADMIN_USER_IDS: secret },
          'Bearer anything',
          401,
        ],
      };
      const [env, authorization, expected] = cases[shape];
      const status = await adminStatus(env, authorization);
      if (status !== expected) {
        throw new Error(`${shape} with secret ${JSON.stringify(secret)}: expected ${expected}, got ${status}`);
      }
      return true;
    },
  ),
);

check(
  'a path outside the admin prefix falls through',
  (await handleTelemetryAdminRequest(
    new Request('https://cloud.example.test/api/me'),
    { PHORMA_TOKEN: SHARED_TOKEN },
    new URL('https://cloud.example.test/api/me'),
    respond,
  )) === null,
);
check(
  'no failure body names the allowlist',
  await (async () => {
    const request = adminRequest(`Bearer ${SHARED_TOKEN}`);
    const response = await handleTelemetryAdminRequest(
      request,
      { PHORMA_TOKEN: SHARED_TOKEN, TELEMETRY_ADMIN_USER_IDS: 'user_secret_owner' },
      new URL(request.url),
      respond,
    );
    const text = await response.text();
    return response.status === 403 && !text.includes('user_secret_owner') && text === '{"error":"Forbidden."}';
  })(),
);

// ── Property 28: date range parsing and capping are exact ────────────────────
//
// The oracle is an independently written calendar check - a leap-year rule and a
// month-length table, not a `Date` round trip - so `2026-02-30` and `2025-02-29`
// are rejected by arithmetic here rather than by the same mechanism the
// implementation uses.

console.log('\nProperty 28: date range parsing and capping are exact');

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** A real `YYYY-MM-DD` calendar day, decided from a month-length table. */
function isRealDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= lengths[month - 1];
}

function inclusiveDays(from, to) {
  const span = Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`);
  return Math.round(span / MS_PER_DAY) + 1;
}

function searchParams(from, to) {
  const params = new URLSearchParams();
  if (from !== undefined) params.set('from', from);
  if (to !== undefined) params.set('to', to);
  return params;
}

const realDayArb = fc
  .integer({ min: Date.parse('1971-01-01T00:00:00Z'), max: Date.parse('2098-12-31T00:00:00Z') })
  .map(ms => new Date(ms).toISOString().slice(0, 10));

const dayParam = fc.oneof(
  realDayArb,
  fc.constantFrom(
    '2026-02-30',
    '2025-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-00-01',
    '2026-01-00',
    '2026-1-1',
    '26-01-01',
    '',
    '   ',
    'yesterday',
    '2026-01-01T00:00:00Z',
    '2024-02-29',
  ),
  fc.string({ maxLength: 12 }),
);

const rangeCase = fc.record({
  today: realDayArb,
  from: fc.option(dayParam, { nil: undefined }),
  to: fc.option(dayParam, { nil: undefined }),
});

// Feature: telemetry-phone-home, Property 28: Date range parsing and capping are exact
property('accepts exactly the real, ordered, in-cap ranges and defaults on an absent parameter', () =>
  fc.property(rangeCase, ({ today, from, to }) => {
    const result = parseDateRange(searchParams(from, to), today);
    const defaulted = from === undefined || to === undefined;
    const expectedOk = defaulted
      ? true
      : isRealDay(from) && isRealDay(to) && from <= to && inclusiveDays(from, to) <= TELEMETRY_RANGE_MAX_DAYS;

    if (result.ok !== expectedOk) {
      throw new Error(
        `from ${JSON.stringify(from)} to ${JSON.stringify(to)} on ${today}: expected ok ${expectedOk}, got ${result.ok} ${result.ok ? '' : result.error}`,
      );
    }
    if (!result.ok) {
      if (result.error !== INVALID_RANGE_ERROR) throw new Error(`error "${result.error}"`);
      return true;
    }
    if (defaulted) {
      const expectedFrom = new Date(
        Date.parse(`${today}T00:00:00.000Z`) - (TELEMETRY_RANGE_DEFAULT_DAYS - 1) * MS_PER_DAY,
      )
        .toISOString()
        .slice(0, 10);
      if (result.range.to !== today || result.range.from !== expectedFrom) {
        throw new Error(
          `default range ${result.range.from}..${result.range.to} instead of ${expectedFrom}..${today}`,
        );
      }
      if (inclusiveDays(result.range.from, result.range.to) !== TELEMETRY_RANGE_DEFAULT_DAYS) {
        throw new Error('the default range is not exactly 30 inclusive days');
      }
      return true;
    }
    if (result.range.from !== from || result.range.to !== to) {
      throw new Error(`range ${result.range.from}..${result.range.to} instead of ${from}..${to}`);
    }
    return true;
  }),
);

// Feature: telemetry-phone-home, Property 28: Date range parsing and capping are exact
property('caps the inclusive length at 400 days, accepting exactly 400', () =>
  fc.property(realDayArb, fc.integer({ min: 0, max: 500 }), (from, span) => {
    const to = new Date(Date.parse(`${from}T00:00:00.000Z`) + span * MS_PER_DAY)
      .toISOString()
      .slice(0, 10);
    const result = parseDateRange(searchParams(from, to), from);
    return result.ok === (span + 1 <= TELEMETRY_RANGE_MAX_DAYS);
  }),
);

{
  const today = '2026-06-15';
  const range = (from, to) => parseDateRange(searchParams(from, to), today);
  check('an inclusive span of exactly 400 days is accepted', range('2025-05-12', '2026-06-15').ok);
  check('an inclusive span of 401 days is rejected', range('2025-05-11', '2026-06-15').ok === false);
  check('a single day is accepted', range('2026-06-15', '2026-06-15').ok);
  check('from later than to is rejected', range('2026-06-16', '2026-06-15').ok === false);
  check('a rolled-over calendar date is rejected', range('2026-02-30', '2026-06-15').ok === false);
  check('an unpadded date is rejected', range('2026-1-1', '2026-06-15').ok === false);
  check('a real leap day is accepted', range('2024-02-29', '2024-03-01').ok);
  check('an empty parameter is present-but-invalid, not absent', range('', '2026-06-15').ok === false);
  check(
    'an absent from defaults without validating its partner',
    (() => {
      const result = parseDateRange(searchParams(undefined, 'not-a-day'), today);
      return result.ok && result.range.to === today && result.range.from === '2026-05-17';
    })(),
  );
  check('an unusable today is rejected rather than fabricated', parseDateRange(searchParams(), 'nope').ok === false);
}

// ── Property 30: the k-anonymity floor holds and conserves metrics ───────────
//
// Conservation is the load-bearing half: a reader who adds up the response has
// to get the same totals as the underlying groups, or the fold has quietly
// deleted usage. So for EVERY numeric metric, not just `installs`, the sum across
// the output equals the sum across the input.
//
// The floor itself is strict: `installs` below 5 folds, exactly 5 stays. A row
// whose `installs` is not a finite number folds, because a group we cannot size
// must not be published.

console.log('\nProperty 30: the k-anonymity floor holds and conserves metrics');

/** The floor's own reading of a row's install count: non-finite counts as zero. */
function installsOf(row) {
  return typeof row.installs === 'number' && Number.isFinite(row.installs) ? row.installs : 0;
}

/** Every numeric key present anywhere in a row list. */
function numericKeys(rows) {
  const keys = new Set();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (key !== 'label' && typeof value === 'number') keys.add(key);
    }
  }
  return [...keys];
}

function sumMetric(rows, key) {
  return rows.reduce((total, row) => total + (typeof row[key] === 'number' ? row[key] : 0), 0);
}

// Labels exclude the literal `other` here: an INPUT row already labelled `other`
// is a separate case, covered by the examples below, and it would otherwise make
// "no `other` row when nothing folds" read as a violation.
const groupRow = fc
  .record({
    label: fc
      .string({ minLength: 1, maxLength: 6 })
      .filter(text => text !== K_ANONYMITY_OTHER_LABEL),
    installs: fc.integer({ min: 0, max: 12 }),
    runs: fc.option(fc.integer({ min: 0, max: 5000 }), { nil: undefined }),
    sessions: fc.option(fc.integer({ min: 0, max: 5000 }), { nil: undefined }),
    note: fc.option(fc.string({ maxLength: 4 }), { nil: undefined }),
  })
  .map(({ label, installs, runs, sessions, note }) => {
    const row = { label, installs };
    if (runs !== undefined) row.runs = runs;
    if (sessions !== undefined) row.sessions = sessions;
    if (note !== undefined) row.note = note;
    return row;
  });

const groupRows = fc.array(groupRow, { maxLength: 12 });

// Feature: telemetry-phone-home, Property 30: The k-anonymity floor holds and conserves metrics
property('publishes no group below the floor and at most one other row', () =>
  fc.property(groupRows, rows => {
    const out = applyKAnonymity(rows);
    for (const row of out) {
      if (row.label === K_ANONYMITY_OTHER_LABEL) continue;
      if (installsOf(row) < K_ANONYMITY_FLOOR) {
        throw new Error(`published "${row.label}" with ${row.installs} installs`);
      }
    }
    const others = out.filter(row => row.label === K_ANONYMITY_OTHER_LABEL).length;
    if (others > 1) throw new Error(`${others} rows labelled other`);
    return true;
  }),
);

// Feature: telemetry-phone-home, Property 30: The k-anonymity floor holds and conserves metrics
property('conserves the sum of every numeric metric', () =>
  fc.property(groupRows, rows => {
    const out = applyKAnonymity(rows);
    for (const key of numericKeys(rows)) {
      const before = sumMetric(rows, key);
      const after = sumMetric(out, key);
      if (before !== after) {
        throw new Error(`${key} sums to ${after} after the fold, ${before} before`);
      }
    }
    return true;
  }),
);

// Feature: telemetry-phone-home, Property 30: The k-anonymity floor holds and conserves metrics
property('adds no other row when every group reaches the floor', () =>
  fc.property(
    fc.array(groupRow.map(row => ({ ...row, installs: row.installs + K_ANONYMITY_FLOOR })), {
      maxLength: 10,
    }),
    rows => {
      const out = applyKAnonymity(rows);
      if (out.some(row => row.label === K_ANONYMITY_OTHER_LABEL)) {
        throw new Error('an other row appeared although nothing folded');
      }
      if (JSON.stringify(out) !== JSON.stringify(rows)) {
        throw new Error(`output ${JSON.stringify(out)} differs from input ${JSON.stringify(rows)}`);
      }
      return true;
    },
  ),
);

// Feature: telemetry-phone-home, Property 30: The k-anonymity floor holds and conserves metrics
property('never mutates its input and never hands back a reference into it', () =>
  fc.property(groupRows, rows => {
    const before = JSON.stringify(rows);
    const out = applyKAnonymity(rows);
    if (JSON.stringify(rows) !== before) throw new Error('the input rows were mutated');
    return out.every(row => !rows.includes(row));
  }),
);

// Feature: telemetry-phone-home, Property 30: The k-anonymity floor holds and conserves metrics
property('applies the same rule for any floor', () =>
  fc.property(groupRows, fc.integer({ min: 1, max: 10 }), (rows, floor) => {
    const out = applyKAnonymity(rows, floor);
    const foldedInput = rows.filter(row => installsOf(row) < floor);
    if (foldedInput.length === 0) {
      return out.every(row => row.label !== K_ANONYMITY_OTHER_LABEL);
    }
    const published = out.filter(row => row.label !== K_ANONYMITY_OTHER_LABEL);
    return (
      published.every(row => installsOf(row) >= floor) &&
      sumMetric(out, 'installs') === sumMetric(rows, 'installs')
    );
  }),
);

{
  const rows = [
    { label: 'DE', installs: 5, runs: 50 },
    { label: 'FR', installs: 4, runs: 40 },
    { label: 'IT', installs: 1, runs: 7 },
  ];
  const out = applyKAnonymity(rows);
  check('installs of exactly 5 keeps its own row', out[0]?.label === 'DE' && out[0]?.installs === 5);
  check('installs of 4 folds', out.every(row => row.label !== 'FR'));
  check(
    'the other row sums the folded groups',
    out.at(-1)?.label === K_ANONYMITY_OTHER_LABEL &&
      out.at(-1)?.installs === 5 &&
      out.at(-1)?.runs === 47,
    JSON.stringify(out.at(-1)),
  );
  check('the fold conserves runs', sumMetric(out, 'runs') === 97, String(sumMetric(out, 'runs')));

  check(
    'nothing folds means no other row at all',
    applyKAnonymity([{ label: 'DE', installs: 5 }, { label: 'US', installs: 9 }]).every(
      row => row.label !== K_ANONYMITY_OTHER_LABEL,
    ),
  );
  check(
    'everything folding leaves exactly one other row',
    (() => {
      const folded = applyKAnonymity([
        { label: 'DE', installs: 1, runs: 2 },
        { label: 'FR', installs: 2, runs: 3 },
      ]);
      return (
        folded.length === 1 &&
        folded[0].label === K_ANONYMITY_OTHER_LABEL &&
        folded[0].installs === 3 &&
        folded[0].runs === 5
      );
    })(),
  );
  check(
    'an input row already labelled other joins the fold rather than doubling it',
    (() => {
      const folded = applyKAnonymity([
        { label: K_ANONYMITY_OTHER_LABEL, installs: 9, runs: 90 },
        { label: 'FR', installs: 2, runs: 20 },
      ]);
      return (
        folded.length === 1 &&
        folded[0].label === K_ANONYMITY_OTHER_LABEL &&
        folded[0].installs === 11 &&
        folded[0].runs === 110
      );
    })(),
  );
  check(
    'a row whose installs cannot be sized folds',
    applyKAnonymity([
      { label: 'DE', installs: Number.NaN },
      { label: 'US', installs: Number.POSITIVE_INFINITY },
      { label: 'FR', installs: 7 },
    ]).every(row => row.label === 'FR' || row.label === K_ANONYMITY_OTHER_LABEL),
  );
  check(
    'a non-numeric metric is dropped from the other row',
    (() => {
      const folded = applyKAnonymity([{ label: 'DE', installs: 1, runs: 2, note: 'hello' }]);
      return Object.keys(folded[0]).sort().join(',') === 'installs,label,runs';
    })(),
  );
}

console.log(failures === 0 ? '\ntelemetry: all checks passed' : `\ntelemetry: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
