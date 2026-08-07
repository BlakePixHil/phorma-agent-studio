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
 */

import { routeAgentRequest } from 'agents';

import { verifyBearer, verifyRequest, isHosted } from './auth';
import { handleApiRequest, type ApiEnv } from './api';
import { handleReleaseRequest, type ReleaseEnv } from './releases';
import { handlePortalEmbedScript, handlePortalRequest } from './portal';
import { PortalIndex } from './portal-registry';
import { WorkflowAgent, type Env } from './workflow-agent';

// Both Durable Object classes must be exported for their bindings to resolve.
export { WorkflowAgent, PortalIndex };

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

    return (
      (await routeAgentRequest(routed, env)) ??
      new Response('Phorma Agent Studio cloud runtime. POST /agents/workflow-agent/{id}/trigger', {
        status: 404,
        headers: cors,
      })
    );
  },
};
