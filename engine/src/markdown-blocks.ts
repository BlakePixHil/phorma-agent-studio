/**
 * A bounded markdown subset parsed into blocks of styled inline runs.
 *
 * Shared by the PDF writer (`pdf.ts`) and the email HTML body
 * (`markdownToHtml`), so a document and an email rendered from the same
 * markdown agree on structure. Deliberately small: headings 1-4 (5 and 6 read
 * as 4), paragraphs, bullet and numbered lists with nesting, horizontal rules,
 * fenced code blocks and block quotes (rendered as paragraphs); inline bold,
 * italic, code and links. Tables and images are kept as plain text.
 *
 * Pure and total: any string parses, nothing throws, nothing reads ambient
 * state.
 */

/** One styled stretch of inline text. */
export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  /** Link target; only http, https and mailto survive {@link safeHref}. */
  href?: string;
}

export type DocumentBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; runs: InlineRun[] }
  | { kind: 'paragraph'; runs: InlineRun[] }
  | { kind: 'list-item'; ordered: boolean; marker: string; depth: number; runs: InlineRun[] }
  | { kind: 'rule' }
  | { kind: 'code'; lines: string[] };

/** Longest source accepted; the rest is ignored rather than failing the run. */
export const MARKDOWN_MAX_CHARS = 500_000;

/** Deepest list nesting kept; deeper items render at this depth. */
const MAX_LIST_DEPTH = 3;

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

/** Parses markdown into blocks. */
export function parseMarkdownBlocks(source: string): DocumentBlock[] {
  const text = (typeof source === 'string' ? source : '').slice(0, MARKDOWN_MAX_CHARS);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: DocumentBlock[] = [];

  let paragraph: string[] = [];
  let item: { ordered: boolean; marker: string; depth: number; parts: string[] } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', runs: parseInline(paragraph.join(' ')) });
    paragraph = [];
  };
  const flushItem = (): void => {
    if (item) {
      blocks.push({
        kind: 'list-item',
        ordered: item.ordered,
        marker: item.marker,
        depth: item.depth,
        runs: parseInline(item.parts.join(' ')),
      });
    }
    item = null;
  };
  const flush = (): void => {
    flushParagraph();
    flushItem();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    if (FENCE.test(line)) {
      flush();
      const fence = FENCE.exec(line)![1]!;
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.trimStart().startsWith(fence)) {
        code.push(lines[index]!);
        index += 1;
      }
      blocks.push({ kind: 'code', lines: code });
      continue;
    }

    if (line.trim().length === 0) {
      flush();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const level = Math.min(heading[1]!.length, 4) as 1 | 2 | 3 | 4;
      blocks.push({ kind: 'heading', level, runs: parseInline(heading[2]!) });
      continue;
    }

    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: 'rule' });
      continue;
    }

    const listItem = LIST_ITEM.exec(line);
    if (listItem) {
      flush();
      const indent = listItem[1]!.replace(/\t/g, '    ').length;
      const marker = listItem[2]!;
      item = {
        ordered: /^\d/.test(marker),
        marker: /^\d/.test(marker) ? `${marker.replace(/[.)]$/, '')}.` : '\u2022',
        depth: Math.min(Math.floor(indent / 2), MAX_LIST_DEPTH),
        parts: [listItem[3]!.trim()],
      };
      continue;
    }

    const quote = QUOTE.exec(line);
    const content = (quote ? quote[1]! : line).trim();
    if (item && /^\s+/.test(line) && !quote) {
      // An indented continuation line belongs to the open list item.
      (item as { parts: string[] }).parts.push(content);
      continue;
    }
    flushItem();
    paragraph.push(content);
  }
  flush();
  return blocks;
}

interface InlineStyle {
  bold: boolean;
  italic: boolean;
  href?: string;
}

/** Parses inline markdown into runs. Unclosed markers render literally. */
export function parseInline(source: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const push = (text: string, style: InlineStyle, code = false): void => {
    if (text.length === 0) return;
    const run: InlineRun = { text };
    if (style.bold) run.bold = true;
    if (style.italic) run.italic = true;
    if (code) run.code = true;
    if (style.href) run.href = style.href;
    const previous = runs[runs.length - 1];
    if (
      previous &&
      previous.bold === run.bold &&
      previous.italic === run.italic &&
      previous.code === run.code &&
      previous.href === run.href
    ) {
      previous.text += text;
      return;
    }
    runs.push(run);
  };
  walkInline(source, { bold: false, italic: false }, push, 0);
  return runs;
}

function walkInline(
  text: string,
  style: InlineStyle,
  push: (text: string, style: InlineStyle, code?: boolean) => void,
  depth: number,
): void {
  if (depth > 8) {
    push(text, style);
    return;
  }
  let buffer = '';
  let i = 0;
  const emit = (): void => {
    push(buffer, style);
    buffer = '';
  };

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === '\\' && i + 1 < text.length && /[\\`*_[\]()#+\-.!<>]/.test(text[i + 1]!)) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) {
        emit();
        push(text.slice(i + 1, end), style, true);
        i = end + 1;
        continue;
      }
    }

    if (ch === '[') {
      const close = findClosing(text, i, '[', ']');
      if (close > i && text[close + 1] === '(') {
        const end = findClosing(text, close + 1, '(', ')');
        if (end > close) {
          const label = text.slice(i + 1, close);
          const href = safeHref(text.slice(close + 2, end).trim().split(/\s+/)[0] ?? '');
          emit();
          walkInline(label, href ? { ...style, href } : style, push, depth + 1);
          i = end + 1;
          continue;
        }
      }
    }

    if (ch === '<') {
      const end = text.indexOf('>', i + 1);
      if (end > i) {
        const inner = text.slice(i + 1, end);
        const href = safeHref(inner.includes('@') && !inner.includes(':') ? `mailto:${inner}` : inner);
        if (href) {
          emit();
          push(inner, { ...style, href });
          i = end + 1;
          continue;
        }
      }
    }

    if (ch === '*' || ch === '_') {
      const double = text[i + 1] === ch;
      const marker = double ? ch + ch : ch;
      // `_` inside a word (snake_case) is not emphasis.
      const intraword = ch === '_' && i > 0 && /\w/.test(text[i - 1]!);
      const end = intraword ? -1 : text.indexOf(marker, i + marker.length);
      if (end > i + marker.length - 1 && end - (i + marker.length) > 0) {
        emit();
        const inner = text.slice(i + marker.length, end);
        walkInline(
          inner,
          double ? { ...style, bold: true } : { ...style, italic: true },
          push,
          depth + 1,
        );
        i = end + marker.length;
        continue;
      }
    }

    buffer += ch;
    i += 1;
  }
  emit();
}

function findClosing(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** A link target that is safe to emit, or undefined. */
export function safeHref(raw: string): string | undefined {
  const href = raw.trim();
  if (/^https?:\/\/[^\s<>"]+$/i.test(href)) return href;
  if (/^mailto:[^\s<>"]+@[^\s<>"]+$/i.test(href)) return href;
  return undefined;
}

/** The plain text of a run list. */
export function runsText(runs: readonly InlineRun[]): string {
  return runs.map(run => run.text).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML (email bodies)
// ─────────────────────────────────────────────────────────────────────────────

/** Escapes text for an HTML text node or a double-quoted attribute. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function runsToHtml(runs: readonly InlineRun[]): string {
  return runs
    .map(run => {
      let html = escapeHtml(run.text);
      if (run.code) html = `<code>${html}</code>`;
      if (run.italic) html = `<em>${html}</em>`;
      if (run.bold) html = `<strong>${html}</strong>`;
      if (run.href) html = `<a href="${escapeHtml(run.href)}">${html}</a>`;
      return html;
    })
    .join('');
}

/**
 * Markdown to a self-contained HTML fragment. Every piece of text is escaped
 * and only the tags this function writes appear, so payload text interpolated
 * into a markdown body can never inject markup into an email.
 */
export function markdownToHtml(source: string): string {
  const out: string[] = [];
  const openLists: ('ul' | 'ol')[] = [];
  const closeListsTo = (depth: number): void => {
    while (openLists.length > depth) out.push(`</${openLists.pop()!}>`);
  };

  for (const block of parseMarkdownBlocks(source)) {
    if (block.kind !== 'list-item') closeListsTo(0);
    switch (block.kind) {
      case 'heading':
        out.push(`<h${block.level}>${runsToHtml(block.runs)}</h${block.level}>`);
        break;
      case 'paragraph':
        out.push(`<p>${runsToHtml(block.runs)}</p>`);
        break;
      case 'rule':
        out.push('<hr>');
        break;
      case 'code':
        out.push(`<pre><code>${escapeHtml(block.lines.join('\n'))}</code></pre>`);
        break;
      case 'list-item': {
        const tag = block.ordered ? 'ol' : 'ul';
        closeListsTo(block.depth + 1);
        while (openLists.length < block.depth + 1) {
          out.push(`<${tag}>`);
          openLists.push(tag);
        }
        out.push(`<li>${runsToHtml(block.runs)}</li>`);
        break;
      }
    }
  }
  closeListsTo(0);
  return out.join('\n');
}
