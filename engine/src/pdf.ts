/**
 * A dependency-free PDF writer for markdown documents (render-document, G3).
 *
 * Output is a PDF 1.4 file with real, selectable, single-column text in the
 * standard Helvetica and Courier fonts under WinAnsiEncoding, so text
 * extractors and document parsers read it cleanly. Layout covers headings,
 * paragraphs, nested lists, rules, code blocks, bold, italic, inline code and
 * links (as URI annotations), with greedy word wrap and pagination.
 *
 * Deterministic: the same markdown and layout produce byte-identical output on
 * every host. There is no timestamp, no random id and no compression.
 *
 * Every string the writer emits is Latin-1, and every non-ASCII byte inside a
 * PDF string is written as an octal escape, so a character offset is a byte
 * offset when the cross-reference table is built.
 */

import {
  parseMarkdownBlocks,
  runsText,
  type DocumentBlock,
  type InlineRun,
} from './markdown-blocks.js';
import { DOCUMENT_LAYOUT_LIMITS, describeLayoutIssues } from './delivery-limits.js';
import type { DocumentLayout } from './types.js';

export { DOCUMENT_LAYOUT_LIMITS, describeLayoutIssues };

// ─────────────────────────────────────────────────────────────────────────────
// Layout options
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZES: Readonly<Record<'a4' | 'letter', { width: number; height: number }>> = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
};

interface ResolvedLayout {
  width: number;
  height: number;
  margin: number;
  fontSize: number;
  accent: Rgb;
}

type Rgb = readonly [number, number, number];

function resolveLayout(layout: DocumentLayout | undefined): ResolvedLayout {
  if (describeLayoutIssues(layout).length > 0) {
    throw new Error(`Invalid document layout: ${describeLayoutIssues(layout).join(' ')}`);
  }
  const page = PAGE_SIZES[layout?.pageSize ?? 'a4'];
  const marginMm = layout?.marginMm ?? DOCUMENT_LAYOUT_LIMITS.marginMm.default;
  return {
    width: page.width,
    height: page.height,
    margin: (marginMm * 72) / 25.4,
    fontSize: layout?.fontSize ?? DOCUMENT_LAYOUT_LIMITS.fontSize.default,
    accent: hexToRgb(layout?.accentColor ?? DOCUMENT_LAYOUT_LIMITS.accentColor.default),
  };
}

function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const TEXT_COLOR: Rgb = [0.1, 0.1, 0.1];
const MUTED_COLOR: Rgb = [0.33, 0.33, 0.33];
const RULE_COLOR: Rgb = [0.75, 0.75, 0.75];

// ─────────────────────────────────────────────────────────────────────────────
// Fonts and WinAnsi encoding
// ─────────────────────────────────────────────────────────────────────────────

export type PdfFont = 'regular' | 'bold' | 'italic' | 'bold-italic' | 'mono';

const FONT_RESOURCES: Readonly<Record<PdfFont, { tag: string; base: string }>> = {
  regular: { tag: 'F1', base: 'Helvetica' },
  bold: { tag: 'F2', base: 'Helvetica-Bold' },
  italic: { tag: 'F3', base: 'Helvetica-Oblique' },
  'bold-italic': { tag: 'F4', base: 'Helvetica-BoldOblique' },
  mono: { tag: 'F5', base: 'Courier' },
};

/** Expands `"value*count value ..."` into a width list. */
function widthList(spec: string): number[] {
  const out: number[] = [];
  for (const token of spec.trim().split(/\s+/)) {
    const [value, count] = token.split('*');
    for (let i = 0; i < Number(count ?? 1); i += 1) out.push(Number(value));
  }
  return out;
}

/** Helvetica AFM widths for WinAnsi codes 32-255 (Oblique shares them). */
const HELVETICA_WIDTHS = widthList(
  // 32-63
  '278 278 355 556*2 889 667 191 333*2 389 584 278 333 278*2 556*10 278*2 584*3 556 ' +
    // 64-95
    '1015 667*2 722*2 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667*2 611 278*3 469 556 ' +
    // 96-127
    '333 556*2 500 556*2 278 556*2 222*2 500 222 833 556*5 333 500 278 556 500 722 500*3 334 260 334 584 350 ' +
    // 128-159
    '556 350 222 556 333 1000 556*2 333 1000 667 333 1000 350 611 350*2 222*2 333*2 350 556 1000 333 1000 500 333 944 350 500 667 ' +
    // 160-191
    '278 333 556*4 260 556 333 737 370 556 584 333 737 333 400 584 333*3 556 537 278 333*2 365 556 834*3 611 ' +
    // 192-223
    '667*6 1000 722 667*4 278*4 722*2 778*5 584 778 722*4 667*2 611 ' +
    // 224-255
    '556*6 889 500 556*4 278*4 556*7 584 611 556*4 500 556 500',
);

/** Helvetica-Bold AFM widths for WinAnsi codes 32-255 (BoldOblique shares them). */
const HELVETICA_BOLD_WIDTHS = widthList(
  '278 333 474 556*2 889 722 238 333*2 389 584 278 333 278*2 556*10 333*2 584*3 611 ' +
    '975 722*4 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667*2 611 333 278 333 584 556 ' +
    '333 556 611 556 611 556 333 611*2 278*2 556 278 889 611*5 389 556 333 611 556 778 556*2 500 389 280 389 584 350 ' +
    '556 350 278 556 500 1000 556*2 333 1000 667 333 1000 350 611 350*2 278*2 500*2 350 556 1000 333 1000 556 333 944 350 500 667 ' +
    '278 333 556*4 280 556 333 737 370 556 584 333 737 333 400 584 333*3 611 556 278 333*2 365 556 834*3 611 ' +
    '722*6 1000 722 667*4 278*4 722*2 778*5 584 778 722*4 667*2 611 ' +
    '556*6 889 556*5 278*4 611*7 584 611*5 556 611 556',
);

/** Unicode code points with a WinAnsi byte in the 0x80-0x9F block. */
const WIN_ANSI_SPECIALS: ReadonlyMap<number, number> = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f],
]);

/** Code points with no WinAnsi glyph that have an obvious stand-in. */
const WIN_ANSI_FALLBACKS: ReadonlyMap<number, number> = new Map([
  [0x00a0, 0x20], // no-break space
  [0x2002, 0x20], [0x2003, 0x20], [0x2009, 0x20], [0x200a, 0x20], [0x202f, 0x20],
  [0x2010, 0x2d], [0x2011, 0x2d], [0x2012, 0x2d], [0x2212, 0x2d], // hyphens, minus
  [0x2032, 0x27], [0x2033, 0x22], // prime, double prime
  [0x2043, 0x95], [0x25cf, 0x95], [0x25aa, 0x95], // bullet look-alikes
  [0x2192, 0x3e], // right arrow
]);

/**
 * The WinAnsi byte for one code point: Latin-1 maps directly, the typographic
 * block maps through {@link WIN_ANSI_SPECIALS}, a few look-alikes through the
 * fallbacks, and anything else (including control characters) becomes `?`.
 * Zero-width characters return -1 and are dropped.
 */
export function winAnsiByte(codePoint: number): number {
  if (codePoint === 0x09) return 0x20;
  if (codePoint === 0x200b || codePoint === 0x200c || codePoint === 0x200d || codePoint === 0xfeff) {
    return -1;
  }
  if (codePoint >= 0x20 && codePoint <= 0x7e) return codePoint;
  if (codePoint >= 0xa1 && codePoint <= 0xff) return codePoint;
  return WIN_ANSI_SPECIALS.get(codePoint) ?? WIN_ANSI_FALLBACKS.get(codePoint) ?? 0x3f;
}

/** A string as WinAnsi bytes. Total: every input maps to some byte list. */
export function toWinAnsi(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const byte = winAnsiByte(char.codePointAt(0)!);
    if (byte >= 0) bytes.push(byte);
  }
  return bytes;
}

/** Width of `text` in points at `size` in `font`. */
export function measureText(text: string, font: PdfFont, size: number): number {
  if (font === 'mono') return (toWinAnsi(text).length * 600 * size) / 1000;
  const table = font === 'bold' || font === 'bold-italic' ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let units = 0;
  for (const byte of toWinAnsi(text)) units += table[byte - 32] ?? 556;
  return (units * size) / 1000;
}

/** A PDF literal string: `(`, `)` and `\` escaped, non-printable bytes as octal. */
function pdfString(text: string): string {
  let out = '(';
  for (const byte of toWinAnsi(text)) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte < 0x20 || byte > 0x7e) out += `\\${byte.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(byte);
  }
  return `${out})`;
}

/** A number as PDF source: at most two decimals, no trailing zeros, no `-0`. */
function num(value: number): string {
  const fixed = (Math.round(value * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
  return fixed === '-0' ? '0' : fixed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Line breaking
// ─────────────────────────────────────────────────────────────────────────────

/** One styled word (or word fragment) with whether a space precedes it. */
interface Piece {
  text: string;
  font: PdfFont;
  color: Rgb;
  href?: string;
  spaceBefore: boolean;
}

/** A positioned run of text on one line. */
export interface LineSegment {
  text: string;
  font: PdfFont;
  color: Rgb;
  href?: string;
  x: number;
  width: number;
}

function fontOf(run: InlineRun, base: PdfFont): PdfFont {
  if (run.code) return 'mono';
  const bold = run.bold === true || base === 'bold' || base === 'bold-italic';
  const italic = run.italic === true || base === 'italic' || base === 'bold-italic';
  if (bold && italic) return 'bold-italic';
  if (bold) return 'bold';
  if (italic) return 'italic';
  return 'regular';
}

function piecesOf(runs: readonly InlineRun[], base: PdfFont, color: Rgb, accent: Rgb): Piece[] {
  const pieces: Piece[] = [];
  let pendingSpace = false;
  for (const run of runs) {
    const font = fontOf(run, base);
    const runColor = run.href ? accent : color;
    const parts = run.text.split(/(\s+)/);
    for (const part of parts) {
      if (part.length === 0) continue;
      if (/^\s+$/.test(part)) {
        pendingSpace = pieces.length > 0;
        continue;
      }
      pieces.push({ text: part, font, color: runColor, href: run.href, spaceBefore: pendingSpace });
      pendingSpace = false;
    }
  }
  return pieces;
}

/** Splits a piece wider than `maxWidth` into fragments that each fit. */
function splitWide(piece: Piece, size: number, maxWidth: number): Piece[] {
  const fragments: Piece[] = [];
  let current = '';
  for (const char of piece.text) {
    if (current.length > 0 && measureText(current + char, piece.font, size) > maxWidth) {
      fragments.push({ ...piece, text: current, spaceBefore: fragments.length === 0 && piece.spaceBefore });
      current = '';
    }
    current += char;
  }
  if (current.length > 0) {
    fragments.push({ ...piece, text: current, spaceBefore: fragments.length === 0 && piece.spaceBefore });
  }
  return fragments;
}

/**
 * Greedy word wrap. Every returned line's width is at most `maxWidth` (a single
 * glyph wider than the line is the only exception, and it still gets a line of
 * its own). Adjacent pieces of one style merge into one segment, and the
 * separating space stays inside the text so extractors see real word breaks.
 */
export function wrapRuns(
  runs: readonly InlineRun[],
  options: { font: PdfFont; size: number; color: Rgb; accent: Rgb; maxWidth: number },
): LineSegment[][] {
  const { size, maxWidth } = options;
  const pieces = piecesOf(runs, options.font, options.color, options.accent).flatMap(piece =>
    measureText(piece.text, piece.font, size) > maxWidth ? splitWide(piece, size, maxWidth) : [piece],
  );

  const lines: LineSegment[][] = [];
  let line: LineSegment[] = [];
  let x = 0;

  for (const piece of pieces) {
    const space = line.length > 0 && piece.spaceBefore ? measureText(' ', piece.font, size) : 0;
    const width = measureText(piece.text, piece.font, size);
    if (line.length > 0 && x + space + width > maxWidth) {
      lines.push(line);
      line = [];
      x = 0;
    }
    const lead = line.length > 0 && piece.spaceBefore ? ' ' : '';
    const leadWidth = lead ? measureText(' ', piece.font, size) : 0;
    const last = line[line.length - 1];
    if (last && last.font === piece.font && last.color === piece.color && last.href === piece.href) {
      last.text += lead + piece.text;
      last.width += leadWidth + width;
    } else {
      line.push({
        text: lead + piece.text,
        font: piece.font,
        color: piece.color,
        href: piece.href,
        x,
        width: leadWidth + width,
      });
    }
    x += leadWidth + width;
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Page layout
// ─────────────────────────────────────────────────────────────────────────────

interface PageContent {
  ops: string[];
  links: { rect: [number, number, number, number]; href: string }[];
}

class PageWriter {
  readonly pages: PageContent[] = [];
  private y = 0;

  constructor(private readonly layout: ResolvedLayout) {
    this.newPage();
  }

  private get page(): PageContent {
    return this.pages[this.pages.length - 1]!;
  }

  private get top(): number {
    return this.layout.height - this.layout.margin;
  }

  get contentWidth(): number {
    return this.layout.width - 2 * this.layout.margin;
  }

  newPage(): void {
    this.pages.push({ ops: [], links: [] });
    this.y = this.top;
  }

  /** True when `height` more points fit above the bottom margin. */
  fits(height: number): boolean {
    return this.y - height >= this.layout.margin;
  }

  /** Vertical space; never carries onto a fresh page. */
  gap(points: number): void {
    if (this.y === this.top) return;
    this.y -= points;
    if (this.y < this.layout.margin) this.newPage();
  }

  /** One wrapped line at `indent`, breaking the page first when it does not fit. */
  line(segments: readonly LineSegment[], size: number, indent: number, lineHeight: number): void {
    if (!this.fits(lineHeight)) this.newPage();
    const baseline = this.y - size;
    const left = this.layout.margin + indent;
    for (const segment of segments) {
      const { tag } = FONT_RESOURCES[segment.font];
      const [r, g, b] = segment.color;
      this.page.ops.push(
        `BT /${tag} ${num(size)} Tf ${num(r)} ${num(g)} ${num(b)} rg ` +
          `${num(left + segment.x)} ${num(baseline)} Td ${pdfString(segment.text)} Tj ET`,
      );
      if (segment.href) {
        this.page.links.push({
          rect: [left + segment.x, baseline - size * 0.22, left + segment.x + segment.width, baseline + size * 0.8],
          href: segment.href,
        });
      }
    }
    this.y -= lineHeight;
  }

  /** A horizontal rule across the content width. */
  rule(color: Rgb, thickness: number): void {
    if (!this.fits(thickness + 2)) this.newPage();
    const [r, g, b] = color;
    const y = this.y - 1;
    this.page.ops.push(
      `${num(r)} ${num(g)} ${num(b)} RG ${num(thickness)} w ${num(this.layout.margin)} ${num(y)} m ` +
        `${num(this.layout.width - this.layout.margin)} ${num(y)} l S`,
    );
    this.y -= thickness + 2;
  }
}

interface BlockStyle {
  font: PdfFont;
  size: number;
  color: Rgb;
  before: number;
  after: number;
}

function headingStyle(level: 1 | 2 | 3 | 4, layout: ResolvedLayout): BlockStyle {
  const f = layout.fontSize;
  switch (level) {
    case 1:
      return { font: 'bold', size: f * 2, color: TEXT_COLOR, before: f * 0.4, after: f * 0.3 };
    case 2:
      return { font: 'bold', size: f * 1.3, color: layout.accent, before: f * 1.1, after: f * 0.2 };
    case 3:
      return { font: 'bold', size: f * 1.08, color: TEXT_COLOR, before: f * 0.7, after: f * 0.15 };
    default:
      return { font: 'regular', size: f * 0.95, color: MUTED_COLOR, before: f * 0.1, after: f * 0.3 };
  }
}

function layoutBlocks(blocks: readonly DocumentBlock[], layout: ResolvedLayout): PageContent[] {
  const writer = new PageWriter(layout);
  const f = layout.fontSize;
  const bodyLine = f * 1.38;
  const width = writer.contentWidth;

  blocks.forEach((block, index) => {
    switch (block.kind) {
      case 'heading': {
        const style = headingStyle(block.level, layout);
        const lineHeight = style.size * 1.25;
        const lines = wrapRuns(block.runs, { ...style, accent: layout.accent, maxWidth: width });
        writer.gap(style.before);
        // Keep a heading with at least two lines of what follows it.
        const next = blocks[index + 1];
        const keep = lines.length * lineHeight + (next && next.kind !== 'heading' ? 2 * bodyLine : 0);
        if (!writer.fits(keep)) writer.newPage();
        for (const line of lines) writer.line(line, style.size, 0, lineHeight);
        if (block.level === 2) writer.rule(layout.accent, 0.6);
        writer.gap(style.after);
        return;
      }
      case 'paragraph': {
        const lines = wrapRuns(block.runs, {
          font: 'regular',
          size: f,
          color: TEXT_COLOR,
          accent: layout.accent,
          maxWidth: width,
        });
        for (const line of lines) writer.line(line, f, 0, bodyLine);
        writer.gap(f * 0.5);
        return;
      }
      case 'list-item': {
        const indent = 14 + block.depth * 14;
        const lines = wrapRuns(block.runs, {
          font: 'regular',
          size: f,
          color: TEXT_COLOR,
          accent: layout.accent,
          maxWidth: width - indent,
        });
        const marker: LineSegment = {
          text: block.marker,
          font: 'regular',
          color: TEXT_COLOR,
          x: -10 - (block.ordered ? measureText(block.marker, 'regular', f) - 4 : 0),
          width: measureText(block.marker, 'regular', f),
        };
        lines.forEach((line, lineIndex) => {
          writer.line(lineIndex === 0 ? [marker, ...line] : line, f, indent, bodyLine);
        });
        const next = blocks[index + 1];
        writer.gap(next?.kind === 'list-item' ? f * 0.12 : f * 0.5);
        return;
      }
      case 'rule':
        writer.gap(f * 0.3);
        writer.rule(RULE_COLOR, 0.5);
        writer.gap(f * 0.5);
        return;
      case 'code': {
        const size = f * 0.9;
        for (const raw of block.lines.length > 0 ? block.lines : ['']) {
          const lines = wrapRuns([{ text: raw.replace(/ /g, '\u00a0'), code: true }], {
            font: 'mono',
            size,
            color: MUTED_COLOR,
            accent: layout.accent,
            maxWidth: width,
          });
          for (const line of lines.length > 0 ? lines : [[]]) writer.line(line, size, 0, size * 1.3);
        }
        writer.gap(f * 0.5);
        return;
      }
    }
  });
  return writer.pages;
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialisation
// ─────────────────────────────────────────────────────────────────────────────

export interface RenderedPdf {
  bytes: Uint8Array;
  pageCount: number;
}

/** Renders markdown to a PDF. Throws only for an invalid layout. */
export function renderMarkdownPdf(
  markdown: string,
  options: { title?: string; layout?: DocumentLayout } = {},
): RenderedPdf {
  const layout = resolveLayout(options.layout);
  const pages = layoutBlocks(parseMarkdownBlocks(markdown), layout);

  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };

  // 1 catalog, 2 page tree; fonts follow; pages are added after their kids.
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('');
  const fontRefs = (Object.keys(FONT_RESOURCES) as PdfFont[]).map(font => {
    const { tag, base } = FONT_RESOURCES[font];
    return {
      tag,
      ref: add(`<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`),
    };
  });
  const resources = `<< /Font << ${fontRefs.map(font => `/${font.tag} ${font.ref} 0 R`).join(' ')} >> >>`;

  const pageRefs: number[] = [];
  for (const page of pages) {
    const stream = page.ops.join('\n');
    const contentRef = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const annotRefs = page.links.map(link =>
      add(
        `<< /Type /Annot /Subtype /Link /Rect [${link.rect.map(num).join(' ')}] /Border [0 0 0] ` +
          `/A << /S /URI /URI ${pdfString(link.href)} >> >>`,
      ),
    );
    const annots = annotRefs.length > 0 ? ` /Annots [${annotRefs.map(ref => `${ref} 0 R`).join(' ')}]` : '';
    pageRefs.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(layout.width)} ${num(layout.height)}] ` +
          `/Resources ${resources} /Contents ${contentRef} 0 R${annots} >>`,
      ),
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${pageRefs.map(ref => `${ref} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`;

  const title = options.title?.trim();
  const infoRef = add(
    `<< /Producer (Phorma Agent Studio)${title ? ` /Title ${pdfString(title)}` : ''} >>`,
  );

  let out = '%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoRef} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i += 1) bytes[i] = out.charCodeAt(i) & 0xff;
  return { bytes, pageCount: pageRefs.length };
}

/** The plain text a document's blocks carry, one block per line (tests, previews). */
export function documentText(markdown: string): string {
  return parseMarkdownBlocks(markdown)
    .map(block =>
      block.kind === 'rule' ? '' : block.kind === 'code' ? block.lines.join('\n') : runsText(block.runs),
    )
    .join('\n');
}
