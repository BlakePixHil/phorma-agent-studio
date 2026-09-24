import { describe, expect, it } from 'vitest';

import {
  clampMaxChars,
  decodeHtmlEntities,
  extractHtmlTitle,
  htmlToReadableText,
  isReadableContentType,
  normalizeWebUrl,
  readablePage,
  truncateForModel,
  WEB_PAGE_DEFAULT_MAX_CHARS,
} from './web-fetch.js';

describe('decodeHtmlEntities', () => {
  it('decodes named, decimal and hex entities', () => {
    expect(decodeHtmlEntities('a &amp; b &lt;c&gt; &#39;d&#39; &#x2713;')).toBe("a & b <c> 'd' \u2713");
  });

  it('leaves unknown and out-of-range entities alone', () => {
    expect(decodeHtmlEntities('&bogus; &#99999999;')).toBe('&bogus; &#99999999;');
  });
});

describe('htmlToReadableText', () => {
  const page = `<!doctype html><html><head><title>Ignored</title>
    <style>body { color: red }</style><script>alert(1)</script></head>
    <body><nav><a href="/home">Home</a></nav>
    <h1>Main &amp; title</h1>
    <p>First <strong>bold</strong> paragraph with a <a href="/docs/start">link</a>.</p>
    <ul><li>One</li><li>Two</li></ul>
    <pre><code>const x = 1;
  return x;</code></pre>
    <footer>Copyright</footer></body></html>`;

  it('drops scripts, styles, navigation and footers', () => {
    const text = htmlToReadableText(page, 'https://example.com/a/b');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color: red');
    expect(text).not.toContain('Home');
    expect(text).not.toContain('Copyright');
  });

  it('keeps headings, emphasis, lists and resolved links', () => {
    const text = htmlToReadableText(page, 'https://example.com/a/b');
    expect(text).toContain('# Main & title');
    expect(text).toContain('**bold**');
    expect(text).toContain('[link](https://example.com/docs/start)');
    expect(text).toMatch(/- One\n- Two/);
  });

  it('preserves preformatted whitespace in a fenced block', () => {
    const text = htmlToReadableText(page);
    expect(text).toContain('```\nconst x = 1;\n  return x;\n```');
  });

  it('drops javascript: and fragment links but keeps their label', () => {
    const text = htmlToReadableText('<p><a href="javascript:void 0">Click</a> <a href="#top">Top</a></p>');
    expect(text).toBe('Click Top');
  });

  it('survives unclosed and malformed markup', () => {
    expect(() => htmlToReadableText('<div><p>open <script>never closed')).not.toThrow();
    expect(htmlToReadableText('<div><p>open <script>never closed')).toContain('open');
  });
});

describe('extractHtmlTitle', () => {
  it('prefers <title>, falls back to the first <h1>', () => {
    expect(extractHtmlTitle('<title> A &amp; B </title><h1>C</h1>')).toBe('A & B');
    expect(extractHtmlTitle('<h1><span>Only</span> heading</h1>')).toBe('Only heading');
    expect(extractHtmlTitle('<p>none</p>')).toBe('');
  });
});

describe('truncateForModel', () => {
  it('returns short text untouched', () => {
    expect(truncateForModel('short', 100)).toEqual({ text: 'short', truncated: false });
  });

  it('cuts at a paragraph boundary near the limit and says how much was dropped', () => {
    const text = `${'a'.repeat(950)}\n\n${'b'.repeat(500)}`;
    const result = truncateForModel(text, 1000);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith('a'.repeat(950))).toBe(true);
    expect(result.text).not.toContain('b');
    expect(result.text).toMatch(/truncated - \d+ more characters/);
  });
});

describe('readablePage', () => {
  it('converts HTML and extracts the title', () => {
    const page = readablePage('<html><title>T</title><body><p>Hello</p></body></html>', {
      contentType: 'text/html; charset=utf-8',
    });
    expect(page).toEqual({ title: 'T', text: 'Hello', truncated: false });
  });

  it('sniffs unlabelled HTML', () => {
    expect(readablePage('<!DOCTYPE html><p>Hi</p>').text).toBe('Hi');
  });

  it('pretty-prints JSON', () => {
    expect(readablePage('{"a":1}', { contentType: 'application/json' }).text).toBe('{\n  "a": 1\n}');
  });

  it('passes plain text through', () => {
    expect(readablePage('  plain  ', { contentType: 'text/plain' }).text).toBe('plain');
  });
});

describe('isReadableContentType', () => {
  it.each(['text/html', 'text/plain; charset=utf-8', 'application/json', 'text/csv', null])(
    'accepts %s',
    type => expect(isReadableContentType(type)).toBe(true),
  );

  it.each(['image/png', 'application/pdf', 'application/octet-stream', 'video/mp4'])(
    'refuses %s',
    type => expect(isReadableContentType(type)).toBe(false),
  );
});

describe('clampMaxChars', () => {
  it('defaults, floors and caps', () => {
    expect(clampMaxChars(undefined)).toBe(WEB_PAGE_DEFAULT_MAX_CHARS);
    expect(clampMaxChars(10)).toBe(1_000);
    expect(clampMaxChars(10_000_000)).toBe(60_000);
  });
});

describe('normalizeWebUrl', () => {
  it('adds https to a bare host and strips the fragment', () => {
    expect(normalizeWebUrl(' example.com/docs#intro ')).toBe('https://example.com/docs');
  });

  it('keeps an explicit http(s) URL', () => {
    expect(normalizeWebUrl('http://example.org/a?b=1')).toBe('http://example.org/a?b=1');
  });

  it.each(['', 'not a url', 'ftp://example.com', 'javascript:alert(1)', 'intranet'])(
    'rejects %j',
    raw => expect(normalizeWebUrl(raw)).toBeNull(),
  );
});
