/**
 * Phorma Agent Studio — cloud runtime entry point.
 *
 * Routes requests to WorkflowAgent Durable Objects. Instances are addressed
 * as /agents/workflow-agent/{instance-name}; the studio uses one instance
 * per deployed workflow (the workflow id).
 *
 * Hosted mode (PHORMA_MODE=hosted) adds the multi-tenant gateway:
 *  - Clerk JWT verification happens HERE, before any DO is woken.
 *  - Instance names are rewritten to `{userId}:{workflowId}` so tenants are
 *    isolated structurally — a caller can only ever address instances under
 *    their own prefix.
 *  - `/api/*` control-plane routes (profile/quota, admin provisioning).
 *  - CORS is scoped via ALLOWED_ORIGINS instead of `*`.
 *
 * Five route groups are deliberately public and matched before any auth layer:
 * `/status.*` (service health for the website), `/update|/download|/releases.json`
 * (installers and the updater manifest), `/p/{slug}` (published portals),
 * `/billing/return` (where Stripe sends the browser back after checkout), and
 * `/signed-in` (where Clerk sends the browser after sign-in).
 */

import { routeAgentRequest } from 'agents';

import { verifyBearer, verifyRequest, isHosted } from './auth';
import {
  handleApiRequest,
  handleBillingReturnRequest,
  handleSignedInRequest,
  type ApiEnv,
} from './api';
import { handleDeviceAuthPage } from './device-auth-routes';
import { handleReleaseRequest, type ReleaseEnv } from './releases';
import { handlePortalEmbedScript, handlePortalRequest } from './portal';
import { PortalIndex } from './portal-registry';
import { handleStatusRequest, type StatusEnv } from './status';
import { handleTelemetryRequest, runTelemetryRetention, type TelemetryEnv } from './telemetry';
import { runBackupRetention, type BackupRoutesEnv } from './backup-routes';
import { SecretVault } from './secret-vault';
import { WorkflowAgent, type Env } from './workflow-agent';

// Every Durable Object class must be exported for its binding to resolve.
export { WorkflowAgent, PortalIndex, SecretVault };

/** CORS headers for the current mode (scoped in hosted, `*` in BYO). */
function corsHeaders(env: Env, request: Request): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS;
  let origin = '*';
  if (isHosted(env) && allowed) {
    const requestOrigin = request.headers.get('Origin') ?? '';
    const list = allowed.split(',').map(entry => entry.trim()).filter(Boolean);
    origin = list.includes(requestOrigin) ? requestOrigin : list[0] ?? '';
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    ...(origin !== '*' ? { Vary: 'Origin' } : {}),
  };
}

const AGENT_PATH_PREFIX = '/agents/workflow-agent/';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cors = corsHeaders(env, request);

    // Public service status (`/status.json`, `/status.svg`). Unauthenticated and
    // edge-cached so the marketing site can render a live indicator. Matched
    // FIRST because it answers its own preflight with open CORS - the scoped
    // `cors` below would reject phorma-labs.com, and widening ALLOWED_ORIGINS
    // to fix that would also widen the authenticated `/api/*` surface.
    const statusResponse = await handleStatusRequest(request, env as StatusEnv, ctx);
    if (statusResponse) return statusResponse;

    // Anonymous telemetry ingest. Matched HERE for the same two reasons `/status.*`
    // is matched first: it answers its own preflight with a CORS set that is
    // independent of ALLOWED_ORIGINS (widening that var would widen the
    // authenticated `/api/*` surface too), and it is deliberately unauthenticated,
    // so it must not fall into the `/api/*` branch.
    const telemetryResponse = await handleTelemetryRequest(request, env as TelemetryEnv, ctx);
    if (telemetryResponse) return telemetryResponse;

    // CORS preflight for the studio (Tauri webview / localhost dev).
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // Public release/download routes (no auth; backed by R2).
    const releaseResponse = await handleReleaseRequest(request, env as ReleaseEnv, cors);
    if (releaseResponse) return releaseResponse;

    // Published portal surfaces (EPIC 9): `/p/{slug}` and its sub-routes are
    // deliberately UNAUTHENTICATED, so they are matched before the studio's
    // auth layers and carry their own open CORS + redaction rules.
    const portalResponse = await handlePortalRequest(request, env);
    if (portalResponse) return portalResponse;

    // The embed loader a customer's site includes. Slug-agnostic and cacheable,
    // so it lives at the top level rather than under `/p/`.
    const embedResponse = handlePortalEmbedScript(request);
    if (embedResponse) return embedResponse;

    // `GET /billing/return` - where Stripe sends the browser after checkout.
    // PUBLIC, because the request is the user's own browser following a redirect
    // with no bearer to present, and it carries NO CORS headers because a
    // top-level navigation needs none. It is not under `/api/`, so
    // `handleApiRequest` below would never see it. Static markup, no bindings, no
    // billing state: the studio learns the outcome by polling `/api/me`.
    const billingReturn = handleBillingReturnRequest(request);
    if (billingReturn) return billingReturn;

    // `GET /signed-in` - where the Clerk instance sends a browser after sign-in
    // and sign-up. Public for the same reasons as `/billing/return` above: a
    // top-level navigation performed by the identity provider, no bearer, no XHR,
    // so no CORS. It exists because a Clerk instance must name a post-sign-in URL
    // and ours named a hostname with no DNS record, which ended every social
    // sign-in on a browser error page.
    const signedIn = handleSignedInRequest(request);
    if (signedIn) return signedIn;

    // `GET /auth/device` - the page that signs a desktop install in. Public and
    // CORS-free like the two above: the studio hands the browser this URL, so it
    // is a top-level navigation with no bearer. It is the only one of the three
    // that runs script, because loading clerk-js FIRST-PARTY on this origin is
    // the entire mechanism - the studio's own webview is cross-site with
    // `clerk.phorma-labs.com` and can never hold a Clerk session.
    const devicePage = handleDeviceAuthPage(request, env);
    if (devicePage) return devicePage;

    // Control-plane routes (hosted mode).
    const apiResponse = await handleApiRequest(request, env as ApiEnv, cors, ctx);
    if (apiResponse) return apiResponse;

    // Hosted mode: authenticate at the edge and rewrite the instance name to
    // the tenant's namespace BEFORE the DO is addressed. The DO re-verifies
    // (defense in depth), but isolation is structural from here on.
    let routed = request;
    if (isHosted(env)) {
      const url = new URL(request.url);
      if (url.pathname.startsWith(AGENT_PATH_PREFIX)) {
        const auth =
          request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
            ? await verifyBearer(env, url.searchParams.get('token'))
            : await verifyRequest(env, request);
        if (!auth?.userId) {
          return new Response(JSON.stringify({ error: 'Unauthorized.' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...cors },
          });
        }

        const rest = url.pathname.slice(AGENT_PATH_PREFIX.length);
        const [rawInstance, ...restPath] = rest.split('/');
        const instance = decodeURIComponent(rawInstance ?? '');
        const prefix = `${auth.userId}:`;
        // Callers may send either the bare workflow id or an already-prefixed
        // name (their own prefix only — anything else is forbidden).
        if (instance.includes(':') && !instance.startsWith(prefix)) {
          return new Response(JSON.stringify({ error: 'Forbidden.' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json', ...cors },
          });
        }
        const scoped = instance.startsWith(prefix) ? instance : `${prefix}${instance}`;
        url.pathname =
          AGENT_PATH_PREFIX + encodeURIComponent(scoped) + (restPath.length ? `/${restPath.join('/')}` : '');
        routed = new Request(url, request);
      }
    }

    const response =
      (await routeAgentRequest(routed, env)) ??
      new Response('Phorma Agent Studio cloud runtime. POST /agents/workflow-agent/{id}/trigger', {
        status: 404,
        headers: cors,
      });
    // `routeAgentRequest` (the agents SDK) returns its own Response for
    // unknown methods/paths (404/405) WITHOUT CORS headers, so the browser
    // blocks the body and the studio only sees a misleading CORS error
    // instead of the real status. Attach the studio CORS headers to those so a
    // missing route surfaces as a clean 404 the frontend can read, not an
    // opaque network failure. (`WorkflowAgent`'s own `json()` responses already
    // carry CORS, so they fall straight through.)
    //
    // NEVER re-wrap a WebSocket upgrade: the 101 response carries the
    // `webSocket` handle, which `new Response(body, init)` drops, and workerd
    // rejects status 101 without it - the cloud monitor's `wss://` connect to
    // this same `/agents/workflow-agent/{id}` path would fail outright. CORS
    // does not apply to WebSockets anyway (browsers do not preflight them), so
    // there is nothing to attach. The SDK's own CORS helper skips upgrades for
    // exactly this reason.
    const isUpgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
    if (response && !isUpgrade && response.status !== 101 && !response.webSocket) {
      if (!response.headers.has('Access-Control-Allow-Origin')) {
        const headers = new Headers(response.headers);
        for (const [key, value] of Object.entries(cors)) headers.set(key, value);
        return new Response(response.body, { status: response.status, headers });
      }
    }
    return response;
  },

  // Cron. The telemetry retention pass prunes rollups past the 400 day window
  // and stale ingest rate windows; the cron itself is configured under
  // `env.hosted` only, since a BYO deployment has no `DB` and nothing to prune.
  //
  // The trailing `.catch()` is the containment: a rejected retention promise
  // must not surface as a Worker error, and a failed pass has to leave existing
  // rows in place and the ingest route answering normally.
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runTelemetryRetention(env as TelemetryEnv).catch(() => undefined));
    // Workflow backup tombstones past their 30 day window. Contained the same way
    // and for the same reason as the pass above: a rejected retention promise must
    // not surface as a Worker error, and a failed pass has to leave existing rows
    // in place for the next one. It is a no-op wherever the D1 or R2 binding is
    // absent, so a BYO worker with a cron never touches it.
    ctx.waitUntil(runBackupRetention(env as BackupRoutesEnv).catch(() => undefined));
  },
};
