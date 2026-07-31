/**
 * WorkerConnectionStore — the worker's credential boundary (task 18.2,
 * Requirements 2.4-2.7, 2.11, 2.12, 3.5, 3.6, 3.7, 3.10, 3.11).
 *
 * No worker, no network: the env is a read-counting proxy, the token endpoint is
 * a stub, and the token cache is an in-memory `WorkflowStateStore`. That is
 * enough to pin the properties that matter — an undelivered connection reads no
 * environment variable, a missing secret never yields a partial bundle, a cached
 * token with 30+ seconds left causes no grant request, and concurrent
 * resolutions share one refresh.
 *
 * Run: npx -y tsx cloud/test/connections.test.mjs
 */

import {
  OAUTH_MIN_REMAINING_MS,
  WorkerConnectionStore,
  connectionMetadataFromPush,
} from '../src/connections.ts';

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

/** Minimal in-memory `WorkflowStateStore`, recording the options of each write. */
function memoryState() {
  const entries = new Map();
  const writes = [];
  return {
    entries,
    writes,
    async get(key) {
      return entries.get(key);
    },
    async set(key, value, options) {
      writes.push({ key, value, options });
      entries.set(key, { key, value, updatedAt: 0 });
    },
    async delete(key) {
      entries.delete(key);
    },
    async list() {
      return [...entries.values()];
    },
    async compareAndSet(key, expected, value) {
      const current = entries.get(key)?.value;
      if (current !== expected) return false;
      entries.set(key, { key, value, updatedAt: 0 });
      return true;
    },
  };
}

/** Env that records every property read, so "read no secret" is checkable. */
function spyEnv(values) {
  const reads = [];
  const proxy = new Proxy(
    { ...values },
    {
      get(target, prop) {
        if (typeof prop === 'string') reads.push(prop);
        return target[prop];
      },
    },
  );
  return { env: proxy, reads };
}

const NOW = 1_700_000_000_000;

const httpConnection = {
  id: 'conn-crm',
  name: 'CRM',
  type: 'http',
  config: { baseUrl: 'https://api.example.com' },
  secretKeys: ['token', 'tenant'],
  auth: { mode: 'bearer', secretKey: 'token' },
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const oauthConnection = {
  id: 'conn-books',
  name: 'Books',
  type: 'oauth2',
  config: {},
  secretKeys: ['clientId', 'clientSecret'],
  auth: {
    mode: 'oauth2-client-credentials',
    tokenUrl: 'https://id.example.com/token',
    clientIdSecretKey: 'clientId',
    clientSecretKey: 'clientSecret',
    scope: 'read',
  },
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

function metadataOf(...connections) {
  return new Map(connections.map(connection => [connection.id, connection]));
}

async function rejection(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

console.log('\nWorkerConnectionStore');

// ── Requirement 2.11: malformed id, no secret read ──────────────────────────
{
  const { env, reads } = spyEnv({ CONN_CONN_CRM_TOKEN: 'live-token' });
  const store = new WorkerConnectionStore(env, metadataOf(httpConnection), memoryState(), { now: () => NOW });
  const message = await rejection(store.resolve('not-a-connection'));
  check('rejects a malformed connection id', message?.includes('not-a-connection') === true, message);
  check('reads no env variable for a malformed id', reads.length === 0, reads.join(','));
}

// ── Requirements 2.4, 3.11: undelivered metadata, no env read ───────────────
{
  const { env, reads } = spyEnv({ CONN_CONN_OTHER_TOKEN: 'live-token' });
  const store = new WorkerConnectionStore(env, metadataOf(httpConnection), memoryState(), { now: () => NOW });
  const message = await rejection(store.resolve('conn-other'));
  check('rejects an undelivered connection by name', message?.includes('conn-other') === true, message);
  check('reads no env variable for an undelivered connection', reads.length === 0, reads.join(','));
}

// ── Requirements 2.3, 2.5, 3.5: complete-or-reject bundle ───────────────────
{
  const { env } = spyEnv({ CONN_CONN_CRM_TOKEN: 'live-token' });
  const store = new WorkerConnectionStore(env, metadataOf(httpConnection), memoryState(), { now: () => NOW });
  const message = await rejection(store.resolve('conn-crm'));
  check(
    'rejects naming the connection, the missing key and the env name',
    message?.includes('CRM') === true &&
      message.includes('tenant') === true &&
      message.includes('CONN_CONN_CRM_TENANT') === true,
    message,
  );
}

{
  const { env } = spyEnv({ CONN_CONN_CRM_TOKEN: 'live-token', CONN_CONN_CRM_TENANT: 'acme' });
  const store = new WorkerConnectionStore(env, metadataOf(httpConnection), memoryState(), { now: () => NOW });
  const resolved = await store.resolve('conn-crm');
  check(
    'resolves every declared secret from CONN_* env names',
    resolved.secrets.token === 'live-token' && resolved.secrets.tenant === 'acme',
    JSON.stringify(Object.keys(resolved.secrets)),
  );
  check('treats an absent allowWrites as false', resolved.allowWrites === false);
  check(
    'freezes secrets and config',
    Object.isFrozen(resolved.secrets) && Object.isFrozen(resolved.config),
  );
}

// ── Requirement 3.10: a fresh cached token means no grant request ───────────
{
  const state = memoryState();
  state.entries.set('wf-1::oauth:conn-books', {
    key: 'wf-1::oauth:conn-books',
    value: JSON.stringify({ token: 'cached-token', expiresAt: NOW + 60_000 }),
    updatedAt: NOW,
  });
  let calls = 0;
  const { env } = spyEnv({ CONN_CONN_BOOKS_CLIENTID: 'id', CONN_CONN_BOOKS_CLIENTSECRET: 'shh' });
  const store = new WorkerConnectionStore(env, metadataOf(oauthConnection), state, {
    workflowId: 'wf-1',
    now: () => NOW,
    fetchImpl: async () => {
      calls += 1;
      throw new Error('the cached token should have been served');
    },
  });
  const resolved = await store.resolve('conn-books');
  check('serves a cached token with 30+ seconds left', resolved.secrets.accessToken === 'cached-token');
  check('requests no new token while the cache is fresh', calls === 0, String(calls));
}

// ── Requirements 2.7, 3.7: refresh, cache with no expiry, single flight ─────
{
  const state = memoryState();
  state.entries.set('wf-1::oauth:conn-books', {
    key: 'wf-1::oauth:conn-books',
    // 10 seconds left: under the 30-second floor, so it must be refreshed.
    value: JSON.stringify({ token: 'stale-token', expiresAt: NOW + 10_000 }),
    updatedAt: NOW,
  });
  let calls = 0;
  let sentBody = '';
  let sentAuth = '';
  const { env } = spyEnv({ CONN_CONN_BOOKS_CLIENTID: 'id', CONN_CONN_BOOKS_CLIENTSECRET: 'shh' });
  const store = new WorkerConnectionStore(env, metadataOf(oauthConnection), state, {
    workflowId: 'wf-1',
    now: () => NOW,
    fetchImpl: async (url, init) => {
      calls += 1;
      sentBody = String(init.body);
      sentAuth = init.headers.Authorization;
      return new Response(JSON.stringify({ access_token: 'fresh-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const [first, second] = await Promise.all([store.resolve('conn-books'), store.resolve('conn-books')]);
  check('refreshes a token under the 30-second floor', first.secrets.accessToken === 'fresh-token');
  check('shares one refresh across concurrent resolutions', calls === 1, String(calls));
  check('both concurrent resolutions see the same token', second.secrets.accessToken === 'fresh-token');
  check(
    'sends the client-credentials grant with the scope',
    sentBody.includes('grant_type=client_credentials') && sentBody.includes('scope=read'),
    sentBody,
  );
  check(
    'sends client credentials in the Authorization header, not the body',
    sentAuth === `Basic ${btoa('id:shh')}` && !sentBody.includes('shh'),
    sentAuth,
  );

  const write = state.writes.at(-1);
  check(
    'caches the refreshed token under oauth:{connectionId}',
    write?.key === 'wf-1::oauth:conn-books' && JSON.parse(write.value).token === 'fresh-token',
    JSON.stringify(write),
  );
  check(
    'applies no expiry to the cache entry',
    write?.options === undefined || write.options.ttlSec === undefined,
    JSON.stringify(write?.options),
  );
}

// ── Requirement 2.12: a too-short-lived grant is a rejection ────────────────
{
  const { env } = spyEnv({ CONN_CONN_BOOKS_CLIENTID: 'id', CONN_CONN_BOOKS_CLIENTSECRET: 'shh' });
  const state = memoryState();
  const store = new WorkerConnectionStore(env, metadataOf(oauthConnection), state, {
    workflowId: 'wf-1',
    now: () => NOW,
    fetchImpl: async () =>
      new Response(JSON.stringify({ access_token: 'blink', expires_in: OAUTH_MIN_REMAINING_MS / 1000 - 5 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });
  const message = await rejection(store.resolve('conn-books'));
  check(
    'rejects a token with under 30 seconds of validity, naming the mode',
    message?.includes('oauth2-client-credentials') === true && message.includes('Books') === true,
    message,
  );
  check('caches nothing for a rejected grant', state.writes.length === 0, String(state.writes.length));
}

// ── Requirement 2.12: a failing token endpoint leaks no secret ──────────────
{
  const { env } = spyEnv({ CONN_CONN_BOOKS_CLIENTID: 'id', CONN_CONN_BOOKS_CLIENTSECRET: 'shh' });
  const store = new WorkerConnectionStore(env, metadataOf(oauthConnection), memoryState(), {
    workflowId: 'wf-1',
    now: () => NOW,
    fetchImpl: async () => new Response('invalid_client: shh', { status: 401 }),
  });
  const message = await rejection(store.resolve('conn-books'));
  check(
    'reports the token endpoint status without its body',
    message?.includes('401') === true && !message.includes('shh'),
    message,
  );
}

// ── Requirement 2.9: the non-secret summary counts present secrets ──────────
{
  const { env } = spyEnv({ CONN_CONN_CRM_TOKEN: 'live-token' });
  const store = new WorkerConnectionStore(env, metadataOf(httpConnection, oauthConnection), memoryState(), {
    now: () => NOW,
  });
  const summaries = await store.list();
  const crm = summaries.find(entry => entry.id === 'conn-crm');
  check('counts only the secrets actually present', crm?.secretsPresent === 1, JSON.stringify(crm));
  check(
    'the summary carries no secret value',
    !JSON.stringify(summaries).includes('live-token'),
    JSON.stringify(summaries),
  );
}

// ── Requirement 3.6: push metadata keeps names, never values ────────────────
{
  const metadata = connectionMetadataFromPush({
    connections: [
      { ...httpConnection, secrets: { token: 'pushed-secret' }, allowWrites: true },
      { id: 'nope', name: 'bad id', type: 'http', auth: { mode: 'none' } },
      { id: 'conn-x', name: 'bad type', type: 'ftp', auth: { mode: 'none' } },
    ],
  });
  const crm = metadata.get('conn-crm');
  check('keeps a well-formed pushed connection', crm?.id === 'conn-crm' && crm.allowWrites === true);
  check(
    'drops any value carried alongside the metadata',
    !JSON.stringify(crm).includes('pushed-secret') && crm.secretKeys.join(',') === 'token,tenant',
    JSON.stringify(crm),
  );
  check('skips malformed entries', metadata.size === 1, String(metadata.size));
}

console.log(failures === 0 ? '\nAll WorkerConnectionStore checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
