/**
 * The small, statically needed half of the document-delivery primitives: the
 * limits and vocabularies the capability validator and the properties panel
 * read. The PDF writer, the markdown renderer, the email adapters and the
 * multipart encoder are loaded lazily by the engine when a step needs them, so
 * a host that never renders or attaches a file never parses their code.
 */

export const DOCUMENT_LAYOUT_LIMITS = {
  marginMm: { min: 5, max: 50, default: 18 },
  fontSize: { min: 7, max: 16, default: 10.5 },
  accentColor: { default: '#1f4e79' },
} as const;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Every problem with a `render-document` layout record, as sentences. Empty when valid. */
export function describeLayoutIssues(layout: unknown): string[] {
  if (layout === undefined || layout === null) return [];
  if (typeof layout !== 'object' || Array.isArray(layout)) return ['the layout must be an object.'];
  const record = layout as Record<string, unknown>;
  const issues: string[] = [];
  const size = record['pageSize'];
  if (size !== undefined && size !== 'a4' && size !== 'letter') {
    issues.push(`page size "${String(size)}" is not a4 or letter.`);
  }
  const range = (key: 'marginMm' | 'fontSize', what: string): void => {
    const value = record[key];
    if (value === undefined) return;
    const { min, max } = DOCUMENT_LAYOUT_LIMITS[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      issues.push(`${what} must be a number from ${min} to ${max}.`);
    }
  };
  range('marginMm', 'the margin (mm)');
  range('fontSize', 'the font size (pt)');
  const accent = record['accentColor'];
  if (accent !== undefined && (typeof accent !== 'string' || !HEX_COLOR.test(accent))) {
    issues.push('the accent colour must be a #rrggbb hex value.');
  }
  return issues;
}

/** Email adapters a connection may select with `config.emailProvider`. */
export const EMAIL_PROVIDER_IDS = ['generic-json', 'resend'] as const;
export type EmailProviderId = (typeof EMAIL_PROVIDER_IDS)[number];

/** Largest total raw attachment size on one email (Resend allows 40 MB encoded). */
export const EMAIL_ATTACHMENTS_MAX_BYTES = 10_485_760;
