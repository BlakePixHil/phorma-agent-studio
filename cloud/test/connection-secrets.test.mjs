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
import { createSign, generateKeyPairSync } from 'node:crypto';
import process from 'node:process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

import { withLoopbackRetry } from './miniflare-loopback.mjs';

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

// ── A real Clerk session token, for the hosted organisation section ─────────
//
// Authorization is never stubbed: the public half of a locally generated keypair
// is handed to the worker as `CLERK_JWT_KEY`, so `@clerk/backend` verifies every
// token for real on its offline path with no JWKS fetch. The owner a vault is
// addressed by has to come from a VERIFIED claim, which is the only way an
// organisation can reach this code at all.

const { publicKey: CLERK_JWT_KEY, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const base64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function mintClerkToken(sub, claims = {}) {
  const seconds = Math.floor(Date.now() / 1000);
  const signing = `${base64url({ alg: 'RS256', typ: 'JWT', kid: 'phorma-vault-test' })}.${base64url({
    sub,
    iat: seconds - 60,
    nbf: seconds - 60,
    exp: seconds + 3600,
    ...claims,
  })}`;
  const signature = createSign('RSA-SHA256').update(signing).sign(privateKey).toString('base64url');
  return `${signing}.${signature}`;
}

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

// ── 4: the vault is addressed by the OWNER, not by the caller ──────────────
//
// Feature: multi-organisation-phorma, Property 10: Every owner-scoped read
// returns exactly the caller's owner's set.
//
// A credential is a property of the ACCOUNT, and for an organisation the account
// is the organisation. Two facts are load-bearing and neither is a leak:
//
//  - one member stores a credential and ANOTHER member's deployed run resolves
//    it, which is the only reason a shared workspace can run an authenticated
//    node at all (Requirement 4.2);
//  - the first push is the hard case. The inventory is read BEFORE `POST
//    /workflow` stamps an owner, so the vault fallback comes from the request. If
//    that fallback is the caller rather than the resolved owner, the member
//    pushing reads their PERSONAL vault, every shared secret reads as missing, and
//    the push is refused with a message naming credentials a colleague had already
//    stored.
console.log('\nA hosted organisation shares ONE vault across its members');
{
  const ORG = 'org_vault_alpha';
  const MEMBER_ONE = mintClerkToken('user_vault_one', { org_id: ORG, org_role: 'org:admin' });
  const MEMBER_TWO = mintClerkToken('user_vault_two', { org_id: ORG, org_role: 'org:admin' });
  /** The same human as MEMBER_ONE, signed in with no organisation. */
  const PERSONAL = mintClerkToken('user_vault_one');
  const OUTSIDER = mintClerkToken('user_vault_beta', {
    org_id: 'org_vault_beta',
    org_role: 'org:admin',
  });

  const mf = withLoopbackRetry(
    worker({
      PHORMA_MODE: 'hosted',
      CLERK_SECRET_KEY: 'sk_test_clerk_not_used_offline',
      CLERK_JWT_KEY,
      KEY_ENC_SECRET,
    }),
  );
  const headersFor = token => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

  try {
    // Member one stores the credential.
    const stored = await vaultRequest(
      mf,
      'POST',
      { connectionId: CONNECTION_ID, secretKey: 'apiKey', value: 'org-shared-secret' },
      headersFor(MEMBER_ONE),
    );
    check('a member may store a credential (200)', stored.status === 200, JSON.stringify(stored.body));

    // Member two, a different human with the same organisation claim, sees it.
    const asTwo = await vaultRequest(mf, 'GET', {}, headersFor(MEMBER_TWO));
    check(
      'a DIFFERENT member of the same organisation sees the entry',
      asTwo.body?.secrets?.length === 1 && asTwo.body.secrets[0].name === EXPECTED_NAME,
      JSON.stringify(asTwo.body),
    );
    check(
      'and still never the value',
      !JSON.stringify(asTwo.body).includes('org-shared-secret'),
      JSON.stringify(asTwo.body),
    );

    // The same human's PERSONAL owner is a different vault. Not a refusal: a
    // personal account is a first-class owner that simply holds nothing here.
    const asPersonal = await vaultRequest(mf, 'GET', {}, headersFor(PERSONAL));
    check(
      "the storing member's own personal vault is empty",
      asPersonal.status === 200 && (asPersonal.body?.secrets ?? []).length === 0,
      JSON.stringify(asPersonal.body),
    );
    const asOutsider = await vaultRequest(mf, 'GET', {}, headersFor(OUTSIDER));
    check(
      "and another organisation's vault is empty too",
      asOutsider.status === 200 && (asOutsider.body?.secrets ?? []).length === 0,
      JSON.stringify(asOutsider.body),
    );

    // THE first-push case. Member TWO pushes, so nothing about this instance has
    // ever seen member one - and the inventory is read before the owner is stamped.
    const instance = 'wf-vault-org';
    const agentUrl = `http://localhost/agents/workflow-agent/${instance}`;
    const metadata = await mf.dispatchFetch(`${agentUrl}/connections`, {
      method: 'POST',
      headers: headersFor(MEMBER_TWO),
      body: JSON.stringify({ connections: [CONNECTION] }),
    });
    check('a member can push connection metadata', metadata.status === 200, String(metadata.status));

    const inventory = await (
      await mf.dispatchFetch(`${agentUrl}/connections`, { headers: headersFor(MEMBER_TWO) })
    ).json();
    check(
      "the first-push inventory resolves the ORGANISATION's vault",
      inventory.connections?.[0]?.secretsPresent === 1,
      JSON.stringify(inventory.connections),
    );
    check(
      'so nothing is reported missing to the member who pushed',
      JSON.stringify(inventory.connections?.[0]?.missingSecretKeys) === '[]',
      JSON.stringify(inventory.connections?.[0]),
    );
    check(
      'and the inventory never carries the value',
      !JSON.stringify(inventory.connections).includes('org-shared-secret'),
      JSON.stringify(inventory.connections),
    );

    // The negative control, so the check above cannot be passing because every
    // vault answers: the same push read by a personal credential of a member finds
    // nothing. A different instance id, because the first push has now stamped the
    // organisation onto `wf-vault-org` and a personal caller would be refused there.
    const personalAgent = 'http://localhost/agents/workflow-agent/wf-vault-personal';
    await mf.dispatchFetch(`${personalAgent}/connections`, {
      method: 'POST',
      headers: headersFor(PERSONAL),
      body: JSON.stringify({ connections: [CONNECTION] }),
    });
    const personalInventory = await (
      await mf.dispatchFetch(`${personalAgent}/connections`, { headers: headersFor(PERSONAL) })
    ).json();
    check(
      "a personal owner's first push reads its own empty vault",
      personalInventory.connections?.[0]?.secretsPresent === 0,
      JSON.stringify(personalInventory.connections),
    );
  } finally {
    await mf.dispose();
  }
}

console.log(failures === 0 ? '\nAll connection-secrets checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
