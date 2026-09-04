/**
 * OpenRouter workspace migration - the part with the decisions in it.
 *
 * `migrate-openrouter-workspace.mjs` beside this file is the CLI: it parses
 * arguments, talks to remote D1 through the wrangler binary, and prints. Every
 * rule about WHAT happens to a tenant lives here, so it can be tested against a
 * real local D1 with a stubbed OpenRouter and no shell at all
 * (`test/workspace-migration.test.mjs`).
 *
 * ## What the investigation settled (task 10.1, requirement 36)
 *
 * Verified against OpenRouter's key management API reference, 2026-09-03:
 *
 *  - `POST /api/v1/keys` accepts an optional `workspace_id` (UUID) in the BODY:
 *    "The workspace to create the API key in. Defaults to the default workspace
 *    if not provided." So a workspace is TARGETED explicitly at mint time. It is
 *    not implied by which key mints, and there is no per-workspace provisioning
 *    key to obtain - OpenRouter documents Management Keys as account-level, "API
 *    keys for administrative actions across all workspaces".
 *  - Every key we have ever minted therefore lives in the DEFAULT workspace,
 *    because `provisionOpenRouterKey` sent `{name, limit}` and nothing else.
 *  - A key object carries `workspace_id`, on the mint response, on
 *    `GET /keys/{hash}` and in `GET /keys`. That is what lets this script tell a
 *    migrated tenant from an unmigrated one WITHOUT keeping its own bookkeeping.
 *  - `GET /keys` takes `workspace_id`, `include_disabled` and `offset`, so the
 *    target workspace can be inventoried and paged.
 *  - `PATCH /keys/{hash}` needs no workspace selector (a hash is account-global)
 *    and has NO field that moves an existing key between workspaces. Re-minting
 *    is the only migration there is.
 *
 * Consequence for this script: it does not need a new secret. It needs the target
 * workspace's UUID plus the management key the worker already holds.
 *
 * ## Why re-running is safe (requirement 40)
 *
 * This operates on live paid accounts, so "safe to re-run" has to mean something
 * stronger than "does not crash". Four mechanisms, in the order they bite:
 *
 * 1. THE STORED HASH IS THE STATE. A tenant is migrated when the key in
 *    `tenants.openrouter_key_id` reports the target `workspace_id` and is not
 *    disabled. That is read from OpenRouter, so it cannot disagree with reality
 *    the way a local ledger could, and a second run classifies such a tenant
 *    `skip_already_migrated` and issues no write at all.
 * 2. THE KEY NAME IS DETERMINISTIC. A plaintext key is returned exactly once, so
 *    a key minted by a run that died before storing it is unrecoverable and
 *    invisible - except by its name, `phorma-tenant-{id}`. Before minting, any
 *    key of that name in the target workspace that is NOT the tenant's stored
 *    hash is disabled as an orphan. So the worst a crash costs is one dead key,
 *    never a live one nobody can account for, and never two live keys for one
 *    tenant.
 * 3. THE STORE IS ONE WRITE. `TenantStore.setRuntimeKey` moves both key columns
 *    in a single statement, so there is no half-migrated row to reason about.
 * 4. NOTHING ELSE IS TOUCHED. Non-active tenants and tenants holding a key with
 *    no stored hash are reported and skipped, so their classification is stable
 *    across runs and a re-run cannot start acting on them.
 *
 * The one thing a re-run cannot undo is a key minted into the WRONG workspace by
 * a mistyped `--workspace`: it would then be "already migrated" for that wrong
 * target. Hence {@link resolveWorkspace} refuses anything it cannot match
 * against `GET /workspaces` rather than passing a UUID straight through.
 */

import {
  TIERS,
  TenantStore,
  disableOpenRouterKey,
  reconcileRuntimeKey,
  runtimeKeyName,
} from '../src/tenants.ts';

const OPENROUTER_API = 'https://openrouter.ai/api/v1';

/**
 * A User-Agent, because several of our outbound calls elsewhere are rejected
 * without one and the failure is silent once JSON parsing masks the body.
 */
const UA = 'phorma-workspace-migration/1';

/**
 * Stands in for a tenant's stored ciphertext while the migration runs.
 *
 * The migration never needs the runtime key's PLAINTEXT: `reconcileRuntimeKey`
 * reads `openrouterKeyEnc` only as a boolean ("is there a usable key"), and a
 * rotation overwrites it with a freshly encrypted one. So the inventory query
 * selects `openrouter_key_enc IS NOT NULL` instead of the column, and a stored
 * secret never travels to an operator's terminal or into a report. The value is
 * deliberately un-decryptable, so a bug that wrote it back would fail closed
 * (`runtimeKey` returns null, the gate says `no_runtime_key`) rather than look
 * like a working key.
 */
export const CIPHERTEXT_PRESENT = '__migration_placeholder_not_a_key__';

/** What one tenant's migration is, as a decision that can be printed and asserted. */
export const ACTIONS = Object.freeze({
  /** The stored key already lives in the target workspace and is enabled. */
  alreadyMigrated: 'skip_already_migrated',
  /** Not `active`, so `reconcileRuntimeKey` would refuse anyway - and should. */
  notActive: 'skip_not_active',
  /** A usable key with no stored hash: unretirable, so never replaced silently. */
  unmanaged: 'skip_unmanaged',
  /** In the target workspace but disabled - one PATCH, no rotation. */
  repair: 'repair_disabled',
  /** A key somewhere else: mint a replacement here, retire that one. */
  rotate: 'rotate',
  /** No usable key at all: mint a first one, in the right workspace. */
  mint: 'mint',
});

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function openRouter(provisioningKey, path, init = {}) {
  const response = await fetch(`${OPENROUTER_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${provisioningKey}`,
      'Content-Type': 'application/json',
      'User-Agent': UA,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`OpenRouter ${path} failed (${response.status}): ${detail.slice(0, 200)}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/** Every workspace the management key can see: `{id, name, slug}` each. */
export async function listWorkspaces(provisioningKey) {
  const body = await openRouter(provisioningKey, '/workspaces');
  return (body?.data ?? []).map((workspace) => ({
    id: String(workspace.id ?? ''),
    name: String(workspace.name ?? ''),
    slug: String(workspace.slug ?? ''),
  }));
}

/**
 * Turns `--workspace <uuid | slug | name>` into a UUID, or throws.
 *
 * Deliberately resolved against `GET /workspaces` even when the input already
 * looks like a UUID. A mistyped id would otherwise be accepted by `POST /keys`
 * as some other workspace (or rejected halfway through the fleet), and the ONE
 * outcome a re-run cannot repair is keys minted into a workspace nobody meant.
 * Matching by slug or name also keeps the operator command readable.
 */
export async function resolveWorkspace(provisioningKey, selector) {
  const wanted = String(selector ?? '').trim();
  if (!wanted) throw new Error('A target workspace is required (--workspace <uuid|slug|name>).');
  const workspaces = await listWorkspaces(provisioningKey);
  const lower = wanted.toLowerCase();
  const match =
    workspaces.find((workspace) => workspace.id === wanted) ??
    workspaces.find((workspace) => workspace.slug.toLowerCase() === lower) ??
    workspaces.find((workspace) => workspace.name.toLowerCase() === lower);
  if (!match) {
    const known = workspaces.map((w) => `${w.name} (slug ${w.slug}, id ${w.id})`).join('; ');
    throw new Error(
      `No OpenRouter workspace matches "${wanted}". This account has: ${known || 'none'}.`,
    );
  }
  return match;
}

/**
 * Every key in one workspace, disabled ones included, paged through `offset`.
 *
 * Disabled keys are included on purpose: they are how an orphan from an
 * interrupted run is recognized as ALREADY retired, so a re-run does not disable
 * it a second time and does not report a leak that is not one.
 */
export async function listWorkspaceKeys(provisioningKey, workspaceId) {
  const keys = [];
  const seen = new Set();
  for (let page = 0; page < 200; page += 1) {
    const query = `?workspace_id=${encodeURIComponent(workspaceId)}&include_disabled=true&offset=${keys.length}`;
    const body = await openRouter(provisioningKey, `/keys${query}`);
    const batch = body?.data ?? [];
    if (batch.length === 0) break;
    let added = 0;
    for (const key of batch) {
      const hash = String(key.hash ?? '');
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      keys.push(normalizeKey(key));
      added += 1;
    }
    // A page that adds nothing new means the endpoint is not honouring `offset`
    // the way we assume. Stop rather than loop: a wrong inventory here would
    // classify a migrated tenant as unmigrated and re-mint their key.
    if (added === 0) break;
  }
  return keys;
}

function normalizeKey(key) {
  return {
    hash: String(key.hash ?? ''),
    name: typeof key.name === 'string' ? key.name : '',
    workspaceId: typeof key.workspace_id === 'string' ? key.workspace_id : null,
    disabled: key.disabled === true,
    limit: typeof key.limit === 'number' ? key.limit : null,
    limitReset: typeof key.limit_reset === 'string' ? key.limit_reset : null,
    usage: typeof key.usage === 'number' ? key.usage : null,
  };
}

/** One key by hash, or null when OpenRouter has never heard of it (404). */
export async function getOpenRouterKey(provisioningKey, hash) {
  try {
    const body = await openRouter(provisioningKey, `/keys/${encodeURIComponent(hash)}`);
    return normalizeKey(body?.data ?? body ?? {});
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

/**
 * The tenants the migration operates on, read with `0001_init.sql` columns ONLY.
 *
 * Verified against the live hosted database on 2026-09-03: it carries the initial
 * schema plus telemetry, and NOT `0003_billing.sql` - `stripe_customer_id` does
 * not exist there yet. So selecting a billing column would make the whole
 * migration fail on a `SQLITE_ERROR` before it read a single tenant, and none of
 * those columns has anything to do with a runtime key.
 *
 * `openrouter_key_enc` is reduced to a boolean rather than selected - see
 * {@link CIPHERTEXT_PRESENT}.
 */
export async function readTenantInventory(db) {
  const { results } = await db
    .prepare(
      `SELECT id, email, tier, status, openrouter_key_id,
              (openrouter_key_enc IS NOT NULL) AS has_key_enc, created_at, updated_at
         FROM tenants
        ORDER BY created_at`,
    )
    .all();
  return (results ?? []).map((row) => ({
    id: String(row.id),
    email: row.email ?? null,
    tier: String(row.tier),
    status: String(row.status),
    openrouterKeyId: row.openrouter_key_id ?? null,
    hasKeyEnc: Number(row.has_key_enc) === 1,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    /** Whether `TIERS` still declares this tenant's tier (unknown falls back to starter). */
    knownTier: Object.prototype.hasOwnProperty.call(TIERS, String(row.tier)),
  }));
}

/**
 * What to do with ONE tenant, decided from the tenant row plus what OpenRouter
 * says about the key it points at. Pure, so every branch is assertable.
 */
export function classifyTenant({ tenant, storedKey, workspaceId }) {
  if (tenant.status !== 'active') {
    return {
      action: ACTIONS.notActive,
      reason: `status is ${tenant.status}; only active tenants are reconciled`,
    };
  }
  if (storedKey && storedKey.workspaceId === workspaceId) {
    return storedKey.disabled
      ? { action: ACTIONS.repair, reason: 'already in the target workspace but disabled' }
      : { action: ACTIONS.alreadyMigrated, reason: 'already in the target workspace' };
  }
  if (tenant.hasKeyEnc && !tenant.openrouterKeyId) {
    return {
      action: ACTIONS.unmanaged,
      reason:
        'holds a usable key with no stored hash, so a replacement could not retire it - ' +
        'retire it by hand in the OpenRouter dashboard',
    };
  }
  if (!tenant.hasKeyEnc) {
    return { action: ACTIONS.mint, reason: 'no usable runtime key stored' };
  }
  return {
    action: ACTIONS.rotate,
    reason: storedKey
      ? `key is in workspace ${storedKey.workspaceId ?? 'unknown'}`
      : 'OpenRouter does not know the stored key hash',
  };
}

/**
 * The migration.
 *
 * Dry run by DEFAULT (`apply: false`): it reads the tenant table and OpenRouter
 * and returns exactly the plan an `apply: true` run would execute, without a
 * single write on either side. The dry run is the deliverable an operator reads
 * before spending real money on live accounts.
 *
 * Per tenant, in order, and sequentially across tenants so one failure is
 * contained and the log stays readable:
 *
 *  1. Disable orphan keys of the same deterministic name in the target
 *     workspace (mechanism 2 in the header).
 *  2. `reconcileRuntimeKey`, with `rotate: true` for a tenant whose key is
 *     elsewhere. That is the ONE rotation path in this codebase: it disables the
 *     superseded key FIRST, mints at the tier's cap into
 *     `OPENROUTER_WORKSPACE_ID`, and stores both key columns in one write. This
 *     script deliberately does not reimplement any of it.
 *  3. Purge the tenant's KV cache entry, if the caller supplied a way to.
 *
 * `purgeCache` is not optional in spirit. `getTenant` caches a tenant row in KV
 * for 60s, and a rotation disables the old key immediately, so a worker holding a
 * cached row keeps handing runs a key OpenRouter now refuses until the entry
 * expires. `TenantStore.setRuntimeKey` deletes it when a `TENANTS` binding is
 * present, and this script has no binding, so the CLI passes a `wrangler kv key
 * delete` instead. Without it, expect up to a minute of failing hosted runs per
 * migrated tenant.
 */
export async function migrateWorkspace({
  db,
  provisioningKey,
  keyEncSecret,
  workspaceId,
  apply = false,
  only = null,
  purgeCache = null,
  log = () => {},
}) {
  if (!provisioningKey) throw new Error('OPENROUTER_PROVISIONING_KEY is required.');
  // Never optional, and never defaulted: `POST /keys` with no `workspace_id`
  // mints into the DEFAULT workspace, which is precisely the workspace this
  // migration exists to leave. A missing id would look like a successful run.
  if (!workspaceId) throw new Error('A target workspace id is required.');
  // Only needed to STORE a minted key, but demanded up front: `reconcileRuntimeKey`
  // degrades to `skipped` without it, so an apply run would otherwise report a
  // tidy row of no-ops and look finished.
  if (apply && !keyEncSecret) throw new Error('KEY_ENC_SECRET is required for --apply.');

  const env = {
    OPENROUTER_PROVISIONING_KEY: provisioningKey,
    OPENROUTER_WORKSPACE_ID: workspaceId,
    KEY_ENC_SECRET: keyEncSecret,
  };
  const store = new TenantStore({ DB: db, KEY_ENC_SECRET: keyEncSecret });

  const inventory = await readTenantInventory(db);
  const tenants = only ? inventory.filter((tenant) => tenant.id === only) : inventory;
  if (only && tenants.length === 0) throw new Error(`No tenant row for "${only}".`);

  const workspaceKeys = await listWorkspaceKeys(provisioningKey, workspaceId);
  const namesWanted = new Set(inventory.map((tenant) => runtimeKeyName(tenant.id)));

  const report = {
    workspaceId,
    apply,
    tenantsInTable: inventory.length,
    keysInWorkspace: workspaceKeys.length,
    tenants: [],
    /**
     * Keys in the target workspace that no tenant row claims. Audit output, never
     * touched: a hand-made key, or a key belonging to a tenant row somebody
     * deleted. Deciding which is an operator's call (task 10.4).
     */
    unclaimedKeys: workspaceKeys
      .filter((key) => !namesWanted.has(key.name))
      .map((key) => ({ hash: key.hash, name: key.name, disabled: key.disabled })),
    summary: {
      alreadyMigrated: 0,
      rotated: 0,
      minted: 0,
      repaired: 0,
      skipped: 0,
      orphansDisabled: 0,
      failures: 0,
    },
  };

  for (const tenant of tenants) {
    const entry = {
      id: tenant.id,
      tier: tenant.tier,
      status: tenant.status,
      knownTier: tenant.knownTier,
      storedKeyHash: tenant.openrouterKeyId,
      storedKeyWorkspaceId: null,
      action: null,
      reason: null,
      orphans: [],
      orphansDisabled: [],
      outcome: null,
      cachePurged: false,
      error: null,
    };
    report.tenants.push(entry);

    let storedKey = null;
    if (tenant.openrouterKeyId) {
      try {
        storedKey = await getOpenRouterKey(provisioningKey, tenant.openrouterKeyId);
      } catch (error) {
        // Not fatal for the fleet, but fatal for THIS tenant: without knowing
        // which workspace their key is in, a rotation could be a needless
        // re-mint of a key that was already migrated.
        entry.action = 'error';
        entry.error = `could not read the stored key from OpenRouter: ${errorMessage(error)}`;
        report.summary.failures += 1;
        log(`  ${tenant.id}: SKIPPED - ${entry.error}`);
        continue;
      }
    }
    entry.storedKeyWorkspaceId = storedKey?.workspaceId ?? null;

    const { action, reason } = classifyTenant({ tenant, storedKey, workspaceId });
    entry.action = action;
    entry.reason = reason;

    if (action === ACTIONS.alreadyMigrated) {
      report.summary.alreadyMigrated += 1;
      log(`  ${tenant.id}: already migrated (${tenant.tier})`);
      continue;
    }
    if (action === ACTIONS.notActive || action === ACTIONS.unmanaged) {
      report.summary.skipped += 1;
      log(`  ${tenant.id}: skipped - ${reason}`);
      continue;
    }

    // Mechanism 2: same name, different hash, still live -> a key from a run that
    // died between minting and storing. Its plaintext is gone forever, so it can
    // never be adopted; retiring it is the only way it stops being spendable.
    if (action === ACTIONS.rotate || action === ACTIONS.mint) {
      entry.orphans = workspaceKeys
        .filter(
          (key) =>
            key.name === runtimeKeyName(tenant.id) &&
            key.hash !== tenant.openrouterKeyId &&
            !key.disabled,
        )
        .map((key) => key.hash);
    }

    if (!apply) {
      log(`  ${tenant.id}: would ${action} (${reason})${entry.orphans.length ? `, retiring ${entry.orphans.length} orphan key(s)` : ''}`);
      continue;
    }

    for (const hash of entry.orphans) {
      try {
        await disableOpenRouterKey(provisioningKey, hash);
        entry.orphansDisabled.push({ hash, disabled: true });
        report.summary.orphansDisabled += 1;
        log(`  ${tenant.id}: retired orphan key ${hash.slice(0, 12)}...`);
      } catch (error) {
        entry.orphansDisabled.push({ hash, disabled: false });
        report.summary.failures += 1;
        log(`  ${tenant.id}: FAILED to retire orphan key ${hash.slice(0, 12)}... - ${errorMessage(error)}`);
      }
    }

    const outcome = await reconcileRuntimeKey(
      env,
      store,
      {
        id: tenant.id,
        email: tenant.email,
        tier: tenant.tier,
        status: tenant.status,
        openrouterKeyId: tenant.openrouterKeyId,
        openrouterKeyEnc: tenant.hasKeyEnc ? CIPHERTEXT_PRESENT : null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        billingEventAt: 0,
        billingTierAt: 0,
        billingStatusAt: 0,
        billingDunningStatus: null,
        billingDunningAt: 0,
      },
      { rotate: action === ACTIONS.rotate },
    );
    entry.outcome = outcome;

    if (outcome.action === 'minted') {
      report.summary[action === ACTIONS.rotate ? 'rotated' : 'minted'] += 1;
      if (purgeCache) {
        try {
          await purgeCache(tenant.id);
          entry.cachePurged = true;
        } catch (error) {
          // Not a failure of the migration: the key moved and D1 agrees. It costs
          // up to one cache TTL of refused runs, and it self-heals.
          log(`  ${tenant.id}: WARNING - the KV cache entry was not purged (${errorMessage(error)}); hosted runs may fail for up to 60s`);
        }
      }
      log(
        `  ${tenant.id}: minted in ${workspaceId} at $${outcome.limitUsd} ` +
          `(superseded key disabled: ${outcome.supersededKeyDisabled})`,
      );
    } else if (outcome.action === 'limit_updated') {
      report.summary.repaired += 1;
      log(`  ${tenant.id}: re-enabled at $${outcome.limitUsd}`);
    } else {
      report.summary.failures += 1;
      log(`  ${tenant.id}: FAILED - ${outcome.action}${outcome.detail ? ` (${outcome.detail})` : ''}`);
    }
  }

  return report;
}

/**
 * The one-line-per-tenant table an operator reads, plus the summary.
 *
 * Separated from {@link migrateWorkspace} so the report shape is what tests
 * assert against and printing cannot change behaviour.
 */
export function formatReport(report) {
  const lines = [];
  lines.push('');
  lines.push(`Target workspace : ${report.workspaceId}`);
  lines.push(`Mode             : ${report.apply ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  lines.push(`Tenant rows      : ${report.tenantsInTable}`);
  lines.push(`Keys in workspace: ${report.keysInWorkspace}`);
  lines.push('');
  const width = Math.max(8, ...report.tenants.map((tenant) => tenant.id.length));
  lines.push(`${'tenant'.padEnd(width)}  ${'tier'.padEnd(8)}  ${'status'.padEnd(8)}  action`);
  for (const tenant of report.tenants) {
    const suffix = tenant.error
      ? ` - ${tenant.error}`
      : tenant.outcome
        ? ` -> ${tenant.outcome.action}`
        : tenant.reason
          ? ` (${tenant.reason})`
          : '';
    lines.push(
      `${tenant.id.padEnd(width)}  ${tenant.tier.padEnd(8)}  ${tenant.status.padEnd(8)}  ${tenant.action}${suffix}`,
    );
  }
  if (report.unclaimedKeys.length > 0) {
    lines.push('');
    lines.push(`Keys in the workspace that no tenant row claims (${report.unclaimedKeys.length}):`);
    for (const key of report.unclaimedKeys) {
      lines.push(`  ${key.hash.slice(0, 12)}...  ${key.name || '(no name)'}${key.disabled ? '  [disabled]' : ''}`);
    }
  }
  lines.push('');
  lines.push(
    `Summary: ${report.summary.alreadyMigrated} already migrated, ${report.summary.rotated} rotated, ` +
      `${report.summary.minted} first-time mints, ${report.summary.repaired} re-enabled, ` +
      `${report.summary.skipped} skipped, ${report.summary.orphansDisabled} orphan keys retired, ` +
      `${report.summary.failures} failure(s).`,
  );
  return lines.join('\n');
}
