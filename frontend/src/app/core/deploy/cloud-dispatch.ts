/**
 * The dispatcher that turns a {@link CloudOperation} into one transport call.
 *
 * Extracted out of `CloudService` because there is now a SECOND caller that must
 * not go through it: `DeploymentsService` and the backup service both talk to
 * Phorma Cloud regardless of which deploy target the user has chosen, while
 * `CloudService` dispatches against `settings.cloudProvider()`. A subscriber
 * deploying to AWS still has a Phorma Cloud account, so routing their deployment
 * list or their backup upload through the provider-dependent dispatcher would
 * send it to the wrong host - or to no route at all.
 *
 * Keeping ONE dispatcher and parameterising the route table plus the base-URL
 * resolver is what stops those two paths drifting: reshaping, unwrapping and the
 * three-outcome failure contract are described here once.
 *
 * A leaf module, like `deploy-targets.ts` and `cloud-transport.ts`: pure
 * functions, no `inject`, no Angular import. Safe for anything to import
 * without widening the known `RunControllerService -> ModelTransportService ->
 * PhormaCloudService -> CloudService` DI cycle.
 */

import type { CloudTransport } from './cloud-transport';
import type { CloudEndpointContext, CloudEndpoints, CloudOperation } from './deploy-targets';

/** An HTTP answer the target rejected, with the host's own message. */
export interface CloudCallFailure {
  ok: false;
  status: number;
  /** The host's own `error` message, or null when it sent none. */
  hostError: string | null;
  /** `hostError`, or `HTTP <status>` - the message most callers surface. */
  error: string;
  /** The parsed failure body, for the caller that reads another field. */
  detail: unknown;
}

/**
 * One dispatched endpoint call.
 *
 * `'unsupported'` is a first-class outcome, not an error: the target declares no
 * route for the operation, or its base URL is not configured yet, and the caller
 * resolves that to the operation's documented absent value (Requirement 12.6).
 */
export type CloudCallResult<T> =
  | { ok: true; status: number; value: T }
  | CloudCallFailure
  | { ok: 'unsupported' };

/**
 * How a dispatch resolves the base URL for each endpoint scope.
 *
 * Two functions rather than one string because the two scopes resolve
 * differently: a root endpoint hangs off the worker origin, an instance endpoint
 * off a per-workflow path the target's registry entry shapes.
 */
export interface CloudScopeResolver {
  /** Base for a `scope: 'root'` endpoint. Empty means unreachable. */
  root(): string;
  /** Base for a `scope: 'instance'` endpoint. Null means unreachable. */
  instance(workflowId: string): string | null;
}

/** A body parsed leniently, as `response.json().catch(() => null)` does. */
export function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/** The host's own `error` message, or null when the body carries none. */
export function readErrorMessage(detail: unknown): string | null {
  const value = (detail as { error?: unknown } | null | undefined)?.error;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Dispatches one logical operation against a route table.
 *
 * Everything host-specific is data: the table supplies the method, the scope,
 * the path, the request-body reshaper and the response unwrapper, and the
 * {@link CloudTransport} seam supplies the credential model. Nothing here knows
 * which host it is talking to.
 *
 * A transport failure THROWS, exactly as `fetch` does, because
 * `CloudTransportResponse` describes an HTTP answer and has no failure variant.
 * So does an unparseable SUCCESS body - a 200 that is not JSON is a broken host,
 * not a value to hand on - while a failure body is parsed leniently, because the
 * status is already the answer and the body is only extra detail.
 */
export async function dispatchCloudOperation<T>(
  endpoints: CloudEndpoints,
  transport: CloudTransport,
  scope: CloudScopeResolver,
  op: CloudOperation,
  ctx: CloudEndpointContext,
  payload?: unknown,
): Promise<CloudCallResult<T>> {
  const endpoint = endpoints[op];
  if (!endpoint) return { ok: 'unsupported' };

  const base = endpoint.scope === 'instance' ? scope.instance(ctx.workflowId) : scope.root();
  if (!base) return { ok: 'unsupported' };

  // A declared `body` reshaper is also the marker for "this endpoint sends a
  // request body": the read routes declare none and send none.
  const requestBody = endpoint.body?.(payload, ctx);
  const headers = endpoint.headers?.(ctx);
  const response = await transport.send(`${base}${endpoint.path(ctx)}`, {
    method: endpoint.method,
    body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
  });

  if (!response.ok) {
    const detail = parseJsonBody(response.body);
    const hostError = readErrorMessage(detail);
    return {
      ok: false,
      status: response.status,
      hostError,
      error: hostError ?? `HTTP ${response.status}`,
      detail,
    };
  }

  const parsed = JSON.parse(response.body) as unknown;
  return {
    ok: true,
    status: response.status,
    value: (endpoint.unwrap ? endpoint.unwrap(parsed) : parsed) as T,
  };
}
