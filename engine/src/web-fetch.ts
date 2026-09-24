/**
 * Web page reading for the assistant's `web_fetch` tool and URL references.
 *
 * Pure string processing - no DOM, no network. Hosts fetch the bytes (Rust
 * `web_fetch` on desktop, the worker's `/api/fetch` in the browser) and hand
 * the body here to become compact, model-friendly markdown-ish text.
 *
 * The converter is deliberately a tolerant tokenizer rather than a parser: web
 * HTML is routinely malformed, and the goal is readable prose for a model, not
 * a faithful tree. It drops non-content regions (scripts, styles, navigation,
 * forms, footers), keeps headings, list items, links, code and paragraphs, and
 * decodes entities.
 */

/** The page as the model sees it. */
export interface ReadablePage {
  /** `<title>` (or first `<h1>`), empty when neither exists. */
  title: string;
  /** Readable text, already truncated to the caller's limit. */
  text: string;
  /** True when {@link ReadablePage.text} was cut short. */
  truncated: boolean;
}

/** Default character cap for page text handed to a model. */
export const WEB_PAGE_DEFAULT_MAX_CHARS = 24_000;

/** Upper bound a caller may request (keeps one page from flooding context). */
export const WEB_PAGE_MAX_CHARS = 60_000;

/** Elements whose whole subtree is dropped. */
const DROPPED_ELEMENTS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'nav',
  'footer',
  'form',
  'select',
  'button',
  'head',
  // Reported separately as the page title; a head-less document keeps it inline.
  'title',
];

/** Block-level elements that end a line. */
const BLOCK_ELEMENTS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'aside',
  'header',
  'blockquote',
  'figure',
  'figcaption',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'dl',
  'dt',
  'dd',
  'ul',
  'ol',
  'address',
  'details',
  'summary',
  'hr',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  hellip: '...',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  laquo: '"',
  raquo: '"',
  copy: '(c)',
  reg: '(R)',
  trade: '(TM)',
  middot: '-',
  bull: '-',
  times: 'x',
  deg: ' deg',
};

/** Decodes the HTML entities that matter for readable text. */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Removes every `<name ...>...</name>` region, tolerating a missing close tag. */
function dropElement(html: string, name: string): string {
  const paired = new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}\\s*>`, 'gi');
  const unclosed = new RegExp(`<${name}\\b[^>]*\\/?>`, 'gi');
  return html.replace(paired, ' ').replace(unclosed, ' ');
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? null;
}

/** Resolves an href against the page URL; null for non-navigable links. */
function resolveHref(href: string, baseUrl: string | undefined): string | null {
  const trimmed = decodeHtmlEntities(href.trim());
  if (!trimmed || trimmed.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(trimmed)) {
    return null;
  }
  try {
    const resolved = baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed);
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.href : null;
  } catch {
    return null;
  }
}

function collapseInline(value: string): string {
  return value.replace(/[ \t\f\v\r\n\u00a0]+/g, ' ');
}

/** Extracts the page title from `<title>`, falling back to the first `<h1>`. */
export function extractHtmlTitle(html: string): string {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1];
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html)?.[1];
  const raw = title?.trim() ? title : h1 ?? '';
  return collapseInline(decodeHtmlEntities(raw.replace(/<[^>]+>/g, ' '))).trim();
}

/**
 * Converts an HTML document to readable markdown-ish text.
 *
 * @param baseUrl resolves relative links so the model can follow them.
 */
export function htmlToReadableText(html: string, baseUrl?: string): string {
  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
    // <!DOCTYPE ...> and other declarations / processing instructions.
    .replace(/<[!?][^>]*>/g, ' ');
  // Prefer the main content region when the page marks one.
  const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(body)?.[1];
  const article = /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i.exec(body)?.[1];
  const focus = main ?? article;
  if (focus && focus.replace(/<[^>]+>/g, '').trim().length > 200) body = focus;
  for (const name of DROPPED_ELEMENTS) body = dropElement(body, name);

  // Preformatted blocks keep their whitespace; stash them before collapsing.
  const preBlocks: string[] = [];
  body = body.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_match, inner: string) => {
    const code = decodeHtmlEntities(inner.replace(/<[^>]+>/g, '')).replace(/\n+$/, '');
    preBlocks.push(code);
    return `\n\u0000PRE${preBlocks.length - 1}\u0000\n`;
  });

  // Links become `text (url)`; the text is resolved when the inner is tag-free.
  body = body.replace(
    /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi,
    (_match, attrs: string, inner: string) => {
      const label = collapseInline(inner.replace(/<[^>]+>/g, ' ')).trim();
      const href = attribute(attrs, 'href');
      const url = href ? resolveHref(href, baseUrl) : null;
      if (!label) return url ? ` ${url} ` : ' ';
      return url && url !== label ? ` [${label}](${url}) ` : ` ${label} `;
    },
  );

  body = body.replace(/<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi, (_match, close: string, rawName: string, attrs: string) => {
    const name = rawName.toLowerCase();
    const heading = /^h([1-6])$/.exec(name);
    if (heading) return close ? '\n\n' : `\n\n${'#'.repeat(Number(heading[1]))} `;
    if (name === 'br') return '\n';
    // The OPENING tag starts the line; a closing tag adding its own newline
    // would put a blank line between every item.
    if (name === 'li') return close ? '' : '\n- ';
    if (name === 'tr') return close ? '' : '\n';
    if (name === 'td' || name === 'th') return close ? ' | ' : '';
    if (name === 'code') return '`';
    if (name === 'strong' || name === 'b') return '**';
    if (name === 'em' || name === 'i') return '_';
    if (name === 'img') {
      const alt = attribute(attrs, 'alt');
      return alt?.trim() ? ` [image: ${collapseInline(decodeHtmlEntities(alt)).trim()}] ` : ' ';
    }
    if (BLOCK_ELEMENTS.has(name)) return '\n\n';
    return ' ';
  });

  const lines = decodeHtmlEntities(body)
    .split('\n')
    .map(line => collapseInline(line).trim())
    // Empty emphasis/code markers left behind by stripped content.
    .map(line => line.replace(/(\*\*|_|`)\s*\1/g, '').trim())
    .map(line => (/^-\s*$/.test(line) || /^#+\s*$/.test(line) ? '' : line));

  const text = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\u0000PRE(\d+)\u0000/g, (_match, index: string) => `\`\`\`\n${preBlocks[Number(index)] ?? ''}\n\`\`\``)
    .trim();
  return text;
}

/**
 * Truncates text at a character limit, preferring a paragraph or sentence
 * boundary in the last 10% so the model does not see a word cut in half.
 */
export function truncateForModel(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const window = text.slice(0, maxChars);
  const floor = Math.floor(maxChars * 0.9);
  const paragraph = window.lastIndexOf('\n\n');
  const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('.\n'));
  const cut = paragraph >= floor ? paragraph : sentence >= floor ? sentence + 1 : maxChars;
  return {
    text: `${window.slice(0, cut).trimEnd()}\n\n[... truncated - ${text.length - cut} more characters]`,
    truncated: true,
  };
}

/** Content types the reader accepts, by prefix. Everything else is refused. */
const READABLE_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'application/json',
  'application/ld+json',
  'text/xml',
  'application/xml',
  'application/rss+xml',
  'application/atom+xml',
  'text/csv',
];

/** Whether a response content type can be turned into readable text. */
export function isReadableContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return true; // Unlabelled responses are sniffed by the caller.
  const bare = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return READABLE_TYPES.some(type => bare === type) || bare.startsWith('text/');
}

/** Converts a fetched body into a {@link ReadablePage}. */
export function readablePage(
  body: string,
  options: { url?: string; contentType?: string | null; maxChars?: number } = {},
): ReadablePage {
  const maxChars = clampMaxChars(options.maxChars);
  const bare = options.contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  const looksHtml =
    bare === 'text/html' ||
    bare === 'application/xhtml+xml' ||
    (!bare && /^\s*(<!doctype html|<html\b|<head\b|<body\b)/i.test(body));
  if (looksHtml) {
    const title = extractHtmlTitle(body);
    const { text, truncated } = truncateForModel(htmlToReadableText(body, options.url), maxChars);
    return { title, text, truncated };
  }
  if (bare === 'application/json' || bare === 'application/ld+json') {
    let pretty = body;
    try {
      pretty = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      // Not valid JSON after all - hand it over as-is.
    }
    const { text, truncated } = truncateForModel(pretty, maxChars);
    return { title: '', text, truncated };
  }
  const { text, truncated } = truncateForModel(body.trim(), maxChars);
  return { title: '', text, truncated };
}

/** Clamps a requested character limit into the supported range. */
export function clampMaxChars(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return WEB_PAGE_DEFAULT_MAX_CHARS;
  return Math.max(1_000, Math.min(Math.floor(value), WEB_PAGE_MAX_CHARS));
}

/**
 * Normalises a user- or model-supplied URL: trims, adds `https://` to a bare
 * host, and rejects anything that is not http(s). Returns null when invalid.
 * Egress policy (private addresses) is the fetching host's job, not this.
 */
export function normalizeWebUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname || (!url.hostname.includes('.') && url.hostname !== 'localhost')) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}
