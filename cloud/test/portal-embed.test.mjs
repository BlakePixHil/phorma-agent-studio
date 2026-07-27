/**
 * Guards the embed surface (portal follow-ups).
 *
 * Two things here are security-relevant and easy to get quietly wrong:
 *
 * 1. `frame-ancestors`. Before this feature the directive was simply ABSENT,
 *    which browsers read as "anyone may frame me" - so a key-protected portal
 *    could be framed and clickjacked. It must now default to `'none'` and only
 *    open up when the owner explicitly enables embedding.
 * 2. The loader is emitted from a template literal, so a stray backtick breaks
 *    the whole worker build (and `wrangler dev` then hangs rather than
 *    reporting it). That trap already cost real time once.
 *
 * Pure - no worker, no network.
 * Run: npx -y tsx cloud/test/portal-embed.test.mjs
 */

import { frameAncestors, renderEmbedLoader, embedSnippet } from '../src/portal-embed.ts';
import { normalizeEmbedOrigin, portalPublicConfig } from '../../engine/src/portal.ts';

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

// ── 1: frame-ancestors defaults closed ───────────────────────────────────────
console.log('frame-ancestors: closed by default');
{
  check("embedding off => 'none'", frameAncestors({}) === "frame-ancestors 'none'");
  check(
    "embedding explicitly off => 'none'",
    frameAncestors({ embedEnabled: false, embedOrigins: ['https://acme.com'] }) ===
      "frame-ancestors 'none'",
  );
  check(
    'embedding on with origins => exactly those origins',
    frameAncestors({ embedEnabled: true, embedOrigins: ['https://acme.com', 'https://b.com'] }) ===
      'frame-ancestors https://acme.com https://b.com',
  );
  check(
    'embedding on with no origins => * (owner opted in)',
    frameAncestors({ embedEnabled: true, embedOrigins: [] }) === 'frame-ancestors *',
  );
  check(
    'blank origins are dropped rather than emitted',
    frameAncestors({ embedEnabled: true, embedOrigins: ['', '  '] }) === 'frame-ancestors *',
  );
  check(
    'the directive never contains a newline (would break the header)',
    !frameAncestors({ embedEnabled: true, embedOrigins: ['https://a.com'] }).includes('\n'),
  );
}

// ── 2: origin normalization ──────────────────────────────────────────────────
console.log('\nOrigin normalization');
{
  check('bare host gets https', normalizeEmbedOrigin('acme.com') === 'https://acme.com');
  check('https passes through', normalizeEmbedOrigin('https://acme.com') === 'https://acme.com');
  check('path is stripped', normalizeEmbedOrigin('https://acme.com/pricing') === 'https://acme.com');
  check(
    'trailing slash is stripped',
    normalizeEmbedOrigin('https://acme.com/') === 'https://acme.com',
  );
  check('port is preserved', normalizeEmbedOrigin('http://localhost:4200') === 'http://localhost:4200');
  check('subdomain is preserved', normalizeEmbedOrigin('https://a.b.acme.com') === 'https://a.b.acme.com');
  check('whitespace is trimmed', normalizeEmbedOrigin('  acme.com  ') === 'https://acme.com');
  check('empty stays empty', normalizeEmbedOrigin('') === '');
  check('garbage is rejected', normalizeEmbedOrigin('not a url at all') === '');
  // A javascript: origin in a CSP would be nonsense at best.
  check('non-http schemes are rejected', normalizeEmbedOrigin('javascript:alert(1)') === '');
  check('wildcards are rejected', normalizeEmbedOrigin('*') === '');
}

// ── 3: the public config projection ──────────────────────────────────────────
console.log('\nPublic config: embed fields');
{
  const off = portalPublicConfig({ mode: 'chat', access: 'public' }, 'Fallback');
  check('embedding defaults off', off.embedEnabled === false);
  check('origins default empty', off.embedOrigins.length === 0);
  check('a default label is always present', off.embedLabel.length > 0);

  const on = portalPublicConfig(
    {
      mode: 'chat',
      access: 'public',
      embedEnabled: true,
      embedOrigins: ['acme.com', 'https://acme.com/x', '  ', 'nope nope'],
      embedLabel: '  Talk to sales  ',
    },
    'Fallback',
  );
  check('origins are normalized', on.embedOrigins.includes('https://acme.com'));
  check('duplicates are collapsed', on.embedOrigins.length === 1, JSON.stringify(on.embedOrigins));
  check('unusable origins are dropped', !on.embedOrigins.some(origin => origin.includes('nope')));
  check('label is trimmed', on.embedLabel === 'Talk to sales');
}

// ── 4: the loader script ─────────────────────────────────────────────────────
console.log('\nEmbed loader script');
{
  const loader = renderEmbedLoader();

  check('loader is non-trivial', loader.length > 500);
  check(
    'loader has NO backticks (a stray one breaks the worker build)',
    !loader.includes('`'),
  );
  check('the channel placeholder was substituted', !loader.includes('__CHANNEL__'));
  check('loader references the shared channel name', loader.includes('phorma-portal'));
  check('loader reads data-slug', loader.includes('data-slug'));
  check('loader requests the embed layout', loader.includes('embed=1'));
  check('loader guards against a double include', loader.includes('__phormaPortal_'));
  check('loader verifies the message origin', loader.includes('event.origin !== origin'));
  check('loader checks the channel on incoming messages', loader.includes('data.channel !== CHANNEL'));
  check('loader lazy-loads the frame on first open', loader.includes('if (!loaded)'));
  check('loader supports Escape to close', loader.includes("'Escape'"));
  check('loader sets aria-expanded', loader.includes('aria-expanded'));
  check('loader resolves the origin from its own src', loader.includes('script.src'));
  check('loader is IIFE-wrapped (no globals leak)', loader.trim().startsWith('(function ()'));
  check('loader is strict mode', loader.includes("'use strict'"));
  // It runs on a customer's page: it must not need eval or inline handlers.
  check('loader uses no eval', !loader.includes('eval('));
  check('loader uses no document.write', !loader.includes('document.write'));
}

// ── 4b: theme defaults to light, not the visitor's OS ────────────────────────
// A widget is a guest on someone else's page. `theme: auto` follows the
// VISITOR's OS, which renders a dark panel on a light host site - caught in a
// real browser, so it is pinned here.
console.log('\nEmbed loader theme');
{
  const loader = renderEmbedLoader();

  check('loader reads data-theme', loader.includes('data-theme'));
  check(
    "loader defaults to light rather than 'auto'",
    /data-theme[^\n]*\|\|\s*'light'/.test(loader),
  );
  check(
    "loader forwards the theme to the page unless it is 'auto'",
    loader.includes("theme === 'auto' ? ''") && loader.includes("'&theme='"),
  );
  check(
    'the launcher panel background tracks the resolved theme',
    loader.includes("dark ?"),
  );
}

// ── 5: the copyable snippet ──────────────────────────────────────────────────
console.log('\nEmbed snippet');
{
  const snippet = embedSnippet('https://w.example.dev', 'support', 'Ask us');
  check('snippet points at the loader', snippet.includes('https://w.example.dev/portal-embed.js'));
  check('snippet carries the slug', snippet.includes('data-slug="support"'));
  check('snippet carries the label', snippet.includes('data-label="Ask us"'));
  check('snippet defers', snippet.includes('defer'));
  const bare = embedSnippet('https://w.example.dev', 'support');
  check('label is optional', !bare.includes('data-label'));
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
