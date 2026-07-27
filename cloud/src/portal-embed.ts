/**
 * The embed loader - a real JavaScript file served to a customer's website.
 *
 * A site owner drops one tag onto their page:
 *
 *   <script src="https://their-worker.dev/portal-embed.js" data-slug="support" defer></script>
 *
 * and gets a launcher bubble that opens the portal in an iframe. The loader is
 * deliberately NOT part of `portal-page.ts`: that page's script is inline, and
 * inline script is blocked by most real sites' CSP. This one is a normal file
 * with a normal `Content-Type`, so it works under a strict host CSP.
 *
 * It is served from a TOP-LEVEL path rather than `/p/{slug}/embed.js` because
 * `portal.ts` enforces a two-segment invariant on `/p/…` and one shared file
 * for every portal caches better anyway.
 *
 * Constraints:
 *  - No build step, no framework, no template literals in the emitted script
 *    (this module is itself a template literal - a stray backtick would break
 *    the worker build, exactly as it did in EPIC 9).
 *  - Touches the host page as little as possible: one container element, one
 *    iframe, all styles inline and scoped, no globals beyond a single guard.
 */

/** Mirrors the page's own channel name (see `portal-page.ts`). */
const CHANNEL = 'phorma-portal';

/**
 * The loader source. Plain ES5-ish so it runs anywhere a customer's site does,
 * without transpilation.
 */
const LOADER = String.raw`
(function () {
  'use strict';

  var CHANNEL = '__CHANNEL__';
  var script = document.currentScript;
  if (!script) return;

  var slug = script.getAttribute('data-slug');
  if (!slug) {
    console.error('[phorma] portal-embed.js needs a data-slug attribute.');
    return;
  }

  // Guard against the tag being included twice on one page.
  var guard = '__phormaPortal_' + slug;
  if (window[guard]) return;
  window[guard] = true;

  // Resolve the portal against the script's own origin, so a site owner never
  // has to repeat the worker URL.
  var origin = new URL(script.src, location.href).origin;
  var label = script.getAttribute('data-label') || 'Chat with us';
  var accent = script.getAttribute('data-accent') || '#8578f6';
  var side = script.getAttribute('data-side') === 'left' ? 'left' : 'right';
  var key = script.getAttribute('data-key') || '';

  /* Theme. A standalone portal follows the VISITOR's OS preference, which is
     right for a full page but wrong in a widget: a dark panel dropped into a
     light host site looks broken. So the host chooses, defaulting to light
     because most sites are. data-theme="auto" opts back into OS preference. */
  var theme = script.getAttribute('data-theme') || 'light';
  var frameSrc = origin + '/p/' + encodeURIComponent(slug) + '?embed=1' +
    (theme === 'auto' ? '' : '&theme=' + encodeURIComponent(theme)) +
    (key ? '&key=' + encodeURIComponent(key) : '');
  var dark = theme === 'dark';

  var OPEN_LABEL = label;
  var CLOSE_LABEL = 'Close chat';

  function css(node, styles) {
    for (var name in styles) {
      if (Object.prototype.hasOwnProperty.call(styles, name)) node.style[name] = styles[name];
    }
  }

  // ── Launcher ──────────────────────────────────────────────────────────────
  var launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('aria-label', OPEN_LABEL);
  launcher.textContent = OPEN_LABEL;
  css(launcher, {
    position: 'fixed',
    bottom: '20px',
    zIndex: '2147483000',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    maxWidth: 'calc(100vw - 40px)',
    padding: '12px 18px',
    border: '0',
    borderRadius: '999px',
    background: accent,
    color: '#fff',
    font: '600 15px/1.2 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
    boxShadow: '0 6px 24px rgba(0,0,0,.22)',
    cursor: 'pointer'
  });
  launcher.style[side] = '20px';

  // Unread dot, shown when an answer lands while the panel is closed.
  var dot = document.createElement('span');
  css(dot, {
    display: 'none',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: '#fff',
    boxShadow: '0 0 0 3px rgba(255,255,255,.35)'
  });
  launcher.insertBefore(dot, launcher.firstChild);

  // ── Panel ─────────────────────────────────────────────────────────────────
  var panel = document.createElement('div');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', label);
  css(panel, {
    position: 'fixed',
    bottom: '84px',
    zIndex: '2147483000',
    width: 'min(400px, calc(100vw - 32px))',
    height: 'min(600px, calc(100vh - 120px))',
    display: 'none',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: '16px',
    /* Matches the portal's own surface token so the panel and the frame inside
       it are the same colour - a mismatch reads as a rendering bug. */
    background: dark ? '#17131d' : '#fff',
    boxShadow: '0 16px 48px rgba(0,0,0,.28)'
  });
  panel.style[side] = '20px';

  var bar = document.createElement('div');
  css(bar, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    flex: '0 0 auto',
    padding: '10px 8px 10px 14px',
    background: accent,
    color: '#fff',
    font: '600 14px/1.3 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif'
  });
  var barTitle = document.createElement('span');
  barTitle.textContent = label;
  var close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', CLOSE_LABEL);
  close.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  css(close, {
    display: 'inline-flex',
    padding: '6px',
    border: '0',
    borderRadius: '8px',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer'
  });
  bar.appendChild(barTitle);
  bar.appendChild(close);

  var frame = document.createElement('iframe');
  frame.title = label;
  // The portal is same-origin with the worker, cross-origin with the host, so
  // the host cannot read it and it cannot script the host.
  frame.setAttribute('loading', 'lazy');
  frame.setAttribute('allow', '');
  css(frame, { flex: '1 1 auto', width: '100%', border: '0', display: 'block' });

  panel.appendChild(bar);
  panel.appendChild(frame);

  var open = false;
  var loaded = false;

  function setOpen(next) {
    open = next;
    panel.style.display = open ? 'flex' : 'none';
    launcher.setAttribute('aria-expanded', open ? 'true' : 'false');
    launcher.setAttribute('aria-label', open ? CLOSE_LABEL : OPEN_LABEL);
    if (open) {
      dot.style.display = 'none';
      // Load on first open, so an unopened widget costs the host page nothing.
      if (!loaded) { frame.src = frameSrc; loaded = true; }
    }
  }

  launcher.addEventListener('click', function () { setOpen(!open); });
  close.addEventListener('click', function () { setOpen(false); launcher.focus(); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && open) { setOpen(false); launcher.focus(); }
  });

  // ── Messages from the portal ──────────────────────────────────────────────
  window.addEventListener('message', function (event) {
    if (event.origin !== origin) return;
    var data = event.data;
    if (!data || data.channel !== CHANNEL || data.slug !== slug) return;
    if (data.type === 'answered' && !open) dot.style.display = 'block';
  });

  function mount() {
    document.body.appendChild(panel);
    document.body.appendChild(launcher);
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
`;

/** The loader script, ready to serve. */
export function renderEmbedLoader(): string {
  return LOADER.replace('__CHANNEL__', CHANNEL);
}

/**
 * Builds the `frame-ancestors` CSP directive for a portal page.
 *
 * Embedding OFF sends `'none'`, so the page cannot be framed at all. That is
 * deliberate hardening: before this existed the directive was simply absent,
 * which browsers read as "any site may frame me" - meaning anyone could frame a
 * key-protected portal and clickjack it.
 *
 * Embedding ON with no origins sends `*` (the owner opted into any site, and the
 * studio warns them at publish time). With origins it sends exactly those.
 */
export function frameAncestors(record: {
  embedEnabled?: boolean;
  embedOrigins?: string[];
}): string {
  if (!record.embedEnabled) return "frame-ancestors 'none'";
  // Trim before filtering: a whitespace-only entry is truthy, and emitting it
  // would add a stray token that browsers reject, breaking the whole directive.
  const origins = (record.embedOrigins ?? []).map(origin => origin.trim()).filter(Boolean);
  return origins.length ? `frame-ancestors ${origins.join(' ')}` : 'frame-ancestors *';
}

/** The snippet an owner copies into their site. */
export function embedSnippet(workerOrigin: string, slug: string, label?: string): string {
  const attrs = [
    `src="${workerOrigin}/portal-embed.js"`,
    `data-slug="${slug}"`,
    label ? `data-label="${label}"` : '',
    'defer',
  ]
    .filter(Boolean)
    .join(' ');
  return `<script ${attrs}></script>`;
}
