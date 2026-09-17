/**
 * `GET /api/notifications` - the account-wide notification fan-out.
 *
 * What this suite is actually protecting. The route asks N Durable Objects for
 * their own notification projection and merges the answers, and the interesting
 * failures are all in the merge rather than in any one instance:
 *
 *  - an instance that cannot be reached must NOT read as an instance with
 *    nothing to report, because collapsing those two turns an outage into a
 *    clean bill of health (the same "a null is not a zero" rule the billing
 *    admin routes carry);
 *  - the fan-out is capped, and a capped answer has to SAY so rather than
 *    silently be a different answer;
 *  - the instance names come from an owner-scoped registry prefix, so tenant
 *    isolation is structural - this asserts the names it actually asks for,
 *    since a bug there is a cross-tenant read and not a rendering glitch;
 *  - the cursor filters on when a run ENDED, so a long run that started before
 *    the cursor and failed after it is still reported. That one is the whole
 *    reason a naive `started_at > cursor` query was rejected.
 *
 * No Miniflare and no worker: the route's dependencies are a registry (a Map is
 * a faithful `ctx.storage`) and a Durable Object namespace (a stub that records
 * the names it is asked for). Spending a loopback socket per request here would
 * buy nothing and cost port range - see the note in the `cloud-worker` steering.
 *
 * Authorization is NOT stubbed. Hosted cases mint a real `phd_` device token and
 * let `verifyBearer` verify it, which is a genuine HMAC round trip with no Clerk
 * and no JWKS fetch - so the identity the route scopes by is the identity a real
 * request would produce.
 *
 * Run: npx -y tsx cloud/test/notifications.test.mjs
 */

import { registerHooks } from 'node:module';

import fc from 'fast-check';

// `notifications.ts` reaches `portal-registry.ts`, which extends
// `cloudflare:workers`' `DurableObject`. Node cannot resolve that built-in, so
// redirect it before the module graph loads.
const workersShim = new URL('./stubs/cloudflare-workers.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      return { url: workersShim, format: 'module', shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const {
  handleNotificationsRequest,
  NOTIFICATIONS_PATH,
  NOTIFY_FANOUT_MAX,
  payloadIsSubstantive,
  projectSettledRun,
  terminalNoticeStatus,
} = await import('../src/notifications.ts');
const { PortalIndex } = await import('../src/portal-registry.ts');
const { mintDeviceToken } = await import('../src/device-auth.ts');

const RUNS = { numRuns: 200 };
const AUTH_SECRET = 'test-device-secret-value';

/** "Send no Authorization header at all", distinguishable from "not specified". */
const NO_BEARER = Symbol('no-bearer');

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

// ── Test doubles ────────────────────────────────────────────────────────────

/** Minimal `ctx.storage`: a Map with get/put/delete/prefix-bounded list. */
function mapStorage() {
  const map = new Map();
  return {
    get: async key => map.get(key) ?? undefined,
    put: async (key, value) => {
      map.set(key, value);
    },
    delete: async key => map.delete(key),
    list: async ({ prefix } = {}) => {
      const out = new Map();
      for (const [key, value] of map) {
        if (prefix === undefined || key.startsWith(prefix)) out.set(key, value);
      }
      return out;
    },
    _map: map,
  };
}

/** An empty projection - what an instance with nothing to say returns. */
function emptyNotice() {
  return { runs: [], pending: [], issues: [] };
}

/**
 * A `WorkflowAgent` namespace stub.
 *
 * `behaviour` maps an instance NAME to either a projection or a thrown error, so
 * a case can make one specific deployment unreachable. Every name asked for is
 * recorded, which is how the isolation checks below assert on the owner prefix
 * rather than trusting it.
 */
function agentNamespace(behaviour) {
  const asked = [];
  const calls = [];
  return {
    asked,
    calls,
    idFromName: name => {
      asked.push(name);
      return { name };
    },
    get: id => ({
      notificationsSince: async (ownerId, cursor) => {
        calls.push({ name: id.name, ownerId, cursor });
        const entry = behaviour[id.name];
        if (entry === undefined) return emptyNotice();
        if (entry instanceof Error) throw entry;
        return entry;
      },
    }),
  };
}

function record(overrides = {}) {
  return {
    workflowId: 'wf-a',
    ownerId: 'user_1',
    workflowName: 'Invoice triage',
    deployedAt: 1_000,
    updatedAt: 1_000,
    specHash: 'hash-1',
    cronArmed: false,
    portalSlug: null,
    ...overrides,
  };
}

/** JSON responder matching the one `routeApiRequest` passes in. */
function respond(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Drives the route.
 *
 * `mode: 'hosted'` mints a device token for `userId` and sends it as a bearer, so
 * the owner the route scopes by is derived by real verification. BYO sends no
 * credential at all, which is what an open single-tenant worker looks like.
 *
 * `bearer: NO_BEARER` is a sentinel rather than `null`, because `null ?? mint()`
 * mints - which silently turned the "hosted with no credential" case into a
 * happy-path read and made it pass against a 200.
 */
async function callRoute({
  records = [],
  behaviour = {},
  since,
  mode = 'byo',
  userId = 'user_1',
  bearer,
} = {}) {
  const storage = mapStorage();
  const index = new PortalIndex({ storage }, {});
  for (const entry of records) await index.registerDeployment(entry);

  const agents = agentNamespace(behaviour);
  const env = {
    PortalIndex: {
      idFromName: () => ({}),
      get: () => index,
    },
    WorkflowAgent: agents,
    ...(mode === 'hosted'
      ? { PHORMA_MODE: 'hosted', PHORMA_AUTH_SECRET: AUTH_SECRET }
      : {}),
  };

  let token = null;
  if (bearer === NO_BEARER) {
    token = null;
  } else if (bearer !== undefined) {
    token = bearer;
  } else if (mode === 'hosted') {
    token = await mintDeviceToken(AUTH_SECRET, userId, Date.now() / 1000);
  }
  const url = new URL(
    `https://worker.example${NOTIFICATIONS_PATH}${since === undefined ? '' : `?since=${since}`}`,
  );
  const request = new Request(url, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  const response = await handleNotificationsRequest(request, env, url, respond);
  return {
    response,
    agents,
    body: response ? await response.clone().json() : null,
  };
}

/** One settled run projection, as an instance would return it. */
function run(overrides = {}) {
  return {
    runId: 'cloudrun-1',
    status: 'failed',
    source: 'schedule',
    startedAt: 5_000,
    endedAt: 6_000,
    error: 'Model refused the request.',
    ...overrides,
  };
}

// ── Path and method matching ────────────────────────────────────────────────

console.log('\nRoute matching');
{
  const url = new URL('https://worker.example/api/deployments');
  const other = await handleNotificationsRequest(
    new Request(url),
    { PortalIndex: {}, WorkflowAgent: {} },
    url,
    respond,
  );
  check('another path answers null so the router keeps looking', other === null);

  const postUrl = new URL(`https://worker.example${NOTIFICATIONS_PATH}`);
  const post = await handleNotificationsRequest(
    new Request(postUrl, { method: 'POST' }),
    { PortalIndex: {}, WorkflowAgent: {} },
    postUrl,
    respond,
  );
  check('a non-GET is 405, not a silent null', post?.status === 405, String(post?.status));
}

// ── Authorization ───────────────────────────────────────────────────────────

console.log('\nAuthorization');
{
  const { response } = await callRoute({ mode: 'hosted', bearer: 'phd_not-a-real-token' });
  check('hosted rejects a forged device token', response.status === 401, String(response.status));

  const missing = await callRoute({ mode: 'hosted', bearer: NO_BEARER });
  check(
    'hosted with no bearer is 401 rather than an anonymous read',
    missing.response.status === 401,
    String(missing.response.status),
  );

  // An open BYO worker has ONE owner and answers for it with no credential -
  // the same contract `/api/deployments` has, and the reason a BYO install gets
  // notifications without a subscription.
  const byo = await callRoute({ records: [record({ ownerId: 'default' })] });
  check('BYO with no credential is answered', byo.response.status === 200, String(byo.response.status));

  const noRegistry = await handleNotificationsRequest(
    new Request(new URL(`https://worker.example${NOTIFICATIONS_PATH}`)),
    { WorkflowAgent: {} },
    new URL(`https://worker.example${NOTIFICATIONS_PATH}`),
    respond,
  );
  check(
    'a worker with no registry binding answers 501 naming that, not 500',
    noRegistry.status === 501,
    String(noRegistry.status),
  );
}

// ── Tenant isolation is structural ──────────────────────────────────────────

console.log('\nTenant isolation');
{
  const { agents, body } = await callRoute({
    mode: 'hosted',
    userId: 'user_1',
    records: [
      record({ ownerId: 'user_1', workflowId: 'wf-mine', workflowName: 'Mine' }),
      record({ ownerId: 'user_2', workflowId: 'wf-theirs', workflowName: 'Theirs' }),
    ],
    behaviour: {
      'user_1:wf-mine': { runs: [run()], pending: [], issues: [] },
      'user_2:wf-theirs': { runs: [run({ runId: 'leak' })], pending: [], issues: [] },
    },
  });

  check(
    'only the caller\'s own deployment is asked',
    agents.asked.length === 1 && agents.asked[0] === 'user_1:wf-mine',
    agents.asked.join(', '),
  );
  check(
    'the other tenant\'s run never appears in the body',
    JSON.stringify(body).includes('leak') === false,
    JSON.stringify(body),
  );
  check(
    'the instance name carries the hosted owner prefix',
    agents.calls[0].name === 'user_1:wf-mine',
    agents.calls[0].name,
  );
  check(
    'the verified owner is passed to the instance for its own re-check',
    agents.calls[0].ownerId === 'user_1',
    agents.calls[0].ownerId,
  );
}

{
  // BYO instances are named by the bare workflow id, because `index.ts` only
  // applies the owner prefix in hosted mode. Asking for `default:wf-a` there
  // would address a Durable Object that has never existed, and every deployment
  // would read as empty rather than as an error.
  const { agents } = await callRoute({
    records: [record({ ownerId: 'default', workflowId: 'wf-a' })],
  });
  check(
    'a BYO instance is asked by its bare workflow id',
    agents.asked.length === 1 && agents.asked[0] === 'wf-a',
    agents.asked.join(', '),
  );
}

// ── Unreachable is not empty ────────────────────────────────────────────────

console.log('\nAn unreachable instance is named, never silently empty');
{
  const { body } = await callRoute({
    mode: 'hosted',
    records: [
      record({ workflowId: 'wf-ok', workflowName: 'Fine' }),
      record({ workflowId: 'wf-down', workflowName: 'Evicted' }),
    ],
    behaviour: {
      'user_1:wf-ok': { runs: [run()], pending: [], issues: [] },
      'user_1:wf-down': new Error('RPC failed: instance unreachable'),
    },
  });

  check('the reachable deployment is still reported', body.deployments.length === 1, JSON.stringify(body.deployments));
  check('the unreachable one is named', body.unreachable.length === 1 && body.unreachable[0] === 'wf-down', JSON.stringify(body.unreachable));
  check(
    'an unreachable instance does not appear as a deployment with nothing to say',
    body.deployments.some(entry => entry.workflowId === 'wf-down') === false,
    JSON.stringify(body.deployments),
  );
}

{
  // Every instance down is the case a naive implementation reports as "all
  // clear". The list must be empty AND the failures named, so the studio can
  // tell the user it could not check rather than that nothing happened.
  const { body } = await callRoute({
    mode: 'hosted',
    records: [record({ workflowId: 'wf-1' }), record({ workflowId: 'wf-2' })],
    behaviour: {
      'user_1:wf-1': new Error('down'),
      'user_1:wf-2': new Error('down'),
    },
  });
  check('a total outage reports no deployments', body.deployments.length === 0);
  check('a total outage names every failure', body.unreachable.length === 2, JSON.stringify(body.unreachable));
}

// ── Empty projections are omitted, not padded ───────────────────────────────

console.log('\nDeployments with nothing to report are omitted');
{
  const { body } = await callRoute({
    mode: 'hosted',
    records: [
      record({ workflowId: 'wf-quiet' }),
      record({ workflowId: 'wf-loud' }),
    ],
    behaviour: {
      'user_1:wf-quiet': emptyNotice(),
      'user_1:wf-loud': { runs: [], pending: [], issues: ['Schedule "Nightly" was not armed.'] },
    },
  });
  check(
    'a deployment with three empty arrays is left out of the body',
    body.deployments.length === 1 && body.deployments[0].workflowId === 'wf-loud',
    JSON.stringify(body.deployments),
  );
  check(
    'an issues-only deployment IS reported',
    body.deployments[0].issues.length === 1,
    JSON.stringify(body.deployments[0]),
  );
  check('a quiet deployment is not counted as unreachable', body.unreachable.length === 0);
}

// ── Identity comes from the registry ────────────────────────────────────────

console.log('\nIdentity is stitched from the registry record');
{
  const { body } = await callRoute({
    mode: 'hosted',
    records: [record({ workflowId: 'wf-a', workflowName: 'Invoice triage' })],
    behaviour: { 'user_1:wf-a': { runs: [run()], pending: [], issues: [] } },
  });
  const entry = body.deployments[0];
  check('the workflow id is the registry id', entry.workflowId === 'wf-a', entry.workflowId);
  check('the workflow name is the registry name', entry.workflowName === 'Invoice triage', entry.workflowName);
  check('the projection payload is carried through', entry.runs.length === 1 && entry.runs[0].status === 'failed', JSON.stringify(entry.runs));
}

// ── The cursor ──────────────────────────────────────────────────────────────

console.log('\nThe cursor');
{
  const { agents } = await callRoute({
    mode: 'hosted',
    since: 12_345,
    records: [record()],
  });
  check('the since parameter reaches the instance', agents.calls[0].cursor === 12_345, String(agents.calls[0].cursor));

  for (const [label, value] of [
    ['absent', undefined],
    ['empty', ''],
    ['negative', '-5'],
    ['non-numeric', 'yesterday'],
    ['infinite', 'Infinity'],
  ]) {
    const { agents: a } = await callRoute({ mode: 'hosted', since: value, records: [record()] });
    check(
      `a ${label} cursor reads as 0 so nothing unseen is skipped`,
      a.calls[0].cursor === 0,
      String(a.calls[0].cursor),
    );
  }

  const { agents: floored } = await callRoute({
    mode: 'hosted',
    since: '900.75',
    records: [record()],
  });
  check('a fractional cursor floors rather than rejecting', floored.calls[0].cursor === 900, String(floored.calls[0].cursor));
}

{
  // The server clock is the next cursor, not the client's. A machine whose clock
  // runs fast would otherwise hand back a future `since` and skip its own
  // notifications, permanently and silently.
  const before = Date.now();
  const { body } = await callRoute({ mode: 'hosted', records: [record()] });
  check(
    'the response carries a server-side cursor for the next call',
    typeof body.at === 'number' && body.at >= before,
    String(body.at),
  );
}

// ── The fan-out cap ─────────────────────────────────────────────────────────

console.log('\nThe fan-out cap');
{
  const many = [];
  for (let index = 0; index < NOTIFY_FANOUT_MAX + 5; index += 1) {
    many.push(record({ workflowId: `wf-${index}`, updatedAt: 10_000 - index }));
  }
  const { agents, body } = await callRoute({ mode: 'hosted', records: many });

  check(
    `at most ${NOTIFY_FANOUT_MAX} instances are asked`,
    agents.asked.length === NOTIFY_FANOUT_MAX,
    String(agents.asked.length),
  );
  check('a capped answer says so', body.truncated === true, String(body.truncated));
  check(
    'the cap keeps the most recently updated deployments',
    agents.asked.includes('user_1:wf-0') && agents.asked.includes(`user_1:wf-${NOTIFY_FANOUT_MAX - 1}`),
    agents.asked.join(', '),
  );
  check(
    'the oldest deployment past the cap is the one dropped',
    agents.asked.includes(`user_1:wf-${NOTIFY_FANOUT_MAX + 4}`) === false,
  );
}

{
  const { body } = await callRoute({ mode: 'hosted', records: [record()] });
  check('an uncapped answer says so too', body.truncated === false, String(body.truncated));
}

{
  const { body, agents } = await callRoute({ mode: 'hosted', records: [] });
  check('an account with no deployments asks nothing', agents.asked.length === 0);
  check('and answers an empty list rather than failing', body.deployments.length === 0 && body.truncated === false);
}

// ── Property: the merge is total ────────────────────────────────────────────

console.log('\nProperty: every selected deployment is reported or named unreachable');
await fc.assert(
  fc.asyncProperty(
    fc.array(
      fc.record({
        workflowId: fc.string({ minLength: 1, maxLength: 8 }).filter(value => !value.includes(':')),
        reachable: fc.boolean(),
        hasNews: fc.boolean(),
      }),
      { minLength: 0, maxLength: 12 },
    ),
    async entries => {
      // Distinct ids: the registry is keyed by id, so a duplicate is one record.
      const unique = [];
      const seen = new Set();
      for (const entry of entries) {
        if (seen.has(entry.workflowId)) continue;
        seen.add(entry.workflowId);
        unique.push(entry);
      }

      const behaviour = {};
      for (const entry of unique) {
        behaviour[`user_1:${entry.workflowId}`] = entry.reachable
          ? entry.hasNews
            ? { runs: [run({ runId: `r-${entry.workflowId}` })], pending: [], issues: [] }
            : emptyNotice()
          : new Error('unreachable');
      }

      const { body } = await callRoute({
        mode: 'hosted',
        records: unique.map(entry => record({ workflowId: entry.workflowId })),
        behaviour,
      });

      const reported = new Set(body.deployments.map(entry => entry.workflowId));
      const named = new Set(body.unreachable);

      for (const entry of unique) {
        // Three exhaustive outcomes, and no deployment may fall between them:
        // reported with news, named unreachable, or omitted as quiet.
        if (!entry.reachable) {
          if (!named.has(entry.workflowId)) return false;
          if (reported.has(entry.workflowId)) return false;
        } else if (entry.hasNews) {
          if (!reported.has(entry.workflowId)) return false;
          if (named.has(entry.workflowId)) return false;
        } else {
          if (reported.has(entry.workflowId)) return false;
          if (named.has(entry.workflowId)) return false;
        }
      }
      // And nothing is invented: every reported or named id was a real record.
      for (const id of [...reported, ...named]) if (!seen.has(id)) return false;
      return true;
    },
  ),
  RUNS,
);
console.log('  PASS  the merge classifies every selected deployment exactly once');

// ── Property: a raised cursor never resurrects a notice ─────────────────────

console.log('\nProperty: advancing the cursor is monotonic at the boundary');
await fc.assert(
  fc.asyncProperty(
    fc.integer({ min: 1, max: 100_000 }),
    fc.integer({ min: 1, max: 100_000 }),
    async (a, b) => {
      const low = Math.min(a, b);
      const high = Math.max(a, b);
      const lowCall = await callRoute({ mode: 'hosted', since: low, records: [record()] });
      const highCall = await callRoute({ mode: 'hosted', since: high, records: [record()] });
      // The route's own contract: whatever the client asked for is what the
      // instance is asked, unmodified and unclamped, so the studio's cursor
      // arithmetic is the only thing deciding the window.
      return lowCall.agents.calls[0].cursor === low && highCall.agents.calls[0].cursor === high;
    },
  ),
  RUNS,
);
console.log('  PASS  the cursor reaches the instance unmodified');

// ── The per-run projection ──────────────────────────────────────────────────
//
// These are the decisions `WorkflowAgent.settledRunsSince` delegates. They live
// in `notifications.ts` rather than on the Durable Object precisely so they can
// be asserted here without importing the `agents` SDK.

console.log('\nWhich statuses are an outcome');
{
  check('completed is an outcome', terminalNoticeStatus('completed') === 'completed');
  check('failed is an outcome', terminalNoticeStatus('failed') === 'failed');
  check('stopped is an outcome', terminalNoticeStatus('stopped') === 'stopped');
  // A `running` row is either a live run or an instance evicted mid-run that
  // never resumed. Reporting it would announce the same non-event every tick.
  check('running is not an outcome', terminalNoticeStatus('running') === null);
  check('skipped is not an outcome', terminalNoticeStatus('skipped') === null);
  // Fails closed on purpose: a status added to the engine later is unreported
  // rather than reported as something it is not.
  check('an unknown status is not an outcome', terminalNoticeStatus('quantum') === null);
}

console.log('\nThe cursor filters on when a run ENDED');
{
  // The defect this exists to prevent. A run starts at 1000, the client's cursor
  // is 2000, the run fails at 3000. Filtering on `startedAt` loses it forever -
  // and a long-running deployed workflow failing is the single most important
  // notification in the product.
  const longRun = { id: 'r1', status: 'failed', source: 'schedule', startedAt: 1_000, endedAt: 3_000, error: 'boom' };
  check(
    'a run that started before the cursor but ended after it IS reported',
    projectSettledRun(longRun, 2_000)?.runId === 'r1',
    JSON.stringify(projectSettledRun(longRun, 2_000)),
  );
  check(
    'the same run is not reported once the cursor passes its end',
    projectSettledRun(longRun, 3_000) === null,
  );
  check(
    'the boundary is exclusive, so a run is never reported twice',
    projectSettledRun({ ...longRun, endedAt: 3_000 }, 3_000) === null,
  );
  check(
    'a run with no endedAt has not settled, whatever its status column says',
    projectSettledRun({ id: 'r2', status: 'completed', source: 'manual', startedAt: 1 }, 0) === null,
  );
  check(
    'a running row is never projected',
    projectSettledRun({ id: 'r3', status: 'running', source: 'manual', startedAt: 1, endedAt: 9 }, 0) === null,
  );
}

{
  const failed = projectSettledRun(
    { id: 'r', status: 'failed', source: 'schedule', startedAt: 1, endedAt: 2, error: 'nope' },
    0,
  );
  check('a failure carries its message', failed.error === 'nope');
  const completed = projectSettledRun(
    { id: 'r', status: 'completed', source: 'manual', startedAt: 1, endedAt: 2, error: 'stale' },
    0,
  );
  // An `error` on a completed row would be a recorder bug; carrying it would
  // render a success as a failure in the feed.
  check('a completion carries no error field at all', 'error' in completed === false, JSON.stringify(completed));
  check('the engine source is carried through verbatim', completed.source === 'manual');
}

console.log('\nProperty: projection never reports a run at or before the cursor');
await fc.assert(
  fc.property(
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 6 }),
      status: fc.constantFrom('running', 'completed', 'failed', 'stopped', 'skipped'),
      source: fc.constantFrom('manual', 'schedule', 'eval', 'portal', 'webhook', 'resume'),
      startedAt: fc.integer({ min: 0, max: 100_000 }),
      endedAt: fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: undefined }),
    }),
    fc.integer({ min: 0, max: 100_000 }),
    (summary, cursor) => {
      const projected = projectSettledRun(summary, cursor);
      if (projected === null) return true;
      // Three claims about anything that IS projected, and the contents matter:
      // it ended strictly after the cursor, it is a terminal status, and its
      // identity is the summary's own rather than something invented.
      if (projected.endedAt <= cursor) return false;
      if (!['completed', 'failed', 'stopped'].includes(projected.status)) return false;
      return projected.runId === summary.id && projected.startedAt === summary.startedAt;
    },
  ),
  RUNS,
);
console.log('  PASS  a projected run always ended strictly after the cursor');

console.log('\nWhether a gate carries context worth opening the run for');
{
  check('a real payload is substantive', payloadIsSubstantive('{"invoice":"INV-1"}'));
  check('an empty string is not', payloadIsSubstantive('') === false);
  check('whitespace is not', payloadIsSubstantive('   \n ') === false);
  // These three are what an unset payload serializes to at different points on
  // the path, and each one would otherwise send the user to read nothing.
  check('an empty JSON object is not', payloadIsSubstantive('{}') === false);
  check('the string "null" is not', payloadIsSubstantive('null') === false);
  check('an empty JSON string is not', payloadIsSubstantive('""') === false);
  check('undefined is not', payloadIsSubstantive(undefined) === false);
  check('null is not', payloadIsSubstantive(null) === false);
  // A non-string non-nullish payload is a host passing something unexpected;
  // treat it as context rather than hide it.
  check('a non-string value counts as context', payloadIsSubstantive({ a: 1 }));
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log('All notification fan-out checks passed.');
