import DOMPurify from 'dompurify';
import { marked } from 'marked';

/**
 * Renders markdown to sanitized HTML.
 *
 * Every markdown preview in the studio goes through here (prompt panel,
 * prompt dialog, skill editor): marked for parsing, DOMPurify for sanitizing.
 * Callers still have to wrap the result in `DomSanitizer.bypassSecurityTrustHtml`
 * before binding to `[innerHTML]` — that keeps the Angular dependency out of
 * this module.
 */
export function renderMarkdown(source: string): string {
  if (!source) return '';
  const raw = marked.parse(source, { async: false });
  return DOMPurify.sanitize(raw);
}
