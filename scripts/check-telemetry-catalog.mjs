#!/usr/bin/env node
/**
 * check-telemetry-catalog.mjs
 *
 * Anonymous usage telemetry has three pairs of hand-written declarations that
 * MUST agree, and no compiler can see across any of the three boundaries:
 *
 * 1. `frontend/src/app/core/telemetry-catalog.ts` and `cloud/src/telemetry-catalog.ts`
 *    are structural twins - the studio and the Worker declare the Counter_Catalog,
 *    the schema version and the disclosure version independently, with no import
 *    across the package boundary. A name only one side knows is a counter that is
 *    collected on the client and then silently dropped at ingest (3.1).
 * 2. `cloud/migrations/0002_telemetry.sql` (the deploy path) and
 *    `TELEMETRY_SCHEMA_STATEMENTS` in `cloud/src/telemetry.ts` (the runtime
 *    self-healing path) carry the same DDL. Drift means the tables a migrated
 *    deployment has and the tables the Worker assumes are different, which
 *    surfaces as a runtime D1 error on a column nobody notices is missing (8.4).
 * 3. `COUNTED_PANEL_IDS` in the frontend catalog and `DEFAULT_TABS` in
 *    `frontend/src/app/core/panel-registry.service.ts`. `DEFAULT_TABS` is
 *    module-private and `PanelTab.id` is a plain `string`, so the catalog cannot
 *    pin itself to it with `satisfies`; a new panel would just never be counted.
 *
 * The two catalog modules and `telemetry.ts` are EXECUTED here rather than parsed,
 * so the assertion covers `counterName`, the family expansion and every list at
 * once. `DEFAULT_TABS` is read from source, because a private value on an Angular
 * service cannot be imported.
 *
 * Run: node scripts/check-telemetry-catalog.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const STUDIO_CATALOG = resolve(ROOT, 'frontend', 'src', 'app', 'core', 'telemetry-catalog.ts');
const WORKER_CATALOG = resolve(ROOT, 'cloud', 'src', 'telemetry-catalog.ts');
const WORKER_TELEMETRY = resolve(ROOT, 'cloud', 'src', 'telemetry.ts');
const MIGRATION = resolve(ROOT, 'cloud', 'migrations', '0002_telemetry.sql');
const PANEL_REGISTRY = resolve(ROOT, 'frontend', 'src', 'app', 'core', 'panel-registry.service.ts');

/** Dimension lists that must be declared identically on both sides. */
const DIMENSION_LISTS = [
  'COUNTED_NODE_KINDS',
  'COUNTED_PANEL_IDS',
  'COUNTED_ASSISTANT_MODES',
  'COUNTED_DEPLOY_TARGETS',
  'ERROR_CATEGORIES',
];

/** Scalars that must hold the same value on both sides. */
const SHARED_SCALARS = ['TELEMETRY_SCHEMA_VERSION', 'CURRENT_DISCLOSURE_VERSION'];

/** Packages that may own the `tsx` install this guard loads TypeScript through. */
const TSX_HOSTS = ['cloud', 'cloud-aws', 'engine', 'frontend'];

const failures = [];

// --- TypeScript loading ----------------------------------------------------

/**
 * Resolves `tsImport` out of whichever package already depends on `tsx`. The repo
 * root has no `node_modules`, and CI runs on Node 20, which cannot strip types on
 * its own - so an installed `tsx` is the only route to the real modules.
 */
async function loadTsImport() {
  for (const host of TSX_HOSTS) {
    const manifest = resolve(ROOT, host, 'package.json');
    if (!existsSync(manifest)) continue;
    let entry;
    try {
      entry = createRequire(manifest).resolve('tsx/esm/api');
    } catch {
      continue;
    }
    const api = await import(pathToFileURL(entry).href);
    const tsImport = api.tsImport ?? api.default?.tsImport;
    if (typeof tsImport === 'function') return tsImport;
  }
  return null;
}

const tsImport = await loadTsImport();
if (tsImport === null) {
  console.error(
    'could not resolve `tsx` from any of ' +
      TSX_HOSTS.join(', ') +
      ' - run `npm install` in `cloud` first.',
  );
  process.exit(1);
}

/**
 * `frontend/package.json` declares no `"type": "module"`, so tsx transforms that
 * package's TypeScript to CommonJS and the exports arrive on `default`. `cloud`
 * IS a module, so its exports arrive as a normal namespace. Probe rather than
 * assume, so neither package flipping its type breaks the guard silently.
 */
function exportsOf(namespace, probe) {
  const cjs = namespace.default;
  if (cjs && typeof cjs === 'object' && probe in cjs) return cjs;
  return namespace;
}

async function loadModule(path, probe) {
  try {
    return exportsOf(await tsImport(pathToFileURL(path).href, import.meta.url), probe);
  } catch (error) {
    console.error(`could not load ${path}: ${error.message}`);
    process.exit(1);
  }
}

const studio = await loadModule(STUDIO_CATALOG, 'COUNTER_CATALOG');
const worker = await loadModule(WORKER_CATALOG, 'COUNTER_CATALOG');
const workerTelemetry = await loadModule(WORKER_TELEMETRY, 'TELEMETRY_SCHEMA_STATEMENTS');

// --- Comparison helpers ----------------------------------------------------

/** A `ReadonlySet`, an array or `undefined`, as a sorted array of strings. */
function toSortedNames(value) {
  if (value instanceof Set) return [...value].map(String).sort();
  if (Array.isArray(value)) return value.map(String).sort();
  return null;
}

/** Reports every one-sided member of two name collections. */
function compareNames(label, studioValue, workerValue) {
  const left = toSortedNames(studioValue);
  const right = toSortedNames(workerValue);
  if (left === null || right === null) {
    const side = left === null ? 'the studio' : 'the Worker';
    failures.push(`${label} is not a set or an array on ${side} side`);
    return;
  }
  if (left.length === 0) {
    failures.push(`${label} is empty - the catalog cannot be`);
    return;
  }
  for (const name of left) {
    if (!right.includes(name)) {
      failures.push(`${label}: "${name}" is in the studio twin but not the Worker twin`);
    }
  }
  for (const name of right) {
    if (!left.includes(name)) {
      failures.push(`${label}: "${name}" is in the Worker twin but not the studio twin`);
    }
  }
}

// --- 1. Catalog twin identity ----------------------------------------------

compareNames('COUNTER_CATALOG', studio.COUNTER_CATALOG, worker.COUNTER_CATALOG);

// Redundant with the catalog comparison above whenever a family is dimensioned,
// but it names the list that drifted instead of 25 counter names.
for (const list of DIMENSION_LISTS) {
  compareNames(list, studio[list], worker[list]);
}

compareNames(
  'DIMENSIONLESS_COUNTER_FAMILIES',
  studio.DIMENSIONLESS_COUNTER_FAMILIES,
  worker.DIMENSIONLESS_COUNTER_FAMILIES,
);
compareNames(
  'DIMENSIONED_COUNTER_FAMILIES',
  Object.keys(studio.DIMENSIONED_COUNTER_FAMILIES ?? {}),
  Object.keys(worker.DIMENSIONED_COUNTER_FAMILIES ?? {}),
);

for (const scalar of SHARED_SCALARS) {
  if (studio[scalar] !== worker[scalar]) {
    failures.push(
      `${scalar} is ${JSON.stringify(studio[scalar])} in the studio twin and ` +
        `${JSON.stringify(worker[scalar])} in the Worker twin`,
    );
  }
}

// The client stamps every Rollup with its own schema version, so a version the
// Ingest_Endpoint does not accept rejects the whole fleet.
const knownVersions = worker.KNOWN_SCHEMA_VERSIONS;
if (!Array.isArray(knownVersions)) {
  failures.push('cloud/src/telemetry-catalog.ts does not export KNOWN_SCHEMA_VERSIONS as an array');
} else if (!knownVersions.includes(studio.TELEMETRY_SCHEMA_VERSION)) {
  failures.push(
    `KNOWN_SCHEMA_VERSIONS ${JSON.stringify(knownVersions)} does not accept the studio's ` +
      `TELEMETRY_SCHEMA_VERSION ${JSON.stringify(studio.TELEMETRY_SCHEMA_VERSION)} - ` +
      'every Rollup would be rejected',
  );
}

// --- 2. Migration and runtime DDL are the same SQL -------------------------

/**
 * Splits a migration file into statements: strips `--` line comments (the file
 * has no string literal containing `--`), splits on `;`, drops what is left of
 * blank segments.
 */
function migrationStatements(sql) {
  return sql
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Canonical form for comparison: every run of whitespace becomes one space. That
 * absorbs line endings, indentation and the trailing `;`, and nothing else - a
 * changed column, type, default, table name or index column list changes a token
 * and still fails.
 */
function canonicalSql(statement) {
  return statement.replace(/\s+/g, ' ').trim();
}

const declared = workerTelemetry.TELEMETRY_SCHEMA_STATEMENTS;
if (!Array.isArray(declared)) {
  failures.push('cloud/src/telemetry.ts does not export TELEMETRY_SCHEMA_STATEMENTS as an array');
} else if (!existsSync(MIGRATION)) {
  failures.push('cloud/migrations/0002_telemetry.sql does not exist');
} else {
  const migrated = migrationStatements(readFileSync(MIGRATION, 'utf-8'));
  if (migrated.length !== declared.length) {
    failures.push(
      `0002_telemetry.sql has ${migrated.length} statement(s) and ` +
        `TELEMETRY_SCHEMA_STATEMENTS has ${declared.length} - they carry the same DDL or neither`,
    );
  }
  const pairs = Math.min(migrated.length, declared.length);
  for (let i = 0; i < pairs; i++) {
    const fromFile = canonicalSql(migrated[i]);
    const fromCode = canonicalSql(String(declared[i]));
    if (fromFile !== fromCode) {
      failures.push(
        `statement ${i + 1} differs between 0002_telemetry.sql and TELEMETRY_SCHEMA_STATEMENTS\n` +
          `    migration: ${fromFile}\n` +
          `    constant:  ${fromCode}`,
      );
    }
  }
  // 8.4: the Worker re-applies this DDL once per isolate on a store that may
  // already exist, so every statement has to be a no-op the second time.
  for (const [i, statement] of declared.entries()) {
    if (!/IF NOT EXISTS/i.test(String(statement))) {
      failures.push(
        `TELEMETRY_SCHEMA_STATEMENTS statement ${i + 1} has no IF NOT EXISTS, so ` +
          're-applying the schema throws instead of doing nothing',
      );
    }
  }
}

// --- 3. COUNTED_PANEL_IDS mirrors DEFAULT_TABS -----------------------------

const registrySource = readFileSync(PANEL_REGISTRY, 'utf-8');
const tabsBlock = /const DEFAULT_TABS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(registrySource);
if (tabsBlock === null) {
  failures.push(
    'could not find the DEFAULT_TABS array literal in core/panel-registry.service.ts - ' +
      'this guard reads it from source because it is module-private',
  );
} else {
  const tabIds = [...tabsBlock[1].matchAll(/\bid:\s*'([^']+)'/g)].map((match) => match[1]);
  const counted = studio.COUNTED_PANEL_IDS ?? [];
  if (tabIds.length === 0) {
    failures.push('parsed zero ids out of DEFAULT_TABS - the literal shape changed');
  } else if (tabIds.join(',') !== [...counted].join(',')) {
    // Order matters too: the catalog documents itself as being in DEFAULT_TABS order.
    failures.push(
      'COUNTED_PANEL_IDS does not match DEFAULT_TABS in core/panel-registry.service.ts\n' +
        `    DEFAULT_TABS:       ${tabIds.join(', ')}\n` +
        `    COUNTED_PANEL_IDS:  ${[...counted].join(', ')}`,
    );
  }
}

// --- Report ----------------------------------------------------------------

if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL: ${failure}`);
  console.error(`\ncheck-telemetry-catalog FAILED with ${failures.length} failure(s).`);
  process.exit(1);
}

const catalogSize = toSortedNames(studio.COUNTER_CATALOG)?.length ?? 0;
console.log(
  `check-telemetry-catalog passed: ${catalogSize} counter names identical across both twins, ` +
    `${declared.length} schema statements identical to the migration, ` +
    'COUNTED_PANEL_IDS matches DEFAULT_TABS.',
);
