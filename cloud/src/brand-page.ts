/**
 * The shared look for every page this Worker serves to a real browser.
 *
 * Four pages land in an external browser during sign-in or checkout, and until
 * now each one carried its own copy of the same 30 lines of CSS plus an unbranded
 * 40px coloured disc:
 *
 *   `GET /billing/return`   back from Stripe Checkout          (`api.ts`)
 *   `GET /signed-in`        back from the Clerk Account Portal (`api.ts`)
 *   `GET /auth/device`      the desktop sign-in handoff        (`device-auth-routes.ts`)
 *   the 503 variant of that page, on a deployment with no sign-in configured
 *
 * They are the only Phorma-owned pages in a flow otherwise made of Stripe's and
 * Clerk's own screens, so a plain dark rectangle with a green dot on it is the
 * moment a user cannot tell whose page they are on. This module is the fix and
 * the de-duplication in one: {@link brandPageDocument} renders all four.
 *
 * ## Why the mark is an inline `<svg>` and not an image
 *
 * `/billing/return` and `/signed-in` answer with
 * `default-src 'none'; style-src 'unsafe-inline'` and NO `img-src`, so an `<img>`
 * or an `<svg><use href>` would be blocked outright. An inline `<svg>` element is
 * not a resource fetch, so it needs no CSP change on any of the four pages. It
 * also cannot fail: these pages are read by someone who may be offline, on a
 * captive portal, or in a hardened browser, and the whole reason they are
 * self-contained is that they must render identically in all three.
 *
 * The Worker also has no way to SERVE a binary: `wrangler.jsonc` binds no `assets`
 * directory, and the one binary path that exists (`RELEASES` in R2) is hosted-only,
 * while these pages must render on a BYO worker that binds nothing. "Static markup,
 * no bindings" is the invariant `index.ts` documents for all of them.
 *
 * `cloud/` also cannot import from `frontend/`, so the paths below are a HAND COPY
 * of `frontend/public/logo.svg`. That is a structural twin, and the one thing that
 * would silently rot: if the brand mark changes, it changes in both places. There
 * is no build step that could share it without making this Worker depend on the
 * Angular app.
 *
 * ## The state signal moved OFF the mark
 *
 * The old `.mark` disc was doing two jobs: it was the only brand element AND the
 * only success/pending/error channel (green, grey, red). Those fight each other -
 * a logo tinted red is a broken logo, not an error state. So the mark now renders
 * clean at a fixed size and state is a small coloured dot beside the heading, which
 * leaves the brand constant and makes the state read as a status rather than as a
 * corrupted image.
 *
 * The dot is not the only state channel either, and deliberately so: every state
 * also changes the heading text. A colour-blind reader, or anyone with a stylesheet
 * blocked, still gets the outcome from the words.
 */

/** The three states a branded page can report, and the dot colour each gets. */
export type BrandPageState = 'pending' | 'ok' | 'bad';

/**
 * Class on the `<span>` holding the heading TEXT, as opposed to the state dot
 * beside it.
 *
 * Exported so the one page that rewrites its heading at runtime
 * (`GET /auth/device`) can target the text and nothing else. It exists because the
 * obvious selector is wrong in a way no markup assertion catches: the `<h1>` has
 * two `<span>` children and the DOT is the first, so `#title span` writes the
 * heading into the status indicator.
 */
export const BRAND_HEADING_TEXT_CLASS = 'brand__heading-text';

/**
 * The Phorma mark, inline.
 *
 * HAND COPY of `frontend/public/logo.svg` - see the module header on why it cannot
 * be imported. Two deliberate differences from that file:
 *
 *  - The gradient ids are namespaced `phorma-mark-*` rather than Figma's
 *    `paint0_linear_1203_440`. An id in an inline SVG is document-global, so a
 *    generic id is a collision waiting for the second inline SVG on the page.
 *  - `width`/`height` are dropped in favour of the `viewBox` plus a CSS size, so
 *    one constant serves the page mark without a second copy of the paths.
 *  - THE VIEWBOX IS TIGHTENED to the glyph's real bounds. The source is
 *    `0 0 600 600` but the paths only span x 136-476 and y 95-543, so 43 percent of
 *    that box is empty padding - at a 48px CSS size the mark rendered about 27px
 *    wide and read as an afterthought beside the wordmark. `132 91 348 456` frames
 *    the glyph itself, which makes it a third larger at the same CSS size. The
 *    paths are untouched; only the window onto them changed.
 *
 * The three white 15%-opacity stroke twins from the source are kept: they are what
 * keeps the darkest blade legible against a dark background, which is exactly the
 * case this page is.
 *
 * NO `src=`, `href=` or `xlink:href=` anywhere in here, and that is load-bearing
 * rather than incidental - `cloud/test/billing-routes.test.mjs` asserts these two
 * pages reference no remote asset, and a `<use href>` would trip it.
 */
export const PHORMA_MARK_SVG = `<svg class="brand__mark" viewBox="132 91 348 456" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
<path d="M138.477 215.167H270.477V455.773C270.477 466.53 264.717 476.464 255.382 481.808L158.623 537.201C148.58 542.951 136.085 535.644 136.171 524.072L138.477 215.167Z" fill="url(#phorma-mark-a)"/>
<path d="M269.977 215.667V455.773C269.977 466.351 264.313 476.119 255.133 481.375L158.375 536.767C148.667 542.325 136.588 535.262 136.671 524.076L138.973 215.667H269.977Z" stroke="white" stroke-opacity="0.15"/>
<path d="M266.476 239.266L369.976 160.667L459.704 217.65C469.526 223.888 475.477 234.716 475.477 246.351L475.477 342.136C475.477 352.966 469.639 362.956 460.203 368.273L359.367 425.086C351.368 429.594 341.477 423.813 341.477 414.632L341.477 293.12C341.477 287.872 338.734 283.006 334.245 280.288L266.476 239.266Z" fill="url(#phorma-mark-b)"/>
<path d="M370.001 161.275L459.436 218.072C469.114 224.218 474.977 234.887 474.977 246.351L474.976 342.136C474.976 352.786 469.236 362.609 459.957 367.837L359.122 424.651C351.456 428.97 341.977 423.431 341.977 414.631L341.976 293.12C341.976 287.698 339.142 282.669 334.503 279.861L267.364 239.219L370.001 161.275Z" stroke="white" stroke-opacity="0.15"/>
<path d="M138.478 176.185C138.478 164.146 145.034 153.063 155.584 147.265L239.186 101.318C251.694 94.4439 266.959 94.9515 278.983 102.642L400.979 180.666C388.356 178.401 375.338 180.507 364.074 186.636L163.294 295.884C150.696 302.738 141.656 314.681 138.478 328.666L138.478 176.185Z" fill="url(#phorma-mark-c)"/>
<path d="M155.825 147.703L239.427 101.756C251.775 94.97 266.844 95.4715 278.714 103.063L398.695 179.8C386.711 178.168 374.495 180.397 363.835 186.197L163.055 295.445C151.454 301.758 142.84 312.342 138.978 324.867L138.979 176.185C138.979 164.329 145.435 153.413 155.825 147.703Z" stroke="white" stroke-opacity="0.15"/>
<defs>
<linearGradient id="phorma-mark-a" x1="204.477" y1="215.167" x2="204.477" y2="550.167" gradientUnits="userSpaceOnUse">
<stop stop-color="#12101F"/><stop offset="1" stop-color="#4A477D"/>
</linearGradient>
<linearGradient id="phorma-mark-b" x1="499.977" y1="211.166" x2="272.477" y2="342.514" gradientUnits="userSpaceOnUse">
<stop stop-color="#B2A3F7"/><stop offset="1" stop-color="#604FEE"/>
</linearGradient>
<linearGradient id="phorma-mark-c" x1="194.481" y1="124.333" x2="270.498" y2="255.999" gradientUnits="userSpaceOnUse">
<stop stop-color="#E2D9FD"/><stop offset="1" stop-color="#A896F0"/>
</linearGradient>
</defs>
</svg>`;

/**
 * The favicon, as a `data:` URI.
 *
 * DELIBERATELY A SIMPLIFIED, FLAT MARK rather than the real one above. At 16px the
 * three gradients composite into a single mauve smudge and the dark blade
 * disappears entirely, so the full mark is worse than no favicon. This is the same
 * three-blade silhouette in two flat tones, which still reads as the Phorma mark at
 * tab size. That is a legibility decision, not a size one.
 *
 * `#` is percent-encoded as `%23`; leaving it raw truncates the URI at the first
 * colour because `#` starts a fragment.
 *
 * COSTS A CSP CHANGE on `/billing/return` and `/signed-in`. A favicon is governed
 * by `img-src`, and those two pages declare `default-src 'none'` with no `img-src`
 * at all, so without `img-src data:` the browser blocks it and logs a violation for
 * an icon we asked for. That is why {@link BRAND_PAGE_CSP} exists rather than each
 * route hand-writing its own directives.
 */
export const PHORMA_FAVICON_DATA_URI =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">' +
      '<path d="M138 215h132v241c0 11-6 21-15 26l-97 55c-10 6-22-1-22-13z" fill="#4A477D"/>' +
      '<path d="M266 239l104-78 90 57c9 6 15 17 15 28v96c0 11-6 21-15 26l-101 57c-8 5-18-1-18-10V293c0-5-3-10-7-13z" fill="#8B79F2"/>' +
      '<path d="M138 176c0-12 7-23 17-29l84-46c12-7 28-6 40 1l122 78c-13-2-26 0-37 6L163 296c-13 7-22 19-25 33z" fill="#CFC2FA"/>' +
      '</svg>',
  );

/**
 * The CSP for the two pages that load NOTHING but their own inline stylesheet and
 * favicon.
 *
 * `default-src 'none'` is still the claim - the two exceptions are the inline
 * stylesheet these pages carry and the `data:` favicon. `img-src data:` admits
 * `data:` URIs ONLY: no host, no scheme, so it cannot become a way to reach a
 * remote image. `base-uri` and `form-action` stay `'none'`.
 *
 * `/auth/device` does NOT use this: it runs clerk-js and needs a much wider policy,
 * which it builds itself and which already carried `img-src data: https:`.
 */
export const BRAND_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

/**
 * The one stylesheet all four pages share.
 *
 * Sizes are absolute px, not rem: unlike the studio these pages have no 14px root
 * override, and hard-coding the unit removes a whole class of "which root is this
 * measured against" mistake on a page nobody will look at twice.
 *
 * The dot's three colours are the SAME hexes the old `.mark` disc used, so the
 * state palette is unchanged - only what it is painted on moved.
 */
const BRAND_PAGE_STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0f1115;
    color: #e7e9ee;
    font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    padding: 24px;
  }
  main { max-width: 27rem; text-align: center; }
  .brand {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 11px;
    margin: 0 0 22px;
  }
  /* Sized to the tightened viewBox's 348:456 ratio (0.763), so the box has no dead
     space to letterbox into and the glyph is exactly as tall as declared. */
  .brand__mark { width: 35px; height: 46px; flex-shrink: 0; }
  .brand__name {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: #e7e9ee;
  }
  h1 {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 11px;
    font-size: 1.5rem;
    font-weight: 600;
    margin: 0 0 0.75rem;
  }
  /* The state channel. A small dot beside the heading, so the mark above stays the
     brand and never becomes a red logo. The heading TEXT also changes with the
     state, so this is a second signal rather than the only one.

     The halo is what stops it reading as a LIST BULLET, which is exactly how a
     bare 9px circle looked to the left of a 24px bold heading. A dot with a soft
     ring around it reads as a status light instead - and the ring is a box-shadow,
     so it costs no layout width and the heading text stays where it was.

     NOTE for anyone editing this block: it lives inside a TEMPLATE LITERAL, so a
     backtick in a comment here terminates the string and the file stops parsing
     several lines later with a message that points nowhere near the cause. */
  .dot {
    width: 8px;
    height: 8px;
    flex-shrink: 0;
    border-radius: 50%;
    background: #6b7280;
    box-shadow: 0 0 0 4px rgba(107, 114, 128, 0.16);
  }
  .ok .dot {
    background: #34d399;
    box-shadow: 0 0 0 4px rgba(52, 211, 153, 0.18);
  }
  .bad .dot {
    background: #f87171;
    box-shadow: 0 0 0 4px rgba(248, 113, 113, 0.18);
  }
  p { margin: 0; color: #a8aebb; }
  p + p { margin-top: 0.75rem; }
`;

/** What one branded page renders. */
export interface BrandPageOptions {
  /** `<title>`. " - Phorma Agent Studio" is appended, so pass the page part only. */
  title: string;
  /** The `<h1>`. Defaults to `title`, which is the common case. */
  heading?: string;
  /** One or more paragraphs of body copy, in order. */
  body: string[];
  /**
   * Which dot to show, or `'none'` for a page with no outcome to report (the 503
   * variant, which is a statement about the deployment rather than about a request).
   */
  state: BrandPageState | 'none';
  /** Extra markup after the copy - the device page's script goes here. */
  extraBody?: string;
  /**
   * Extra markup inside `<head>`, for the device page's clerk-js tag. Kept
   * separate from `extraBody` because a `<script src>` in `<head>` and a bootstrap
   * at the end of `<body>` are different positions with different load semantics.
   */
  extraHead?: string;
  /**
   * `id` on `<main>`, so a script can swap the state at runtime. Only the device
   * page needs it; every other page is static.
   */
  rootId?: string;
  /** `id`s for the heading and first paragraph, for the same reason. */
  headingId?: string;
  bodyId?: string;
}

/**
 * Renders one branded page.
 *
 * NOTHING here interpolates request data, and that is what lets the CSP be this
 * strict. Every caller passes literals or values it derived itself; a route that
 * ever wants to echo a query parameter must escape it at the call site, because
 * this function does not.
 */
export function brandPageDocument(options: BrandPageOptions): string {
  const stateClass = options.state === 'none' ? '' : ` class="${options.state}"`;
  const dot = options.state === 'none' ? '' : '<span class="dot" aria-hidden="true"></span>';
  const heading = options.heading ?? options.title;
  // The heading text carries its OWN class, and that is load-bearing for the one
  // page that rewrites it at runtime. The `<h1>` holds two children - the state dot
  // and the text - so a selector like `#title span` matches the DOT and writing to
  // it replaces an 8px circle with a paragraph of overflowing text. Measured, in a
  // screenshot, after every markup assertion in the suite passed.
  const paragraphs = options.body
    .map((text, index) => {
      const id = index === 0 && options.bodyId ? ` id="${options.bodyId}"` : '';
      return `  <p${id}>${text}</p>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="${PHORMA_FAVICON_DATA_URI}">
<title>${options.title} - Phorma Agent Studio</title>
<style>${BRAND_PAGE_STYLE}</style>${options.extraHead ? `\n${options.extraHead}` : ''}
</head>
<body>
<main${options.rootId ? ` id="${options.rootId}"` : ''}${stateClass}>
  <div class="brand">
    ${PHORMA_MARK_SVG}
    <span class="brand__name">Phorma Agent Studio</span>
  </div>
  <h1${options.headingId ? ` id="${options.headingId}"` : ''}>${dot}<span class="${BRAND_HEADING_TEXT_CLASS}">${heading}</span></h1>
${paragraphs}
</main>${options.extraBody ? `\n${options.extraBody}` : ''}
</body>
</html>
`;
}
