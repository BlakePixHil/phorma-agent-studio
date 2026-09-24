/**
 * `POST /api/fetch` - reads one public web page for the studio's AI assistant
 * when it runs in a plain browser, where CORS blocks a direct fetch of almost
 * every site. The desktop app does the same job in Rust (`web_fetch.rs`), and
 * the two are kept to one contract:
 *
 *   request  `{ url: string, maxBytes?: number }`
 *   response `{ status, finalUrl, contentType, body, truncated }`
 *
 * The URL may be model-chosen, and a model can be steered by the pages it
 * reads, so the route is narrow on purpose:
 *
 *  - GET only, no caller headers, no cookies, no credentials forwarded.
 *  - {@link assertPublicHttpUrl} on the first URL AND on every redirect hop,
 *    because `fetch`'s automatic redirects would skip the guard.
 *  - Readable content types only, a byte cap, and a total timeout.
 *  - A per-owner rate limit, best-effort per isolate: the route spends no
 *    credits, so the limit exists to stop the worker being used as an open
 *    proxy, not to meter anything.
 */

import { assertPublicHttpUrl } from './data-host';

/** Redirect hops followed before giving up. */
export const WEB_FETCH_MAX_REDIRECTS = 5;
/** Total budget for one fetch, redirects and body included. */
export const WEB_FETCH_TIMEOUT_MS = 20_000;
/** Body cap when the caller declares none, and the accepted range. */
export const WEB_FETCH_DEFAULT_MAX_BYTES = 1024 * 1024;
const MIN_MAX_BYTES = 16 * 1024;
const MAX_MAX_BYTES = 2 * 1024 * 1024;
/** Requests one owner may make per window. */
export const WEB_FETCH_RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

const USER_AGENT = 'PhormaAgentStudio/1.0 (+https://phorma.dev) page-reader';
const ACCEPT =
  'text/html,application/xhtml+xml,text/plain;q=0.9,text/markdown;q=0.9,application/json;q=0.8,*/*;q=0.3';

/** The route's success body. */
export interface WebFetchResult {
  status: number;
  finalUrl: string;
  contentType: string | null;
  body: string;
  truncated: boolean;
}

/** A refusal the route answers with, never a thrown error. */
export interface WebFetchRefusal {
  error: string;
  status: number;
}

/** Mirrors `isReadableContentType` in `engine/src/web-fetch.ts`. */
function isReadableContentType(contentType: string | null): boolean {
  if (!contentType) return true;
  const bare = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    bare.startsWith('text/') ||
    [
      'application/xhtml+xml',
      'application/json',
      'application/ld+json',
      'application/xml',
      'application/rss+xml',
      'application/atom+xml',
    ].includes(bare)
  );
}

/** Validates a URL: http(s), no embedded credentials, public by hostname shape. */
function checkedUrl(raw: string): URL {
  assertPublicHttpUrl(raw, 'page URL');
  const url = new URL(raw);
  if (url.username || url.password) {
    throw new Error('Blocked page URL (embedded credentials are not allowed).');
  }
  return url;
}

/** Reads at most `cap` bytes of a body, decoding UTF-8 without a split character. */
async function readCapped(response: Response, cap: number): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) return { body: '', truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let body = '';
  let received = 0;
  let truncated = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const room = cap - received;
    if (value.byteLength > room) {
      body += decoder.decode(value.subarray(0, room), { stream: true });
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    received += value.byteLength;
    body += decoder.decode(value, { stream: true });
  }
  // A cut mid-character leaves the decoder holding a partial sequence; with
  // `stream: true` it was never emitted, so a final flush is only safe when
  // the body was read to its end.
  if (!truncated) body += decoder.decode();
  return { body, truncated };
}

/**
 * Fetches one public page. Returns a refusal (never throws) for anything the
 * caller should see as a 4xx/5xx from the route itself.
 */
export async function fetchPublicPage(
  rawUrl: string,
  options: { maxBytes?: number; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<WebFetchResult | WebFetchRefusal> {
  const cap = Math.max(
    MIN_MAX_BYTES,
    Math.min(Math.floor(options.maxBytes ?? WEB_FETCH_DEFAULT_MAX_BYTES), MAX_MAX_BYTES),
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? WEB_FETCH_TIMEOUT_MS);
  try {
    let current: URL;
    try {
      current = checkedUrl(rawUrl);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), status: 400 };
    }
    for (let hop = 0; hop <= WEB_FETCH_MAX_REDIRECTS; hop++) {
      let response: Response;
      try {
        response = await fetchImpl(current.href, {
          method: 'GET',
          redirect: 'manual',
          headers: { 'User-Agent': USER_AGENT, Accept: ACCEPT },
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return { error: `Timed out reading ${current.host}.`, status: 504 };
        }
        return {
          error: `Could not reach ${current.host}: ${error instanceof Error ? error.message : String(error)}`,
          status: 502,
        };
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location) {
          return { error: `${current.host} redirected without a Location header.`, status: 502 };
        }
        try {
          current = checkedUrl(new URL(location, current).href);
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error), status: 400 };
        }
        continue;
      }

      const contentType = response.headers.get('content-type');
      if (!isReadableContentType(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        const bare = contentType?.split(';')[0]?.trim() ?? 'binary';
        return { error: `${current.href} is ${bare}, not a readable page.`, status: 415 };
      }
      const { body, truncated } = await readCapped(response, cap);
      return { status: response.status, finalUrl: current.href, contentType, body, truncated };
    }
    return { error: `Too many redirects (more than ${WEB_FETCH_MAX_REDIRECTS}).`, status: 508 };
  } catch (error) {
    if (controller.signal.aborted) return { error: 'Timed out reading the page.', status: 504 };
    return { error: error instanceof Error ? error.message : String(error), status: 502 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sliding-window rate limit keyed by owner. Per isolate and in memory: a
 * best-effort brake on the route being used as an open proxy, which is the
 * only thing it is for.
 */
export class WebFetchRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit = WEB_FETCH_RATE_LIMIT,
    private readonly windowMs = RATE_WINDOW_MS,
  ) {}

  /** Records a request; false when the owner is over the limit. */
  allow(owner: string, now = Date.now()): boolean {
    const recent = (this.hits.get(owner) ?? []).filter(at => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(owner, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(owner, recent);
    // Keep the map from growing without bound across many owners.
    if (this.hits.size > 5_000) {
      for (const [key, times] of this.hits) {
        if (times.every(at => now - at >= this.windowMs)) this.hits.delete(key);
      }
    }
    return true;
  }
}
