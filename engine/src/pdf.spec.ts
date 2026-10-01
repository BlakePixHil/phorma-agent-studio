/**
 * PDF writer and markdown blocks (Requirement 3). Structure is checked with an
 * independent reader (`test/pdf-reader.ts`), never with the writer's own code.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { escapeHtml, markdownToHtml, parseMarkdownBlocks, parseInline } from './markdown-blocks.js';
import {
  describeLayoutIssues,
  measureText,
  renderMarkdownPdf,
  toWinAnsi,
  winAnsiByte,
  wrapRuns,
} from './pdf.js';
import { inspectPdf } from './test/pdf-reader.js';

const SAMPLE = [
  '# Alex Example',
  '#### alex@example.com | +1 555 0100 | Springfield',
  '',
  '## Summary',
  'Engineer with **8 years** of *practical* work. See [portfolio](https://example.com/work).',
  '',
  '## Skills',
  '- TypeScript, Python, SQL',
  '  - Nested detail',
  '1. First',
  '2. Second',
  '',
  '---',
  '',
  '```',
  'const x = 1;',
  '```',
].join('\n');

describe('markdown blocks', () => {
  it('parses every block kind', () => {
    const kinds = parseMarkdownBlocks(SAMPLE).map(block => block.kind);
    expect(kinds).toEqual([
      'heading',
      'heading',
      'heading',
      'paragraph',
      'heading',
      'list-item',
      'list-item',
      'list-item',
      'list-item',
      'rule',
      'code',
    ]);
  });

  it('parses inline styles and drops unsafe link targets', () => {
    expect(parseInline('a **b** *c* `d` [e](https://x.test) [f](javascript:alert(1))')).toEqual([
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: ' ' },
      { text: 'c', italic: true },
      { text: ' ' },
      { text: 'd', code: true },
      { text: ' ' },
      { text: 'e', href: 'https://x.test' },
      { text: ' f' },
    ]);
  });

  it('HTML output never carries markup from the source text (Requirement 4.5)', () => {
    fc.assert(
      fc.property(fc.string(), text => {
        const html = markdownToHtml(text);
        const allowed = /^<\/?(h[1-4]|p|ul|ol|li|strong|em|code|pre|hr|a( href="[^"]*")?)>$/;
        for (const tag of html.match(/<[^>]*>/g) ?? []) expect(tag).toMatch(allowed);
      }),
    );
    expect(markdownToHtml('<script>x</script>')).toBe(`<p>${escapeHtml('<script>x</script>')}</p>`);
  });
});

describe('WinAnsi encoding (Requirement 3.4)', () => {
  it('maps typographic characters to their WinAnsi bytes', () => {
    expect(toWinAnsi('\u201cHi\u201d \u2013 \u2014 \u2026 \u2022 \u20ac')).toEqual([
      0x93, 0x48, 0x69, 0x94, 0x20, 0x96, 0x20, 0x97, 0x20, 0x85, 0x20, 0x95, 0x20, 0x80,
    ]);
    expect(winAnsiByte(0x4e2d)).toBe(0x3f);
    expect(winAnsiByte(0x200b)).toBe(-1);
  });

  it('is total: every code point maps to a printable byte or is dropped', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), text => {
        for (const byte of toWinAnsi(text)) {
          expect(byte >= 0x20 && byte <= 0xff && byte !== 0x7f).toBe(true);
        }
      }),
    );
  });
});

describe('renderMarkdownPdf', () => {
  it('writes a valid single-page PDF with selectable text and links', () => {
    const { bytes, pageCount } = renderMarkdownPdf(SAMPLE, { title: 'Alex' });
    const pdf = inspectPdf(bytes);
    expect(pdf.header).toBe('%PDF-1.4');
    expect(pdf.xrefValid).toBe(true);
    expect(pdf.pageCount).toBe(1);
    expect(pageCount).toBe(1);
    expect(pdf.text).toContain('Alex Example');
    expect(pdf.text).toContain('8 years');
    expect(pdf.links).toEqual(['https://example.com/work']);
  });

  it('paginates long documents', () => {
    const long = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} ${'word '.repeat(30)}`).join('\n\n');
    const { bytes, pageCount } = renderMarkdownPdf(long);
    const pdf = inspectPdf(bytes);
    expect(pageCount).toBeGreaterThan(5);
    expect(pdf.pageCount).toBe(pageCount);
    expect(pdf.xrefValid).toBe(true);
    expect(pdf.text).toContain('Paragraph 199');
  });

  it('is deterministic and structurally valid for any markdown (Requirement 3.6)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), source => {
        const first = renderMarkdownPdf(source);
        const second = renderMarkdownPdf(source);
        expect(first.bytes).toEqual(second.bytes);
        const pdf = inspectPdf(first.bytes);
        expect(pdf.xrefValid).toBe(true);
        expect(pdf.pageCount).toBe(first.pageCount);
        expect(pdf.pageCount).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 60 },
    );
  });

  it('honours page size and refuses an invalid layout', () => {
    const letter = new TextDecoder('latin1').decode(renderMarkdownPdf('x', { layout: { pageSize: 'letter' } }).bytes);
    expect(letter).toContain('/MediaBox [0 0 612 792]');
    expect(() => renderMarkdownPdf('x', { layout: { marginMm: 1 } })).toThrow(/margin/);
    expect(describeLayoutIssues({ accentColor: 'red', fontSize: 30, pageSize: 'a3' })).toHaveLength(3);
    expect(describeLayoutIssues({ accentColor: '#112233', fontSize: 11, marginMm: 20 })).toEqual([]);
  });
});

describe('wrapRuns (Requirement 3.3)', () => {
  it('never lets a line exceed the width, and keeps every word', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[A-Za-z]{1,30}$/), { minLength: 1, maxLength: 60 }),
        fc.integer({ min: 60, max: 500 }),
        (words, maxWidth) => {
          const lines = wrapRuns([{ text: words.join(' ') }], {
            font: 'regular',
            size: 10,
            color: [0, 0, 0],
            accent: [0, 0, 1],
            maxWidth,
          });
          for (const line of lines) {
            const end = line[line.length - 1]!;
            expect(end.x + end.width).toBeLessThanOrEqual(maxWidth + 0.001);
          }
          const text = lines.map(line => line.map(segment => segment.text).join('')).join(' ');
          expect(text.replace(/\s+/g, '')).toBe(words.join(''));
        },
      ),
    );
  });

  it('measures with real glyph widths', () => {
    expect(measureText('iiii', 'regular', 10)).toBeLessThan(measureText('MMMM', 'regular', 10));
    expect(measureText('abc', 'mono', 10)).toBe(18);
    expect(measureText('abc', 'bold', 10)).toBeGreaterThan(measureText('abc', 'regular', 10));
  });
});
