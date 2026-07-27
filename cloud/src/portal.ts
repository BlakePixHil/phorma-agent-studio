/**
 * Public portal routes (EPIC 9) - the only UNAUTHENTICATED surface that can
 * start a run.
 *
 * Every other route in this worker requires a `PHORMA_TOKEN` or a Clerk JWT.
 * These routes are reachable by strangers, so each one is deliberately narrow:
 *
 *   GET    /p/{slug}                     the page (self-contained HTML)
 *   GET    /p/{slug}/config              visitor-safe config (no graph/prompts)
 *   POST   /p/{slug}/session             mint an opaque conversation id
 *   POST   /p/{slug}/message             one visitor turn -> { runId }
 *   GET    /p/{slug}/stream              redacted SSE of that turn
 *   POST   /p/{slug}/answer              reply to an Ask User question
 *   POST   /p/{slug}/run                 scoped-token JSON API (?wait=1, SSE)
 *
 * Defence in depth, in order, for every mutating route:
 *   1. slug resolves to a live publish record (else 404, no detail),
 *   2. access mode satisfied (`public`, or a valid scoped key),
 *   3. rate limit consumed (per visitor AND per slug),
 *   4. the run executes in a per-visitor SESSION instance, never the owner's
 *      workflow instance - which is also what allows concurrent visitors,
 *   5. every event that flows back is passed through the redaction projection.
 *
 * Mounted in index.ts BEFORE the API and agent routes, mirroring
 * `handleReleaseRequest`. Returns null when the path isn't ours.
 */

import { coercePortalFields, type WorkflowSpec } from '@phorma/engine';

import { readPortalToken, verifyPortalToken } from './portal-auth';
import { frameAncestors, renderEmbedLoader } from './portal-embed';
import { renderPortalPage } from './portal-page';
import {
  portalIndex,
  portalOwnerInstance,
  portalSessionInstance,
  type PortalRegistryEnv,
  type PublishRecord,
} from './portal-registry';
import { PORTAL_GENERIC_ERROR } from './portal-events';
import type { Env } from './workflow-agent';

/**
 * Portal responses are meant to be embeddable on any site, so CORS is open.
 * `X-Portal-Key` is listed so a browser may send a scoped key without it
 * colliding with the studio's own `Authorization` handling.
 */
const PORTAL_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Portal-Key',
  'Access-Control-Max-Age': '86400',
};

/** Visitor messages are short by design; anything larger is abuse. */
const MAX_MESSAGE_CHARS = 8_000;

/** Cap on a submitted form body. */
const MAX_BODY_BYTES = 64 * 1024;

/** Session ids are opaque and unguessable - they authorize a conversation. */
const SESSION_ID_BYTES = 16;

const SESSION_ID_PATTERN = /^[0-9a-f]{32}$/;

/** The RPC surface a session instance exposes (see workflow-agent.ts). */
interface SessionStub {
  initPortalSession(input: {
    spec: WorkflowSpec;
    slug: string;
    sessionId: string;
    workflowId: string;
    ownerInstance: string;
    ownerId: string | null;
    responderNodeId: string | null;
  }): Promise<{ ok: true }>;
  startPortalTurn(input: {
    message?: string;
    fields?: Record<string, string | number | boolean>;
  }): Promise<{ ok: boolean; runId?: string; error?: string; status?: number }>;
  answerPortalQuestion(requestId: string, response: string): Promise<{ delivered: boolean }>;
  openPortalStream(): Promise<Response>;
}

/** The owner instance's read-only surface used to fetch the published spec. */
interface OwnerStub {
  publishedSpec(): Promise<WorkflowSpec | null>;
}

/**
 * Handles a public portal request, or returns null when the path is not a
 * portal path.
 */
export async function handlePortalRequest(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/p/')) return null;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: PORTAL_CORS });
  }

  const segments = url.pathname.slice('/p/'.length).split('/').filter(Boolean);
  const slug = decodeURIComponent(segments[0] ?? '');
  const action = segments[1] ?? '';
  if (!slug || segments.length > 2) return notFound();

  // Drain the body ONCE, before anything can return early. Leaving a request
  // stream unread and then responding throws "Can't read from request stream
  // after response has been sent" in the Workers runtime, which wedges the
  // caller's next request on that connection. Guards below (auth, rate limit)
  // legitimately reject before they would ever look at a body, so reading here
  // is the only way to keep every path safe.
  let body: Record<string, unknown> | null = {};
  if (request.method === 'POST') {
    body = await readJsonBody(request);
  }

  const record = await portalIndex(env as PortalRegistryEnv).resolve(slug);
  // An unpublished slug and a slug behind a key look identical from outside -
  // no probing for which workflows exist.
  if (!record) return notFound();

  if (request.method === 'POST' && !body) {
    return jsonResponse({ error: 'Malformed request.' }, 400);
  }

  try {
    switch (`${request.method} ${action}`) {
      case 'GET ':
        return servePage(
          record,
          url.searchParams.get('embed') === '1',
          url.searchParams.get('theme'),
        );
      case 'GET config':
        return serveConfig(record);
      case 'POST session':
        return serveSession(request, url, record, env);
      case 'POST message':
        return serveMessage(request, url, record, env, body!);
      case 'GET stream':
        return serveStream(request, url, record, env);
      case 'POST answer':
        return serveAnswer(request, url, record, env, body!);
      case 'POST run':
        return serveApiRun(request, url, record, env, body!);
      default:
        return notFound();
    }
  } catch {
    // Never leak a stack trace or an internal message to the public.
    return jsonResponse({ error: PORTAL_GENERIC_ERROR }, 500);
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

/**
 * The page itself. Cached briefly; the config is fetched separately.
 *
 * `themeOverride` exists for the embed loader: the host site knows whether its
 * own pages are light or dark, and a widget that follows the VISITOR's OS
 * instead would render a dark panel on a light site.
 */
function servePage(
  record: PublishRecord,
  embed = false,
  themeOverride?: string | null,
): Response {
  const config = publicConfigOf(record);
  const theme =
    themeOverride === 'light' || themeOverride === 'dark' || themeOverride === 'auto'
      ? themeOverride
      : config.theme;
  return new Response(renderPortalPage({ ...config, theme }, embed), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      // The page is entirely self-contained: no external scripts, styles,
      // fonts or images, and it only talks to its own origin.
      //
      // `frame-ancestors` is set EXPLICITLY, and defaults to 'none'. It does not
      // fall back to `default-src`, so before this it was simply absent - which
      // browsers read as "anyone may frame me", leaving a key-protected portal
      // open to clickjacking.
      'Content-Security-Policy': [
        "default-src 'none'",
        "connect-src 'self'",
        "style-src 'unsafe-inline'",
        "script-src 'unsafe-inline'",
        'img-src data:',
        "base-uri 'none'",
        "form-action 'none'",
        frameAncestors(record),
      ].join('; '),
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      ...PORTAL_CORS,
    },
  });
}

/** Visitor-safe config. Deliberately contains no graph, prompts or owner. */
function serveConfig(record: PublishRecord): Response {
  return jsonResponse(publicConfigOf(record));
}

/**
 * The embed loader, served to a customer's website.
 *
 * A TOP-LEVEL route (not under `/p/`) so the two-segment invariant there holds,
 * and so one cached file serves every portal. Slug-agnostic: the tag's
 * `data-slug` selects the portal at runtime.
 */
export function handlePortalEmbedScript(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== '/portal-embed.js') return null;
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: PORTAL_CORS });
  }
  if (request.method !== 'GET') {
    return new Response('Method not allowed.', { status: 405, headers: PORTAL_CORS });
  }
  return new Response(renderEmbedLoader(), {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      // Short deliberately. The loader is the ONLY portal asset a customer's
      // browser caches across visits, so a long TTL means a redeploy takes
      // hours to reach real visitors - and during development it looks like the
      // fix simply did not work. Five minutes keeps it cheap without stranding
      // anyone on an old launcher.
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      ...PORTAL_CORS,
    },
  });
}

/** Mints a conversation id. Cheap, unauthenticated, rate-limited by slug. */
async function serveSession(
  request: Request,
  url: URL,
  record: PublishRecord,
  env: Env,
): Promise<Response> {
  const denied = await authorizePortal(request, url, record, env);
  if (denied) return denied;
  return jsonResponse({ sessionId: randomSessionId() });
}

/** One visitor turn on the chat/form surface. */
async function serveMessage(
  request: Request,
  url: URL,
  record: PublishRecord,
  env: Env,
  body: Record<string, unknown>,
): Promise<Response> {
  const denied = await authorizePortal(request, url, record, env);
  if (denied) return denied;

  const sessionId = normalizeSessionId(body.sessionId);
  if (!sessionId) return jsonResponse({ error: 'Missing conversation id.' }, 400);

  const rate = await consumeRate(request, record, env, sessionId);
  if (rate) return rate;

  const turn = await buildTurn(record, body);
  if ('error' in turn) return jsonResponse({ error: turn.error }, 422);

  const session = await openSession(env, record, sessionId);
  if ('error' in session) return jsonResponse({ error: session.error }, session.status);

  const result = await session.stub.startPortalTurn(turn.turn);
  if (!result.ok) {
    return jsonResponse({ error: result.error ?? PORTAL_GENERIC_ERROR }, result.status ?? 409);
  }

  // Counters are advisory; never fail a visitor's turn over them.
  void portalIndex(env as PortalRegistryEnv)
    .recordHit(record.slug, undefined)
    .catch(() => undefined);

  return jsonResponse({ runId: result.runId }, 202);
}

/** Redacted SSE for the current turn of a conversation. */
async function serveStream(
  request: Request,
  url: URL,
  record: PublishRecord,
  env: Env,
): Promise<Response> {
  const denied = await authorizePortal(request, url, record, env);
  if (denied) return denied;

  const sessionId = normalizeSessionId(url.searchParams.get('sessionId'));
  if (!sessionId) return jsonResponse({ error: 'Missing conversation id.' }, 400);

  const stub = sessionStub(env, record, sessionId);
  return stub.openPortalStream();
}

/** Answers a pending Ask User question inside the visitor's own run. */
async function serveAnswer(
  request: Request,
  url: URL,
  record: PublishRecord,
  env: Env,
  body: Record<string, unknown>,
): Promise<Response> {
  const denied = await authorizePortal(request, url, record, env);
  if (denied) return denied;

  const sessionId = normalizeSessionId(body.sessionId);
  const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
  if (!sessionId || !requestId) return jsonResponse({ error: 'Malformed request.' }, 400);

  const response = clampText(body.response, MAX_MESSAGE_CHARS);
  const stub = sessionStub(env, record, sessionId);
  const result = await stub.answerPortalQuestion(requestId, response);
  return jsonResponse({ delivered: result.delivered });
}

/**
 * The machine-facing endpoint. Same execution path as the page, but shaped for
 * a caller that wants JSON: `?wait=1` blocks for the answer, an
 * `Accept: text/event-stream` header streams it, and the default is a 202 with
 * a runId to poll the stream with.
 */
async function serveApiRun(
  request: Request,
  url: URL,
  record: PublishRecord,
  env: Env,
  body: Record<string, unknown>,
): Promise<Response> {
  const denied = await authorizePortal(request, url, record, env);
  if (denied) return denied;

  // API callers get a fresh conversation unless they carry one, so a bare
  // POST is a valid one-shot invocation.
  const sessionId = normalizeSessionId(body.sessionId) ?? randomSessionId();

  const rate = await consumeRate(request, record, env, sessionId);
  if (rate) return rate;

  const turn = await buildTurn(record, body);
  if ('error' in turn) return jsonResponse({ error: turn.error }, 422);

  const session = await openSession(env, record, sessionId);
  if ('error' in session) return jsonResponse({ error: session.error }, session.status);

  const result = await session.stub.startPortalTurn(turn.turn);
  if (!result.ok) {
    return jsonResponse({ error: result.error ?? PORTAL_GENERIC_ERROR }, result.status ?? 409);
  }

  void portalIndex(env as PortalRegistryEnv)
    .recordHit(record.slug, undefined)
    .catch(() => undefined);

  const wantsStream = (request.headers.get('Accept') ?? '').includes('text/event-stream');
  if (wantsStream) return session.stub.openPortalStream();

  if (url.searchParams.get('wait') === '1') {
    const stream = await session.stub.openPortalStream();
    const settled = await collectFinalAnswer(stream);
    return jsonResponse({ runId: result.runId, sessionId, ...settled }, settled.ok ? 200 : 502);
  }

  return jsonResponse({ runId: result.runId, sessionId }, 202);
}

// ── Guards ──────────────────────────────────────────────────────────────────

/**
 * Enforces the portal's access mode. Returns a response to send when access is
 * refused, or null to proceed.
 */
async function authorizePortal(
  request: Request,
  url: URL,
  record: PublishRecord,
  env: Env,
): Promise<Response | null> {
  if (record.access !== 'token') return null;
  const presented = readPortalToken(request, url);
  const match = await verifyPortalToken(record.slug, record.tokens, presented);
  if (!match) {
    return jsonResponse({ error: 'An access key is required.' }, 401);
  }
  void portalIndex(env as PortalRegistryEnv)
    .recordHit(record.slug, match.id)
    .catch(() => undefined);
  return null;
}

/**
 * Consumes one rate-limit slot. The visitor identity is the conversation id
 * plus the connecting IP, so neither a shared NAT nor a fresh session alone
 * defeats the limit.
 */
async function consumeRate(
  request: Request,
  record: PublishRecord,
  env: Env,
  sessionId: string,
): Promise<Response | null> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const verdict = await portalIndex(env as PortalRegistryEnv).checkRate(
    record.slug,
    `${ip}|${sessionId}`,
    record.rateLimitPerMin,
  );
  if (verdict.allowed) return null;
  return new Response(
    JSON.stringify({ error: 'Too many messages. Please slow down.' }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(verdict.retryAfter),
        ...PORTAL_CORS,
      },
    },
  );
}

// ── Session plumbing ────────────────────────────────────────────────────────

function sessionStub(env: Env, record: PublishRecord, sessionId: string): SessionStub {
  const name = portalSessionInstance(record, sessionId);
  return env.WorkflowAgent.get(env.WorkflowAgent.idFromName(name)) as unknown as SessionStub;
}

/**
 * Ensures a session instance exists and holds the published spec.
 *
 * The spec is read from the OWNER instance every turn rather than cached in
 * the registry: it can be large, and re-reading means a re-push takes effect
 * immediately without a republish.
 */
async function openSession(
  env: Env,
  record: PublishRecord,
  sessionId: string,
): Promise<{ stub: SessionStub } | { error: string; status: number }> {
  const ownerName = portalOwnerInstance(record);
  const owner = env.WorkflowAgent.get(
    env.WorkflowAgent.idFromName(ownerName),
  ) as unknown as OwnerStub;
  const spec = await owner.publishedSpec();
  if (!spec) return { error: 'This assistant is not available right now.', status: 503 };

  const stub = sessionStub(env, record, sessionId);
  await stub.initPortalSession({
    spec,
    slug: record.slug,
    sessionId,
    workflowId: record.workflowId,
    // The session instance cannot derive this itself: reading `this.name` on an
    // RPC-reached Durable Object throws in partyserver.
    ownerInstance: ownerName,
    ownerId: record.ownerId,
    responderNodeId: record.responderNodeId,
  });
  return { stub };
}

/** Validates and shapes the visitor's turn according to the portal's mode. */
async function buildTurn(
  record: PublishRecord,
  body: Record<string, unknown>,
): Promise<
  | { turn: { message?: string; fields?: Record<string, string | number | boolean> } }
  | { error: string }
> {
  if (record.mode === 'form') {
    const raw = (body.fields ?? {}) as Record<string, unknown>;
    if (typeof raw !== 'object' || raw === null) return { error: 'Malformed submission.' };
    // Server-side coercion: the page validates too, but a hand-rolled POST
    // must not be able to inject off-schema values into a prompt.
    const coerced = coercePortalFields(record.fields, raw);
    if ('errors' in coerced) return { error: coerced.errors.join(' ') };
    return { turn: { fields: coerced.values } };
  }

  const message = clampText(body.message, MAX_MESSAGE_CHARS);
  if (!message) return { error: 'Please enter a message.' };
  return { turn: { message } };
}

/**
 * Drains a redacted SSE stream down to its terminal event - the `?wait=1`
 * convenience for API callers who just want the answer.
 */
async function collectFinalAnswer(
  stream: Response,
): Promise<{ ok: boolean; output?: string; error?: string }> {
  const body = stream.body;
  if (!body) return { ok: false, error: PORTAL_GENERIC_ERROR };

  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let output = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value ?? '';
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const payload = frame.startsWith('data: ') ? frame.slice('data: '.length) : null;
        if (payload) {
          const event = safeParse(payload);
          if (event?.type === 'token' && typeof event.text === 'string') output += event.text;
          if (event?.type === 'done') {
            return { ok: true, output: typeof event.output === 'string' ? event.output : output };
          }
          if (event?.type === 'error') return { ok: false, error: PORTAL_GENERIC_ERROR };
          if (event?.type === 'stopped') return { ok: false, error: 'The run was stopped.' };
        }
        index = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
  // The stream closed without a terminal frame: report whatever streamed.
  return output ? { ok: true, output } : { ok: false, error: PORTAL_GENERIC_ERROR };
}

// ── Small helpers ───────────────────────────────────────────────────────────

/** The visitor-facing config, assembled from the stored record. */
function publicConfigOf(record: PublishRecord) {
  return {
    slug: record.slug,
    mode: record.mode,
    title: record.title,
    greeting: record.greeting,
    fields: record.mode === 'form' ? record.fields : [],
    access: record.access,
    theme: record.theme,
    showBranding: record.showBranding,
  };
}

function randomSessionId(): string {
  const bytes = new Uint8Array(SESSION_ID_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Session ids must be exactly what we minted - no caller-chosen names. */
function normalizeSessionId(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SESSION_ID_PATTERN.test(text) ? text : null;
}

function clampText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get('Content-Length') ?? 0);
  if (length > MAX_BODY_BYTES) return null;
  const text = await request.text().catch(() => '');
  if (!text) return {};
  if (text.length > MAX_BODY_BYTES) return null;
  const parsed = safeParse(text);
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...PORTAL_CORS },
  });
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: 'Not found.' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', ...PORTAL_CORS },
  });
}
