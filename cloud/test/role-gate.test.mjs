/**
 * The Role_Gate - `cloud/src/role-gate.ts` and its call sites
 * (multi-organisation-phorma tasks 5 and 6, Requirements 5.9, 5.10, 6.1 to 6.11,
 * 7.6, 8.5, 13.1, 13.2, 16.2, 18.1, 18.5, 18.6).
 *
 * `/api/me`'s two additive fields (task 6) are driven here rather than in a suite
 * of their own, because they REPORT what `resolveRole` answers and this harness
 * already holds one member per level in a real `org_members` table. The route half
 * of the studio capability seam and the write gate then cannot drift apart: the
 * same organisation, the same rows, the same tokens.
 *
 * Two halves, and BOTH are needed.
 *
 *  1. RUNTIME. Every `WRITE_ROUTES` entry is driven against the real route in a
 *     real worker, once per Capability_Level, and the answer is required to be
 *     exactly `atLeast(level, required)`. Driving the TABLE alone would pass for
 *     a table that has drifted away from the routes, which is the failure mode
 *     the table exists to prevent.
 *  2. STATIC. `cloud/src/api.ts` and `cloud/src/workflow-agent.ts` are scanned
 *     for mutating method and path literals, and any that `requiredLevelFor`
 *     does not answer fails the suite. This is what makes Requirement 6.9 real:
 *     a new write route with no table entry fails HERE, before anybody has to
 *     notice the 403 the runtime fallback would have produced.
 *
 * Harness, and why each piece is real rather than stubbed:
 *
 *  - THE WORKER IS THE DEPLOY BUNDLE. `wrangler deploy --dry-run` emits the exact
 *    script a real deploy would ship, and Miniflare runs it with real
 *    SQLite-backed Durable Objects. So the gateway, `WorkflowAgent.onRequest` and
 *    `routeApiRequest` are all in the path, which is the only way to tell "the
 *    gate is wired into this route" from "the gate exists".
 *  - HOSTED MODE, because an organisation only exists there. The gateway
 *    therefore rewrites each instance name to `{userId}:{workflowId}`, so each
 *    test user drives their OWN instance and no assertion can be confused by
 *    `enforceOwnership`'s 403. That 403 carries no `code`, and every refusal
 *    assertion below reads `code` and `required` rather than the status alone,
 *    so the two can never be mistaken for one another.
 *  - AUTHORIZATION IS NOT STUBBED. An RSA keypair is generated here, the public
 *    half is handed to the worker as `CLERK_JWT_KEY`, and each case signs its own
 *    RS256 session JWT, so `@clerk/backend` verifies for real on its offline path
 *    with no JWKS fetch.
 *  - D1 IS REAL, with the real migrations applied, because `org_members` is the
 *    authoritative level source. Setup goes through `DB.batch([...])` and the
 *    handle through `withLoopbackRetryD1`, since each proxied statement costs a
 *    loopback socket.
 *  - THERE IS NO `TENANTS` BINDING, deliberately. `resolveRole` caches a HIT for
 *    60 seconds, and this suite rewrites a level between passes; with no KV in
 *    the path every request reads the authoritative row. The cache itself, its
 *    key and its TTL are pinned by `owner-identity.test.mjs`.
 *
 * NOT asserted here, on purpose:
 *
 *  - Anything about the ownership claim BEYOND its required level. Its entry and
 *    its probe arrived with the route in task 2, because a table entry with no
 *    route behind it would 404 under the drive below; the claim path's own
 *    preconditions, refusals and row transfers live in `ownership-claim.test.mjs`.
 *  - The `billing_managed` refusal's own behaviour - the absent Stripe call, the
 *    byte-identical personal-owner path - which `billing-routes.test.mjs` and
 *    `organisation-billing.test.mjs` own. What IS asserted here is that it is NOT a
 *    level refusal: every credential in this suite names an organisation, so the two
 *    billing routes answer `billing_managed` at all four levels including `admin`,
 *    and never `role_forbidden`. That is the table's personal-owner condition,
 *    measured rather than left in prose - an implementation that moved the refusal
 *    into `requireCapability` would refuse the three lower levels with the wrong
 *    code and let `admin` through to Stripe.
 *  - The impersonation refusal beyond its ORDERING, which is pinned by calling the
 *    gate directly. `applyImpersonation` is the only thing that sets `impersonated`,
 *    and the act-as header end to end - both enforcement layers, the audit and the
 *    silence - is `impersonation.test.mjs`'s subject.
 *
 * Run: node cloud/test/role-gate.test.mjs
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

// `portal-registry.ts` extends the SDK's `DurableObject`, which a plain node
// process cannot resolve. Redirected before the module graph loads, the same shim
// `status.test.mjs` and `owner-identity.test.mjs` use.
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
  MUTATING_METHODS,
  ROLE_GATE_FALLBACK_LEVEL,
  WRITE_ROUTES,
  isMutatingMethod,
  matchWriteRoute,
  requireCapability,
  requiredLevelFor,
  roleForbidden,
} = await import('../src/role-gate.ts');
const { CAPABILITIES_BY_LEVEL, CAPABILITY_LEVELS, atLeast } = await import(
  '../src/capabilities.ts'
);
const { TELEMETRY_ADMIN_PREFIX } = await import('../src/telemetry-admin.ts');
const { BILLING_ADMIN_PREFIX } = await import('../src/billing-admin.ts');
const { ORG_ADMIN_PREFIX } = await import('../src/org-admin.ts');
const { BILLING_RETURN_PATH, SIGNED_IN_PATH } = await import('../src/api.ts');

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

// ══ Part 1: the gate as a function ══════════════════════════════════════════
//
// Driven directly, with no worker, for the three things a route drive cannot
// reach: the discriminator's shape, the inert `admin` answers that make this
// whole feature deployable, and the impersonation ORDERING - which no ordinary
// route drive can produce, because a real act-as header is refused at the gateway
// before it ever reaches a route (`impersonation.test.mjs` drives that half).
//
// These calls pass NO method, which is the fail-closed shape: with no method named
// the gate treats the request as a write, so an impersonated caller is refused
// whatever level they resolve.

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A synthesised context, the way a caller that holds one would pass it. */
function context(partial) {
  const auth = { userId: null, orgId: null, orgRole: null, kind: 'clerk', ...partial };
  auth.ownerId = auth.orgId ?? auth.userId;
  return auth;
}

async function refusalOf(response) {
  return { status: response.status, body: await response.json().catch(() => null) };
}

console.log('\nrequireCapability, driven directly (Requirements 5.9, 5.10, 6.1)');
{
  // Feature: multi-organisation-phorma, Property 2: A credential with no
  // organisation claim resolves full capability over its own owner.
  //
  // `{}` as the env is the load-bearing part of the next two checks: an `admin`
  // answer with no `DB` and no `TENANTS` binding cannot have come from a table.
  for (const level of CAPABILITY_LEVELS) {
    const solo = await requireCapability({}, context({ userId: 'user_solo' }), level, reply);
    check(
      `a credential with no organisation claim is admitted at ${level} with no bindings`,
      !(solo instanceof Response) && solo.level === 'admin',
      JSON.stringify(solo),
    );
  }

  const shared = await requireCapability(
    {},
    context({ userId: null, kind: 'shared' }),
    'admin',
    reply,
  );
  check(
    'a BYO shared credential is admitted at admin',
    !(shared instanceof Response) && shared.level === 'admin',
    JSON.stringify(shared),
  );
  check(
    'and it carries a null owner rather than an invented one',
    !(shared instanceof Response) && shared.ownerId === null && shared.userId === null,
    JSON.stringify(shared),
  );
  check(
    "the discriminator is 'level' in result, so no cast is needed",
    !(shared instanceof Response) && 'level' in shared,
  );

  // A mapped role claim short-circuits, so this needs no bindings either.
  const claimed = await requireCapability(
    {},
    context({ userId: 'user_a', orgId: 'org_acme', orgRole: 'org:admin' }),
    'admin',
    reply,
  );
  check(
    'a mapped organisation role claim is admitted with no table read',
    !(claimed instanceof Response) && claimed.level === 'admin',
    JSON.stringify(claimed),
  );
  check(
    'and the organisation is the owner, with userId still the subject',
    !(claimed instanceof Response) && claimed.ownerId === 'org_acme' && claimed.userId === 'user_a',
    JSON.stringify(claimed),
  );
  check(
    'an ordinary caller is not impersonated',
    !(claimed instanceof Response) && claimed.impersonated === false,
  );

  // Feature: multi-organisation-phorma, Property 13: An unresolvable role fails
  // closed and writes nothing.
  const unresolvable = context({ userId: 'user_b', orgId: 'org_acme', orgRole: 'org:member' });
  const unknown = await refusalOf(
    await requireCapability({}, unresolvable, 'operator', reply),
  );
  check('an unresolvable role is 403', unknown.status === 403, String(unknown.status));
  check(
    'with code role_unknown, never a substituted operator',
    unknown.body?.code === 'role_unknown',
    JSON.stringify(unknown.body),
  );
  check(
    'and it names no required level, because the level was never the reason',
    unknown.body?.required === undefined,
    JSON.stringify(unknown.body),
  );

  // The impersonation refusal is FIRST, so an operator who ALSO holds a real
  // membership cannot write through the act-as header (Requirement 14.14).
  const impersonatedAdmin = { ...context({ userId: 'user_op', orgId: null }), impersonated: true };
  const blocked = await refusalOf(
    await requireCapability({}, impersonatedAdmin, 'operator', reply),
  );
  check(
    'an impersonated request is refused even though it resolves admin',
    blocked.status === 403 && blocked.body?.code === 'impersonation_read_only',
    JSON.stringify(blocked.body),
  );
  const impersonatedUnknown = {
    ...context({ userId: 'user_b', orgId: 'org_acme', orgRole: 'org:member' }),
    impersonated: true,
  };
  const ordered = await refusalOf(
    await requireCapability({}, impersonatedUnknown, 'admin', reply),
  );
  check(
    'the impersonation refusal outranks both role_unknown and role_forbidden',
    ordered.body?.code === 'impersonation_read_only',
    JSON.stringify(ordered.body),
  );

  // Requirement 6.8: the required level is NAMED in the body.
  const forbidden = await refusalOf(roleForbidden('builder', reply));
  check('roleForbidden is 403', forbidden.status === 403, String(forbidden.status));
  check(
    'and names the required level in the body',
    forbidden.body?.code === 'role_forbidden' && forbidden.body?.required === 'builder',
    JSON.stringify(forbidden.body),
  );
}

console.log('\nThe write-route table (Requirement 6.9)');
{
  check(
    'every mutating method is classified as mutating',
    MUTATING_METHODS.every(method => isMutatingMethod(method)) &&
      isMutatingMethod('post') &&
      !isMutatingMethod('GET') &&
      !isMutatingMethod('HEAD'),
  );
  check(
    'the fail-closed level is the HIGHEST one, so an unguarded write is broken not open',
    CAPABILITY_LEVELS.every(level => atLeast(ROLE_GATE_FALLBACK_LEVEL, level)),
    ROLE_GATE_FALLBACK_LEVEL,
  );
  check(
    'every table entry declares a level in the vocabulary',
    WRITE_ROUTES.every(route => CAPABILITY_LEVELS.includes(route.required)),
  );
  check(
    'every table entry declares a mutating method',
    WRITE_ROUTES.every(route => isMutatingMethod(route.method)),
  );
  check(
    'every table entry carries a reason',
    WRITE_ROUTES.every(route => typeof route.note === 'string' && route.note.length > 10),
  );
  check(
    'requiredLevelFor answers undefined for a path the table does not name',
    requiredLevelFor('POST', '/agents/workflow-agent/wf/brand-new-write') === undefined,
  );
  check(
    'a read is never answered, so reads stay open to every level',
    requiredLevelFor('GET', '/agents/workflow-agent/wf/workflow') === undefined &&
      requiredLevelFor('GET', '/api/me') === undefined,
  );
}

// ══ Part 2: the static scan ═════════════════════════════════════════════════
//
// The comment and template-literal stripping and the "no matches found means the
// parser broke" vacuous-pass guard are copied from
// `scripts/check-telemetry-isolation.mjs`, for the same reason it has them: a
// doc comment must not be able to pass or fail the check, and a scanner that
// stops matching the file passes vacuously and silently.

const SCANNED_FILES = ['src/api.ts', 'src/workflow-agent.ts'];

/**
 * Mutating routes in the two scanned files that the table deliberately does NOT
 * answer, with a reason each. Keyed `METHOD path`. An entry the scan never
 * reaches is pruned, so this list cannot rot into a blanket exemption.
 */
const EXEMPT_WRITES = {
  'POST /api/provision':
    'Authenticates against PHORMA_ADMIN_TOKEN, a shared operator secret carrying no ' +
    'Clerk identity, so there is no Capability_Level to resolve and no AuthContext ' +
    'to hand the gate. Manual billing; see its own header comment.',
  'POST /api/deactivate':
    'The same PHORMA_ADMIN_TOKEN surface as /api/provision, and refused the same way.',
};

/**
 * Path branches in the two scanned files that carry no method in the same
 * expression, with a reason each. `delegates` names the mutating methods a
 * branch hands on to, and each one is required to be answered by the table - so
 * a delegating branch cannot hide an unguarded write behind a method check made
 * somewhere else in the file.
 */
const ROUTE_BRANCHES = {
  '/api/': {
    reason:
      'The control-plane surface prefix, not a route: handleApiRequest answers null for ' +
      'anything outside it.',
    delegates: [],
  },
  '/api/connection-secrets': {
    reason:
      'One branch, three methods: handleConnectionSecretRequest dispatches GET as a read ' +
      'and POST/DELETE as writes, so the two writes are what the table has to answer.',
    delegates: [
      ['POST', 'editor'],
      ['DELETE', 'editor'],
    ],
  },
  [TELEMETRY_ADMIN_PREFIX]: {
    reason:
      'NOT a Role_Gate family. Gated by refuseNonOperator (admin-auth.ts), which answers a ' +
      'different 401-versus-403 split, refuses a non-clerk credential kind outright and hands ' +
      'back no identity - so requiredLevelFor answering undefined here is correct.',
    delegates: [],
  },
  [BILLING_ADMIN_PREFIX]: {
    reason:
      'The second operator family, behind the same refuseNonOperator gate and the same ' +
      'allowlist secret. A separate prefix for a privacy contract, not for authorization.',
    delegates: [],
  },
  [ORG_ADMIN_PREFIX]: {
    reason:
      'The THIRD operator family (org-admin.ts), same refuseNonOperator gate, same allowlist ' +
      'secret. Its absence from the table is a REQUIREMENT rather than a consequence: ' +
      'Requirement 13.7 says membership is written through the operator gate alone, so ' +
      'member.manage is a declared capability no Role_Gate route exercises. The inventory ' +
      'assertion below is what holds that.',
    delegates: [],
  },
  [BILLING_RETURN_PATH]: {
    reason:
      'A public GET/HEAD page Stripe redirects a browser to. No bearer, no bindings, no state, ' +
      'and every other method is answered 405 by the handler itself.',
    delegates: [],
  },
  [SIGNED_IN_PATH]: {
    reason: 'A public GET/HEAD page the Clerk instance redirects a browser to. As above.',
    delegates: [],
  },
};

/** Path-valued constants the scan may meet as an identifier rather than a literal. */
const PATH_CONSTANTS = {
  TELEMETRY_ADMIN_PREFIX,
  BILLING_ADMIN_PREFIX,
  ORG_ADMIN_PREFIX,
  BILLING_RETURN_PATH,
  SIGNED_IN_PATH,
};

/**
 * Path fragments that mean "this route writes membership". Deliberately broad:
 * the assertion below is an ABSENCE claim, and a narrow pattern would pass by
 * failing to recognise the route it was supposed to find.
 */
const MEMBER_WRITE_TELLS = [/member/i, /organisation/i, /organization/i, /\bteam\b/i, /invite/i];

/**
 * Comments removed, so a doc comment can neither pass nor fail this check.
 *
 * Three decisions here were each paid for by the scan silently reading `api.ts`
 * as having ZERO routes, which is the exact vacuous pass this guard is supposed
 * to be immune to:
 *
 *  - LINE comments go FIRST. `api.ts` carries section banners like
 *    `// /api/admin/telemetry/* - owner-only telemetry aggregates`, and a
 *    block-comment stripper run first treats that `/*` as an opening delimiter
 *    and deletes everything up to the next `*\/`, which was 400 lines of real
 *    routes. Order is not cosmetic here.
 *  - The line stripper matches only a comment that OPENS its line. A stripper
 *    keyed on `//` anywhere eats the tail of any line holding a URL or a `[^/]`
 *    character class, which deleted a further 5,000 characters.
 *  - Template literals are NOT stripped. Neither file contains a template
 *    literal that could form a method-plus-path comparison, and a stripper that
 *    mistakes a backtick inside a single-quoted string (this file has several,
 *    quoting `wrangler secret put ...`) for a delimiter deletes real code
 *    between them.
 */
function strippedSource(source) {
  return source.replace(/^[ \t]*\/\/[^\n]*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const PATH_EXPR = String.raw`(?:url\.pathname|path)`;
const COMPARE = String.raw`(?:\s*(?:===|!==)\s*|\.(?:endsWith|startsWith)\(\s*)`;
const ANY_METHOD = 'GET|HEAD|POST|PUT|PATCH|DELETE';
/**
 * The body of a route regex literal. The character-class alternative is required
 * rather than tidy: every route regex in `workflow-agent.ts` contains `[^/]`, and
 * a body pattern that simply refuses an unescaped `/` stops at the one inside
 * that class and reads the `]` as the closing delimiter - which is how the
 * `DELETE /portal-tokens/{id}` route went unscanned.
 */
const REGEX_BODY = String.raw`(?:[^/\\\n\[]|\\.|\[(?:[^\]\\]|\\.)*\])+`;

/** A path literal derived from a route regex literal, with captures made concrete. */
function probePathFromRegexSource(source) {
  return source
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\([^)]*\)/g, 'probe')
    .replace(/\\\//g, '/');
}

const scanned = [];
for (const file of SCANNED_FILES) {
  const code = strippedSource(readFileSync(join(cloudRoot, file), 'utf8'));
  const pairs = [];

  const methodFirst = new RegExp(
    String.raw`request\.method\s*===\s*'(${ANY_METHOD})'\s*&&\s*${PATH_EXPR}${COMPARE}'([^']*)'`,
    'g',
  );
  for (const [, method, path] of code.matchAll(methodFirst)) pairs.push({ method, path });

  const pathFirst = new RegExp(
    String.raw`${PATH_EXPR}${COMPARE}'([^']*)'\s*&&\s*request\.method\s*===\s*'(${ANY_METHOD})'`,
    'g',
  );
  for (const [, path, method] of code.matchAll(pathFirst)) pairs.push({ method, path });

  // The ternary form: `request.method === 'DELETE' ? /\/portal-tokens\/([^/]+)$/.exec(path)`.
  const regexRoute = new RegExp(
    String.raw`request\.method\s*===\s*'(${ANY_METHOD})'\s*\?\s*\/(${REGEX_BODY})\/[gimsuy]*\.exec\(`,
    'g',
  );
  for (const [, method, source] of code.matchAll(regexRoute)) {
    pairs.push({ method, path: probePathFromRegexSource(source) });
  }

  const pairedPaths = new Set(pairs.map(pair => pair.path));
  const branches = [];

  const literalBranch = new RegExp(String.raw`${PATH_EXPR}${COMPARE}'([^']*)'`, 'g');
  for (const [, path] of code.matchAll(literalBranch)) {
    if (!pairedPaths.has(path)) branches.push({ path, source: `'${path}'` });
  }

  const identifierBranch = new RegExp(String.raw`${PATH_EXPR}${COMPARE}([A-Za-z_$][\w$]*)`, 'g');
  for (const [, name] of code.matchAll(identifierBranch)) {
    branches.push({ path: PATH_CONSTANTS[name], source: name });
  }

  scanned.push({ file, pairs, branches });
}

/**
 * Every path branch the scan resolved, hoisted out of part 2's block so part 2b
 * can prove it is reading the same `api.ts` rather than asserting into the void.
 */
const foundBranchPaths = new Set();

console.log('\nStatic scan of the mutating routes (Requirement 6.9)');
{
  for (const { file, pairs } of scanned) {
    const mutating = pairs.filter(pair => isMutatingMethod(pair.method));
    // The vacuous-pass guard: no matches means the scanner stopped matching the
    // file, not that the file is clean.
    check(
      `${file}: the scanner still finds mutating routes`,
      mutating.length > 0,
      `${pairs.length} route literal(s) found in total`,
    );
    for (const { method, path } of mutating) {
      const key = `${method} ${path}`;
      const declared = requiredLevelFor(method, path);
      check(
        `${file}: ${key} is answered by the write-route table`,
        declared !== undefined || key in EXEMPT_WRITES,
        'add a WRITE_ROUTES entry for it, or exempt it by name with a reason in this suite',
      );
    }
  }

  const foundWrites = new Set(
    scanned.flatMap(({ pairs }) =>
      pairs.filter(pair => isMutatingMethod(pair.method)).map(pair => `${pair.method} ${pair.path}`),
    ),
  );
  for (const key of Object.keys(EXEMPT_WRITES)) {
    const [method, path] = key.split(' ');
    check(
      `the exemption for ${key} still describes a real route`,
      foundWrites.has(key),
      'prune it, so the exemption list keeps describing the real write surface',
    );
    check(
      `${key} is exempt rather than exempt AND in the table`,
      requiredLevelFor(method, path) === undefined,
      'a route cannot be both; one of the two declarations is wrong',
    );
    check(
      `the exemption for ${key} carries a reason`,
      EXEMPT_WRITES[key].length > 20,
    );
  }

  const foundBranches = foundBranchPaths;
  for (const { file, branches } of scanned) {
    for (const { path, source } of branches) {
      check(
        `${file}: the guard can resolve the route branch ${source}`,
        typeof path === 'string' && path.length > 0,
        'add its value to PATH_CONSTANTS, or the guard is passing on a branch it cannot read',
      );
      if (typeof path !== 'string') continue;
      foundBranches.add(path);
      const declared = ROUTE_BRANCHES[path];
      check(
        `${file}: the route branch ${source} is declared with a reason`,
        declared !== undefined && declared.reason.length > 20,
        'a path branch with no method beside it must say what it delegates and why',
      );
      for (const [method, level] of declared?.delegates ?? []) {
        check(
          `${file}: ${method} ${path} is delegated and answered at ${level}`,
          requiredLevelFor(method, path) === level,
          String(requiredLevelFor(method, path)),
        );
      }
    }
  }
  for (const path of Object.keys(ROUTE_BRANCHES)) {
    check(
      `the route-branch entry for ${path} still describes a real branch`,
      foundBranches.has(path),
      'prune it',
    );
  }
}

// ══ Part 2b: no organisation-facing member write exists ═════════════════════
//
// Requirement 13.7, as an INVENTORY assertion rather than a property. Membership
// is written through the Operator_Gate alone, so exactly one surface writes it -
// and the `member.manage` capability stays DECLARED in the Capability_Contract
// and exercised by no route at all, because a released token is never renamed or
// repurposed (Requirement 5.11).
//
// The claim has two halves, and both are needed:
//
//  1. no mutating route in the scanned files whose path reads like a membership
//     write sits OUTSIDE the operator prefix, and
//  2. `WRITE_ROUTES` - the Role_Gate's own inventory - declares no such entry at
//     any level, which is the half that would fail if somebody "finished" this
//     feature by adding an `admin`-level organisation-facing route.
//
// Part 2 above already proves the scanner still reads both files, so this cannot
// pass vacuously on a broken parser.
console.log('\nNo organisation-facing member write exists (Requirement 13.7)');
{
  const looksLikeMemberWrite = path => MEMBER_WRITE_TELLS.some(tell => tell.test(path));

  let scannedMemberWrites = 0;
  for (const { file, pairs } of scanned) {
    for (const { method, path } of pairs) {
      if (!isMutatingMethod(method) || !looksLikeMemberWrite(path)) continue;
      scannedMemberWrites += 1;
      check(
        `${file}: the member write ${method} ${path} sits behind the operator prefix`,
        path.startsWith(ORG_ADMIN_PREFIX),
        `Requirement 13.7 allows exactly one membership-writing surface, ${ORG_ADMIN_PREFIX}`,
      );
    }
  }
  // Not a vacuous-pass guard on the scanner - part 2 owns that - but a record that
  // the operator family is mounted through a PREFIX branch and therefore carries
  // no method-plus-path literal of its own. If a future change gives it one, this
  // count moves and the assertions above start firing, which is the intent.
  check(
    'the operator family is reached through a prefix branch, not a route literal',
    scannedMemberWrites === 0,
    `${scannedMemberWrites} member-write literal(s) found`,
  );
  check(
    `and that prefix branch is declared`,
    foundBranchPaths.has(ORG_ADMIN_PREFIX),
    'the scan never met the organisation prefix, so this assertion is not reading api.ts',
  );

  const declaredMemberWrites = WRITE_ROUTES.filter(route =>
    MEMBER_WRITE_TELLS.some(tell => tell.test(route.match.source)),
  );
  check(
    'WRITE_ROUTES declares no member-management write at any level',
    declaredMemberWrites.length === 0,
    declaredMemberWrites.map(route => `${route.method} ${route.match.source}`).join(', '),
  );
  check(
    'and no WRITE_ROUTES entry sits under the operator prefix at all',
    !WRITE_ROUTES.some(route => route.match.test(`${ORG_ADMIN_PREFIX}members`)),
    'an /api/admin/* route is gated by refuseNonOperator, never by the Role_Gate',
  );
  check(
    'member.manage is still declared in the capability contract',
    CAPABILITIES_BY_LEVEL.admin.includes('member.manage'),
    'a released token is never renamed or repurposed (Requirement 5.11)',
  );
  check(
    'and no level below admin holds it',
    ['operator', 'editor', 'builder'].every(
      level => !CAPABILITIES_BY_LEVEL[level].includes('member.manage'),
    ),
  );
}

// ══ Part 3: the runtime drive ═══════════════════════════════════════════════

/** One member per level, all in the same organisation. */
const MEMBERS = {
  operator: 'user_role_operator',
  editor: 'user_role_editor',
  builder: 'user_role_builder',
  admin: 'user_role_admin',
};
const ORG_ID = 'org_rolegate';
/** A member of the organisation with no row and no mapped claim: role_unknown. */
const STRANGER = 'user_role_stranger';
/** No organisation claim at all: the inert case every install is in today. */
const SOLO = 'user_role_solo';

const { publicKey: CLERK_JWT_KEY, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const base64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function mintToken(sub, claims = {}) {
  const seconds = Math.floor(Date.now() / 1000);
  const signing = `${base64url({ alg: 'RS256', typ: 'JWT', kid: 'phorma-role-gate-test' })}.${base64url(
    { sub, iat: seconds - 60, nbf: seconds - 60, exp: seconds + 3600, ...claims },
  )}`;
  const signature = createSign('RSA-SHA256').update(signing).sign(privateKey).toString('base64url');
  return `${signing}.${signature}`;
}

/** Every test token carries the organisation but NO role claim, so the level comes
 *  from `org_members` - the authoritative source a desktop credential also uses. */
const tokenFor = userId => mintToken(userId, { org_id: ORG_ID });

// -- Build the exact deploy bundle, then run it under Miniflare --------------

const wranglerBin = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url),
);
const bundleDir = mkdtempSync(join(tmpdir(), 'phorma-cloud-role-gate-'));
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
    modules: true,
    script,
    compatibilityDate: '2025-05-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: {
      WorkflowAgent: { className: 'WorkflowAgent', useSQLite: true },
      PortalIndex: { className: 'PortalIndex', useSQLite: true },
      SecretVault: { className: 'SecretVault', useSQLite: true },
    },
    d1Databases: { DB: 'phorma-cloud-role-gate' },
    bindings: {
      PHORMA_MODE: 'hosted',
      CLERK_SECRET_KEY: 'sk_test_clerk_not_used_offline',
      CLERK_JWT_KEY,
      // The vault route needs both of these to reach its method dispatch at all,
      // and reaching the dispatch is the whole point of driving it.
      KEY_ENC_SECRET: Buffer.alloc(32, 11).toString('base64'),
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

  const now = new Date().toISOString();
  await DB.batch([
    DB.prepare('DELETE FROM org_members'),
    ...Object.entries(MEMBERS).map(([level, userId]) =>
      DB.prepare(
        `INSERT OR REPLACE INTO org_members (org_id, user_id, level, invited_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(ORG_ID, userId, level, 'user_role_seed', now, now),
    ),
  ]);

  const AGENT = '/agents/workflow-agent/wf-role-gate';
  const spec = {
    version: 1,
    id: 'wf-role-gate',
    name: 'Role gate probe',
    savedAt: now,
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
      edges: [],
    },
  };

  /**
   * Every `WRITE_ROUTES` entry, as a concrete request.
   *
   * Kept as a flat list rather than derived from the table, because a probe
   * derived from the thing under test proves nothing. The two are cross-checked
   * below in both directions: every probe must resolve to the level it claims,
   * and every table entry must be reached by at least one probe - so a new entry
   * with no probe FAILS rather than going undriven. Adding a route later is one
   * table entry plus one line here.
   */
  const PROBES = [
    { method: 'POST', path: `${AGENT}/workflow`, required: 'builder', body: spec },
    { method: 'DELETE', path: `${AGENT}/workflow`, required: 'builder' },
    { method: 'DELETE', path: `${AGENT}/workflow/purge`, required: 'builder' },
    { method: 'POST', path: `${AGENT}/connections`, required: 'builder', body: { connections: [] } },
    { method: 'POST', path: `${AGENT}/publish`, required: 'builder', body: {} },
    { method: 'POST', path: `${AGENT}/unpublish`, required: 'builder', body: {} },
    { method: 'POST', path: `${AGENT}/portal-tokens`, required: 'builder', body: { label: 'p' } },
    { method: 'DELETE', path: `${AGENT}/portal-tokens/pk-probe`, required: 'builder' },
    { method: 'POST', path: `${AGENT}/trigger`, required: 'operator', body: { input: 'hello' } },
    {
      method: 'POST',
      path: `${AGENT}/events`,
      required: 'operator',
      body: { correlationKey: 'probe', payload: 'x' },
    },
    {
      method: 'POST',
      path: `${AGENT}/approvals`,
      required: 'operator',
      body: { requestId: 'probe', approved: true },
    },
    {
      method: 'POST',
      path: `${AGENT}/questions`,
      required: 'operator',
      body: { requestId: 'probe', response: 'x' },
    },
    {
      method: 'POST',
      path: '/api/connection-secrets',
      required: 'editor',
      body: { connectionId: 'conn-role-gate', secretKey: 'apiKey', value: 'probe-value' },
    },
    {
      method: 'DELETE',
      path: '/api/connection-secrets?connectionId=conn-role-gate&secretKey=apiKey',
      required: 'editor',
      matchPath: '/api/connection-secrets',
    },
    { method: 'POST', path: '/api/infer', required: 'operator', body: { model: 'x', messages: [] } },
    // The ownership claim route (task 2). Nothing is deployed under this workflow
    // id, so an admitted caller reaches `claim_unowned` rather than a capability
    // refusal - which is exactly what this drive needs to tell apart. The claim path
    // itself is driven end to end in `ownership-claim.test.mjs`.
    { method: 'POST', path: '/api/deployments/wf-role-gate-claim/claim', required: 'builder', body: {} },
    // The three proposal routes (task 10). This worker binds no R2, so an
    // admitted caller reaches the 501 binding refusal rather than a capability
    // one - which is exactly what this drive needs to tell apart, and it is why
    // the Role_Gate runs BEFORE that binding check in `proposal-routes.ts`. The
    // proposal paths themselves are driven end to end in `proposals.test.mjs`.
    {
      method: 'POST',
      path: '/api/proposals/wf-role-gate',
      required: 'editor',
      body: { spec: { version: 1, id: 'wf-role-gate', name: 'p', graph: { nodes: [] } }, connections: [] },
    },
    {
      method: 'POST',
      path: '/api/proposals/wf-role-gate/prop-role-gate-probe/publish',
      required: 'builder',
      body: { revision: 1 },
    },
    {
      method: 'POST',
      path: '/api/proposals/wf-role-gate/prop-role-gate-probe/reject',
      required: 'builder',
      body: { revision: 1 },
    },
    // The two billing routes carry a condition the LEVEL does not express: `admin`
    // AND a personal owner (multi-organisation-phorma, task 15, Requirement 19.4).
    // Every credential in this suite names an organisation, so all four levels -
    // including `admin`, which passes the level comparison - are refused
    // `billing_managed` ABOVE the gate. `beforeGate` says so, and the matrix below
    // asserts it PER LEVEL rather than skipping them: "the level is not what refuses
    // an organisation admin" is the claim, and an implementation that put this
    // refusal inside `requireCapability` would answer `role_forbidden` for the three
    // lower levels and let `admin` through to Stripe.
    {
      method: 'POST',
      path: '/api/checkout',
      required: 'admin',
      body: { lookupKey: 'probe' },
      beforeGate: 'billing_managed',
    },
    {
      method: 'POST',
      path: '/api/billing-portal',
      required: 'admin',
      body: {},
      beforeGate: 'billing_managed',
    },
  ];

  async function drive(probe, token) {
    const response = await mf.dispatchFetch(`http://localhost${probe.path}`, {
      method: probe.method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(probe.body === undefined ? {} : { body: JSON.stringify(probe.body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  const probePath = probe => probe.matchPath ?? probe.path;

  const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

  /**
   * Records everything a monitor socket says.
   *
   * Listeners are attached BEFORE `accept()`, because workerd buffers socket
   * events until the socket is accepted and then delivers them at once - a
   * listener attached afterwards races frames the worker has already sent.
   *
   * There is deliberately no assertion on the CLOSE code anywhere in this suite.
   * Measured against the real deploy bundle, a `connection.close(4001)` issued
   * from inside `onConnect` is not delivered: the client socket stays at
   * `readyState === 1` and goes on to have its frames served. That is a
   * pre-existing property of the shipped worker (the `!auth` refusal has the same
   * shape), and it is exactly why the enforcement is the frame-level guard in
   * `onMessage` rather than the close. Asserting the close code would have
   * asserted a refusal that does not happen.
   */
  function watchMonitor(socket) {
    const messages = [];
    socket.addEventListener('message', event => messages.push(String(event.data ?? '')));
    socket.accept();
    return { messages, saw: needle => messages.some(message => message.includes(needle)) };
  }

  // -- The probes and the table agree, in both directions --------------------
  console.log('\nEvery write route in the table is driven by a probe');
  {
    const reached = new Set();
    for (const probe of PROBES) {
      const entry = matchWriteRoute(probe.method, probePath(probe));
      check(
        `${probe.method} ${probePath(probe)} resolves to ${probe.required}`,
        entry?.required === probe.required,
        String(entry?.required),
      );
      if (entry) reached.add(entry);
    }
    for (const route of WRITE_ROUTES) {
      check(
        `the table entry ${route.method} ${route.match.source} is driven`,
        reached.has(route),
        'add a probe for it, or the entry is declared and never checked',
      );
    }
  }

  // -- Property 14: the full level-by-route matrix ---------------------------
  //
  // Feature: multi-organisation-phorma, Property 14: Every write route is
  // covered by the Role_Gate, and the answer is exactly the level comparison.
  //
  // Driven as the whole cross product rather than as "operator, then the declared
  // level", because an implementation that gated only the levels it was asked
  // about would pass the narrower version. The two cases the task names are
  // asserted by name underneath.
  console.log('\nEvery level against every write route (Requirements 6.4 to 6.8)');
  for (const level of CAPABILITY_LEVELS) {
    const token = tokenFor(MEMBERS[level]);
    for (const probe of PROBES) {
      const allowed = atLeast(level, probe.required);
      const { status, body } = await drive(probe, token);
      const label = `${level} -> ${probe.method} ${probePath(probe)}`;
      if (probe.beforeGate) {
        // Refused above the gate, for a reason the level cannot express. Asserted
        // as the SAME answer at every level, which is what distinguishes a refusal
        // about who is PAYING from one about what the caller may do.
        check(
          `${label} is 403 ${probe.beforeGate}, whatever the level`,
          status === 403 && body?.code === probe.beforeGate,
          `${status} ${JSON.stringify(body).slice(0, 160)}`,
        );
        check(
          `${label} is NOT a role refusal`,
          body?.code !== 'role_forbidden' && body?.code !== 'role_unknown',
          `${status} ${JSON.stringify(body).slice(0, 160)}`,
        );
        continue;
      }
      if (allowed) {
        check(
          `${label} is NOT refused on capability`,
          status !== 403 && body?.code !== 'role_forbidden',
          `${status} ${JSON.stringify(body).slice(0, 160)}`,
        );
      } else {
        check(
          `${label} is 403 role_forbidden naming ${probe.required}`,
          status === 403 && body?.code === 'role_forbidden' && body?.required === probe.required,
          `${status} ${JSON.stringify(body).slice(0, 160)}`,
        );
      }
    }
  }

  console.log('\nThe three routes the task names explicitly');
  {
    const operator = tokenFor(MEMBERS.operator);
    const builder = tokenFor(MEMBERS.builder);
    const editor = tokenFor(MEMBERS.editor);

    const push = await drive(PROBES[0], operator);
    check(
      'POST /workflow refuses an operator and names builder',
      push.status === 403 && push.body?.required === 'builder',
      JSON.stringify(push.body),
    );
    const pushed = await drive(PROBES[0], builder);
    check('POST /workflow accepts a builder', pushed.status === 200, JSON.stringify(pushed.body));

    const remove = await drive(PROBES[1], operator);
    check(
      'DELETE /workflow refuses an operator and names builder',
      remove.status === 403 && remove.body?.required === 'builder',
      JSON.stringify(remove.body),
    );
    const removed = await drive(PROBES[1], builder);
    check('DELETE /workflow accepts a builder', removed.status === 200, JSON.stringify(removed.body));

    const secret = await drive(PROBES[12], operator);
    check(
      'POST /api/connection-secrets refuses an operator and names editor',
      secret.status === 403 && secret.body?.required === 'editor',
      JSON.stringify(secret.body),
    );
    const stored = await drive(PROBES[12], editor);
    check(
      'POST /api/connection-secrets accepts an editor',
      stored.status === 200 && typeof stored.body?.name === 'string',
      JSON.stringify(stored.body),
    );
  }

  // -- Reads stay open to every level (Requirement 6.3) ---------------------
  console.log('\nReads and the monitor are open to an operator (Requirement 6.3)');
  {
    const operator = tokenFor(MEMBERS.operator);
    const read = async path => {
      const response = await mf.dispatchFetch(`http://localhost${path}`, {
        headers: { Authorization: `Bearer ${operator}` },
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };

    for (const path of [
      `${AGENT}/status`,
      `${AGENT}/runs`,
      `${AGENT}/usage`,
      `${AGENT}/connections`,
      `${AGENT}/portal`,
      `${AGENT}/portal-runs`,
      '/api/me',
      '/api/deployments',
      '/api/notifications',
      '/api/connection-secrets',
    ]) {
      const { status, body } = await read(path);
      check(
        `GET ${path} answers 200 for an operator`,
        status === 200,
        `${status} ${JSON.stringify(body).slice(0, 160)}`,
      );
    }

    // `GET /workflow` on an instance with nothing deployed is a 404 about the
    // deployment, never a capability refusal. Asserted rather than skipped,
    // because "not 200" is exactly where a wrongly gated read would hide.
    const spec404 = await read(`${AGENT}/workflow`);
    check(
      'GET /workflow on an empty instance is 404 about the deployment, not a refusal',
      spec404.status === 404 && spec404.body?.hasWorkflow === false,
      `${spec404.status} ${JSON.stringify(spec404.body)}`,
    );

    // The monitor socket. It accepts write control frames, so the gate applies at
    // connect - and an operator holds every one of those frames.
    const monitor = await mf.dispatchFetch(`http://localhost${AGENT}?token=${operator}`, {
      headers: { Upgrade: 'websocket' },
    });
    check('the monitor upgrade is answered 101', monitor.status === 101, String(monitor.status));
    check('and carries the webSocket handle', Boolean(monitor.webSocket));
    if (monitor.webSocket) {
      const probe = watchMonitor(monitor.webSocket);
      await settle(500);
      check(
        'an admitted monitor receives the sync sentinel',
        probe.saw('monitor-synced'),
        probe.messages.join(' | ').slice(0, 200),
      );
      try {
        monitor.webSocket.close();
      } catch {
        // Already closed by the worker; nothing to do.
      }
    }
  }

  // -- /api/me reports the resolved owner and level (Requirement 7.6) --------
  //
  // The studio never resolves a level for itself: `CapabilityService` is a DI leaf
  // and is PUSHED whatever this route reports. So these two fields are the whole
  // wire half of the studio capability seam, and three claims about them are worth
  // driving through the real route rather than reading off `resolveRole`:
  //
  //  - The level reported is the level `org_members` holds, for EVERY level. One
  //    sampled token would pass for a route that reported a constant.
  //  - The route stays a READ. An unresolvable role must NOT 403 here (Requirement
  //    6.3): a profile poll is how the studio learns its plan and its credits, and
  //    the write gate is where `role_unknown` belongs. The field is omitted, which
  //    is the same shape an older worker sends, so the studio has one case to
  //    handle rather than two.
  //  - ADDITIVE means additive. For a credential with no organisation claim, the
  //    body with these two fields removed must equal what this route answered
  //    before they existed - field for field, in the same order.
  console.log('\n/api/me reports the resolved owner and level, additively (Requirement 7.6)');
  {
    const me = async token => {
      const response = await mf.dispatchFetch('http://localhost/api/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };

    for (const [level, userId] of Object.entries(MEMBERS)) {
      const { status, body } = await me(tokenFor(userId));
      check(`a ${level} member reads /api/me 200`, status === 200, String(status));
      check(`and the level reported is ${level}`, body?.level === level, JSON.stringify(body));
      check(
        `and the owner reported is the organisation, not the member`,
        body?.ownerId === ORG_ID,
        JSON.stringify(body),
      );
      // `id` keeps its old MEANING - "the `tenants` primary key this answer is
      // about" - and task 3 made that the resolved owner, because the tier, status
      // and quota block beside it are the ORGANISATION's (Requirements 4.9, 19.6).
      // An `id` naming the member would label an organisation's credits with a
      // personal account, and for a credential with no organisation claim it is the
      // userId exactly as before (asserted on the solo branch below). `ownerId` is
      // still a field of its own because it answers even when there is no tenant
      // row, and because the studio reads it by name.
      check(
        `while id names the tenant row this answer is about (${level})`,
        body?.id === ORG_ID && body?.id === body?.ownerId,
        JSON.stringify(body),
      );
      check(
        `and the member's own account id is nowhere in the payload (${level})`,
        !JSON.stringify(body).includes(userId),
        JSON.stringify(body),
      );
      check(
        `and the reported level is a declared token (${level})`,
        CAPABILITY_LEVELS.includes(body?.level),
        JSON.stringify(body),
      );
    }

    const solo = await me(mintToken(SOLO));
    check('a credential with no organisation claim reads 200', solo.status === 200, String(solo.status));
    check(
      'and resolves its own account as the owner',
      solo.body?.ownerId === SOLO,
      JSON.stringify(solo.body),
    );
    check(
      'at admin, the same level the gate resolves for it',
      solo.body?.level === 'admin',
      JSON.stringify(solo.body),
    );
    // THREE additive fields are lifted out, not two. `owners` (Requirement 20.1)
    // is the third, and it is present on both `/api/me` branches for every caller
    // including a solo one, where it is `[]` - which is deliberate and is pinned by
    // `owner-switching.test.mjs`: an empty list says "this worker answers about
    // memberships and you hold none", where an absent field is what an OLDER worker
    // sends. The claim here is unchanged and is the one that matters for a solo
    // install - no PRE-EXISTING field moved - so a new additive field joins this
    // destructure rather than weakening the comparison.
    const {
      ownerId: _soloOwner,
      level: _soloLevel,
      owners: _soloOwners,
      ...legacy
    } = solo.body ?? {};
    check(
      'and every pre-existing field is byte-identical to the pre-feature answer',
      JSON.stringify(legacy) ===
        JSON.stringify({ id: SOLO, provisioned: false, tier: null, status: null, quota: null }),
      JSON.stringify(legacy),
    );
    // And the third field IS there, so the destructure above cannot silently start
    // hiding a field that stopped being sent.
    check(
      'while the additive owners list is present and empty for a solo account',
      Array.isArray(solo.body?.owners) && solo.body.owners.length === 0,
      JSON.stringify(solo.body?.owners),
    );

    const stranger = await me(tokenFor(STRANGER));
    check(
      'a caller whose level cannot be resolved is still answered 200, because a read never refuses',
      stranger.status === 200,
      `${stranger.status} ${JSON.stringify(stranger.body)}`,
    );
    check(
      'with the level field OMITTED rather than substituted',
      stranger.body !== null && !('level' in stranger.body),
      JSON.stringify(stranger.body),
    );
    check(
      'and no role_unknown refusal on a read',
      stranger.body?.code === undefined,
      JSON.stringify(stranger.body),
    );
    check(
      'the resolved owner is still reported',
      stranger.body?.ownerId === ORG_ID,
      JSON.stringify(stranger.body),
    );
  }

  // -- An unresolvable role fails closed, and writes nothing ----------------
  //
  // Feature: multi-organisation-phorma, Property 13: An unresolvable role fails
  // closed and writes nothing.
  console.log('\nAn organisation claim with no membership row (Requirement 5.9)');
  {
    const builder = tokenFor(MEMBERS.builder);
    const stranger = tokenFor(STRANGER);

    // A known-good state to compare against, on the STRANGER's own instance, so
    // "nothing was written" is a claim about the instance the refusal addressed.
    const strangerAgent = '/agents/workflow-agent/wf-role-gate-stranger';
    const beforePush = await mf.dispatchFetch(`http://localhost${strangerAgent}/status`, {
      headers: { Authorization: `Bearer ${stranger}` },
    });
    check(
      'even a READ is refused when the role cannot be resolved',
      beforePush.status === 403,
      String(beforePush.status),
    );
    const beforeBody = await beforePush.json().catch(() => null);
    check(
      'with code role_unknown',
      beforeBody?.code === 'role_unknown',
      JSON.stringify(beforeBody),
    );

    const write = await drive(
      { method: 'POST', path: `${strangerAgent}/workflow`, body: spec },
      stranger,
    );
    check(
      'a write is refused role_unknown, not role_forbidden',
      write.status === 403 && write.body?.code === 'role_unknown',
      JSON.stringify(write.body),
    );

    // Nothing was written: the deployment registry still lists nothing for the
    // stranger's workflow id, read through a caller whose role DOES resolve.
    const listed = await mf.dispatchFetch('http://localhost/api/deployments', {
      headers: { Authorization: `Bearer ${builder}` },
    });
    const deployments = (await listed.json().catch(() => ({}))).deployments ?? [];
    check(
      'and the refused push registered no deployment',
      !deployments.some(entry => entry.workflowId === 'wf-role-gate-stranger'),
      JSON.stringify(deployments).slice(0, 200),
    );

    const socket = await mf.dispatchFetch(`http://localhost${strangerAgent}?token=${stranger}`, {
      headers: { Upgrade: 'websocket' },
    });
    if (socket.webSocket) {
      const probe = watchMonitor(socket.webSocket);
      await settle(500);
      check(
        'a monitor whose role cannot be resolved is never synced',
        !probe.saw('monitor-synced'),
        probe.messages.join(' | ').slice(0, 200),
      );
    } else {
      check('the monitor upgrade returned a socket to observe', false, String(socket.status));
    }
  }

  // -- The runtime fail-closed backstop ------------------------------------
  console.log('\nA mutating path the table does not answer (Requirement 6.9)');
  {
    const admin = tokenFor(MEMBERS.admin);
    const unguarded = await drive(
      { method: 'POST', path: `${AGENT}/not-a-declared-write`, body: {} },
      admin,
    );
    check(
      'a mutating request the table does not answer is refused, not passed through',
      unguarded.status === 403 && unguarded.body?.code === 'role_forbidden',
      `${unguarded.status} ${JSON.stringify(unguarded.body)}`,
    );
    check(
      `and it names the fail-closed level ${ROLE_GATE_FALLBACK_LEVEL}`,
      unguarded.body?.required === ROLE_GATE_FALLBACK_LEVEL,
      JSON.stringify(unguarded.body),
    );
    // A READ of an unknown path is still an honest 404: the backstop is about
    // writes, and turning every stray GET into a refusal would be a new answer to
    // an old question.
    const strayRead = await mf.dispatchFetch(`http://localhost${AGENT}/not-a-route`, {
      headers: { Authorization: `Bearer ${admin}` },
    });
    check('a stray READ is still 404', strayRead.status === 404, String(strayRead.status));
  }

  // -- Inertness: an install with no organisation is unchanged --------------
  //
  // Feature: multi-organisation-phorma, Property 37: Bring-your-own behaviour is
  // unchanged.
  //
  // PROVEN rather than asserted: the same probe list is driven by a credential
  // carrying NO organisation claim, and every single write is admitted. That is
  // the whole compatibility claim of Phases 0 and 1 in one loop.
  console.log('\nA credential with no organisation claim is admitted everywhere (Requirement 5.10)');
  {
    const solo = mintToken(SOLO);
    for (const probe of PROBES) {
      const { status, body } = await drive(probe, solo);
      check(
        `no-organisation credential -> ${probe.method} ${probePath(probe)} is not refused`,
        status !== 403 && body?.code !== 'role_forbidden' && body?.code !== 'role_unknown',
        `${status} ${JSON.stringify(body).slice(0, 160)}`,
      );
    }
    const unauthenticated = await mf.dispatchFetch(`http://localhost${AGENT}/status`);
    check(
      'and an unauthenticated request is still 401, not a capability refusal',
      unauthenticated.status === 401,
      String(unauthenticated.status),
    );
  }

  // -- The monitor socket is a write path, and it is gated per frame ---------
  //
  // This block exists because of a defect found while writing it: a
  // `connection.close(4001)` issued from `onConnect` is NOT delivered. The socket
  // stays open at `readyState === 1`, and `onMessage` performed no authorization
  // of its own - so a monitor that failed verification kept a channel that serves
  // `trigger`, `approval`, `question`, `event` and `stop`. That predates this
  // feature (the shipped `!auth` refusal has the same shape) and it is the reason
  // the level is recorded ON the connection and re-checked per frame.
  //
  // A SECOND worker, in BYO shape, because the property needs a socket pointed at
  // an instance that already holds a spec: the hosted gateway rewrites every
  // instance name to the CALLER's own prefix, so a refused caller can only ever
  // reach their own empty instance there and "no run started" would be true for
  // the wrong reason.
  console.log('\nA monitor socket cannot write without having been admitted (Requirement 6.2)');
  {
    const byo = withLoopbackRetry(
      new Miniflare({
        modules: true,
        script,
        compatibilityDate: '2025-05-01',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: {
          WorkflowAgent: { className: 'WorkflowAgent', useSQLite: true },
          PortalIndex: { className: 'PortalIndex', useSQLite: true },
          SecretVault: { className: 'SecretVault', useSQLite: true },
        },
        bindings: { PHORMA_TOKEN: 'role-gate-right-token' },
      }),
    );
    try {
      const instance = '/agents/workflow-agent/wf-role-gate-socket';
      const right = 'role-gate-right-token';
      const wrong = 'role-gate-wrong-token';
      const statusOf = async () => {
        const response = await byo.dispatchFetch(`http://localhost${instance}/status`, {
          headers: { Authorization: `Bearer ${right}` },
        });
        return response.json();
      };

      const pushed = await byo.dispatchFetch(`http://localhost${instance}/workflow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${right}` },
        body: JSON.stringify(spec),
      });
      check('the spec deploys on the BYO instance', pushed.status === 200, String(pushed.status));
      const unauthorized = await byo.dispatchFetch(`http://localhost${instance}/status`, {
        headers: { Authorization: `Bearer ${wrong}` },
      });
      check('and the wrong token is genuinely wrong over HTTP', unauthorized.status === 401);
      check('nothing has run yet', (await statusOf()).lastRunId === null);

      // The refused socket. It still gets a 101 - that much is the SDK - so the
      // claim under test is only about what its FRAMES can do.
      const refused = await byo.dispatchFetch(`http://localhost${instance}?token=${wrong}`, {
        headers: { Upgrade: 'websocket' },
      });
      check('a socket opened with the wrong token still upgrades', refused.status === 101);
      if (refused.webSocket) {
        watchMonitor(refused.webSocket);
        refused.webSocket.send(JSON.stringify({ type: 'trigger', input: 'from a refused socket' }));
        await settle(1200);
        const after = await statusOf();
        check(
          'but its trigger frame starts NO run',
          after.lastRunId === null && after.running === false,
          JSON.stringify(after).slice(0, 200),
        );
      } else {
        check('the refused upgrade returned a socket to drive', false, String(refused.status));
      }

      // The positive control, so the assertion above cannot pass because nothing
      // works: the SAME frame on an ADMITTED socket does start a run.
      const admitted = await byo.dispatchFetch(`http://localhost${instance}?token=${right}`, {
        headers: { Upgrade: 'websocket' },
      });
      check('an admitted socket upgrades', admitted.status === 101);
      if (admitted.webSocket) {
        watchMonitor(admitted.webSocket);
        admitted.webSocket.send(JSON.stringify({ type: 'trigger', input: 'from an admitted socket' }));
        await settle(2000);
        const after = await statusOf();
        check(
          'and the same frame on an admitted socket DOES start a run',
          typeof after.lastRunId === 'string' && after.lastRunId.length > 0,
          JSON.stringify(after).slice(0, 200),
        );
      } else {
        check('the admitted upgrade returned a socket to drive', false, String(admitted.status));
      }
    } finally {
      await byo.dispose();
    }
  }
} finally {
  await mf.dispose();
}

console.log(failures === 0 ? '\nAll role-gate checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
