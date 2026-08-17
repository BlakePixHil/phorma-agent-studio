/**
 * Portal E2E against a REAL local Durable Object (EPIC 9).
 *
 * Exercises the full public surface the way a visitor's browser and a
 * server-to-server caller do - publish, chat turn, SSE streaming, form submit,
 * scoped-token access, rate limiting, revocation, and (most importantly) the
 * redaction guarantee: no prompt, node name, tool payload, usage figure or raw
 * error may appear in the public stream.
 *
 * Prerequisites (the runner does NOT start these):
 *   1. npx wrangler dev --config cloud/wrangler.jsonc --port 8799
 *   2. A local model. Defaults to Ollama at http://localhost:11434 with the
 *      first installed model; override with PORTAL_E2E_MODEL.
 *
 * Run: node cloud/test/portal.e2e.mjs
 */

const BASE = process.env.PORTAL_E2E_BASE ?? 'http://127.0.0.1:8799';
const OLLAMA = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

async function pickModel() {
  if (process.env.PORTAL_E2E_MODEL) return process.env.PORTAL_E2E_MODEL;
  const response = await fetch(`${OLLAMA}/api/tags`).catch(() => null);
  if (!response?.ok) return null;
  const body = await response.json();
  return body.models?.[0]?.name ?? null;
}

// ── Graph fixtures ──────────────────────────────────────────────────────────

function node(id, kind, ports, data = {}, category = 'flow') {
  return { id, name: id, kind, category, icon: '', position: { x: 0, y: 0 }, ports, data };
}
function edge(id, fromPort, toPort, kind = 'handoff') {
  return { id, outputId: `${fromPort}-out`, inputId: `${toPort}-in`, kind };
}
function portalNode(data) {
  return node(
    'portal',
    'portal-trigger',
    [{ id: 'portal-msg', name: 'Message', role: 'message-out' }],
    { mode: 'chat', access: 'public', ...data },
    'trigger',
  );
}
function agentNode(id, name, prompt, model) {
  return node(
    id,
    'agent',
    [
      { id: `${id}-in`, name: 'Task', role: 'message-in' },
      { id: `${id}-out`, name: 'Result', role: 'message-out' },
    ],
    { prompt, provider: 'ollama', model },
    'agent',
  );
}

/**
 * A two-agent chain used to audit what reaches the public.
 *
 * IMPORTANT: the deterministic proof of the redaction boundary lives in
 * `cloud/test/portal-projection.test.mjs`, which drives every `RunEvent`
 * variant through `toPortalEvent`. This file audits the LIVE wire, where a
 * model may legitimately choose to recite its own prompt back to the user - so
 * the assertions below check the things the TRANSPORT controls (event shapes,
 * absent metadata fields, which node's tokens stream) rather than the prose a
 * 3B model happens to produce.
 */
const SECRET_IN_PROMPT = 'CLASSIFIED-PROMPT-abc123';

function chainSpec(model, portalData = {}) {
  return {
    version: 1,
    id: 'wf-portal-e2e',
    name: 'Portal E2E',
    savedAt: new Date().toISOString(),
    graph: {
      nodes: [
        portalNode(portalData),
        // The secret rides in this agent's prompt. The transport must never
        // publish this node's tokens or output regardless of what it says.
        agentNode(
          'triage',
          'Triage',
          `Internal policy reference ${SECRET_IN_PROMPT}. Summarise the request in one short sentence. Never mention the policy reference.\n\nVisitor said: {{message}}`,
          model,
        ),
        // The responder. Its exact wording is irrelevant to the assertions:
        // provenance is proven by comparing the streamed tokens against
        // `run-completed.output` (see the redaction audit below).
        agentNode('answer', 'Answerer', 'Reply in one short sentence.', model),
      ],
      connections: [
        edge('e1', 'portal-msg', 'triage-in'),
        edge('e2', 'triage-out', 'answer-in'),
      ],
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function push(spec) {
  const response = await fetch(
    `${BASE}/agents/workflow-agent/${encodeURIComponent(spec.id)}/workflow`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) },
  );
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function ownerPost(workflowId, action, body) {
  const response = await fetch(
    `${BASE}/agents/workflow-agent/${encodeURIComponent(workflowId)}/${action}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) },
  );
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function ownerGet(workflowId, action) {
  const response = await fetch(
    `${BASE}/agents/workflow-agent/${encodeURIComponent(workflowId)}/${action}`,
  );
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function portalPost(slug, action, body, key) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['X-Portal-Key'] = key;
  const response = await fetch(`${BASE}/p/${slug}${action ? `/${action}` : ''}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** Reads a portal SSE stream to its terminal event, returning raw frames. */
async function readStream(slug, sessionId, key, timeoutMs = 120_000) {
  const headers = {};
  if (key) headers['X-Portal-Key'] = key;
  const response = await fetch(
    `${BASE}/p/${slug}/stream?sessionId=${encodeURIComponent(sessionId)}`,
    { headers, signal: AbortSignal.timeout(timeoutMs) },
  );
  const raw = await response.text();
  const events = [];
  for (const frame of raw.split('\n\n')) {
    if (!frame.startsWith('data: ')) continue;
    try {
      events.push(JSON.parse(frame.slice(6)));
    } catch {
      // ignore
    }
  }
  return { contentType: response.headers.get('Content-Type') ?? '', raw, events };
}

/** Polls the stream until a terminal event arrives (the run may still be warm). */
async function awaitTurn(slug, sessionId, key) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await readStream(slug, sessionId, key);
    const terminal = result.events.find(
      event => event.type === 'done' || event.type === 'error' || event.type === 'stopped',
    );
    if (terminal) return result;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  return null;
}

// ── Run ─────────────────────────────────────────────────────────────────────

const model = await pickModel();
if (!model) {
  console.error('No Ollama model available. Set PORTAL_E2E_MODEL or start Ollama.');
  process.exit(1);
}
console.log(`Using model: ${model}\nWorker: ${BASE}\n`);

// 1 ── Publish
console.log('Portal E2E: publish');
const spec = chainSpec(model, { slug: 'e2e-support', responderNodeId: 'answer' });
{
  const pushed = await push(spec);
  check('spec pushes', pushed.status === 200, JSON.stringify(pushed.body));

  const published = await ownerPost(spec.id, 'publish');
  check('publish succeeds', published.status === 200, JSON.stringify(published.body));
  check('slug is honored', published.body.record?.slug === 'e2e-support');
  check('responder is stored', published.body.record?.responderNodeId === 'answer');
  check('access defaults public', published.body.record?.access === 'public');
  check(
    'publish response carries no key hashes',
    !JSON.stringify(published.body).includes('hash'),
    JSON.stringify(published.body.record?.tokens),
  );

  const status = await ownerGet(spec.id, 'portal');
  check('portal status reads back', status.body.record?.slug === 'e2e-support');
  check('validation is clean', status.body.validation?.errors?.length === 0);
}

// 2 ── The page
console.log('\nPortal E2E: page + config');
{
  const page = await fetch(`${BASE}/p/e2e-support`);
  const html = await page.text();
  check('page serves 200', page.status === 200);
  check('page is HTML', (page.headers.get('Content-Type') ?? '').includes('text/html'));
  check('page sets a CSP', !!page.headers.get('Content-Security-Policy'));
  check('page is noindex', html.includes('noindex'));
  // No external subresources: any src/href pointing off-origin would be
  // blocked by the CSP anyway, so catching it here keeps the page honest.
  const externalRefs = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/gi)]
    .map(match => match[1])
    .filter(value => /^(https?:)?\/\//i.test(value));
  check('page loads no external resources', externalRefs.length === 0, externalRefs.join(','));

  // The page must not embed the graph, prompts, or the responder node id.
  check('page does NOT contain the prompt secret', !html.includes(SECRET_IN_PROMPT));
  check('page does NOT contain node names', !html.includes('Answerer') && !html.includes('Triage'));
  check('page does NOT contain the responder node id', !/"responderNodeId"/.test(html));
  check('page does NOT contain the model id', !html.includes(model));

  const config = await fetch(`${BASE}/p/e2e-support/config`);
  const configBody = await config.json();
  check('config serves', config.status === 200);
  check('config carries the mode', configBody.mode === 'chat');
  check('config has no graph', configBody.graph === undefined);
  check('config has no ownerId', configBody.ownerId === undefined);
  check('config has no tokens', configBody.tokens === undefined);
  check('config has no responder', configBody.responderNodeId === undefined);

  const missing = await fetch(`${BASE}/p/does-not-exist`);
  check('unknown slug 404s', missing.status === 404);
}

// 3 ── A chat turn end to end, plus the redaction audit
console.log('\nPortal E2E: chat turn + redaction audit');
let sessionId = null;
{
  const session = await portalPost('e2e-support', 'session');
  sessionId = session.body.sessionId;
  check('session mints', /^[0-9a-f]{32}$/.test(sessionId ?? ''), sessionId);

  const rejected = await portalPost('e2e-support', 'message', { sessionId, message: '' });
  check('empty messages are rejected', rejected.status === 422);

  const badSession = await portalPost('e2e-support', 'message', {
    sessionId: 'not-a-session',
    message: 'hi',
  });
  check('forged session ids are rejected', badSession.status === 400);

  const sent = await portalPost('e2e-support', 'message', {
    sessionId,
    message: 'Where is my order?',
  });
  check('message is accepted', sent.status === 202, JSON.stringify(sent.body));
  check('message returns a runId', typeof sent.body.runId === 'string');

  const result = await awaitTurn('e2e-support', sessionId);
  check('turn reaches a terminal event', !!result, 'timed out');

  if (!result) {
    // Everything below - the entire live redaction audit, which is the security
    // core of this file - lives inside the `if (result)` branch. A timed-out
    // turn used to skip all of it while reporting a single failure, so a run
    // could look "1 check failed" when ~14 security assertions never executed.
    check(
      'the live redaction audit ran',
      false,
      'turn timed out, so NONE of the redaction assertions executed - treat this run as no evidence, not as a pass',
    );
  } else {
    check('stream is text/event-stream', result.contentType.includes('text/event-stream'));
    const done = result.events.find(event => event.type === 'done');
    check('turn completes', !!done, JSON.stringify(result.events.map(e => e.type)));
    check('answer reaches the visitor', (done?.output ?? '').trim().length > 0, done?.output);

    // ── Live redaction audit (structural: transport-controlled only) ──
    const raw = result.raw;

    // Metadata fields: entirely the transport's choice, so these are exact.
    check('stream carries no node ids', !raw.includes('nodeId'));
    check('stream carries no node names', !raw.includes('nodeName'));
    check('stream carries no usage', !raw.includes('inputTokens') && !raw.includes('costUsd'));
    check('stream carries no provider or model fields', !raw.includes('"provider"') && !raw.includes('"model"'));
    check('stream carries no handoff events', !raw.includes('handoff'));
    check('stream carries no tool events', !raw.includes('tool-call') && !raw.includes('tool-result'));
    check('stream carries no payload fields', !raw.includes('"payload"'));
    check('stream carries no input echo', !raw.includes('"input"'));

    // Only whitelisted event types may appear.
    const allowed = new Set(['started', 'token', 'question', 'review', 'review-resolved', 'done', 'error', 'stopped']);
    const unexpected = result.events.map(event => event.type).filter(type => !allowed.has(type));
    check('only whitelisted event types stream', unexpected.length === 0, unexpected.join(','));

    // Streaming provenance, proven WITHOUT relying on model cooperation.
    //
    // The responder is the graph's terminal leaf, so `run-completed.output` IS
    // its output. Reassembling the streamed tokens must therefore reproduce
    // exactly that text. The intermediate agent runs FIRST, so if node
    // filtering were broken its output would be prepended and the two strings
    // would diverge - whatever the model chose to say.
    const streamed = result.events
      .filter(event => event.type === 'token')
      .map(event => event.text)
      .join('');
    check(
      'streamed tokens reconstruct exactly the responder output (no other node leaked)',
      streamed.trim() === (done?.output ?? '').trim(),
      `streamed(${streamed.length}): ${streamed.slice(0, 120)} | final(${(done?.output ?? '').length}): ${(done?.output ?? '').slice(0, 120)}`,
    );
  }
}

// 4 ── Multi-turn: the transcript must reach the prompt as {{history}}
console.log('\nPortal E2E: multi-turn history');
{
  const second = await portalPost('e2e-support', 'message', {
    sessionId,
    message: 'And the second one?',
  });
  check('second turn is accepted', second.status === 202, JSON.stringify(second.body));
  const result = await awaitTurn('e2e-support', sessionId);
  check('second turn completes', !!result?.events.some(event => event.type === 'done'));

  // The owner's Runs panel must see BOTH portal runs, mirrored up from the
  // session instance (session-scoped DOs would otherwise hide them). The
  // mirror is fire-and-forget at settle, so poll rather than sleep once.
  let mirrored = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const runs = await ownerGet(spec.id, 'portal-runs');
    mirrored = runs.body.runs ?? [];
    if (mirrored.length >= 2) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  check('portal runs mirror to the owner instance', mirrored.length >= 2, `saw ${mirrored.length}`);
  check(
    'mirrored runs are attributed to the portal',
    mirrored.length > 0 && mirrored.every(run => run.source === 'portal'),
  );
  check(
    'mirrored runs record the visitor input envelope',
    mirrored.every(run => typeof run.input === 'string' && run.input.includes('sessionId')),
  );
}

// 5 ── Concurrency: distinct visitors must never collide (the 409 blocker)
console.log('\nPortal E2E: concurrent visitors');
{
  const sessions = await Promise.all(
    Array.from({ length: 5 }, () => portalPost('e2e-support', 'session')),
  );
  const ids = sessions.map(result => result.body.sessionId);
  check('five sessions mint', ids.every(id => /^[0-9a-f]{32}$/.test(id ?? '')));
  check('session ids are unique', new Set(ids).size === 5);

  const sent = await Promise.all(
    ids.map(id => portalPost('e2e-support', 'message', { sessionId: id, message: 'Concurrent hello' })),
  );
  const statuses = sent.map(result => result.status);
  check(
    'five concurrent visitors all get 202 (no 409)',
    statuses.every(status => status === 202),
    statuses.join(','),
  );
}

// 6 ── Rate limiting
console.log('\nPortal E2E: rate limiting');
{
  const rateSpec = chainSpec(model, {
    slug: 'e2e-rate',
    responderNodeId: 'answer',
    rateLimitPerMin: 2,
  });
  rateSpec.id = 'wf-portal-rate';
  await push(rateSpec);
  const published = await ownerPost(rateSpec.id, 'publish');
  check('rate-limited portal publishes', published.status === 200, JSON.stringify(published.body));
  check('rate limit is stored', published.body.record?.rateLimitPerMin === 2);

  const session = await portalPost('e2e-rate', 'session');
  const id = session.body.sessionId;
  const statuses = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await portalPost('e2e-rate', 'message', { sessionId: id, message: `msg ${attempt}` });
    statuses.push(result.status);
  }
  check('the limit eventually returns 429', statuses.includes(429), statuses.join(','));

  const blocked = await fetch(`${BASE}/p/e2e-rate/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: id, message: 'again' }),
  });
  // Asserted unconditionally. The previous form was
  // `blocked.status !== 429 || !!header`, which passes whenever the request is
  // NOT rate-limited - and the loop above has already consumed the window, so
  // that was the common case. Rate-limit headers went effectively unasserted.
  check('a further request inside the window is still blocked', blocked.status === 429, `status ${blocked.status}`);
  const retryAfter = blocked.headers.get('Retry-After');
  check('429 carries Retry-After', !!retryAfter, String(retryAfter));
  check(
    'Retry-After is a positive number of seconds',
    Number.isFinite(Number(retryAfter)) && Number(retryAfter) > 0,
    String(retryAfter),
  );
}

// 7 ── Scoped tokens
console.log('\nPortal E2E: scoped access keys');
{
  const gatedSpec = chainSpec(model, {
    slug: 'e2e-gated',
    responderNodeId: 'answer',
    access: 'token',
  });
  gatedSpec.id = 'wf-portal-gated';
  await push(gatedSpec);
  const published = await ownerPost(gatedSpec.id, 'publish');
  check('token portal publishes', published.status === 200, JSON.stringify(published.body));
  check('access mode is token', published.body.record?.access === 'token');

  const anon = await portalPost('e2e-gated', 'session');
  check('anonymous access is refused', anon.status === 401);

  const minted = await ownerPost(gatedSpec.id, 'portal-tokens', { label: 'E2E key' });
  const secret = minted.body.secret;
  check('a key mints', typeof secret === 'string' && secret.startsWith('pk_e2e-gated_'), secret);
  check('minted key metadata has no hash', minted.body.token?.hash === undefined);
  check('minted key keeps its label', minted.body.token?.label === 'E2E key');

  const withKey = await portalPost('e2e-gated', 'session', {}, secret);
  check('a valid key is accepted', withKey.status === 200, JSON.stringify(withKey.body));

  const tampered = `${secret.slice(0, -1)}${secret.endsWith('a') ? 'b' : 'a'}`;
  check(
    'a tampered key is refused',
    (await portalPost('e2e-gated', 'session', {}, tampered)).status === 401,
  );
  check(
    "another portal's key is refused",
    (await portalPost('e2e-gated', 'session', {}, 'pk_e2e-support_aaaaaaaa')).status === 401,
  );

  // Keys survive re-publishing (an owner tweaking a greeting must not break
  // every integration).
  await ownerPost(gatedSpec.id, 'publish');
  check(
    'keys survive a re-publish',
    (await portalPost('e2e-gated', 'session', {}, secret)).status === 200,
  );

  const revoked = await fetch(
    `${BASE}/agents/workflow-agent/${encodeURIComponent(gatedSpec.id)}/portal-tokens/${minted.body.token.id}`,
    { method: 'DELETE' },
  );
  check('a key revokes', revoked.status === 200);
  check(
    'a revoked key is refused',
    (await portalPost('e2e-gated', 'session', {}, secret)).status === 401,
  );
}

// 8 ── Form mode + the scoped-token API
console.log('\nPortal E2E: form mode + JSON API');
{
  const formSpec = chainSpec(model, {
    slug: 'e2e-form',
    mode: 'form',
    responderNodeId: 'answer',
    fields: [
      { key: 'orderId', label: 'Order number', type: 'text', required: true },
      { key: 'team', label: 'Team', type: 'select', options: ['Sales', 'Support'] },
    ],
  });
  formSpec.id = 'wf-portal-form';
  // The triage prompt reads a submitted field, so a successful run proves the
  // {{fields.x}} envelope reached the graph.
  formSpec.graph.nodes[1].data.prompt =
    'Repeat the order number and nothing else: {{fields.orderId}}';
  await push(formSpec);
  const published = await ownerPost(formSpec.id, 'publish');
  check('form portal publishes', published.status === 200, JSON.stringify(published.body));
  check('fields are stored', published.body.record?.fields?.length === 2);

  const config = await (await fetch(`${BASE}/p/e2e-form/config`)).json();
  check('form config exposes fields', config.fields?.length === 2);
  check('form config exposes options', config.fields?.[1]?.options?.length === 2);

  const page = await (await fetch(`${BASE}/p/e2e-form`)).text();
  check('form page renders the field labels', page.includes('Order number'));

  const session = await portalPost('e2e-form', 'session');
  const missing = await portalPost('e2e-form', 'message', {
    sessionId: session.body.sessionId,
    fields: { team: 'Sales' },
  });
  check('required fields are enforced server-side', missing.status === 422, JSON.stringify(missing.body));

  const offSchema = await portalPost('e2e-form', 'message', {
    sessionId: session.body.sessionId,
    fields: { orderId: 'ORD-1', team: 'Engineering' },
  });
  check('off-schema select values are refused', offSchema.status === 422);

  const submitted = await portalPost('e2e-form', 'message', {
    sessionId: session.body.sessionId,
    fields: { orderId: 'ORD-1', team: 'Sales' },
  });
  check('a valid submission is accepted', submitted.status === 202, JSON.stringify(submitted.body));

  // The JSON API: one call, wait for the answer.
  const waited = await fetch(`${BASE}/p/e2e-form/run?wait=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { orderId: 'ORD-9', team: 'Support' } }),
    signal: AbortSignal.timeout(180_000),
  });
  const waitedBody = await waited.json().catch(() => ({}));
  check('POST /run?wait=1 returns the answer', waited.status === 200, JSON.stringify(waitedBody));
  check('the answer is non-empty', (waitedBody.output ?? '').trim().length > 0, waitedBody.output);
  check('the API reply carries no run metadata', !JSON.stringify(waitedBody).includes('nodeId'));
  check('the API returns a session id for follow-ups', typeof waitedBody.sessionId === 'string');
}

// 9 ── Unpublish
console.log('\nPortal E2E: unpublish');
{
  const removed = await ownerPost(spec.id, 'unpublish');
  check('unpublish succeeds', removed.status === 200, JSON.stringify(removed.body));
  check('the slug is released', removed.body.removed?.includes('e2e-support'));
  check('the page stops serving', (await fetch(`${BASE}/p/e2e-support`)).status === 404);
  check(
    'messages stop being accepted',
    (await portalPost('e2e-support', 'message', { sessionId, message: 'hello?' })).status === 404,
  );
}

// 9b ── Embedding: frame-ancestors, the loader, and the embed layout
console.log('\nPortal E2E: embedding');
{
  // A portal with embedding OFF must refuse to be framed at all.
  const closedSpec = chainSpec(model, { slug: 'e2e-noembed', responderNodeId: 'answer' });
  closedSpec.id = 'wf-portal-noembed';
  await push(closedSpec);
  await ownerPost(closedSpec.id, 'publish');
  const closed = await fetch(`${BASE}/p/e2e-noembed`);
  const closedCsp = closed.headers.get('Content-Security-Policy') ?? '';
  check(
    'embedding off sends frame-ancestors none',
    closedCsp.includes("frame-ancestors 'none'"),
    closedCsp,
  );
  // Named for what it checks. The previous version asserted `closed.status === 200`
  // under the title "X-Frame-Options is not relied upon", so the header it was
  // named after was never looked at. CSP frame-ancestors is the control; a
  // legacy X-Frame-Options alongside it cannot express an allow-list and would
  // contradict the CSP once embedding IS enabled.
  check('the closed portal still serves', closed.status === 200, `status ${closed.status}`);
  check(
    'no legacy X-Frame-Options header is sent',
    closed.headers.get('X-Frame-Options') === null,
    String(closed.headers.get('X-Frame-Options')),
  );

  // A malformed origin must BLOCK publishing rather than being silently
  // dropped: quietly discarding it would leave the owner believing a site is
  // allowed when it is not, which is a security expectation, not a typo.
  const badSpec = chainSpec(model, {
    slug: 'e2e-badorigin',
    responderNodeId: 'answer',
    embedEnabled: true,
    embedOrigins: ['not a url'],
  });
  badSpec.id = 'wf-portal-badorigin';
  await push(badSpec);
  const rejected = await ownerPost(badSpec.id, 'publish');
  check('a malformed embed origin blocks publishing', rejected.status === 422, String(rejected.status));
  check(
    'the rejection names the offending origin',
    (rejected.body.error ?? '').includes('not a url'),
    rejected.body.error,
  );

  // Now a portal with embedding ON and a valid restricted origin. Note the
  // sloppy-but-recoverable forms: a bare host and a trailing path.
  const openSpec = chainSpec(model, {
    slug: 'e2e-embed',
    responderNodeId: 'answer',
    embedEnabled: true,
    embedOrigins: ['acme.example', 'https://acme.example/pricing'],
    embedLabel: 'Talk to us',
  });
  openSpec.id = 'wf-portal-embed';
  await push(openSpec);
  const published = await ownerPost(openSpec.id, 'publish');
  check('embeddable portal publishes', published.status === 200, JSON.stringify(published.body));
  check('embed flag is stored', published.body.record?.embedEnabled === true);
  check(
    'equivalent origins are collapsed at publish time',
    published.body.record?.embedOrigins?.length === 1,
    JSON.stringify(published.body.record?.embedOrigins),
  );
  check(
    'origins are normalized at publish time',
    published.body.record?.embedOrigins?.[0] === 'https://acme.example',
  );
  check('embed label is stored', published.body.record?.embedLabel === 'Talk to us');

  const framed = await fetch(`${BASE}/p/e2e-embed`);
  const csp = framed.headers.get('Content-Security-Policy') ?? '';
  check(
    'frame-ancestors lists only the allowed origin',
    csp.includes('frame-ancestors https://acme.example'),
    csp,
  );
  check('the CSP still locks everything else down', csp.includes("default-src 'none'"));

  // The embed layout.
  const embedPage = await (await fetch(`${BASE}/p/e2e-embed?embed=1`)).text();
  check('embed layout sets the is-embed class', /class="[^"]*is-embed/.test(embedPage));
  check('embed layout carries the embed flag in config', embedPage.includes('"embed":true'));
  const plainPage = await (await fetch(`${BASE}/p/e2e-embed`)).text();
  check('the plain page is NOT in embed mode', !/class="[^"]*is-embed/.test(plainPage));

  // The loader script.
  const loader = await fetch(`${BASE}/portal-embed.js`);
  const loaderBody = await loader.text();
  check('loader serves 200', loader.status === 200);
  check(
    'loader is javascript (a host CSP would reject anything else)',
    (loader.headers.get('Content-Type') ?? '').includes('javascript'),
    loader.headers.get('Content-Type') ?? '',
  );
  check('loader is cacheable', (loader.headers.get('Cache-Control') ?? '').includes('max-age'));
  check('loader is nosniff', loader.headers.get('X-Content-Type-Options') === 'nosniff');
  check('loader reads data-slug', loaderBody.includes('data-slug'));
  check('loader requests the embed layout', loaderBody.includes('embed=1'));
  check('loader carries no portal secrets', !loaderBody.includes('pk_'));
  check(
    'loader is slug-agnostic (one cached file serves every portal)',
    !loaderBody.includes('e2e-embed'),
  );
  const loaderPost = await fetch(`${BASE}/portal-embed.js`, { method: 'POST' });
  check('loader rejects non-GET', loaderPost.status === 405);

  // The theme override. The widget is a guest on a host page, so the HOST
  // decides light/dark - not the visitor's OS, which produced a dark panel on a
  // light site until this existed.
  const lightPage = await (await fetch(`${BASE}/p/e2e-embed?embed=1&theme=light`)).text();
  check('?theme=light forces the light palette', /class="[^"]*theme-light/.test(lightPage));
  const darkPage = await (await fetch(`${BASE}/p/e2e-embed?embed=1&theme=dark`)).text();
  check('?theme=dark forces the dark palette', /class="[^"]*theme-dark/.test(darkPage));
  const junkPage = await (await fetch(`${BASE}/p/e2e-embed?embed=1&theme=../evil`)).text();
  check(
    'an unknown ?theme= falls back to the portal setting (no class injection)',
    !junkPage.includes('evil'),
  );
}

// 9c ── The build stamp that drives the staleness warning
console.log('\nPortal E2E: build stamp');
{
  const status = await ownerGet('wf-portal-embed', 'portal');
  check(
    'GET /portal reports the worker build',
    typeof status.body.workerBuild === 'string' && status.body.workerBuild.length > 0,
    JSON.stringify(status.body.workerBuild),
  );
  check(
    'the build looks like a version',
    /^\d+\.\d+\.\d+/.test(status.body.workerBuild ?? ''),
    status.body.workerBuild,
  );
}

// 10 ── Cron regression: publishing must not drop a schedule
console.log('\nPortal E2E: schedule regression');
{
  const cronSpec = chainSpec(model, { slug: 'e2e-cron', responderNodeId: 'answer' });
  cronSpec.id = 'wf-portal-cron';
  cronSpec.graph.nodes.push(
    node('cron', 'schedule-trigger', [{ id: 'cron-tick', name: 'Tick', role: 'message-out' }], {
      cron: '0 9 * * 1-5',
    }, 'trigger'),
  );
  cronSpec.graph.connections.push(edge('e3', 'cron-tick', 'triage-in'));
  const pushed = await push(cronSpec);
  check('a workflow with both a portal and a cron pushes', pushed.status === 200);
  const published = await ownerPost(cronSpec.id, 'publish');
  check('publishing alongside a schedule works', published.status === 200, JSON.stringify(published.body));
  const status = await ownerGet(cronSpec.id, 'status');
  check('the workflow still reports healthy', status.body.hasWorkflow === true);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
