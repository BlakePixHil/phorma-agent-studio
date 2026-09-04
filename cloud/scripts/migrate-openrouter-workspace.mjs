#!/usr/bin/env node
/**
 * migrate-openrouter-workspace.mjs - move every tenant's OpenRouter runtime key
 * into the dedicated Phorma Cloud workspace (task 10.2, requirement 40).
 *
 * DRY RUN BY DEFAULT. Nothing is written anywhere without `--apply`, and the
 * dry run performs GETs only - against D1 as well, where the shim below refuses
 * any statement that is not a SELECT.
 *
 *   cd cloud
 *   $env:OPENROUTER_PROVISIONING_KEY = "sk-or-v1-..."     # the MANAGEMENT key
 *   npx tsx scripts/migrate-openrouter-workspace.mjs --workspace phorma-cloud
 *
 *   # then, once the plan reads correctly:
 *   $env:KEY_ENC_SECRET = "<the hosted worker's KEY_ENC_SECRET>"
 *   npx tsx scripts/migrate-openrouter-workspace.mjs --workspace phorma-cloud --apply
 *
 * `tsx`, not `node`: this imports `../src/tenants.ts` so the rotation, the
 * encryption and the tier caps are the SAME code the worker runs.
 *
 * ## Order of operations for the real migration
 *
 * 1. Create the workspace in the OpenRouter dashboard.
 * 2. Dry-run this script and read the plan.
 * 3. Set `OPENROUTER_WORKSPACE_ID` in `wrangler.jsonc` (`env.hosted.vars`) to the
 *    workspace UUID and `wrangler deploy --env hosted`. Do this BEFORE `--apply`:
 *    the deployed worker mints keys of its own (a new subscriber, a tier change
 *    that finds no usable key), and until it knows the workspace those land in the
 *    default one and need migrating again.
 * 4. Run with `--apply`.
 * 5. Re-run WITHOUT `--apply`. Every active tenant must read
 *    `skip_already_migrated`, which is the migration's own proof that it is done.
 * 6. Anything still reported as skipped or unclaimed is task 10.4: retire it by
 *    hand in the OpenRouter dashboard.
 *
 * ## Flags
 *
 *   --workspace <uuid|slug|name>  REQUIRED. Resolved against `GET /workspaces`.
 *   --apply                       Perform the writes. Absent = plan only.
 *   --tenant <user_...>           One tenant, for a first cautious apply.
 *   --database <name>             D1 database, default `phorma-cloud`.
 *   --env <name>                  wrangler environment, default `hosted`.
 *   --local                       Plan against the LOCAL D1 instead of the remote
 *                                 one. Cannot be combined with `--apply` - see the
 *                                 note in `parseArgs`.
 *   --no-cache-purge              Skip the KV purge (see below), for a database
 *                                 with no `TENANTS` binding.
 *   --out <file.json>             Write the full report, which is also the
 *                                 inventory (task 10.3) in machine-readable form.
 *                                 NAME IT `report.json` or `<something>-report.json`:
 *                                 a plan run against the hosted database inventories
 *                                 LIVE tenants, so the file carries Clerk user ids and
 *                                 OpenRouter key hashes, and those are the names
 *                                 `cloud/.gitignore` and `scripts/check-deploy-bundle.mjs`
 *                                 cover. Any other name is committable and fails the
 *                                 bundle guard on your machine.
 *
 * ## Environment
 *
 *   OPENROUTER_PROVISIONING_KEY   required. The account-level MANAGEMENT key.
 *   KEY_ENC_SECRET                required for `--apply` only; it is what a
 *                                 minted key is encrypted with before storage.
 *
 * Neither is read from `.dev.vars` on purpose: this touches the REMOTE database,
 * so the operator supplies the deployed worker's values deliberately rather than
 * inheriting a local placeholder that would encrypt keys nothing can decrypt.
 *
 * ## Why the KV purge is part of the job
 *
 * `getTenant` caches a tenant row in KV for 60s, and a rotation disables the old
 * key immediately. A worker holding a cached row would keep handing runs a key
 * OpenRouter now refuses. `TenantStore.setRuntimeKey` deletes that entry when a
 * `TENANTS` binding exists; this script has no bindings, so it shells out to
 * `wrangler kv key delete` after each mint instead.
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { formatReport, migrateWorkspace, resolveWorkspace } from './workspace-migration.mjs';

const CLOUD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = createRequire(join(CLOUD_DIR, 'package.json')).resolve('wrangler/bin/wrangler.js');

// ── Arguments ───────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const flags = {
    workspace: null,
    apply: false,
    tenant: null,
    database: 'phorma-cloud',
    env: 'hosted',
    local: false,
    cachePurge: true,
    out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value.`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--workspace': flags.workspace = next(); break;
      case '--apply': flags.apply = true; break;
      case '--tenant': flags.tenant = next(); break;
      case '--database': flags.database = next(); break;
      case '--env': flags.env = next(); break;
      case '--local': flags.local = true; break;
      case '--no-cache-purge': flags.cachePurge = false; break;
      case '--out': flags.out = next(); break;
      case '--help': case '-h': flags.help = true; break;
      default: throw new Error(`Unknown argument "${arg}".`);
    }
  }
  // Verified on wrangler 4 (2026-09-03): `d1 execute --local --json` answers with
  // `meta: { duration }` and NO `changes`, while the remote form carries the real
  // count. `TenantStore.setRuntimeKey` reads `meta.changes` to decide whether a row
  // was updated, so a local apply would store the key correctly and then report
  // `mint_failed` - and the next run, seeing a stored hash it thinks was never
  // written, would mint again. A rehearsal that lies in exactly the direction
  // requirement 40 forbids is worse than no rehearsal, so the combination is
  // refused. `--local` without `--apply` is still a genuine plan against the local
  // database.
  if (flags.local && flags.apply) {
    throw new Error(
      '--local cannot be combined with --apply: the local D1 driver reports no row ' +
        'count, so a stored key would be misreported as a failed mint.',
    );
  }
  return flags;
}

// ── wrangler plumbing ───────────────────────────────────────────────────────

/**
 * Runs the wrangler that `cloud/` already depends on, through `process.execPath`
 * rather than `npx`. Two reasons: `npx` resolves differently on Windows (`npx.cmd`
 * plus a shell, which then needs its own quoting), and pinning the resolved binary
 * means this script cannot silently run a different wrangler than
 * `npm run deploy` does.
 *
 * `stdio` is piped, which also makes the call NON-INTERACTIVE: wrangler falls back
 * to "yes" for its own confirmation prompts, so a remote write does not hang
 * waiting for a keypress that never comes.
 */
function wrangler(args) {
  const result = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: CLOUD_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `wrangler ${args.slice(0, 3).join(' ')} failed (exit ${result.status}): ` +
        `${(result.stderr || result.stdout || '').trim().slice(0, 800)}`,
    );
  }
  return result.stdout ?? '';
}

/**
 * A SQL literal for one bound value.
 *
 * The shim below cannot bind parameters - `wrangler d1 execute` takes SQL text -
 * so the values are inlined, which is exactly the shape where an injection bug
 * lives. Every value is therefore type-checked before it is rendered, and anything
 * that is not a string, a finite number, a boolean or null is REFUSED rather than
 * stringified - an object with a `toString` is how a quote gets in. In practice the
 * migration binds a tenant id, a key hash, base64 ciphertext and an ISO timestamp,
 * all strings, plus nulls. A quote is doubled per SQL's own rule, and a NUL byte is
 * refused rather than escaped because SQLite truncates a string literal there and
 * the write would silently store a prefix.
 */
export function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Refusing to bind a non-finite number.');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value !== 'string') throw new Error(`Refusing to bind a ${typeof value}.`);
  if (value.includes('\u0000')) throw new Error('Refusing to bind a string containing NUL.');
  return `'${value.replace(/'/g, "''")}'`;
}

/** `?` placeholders replaced left to right by their bound literals. */
export function renderSql(sql, values) {
  let index = 0;
  const rendered = sql.replace(/\?/g, () => {
    if (index >= values.length) throw new Error('More ? placeholders than bound values.');
    return sqlLiteral(values[index++]);
  });
  if (index !== values.length) throw new Error('More bound values than ? placeholders.');
  return rendered;
}

/**
 * wrangler's `--json` payload, tolerant of anything it prints alongside it.
 *
 * `d1 execute --command --json` currently prints the JSON alone, but other verbs
 * prefix progress lines, and a parse that silently produced the wrong object here
 * would be read as an empty result set - which the migration would then interpret
 * as "no tenants" or "the row is gone".
 */
export function parseWranglerJson(stdout) {
  const text = String(stdout ?? '').trim();
  const start = Math.min(
    ...[text.indexOf('['), text.indexOf('{')].filter((index) => index >= 0),
  );
  for (const candidate of [text, Number.isFinite(start) ? text.slice(start) : '']) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      /* fall through to the next candidate */
    }
  }
  throw new Error(`Could not parse wrangler JSON output: ${text.slice(0, 400)}`);
}

/**
 * The smallest thing `TenantStore` will accept as a `D1Database`, backed by the
 * wrangler CLI.
 *
 * Three statements ever reach it, so `prepare().bind().all()/first()/run()` is the
 * whole surface. Deliberately NOT a general adapter: a second WRITE appearing here
 * would be a sign the migration had grown a second write path.
 *
 *  1. the inventory SELECT (`readTenantInventory`), once per run;
 *  2. `TenantStore.grantPool`'s SELECT, once PER TENANT - `reconcileRuntimeKey`
 *     caps a key at the tier allowance plus the tenant's unspent top-ups, so it
 *     reads the pool. One extra wrangler subprocess and one extra remote round trip
 *     per tenant, which is the cost of the cap being the same number the inference
 *     gate enforces. It goes through `first()` and it is a SELECT, so the dry run's
 *     write guard passes it untouched;
 *  3. `setRuntimeKey`'s UPDATE, on an apply only.
 *
 * Statement 2 is the one that can legitimately FAIL rather than return rows: the
 * hosted database carries `0001_init.sql` plus telemetry and NOT `0003_billing.sql`
 * (see `readTenantInventory`), so `credit_grants` does not exist there yet and the
 * SELECT answers `no such table`. `runtimeKeyLimitUsd` catches exactly that and caps
 * at the tier allowance alone, which is the pre-grant behaviour and the safe
 * direction - so the migration runs on a pre-billing schema, at the cost of one
 * logged line per tenant. Nothing here needs to detect it.
 *
 * `allowWrites` is the dry run's teeth. Without it "dry run" would be a promise
 * made by the caller; with it, a non-SELECT statement throws before a single
 * remote byte moves.
 */
export function wranglerD1({ database, env, local, allowWrites }) {
  const scope = local ? '--local' : '--remote';
  const exec = (sql, values) => {
    const rendered = renderSql(sql, values);
    if (!allowWrites && !/^\s*SELECT\b/i.test(rendered)) {
      throw new Error(`Refusing to run a non-SELECT statement without --apply:\n${rendered}`);
    }
    // `--command` takes multiple queries separated by `;`, and no statement this
    // shim sends needs one, so a semicolon anywhere in the rendered SQL means a
    // bound value carried one. Refused rather than escaped: the split happens in
    // wrangler, not in SQLite, so a quoted `;` would still cut the statement in
    // half and the halves could each be valid.
    if (rendered.includes(';')) {
      throw new Error(`Refusing to run a statement containing a semicolon:\n${rendered}`);
    }
    // `--command`, NOT `--file`. Verified against the hosted database on
    // 2026-09-03: `--file --remote` takes D1's IMPORT path, which uploads the file
    // and answers with a SUMMARY row ("Total queries executed", "Rows read")
    // instead of the query's own rows - so a SELECT reads as one row of undefined
    // columns, and `meta.changes` comes back 1 for a statement that changed
    // nothing. Both failures are silent, and the second one would make
    // `setRuntimeKey` report a stored key on a row that does not exist.
    //
    // No shell is involved (`spawnSync` without `shell`), so the SQL crosses as one
    // argv entry and needs no quoting; `sqlLiteral` handles SQL's own quoting.
    const stdout = wrangler(['d1', 'execute', database, '--env', env, scope, '--json', '-y', '--command', rendered]);
    const json = parseWranglerJson(stdout);
    const last = Array.isArray(json) ? json[json.length - 1] : json;
    return { results: last?.results ?? [], meta: last?.meta ?? {} };
  };

  const statement = (sql, values) => ({
    bind: (...next) => statement(sql, next),
    all: async () => {
      const { results, meta } = await exec(sql, values);
      return { results, meta, success: true };
    },
    first: async () => (await exec(sql, values)).results[0] ?? null,
    run: async () => {
      const { results, meta } = await exec(sql, values);
      return { results, meta, success: true };
    },
  });

  return { prepare: (sql) => statement(sql, []) };
}

// ── Main ────────────────────────────────────────────────────────────────────

const HELP = `Usage: npx tsx scripts/migrate-openrouter-workspace.mjs --workspace <uuid|slug|name> [--apply]

Dry run by default. See the header of this file for the full procedure.`;

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || !flags.workspace) {
    console.log(HELP);
    process.exit(flags.workspace ? 0 : 1);
  }

  const provisioningKey = process.env.OPENROUTER_PROVISIONING_KEY;
  if (!provisioningKey) throw new Error('OPENROUTER_PROVISIONING_KEY is not set.');
  const keyEncSecret = process.env.KEY_ENC_SECRET;
  if (flags.apply && !keyEncSecret) {
    throw new Error('KEY_ENC_SECRET is not set, and --apply needs it to store a minted key.');
  }

  const workspace = await resolveWorkspace(provisioningKey, flags.workspace);
  console.log(
    `Target workspace: ${workspace.name} (slug ${workspace.slug}, id ${workspace.id})`,
  );
  if (!flags.apply) console.log('DRY RUN: nothing will be written. Add --apply to execute.');

  const db = wranglerD1({
    database: flags.database,
    env: flags.env,
    local: flags.local,
    allowWrites: flags.apply,
  });

  const purgeCache =
    flags.apply && flags.cachePurge
      ? async (tenantId) => {
          wrangler([
            'kv', 'key', 'delete', `tenant:${tenantId}`,
            '--binding', 'TENANTS', '--env', flags.env, flags.local ? '--local' : '--remote',
          ]);
        }
      : null;
  if (flags.apply && !purgeCache) {
    console.log(
      'WARNING: the KV tenant cache will NOT be purged, so the worker may hand runs a ' +
        'superseded key for up to 60 seconds per migrated tenant.',
    );
  }

  const report = await migrateWorkspace({
    db,
    provisioningKey,
    keyEncSecret,
    workspaceId: workspace.id,
    apply: flags.apply,
    only: flags.tenant,
    purgeCache,
    log: (line) => console.log(line),
  });

  console.log(formatReport(report));
  if (flags.out) {
    writeFileSync(flags.out, `${JSON.stringify({ workspace, ...report }, null, 2)}\n`, 'utf8');
    console.log(`\nReport written to ${flags.out}`);
  }
  // A non-zero exit for any failure, so a wrapper cannot read a partial migration
  // as a finished one.
  process.exit(report.summary.failures > 0 ? 1 : 0);
}

/**
 * Only when RUN, never when imported. `test/workspace-migration.test.mjs` imports
 * the argument parsing, the SQL literal encoder and the write guard - the three
 * pieces here worth asserting - and importing a module that immediately started
 * talking to the hosted database would be a poor trade for that coverage.
 */
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\nMigration aborted: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
