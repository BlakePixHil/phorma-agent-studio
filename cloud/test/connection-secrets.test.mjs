/**
 * `/api/connection-secrets` + `SecretVault` - credential ingestion for
 * DEPLOYED runs.
 *
 * The gap this closes: a connection secret typed in the studio lands in the OS
 * keychain, which a worker cannot read. Before the vault the ONLY way to give a
 * deployed run a credential was `wrangler secret put`, so push-time validation
 * reported "missing 1 of 1 secret values" with no in-app way to satisfy it -
 * and no way at all for a Phorma-hosted tenant, who does not own the account.
 *
 * The claim under test is end to end: a secret POSTed through the route is
 * counted as PRESENT by the same `GET /connections` inventory
 * `CloudService.pushWorkflow` validates against, while no route ever hands the
 * value back.
 *
 * Runs the real deploy bundle under Miniflare with a real SQLite-backed
 * Durable Object. No network, no Cloudflare account.
 *
 * Run: node cloud/test/connection-secrets.test.mjs
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const here = dirname(fileURLToPath(import.meta.url));
const cloudRoot = join(here, '..');

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

const TOKEN = 'test-phorma-token';
/** base64 32 bytes - the AES-GCM key `encryptString` expects. */
const KEY_ENC_SECRET = Buffer.alloc(32, 7).toString('base64');
const CONNECTION_ID = 'conn-jira-test';
/** `workerSecretName('conn-jira-test', 'apiKey')`, computed by hand here so a
 *  change to the naming scheme fails this test rather than passing silently. */
const EXPECTED_NAME = 'CONN_CONN_JIRA_TEST_APIKEY';

const CONNECTION = {
  id: CONNECTION_ID,
  name: 'JIRA Connection',
  type: 'http',
  config: { baseUrl: 'https://example.atlassian.net' },
  secretKeys: ['apiKey'],
  auth: { mode: 'bearer', secretKey: 'apiKey' },
};

// ── Build the exact deploy bundle, then run it under Miniflare ──────────────

const wranglerBin = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const bundleDir = mkdtempSync(join(tmpdir(), 'phorma-cloud-connection-secrets-'));
let script;
try {
  execFileSync(process.execPath, [wranglerBin, 'deploy', '--dry-run', '--outdir', bundleDir], {
    cwd: cloudRoot,
    stdio: 'pipe',
  });
  script = readFileSync(join(bundleDir, 'index.js'), 'utf8');
} finally {
  rmSync(bundleDir, { recursive: true, force: true });
}

function worker(bindings) {
  return new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2025-05-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: {
      WorkflowAgent: { className: 'WorkflowAgent', useSQLite: true },
      PortalIndex: { className: 'PortalIndex', useSQLite: true },
      SecretVault: { className: 'SecretVault', useSQLite: true },
    },
    bindings,
  });
}

const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };

async function vaultRequest(mf, method, body, headers = authHeaders) {
  const url =
    method === 'DELETE'
      ? `http://localhost/api/connection-secrets?connectionId=${encodeURIComponent(
          body.connectionId,
        )}&secretKey=${encodeURIComponent(body.secretKey)}`
      : 'http://localhost/api/connection-secrets';
  const response = await mf.dispatchFetch(url, {
    method,
    headers,
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

// ── 1: an unprotected worker refuses to hold credentials ───────────────────
console.log('An unprotected BYO worker');
{
  const mf = worker({ KEY_ENC_SECRET });
  try {
    const stored = await vaultRequest(
      mf,
      'POST',
      { connectionId: CONNECTION_ID, secretKey: 'apiKey', value: 'super-secret' },
      { 'Content-Type': 'application/json' },
    );
    check(
      'refuses to store a credential (403)',
      stored.status === 403,
      `${stored.status} ${JSON.stringify(stored.body)}`,
    );
    check(
      'the refusal says how to fix it',
      /PHORMA_TOKEN/.test(stored.body?.error ?? ''),
      stored.body?.error,
    );
  } finally {
    await mf.dispose();
  }
}

// ── 2: a worker with no encryption key says so ──────────────────────────────
console.log('\nA protected worker with no KEY_ENC_SECRET');
{
  const mf = worker({ PHORMA_TOKEN: TOKEN });
  try {
    const stored = await vaultRequest(mf, 'POST', {
      connectionId: CONNECTION_ID,
      secretKey: 'apiKey',
      value: 'super-secret',
    });
    check('refuses rather than storing plaintext (501)', stored.status === 501, JSON.stringify(stored.body));
    check(
      'names the missing secret',
      /KEY_ENC_SECRET/.test(stored.body?.error ?? ''),
      stored.body?.error,
    );
  } finally {
    await mf.dispose();
  }
}

// ── 3: the working path, end to end ────────────────────────────────────────
console.log('\nA protected worker with an encryption key');
{
  const mf = worker({ PHORMA_TOKEN: TOKEN, KEY_ENC_SECRET });
  const instance = 'wf-connection-secrets';
  const agentUrl = `http://localhost/agents/workflow-agent/${instance}`;

  try {
    // Auth is enforced before anything else.
    const anonymous = await vaultRequest(
      mf,
      'POST',
      { connectionId: CONNECTION_ID, secretKey: 'apiKey', value: 'super-secret' },
      { 'Content-Type': 'application/json' },
    );
    check('an unauthenticated write is rejected (401)', anonymous.status === 401, JSON.stringify(anonymous.body));

    // Push the connection METADATA the way the studio does.
    const pushed = await mf.dispatchFetch(`${agentUrl}/connections`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ connections: [CONNECTION] }),
    });
    check('connection metadata pushes (200)', pushed.status === 200, String(pushed.status));

    // Before the secret exists, the inventory must report it missing BY NAME -
    // this is what makes the studio's validation message actionable.
    const before = await (await mf.dispatchFetch(`${agentUrl}/connections`, { headers: authHeaders })).json();
    check(
      'the inventory reports the secret missing',
      before.connections?.[0]?.secretsPresent === 0,
      JSON.stringify(before.connections),
    );
    check(
      'the inventory names WHICH secret is missing',
      JSON.stringify(before.connections?.[0]?.missingSecretKeys) === JSON.stringify(['apiKey']),
      JSON.stringify(before.connections?.[0]),
    );

    // Malformed input is rejected before anything is stored.
    const badId = await vaultRequest(mf, 'POST', {
      connectionId: 'not-a-connection-id',
      secretKey: 'apiKey',
      value: 'x',
    });
    check('a malformed connection id is rejected (400)', badId.status === 400, JSON.stringify(badId.body));
    const badKey = await vaultRequest(mf, 'POST', {
      connectionId: CONNECTION_ID,
      secretKey: 'bad key!',
      value: 'x',
    });
    check('a malformed secret key is rejected (400)', badKey.status === 400, JSON.stringify(badKey.body));
    const empty = await vaultRequest(mf, 'POST', {
      connectionId: CONNECTION_ID,
      secretKey: 'apiKey',
      value: '',
    });
    check('an empty value is rejected (400)', empty.status === 400, JSON.stringify(empty.body));

    // The real write.
    const stored = await vaultRequest(mf, 'POST', {
      connectionId: CONNECTION_ID,
      secretKey: 'apiKey',
      value: 'super-secret-value',
    });
    check('the secret stores (200)', stored.status === 200, JSON.stringify(stored.body));
    check('the response names the entry', stored.body?.name === EXPECTED_NAME, stored.body?.name);

    // Names only, never values - checked against the whole serialized body so
    // a value leaking through any field fails, not just the ones we assert on.
    const listed = await vaultRequest(mf, 'GET', {});
    const listedText = JSON.stringify(listed.body);
    check('the listing returns the stored name', listed.body?.secrets?.[0]?.name === EXPECTED_NAME, listedText);
    check('the listing carries an mtime', typeof listed.body?.secrets?.[0]?.updatedAt === 'number', listedText);
    check('the listing never carries the value', !listedText.includes('super-secret-value'), listedText);

    // THE claim: the same inventory the push validator reads now counts it.
    const after = await (await mf.dispatchFetch(`${agentUrl}/connections`, { headers: authHeaders })).json();
    const afterText = JSON.stringify(after.connections);
    check(
      'the inventory now counts the secret as present',
      after.connections?.[0]?.secretsPresent === 1,
      afterText,
    );
    check(
      'nothing is left in missingSecretKeys',
      JSON.stringify(after.connections?.[0]?.missingSecretKeys) === '[]',
      afterText,
    );
    check('the inventory never carries the value', !afterText.includes('super-secret-value'), afterText);

    // Removal is idempotent and puts the inventory back where it started.
    const removed = await vaultRequest(mf, 'DELETE', { connectionId: CONNECTION_ID, secretKey: 'apiKey' });
    check('the secret deletes (200)', removed.status === 200 && removed.body?.removed === true, JSON.stringify(removed.body));
    const again = await vaultRequest(mf, 'DELETE', { connectionId: CONNECTION_ID, secretKey: 'apiKey' });
    check('a second delete is a no-op', again.status === 200 && again.body?.removed === false, JSON.stringify(again.body));

    const final = await (await mf.dispatchFetch(`${agentUrl}/connections`, { headers: authHeaders })).json();
    check(
      'the inventory reports it missing again',
      final.connections?.[0]?.secretsPresent === 0,
      JSON.stringify(final.connections),
    );
  } finally {
    await mf.dispose();
  }
}

console.log(failures === 0 ? '\nAll connection-secrets checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
