/**
 * `POST /api/fetch`'s page reader (`src/web-fetch.ts`) and the `/api/infer`
 * body helpers that forward a reasoning request.
 *
 * No network: `fetch` is a stub, so the properties under test are the guard
 * ones - a private URL never dispatches, a redirect to a private address is
 * refused BEFORE it is followed, binary content is refused, the body is capped
 * without splitting a character, and the rate limiter brakes one owner without
 * touching another.
 *
 * Run: npx -y tsx cloud/test/web-fetch.test.mjs
 */

import {
  WEB_FETCH_MAX_REDIRECTS,
  WebFetchRateLimiter,
  fetchPublicPage,
} from '../src/web-fetch.ts';

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

/** A fetch stub answering from a route table and recording every URL it saw. */
function stubFetch(routes) {
  const seen = [];
  const impl = async (url, init) => {
    seen.push({ url, init });
    const route = routes[url];
    if (!route) throw new TypeError(`no stub for ${url}`);
    return typeof route === 'function' ? route() : route;
  };
  return { impl, seen };
}

const html = (body, headers = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
const redirect = (location, status = 302) => new Response(null, { status, headers: { location } });

console.log('\nThe SSRF guard');
{
  for (const url of [
    'http://127.0.0.1/',
    'http://localhost:8787/api/me',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.5/',
    'http://printer.local/',
    'file:///etc/passwd',
    'https://user:pass@example.com/',
  ]) {
    const { impl, seen } = stubFetch({});
    const result = await fetchPublicPage(url, { fetchImpl: impl });
    check(`${url} is refused with a 400 before any fetch`, result.status === 400 && 'error' in result && seen.length === 0, JSON.stringify(result));
  }
}

console.log('\nRedirects');
{
  const { impl, seen } = stubFetch({
    'https://example.com/start': redirect('/next'),
    'https://example.com/next': html('<p>arrived</p>'),
  });
  const result = await fetchPublicPage('https://example.com/start', { fetchImpl: impl });
  check('a relative redirect is followed', result.status === 200 && result.body === '<p>arrived</p>', JSON.stringify(result));
  check('finalUrl is the URL that produced the body', result.finalUrl === 'https://example.com/next');
  check('every hop is fetched with redirect: manual', seen.every(({ init }) => init.redirect === 'manual'));
  check('no caller header reaches the upstream', seen.every(({ init }) => !('Authorization' in init.headers) && !('Cookie' in init.headers)));
}
{
  const { impl, seen } = stubFetch({
    'https://example.com/evil': redirect('http://169.254.169.254/latest/meta-data'),
  });
  const result = await fetchPublicPage('https://example.com/evil', { fetchImpl: impl });
  check('a redirect into private space is refused', result.status === 400 && 'error' in result, JSON.stringify(result));
  check('the private hop is never fetched', seen.length === 1);
}
{
  const routes = {};
  for (let i = 0; i <= WEB_FETCH_MAX_REDIRECTS + 1; i++) {
    routes[`https://loop.example.com/${i}`] = redirect(`https://loop.example.com/${i + 1}`);
  }
  const { impl, seen } = stubFetch(routes);
  const result = await fetchPublicPage('https://loop.example.com/0', { fetchImpl: impl });
  check('a redirect chain past the limit is refused', 'error' in result && result.status === 508, JSON.stringify(result));
  check('it stops after the limit', seen.length === WEB_FETCH_MAX_REDIRECTS + 1, String(seen.length));
}

console.log('\nContent');
{
  const { impl } = stubFetch({
    'https://example.com/logo.png': new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: { 'content-type': 'image/png' },
    }),
  });
  const result = await fetchPublicPage('https://example.com/logo.png', { fetchImpl: impl });
  check('binary content is refused with a 415', result.status === 415 && 'error' in result, JSON.stringify(result));
}
{
  const { impl } = stubFetch({
    'https://example.com/404': new Response('<p>missing</p>', { status: 404, headers: { 'content-type': 'text/html' } }),
  });
  const result = await fetchPublicPage('https://example.com/404', { fetchImpl: impl });
  check('an upstream 404 is a result, not a refusal', !('error' in result) && result.status === 404);
}
{
  // 20,000 two-byte characters = 40,000 bytes against a 16 KiB (minimum) cap.
  const big = '\u00e9'.repeat(20_000);
  const { impl } = stubFetch({ 'https://example.com/big': html(big) });
  const result = await fetchPublicPage('https://example.com/big', { fetchImpl: impl, maxBytes: 1 });
  check('an oversized body is truncated', result.truncated === true);
  check('the cap is clamped to its minimum', new TextEncoder().encode(result.body).length <= 16 * 1024);
  check('truncation never leaves a replacement character', !result.body.includes('\ufffd'));
}
{
  // A hung upstream: the stub never resolves, so only the abort can end it.
  const hanging = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  const result = await fetchPublicPage('https://slow.example.com/', { fetchImpl: hanging, timeoutMs: 20 });
  check('a hung upstream times out as a 504', result.status === 504 && 'error' in result, JSON.stringify(result));
}

console.log('\nRate limit');
{
  const limiter = new WebFetchRateLimiter(3, 1_000);
  const results = [0, 1, 2, 3].map(i => limiter.allow('owner-a', 10_000 + i));
  check('the owner is braked after the limit', results.join() === 'true,true,true,false');
  check('another owner is unaffected', limiter.allow('owner-b', 10_004));
  check('the window slides', limiter.allow('owner-a', 11_001));
}

console.log('\n/api/infer body helpers');
{
  const { clampMaxTokens, sanitizeReasoning } = await import('../src/infer-body.ts');
  check('max_tokens defaults to 4096', clampMaxTokens(undefined) === 4096 && clampMaxTokens(-1) === 4096);
  check('max_tokens is honoured below the ceiling', clampMaxTokens(8192) === 8192);
  check('max_tokens is capped', clampMaxTokens(1e9) === 32_000);
  check('a valid reasoning effort is rebuilt', JSON.stringify(sanitizeReasoning({ effort: 'medium', exclude: true })) === '{"effort":"medium"}');
  check('an unknown effort is dropped', sanitizeReasoning({ effort: 'max' }) === undefined);
  check('a non-object is dropped', sanitizeReasoning('high') === undefined);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll web-fetch checks passed.');
