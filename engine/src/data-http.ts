/**
 * HTTP request node: request construction, auth application, result selection
 * and pagination advance (design §5.1.1 to §5.1.3, P1-2 and P1-7).
 *
 * Pure and host-free. Nothing here opens a socket: `buildDataRequest` returns a
 * fully described {@link DataRequest} that the host's `DataFetcher` executes,
 * and every failure it can detect (empty url, non-http scheme, a `json` body
 * template that renders invalid JSON) is raised BEFORE any I/O so a malformed
 * step never costs a network call or a retry.
 *
 * Two invariants drive the shape of this module:
 *
 * 1. **Auth is host-applied and always wins.** Node data carries no secret and
 *    no `Authorization` value; {@link applyConnectionAuth} runs last, after user
 *    headers, and overwrites any header a template tried to set (Requirements
 *    8.5, 8.6).
 * 2. **Construction is deterministic.** Identical `(node.data, payload, cursor)`
 *    yields a byte-identical url, query string, header set and body — query
 *    entries keep their configured order and are percent-encoded exactly once
 *    (Requirement 8.4).
 */

import type { ResolvedConnection } from './connections.js';
import type { DataRequest } from './data-host.js';
import { interpolatePayload, mergePayloads, resolveJsonPath } from './payload.js';
import type { Redactor } from './redact.js';
import type { HttpMethod, HttpRequestNodeData, PaginationConfig, WorkflowNode } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Bounds and vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/** Methods the node may issue (mirrors {@link HttpMethod}). */
export const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

/** `Idempotency-Key` length cap after trimming (Requirement 8.8). */
export const MAX_IDEMPOTENCY_KEY_CHARS = 255;

/** Effective per-attempt timeout when `timeoutSec` is absent or out of range (8.20). */
export const DEFAULT_REQUEST_TIMEOUT_SEC = 30;

/** Accepted `timeoutSec` range, inclusive (8.20). */
export const MIN_REQUEST_TIMEOUT_SEC = 1;
export const MAX_REQUEST_TIMEOUT_SEC = 300;

/** Response byte cap applied when the node declares none (8.18). */
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Header name the connection owns outright, whatever a template says (8.6). */
const AUTHORIZATION = 'Authorization';

/**
 * Pagination position handed to {@link buildDataRequest}. One variant per
 * `PaginationConfig.mode`; `link-header` carries the server's own next url,
 * which already includes every query parameter.
 */
export type CursorState =
  | { mode: 'cursor'; param: string; value: string }
  | { mode: 'page'; pageParam: string; page: number; sizeParam?: string; pageSize?: number }
  | { mode: 'offset'; offsetParam: string; offset: number; limitParam: string; limit: number }
  | { mode: 'link-header'; url: string };

/** One query entry, key and value both still un-encoded. */
interface QueryEntry {
  readonly key: string;
  readonly value: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Redaction seeding (Requirement 2.13)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registers every resolved secret with the Redactor. Callers MUST invoke this
 * immediately after `ConnectionStore.resolve` and BEFORE constructing a request
 * or emitting any event, so a secret cannot reach a trace even if it later ends
 * up echoed in a response body.
 */
export function registerConnectionSecrets(
  redactor: Pick<Redactor, 'addLiterals'> | undefined,
  conn: ResolvedConnection | undefined,
): void {
  if (!redactor || !conn) return;
  const values = Object.values(conn.secrets ?? {}).filter((value): value is string => typeof value === 'string');
  if (values.length > 0) redactor.addLiterals(values);
}

// ─────────────────────────────────────────────────────────────────────────────
// §5.1.1 Request construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the outbound request for an `http-request` node.
 *
 * The ONLY place where connection secrets enter a request, and they enter as
 * host-applied auth — never through a user template.
 *
 * Throws (before any I/O) when the url is empty, is relative with no connection
 * `baseUrl`, resolves to a scheme other than http/https, or when `bodyMode` is
 * `json` and the rendered body does not parse.
 */
export function buildDataRequest(
  node: WorkflowNode,
  payload: string,
  conn?: ResolvedConnection,
  cursor?: CursorState,
): DataRequest {
  const data = node.data as HttpRequestNodeData;
  const method = resolveMethod(data.method);

  const headers: Record<string, string> = {};
  const body = renderBody(data, payload, headers);

  // User headers land second so a template can set Content-Type or Accept, but
  // never Authorization: that name belongs to the connection alone.
  for (const entry of data.headers ?? []) {
    const key = (entry?.key ?? '').trim();
    if (key.length === 0) continue;
    if (key.toLowerCase() === AUTHORIZATION.toLowerCase()) continue;
    setHeader(headers, key, interpolatePayload(entry.value ?? '', payload));
  }

  const idempotencyKey = interpolatePayload(data.idempotencyKey ?? '', payload).trim();
  if (idempotencyKey.length > 0 && idempotencyKey.length <= MAX_IDEMPOTENCY_KEY_CHARS) {
    setHeader(headers, 'Idempotency-Key', idempotencyKey);
  }

  const request: DataRequest = {
    url: resolveUrl(data, payload, conn, cursor),
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    timeoutMs: resolveTimeoutSec(data.timeoutSec) * 1000,
    maxResponseBytes: resolveMaxResponseBytes(data),
  };

  // Auth last: it wins over every user header and every user query entry.
  return applyConnectionAuth(request, conn);
}

/** Applies the connection's auth mode to an already-constructed request. */
export function applyConnectionAuth(request: DataRequest, conn?: ResolvedConnection): DataRequest {
  if (!conn) return request;
  const auth = conn.auth;
  if (!auth || auth.mode === 'none') return request;

  const headers = { ...request.headers };
  let url = request.url;

  switch (auth.mode) {
    case 'bearer':
      setHeader(headers, AUTHORIZATION, `Bearer ${secretOf(conn, auth.secretKey)}`);
      break;
    case 'basic': {
      const user = secretOf(conn, auth.userSecretKey);
      const password = secretOf(conn, auth.passwordSecretKey);
      setHeader(headers, AUTHORIZATION, `Basic ${base64(`${user}:${password}`)}`);
      break;
    }
    case 'basic-token': {
      // The secret already holds the full base64 credential string
      // (e.g. from an external system that issued a Basic token). Send it
      // verbatim under the Authorization header.
      setHeader(headers, AUTHORIZATION, `Basic ${secretOf(conn, auth.tokenSecretKey)}`);
      break;
    }
    case 'header': {
      const name = (auth.header ?? '').trim();
      if (name.length === 0) {
        throw new Error(`Connection "${conn.id}" uses header auth but declares no header name.`);
      }
      setHeader(headers, name, `${auth.prefix ?? ''}${secretOf(conn, auth.secretKey)}`);
      break;
    }
    case 'query': {
      const param = (auth.param ?? '').trim();
      if (param.length === 0) {
        throw new Error(`Connection "${conn.id}" uses query auth but declares no parameter name.`);
      }
      url = appendQuery(stripQueryParam(url, param), [{ key: param, value: secretOf(conn, auth.secretKey) }]);
      break;
    }
    case 'oauth2-client-credentials':
    case 'oauth2-refresh':
      // Acquisition, single-flight refresh and rotation are the HOST's job; it
      // injects the live token under `secrets.accessToken` (design §7).
      setHeader(headers, AUTHORIZATION, `Bearer ${secretOf(conn, 'accessToken')}`);
      break;
    case 'aws-sigv4':
      // Request signing is a host capability (Phase 2 shares it). Reaching here
      // means no host signer ran, which must not produce an unsigned request.
      throw new Error(
        `Connection "${conn.id}" requires AWS SigV4 signing, which this host cannot apply to an HTTP Request step.`,
      );
    default: {
      const exhaustive: never = auth;
      throw new Error(`Unsupported connection auth mode: ${JSON.stringify(exhaustive)}`);
    }
  }

  return { ...request, url, headers };
}

// ─────────────────────────────────────────────────────────────────────────────
// §5.1.2 Result selection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Selects what leaves the node: `resultPath` picks a value out of the parsed
 * response (a resolved `null` counts as present), then `resultKey` shallow-merges
 * it into the incoming payload using the same semantics as `mergePayloads`, so
 * downstream `{{field}}` interpolation keeps working on the original fields.
 *
 * Throws when `resultPath` resolves to no value (Requirement 8.14).
 */
export function selectResult(data: HttpRequestNodeData, parsed: unknown, payload = ''): string {
  const path = (data.resultPath ?? '').trim();
  const value = path.length > 0 ? resolveJsonPath(parsed, path) : parsed;
  if (value === undefined) {
    throw new Error(`Response has no value at "${path}".`);
  }

  const key = (data.resultKey ?? '').trim();
  const selected = JSON.stringify(value) ?? 'null';
  if (key.length === 0) return selected;

  return mergePayloads(payload, JSON.stringify({ [key]: value }));
}

// ─────────────────────────────────────────────────────────────────────────────
// §5.1.3 Pagination (P1-7)
// ─────────────────────────────────────────────────────────────────────────────

/** Effective page cap when `maxPages` is absent or out of range (9.2). */
export const DEFAULT_MAX_PAGES = 100;

/** Accepted `maxPages` range, inclusive (9.2). */
export const MIN_MAX_PAGES = 1;
export const MAX_MAX_PAGES = 1000;

/** Pagination modes the node accepts; anything else is treated as `none` (9.1). */
export const PAGINATION_MODES = ['none', 'cursor', 'page', 'offset', 'link-header'] as const;

/** A pagination configuration that actually loops. */
export type PaginatingConfig = Exclude<PaginationConfig, { mode: 'none' }>;

/** The `page-fetched` event body, one per accumulated page (9.4). */
export interface PageFetched {
  /** One-based page number of the response just accumulated. */
  readonly page: number;
  /** Item count contributed by that page. */
  readonly items: number;
  /** True only when that response yielded a next pagination value. */
  readonly hasMore: boolean;
}

/** What {@link PaginationLoop.accept} tells the caller about one page. */
export interface PageOutcome {
  /** Emit exactly this, once, as the `page-fetched` payload. */
  readonly event: PageFetched;
  /** The items this page contributed, in response order. */
  readonly items: readonly unknown[];
  /** Cursor for the next request, or `undefined` when the loop must stop. */
  readonly nextCursor: CursorState | undefined;
  /** True when no further request may be issued. */
  readonly done: boolean;
}

/**
 * Bookkeeping for a paginated fetch: the cursor to request next, the pages
 * completed so far, the accumulated items and the stop decision.
 *
 * The loop terminates for three reasons, all checked without issuing a request:
 * the response yielded no next pagination value, the next value repeats one
 * already requested (a server pinning its cursor cannot spin the run — 9.5), or
 * the completed page count reached the effective `maxPages` (9.2, 9.7).
 */
export interface PaginationLoop {
  /** Effective page cap for this node. */
  readonly maxPages: number;
  /** Cursor for the next request; `undefined` on the first page of most modes. */
  readonly cursor: CursorState | undefined;
  /** Pages accumulated so far. */
  readonly pages: number;
  /** Every item of pages `1..pages`, in fetch order. */
  readonly items: readonly unknown[];
  /** True once no further request may be issued. */
  readonly done: boolean;
  /** True while another request is allowed. */
  canRequest(): boolean;
  /** Accumulates one parsed response and advances the cursor. */
  accept(parsed: unknown, headers?: Record<string, string>): PageOutcome;
  /** The value handed to {@link selectResult} once the loop stopped (9.14). */
  result(): { items: unknown[]; pages: number };
}

/** True when the configuration loops rather than issuing a single request. */
export function isPaginated(pagination?: PaginationConfig): pagination is PaginatingConfig {
  const mode = (pagination as { mode?: unknown } | undefined)?.mode;
  return typeof mode === 'string' && mode !== 'none' && (PAGINATION_MODES as readonly string[]).includes(mode);
}

/**
 * Resolves the effective page cap: node data when `maxPages` is an integer in
 * 1..1000, otherwise 100. Mode `none` issues exactly one request (9.12).
 */
export function maxPagesOf(pagination?: PaginationConfig): number {
  if (!isPaginated(pagination)) return 1;
  const declared = (pagination as { maxPages?: unknown }).maxPages;
  return Number.isInteger(declared) && (declared as number) >= MIN_MAX_PAGES && (declared as number) <= MAX_MAX_PAGES
    ? (declared as number)
    : DEFAULT_MAX_PAGES;
}

/**
 * The cursor for the FIRST request (9.13).
 *
 * `cursor` and `link-header` start with no cursor at all — the first page is the
 * configured url untouched — while `page` starts at `startPage ?? 1` and
 * `offset` starts at offset 0, both of which must appear on that first request.
 */
export function initialCursor(pagination?: PaginationConfig): CursorState | undefined {
  if (!isPaginated(pagination)) return undefined;
  switch (pagination.mode) {
    case 'page': {
      const start = Number.isInteger(pagination.startPage) ? (pagination.startPage as number) : 1;
      return {
        mode: 'page',
        pageParam: pagination.pageParam,
        page: start,
        ...(pagination.sizeParam ? { sizeParam: pagination.sizeParam } : {}),
        ...(Number.isFinite(pagination.pageSize) ? { pageSize: pagination.pageSize as number } : {}),
      };
    }
    case 'offset':
      return {
        mode: 'offset',
        offsetParam: pagination.offsetParam,
        offset: 0,
        limitParam: pagination.limitParam,
        limit: pageLimitOf(pagination.limit),
      };
    default:
      // 'cursor' sends no cursor parameter on page one; 'link-header' follows the
      // server's own link, which only exists once a response arrived.
      return undefined;
  }
}

/**
 * Resolves the items a page contributed (9.3).
 *
 * An absent or `null` value counts as zero items; anything that is neither an
 * array nor absent fails the node with a message naming `itemsPath`, because
 * silently dropping a page would understate the sync.
 */
export function pageItems(pagination: PaginatingConfig, parsed: unknown): readonly unknown[] {
  const path = (pagination.itemsPath ?? '').trim();
  const value = path.length === 0 ? parsed : resolveJsonPath(parsed, path);
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      `Pagination itemsPath "${path}" resolved to ${typeof value === 'object' ? 'an object' : `a ${typeof value}`}, not an array.`,
    );
  }
  return value;
}

/**
 * Computes the cursor for the next request, or `undefined` when the response
 * says this was the last page (9.5, 9.6, 9.13).
 */
export function nextCursorFrom(
  pagination: PaginationConfig | undefined,
  parsed: unknown,
  headers: Record<string, string> | undefined,
  current: CursorState | undefined,
): CursorState | undefined {
  if (!isPaginated(pagination)) return undefined;

  switch (pagination.mode) {
    case 'cursor': {
      const next = cursorValueOf(resolveJsonPath(parsed, (pagination.cursorPath ?? '').trim()));
      return next === undefined ? undefined : { mode: 'cursor', param: pagination.cursorParam, value: next };
    }
    case 'page': {
      // A page yielding nothing is the end of the collection.
      if (pageItems(pagination, parsed).length === 0) return undefined;
      const page = current?.mode === 'page' ? current.page : initialPageOf(pagination);
      return { ...(initialCursor(pagination) as CursorState & { mode: 'page' }), page: page + 1 };
    }
    case 'offset': {
      const limit = pageLimitOf(pagination.limit);
      // A short page means the server had nothing more to give.
      if (pageItems(pagination, parsed).length < limit) return undefined;
      const offset = current?.mode === 'offset' ? current.offset : 0;
      return {
        mode: 'offset',
        offsetParam: pagination.offsetParam,
        offset: offset + limit,
        limitParam: pagination.limitParam,
        limit,
      };
    }
    default: {
      const next = parseLinkHeader(headerValue(headers, 'link'), pagination.rel);
      return next === undefined ? undefined : { mode: 'link-header', url: next };
    }
  }
}

/**
 * Extracts the url of the link whose relation matches `rel` (default `next`)
 * from an RFC 5988 `Link` header (9.13).
 *
 * Commas and semicolons inside `<...>` and inside quoted parameter values are
 * not separators, so a next url carrying its own comma survives intact.
 */
export function parseLinkHeader(value: string | undefined, rel?: string): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const target = ((rel ?? '').trim() || 'next').toLowerCase();

  for (const entry of splitOutsideQuotes(value, ',')) {
    const match = /^\s*<([^>]*)>([\s\S]*)$/.exec(entry);
    if (!match) continue;
    const url = (match[1] ?? '').trim();
    if (url.length === 0) continue;
    if (linkRelations(match[2] ?? '').includes(target)) return url;
  }
  return undefined;
}

/**
 * Identity of a cursor, used to detect a server that keeps handing back the
 * position it just served. Two cursors with the same key address the same page,
 * so requesting the second would repeat the first.
 */
export function cursorKey(cursor: CursorState | undefined): string {
  if (!cursor) return 'start';
  switch (cursor.mode) {
    case 'cursor':
      return `cursor:${cursor.param}=${cursor.value}`;
    case 'page':
      return `page:${cursor.pageParam}=${cursor.page}`;
    case 'offset':
      return `offset:${cursor.offsetParam}=${cursor.offset}`;
    default:
      return `link:${cursor.url}`;
  }
}

/**
 * Creates the loop state for one `http-request` execution.
 *
 * Usage mirrors design §5.1: while `canRequest()`, build a request with
 * `loop.cursor`, fetch it, then `accept(parsed, headers)` and emit the returned
 * `event` as `page-fetched`. When `done` is true no further request may be
 * issued and `result()` is the value `selectResult` receives.
 */
export function createPaginationLoop(pagination?: PaginationConfig): PaginationLoop {
  const config = isPaginated(pagination) ? pagination : undefined;
  const maxPages = maxPagesOf(pagination);

  let cursor = initialCursor(pagination);
  let pages = 0;
  let done = false;
  const items: unknown[] = [];
  // Every cursor already requested. A cursor that reappears would replay a page
  // we have, which is exactly how a pinned-cursor server spins a run forever.
  const requested = new Set<string>([cursorKey(cursor)]);

  const loop: PaginationLoop = {
    get maxPages() {
      return maxPages;
    },
    get cursor() {
      return cursor;
    },
    get pages() {
      return pages;
    },
    get items() {
      return items;
    },
    get done() {
      return done;
    },
    canRequest() {
      return !done && pages < maxPages;
    },
    accept(parsed: unknown, headers?: Record<string, string>): PageOutcome {
      if (!config) {
        throw new Error('This step is not paginated; accumulate no pages for pagination mode "none".');
      }
      if (done) {
        throw new Error('This paginated fetch already stopped; accept no further page.');
      }

      const pageOfItems = pageItems(config, parsed);
      items.push(...pageOfItems);
      pages += 1;

      const nextCursor = nextCursorFrom(config, parsed, headers, cursor);
      // `hasMore` describes the RESPONSE, not our decision to stop: a fetch that
      // halts at `maxPages` still reports that data remained (9.7).
      const hasMore = nextCursor !== undefined;
      const advancing = nextCursor !== undefined && !requested.has(cursorKey(nextCursor));

      if (advancing) {
        cursor = nextCursor;
        requested.add(cursorKey(nextCursor));
      }
      done = !advancing || pages >= maxPages;

      return {
        event: { page: pages, items: pageOfItems.length, hasMore },
        items: pageOfItems,
        nextCursor: advancing ? nextCursor : undefined,
        done,
      };
    },
    result() {
      return { items: [...items], pages };
    },
  };

  return loop;
}

// ── pagination helpers ───────────────────────────────────────────────────────

/** First page number for mode `page`: `startPage` when an integer, else 1. */
function initialPageOf(pagination: PaginatingConfig & { mode: 'page' }): number {
  return Number.isInteger(pagination.startPage) ? (pagination.startPage as number) : 1;
}

/** A usable `limit` for mode `offset`; a non-positive limit would never advance. */
function pageLimitOf(limit: unknown): number {
  return Number.isInteger(limit) && (limit as number) > 0 ? (limit as number) : 1;
}

/**
 * A cursor value usable in a query parameter. Strings and finite numbers pass;
 * empty, absent, boolean and structural values mean "no next page" rather than
 * an `[object Object]` request.
 */
function cursorValueOf(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Reads a header case-insensitively from a host's (lower-cased) header map. */
function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const direct = headers[name];
  if (typeof direct === 'string') return direct;
  const lower = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === lower)?.[1];
}

/** The relation tokens of one `Link` entry's parameters, lower-cased. */
function linkRelations(params: string): string[] {
  for (const param of splitOutsideQuotes(params, ';')) {
    const eq = param.indexOf('=');
    if (eq < 0) continue;
    if (param.slice(0, eq).trim().toLowerCase() !== 'rel') continue;
    return unquote(param.slice(eq + 1).trim())
      .split(/\s+/)
      .filter((token) => token.length > 0)
      .map((token) => token.toLowerCase());
  }
  return [];
}

/** Splits on `separator`, ignoring separators inside `<...>` or `"..."`. */
function splitOutsideQuotes(input: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angled = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string;
    if (quoted) {
      current += char;
      if (char === '\\' && index + 1 < input.length) {
        current += input[index + 1] as string;
        index += 1;
      } else if (char === '"') {
        quoted = false;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      current += char;
      continue;
    }
    if (char === '<') angled = true;
    else if (char === '>') angled = false;
    else if (char === separator && !angled) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** Removes surrounding quotes and backslash escapes from a parameter value. */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// URL, query and body helpers
// ─────────────────────────────────────────────────────────────────────────────

function resolveMethod(method: unknown): HttpMethod {
  const upper = typeof method === 'string' ? method.trim().toUpperCase() : '';
  const found = HTTP_METHODS.find((candidate) => candidate === upper);
  if (!found) {
    throw new Error(
      `Unsupported HTTP method "${String(method ?? '')}": expected one of ${HTTP_METHODS.join(', ')}.`,
    );
  }
  return found;
}

/**
 * Interpolates the url, joins it to the connection base when relative, then
 * appends the configured query entries followed by the pagination entries.
 *
 * A `link-header` cursor replaces the url outright: the server's next link
 * already carries every parameter, so re-appending `data.query` would duplicate
 * them.
 */
function resolveUrl(
  data: HttpRequestNodeData,
  payload: string,
  conn: ResolvedConnection | undefined,
  cursor: CursorState | undefined,
): string {
  if (cursor?.mode === 'link-header') {
    return assertHttpUrl(cursor.url.trim(), 'pagination next link');
  }

  const rendered = interpolatePayload(data.url ?? '', payload).trim();
  if (rendered.length === 0) {
    throw new Error('HTTP Request url is empty after interpolation.');
  }

  if (rendered.startsWith('//')) {
    // Protocol-relative: no scheme to check and nothing sane to join it to.
    throw new Error(`HTTP Request url "${rendered}" is not an http or https url.`);
  }

  let absolute: string;
  if (schemeOf(rendered) !== undefined) {
    absolute = assertHttpUrl(rendered, 'url');
  } else {
    const baseUrl = (conn?.config?.['baseUrl'] ?? '').trim();
    if (baseUrl.length === 0) {
      throw new Error(
        `HTTP Request url "${rendered}" is relative and no connection base url is available.`,
      );
    }
    absolute = joinUrl(assertHttpUrl(baseUrl, 'connection base url'), rendered);
  }

  const entries = [...configuredQuery(data, payload), ...cursorQuery(cursor)];
  return appendQuery(absolute, entries);
}

/** True-ish scheme detector: returns the scheme when the url carries one. */
function schemeOf(url: string): string | undefined {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url);
  return match ? (match[1] as string).toLowerCase() : undefined;
}

function assertHttpUrl(url: string, label: string): string {
  const scheme = schemeOf(url);
  if (scheme !== 'http' && scheme !== 'https') {
    throw new Error(`HTTP Request ${label} "${url}" is not an http or https url.`);
  }
  try {
    // Reject anything the platform cannot parse (missing host, bad port).
    new URL(url);
  } catch {
    throw new Error(`HTTP Request ${label} "${url}" is not a valid absolute url.`);
  }
  return url;
}

/**
 * Joins a base and a relative path with exactly one `/` between them: a trailing
 * `/` on the base and a leading `/` on the path collapse into that single
 * separator (Requirement 8.3). A query or fragment on the base is dropped, since
 * a relative path replaces it.
 */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.split('#')[0]?.split('?')[0] ?? baseUrl;
  const trimmedBase = base.replace(/\/+$/, '');
  const trimmedPath = path.replace(/^\/+/, '');
  if (trimmedPath.length === 0) return `${trimmedBase}/`;
  return `${trimmedBase}/${trimmedPath}`;
}

function configuredQuery(data: HttpRequestNodeData, payload: string): QueryEntry[] {
  const entries: QueryEntry[] = [];
  for (const entry of data.query ?? []) {
    const key = (entry?.key ?? '').trim();
    if (key.length === 0) continue;
    entries.push({ key, value: interpolatePayload(entry.value ?? '', payload) });
  }
  return entries;
}

function cursorQuery(cursor: CursorState | undefined): QueryEntry[] {
  if (!cursor) return [];
  switch (cursor.mode) {
    case 'cursor':
      return cursor.param.trim().length === 0 ? [] : [{ key: cursor.param, value: cursor.value }];
    case 'page': {
      const entries: QueryEntry[] = [{ key: cursor.pageParam, value: String(cursor.page) }];
      if (cursor.sizeParam && cursor.pageSize !== undefined) {
        entries.push({ key: cursor.sizeParam, value: String(cursor.pageSize) });
      }
      return entries;
    }
    case 'offset':
      return [
        { key: cursor.offsetParam, value: String(cursor.offset) },
        { key: cursor.limitParam, value: String(cursor.limit) },
      ];
    default:
      return [];
  }
}

/** Appends entries in order, percent-encoding each key and value exactly once. */
export function appendQuery(url: string, entries: readonly QueryEntry[]): string {
  if (entries.length === 0) return url;
  const rendered = entries.map((entry) => `${encodeOnce(entry.key)}=${encodeOnce(entry.value)}`).join('&');
  const [withoutFragment, ...fragment] = url.split('#');
  const head = withoutFragment ?? url;
  const separator = !head.includes('?') ? '?' : head.endsWith('?') || head.endsWith('&') ? '' : '&';
  const joined = `${head}${separator}${rendered}`;
  return fragment.length > 0 ? `${joined}#${fragment.join('#')}` : joined;
}

/**
 * Percent-encodes exactly once: an already-encoded `%XX` sequence survives
 * unchanged rather than becoming `%25XX` (Requirement 8.4), so decoding the
 * built parameter returns the configured value.
 */
export function encodeOnce(value: string): string {
  return encodeURIComponent(value).replace(/%25([0-9A-Fa-f]{2})/g, (_match, hex: string) => `%${hex}`);
}

/** Removes every occurrence of `param` from the url's query string. */
function stripQueryParam(url: string, param: string): string {
  const hashAt = url.indexOf('#');
  const fragment = hashAt >= 0 ? url.slice(hashAt) : '';
  const head = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const queryAt = head.indexOf('?');
  if (queryAt < 0) return url;

  const target = encodeOnce(param);
  const kept = head
    .slice(queryAt + 1)
    .split('&')
    .filter((pair) => pair.length > 0)
    .filter((pair) => {
      const key = pair.split('=')[0] ?? '';
      return key !== param && key !== target;
    });
  const base = head.slice(0, queryAt);
  return kept.length === 0 ? `${base}${fragment}` : `${base}?${kept.join('&')}${fragment}`;
}

/**
 * Renders the body and seeds the matching `Content-Type`. For `bodyMode: 'json'`
 * the rendered text must parse, otherwise this throws before any network call —
 * a malformed template is a design error, not a 400 from the target
 * (Requirement 8.7).
 */
function renderBody(
  data: HttpRequestNodeData,
  payload: string,
  headers: Record<string, string>,
): string | undefined {
  const mode = data.bodyMode ?? 'none';
  if (mode === 'none') return undefined;

  const rendered = interpolatePayload(data.body ?? '', payload);
  switch (mode) {
    case 'json':
      try {
        JSON.parse(rendered);
      } catch (error) {
        throw new Error(
          `HTTP Request body template did not render valid JSON: ${
            error instanceof Error ? error.message : 'parse failed'
          }`,
        );
      }
      setHeader(headers, 'Content-Type', 'application/json');
      return rendered;
    case 'form':
      setHeader(headers, 'Content-Type', 'application/x-www-form-urlencoded');
      return rendered;
    default:
      setHeader(headers, 'Content-Type', 'text/plain; charset=utf-8');
      return rendered;
  }
}

/**
 * Sets a header case-insensitively: any existing entry differing only in case is
 * removed first, so "auth applied last wins" holds even when a template used
 * `authorization` and the connection uses `Authorization`.
 */
function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase();
  for (const existing of Object.keys(headers)) {
    if (existing !== name && existing.toLowerCase() === lower) delete headers[existing];
  }
  headers[name] = value;
}

function resolveTimeoutSec(timeoutSec: unknown): number {
  return Number.isInteger(timeoutSec) &&
    (timeoutSec as number) >= MIN_REQUEST_TIMEOUT_SEC &&
    (timeoutSec as number) <= MAX_REQUEST_TIMEOUT_SEC
    ? (timeoutSec as number)
    : DEFAULT_REQUEST_TIMEOUT_SEC;
}

/** Node-declared cap when present and positive, otherwise the 4 MiB default. */
function resolveMaxResponseBytes(data: HttpRequestNodeData): number {
  const declared = (data as { maxResponseBytes?: unknown }).maxResponseBytes;
  return Number.isInteger(declared) && (declared as number) > 0
    ? (declared as number)
    : DEFAULT_MAX_RESPONSE_BYTES;
}

/** Reads a declared secret, failing loudly rather than sending an empty credential. */
function secretOf(conn: ResolvedConnection, secretKey: string): string {
  const value = conn.secrets?.[secretKey];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Connection "${conn.id}" is missing the secret value "${secretKey}".`);
  }
  return value;
}

/** Base64 without a runtime dependency: `btoa` where present, else `Buffer`. */
function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const globals = globalThis as { btoa?: (input: string) => string };
  if (typeof globals.btoa === 'function') {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return globals.btoa(binary);
  }
  const nodeBuffer = (globalThis as { Buffer?: { from(input: Uint8Array): { toString(enc: string): string } } })
    .Buffer;
  if (nodeBuffer) return nodeBuffer.from(bytes).toString('base64');
  throw new Error('This host provides no base64 encoder for basic authentication.');
}
