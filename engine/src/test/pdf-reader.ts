/**
 * A deliberately independent, minimal PDF reader for tests. It does NOT reuse
 * `pdf.ts`: it parses the bytes the way a viewer would (xref offsets, object
 * headers, page objects, `Tj` strings with octal escapes), so a writer bug
 * cannot pass by agreeing with itself.
 */

export interface PdfInspection {
  header: string;
  pageCount: number;
  /** Decoded `Tj` strings in content order (WinAnsi decoded to Unicode). */
  text: string;
  /** True when every xref entry points at its `N 0 obj` header. */
  xrefValid: boolean;
  /** `/URI` targets of link annotations. */
  links: string[];
}

/** WinAnsi 0x80-0x9F back to Unicode, the bytes tests care about. */
const WIN_ANSI_HIGH: Readonly<Record<number, string>> = {
  0x80: '\u20ac', 0x85: '\u2026', 0x91: '\u2018', 0x92: '\u2019', 0x93: '\u201c', 0x94: '\u201d',
  0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014', 0x99: '\u2122',
};

function decodePdfString(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1]!;
    if (/[0-7]/.test(next)) {
      const octal = /^[0-7]{1,3}/.exec(raw.slice(i + 1))![0];
      const byte = Number.parseInt(octal, 8);
      out += WIN_ANSI_HIGH[byte] ?? String.fromCharCode(byte);
      i += octal.length;
    } else {
      out += next === 'n' ? '\n' : next;
      i += 1;
    }
  }
  return out;
}

export function inspectPdf(bytes: Uint8Array): PdfInspection {
  let source = '';
  for (const byte of bytes) source += String.fromCharCode(byte);

  const startxref = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(source);
  let xrefValid = false;
  if (startxref) {
    const at = Number(startxref[1]);
    const table = /^xref\s+0 (\d+)\s+([\s\S]*?)trailer/.exec(source.slice(at));
    if (table) {
      const entries = table[2]!.trim().split(/\s*\n\s*/).slice(1);
      xrefValid =
        entries.length === Number(table[1]) - 1 &&
        entries.every((entry, index) => {
          const offset = Number(entry.slice(0, 10));
          return source.startsWith(`${index + 1} 0 obj`, offset);
        });
    }
  }

  const pageCount = (source.match(/\/Type \/Page\b(?!s)/g) ?? []).length;
  const strings: string[] = [];
  for (const match of source.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)) strings.push(decodePdfString(match[1]!));
  const links = [...source.matchAll(/\/URI \(((?:\\.|[^\\)])*)\)/g)].map(match => decodePdfString(match[1]!));

  return {
    header: source.slice(0, 8),
    pageCount,
    text: strings.join(''),
    xrefValid,
    links,
  };
}
