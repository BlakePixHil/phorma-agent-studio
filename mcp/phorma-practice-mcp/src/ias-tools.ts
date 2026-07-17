/**
 * IAS pack tools — the bridge over the XPM API gap.
 *
 * Spike 0.1 finding: XPM's tax/Activity Statement screens (enter figures,
 * approve, export PDF, lodge to ATO) are NOT in the public API. So the
 * workflow generates its OWN IAS summary PDF for client signing, and
 * assembles a "lodgement pack" a staff member uses to complete the XPM/ATO
 * steps in one short manual pass, gated by an Approval Gate.
 *
 * The PDF is built from scratch (no dependencies): a single-page PDF 1.4
 * document with Helvetica text — legible, printable, and archivable.
 */

import { optionalString, requireString, type Tool } from './mcp.js';

export function iasTools(): Tool[] {
  return [generateIasPdfTool(), lodgementPackTool()];
}

function generateIasPdfTool(): Tool {
  return {
    definition: {
      name: 'ias_generate_pdf',
      description:
        'Generates the monthly IAS (PAYG withholding) summary PDF for a client entity to sign. Returns ' +
        'JSON { documentName, documentBase64 } ready to pass to esign_send. Amounts are AUD.',
      inputSchema: {
        type: 'object',
        properties: {
          entityName: { type: 'string', description: 'Legal name of the client entity.' },
          abn: { type: 'string', description: 'Entity ABN (optional but recommended).' },
          period: { type: 'string', description: 'The IAS period, e.g. "June 2026".' },
          grossWages: { type: 'number', description: 'W1 — total gross salary and wages.' },
          taxWithheld: { type: 'number', description: 'W2 — total PAYG amounts withheld.' },
          preparedBy: { type: 'string', description: 'The firm name shown in the footer.' },
        },
        required: ['entityName', 'period', 'grossWages', 'taxWithheld'],
      },
    },
    handler: async args => {
      const entityName = requireString(args, 'entityName');
      const period = requireString(args, 'period');
      const abn = optionalString(args, 'abn');
      const preparedBy = optionalString(args, 'preparedBy') ?? 'Prepared by your accounting firm';
      const grossWages = Number(args['grossWages']);
      const taxWithheld = Number(args['taxWithheld']);
      if (!Number.isFinite(grossWages) || !Number.isFinite(taxWithheld)) {
        throw new Error('grossWages and taxWithheld must be numbers.');
      }

      const aud = (value: number): string =>
        value.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });

      const lines: [string, string][] = [
        ['Instalment Activity Statement — PAYG Withholding', ''],
        ['', ''],
        ['Entity', entityName],
        ...(abn ? ([['ABN', abn]] as [string, string][]) : []),
        ['Period', period],
        ['', ''],
        ['W1  Total salary, wages and other payments', aud(grossWages)],
        ['W2  Amount withheld from payments at W1', aud(taxWithheld)],
        ['', ''],
        ['Amount payable to the ATO', aud(taxWithheld)],
        ['', ''],
        ['Declaration', ''],
        ['I declare that the information given on this form', ''],
        ['is true and correct, and authorise lodgement of', ''],
        ['this activity statement.', ''],
        ['', ''],
        ['Signature: ____________________________', ''],
        ['Date:       ____________________________', ''],
      ];

      const pdf = buildSimplePdf(lines, preparedBy);
      const documentName = `IAS-${entityName.replace(/[^A-Za-z0-9]+/g, '-')}-${period.replace(/[^A-Za-z0-9]+/g, '-')}.pdf`;
      return JSON.stringify({ documentName, documentBase64: pdf }, null, 2);
    },
  };
}

function lodgementPackTool(): Tool {
  return {
    definition: {
      name: 'ias_lodgement_pack',
      description:
        'Assembles the per-entity lodgement pack shown to staff at the approval gate before the manual ' +
        'XPM/ATO steps. Returns markdown summarising the figures, the Xero journal, the signed document ' +
        'status, and step-by-step XPM instructions.',
      inputSchema: {
        type: 'object',
        properties: {
          entityName: { type: 'string' },
          period: { type: 'string' },
          grossWages: { type: 'number' },
          taxWithheld: { type: 'number' },
          journalId: { type: 'string', description: 'The posted Xero manual journal id.' },
          journalDeepLink: { type: 'string' },
          signedDocumentNote: { type: 'string', description: 'e.g. "Signed by J. Smith on 2026-07-05 (Annature envelope abc123)".' },
          xpmJobId: { type: 'string' },
        },
        required: ['entityName', 'period', 'grossWages', 'taxWithheld'],
      },
    },
    handler: async args => {
      const aud = (value: unknown): string =>
        Number(value).toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });
      const entityName = requireString(args, 'entityName');
      const period = requireString(args, 'period');
      return [
        `## IAS lodgement pack — ${entityName} (${period})`,
        '',
        '| Field | Value |',
        '|---|---|',
        `| W1 Gross wages | ${aud(args['grossWages'])} |`,
        `| W2 PAYG withheld | ${aud(args['taxWithheld'])} |`,
        `| Amount payable | ${aud(args['taxWithheld'])} |`,
        ...(args['journalId'] ? [`| Xero journal | ${args['journalId']}${args['journalDeepLink'] ? ` ([open](${args['journalDeepLink']}))` : ''} |`] : []),
        ...(args['signedDocumentNote'] ? [`| Client signature | ${args['signedDocumentNote']} |`] : []),
        ...(args['xpmJobId'] ? [`| XPM job | ${args['xpmJobId']} |`] : []),
        '',
        '### Manual steps (XPM Tax — not available via API)',
        '',
        `1. Open the entity's IAS for ${period} in XPM Tax.`,
        `2. Enter W1 ${aud(args['grossWages'])} and W2 ${aud(args['taxWithheld'])}.`,
        '3. Complete and approve the statement.',
        '4. Lodge to the ATO.',
        '5. Approve this gate to mark the job complete.',
      ].join('\n');
    },
  };
}

// ── Dependency-free single-page PDF ──────────────────────────────────────────

/** Escapes a string for a PDF literal. */
function pdfEscape(value: string): string {
  // Strip non-Latin-1 (Helvetica WinAnsi) characters; em-dash → hyphen.
  const safe = value.replace(/\u2014/g, '-').replace(/[^\x20-\xFF]/g, '');
  return safe.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Builds a one-page A4 PDF with left/right column rows; returns base64. */
function buildSimplePdf(rows: [string, string][], footer: string): string {
  const content: string[] = ['BT', '/F1 11 Tf'];
  let y = 790;
  for (const [left, right] of rows) {
    if (left || right) {
      const size = y === 790 ? 16 : 11;
      content.push(`/F1 ${size} Tf`);
      content.push(`1 0 0 1 57 ${y} Tm (${pdfEscape(left)}) Tj`);
      if (right) content.push(`1 0 0 1 380 ${y} Tm (${pdfEscape(right)}) Tj`);
    }
    y -= y === 790 ? 34 : 22;
  }
  content.push('/F1 8 Tf');
  content.push(`1 0 0 1 57 40 Tm (${pdfEscape(footer)}) Tj`);
  content.push('ET');
  const stream = content.join('\n');

  const objects: string[] = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
  );
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  // Latin-1 → base64 (PDF text is single-byte here).
  return btoa(pdf);
}
