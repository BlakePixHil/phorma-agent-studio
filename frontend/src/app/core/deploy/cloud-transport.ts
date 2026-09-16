/**
 * The Cloud_Transport seam - how a request reaches a deployed runtime.
 *
 * There is exactly ONE implementation per credential model, never one per
 * endpoint:
 *
 * - `fetch-bearer` - `fetch` plus an `Authorization: Bearer` header. Serves
 *   both Cloudflare targets (Phorma Cloud and BYO Cloudflare).
 * - `aws-cli` - the signed request the `phorma-aws request` verb makes, because
 *   an AWS_IAM-authorized API Gateway route needs SigV4 and the webview holds no
 *   AWS credentials.
 *
 * WHICH endpoint is being called is the endpoint registry's business
 * (`CloudEndpoints` in `deploy-targets.ts`); HOW the bytes travel is this
 * seam's. Keeping the two apart is what lets a new host add a route table
 * without touching transport code, and a new credential model add a transport
 * without touching the route tables.
 *
 * A leaf module: pure types, no `inject`, no Angular import, nothing to
 * construct. `CloudService` may import it without widening the known
 * `RunControllerService -> ModelTransportService -> PhormaCloudService ->
 * CloudService` DI cycle.
 *
 * Feature: aws-byo-deploy
 * Requirements: 12.4, 12.6
 */

/** The HTTP methods any declared endpoint may use. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * One transport answer, deliberately un-parsed.
 *
 * The body stays a string so a transport never has to know which endpoint it
 * carried: parsing and per-host reshaping belong to `CloudEndpointSpec.unwrap`.
 * `ok` is carried explicitly rather than derived, because the AWS transport
 * learns success from a CLI exit code and a status line rather than from a
 * `Response`.
 */
export interface CloudTransportResponse {
  status: number;
  ok: boolean;
  body: string;
}

/**
 * What a dispatch may add to one request.
 *
 * `headers` carries per-ENDPOINT headers only, never the credential: a transport
 * owns its own `Authorization`, and letting a route table set that would put the
 * credential model back in the endpoint registry. It exists because optimistic
 * concurrency on a backup upload travels as `If-Match` (Requirement 16.2), which
 * is a property of the endpoint rather than of how the bytes get there.
 */
export interface CloudTransportInit {
  method: HttpMethod;
  body?: string;
  headers?: Readonly<Record<string, string>>;
}

/** The seam. One implementation per credential model, never per endpoint. */
export interface CloudTransport {
  readonly id: 'fetch-bearer' | 'aws-cli';
  send(url: string, init: CloudTransportInit): Promise<CloudTransportResponse>;
  /**
   * The URL the monitor WebSocket should open for `workflowId`.
   *
   * Asynchronous because the AWS side has to presign it, and the Cloudflare
   * side has to resolve a fresh Clerk token. `instanceBase` is the
   * already-resolved instance URL, so this never re-derives a path shape.
   */
  monitorSocketUrl(instanceBase: string, workflowId: string): Promise<string>;
}
