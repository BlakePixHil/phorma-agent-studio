/**
 * Read-only audited impersonation, end to end (multi-organisation-phorma task 13,
 * Requirements 14.1 to 14.15, 16.2, 18.1, 18.5).
 *
 * ## What is actually at risk
 *
 * Impersonation is the one feature in this product whose failure modes are all
 * SILENT. A header honoured for somebody who is not an operator looks exactly like
 * a successful support read. A write that slips through looks exactly like the
 * customer having done it. An audit row that was never written looks exactly like
 * nobody having looked. None of the three produces an error anywhere, so every one
 * of them is pinned here by observation rather than by reading the source.
 *
 * ## The five claims, and how each is made measurable
 *
 * 1. **A read really is served as the other owner** (Requirement 14.5's read half).
 *    Asserted against a deployment the CUSTOMER pushed, so the operator's answer
 *    can only be right if the substituted owner reached the registry prefix and the
 *    instance stamp. The operator's own header-free answer is the control: empty.
 * 2. **A write is refused at BOTH layers** (Requirements 14.5, 14.7, Property 31).
 *    The gateway refusal is asserted together with the namespace WATCHER, so "no
 *    Durable Object was woken" is an observation. The instance refusal is driven
 *    through a gateway-free probe that reaches the instance BY NAME - if the
 *    assertion could only be made with the gateway present, it would be asserting
 *    the gateway. The WebSocket upgrade is refused outright at the gateway and
 *    refused again by the instance, because every frame that socket accepts writes.
 * 3. **An operator who ALSO holds a real membership still cannot write through the
 *    header** (Requirement 14.14). The same human, one credential carrying a real
 *    `org:admin` claim: the write lands without the header and is refused with it.
 *    That pair is the only thing that separates "impersonation is read-only" from
 *    "this operator happens to have no membership".
 * 4. **Being ignored is INDISTINGUISHABLE** (Requirement 14.4, Property 32). Three
 *    ignored cases - a non-operator, an unparseable value, and an allowlisted
 *    DESKTOP token - each compared byte for byte against the identical request
 *    without the header, with the audit row count unchanged.
 * 5. **One audit row per accepted request, or a refusal** (Requirements 14.8 to
 *    14.10, Property 33). Field by field, including the absence of the query string
 *    the request carried, and then with the table dropped so the write really fails
 *    and the request really is refused with nothing of the resource in the body.
 *
 * ## Harness, and why each piece is real rather than stubbed
 *
 *  - THE WORKER IS THE DEPLOY BUNDLE. `wrangler deploy --dry-run` emits the exact
 *    script a real deploy would ship, so the gateway, `routeAgentRequest`, the
 *    control plane and the instance are all genuinely in the path.
 *  - A HARNESS MODULE wraps it (`modulesRoot` plus an ESModule re-exporting the
 *    three Durable Object classes), adding the namespace watcher and ONE
 *    gateway-free HTTP probe. It touches nothing else.
 *  - AUTHORIZATION IS NOT STUBBED. An RSA keypair is generated here and the public
 *    half handed to the worker as `CLERK_JWT_KEY`, so `@clerk/backend` verifies
 *    every session token for real on its offline path. The desktop token is minted
 *    with the worker's OWN `mintDeviceToken` against the same `PHORMA_AUTH_SECRET`
 *    the worker binds, so "a desktop token cannot impersonate" is asserted about a
 *    token the worker genuinely accepts as a credential.
 *  - D1 IS REAL, with the real migrations applied, because `impersonation_audit` is
 *    the subject. The handle goes through `withLoopbackRetryD1` and setup through
 *    `DB.batch([...])`, since each proxied statement costs a loopback socket.
 *  - THE ENTITLEMENT GATE IS THE SHIPPED FUNCTION, imported directly and pointed at
 *    the same D1 the worker uses, because "no usage row, no ledger entry and no
 *    grant draw" is a claim about rows and only a direct call can hold the tenant
 *    state still while it is checked.
 *
 * Run: npx tsx cloud/test/impersonation.test.mjs
 */

import { execFileSync } from 'node:child_process';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { withLoopbackRetry, withLoopbackRetryD1 } from './miniflare-loopback.mjs';

// The shipped modules imported below sit in a graph that reaches
// `cloudflare:workers`, which Node cannot resolve. Redirected to the same stub
// every other route suite uses, before the graph loads.
const workersShim = new URL('./stubs/cloudflare-workers.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      return { url: workersShim, format: 'module', shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { mintDeviceToken } = await import('../src/device-auth.ts');
const { TenantStore, encryptString, resolveHostedInference } = await import('../src/tenants.ts');
const { ACT_AS_HEADER, IMPERSONATION_ADMIN_PATH } = await import('../src/impersonation.ts');
const { IMPERSONATED_READ_PATHS } = await import('../src/api.ts');

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

/**
 * A HARNESS artifact, not a product one, and the narrowest possible swallow.
 *
 * Answering an `Upgrade: websocket` dispatchFetch with anything other than a 101 -
 * which is exactly what the gateway's outright refusal does - leaves Miniflare's
 * loopback socket reset, and Node raises an unhandled `ECONNRESET` on the raw TCP
 * handle with no listener attached. It fires AFTER the response has been read and
 * asserted, so without this the suite prints every PASS and then exits non-zero,
 * which reads like a failing check.
 *
 * Reproduced in isolation against a five-line worker that returns a 403 to an
 * upgrade, with no Phorma code in the path at all, so this is not covering for
 * anything of ours. Only `ECONNRESET` is swallowed; anything else still crashes the
 * process, and the exit code below is still driven by {@link failures}.
 */
process.on('uncaughtException', error => {
  if (error?.code === 'ECONNRESET') return;
  throw error;
});

// ── The harness module ──────────────────────────────────────────────────────
//
// Two additions over the shipped worker, and nothing else:
//
//  - `/__t/addressed` reports every instance name the WORKER addressed, which is
//    how "the gateway refused before waking anything" becomes an observation
//    rather than a claim about the source.
//  - `/__t/do/*` reaches an instance BY NAME with the gateway out of the path,
//    forwarding the method, the headers and the body unchanged. That is the only
//    way to see `requireCapability` refuse an impersonated write ALONE. It uses
//    the UNWRAPPED namespace, so a probe cannot pollute the addressing log it is
//    being compared against.

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

async function handleTestRoute(request, url, env) {
  if (url.pathname === '/__t/addressed') {
    const seen = addressed;
    if (url.searchParams.get('reset') === '1') addressed = [];
    return json({ addressed: seen });
  }

  // An instance reached BY NAME, exactly as an RPC entry point is, but over HTTP
  // so \`onRequest\` and therefore \`requireCapability\` are in the path. The full
  // \`/agents/workflow-agent/{name}/\` prefix is rebuilt because the agents SDK
  // router reads the instance name out of the path - a bare internal URL 500s.
  if (url.pathname.startsWith('/__t/do/')) {
    const name = url.searchParams.get('name') ?? '';
    const route = url.pathname.slice('/__t/do/'.length);
    const stub = env.WorkflowAgent.get(env.WorkflowAgent.idFromName(name));
    const target = new URL(
      \`http://do.invalid/agents/workflow-agent/\${encodeURIComponent(name)}/\${route}\`,
    );
    const headers = new Headers(request.headers);
    headers.delete('Content-Length');
    try {
      const response = await stub.fetch(
        new Request(target, {
          method: request.method,
          headers,
          ...(request.method === 'GET' || request.method === 'HEAD'
            ? {}
            : { body: await request.text() }),
        }),
      );
      return json({ ok: true, status: response.status, body: await response.text() });
    } catch (error) {
      return json({ ok: false, error: String(error?.message ?? error) });
    }
  }

  return json({ error: 'unknown test route' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/__t/')) return handleTestRoute(request, url, env);
    const proxied = Object.assign({}, env, { WorkflowAgent: watchNamespace(env.WorkflowAgent) });
    return worker.fetch(request, proxied, ctx);
  },
  async scheduled(controller, env, ctx) {
    return worker.scheduled(controller, env, ctx);
  },
};
`;

// ── Identities ──────────────────────────────────────────────────────────────

const { publicKey: CLERK_JWT_KEY, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const base64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function mintToken(sub, claims = {}) {
  const seconds = Math.floor(Date.now() / 1000);
  const signing = `${base64url({ alg: 'RS256', typ: 'JWT', kid: 'phorma-impersonation' })}.${base64url(
    { sub, iat: seconds - 60, nbf: seconds - 60, exp: seconds + 3600, ...claims },
  )}`;
  const signature = createSign('RSA-SHA256').update(signing).sign(privateKey).toString('base64url');
  return `${signing}.${signature}`;
}

/** The customer whose data support needs to see, and one of its members. */
const ORG = 'org_imp_customer';
const MEMBER_SUB = 'user_imp_member';
const CUSTOMER = mintToken(MEMBER_SUB, { org_id: ORG, org_role: 'org:admin' });

/** A second customer, so an operator naming one cannot see the other. */
const OTHER_ORG = 'org_imp_other';
const OTHER_CUSTOMER = mintToken('user_imp_other', {
  org_id: OTHER_ORG,
  org_role: 'org:admin',
});

/** The operator. Allowlisted, and a member of nothing. */
const OPERATOR_SUB = 'user_imp_operator';
const OPERATOR = mintToken(OPERATOR_SUB);

/**
 * The SAME operator, signed in with a real `org:admin` membership of the customer
 * organisation. Requirement 14.14's subject: their membership is how they write,
 * and it does not travel with the act-as header.
 */
const OPERATOR_AS_MEMBER = mintToken(OPERATOR_SUB, { org_id: ORG, org_role: 'org:admin' });

/** Somebody who is not an operator at all. Their header must be ignored. */
const OUTSIDER = mintToken('user_imp_outsider');

/** HMAC secret behind the desktop token, so `phd_` is a real credential here. */
const PHORMA_AUTH_SECRET = Buffer.alloc(32, 21).toString('base64');
const OPERATOR_DEVICE_TOKEN = await mintDeviceToken(
  PHORMA_AUTH_SECRET,
  OPERATOR_SUB,
  Date.now() / 1000,
);

const KEY_ENC_SECRET = Buffer.alloc(32, 13).toString('base64');

// ── Build the exact deploy bundle, then run it under Miniflare ──────────────

const wranglerBin = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url),
);
const bundleDir = mkdtempSync(join(tmpdir(), 'phorma-cloud-impersonation-'));
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
    d1Databases: { DB: 'phorma-cloud-impersonation' },
    bindings: {
      PHORMA_MODE: 'hosted',
      CLERK_SECRET_KEY: 'sk_test_clerk_not_used_offline',
      CLERK_JWT_KEY,
      KEY_ENC_SECRET,
      PHORMA_AUTH_SECRET,
      // A BARE comma-separated list. A JSON-shaped value fails closed and every
      // assertion below would read as "not an operator" for the right-looking
      // wrong reason.
      TELEMETRY_ADMIN_USER_IDS: `${OPERATOR_SUB}, user_imp_second_operator`,
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

/** Lets the worker's own timers and socket writes run. */
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

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

  /** One request through the real worker, optionally acting as another owner. */
  async function call(path, { token, method = 'GET', body, actAs, headers = {} } = {}) {
    const response = await mf.dispatchFetch(`http://localhost${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(actAs ? { [ACT_AS_HEADER]: actAs } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  /** One request at an instance BY NAME, with the gateway out of the path. */
  async function callInstance(name, route, { token, method = 'GET', body, actAs } = {}) {
    const response = await mf.dispatchFetch(
      `http://localhost/__t/do/${route}?name=${encodeURIComponent(name)}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(actAs ? { [ACT_AS_HEADER]: actAs } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    const envelope = await response.json().catch(() => null);
    let parsed = null;
    try {
      parsed = JSON.parse(envelope?.body ?? 'null');
    } catch {
      parsed = null;
    }
    return { ok: envelope?.ok === true, status: envelope?.status ?? 0, body: parsed, envelope };
  }

  /** Every instance name the worker addressed, optionally clearing the log. */
  async function addressed({ reset = false } = {}) {
    const response = await mf.dispatchFetch(
      `http://localhost/__t/addressed${reset ? '?reset=1' : ''}`,
    );
    return (await response.json()).addressed ?? [];
  }

  /** Every audit row, newest first. Read from D1 directly, never through a route. */
  async function auditRows() {
    const { results } = await DB.prepare(
      'SELECT id, acting_user_id, owner_id, method, path, at FROM impersonation_audit ORDER BY id DESC',
    ).all();
    return results ?? [];
  }

  async function auditCount() {
    return (await auditRows()).length;
  }

  /**
   * The Durable Object name the gateway gives one owner's workflow instance.
   *
   * PERCENT-ENCODED, which is not obvious: `index.ts` writes
   * `encodeURIComponent(owner:workflowId)` into the path and partyserver hashes the
   * segment it finds there WITHOUT decoding it, so `org_a:wf` and `org_a%3Awf` are
   * two different Durable Objects. Anything reaching an instance by name has to
   * agree with this.
   */
  const instanceOf = (ownerId, workflowId) => encodeURIComponent(`${ownerId}:${workflowId}`);

  const WORKFLOW = 'wf-imp';
  const CUSTOMER_INSTANCE = instanceOf(ORG, WORKFLOW);

  // ══ 0. The customer's world, built by the CUSTOMER ═════════════════════════
  //
  // Everything below is asserted against data this section created, so an
  // operator's read can only be right if the substituted owner really reached the
  // registry prefix and the instance stamp.
  console.log('\nThe customer deploys a workflow of their own');
  {
    const pushed = await call(`${AGENT}/${WORKFLOW}/workflow`, {
      token: CUSTOMER,
      method: 'POST',
      body: spec(WORKFLOW, 'Customer workflow'),
    });
    check('the customer can deploy', pushed.status === 200, JSON.stringify(pushed.body));

    const otherPushed = await call(`${AGENT}/wf-imp-other/workflow`, {
      token: OTHER_CUSTOMER,
      method: 'POST',
      body: spec('wf-imp-other', 'Other customer workflow'),
    });
    check('a second customer deploys too', otherPushed.status === 200);

    check('no impersonation has happened yet', (await auditCount()) === 0);
  }

  // ══ 1. An operator READS another organisation through the header ════════════
  //
  // Feature: multi-organisation-phorma, Requirement 14.5 (read half), 14.2, 14.3.
  console.log('\nAn operator reads a customer through the act-as header');
  {
    // The control, and it is the whole reason the read below means anything: the
    // operator's own account is empty.
    const own = await call('/api/deployments', { token: OPERATOR });
    check(
      "the operator's own deployments are empty",
      own.status === 200 && own.body?.deployments?.length === 0,
      JSON.stringify(own.body),
    );

    const acting = await call('/api/deployments', { token: OPERATOR, actAs: ORG });
    const ids = (acting.body?.deployments ?? []).map(entry => entry.workflowId);
    check(
      "the customer's deployments are served instead",
      acting.status === 200 && ids.length === 1 && ids[0] === WORKFLOW,
      `${acting.status} ${JSON.stringify(acting.body)}`,
    );

    // Naming ONE customer must not reveal the other. The isolation this leans on is
    // the registry prefix, which is exactly the isolation a member gets.
    const otherActing = await call('/api/deployments', { token: OPERATOR, actAs: OTHER_ORG });
    const otherIds = (otherActing.body?.deployments ?? []).map(entry => entry.workflowId);
    check(
      'naming the second customer serves only theirs',
      otherIds.length === 1 && otherIds[0] === 'wf-imp-other',
      JSON.stringify(otherActing.body),
    );

    // `/api/me` is the other half of "exactly as its members see it": the plan and
    // the credits the customer's own studio would show.
    const profile = await call('/api/me', { token: OPERATOR, actAs: ORG });
    check(
      '/api/me answers about the impersonated owner',
      profile.status === 200 && profile.body?.id === ORG && profile.body?.ownerId === ORG,
      JSON.stringify(profile.body).slice(0, 200),
    );
    check(
      'and reports no level, because the operator is a member of nothing',
      profile.body?.level === undefined,
      String(profile.body?.level),
    );

    // The three reads that honour the substituted owner are enumerable, so the set
    // cannot grow silently. `/api/backups` is deliberately not among them.
    check(
      'the impersonated read set is exactly the three documented paths',
      [...IMPERSONATED_READ_PATHS].sort().join(',') ===
        ['/api/deployments', '/api/me', '/api/notifications'].join(','),
      JSON.stringify(IMPERSONATED_READ_PATHS),
    );

    // Through the AGENT gateway: the prefix became the impersonated owner, so the
    // operator reads the deployed spec exactly as a member does.
    const readSpec = await call(`${AGENT}/${WORKFLOW}/workflow`, { token: OPERATOR, actAs: ORG });
    check(
      "the operator reads the customer's deployed spec through the gateway",
      readSpec.status === 200 && readSpec.body?.spec?.name === 'Customer workflow',
      `${readSpec.status} ${JSON.stringify(readSpec.body).slice(0, 160)}`,
    );
    const withoutHeader = await call(`${AGENT}/${WORKFLOW}/workflow`, { token: OPERATOR });
    check(
      'and the same request without the header reads their own empty instance',
      withoutHeader.status === 404 && withoutHeader.body?.hasWorkflow === false,
      `${withoutHeader.status} ${JSON.stringify(withoutHeader.body)}`,
    );
  }

  // ══ 2. Every write is refused AT THE GATEWAY, before anything is woken ══════
  //
  // Feature: multi-organisation-phorma, Property 31: Impersonation never reaches a
  // write, and spends nothing.
  console.log('\nThe gateway refuses an impersonated write before waking anything');
  {
    for (const [label, path, method, body] of [
      ['POST /trigger', `${AGENT}/${WORKFLOW}/trigger`, 'POST', { input: 'go' }],
      ['POST /workflow', `${AGENT}/${WORKFLOW}/workflow`, 'POST', spec(WORKFLOW, 'Rewritten')],
      ['DELETE /workflow', `${AGENT}/${WORKFLOW}/workflow`, 'DELETE', undefined],
      ['POST /approvals', `${AGENT}/${WORKFLOW}/approvals`, 'POST', { nodeId: 'n', approved: true }],
    ]) {
      await addressed({ reset: true });
      const refused = await call(path, { token: OPERATOR, actAs: ORG, method, body });
      check(
        `${label} is refused impersonation_read_only`,
        refused.status === 403 && refused.body?.code === 'impersonation_read_only',
        `${refused.status} ${JSON.stringify(refused.body)}`,
      );
      check(
        `${label} woke no Durable Object`,
        (await addressed()).length === 0,
        JSON.stringify(await addressed()),
      );
    }

    // The control that makes every refusal above meaningful: the customer's own
    // push of the same shape succeeds, and it is what would have been overwritten.
    const stillTheirs = await call(`${AGENT}/${WORKFLOW}/workflow`, { token: CUSTOMER });
    check(
      'the deployed spec was never touched',
      stillTheirs.body?.spec?.name === 'Customer workflow',
      JSON.stringify(stillTheirs.body).slice(0, 160),
    );

    // A refused write writes NO audit row (Requirement 14.9). The reads in section 1
    // did write rows, so this is a delta rather than a zero.
    const before = await auditCount();
    await call(`${AGENT}/${WORKFLOW}/trigger`, {
      token: OPERATOR,
      actAs: ORG,
      method: 'POST',
      body: { input: 'go' },
    });
    check('and left no audit row behind', (await auditCount()) === before, String(before));
  }

  // ══ 3. Every write is refused INSIDE the instance, with no gateway ══════════
  //
  // Feature: multi-organisation-phorma, Property 31.
  //
  // Reached BY NAME, so the gateway's method check never runs - which is exactly
  // why the second layer exists. If these assertions could only be made with the
  // gateway present, they would be asserting the gateway.
  console.log('\nrequireCapability refuses an impersonated write with the gateway absent');
  {
    // The positive control FIRST: this probe really does reach the stamped instance,
    // not a blank one that would answer anything.
    const read = await callInstance(CUSTOMER_INSTANCE, 'workflow', {
      token: OPERATOR,
      actAs: ORG,
    });
    check(
      'the gateway-free probe reaches the real instance, and the read is admitted',
      read.status === 200 && read.body?.spec?.name === 'Customer workflow',
      `${read.status} ${JSON.stringify(read.body).slice(0, 160)}`,
    );

    for (const [label, route, method, body] of [
      ['POST /trigger', 'trigger', 'POST', { input: 'go' }],
      ['POST /workflow', 'workflow', 'POST', spec(WORKFLOW, 'Rewritten from inside')],
      ['DELETE /workflow', 'workflow', 'DELETE', undefined],
    ]) {
      const refused = await callInstance(CUSTOMER_INSTANCE, route, {
        token: OPERATOR,
        actAs: ORG,
        method,
        body,
      });
      check(
        `${label} is refused impersonation_read_only by the instance itself`,
        refused.status === 403 && refused.body?.code === 'impersonation_read_only',
        `${refused.status} ${JSON.stringify(refused.body ?? refused.envelope)}`,
      );
    }

    const untouched = await callInstance(CUSTOMER_INSTANCE, 'workflow', {
      token: CUSTOMER,
    });
    check(
      'the instance still holds the spec the customer pushed',
      untouched.body?.spec?.name === 'Customer workflow',
      JSON.stringify(untouched.body).slice(0, 160),
    );
  }

  // ══ 4. A REAL membership is the write path; the header never is ═════════════
  //
  // Feature: multi-organisation-phorma, Requirement 14.14.
  //
  // The single most important pair in this file. Same human, same allowlist entry,
  // one credential that carries a genuine `org:admin` claim for the customer: the
  // write lands WITHOUT the header and is refused WITH it. Without this pair, every
  // refusal above is equally explained by "this operator has no membership".
  console.log('\nAn operator who is also a member writes through the membership, never the header');
  {
    const throughMembership = await call(`${AGENT}/${WORKFLOW}/workflow`, {
      token: OPERATOR_AS_MEMBER,
      method: 'POST',
      body: spec(WORKFLOW, 'Pushed through a real membership'),
    });
    check(
      'their real membership CAN write',
      throughMembership.status === 200,
      `${throughMembership.status} ${JSON.stringify(throughMembership.body)}`,
    );

    const throughHeader = await call(`${AGENT}/${WORKFLOW}/workflow`, {
      token: OPERATOR_AS_MEMBER,
      actAs: ORG,
      method: 'POST',
      body: spec(WORKFLOW, 'Pushed through the header'),
    });
    check(
      'and the SAME credential is refused when it names the owner through the header',
      throughHeader.status === 403 && throughHeader.body?.code === 'impersonation_read_only',
      `${throughHeader.status} ${JSON.stringify(throughHeader.body)}`,
    );

    const current = await call(`${AGENT}/${WORKFLOW}/workflow`, { token: CUSTOMER });
    check(
      'so the deployed spec is the one the membership pushed',
      current.body?.spec?.name === 'Pushed through a real membership',
      JSON.stringify(current.body).slice(0, 160),
    );

    // And inside the instance, with no gateway, for the same credential.
    const inside = await callInstance(CUSTOMER_INSTANCE, 'trigger', {
      token: OPERATOR_AS_MEMBER,
      actAs: ORG,
      method: 'POST',
      body: { input: 'go' },
    });
    check(
      'the instance refuses it too',
      inside.status === 403 && inside.body?.code === 'impersonation_read_only',
      `${inside.status} ${JSON.stringify(inside.body ?? inside.envelope)}`,
    );

    // Restore the name the rest of the file asserts against.
    await call(`${AGENT}/${WORKFLOW}/workflow`, {
      token: CUSTOMER,
      method: 'POST',
      body: spec(WORKFLOW, 'Customer workflow'),
    });
  }

  // ══ 5. The WebSocket upgrade is refused OUTRIGHT ═══════════════════════════
  //
  // Feature: multi-organisation-phorma, Property 31.
  //
  // An upgrade is a GET, so a method check alone would admit it - and the monitor
  // socket accepts `approval`, `question`, `event`, `trigger` and `stop` frames, so
  // it is a write channel wearing a read's clothes.
  console.log('\nThe monitor upgrade is refused outright while impersonating');
  {
    const monitorUrl = `http://localhost${AGENT}/${WORKFLOW}`;

    await addressed({ reset: true });
    const refused = await mf.dispatchFetch(
      `${monitorUrl}?token=${encodeURIComponent(OPERATOR)}`,
      {
        headers: {
          Upgrade: 'websocket',
          Authorization: `Bearer ${OPERATOR}`,
          [ACT_AS_HEADER]: ORG,
        },
      },
    );
    const refusedBody = await refused.json().catch(() => null);
    check(
      'the upgrade is 403 impersonation_read_only, not 101',
      refused.status === 403 && refusedBody?.code === 'impersonation_read_only',
      `${refused.status} ${JSON.stringify(refusedBody)}`,
    );
    check('and it carries no socket handle', !refused.webSocket, String(Boolean(refused.webSocket)));
    check(
      'and woke no Durable Object',
      (await addressed()).length === 0,
      JSON.stringify(await addressed()),
    );

    // The control: the CUSTOMER's own upgrade, with no header, is answered 101. So
    // the refusal above is about impersonation rather than about the upgrade path
    // being broken under this harness.
    const admitted = await mf.dispatchFetch(
      `${monitorUrl}?token=${encodeURIComponent(CUSTOMER)}`,
      { headers: { Upgrade: 'websocket' } },
    );
    check("the customer's own monitor upgrades", admitted.status === 101, String(admitted.status));
    // The socket is ACCEPTED, drained and closed rather than abandoned. An
    // unaccepted 101 handle leaves a half-open loopback socket that `mf.dispose()`
    // tears down as an unhandled ECONNRESET - which fails the process AFTER every
    // check has passed, and reads like a test failure rather than a leaked handle.
    // The replay the worker sends on connect has to be drained for the same reason.
    if (admitted.webSocket) {
      admitted.webSocket.addEventListener('error', () => undefined);
      admitted.webSocket.addEventListener('message', () => undefined);
      admitted.webSocket.accept();
      await settle(300);
      try {
        admitted.webSocket.close();
      } catch {
        // Already closed by the worker; nothing to do.
      }
      await settle(200);
    }

    // NOT asserted here, and the reason is worth stating: the INSTANCE cannot refuse
    // an upgrade with a status. Measured against the real deploy bundle, a
    // `connection.close()` issued from inside `onConnect` is not delivered, so the
    // socket's enforcement is the per-frame guard in `onMessage`, which reads the
    // level `onConnect` recorded and refuses when there is none. `onConnect` resolves
    // its caller with NO method, so an impersonated socket records nothing and every
    // frame is refused - and that frame-level refusal is driven end to end in
    // `role-gate.test.mjs`. Asserting a status here would assert a refusal that does
    // not happen. The GATEWAY, asserted above, is what stops the upgrade.

    // A refused upgrade is a refused request, so it leaves no row - the monitor path
    // appears nowhere in the audit.
    const rows = await auditRows();
    check(
      'no audit row records an upgrade attempt',
      rows.every(row => row.path !== `${AGENT}/${WORKFLOW}`),
      JSON.stringify(rows.map(row => `${row.method} ${row.path}`)),
    );
  }

  // ══ 6. The entitlement gate spends nothing ═════════════════════════════════
  //
  // Feature: multi-organisation-phorma, Property 31.
  //
  // Driven against the SHIPPED function over the same D1 the worker uses, because
  // "no usage row, no ledger entry and no grant draw" is a claim about ROWS. The
  // tenant is entitled on purpose: the refusal must be about the CALLER.
  console.log('\nresolveHostedInference refuses an impersonated caller (Requirement 14.6)');
  {
    const store = new TenantStore({ DB, KEY_ENC_SECRET });
    const RUNTIME_KEY = 'sk-or-v1-impersonation-test';
    await store.upsertTenant({
      id: ORG,
      email: 'billing@customer.example',
      tier: 'pro',
      status: 'active',
      openrouterKeyId: `hash_${ORG}`,
      openrouterKeyEnc: await encryptString(RUNTIME_KEY, KEY_ENC_SECRET),
    });

    const entitled = await resolveHostedInference(store, ORG);
    check(
      'the tenant would otherwise be entitled',
      !('status' in entitled) && entitled.key === RUNTIME_KEY,
      JSON.stringify(entitled).slice(0, 160),
    );

    const usageBefore = await DB.prepare('SELECT COUNT(*) AS n FROM usage WHERE tenant_id = ?')
      .bind(ORG)
      .first();
    const quotaBefore = await DB.prepare(
      'SELECT COUNT(*) AS n FROM quotas WHERE tenant_id = ?',
    )
      .bind(ORG)
      .first();
    const grantBefore = await DB.prepare(
      'SELECT COUNT(*) AS n FROM credit_grants WHERE tenant_id = ?',
    )
      .bind(ORG)
      .first();

    const refused = await resolveHostedInference(store, ORG, { impersonated: true });
    check(
      'an impersonated caller is refused impersonation_read_only',
      'status' in refused && refused.code === 'impersonation_read_only',
      JSON.stringify(refused),
    );
    check(
      'with 403, not a billing status',
      'status' in refused && refused.status === 403,
      String(refused.status),
    );
    check(
      'and no runtime key is handed back',
      !('key' in refused),
      JSON.stringify(Object.keys(refused)),
    );

    const usageAfter = await DB.prepare('SELECT COUNT(*) AS n FROM usage WHERE tenant_id = ?')
      .bind(ORG)
      .first();
    const quotaAfter = await DB.prepare('SELECT COUNT(*) AS n FROM quotas WHERE tenant_id = ?')
      .bind(ORG)
      .first();
    const grantAfter = await DB.prepare(
      'SELECT COUNT(*) AS n FROM credit_grants WHERE tenant_id = ?',
    )
      .bind(ORG)
      .first();
    check(
      'no usage row, no quota rollup and no grant draw',
      usageAfter.n === usageBefore.n &&
        quotaAfter.n === quotaBefore.n &&
        grantAfter.n === grantBefore.n,
      `${usageAfter.n}/${quotaAfter.n}/${grantAfter.n}`,
    );

    // The token is APPENDED, never a rename: the five that shipped still answer.
    const unknown = await resolveHostedInference(store, 'user_imp_nobody');
    check(
      'the five existing refusal codes are untouched',
      'status' in unknown && unknown.code === 'no_subscription',
      JSON.stringify(unknown),
    );
  }

  // ══ 7. Being ignored is INDISTINGUISHABLE from never having asked ══════════
  //
  // Feature: multi-organisation-phorma, Property 32: Impersonation is honoured only
  // for an operator, and being ignored is indistinguishable.
  console.log('\nAn unhonoured act-as header changes nothing at all (Requirement 14.4)');
  {
    /** The same request twice, with and without the header, compared verbatim. */
    async function indistinguishable(label, token, value) {
      const before = await auditCount();
      const withHeader = await call('/api/deployments', { token, actAs: value });
      const without = await call('/api/deployments', { token });
      check(
        `${label}: the response equals the one without the header`,
        withHeader.status === without.status &&
          JSON.stringify(withHeader.body) === JSON.stringify(without.body),
        `${JSON.stringify(withHeader)} vs ${JSON.stringify(without)}`,
      );
      check(
        `${label}: and no audit row was written`,
        (await auditCount()) === before,
        String((await auditCount()) - before),
      );
      return withHeader;
    }

    // A caller who is not an operator. Not a refusal: the answer to "show me this
    // organisation" for somebody who is not allowed to is the same answer as to a
    // request that never named it.
    const outsider = await indistinguishable('a non-operator', OUTSIDER, ORG);
    check(
      "and it served the outsider's own empty account",
      outsider.status === 200 && outsider.body?.deployments?.length === 0,
      JSON.stringify(outsider.body),
    );

    // A MEMBER of the other organisation naming this one: still not an operator, so
    // still ignored, so still their own data.
    const foreign = await indistinguishable('a member of another organisation', OTHER_CUSTOMER, ORG);
    check(
      'and it served their own organisation',
      (foreign.body?.deployments ?? []).map(entry => entry.workflowId).join(',') ===
        'wf-imp-other',
      JSON.stringify(foreign.body),
    );

    // A real operator naming something that is not an owner id at all. Ignored
    // rather than refused, so probing the header reveals nothing about the shape a
    // real one has.
    for (const value of ['not-an-owner', 'org_', 'orgimp', `${ORG}:extra`, '   ']) {
      await indistinguishable(`an operator naming ${JSON.stringify(value)}`, OPERATOR, value);
    }

    // The DESKTOP token of the very same allowlisted operator (Requirement 14.3).
    // It is a valid credential for their own data and must never impersonate: it is
    // a long-lived bearer in a laptop keychain with no revocation.
    const device = await indistinguishable(
      "the operator's desktop token",
      OPERATOR_DEVICE_TOKEN,
      ORG,
    );
    check(
      'and the desktop token is still a working credential for their own account',
      device.status === 200,
      `${device.status} ${JSON.stringify(device.body)}`,
    );

    // No session state exists, so a header-free request immediately after an
    // impersonated one resolves the caller's own owner (Requirement 14.13).
    const impersonated = await call('/api/deployments', { token: OPERATOR, actAs: ORG });
    check(
      'an impersonated read still works',
      (impersonated.body?.deployments ?? []).length === 1,
      JSON.stringify(impersonated.body),
    );
    const immediatelyAfter = await call('/api/deployments', { token: OPERATOR });
    check(
      'and the very next header-free request is the operator again',
      immediatelyAfter.body?.deployments?.length === 0,
      JSON.stringify(immediatelyAfter.body),
    );
  }

  // ══ 8. Exactly one audit row, field for field ══════════════════════════════
  //
  // Feature: multi-organisation-phorma, Property 33: An accepted impersonated
  // request is audited exactly once, or refused.
  console.log('\nEvery accepted use writes exactly one audit row (Requirement 14.8)');
  {
    const before = await auditRows();
    const at = Date.now();
    // A query string on purpose: `path` must record the route and nothing else.
    const served = await call('/api/notifications?since=1700000000000', {
      token: OPERATOR,
      actAs: ORG,
    });
    check('the impersonated read is served', served.status === 200, JSON.stringify(served.body).slice(0, 160));

    const after = await auditRows();
    check('exactly one row was appended', after.length === before.length + 1, `${before.length} -> ${after.length}`);

    const row = after[0];
    check('the acting user is the operator', row?.acting_user_id === OPERATOR_SUB, row?.acting_user_id);
    check('the owner is the impersonated customer', row?.owner_id === ORG, row?.owner_id);
    check('the method is the request method', row?.method === 'GET', row?.method);
    check('the path is the request path', row?.path === '/api/notifications', row?.path);
    check('with NO query string', !String(row?.path ?? '').includes('?'), row?.path);
    const stamped = Date.parse(row?.at ?? '');
    check(
      'the time is the request time, in ISO 8601 UTC',
      Number.isFinite(stamped) &&
        Math.abs(stamped - at) < 60_000 &&
        String(row.at).endsWith('Z'),
      `${row?.at} vs ${new Date(at).toISOString()}`,
    );

    // A second read is a second row, never a merge: the audit is append-only and
    // one row per REQUEST is the whole claim.
    await call('/api/deployments', { token: OPERATOR, actAs: ORG });
    check('a second accepted read appends a second row', (await auditRows()).length === after.length + 1);

    // Every row so far is a GET. Nothing this table holds is a write, because a
    // write never gets far enough to be recorded.
    check(
      'every row in the table is a GET',
      (await auditRows()).every(entry => entry.method === 'GET'),
      JSON.stringify((await auditRows()).map(entry => entry.method)),
    );
  }

  // ══ 9. An audit-write failure REFUSES the request ══════════════════════════
  //
  // Feature: multi-organisation-phorma, Property 33.
  //
  // The failure is injected by removing the table, which is a real D1 failure on
  // the real write rather than a stubbed one - and it is the shape a missing
  // migration would take in production.
  console.log('\nAn unaudited impersonated read never happens (Requirement 14.10)');
  {
    await DB.prepare('DROP TABLE impersonation_audit').run();

    const refused = await call('/api/deployments', { token: OPERATOR, actAs: ORG });
    check(
      'the request is refused 403 impersonation_unaudited',
      refused.status === 403 && refused.body?.code === 'impersonation_unaudited',
      `${refused.status} ${JSON.stringify(refused.body)}`,
    );
    check(
      'and NO part of the resource is served',
      refused.body?.deployments === undefined && refused.body?.month === undefined,
      JSON.stringify(refused.body),
    );

    // The gateway half refuses too, so an unauditable read cannot reach an instance
    // by the other door either.
    await addressed({ reset: true });
    const gateway = await call(`${AGENT}/${WORKFLOW}/workflow`, { token: OPERATOR, actAs: ORG });
    check(
      'the gateway refuses an unauditable read as well',
      gateway.status === 403 && gateway.body?.code === 'impersonation_unaudited',
      `${gateway.status} ${JSON.stringify(gateway.body)}`,
    );
    check(
      'and woke no Durable Object doing it',
      (await addressed()).length === 0,
      JSON.stringify(await addressed()),
    );

    // A request that names NOBODY is untouched by any of this: the audit is only on
    // the impersonated path.
    const ordinary = await call('/api/deployments', { token: CUSTOMER });
    check(
      'an ordinary request is unaffected',
      ordinary.status === 200 && (ordinary.body?.deployments ?? []).length === 1,
      `${ordinary.status} ${JSON.stringify(ordinary.body)}`,
    );

    // Put it back, from the migration itself, and prove the surface recovers.
    for (const statement of statementsOf('0006_organisations.sql')) {
      if (/impersonation_audit/.test(statement)) await DB.prepare(statement).run();
    }
    const recovered = await call('/api/deployments', { token: OPERATOR, actAs: ORG });
    check(
      'and the read works again once the audit can be written',
      recovered.status === 200 && (recovered.body?.deployments ?? []).length === 1,
      `${recovered.status} ${JSON.stringify(recovered.body)}`,
    );
  }

  // ══ 10. The audit is exposed to an operator, read-only ═════════════════════
  //
  // Feature: multi-organisation-phorma, Requirement 14.11, 16.5.
  console.log('\nGET /api/admin/impersonation serves the audit to an operator');
  {
    const listed = await call(IMPERSONATION_ADMIN_PATH, { token: OPERATOR });
    check('an operator can read it', listed.status === 200, `${listed.status} ${JSON.stringify(listed.body)}`);
    check(
      'and every entry names who acted, as whom, and where',
      Array.isArray(listed.body?.entries) &&
        listed.body.entries.length > 0 &&
        listed.body.entries.every(
          entry =>
            typeof entry.actingUserId === 'string' &&
            typeof entry.ownerId === 'string' &&
            typeof entry.method === 'string' &&
            typeof entry.path === 'string' &&
            typeof entry.at === 'string',
        ),
      JSON.stringify(listed.body).slice(0, 240),
    );
    check(
      'newest first',
      listed.body.entries.every(
        (entry, index) => index === 0 || listed.body.entries[index - 1].id > entry.id,
      ),
      JSON.stringify(listed.body.entries.map(entry => entry.id)),
    );

    const filtered = await call(`${IMPERSONATION_ADMIN_PATH}?owner=${OTHER_ORG}`, {
      token: OPERATOR,
    });
    check(
      'the owner filter answers only that owner',
      filtered.status === 200 &&
        filtered.body?.owner === OTHER_ORG &&
        filtered.body.entries.every(entry => entry.ownerId === OTHER_ORG),
      JSON.stringify(filtered.body).slice(0, 200),
    );
    const bogus = await call(`${IMPERSONATION_ADMIN_PATH}?owner=not-an-owner`, { token: OPERATOR });
    check(
      'an unusable owner filter is refused rather than silently ignored',
      bogus.status === 400,
      `${bogus.status} ${JSON.stringify(bogus.body)}`,
    );

    // The three `refuseNonOperator` rules, on the NEW prefix. Same door.
    const anonymous = await call(IMPERSONATION_ADMIN_PATH);
    check('an absent bearer is 401', anonymous.status === 401, String(anonymous.status));
    const outsider = await call(IMPERSONATION_ADMIN_PATH, { token: OUTSIDER });
    check('a non-operator is 403', outsider.status === 403, String(outsider.status));
    const device = await call(IMPERSONATION_ADMIN_PATH, { token: OPERATOR_DEVICE_TOKEN });
    check(
      "an allowlisted operator's DESKTOP token is 403 here too",
      device.status === 403,
      `${device.status} ${JSON.stringify(device.body)}`,
    );

    // Read-only: no write method is answered at all.
    for (const method of ['POST', 'DELETE']) {
      const rejected = await call(IMPERSONATION_ADMIN_PATH, { token: OPERATOR, method, body: {} });
      check(`${method} is 405`, rejected.status === 405, `${rejected.status} ${JSON.stringify(rejected.body)}`);
    }

    // And it is never cached, like every other operator answer.
    const response = await mf.dispatchFetch(`http://localhost${IMPERSONATION_ADMIN_PATH}`, {
      headers: { Authorization: `Bearer ${OPERATOR}` },
    });
    check(
      'the answer carries Cache-Control: no-store',
      response.headers.get('Cache-Control') === 'no-store',
      String(response.headers.get('Cache-Control')),
    );
  }

  // ══ 11. The preflight allows the header ════════════════════════════════════
  //
  // A header missing from `Access-Control-Allow-Headers` is dropped by the BROWSER,
  // so the dashboard's request would arrive without it and be served as the
  // operator's own owner - indistinguishable from "the header was ignored", which
  // is exactly the failure this feature's silence makes hard to spot.
  console.log('\nThe act-as header survives a browser preflight');
  {
    const preflight = await mf.dispatchFetch(`http://localhost/api/deployments`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:7323',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': ACT_AS_HEADER,
      },
    });
    const allowed = preflight.headers.get('Access-Control-Allow-Headers') ?? '';
    check(
      'the gateway preflight allows it',
      allowed.toLowerCase().includes(ACT_AS_HEADER.toLowerCase()),
      allowed,
    );

    // The instance's own `json()` carries a SECOND copy of that list, and the two
    // can drift. This is the assertion that catches it.
    const instanceResponse = await mf.dispatchFetch(
      `http://localhost${AGENT}/${WORKFLOW}/workflow`,
      { headers: { Authorization: `Bearer ${CUSTOMER}` } },
    );
    const instanceAllowed = instanceResponse.headers.get('Access-Control-Allow-Headers') ?? '';
    check(
      "and the instance's own copy of the list agrees",
      instanceAllowed.toLowerCase().includes(ACT_AS_HEADER.toLowerCase()),
      instanceAllowed,
    );
  }
} finally {
  await mf.dispose();
}

console.log(
  failures === 0 ? '\nAll impersonation checks passed.\n' : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
