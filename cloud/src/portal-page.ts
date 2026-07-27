/**
 * The portal page (EPIC 9) - one self-contained HTML document.
 *
 * Why a template string instead of a bundled asset: `cloud/wrangler.jsonc` is a
 * committed file shared by BOTH deploy targets (the user's BYO worker and
 * Phorma's hosted worker). Adding an `assets` binding would change every
 * existing user's deploy and has to be reconciled with `routeAgentRequest`'s
 * fall-through, whereas an inlined string ships with the worker script and
 * needs no configuration at all.
 *
 * Constraints this page holds itself to:
 *  - Zero external requests. No fonts, no CDN, no images - the CSP in
 *    `portal.ts` enforces `default-src 'none'` with `connect-src 'self'`, so
 *    anything external would silently fail. Icons are inline SVG paths lifted
 *    from Tabler (the studio's icon set) rather than the webfont.
 *  - Design parity with the studio: the same token names and values as
 *    `frontend/src/styles.scss` (obsidian/violet dark, #f2f3f5 light).
 *  - Accessible: `aria-live` transcript, labelled controls, visible focus,
 *    keyboard submit, reduced-motion support, and no layout shift while
 *    streaming.
 */

import type { PortalAccess, PortalField, PortalMode } from '@phorma/engine';

/** The visitor-facing config the page is rendered from. */
export interface PortalPageConfig {
  slug: string;
  mode: PortalMode;
  title: string;
  greeting?: string;
  fields: PortalField[];
  access: PortalAccess;
  theme: 'auto' | 'light' | 'dark';
  showBranding: boolean;
  embedEnabled?: boolean;
  embedOrigins?: string[];
  embedLabel?: string;
}

/** Escapes text for an HTML text node or a quoted attribute. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders the page. The config is embedded as JSON so the first paint needs no
 * round trip; `/config` exists for programmatic callers.
 *
 * `embed` renders the same document sized for an iframe rather than a full
 * browser tab: no full-viewport minimum height, no centred max-width column,
 * and a compact header. The API surface and script are identical, so an
 * embedded portal behaves exactly like a hosted one.
 */
export function renderPortalPage(config: PortalPageConfig, embed = false): string {
  const title = escapeHtml(config.title);
  // `</script>` inside a JSON string would end the block early; escaping the
  // `<` is the standard mitigation.
  const embedded = JSON.stringify({ ...config, embed }).replace(/</g, '\\u003c');
  const themeClass = config.theme === 'dark' ? 'theme-dark' : config.theme === 'light' ? 'theme-light' : '';
  const rootClass = [themeClass, embed ? 'is-embed' : ''].filter(Boolean).join(' ');

  return `<!doctype html>
<html lang="en" class="${rootClass}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style>${STYLES}</style>
</head>
<body>
<a class="skip" href="#composer">Skip to input</a>
<main class="shell" role="main">
  <header class="head">
    <h1 class="head__title">${title}</h1>
    <p class="head__status" id="status" role="status" aria-live="polite"></p>
  </header>
  <div class="body" id="body"></div>
  ${config.showBranding ? BRANDING : ''}
</main>
<script type="application/json" id="portal-config">${embedded}</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}

const BRANDING = `<footer class="brand"><span>Powered by</span> <strong>Phorma</strong></footer>`;

/**
 * Design tokens mirror `frontend/src/styles.scss` so a published page reads as
 * part of the same product. Root font-size is 14px there, and it is here too.
 */
const STYLES = `
*,*::before,*::after{box-sizing:border-box}
:root{
  --bg:#f2f3f5;--card:#ffffff;--card-2:#f7f8fa;--border:rgba(0,0,0,.10);
  --text:#1c1e26;--muted:#5b6070;--accent:#8578f6;--accent-contrast:#fff;
  --danger:#ef4444;--shadow:0 2px 8px rgba(0,0,0,.08);
  /* ONE horizontal inset for every element inside the shell. Heading text,
     message bubbles, the composer card and the form card all use this, so they
     share a vertical edge at every breakpoint. */
  --gutter:.25rem;
  --radius:14px;color-scheme:light;
}
:root.theme-dark,html.theme-dark{
  --bg:#0c0a10;--card:#17131d;--card-2:#1d1826;--border:rgba(255,255,255,.08);
  --text:#e9e7ef;--muted:#a09bb0;--accent:#8578f6;--accent-contrast:#fff;
  --danger:#f87171;--shadow:0 2px 12px rgba(0,0,0,.5);color-scheme:dark;
}
@media (prefers-color-scheme:dark){
  html:not(.theme-light):not(.theme-dark){
    --bg:#0c0a10;--card:#17131d;--card-2:#1d1826;--border:rgba(255,255,255,.08);
    --text:#e9e7ef;--muted:#a09bb0;--danger:#f87171;
    --shadow:0 2px 12px rgba(0,0,0,.5);color-scheme:dark;
  }
}
html{font-size:14px}
body{
  margin:0;min-height:100vh;min-height:100dvh;background:var(--bg);color:var(--text);
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-size:1rem;line-height:1.55;-webkit-font-smoothing:antialiased;
  display:flex;justify-content:center;
}
.skip{position:absolute;left:-9999px;top:0;padding:.5rem .75rem;background:var(--card);z-index:10}
.skip:focus{left:.5rem;top:.5rem;border-radius:8px;outline:2px solid var(--accent)}
.shell{
  width:100%;max-width:52rem;display:flex;flex-direction:column;
  min-height:100vh;min-height:100dvh;padding:1rem 1rem 0;
}
/* One shared horizontal inset so the heading, bubbles and composer card all
   line up on the same vertical edge. */
.head{padding:.75rem var(--gutter) 1rem;flex:0 0 auto}
.head__title{margin:0;font-size:1.35rem;font-weight:700;letter-spacing:-0.01em}
.head__status{margin:.2rem 0 0;font-size:.928rem;color:var(--muted);min-height:1.45em}
.body{flex:1 1 auto;display:flex;flex-direction:column;min-height:0}

/* ── Chat ───────────────────────────────────────────────────── */
.log{
  flex:1 1 auto;overflow-y:auto;display:flex;flex-direction:column;gap:.75rem;
  padding:.25rem var(--gutter) 1rem;overflow-wrap:anywhere;
}
/* Bottom-anchor the transcript: a short conversation should sit just above the
   composer, not float at the top of an empty page. An auto-margin spacer does
   this without justify-content:flex-end, which clips the top of an overflowing
   log in Chromium. NOTE: no backticks in this block - STYLES is a template
   literal and a stray backtick silently breaks the whole worker build. */
.log::before{content:'';margin-top:auto}
.msg{max-width:min(88%,42rem);padding:.6rem .85rem;border-radius:var(--radius);white-space:pre-wrap}
.msg--user{align-self:flex-end;background:var(--accent);color:var(--accent-contrast);border-bottom-right-radius:5px}
.msg--bot{align-self:flex-start;background:var(--card);border:1px solid var(--border);box-shadow:var(--shadow);border-bottom-left-radius:5px}
.msg--note{align-self:center;background:transparent;color:var(--muted);font-size:.928rem;text-align:center;padding:.2rem}
.msg--error{align-self:center;background:transparent;color:var(--danger);font-size:.928rem;text-align:center}
/* Reserve the caret's width so the bubble never reflows as tokens land. */
.msg--stream::after{content:'▍';margin-left:1px;opacity:.55;animation:blink 1s steps(2,start) infinite}
@keyframes blink{50%{opacity:0}}
.dots{display:inline-flex;gap:4px;align-items:center;height:1.45em}
.dots i{width:6px;height:6px;border-radius:50%;background:var(--muted);animation:bounce 1.2s ease-in-out infinite}
.dots i:nth-child(2){animation-delay:.15s}
.dots i:nth-child(3){animation-delay:.3s}
@keyframes bounce{0%,60%,100%{transform:translateY(0);opacity:.45}30%{transform:translateY(-4px);opacity:1}}

/* ── Composer ─────────────────────────────────────────────────────────── */
.composer{
  flex:0 0 auto;display:flex;gap:.5rem;align-items:flex-end;
  padding:.6rem;margin:0 var(--gutter) .6rem;background:var(--card);
  border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);
  position:sticky;bottom:0;
}
.composer textarea{
  flex:1 1 auto;min-width:0;resize:none;border:0;outline:0;background:transparent;
  color:inherit;font:inherit;max-height:9rem;padding:.35rem .25rem;
}
.send{
  flex:0 0 auto;width:2.35rem;height:2.35rem;display:grid;place-items:center;
  border:0;border-radius:10px;background:var(--accent);color:var(--accent-contrast);cursor:pointer;
  transition:filter .15s ease,opacity .15s ease;
}
.send:hover:not(:disabled){filter:brightness(1.08)}
.send:disabled{opacity:.45;cursor:default}
.send svg{width:18px;height:18px;display:block}

/* ── Form ─────────────────────────────────────────────────────────────── */
.form{
  background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
  box-shadow:var(--shadow);padding:1.1rem;margin:0 var(--gutter) 1rem;
  display:flex;flex-direction:column;gap:.9rem;
}
.field{display:flex;flex-direction:column;gap:.3rem}
.field__label{font-size:.928rem;font-weight:600;color:var(--muted)}
.field__req{color:var(--danger);margin-left:.15rem}
.field input[type=text],.field input[type=number],.field textarea,.field select{
  width:100%;padding:.5rem .6rem;border-radius:10px;border:1px solid var(--border);
  background:var(--card-2);color:inherit;font:inherit;
}
.field textarea{min-height:6rem;resize:vertical}
.field--bool{flex-direction:row;align-items:center;gap:.5rem}
.field--bool input{accent-color:var(--accent);width:1rem;height:1rem}
.field--bool .field__label{font-weight:500;color:inherit}
.field__error{font-size:.928rem;color:var(--danger)}
/* Intro copy above a form. Reads as prose, not as another field label. */
.form__intro{margin:0;font-size:1rem;line-height:1.55;color:var(--muted)}
.submit{
  align-self:flex-start;padding:.55rem 1.1rem;border:0;border-radius:10px;
  background:var(--accent);color:var(--accent-contrast);font:inherit;font-weight:600;cursor:pointer;
}
.submit:hover:not(:disabled){filter:brightness(1.08)}
.submit:disabled{opacity:.45;cursor:default}
.answer{
  background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
  box-shadow:var(--shadow);padding:1rem;margin:0 var(--gutter) 1rem;white-space:pre-wrap;overflow-wrap:anywhere;
}
.answer h2{margin:0 0 .5rem;font-size:.928rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}

/* ── Ask User prompt ──────────────────────────────────────────────────── */
.ask{
  align-self:stretch;background:var(--card-2);border:1px solid var(--border);
  border-left:3px solid var(--accent);border-radius:10px;padding:.75rem .85rem;
  display:flex;flex-direction:column;gap:.5rem;
}
.ask__q{margin:0;font-weight:600;white-space:pre-wrap}
.ask__row{display:flex;gap:.5rem}
.ask__row input{
  flex:1 1 auto;min-width:0;padding:.45rem .6rem;border-radius:8px;
  border:1px solid var(--border);background:var(--card);color:inherit;font:inherit;
}

.brand{
  flex:0 0 auto;padding:.4rem 0 .9rem;text-align:center;
  font-size:.857rem;color:var(--muted);letter-spacing:.02em;
}
.brand strong{font-weight:700;color:var(--text)}

:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media (max-width:480px){
  .shell{padding:.5rem .35rem 0}
  .head{padding:.5rem var(--gutter) .75rem}
  .head__title{font-size:1.2rem}
  .msg{max-width:94%}
}

/* Embedded in an iframe on someone else's site. The frame supplies the size,
   so drop the full-viewport minimum and the centred reading column, and shrink
   the header - a launcher bubble has far less room than a browser tab. The
   loader also draws its own titled header, so ours would be a duplicate. */
html.is-embed,html.is-embed body{height:100%;min-height:0}
html.is-embed body{display:block;background:var(--card)}
html.is-embed .shell{max-width:none;min-height:100%;height:100%;padding:0 .35rem 0}
html.is-embed .msg{max-width:94%}
html.is-embed .brand{padding:.2rem 0 .5rem;font-size:.8rem}
html.is-embed .form,html.is-embed .answer{margin-top:.6rem}
html.is-embed .composer{margin-bottom:.35rem}
/* The loader draws its own titled bar, so the page title would be a duplicate -
   but the status line still matters, so keep the header block and hide only the
   heading. */
html.is-embed .head{padding:.35rem var(--gutter) 0}
html.is-embed .head__title{display:none}
html.is-embed .head__status{min-height:0}
`;

/**
 * The page's behaviour. Written as plain ES2020 (no build step, no bundler),
 * kept small enough to read in one sitting.
 *
 * Streaming uses `fetch` + a manual SSE reader rather than `EventSource`
 * because `EventSource` cannot send the `X-Portal-Key` header a token-gated
 * portal needs, and cannot report a non-200 status cleanly.
 */
const SCRIPT = String.raw`
(function () {
  'use strict';

  var CONFIG = JSON.parse(document.getElementById('portal-config').textContent);
  var BASE = location.pathname.replace(/\/$/, '');
  // A key may arrive in the link (?key=pk_…). Strip it from the visible URL so
  // it is not copy-pasted onward or leaked in a screenshot.
  var params = new URLSearchParams(location.search);
  var KEY = params.get('key') || '';
  if (KEY) {
    params.delete('key');
    var clean = location.pathname + (params.toString() ? '?' + params : '');
    history.replaceState(null, '', clean);
  }

  var statusEl = document.getElementById('status');
  var bodyEl = document.getElementById('body');
  var sessionId = null;
  var busy = false;

  function setStatus(text) { statusEl.textContent = text || ''; }

  /* ── Host-page channel (embed mode only) ─────────────────────────────
     Presentation only: the loader needs our height to size the frame, and
     open/close + unread state to animate the launcher. Deliberately carries NO
     run data - the redacted event projection is the only path for that. */
  var PARENT_CHANNEL = 'phorma-portal';

  /* Tabler 'send' glyph, inlined - the page loads no external assets. */
  var SEND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14l11 -11"/><path d="M21 3l-6.5 18a.55 .55 0 0 1 -1 0l-3.5 -7l-7 -3.5a.55 .55 0 0 1 0 -1l18 -6.5"/></svg>';

  function tellParent(type, payload) {
    if (!CONFIG.embed || window.parent === window) return;
    try {
      // '*' is safe here because every message is presentation state the host
      // page could measure anyway, and the loader may be on any allowed origin.
      window.parent.postMessage(
        { channel: PARENT_CHANNEL, slug: CONFIG.slug, type: type, payload: payload || null },
        '*'
      );
    } catch (error) {
      /* A hostile or vanished parent must never break the conversation. */
    }
  }

  var lastHeight = 0;
  function reportHeight() {
    if (!CONFIG.embed) return;
    var height = Math.ceil(document.documentElement.scrollHeight);
    if (Math.abs(height - lastHeight) < 4) return;
    lastHeight = height;
    tellParent('height', { height: height });
  }

  if (CONFIG.embed) {
    // ResizeObserver catches content growth; the load event catches first paint.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(reportHeight).observe(document.documentElement);
    }
    window.addEventListener('load', reportHeight);
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function headers() {
    var head = { 'Content-Type': 'application/json' };
    if (KEY) head['X-Portal-Key'] = KEY;
    return head;
  }

  function api(action, body) {
    return fetch(BASE + '/' + action, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body || {})
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        return { status: response.status, data: data };
      });
    });
  }

  function ensureSession() {
    if (sessionId) return Promise.resolve(sessionId);
    return api('session', {}).then(function (result) {
      if (result.status === 401) throw new Error('This assistant needs an access key.');
      if (!result.data.sessionId) throw new Error('Could not start a conversation.');
      sessionId = result.data.sessionId;
      return sessionId;
    });
  }

  /**
   * Reads the redacted SSE stream for the current turn.
   * Handlers: onToken(text), onQuestion(requestId, text), onReview(),
   * onDone(output), onError(message), onStopped().
   */
  function stream(handlers) {
    var url = BASE + '/stream?sessionId=' + encodeURIComponent(sessionId);
    var init = { headers: {} };
    if (KEY) init.headers['X-Portal-Key'] = KEY;
    return fetch(url, init).then(function (response) {
      if (!response.ok || !response.body) throw new Error('Lost the connection.');
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) return;
          buffer += decoder.decode(chunk.value, { stream: true });
          var index = buffer.indexOf('\n\n');
          while (index !== -1) {
            var frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            if (frame.indexOf('data: ') === 0) {
              var event = null;
              try { event = JSON.parse(frame.slice(6)); } catch (error) { event = null; }
              if (event) dispatch(event, handlers);
            }
            index = buffer.indexOf('\n\n');
          }
          return pump();
        });
      }
      return pump();
    });
  }

  function dispatch(event, handlers) {
    if (event.type === 'token') handlers.onToken(event.text);
    else if (event.type === 'question') handlers.onQuestion(event.requestId, event.question);
    else if (event.type === 'review') handlers.onReview();
    else if (event.type === 'done') handlers.onDone(event.output);
    else if (event.type === 'error') handlers.onError(event.message);
    else if (event.type === 'stopped') handlers.onStopped();
  }

  /* ── Chat ──────────────────────────────────────────────────────────── */

  function buildChat() {
    var log = el('div', 'log');
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'polite');
    log.setAttribute('aria-label', 'Conversation');

    var composer = el('form', 'composer');
    composer.id = 'composer';
    var input = el('textarea');
    input.rows = 1;
    input.placeholder = 'Type your message…';
    input.setAttribute('aria-label', 'Your message');
    var send = el('button', 'send');
    send.type = 'submit';
    send.setAttribute('aria-label', 'Send message');
    send.innerHTML = SEND_ICON;
    composer.appendChild(input);
    composer.appendChild(send);

    bodyEl.appendChild(log);
    bodyEl.appendChild(composer);

    if (CONFIG.greeting) log.appendChild(bubble('bot', CONFIG.greeting));

    function bubble(kind, text) {
      var node = el('div', 'msg msg--' + kind, text);
      return node;
    }

    function scroll() { log.scrollTop = log.scrollHeight; }

    function autosize() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 144) + 'px';
    }
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        composer.requestSubmit();
      }
    });

    function lock(state) {
      busy = state;
      send.disabled = state;
      input.disabled = state;
      setStatus(state ? 'Thinking…' : '');
      if (!state) input.focus();
    }

    function askInline(requestId, question) {
      var wrap = el('div', 'ask');
      var label = el('p', 'ask__q', question);
      var row = el('div', 'ask__row');
      var field = el('input');
      field.type = 'text';
      field.setAttribute('aria-label', question);
      var ok = el('button', 'send');
      ok.type = 'button';
      ok.setAttribute('aria-label', 'Send answer');
      ok.innerHTML = SEND_ICON;
      row.appendChild(field);
      row.appendChild(ok);
      wrap.appendChild(label);
      wrap.appendChild(row);
      log.appendChild(wrap);
      scroll();
      field.focus();

      function submit() {
        var value = field.value.trim();
        if (!value) return;
        ok.disabled = true;
        field.disabled = true;
        api('answer', { sessionId: sessionId, requestId: requestId, response: value })
          .then(function () {
            wrap.replaceWith(bubble('user', value));
            setStatus('Thinking…');
            scroll();
          })
          .catch(function () {
            ok.disabled = false;
            field.disabled = false;
          });
      }
      ok.addEventListener('click', submit);
      field.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { event.preventDefault(); submit(); }
      });
    }

    composer.addEventListener('submit', function (event) {
      event.preventDefault();
      if (busy) return;
      var text = input.value.trim();
      if (!text) return;

      input.value = '';
      autosize();
      log.appendChild(bubble('user', text));
      scroll();
      lock(true);

      var pending = el('div', 'msg msg--bot');
      var dots = el('span', 'dots');
      dots.innerHTML = '<i></i><i></i><i></i>';
      pending.appendChild(dots);
      log.appendChild(pending);
      scroll();

      var streamed = '';
      function firstToken() {
        if (streamed === '') {
          pending.textContent = '';
          pending.classList.add('msg--stream');
        }
      }

      ensureSession()
        .then(function () { return api('message', { sessionId: sessionId, message: text }); })
        .then(function (result) {
          if (result.status === 429) throw new Error(result.data.error || 'Please slow down.');
          if (result.status >= 400) throw new Error(result.data.error || 'Could not send that.');
          return stream({
            onToken: function (chunk) {
              firstToken();
              streamed += chunk;
              pending.textContent = streamed;
              scroll();
            },
            onQuestion: function (requestId, question) {
              pending.remove();
              askInline(requestId, question);
            },
            onReview: function () {
              pending.textContent = '';
              pending.classList.remove('msg--stream');
              pending.replaceWith(el('div', 'msg msg--note', 'Waiting for a human to review this.'));
              setStatus('Awaiting review');
            },
            onDone: function (output) {
              pending.classList.remove('msg--stream');
              if (pending.isConnected) {
                pending.textContent = output || streamed || '(no answer)';
              } else {
                log.appendChild(bubble('bot', output || '(no answer)'));
              }
              lock(false);
              scroll();
              // Lets a collapsed launcher show an unread dot.
              tellParent('answered');
            },
            onError: function (message) {
              if (pending.isConnected) pending.remove();
              log.appendChild(el('div', 'msg msg--error', message));
              lock(false);
              scroll();
            },
            onStopped: function () {
              if (pending.isConnected) pending.remove();
              log.appendChild(el('div', 'msg msg--note', 'This run was stopped.'));
              lock(false);
              scroll();
            }
          });
        })
        .catch(function (error) {
          if (pending.isConnected) pending.remove();
          log.appendChild(el('div', 'msg msg--error', error.message || 'Something went wrong.'));
          lock(false);
          scroll();
        });
    });

    input.focus();
  }

  /* ── Form ──────────────────────────────────────────────────────────── */

  function buildForm() {
    var form = el('form', 'form');
    form.id = 'composer';
    form.setAttribute('novalidate', 'novalidate');

    if (CONFIG.greeting) form.appendChild(el('p', 'form__intro', CONFIG.greeting));

    var inputs = {};
    CONFIG.fields.forEach(function (field, index) {
      var id = 'f' + index;
      var wrap = el('div', 'field' + (field.type === 'boolean' ? ' field--bool' : ''));
      var label = el('label', 'field__label', field.label);
      label.htmlFor = id;
      if (field.required && field.type !== 'boolean') {
        var star = el('span', 'field__req', '*');
        star.setAttribute('aria-hidden', 'true');
        label.appendChild(star);
      }

      var control;
      if (field.type === 'textarea') {
        control = el('textarea');
      } else if (field.type === 'select') {
        control = el('select');
        control.appendChild(el('option', null, ''));
        (field.options || []).forEach(function (option) {
          control.appendChild(el('option', null, option));
        });
      } else if (field.type === 'boolean') {
        control = el('input');
        control.type = 'checkbox';
      } else {
        control = el('input');
        control.type = field.type === 'number' ? 'number' : 'text';
      }
      control.id = id;
      if (field.placeholder && field.type !== 'boolean' && field.type !== 'select') {
        control.placeholder = field.placeholder;
      }
      if (field.required) control.setAttribute('aria-required', 'true');

      if (field.type === 'boolean') {
        wrap.appendChild(control);
        wrap.appendChild(label);
      } else {
        wrap.appendChild(label);
        wrap.appendChild(control);
      }
      var error = el('p', 'field__error');
      error.hidden = true;
      wrap.appendChild(error);
      form.appendChild(wrap);
      inputs[field.key] = { field: field, control: control, error: error };
    });

    var submit = el('button', 'submit', 'Submit');
    submit.type = 'submit';
    form.appendChild(submit);
    bodyEl.appendChild(form);

    var answer = el('section', 'answer');
    answer.hidden = true;
    answer.appendChild(el('h2', null, 'Answer'));
    var answerBody = el('div');
    answer.appendChild(answerBody);
    bodyEl.appendChild(answer);

    /**
     * Renders a follow-up question inside the answer card and posts the reply.
     * Replaces window.prompt(), which browsers suppress in a cross-origin frame.
     */
    function askInForm(requestId, question) {
      var wrap = el('div', 'ask');
      var label = el('p', 'ask__q', question);
      var row = el('div', 'ask__row');
      var field = el('input');
      field.type = 'text';
      field.setAttribute('aria-label', question);
      var ok = el('button', 'send');
      ok.type = 'button';
      ok.setAttribute('aria-label', 'Send answer');
      ok.innerHTML = SEND_ICON;
      row.appendChild(field);
      row.appendChild(ok);
      wrap.appendChild(label);
      wrap.appendChild(row);
      answer.appendChild(wrap);
      answer.hidden = false;
      field.focus();
      reportHeight();

      function submitAnswer() {
        var value = field.value.trim();
        if (!value) return;
        ok.disabled = true;
        field.disabled = true;
        api('answer', { sessionId: sessionId, requestId: requestId, response: value })
          .then(function () {
            wrap.remove();
            setStatus('Working…');
            reportHeight();
          })
          .catch(function () {
            ok.disabled = false;
            field.disabled = false;
          });
      }
      ok.addEventListener('click', submitAnswer);
      field.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { event.preventDefault(); submitAnswer(); }
      });
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (busy) return;

      var values = {};
      var invalid = null;
      Object.keys(inputs).forEach(function (key) {
        var entry = inputs[key];
        entry.error.hidden = true;
        var raw = entry.field.type === 'boolean' ? entry.control.checked : entry.control.value.trim();
        var empty = entry.field.type === 'boolean' ? false : raw === '';
        if (entry.field.required && empty) {
          entry.error.textContent = entry.field.label + ' is required.';
          entry.error.hidden = false;
          if (!invalid) invalid = entry.control;
          return;
        }
        if (!empty) values[key] = raw;
      });
      if (invalid) { invalid.focus(); return; }

      busy = true;
      submit.disabled = true;
      setStatus('Working…');
      answer.hidden = false;
      answerBody.textContent = '';
      answerBody.className = 'msg--stream';

      var streamed = '';
      ensureSession()
        .then(function () { return api('message', { sessionId: sessionId, fields: values }); })
        .then(function (result) {
          if (result.status >= 400) throw new Error(result.data.error || 'Could not submit that.');
          return stream({
            onToken: function (chunk) { streamed += chunk; answerBody.textContent = streamed; },
            onQuestion: function (requestId, question) {
              // An inline prompt, NOT window.prompt(): browsers suppress or
              // badly present native dialogs inside a cross-origin iframe, so
              // an embedded form would silently stall on an Ask User node.
              askInForm(requestId, question);
            },
            onReview: function () { setStatus('Awaiting review'); },
            onDone: function (output) {
              answerBody.className = '';
              answerBody.textContent = output || streamed || '(no answer)';
              busy = false; submit.disabled = false; setStatus('Done');
            },
            onError: function (message) {
              answerBody.className = '';
              answerBody.textContent = message;
              busy = false; submit.disabled = false; setStatus('');
            },
            onStopped: function () {
              answerBody.className = '';
              answerBody.textContent = 'This run was stopped.';
              busy = false; submit.disabled = false; setStatus('');
            }
          });
        })
        .catch(function (error) {
          answerBody.className = '';
          answerBody.textContent = error.message || 'Something went wrong.';
          busy = false; submit.disabled = false; setStatus('');
        });
    });
  }

  if (CONFIG.mode === 'form') buildForm(); else buildChat();
})();
`;
