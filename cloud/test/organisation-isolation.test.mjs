/**
 * Organisation isolation, at BOTH layers - `cloud/src/index.ts`'s gateway and
 * `WorkflowAgent`'s own `enforceOwnership` (multi-organisation-phorma task 2,
 * Requirements 2.1 to 2.9, 16.2, 18.5, 18.6).
 *
 * ## What is actually at risk
 *
 * One inverted comparison. The gateway rewrites an instance name to
 * `{ownerId}:{instance}`, and `enforceOwnership` compares a stamp; if either reads
 * `auth.userId` where it should read the RESOLVED owner, the failure is silent in
 * the worst direction - every member of an organisation addresses a DIFFERENT
 * instance from their colleagues and sees an empty workspace. So both directions
 * are pinned: two members of one organisation reach the SAME instance, and a
 * member of another organisation reaches nothing at all.
 *
 * ## The four claims, and how each is made measurable
 *
 * 1. **UNREACHABLE, not merely refused** (Requirement 2.2, Property 4). The
 *    gateway's 403 must return before any Durable Object is addressed. Asserted by
 *    WATCHING the namespace: the harness proxies `env.WorkflowAgent` and records
 *    every `idFromName`, so "no Durable Object was instantiated" is an observation
 *    rather than a claim about the source.
 * 2. **The instance refuses ALONE** (Requirement 2.5). Driven through the
 *    `notificationsSince` RPC, which is reached by name with the gateway ENTIRELY
 *    out of the path - the same shape `purgeSelf` and `startPortalTurn` have, and
 *    the reason the second layer exists at all. If the assertion could only be made
 *    with the gateway present, it would be asserting the gateway.
 * 3. **A purge preserves the stamp** (Requirement 2.6). `purgeSelf` carries
 *    `ownerId` across `setState({ ...this.initialState, ownerId })`, which reads
 *    like housekeeping and is load-bearing: without it a purged instance could be
 *    adopted by whoever pushed next.
 * 4. **A portal session instance holds no ownership** (Requirement 2.8,
 *    Property 6). Its `notificationsSince` is empty for ANY owner, including the
 *    correct one.
 *
 * ## Harness, and why each piece is real rather than stubbed
 *
 *  - THE WORKER IS THE DEPLOY BUNDLE. `wrangler deploy --dry-run` emits the exact
 *    script a real deploy would ship, and Miniflare runs it with real
 *    SQLite-backed Durable Objects, so the gateway, `routeAgentRequest` and the
 *    instance are all genuinely in the path.
 *  - A HARNESS MODULE wraps it (`modulesRoot` plus an ESModule re-exporting
 *    `WorkflowAgent`, `PortalIndex` and `SecretVault`), the same pattern
 *    `telemetry-admin.test.mjs` uses. It adds the namespace watcher and two
 *    gateway-free RPC probes, and touches nothing else.
 *  - AUTHORIZATION IS NOT STUBBED. An RSA keypair is generated here and the public
 *    half handed to the worker as `CLERK_JWT_KEY`, so `@clerk/backend` verifies
 *    every token for real on its offline path with no JWKS fetch.
 *  - D1 IS REAL, with the real migrations applied, because `/api/deployments`
 *    reads `usage` and the claim family reads `workflow_backups`. The handle goes
 *    through `withLoopbackRetryD1` and setup through `DB.batch([...])`, since each
 *    proxied statement costs a loopback socket.
 *  - Each member's token carries `org_role: 'org:admin'`, which `CLERK_ROLE_LEVELS`
 *    maps, so `resolveRole` short-circuits and this suite spends no sockets on
 *    membership rows. The authoritative `org_members` path is driven by
 *    `role-gate.test.mjs` and `owner-identity.test.mjs`.
 *
 * NOT asserted here, on purpose: everything about the claim route, including the
 * post-claim HTTP and WebSocket refusals that need a stamp differing from the
 * instance-name prefix. `ownership-claim.test.mjs` owns those.
 *
 * Run: npx tsx cloud/test/organisation-isolation.test.mjs
 */

import { execFileSync } from 'node:child_process';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { withLoopbackRetry, withLoopbackRetryD1 } from './miniflare-loopback.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cloudRoot = join(here, '..');
const migrations = join(cloudRoot, 'migrations');

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

// ── The harness module ──────────────────────────────────────────────────────
//
// Two additions over the shipped worker, and nothing else:
//
//  - `/__t/addressed` reports every instance name the WORKER addressed, which is
//    how "the gateway woke no Durable Object" becomes measurable. The watcher wraps
//    the namespace the worker sees; the Durable Objects themselves get the real
//    binding, so an instance calling into another instance is invisible here, which
//    is exactly right - the claim under test is about the gateway.
//  - `/__t/rpc/*` reach an instance BY NAME with the gateway out of the path. They
//    deliberately use the UNWRAPPED namespace, so a probe cannot pollute the
//    addressing log it is being compared against.

const HARNESS = `
import worker from './worker.mjs';
export { WorkflowAgent, PortalIndex, SecretVault } from './worker.mjs';

/** Instance names the worker addressed since the last reset. */
let addressed = [];

/**
 * A transparent Durable Object namespace that records every name it resolves.
 *
 * Native methods are bound to the real namespace: workerd's binding is not a
 * plain object, and an unbound \`idFromName\` throws on an illegal invocation.
 */
function watchNamespace(namespace) {
  return new Proxy(namespace, {
    get(target, property, receiver) {
      // Both hooks, not just one. \`idFromName\` is what partyserver calls today, and
      // \`get\` is where a stub is really obtained - so a future SDK that resolved a
      // name some other way still cannot slip a wake past this watcher.
      if (property === 'idFromName') {
        return name => {
          addressed.push(name);
          return target.idFromName(name);
        };
      }
      if (property === 'get') {
        return (id, options) => {
          const name = String(id?.name ?? '');
          if (name && !addressed.includes(name)) addressed.push(name);
          return target.get(id, options);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleTestRoute(url, env) {
  if (url.pathname === '/__t/addressed') {
    const seen = addressed;
    if (url.searchParams.get('reset') === '1') addressed = [];
    return json({ addressed: seen });
  }

  if (url.pathname === '/__t/rpc/notifications') {
    const name = url.searchParams.get('name') ?? '';
    const owner = url.searchParams.get('owner') ?? '';
    const stub = env.WorkflowAgent.get(env.WorkflowAgent.idFromName(name));
    try {
      return json({ ok: true, payload: await stub.notificationsSince(owner, 0) });
    } catch (error) {
      return json({ ok: false, error: String(error?.message ?? error) });
    }
  }

  if (url.pathname === '/__t/registry') {
    // The registry read, direct. \`GET /api/deployments\` still scopes on
    // \`auth.userId\` rather than on the resolved owner - that is task 3's change -
    // so the route would answer an empty list here for a reason that has nothing to
    // do with what this suite is asserting.
    const stub = env.PortalIndex.get(env.PortalIndex.idFromName('portal-index'));
    return json({ records: await stub.listDeployments(url.searchParams.get('owner') ?? '') });
  }

  if (url.pathname === '/__t/rpc/init-session') {
    // Creates a portal SESSION instance exactly the way the public router does, so
    // the ownership assertions below are made against a real one.
    const name = url.searchParams.get('name') ?? '';
    const stub = env.WorkflowAgent.get(env.WorkflowAgent.idFromName(name));
    try {
      return json({
        ok: true,
        result: await stub.initPortalSession({
          spec: JSON.parse(url.searchParams.get('spec') ?? 'null'),
          slug: url.searchParams.get('slug') ?? 'iso-portal',
          sessionId: url.searchParams.get('session') ?? 's1',
          workflowId: url.searchParams.get('workflow') ?? 'wf-iso',
          ownerInstance: url.searchParams.get('owner-instance') ?? '',
          ownerId: url.searchParams.get('owner') ?? null,
          responderNodeId: null,
        }),
      });
    } catch (error) {
      return json({ ok: false, error: String(error?.message ?? error) });
    }
  }

  return json({ error: 'unknown test route' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/__t/')) return handleTestRoute(url, env);
    const proxied = Object.assign({}, env, { WorkflowAgent: watchNamespace(env.WorkflowAgent) });
    return worker.fetch(request, proxied, ctx);
  },
  async scheduled(controller, env, ctx) {
    return worker.scheduled(controller, env, ctx);
  },
};
`;

// ── Tokens ──────────────────────────────────────────────────────────────────

const { publicKey: CLERK_JWT_KEY, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const base64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function mintToken(sub, claims = {}) {
  const seconds = Math.floor(Date.now() / 1000);
  const signing = `${base64url({ alg: 'RS256', typ: 'JWT', kid: 'phorma-org-isolation' })}.${base64url(
    { sub, iat: seconds - 60, nbf: seconds - 60, exp: seconds + 3600, ...claims },
  )}`;
  const signature = createSign('RSA-SHA256').update(signing).sign(privateKey).toString('base64url');
  return `${signing}.${signature}`;
}

const ORG_A = 'org_iso_alpha';
const ORG_B = 'org_iso_beta';

/** Two members of ORG_A, so "the owner is the organisation" is observable. */
const ALPHA_ONE = mintToken('user_iso_alpha_1', { org_id: ORG_A, org_role: 'org:admin' });
const ALPHA_TWO = mintToken('user_iso_alpha_2', { org_id: ORG_A, org_role: 'org:admin' });
const BETA_ONE = mintToken('user_iso_beta_1', { org_id: ORG_B, org_role: 'org:admin' });
/** The same human as ALPHA_ONE, signed in with no organisation. */
const ALPHA_ONE_PERSONAL = mintToken('user_iso_alpha_1');
/** A verified credential whose organisation id carries the one forbidden character. */
const COLON_OWNER = mintToken('user_iso_colon', { org_id: 'org_iso:hostile', org_role: 'org:admin' });

// ── Build the exact deploy bundle, then run it under Miniflare ──────────────

const wranglerBin = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url),
);
const bundleDir = mkdtempSync(join(tmpdir(), 'phorma-cloud-org-isolation-'));
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

const mf = withLoopbackRetry(
  new Miniflare({
    modulesRoot: cloudRoot,
    modules: [
      { type: 'ESModule', path: join(cloudRoot, 'harness.mjs'), contents: HARNESS },
      { type: 'ESModule', path: join(cloudRoot, 'worker.mjs'), contents: script },
    ],
    compatibilityDate: '2025-05-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: {
      WorkflowAgent: { className: 'WorkflowAgent', useSQLite: true },
      PortalIndex: { className: 'PortalIndex', useSQLite: true },
      SecretVault: { className: 'SecretVault', useSQLite: true },
    },
    d1Databases: { DB: 'phorma-cloud-org-isolation' },
    bindings: {
      PHORMA_MODE: 'hosted',
      CLERK_SECRET_KEY: 'sk_test_clerk_not_used_offline',
      CLERK_JWT_KEY,
      KEY_ENC_SECRET: Buffer.alloc(32, 13).toString('base64'),
    },
  }),
);

/**
 * Splits a migration into statements. Split on `/\r?\n/`, never `'\n'`: a CRLF
 * checkout leaves each line ending in `\r`, the `--` stripper then matches
 * nothing, and the comment-only tail reaches D1 as "SQL code did not contain a
 * statement".
 */
function statementsOf(file) {
  return readFileSync(join(migrations, file), 'utf8')
    .split(/\r?\n/)
    .map(line => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map(statement => statement.trim())
    .filter(statement => statement.length > 0);
}

/** A minimal deployable spec. One manual trigger, nothing that needs a model. */
function spec(id, name) {
  return {
    version: 1,
    id,
    name,
    savedAt: new Date().toISOString(),
    graph: {
      nodes: [
        {
          id: 'trigger',
          name: 'trigger',
          kind: 'manual-trigger',
          category: 'trigger',
          icon: '',
          position: { x: 0, y: 0 },
          ports: [{ id: 'trigger-out', name: 'Out', role: 'message-out' }],
          data: {},
        },
      ],
      connections: [],
    },
  };
}

try {
  const DB = withLoopbackRetryD1(await mf.getD1Database('DB'));
  for (const file of [
    '0001_init.sql',
    '0003_billing.sql',
    '0004_billing_ordering.sql',
    '0005_workflow_backups.sql',
    '0006_organisations.sql',
  ]) {
    for (const statement of statementsOf(file)) await DB.prepare(statement).run();
  }

  const AGENT = '/agents/workflow-agent';

  async function call(path, { token, method = 'GET', body } = {}) {
    const response = await mf.dispatchFetch(`http://localhost${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  /** Every instance name the worker addressed, optionally clearing the log. */
  async function addressed({ reset = false } = {}) {
    const response = await mf.dispatchFetch(
      `http://localhost/__t/addressed${reset ? '?reset=1' : ''}`,
    );
    return (await response.json()).addressed ?? [];
  }

  /** `notificationsSince` reached by name, with NO gateway in the path. */
  async function rpcNotifications(name, owner) {
    const response = await mf.dispatchFetch(
      `http://localhost/__t/rpc/notifications?name=${encodeURIComponent(name)}&owner=${encodeURIComponent(owner)}`,
    );
    return response.json();
  }

  /**
   * The Durable Object name the gateway gives one owner's workflow instance.
   *
   * PERCENT-ENCODED, which is not obvious and is asserted below against the
   * watcher's log rather than assumed: `index.ts` writes
   * `encodeURIComponent(owner:workflowId)` into the path, and partyserver hashes the
   * path segment it finds there WITHOUT decoding it - so `org_a:wf` and
   * `org_a%3Awf` are two different Durable Objects and only one of them is the
   * deployment. Anything reaching an instance by name has to agree with this.
   */
  const instanceOf = (ownerId, workflowId) => encodeURIComponent(`${ownerId}:${workflowId}`);

  // ══ 1. The owner is the ORGANISATION, for every member ═════════════════════
  //
  // Feature: multi-organisation-phorma, Property 4: A foreign organisation's
  // instance is unreachable, and the instance refuses alone.
  //
  // The same workflow id under two organisations, which is the case that would
  // silently collide if the prefix were still the user id: both members of ORG_A
  // would then hold two different instances of one deployment.
  console.log('\nThe instance prefix is the resolved owner (Requirements 2.1, 2.3)');
  {
    const pushed = await call(`${AGENT}/wf-iso/workflow`, {
      token: ALPHA_ONE,
      method: 'POST',
      body: spec('wf-iso', 'Alpha workflow'),
    });
    check('a member of ORG_A can deploy', pushed.status === 200, JSON.stringify(pushed.body));

    // The second member of the SAME organisation, a different human, reading the
    // bare workflow id. This is the whole point of the owner seam.
    const read = await call(`${AGENT}/wf-iso/workflow`, { token: ALPHA_TWO });
    check(
      'a DIFFERENT member of the same organisation reads the same deployment',
      read.status === 200 && read.body?.spec?.name === 'Alpha workflow',
      `${read.status} ${JSON.stringify(read.body).slice(0, 160)}`,
    );

    // And a member of another organisation, same bare id, is a different instance
    // entirely - not a refusal, because they are not addressing anything of ours.
    const beta = await call(`${AGENT}/wf-iso/workflow`, { token: BETA_ONE });
    check(
      'a member of ORG_B sees nothing at the same workflow id',
      beta.status === 404 && beta.body?.hasWorkflow === false,
      `${beta.status} ${JSON.stringify(beta.body)}`,
    );

    const betaPush = await call(`${AGENT}/wf-iso/workflow`, {
      token: BETA_ONE,
      method: 'POST',
      body: spec('wf-iso', 'Beta workflow'),
    });
    check('ORG_B can deploy its own workflow at the same id', betaPush.status === 200);
    const alphaAgain = await call(`${AGENT}/wf-iso/workflow`, { token: ALPHA_ONE });
    check(
      "and ORG_A's deployment is untouched by it",
      alphaAgain.body?.spec?.name === 'Alpha workflow',
      JSON.stringify(alphaAgain.body).slice(0, 160),
    );

    // The personal credential of a member is a DIFFERENT owner. Not a refusal: a
    // personal account is a first-class owner, and it simply owns nothing here.
    const personal = await call(`${AGENT}/wf-iso/workflow`, { token: ALPHA_ONE_PERSONAL });
    check(
      "a member's personal credential resolves their personal owner, not the organisation",
      personal.status === 404 && personal.body?.hasWorkflow === false,
      `${personal.status} ${JSON.stringify(personal.body)}`,
    );
  }

  // ══ 2. A foreign owner's instance is never WOKEN ═══════════════════════════
  //
  // Feature: multi-organisation-phorma, Property 4: A foreign organisation's
  // instance is unreachable, and the instance refuses alone.
  console.log('\nA foreign owner prefix is 403 and wakes no Durable Object (Requirement 2.2)');
  {
    const foreign = `${ORG_A}:wf-iso`;
    const probes = [
      { method: 'GET', path: `${AGENT}/${encodeURIComponent(foreign)}/status` },
      { method: 'GET', path: `${AGENT}/${encodeURIComponent(foreign)}/workflow` },
      { method: 'GET', path: `${AGENT}/${encodeURIComponent(foreign)}/runs` },
      { method: 'POST', path: `${AGENT}/${encodeURIComponent(foreign)}/trigger`, body: { input: 'x' } },
      { method: 'POST', path: `${AGENT}/${encodeURIComponent(foreign)}/publish`, body: {} },
      { method: 'DELETE', path: `${AGENT}/${encodeURIComponent(foreign)}/workflow` },
      { method: 'DELETE', path: `${AGENT}/${encodeURIComponent(foreign)}/workflow/purge` },
    ];

    for (const probe of probes) {
      await addressed({ reset: true });
      const { status, body } = await call(probe.path, { ...probe, token: BETA_ONE });
      check(
        `${probe.method} ${probe.path.slice(AGENT.length)} is 403 for a foreign owner`,
        status === 403,
        `${status} ${JSON.stringify(body)}`,
      );
      const seen = await addressed();
      check(
        `and no Durable Object was addressed for it`,
        seen.length === 0,
        JSON.stringify(seen),
      );
    }

    // The WebSocket upgrade path inherits the SAME gateway branch, with the token in
    // a query parameter because a browser cannot set a header on a WebSocket.
    await addressed({ reset: true });
    const upgrade = await mf.dispatchFetch(
      `http://localhost${AGENT}/${encodeURIComponent(foreign)}?token=${BETA_ONE}`,
      { headers: { Upgrade: 'websocket' } },
    );
    check('the WebSocket upgrade is 403 for a foreign owner', upgrade.status === 403, String(upgrade.status));
    check('and it is not upgraded at all', !upgrade.webSocket);
    const upgradeSeen = await addressed();
    check('and no Durable Object was addressed for it', upgradeSeen.length === 0, JSON.stringify(upgradeSeen));

    // The positive control, so none of the above can be passing because nothing
    // works: the owner's OWN prefixed name is admitted, and the log proves the
    // instance really is addressed on the path that succeeds.
    await addressed({ reset: true });
    const own = await call(`${AGENT}/${encodeURIComponent(`${ORG_A}:wf-iso`)}/workflow`, {
      token: ALPHA_ONE,
    });
    check('an owner may send their OWN already-prefixed name', own.status === 200, String(own.status));
    const seenOnSuccess = await addressed();
    check(
      'and that path DOES address the instance',
      seenOnSuccess.length > 0,
      JSON.stringify(seenOnSuccess),
    );
    // The name is PERCENT-ENCODED, and the log is where that stops being a guess.
    // Anything that reaches this instance by name - the claim route's RPC, the
    // notification fan-out, the portal's owner lookup - has to spell it the same way
    // or it silently addresses a blank Durable Object.
    check(
      'and the name workerd hashes is the percent-encoded one',
      seenOnSuccess.includes(instanceOf(ORG_A, 'wf-iso')),
      JSON.stringify(seenOnSuccess),
    );
    check(
      'never the raw colon form',
      !seenOnSuccess.includes(`${ORG_A}:wf-iso`),
      JSON.stringify(seenOnSuccess),
    );
  }

  // ══ 3. The colon guard, at the gateway ═════════════════════════════════════
  console.log('\nA colon-bearing owner answers owner_invalid (Requirement 1.8)');
  {
    await addressed({ reset: true });
    const refused = await call(`${AGENT}/wf-iso/status`, { token: COLON_OWNER });
    check('the gateway refuses it 403', refused.status === 403, String(refused.status));
    check(
      'with the owner_invalid code, not a generic Forbidden',
      refused.body?.code === 'owner_invalid',
      JSON.stringify(refused.body),
    );
    check(
      'and nothing is addressed under it',
      (await addressed()).length === 0,
      JSON.stringify(await addressed()),
    );
    // Nothing is truncated or rewritten to make it usable: the value is refused.
    check(
      'no instance name containing the colon-bearing owner exists in the log',
      !(await addressed()).some(name => name.includes('org_iso')),
    );

    // The control plane refuses it too, in ONE place above every route
    // (Requirement 1.8). A read is enough to show it: the gate is not per-route.
    const me = await call('/api/me', { token: COLON_OWNER });
    check('routeApiRequest refuses it too', me.status === 403, String(me.status));
    check('with the same code', me.body?.code === 'owner_invalid', JSON.stringify(me.body));
    const vault = await call('/api/connection-secrets', {
      token: COLON_OWNER,
      method: 'POST',
      body: { connectionId: 'conn-iso', secretKey: 'apiKey', value: 'nope' },
    });
    check('and a vault WRITE never happens under it', vault.status === 403, String(vault.status));
    check('with the same code', vault.body?.code === 'owner_invalid', JSON.stringify(vault.body));
    const listed = await call('/api/connection-secrets', { token: ALPHA_ONE });
    check(
      'so no secret was written under any owner',
      listed.status === 200 && (listed.body?.secrets ?? []).length === 0,
      JSON.stringify(listed.body),
    );

    // And an ORDINARY caller is unaffected by the new gate, which is the half that
    // would break every install if the guard were inverted.
    const ok = await call('/api/me', { token: ALPHA_ONE });
    check('an addressable owner still reads /api/me', ok.status === 200, String(ok.status));
    check('and it reports the organisation as the owner', ok.body?.ownerId === ORG_A, JSON.stringify(ok.body));
  }

  // ══ 4. The instance refuses ALONE, with no gateway in the path ═════════════
  //
  // Feature: multi-organisation-phorma, Property 4: A foreign organisation's
  // instance is unreachable, and the instance refuses alone.
  //
  // `notificationsSince` is an RPC entry point: it is reached by NAME, so the
  // gateway's prefix check never runs. That is not a contrivance - it is exactly
  // why the second layer exists, and `purgeSelf` and `startPortalTurn` have the
  // same shape.
  console.log('\nenforceOwnership refuses with the gateway absent (Requirement 2.5)');
  {
    const instance = instanceOf(ORG_A, 'wf-iso');

    const correct = await rpcNotifications(instance, ORG_A);
    check('the stamped owner is served', correct.ok === true, JSON.stringify(correct));

    // The control that makes the refusals below meaningful: this really is the
    // stamped instance, not a blank one that answers an empty payload to anybody.
    const blank = await rpcNotifications(`${ORG_A}:wf-iso`, ORG_B);
    check(
      'a blank instance would have answered instead of refusing',
      blank.ok === true,
      JSON.stringify(blank),
    );

    for (const [label, owner] of [
      ['another organisation', ORG_B],
      ['the member who deployed it, personally', 'user_iso_alpha_1'],
      ['an owner that does not exist', 'org_iso_nobody'],
    ]) {
      const refused = await rpcNotifications(instance, owner);
      check(
        `${label} is refused by the instance itself`,
        refused.ok === false && /another account/i.test(refused.error ?? ''),
        JSON.stringify(refused),
      );
    }
  }

  // ══ 5. A purge preserves the stamp ═════════════════════════════════════════
  //
  // Feature: multi-organisation-phorma, Property 5: The stamped owner is exactly
  // one value, from the first push until purge.
  console.log('\npurgeSelf preserves the stamped owner (Requirement 2.6)');
  {
    const purged = await call(`${AGENT}/wf-iso-purge/workflow`, {
      token: BETA_ONE,
      method: 'POST',
      body: spec('wf-iso-purge', 'Beta purge target'),
    });
    check('a workflow to purge is deployed', purged.status === 200, JSON.stringify(purged.body));

    const instance = instanceOf(ORG_B, 'wf-iso-purge');
    check(
      'it refuses a foreign owner before the purge',
      (await rpcNotifications(instance, ORG_A)).ok === false,
    );

    const teardown = await call(`${AGENT}/wf-iso-purge/workflow/purge`, {
      token: BETA_ONE,
      method: 'DELETE',
    });
    check('the purge succeeds', teardown.status === 200, JSON.stringify(teardown.body));

    const spec404 = await call(`${AGENT}/wf-iso-purge/workflow`, { token: BETA_ONE });
    check('the spec is gone', spec404.status === 404, String(spec404.status));

    // The load-bearing half: the stamp survived, so the instance cannot be adopted.
    check(
      'a purged instance still refuses a different owner',
      (await rpcNotifications(instance, ORG_A)).ok === false,
      JSON.stringify(await rpcNotifications(instance, ORG_A)),
    );
    check(
      'and still serves its own owner',
      (await rpcNotifications(instance, ORG_B)).ok === true,
    );
  }

  // ══ 6. A portal session instance holds no organisation ownership ═══════════
  //
  // Feature: multi-organisation-phorma, Property 6: A portal session instance
  // holds no organisation ownership.
  console.log('\nA portal session instance is outside ownership (Requirement 2.8)');
  {
    // `#s` is the session separator the studio never produces, and it is what makes
    // a session instance a distinct Durable Object from its owner's. The name is the
    // UNENCODED form `portalSessionInstance` produces, deliberately, so this drives
    // the real session naming rather than a tidied-up version of it.
    const sessionName = `${ORG_A}:wf-iso#siso1`;
    const query = new URLSearchParams({
      name: sessionName,
      spec: JSON.stringify(spec('wf-iso', 'Alpha workflow')),
      workflow: 'wf-iso',
      'owner-instance': `${ORG_A}:wf-iso`,
      session: 'siso1',
      owner: ORG_A,
    });
    const init = await mf.dispatchFetch(`http://localhost/__t/rpc/init-session?${query}`);
    const started = await init.json();
    check('a portal session instance exists', started.ok === true, JSON.stringify(started).slice(0, 200));

    // Empty for the stamped owner, and REFUSED for anybody else. The owner check in
    // `notificationsSince` runs before the session short-circuit, which is stricter
    // than "empty regardless of the owner" rather than weaker.
    const own = await rpcNotifications(sessionName, ORG_A);
    check(
      'notificationsSince is empty for the stamped owner',
      own.ok === true &&
        own.payload?.runs?.length === 0 &&
        own.payload?.pending?.length === 0 &&
        own.payload?.issues?.length === 0,
      JSON.stringify(own).slice(0, 200),
    );
    for (const owner of [ORG_B, 'user_iso_alpha_1']) {
      const payload = await rpcNotifications(sessionName, owner);
      check(
        `a session instance refuses ${owner} outright`,
        payload.ok === false,
        JSON.stringify(payload).slice(0, 200),
      );
    }

    // And it is not in the deployment registry, by any path. Read straight from
    // `PortalIndex` rather than through `GET /api/deployments`, which still scopes on
    // `auth.userId`: org-scoping that route is task 3, and its answer here would be
    // empty for a reason unrelated to what this asserts.
    const registry = await mf.dispatchFetch(
      `http://localhost/__t/registry?owner=${encodeURIComponent(ORG_A)}`,
    );
    const ids = ((await registry.json()).records ?? []).map(entry => entry.workflowId);
    check('the organisation owns the deployment record', ids.includes('wf-iso'), JSON.stringify(ids));
    check(
      'and no session instance is registered',
      !ids.some(id => id.includes('#')),
      JSON.stringify(ids),
    );
    const personal = await mf.dispatchFetch(
      `http://localhost/__t/registry?owner=${encodeURIComponent('user_iso_alpha_1')}`,
    );
    check(
      "and nothing is registered under the deploying member's personal owner",
      ((await personal.json()).records ?? []).length === 0,
    );
  }
} finally {
  await mf.dispose();
}

console.log(
  failures === 0
    ? '\nAll organisation-isolation checks passed.\n'
    : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
