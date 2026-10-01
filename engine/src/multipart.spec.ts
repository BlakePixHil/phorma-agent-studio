/**
 * Multipart encoding (Requirement 6) and the shared base64 codec and artifact
 * helpers it rides on (Requirement 2).
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_NAME_MAX_CHARS,
  artifactId,
  collectArtifactRefs,
  decodeBase64,
  encodeBase64,
  isArtifactRef,
  sanitizeArtifactName,
  utf8,
} from './artifacts.js';
import { encodeMultipart, type MultipartPart } from './multipart.js';

const latin1 = (bytes: Uint8Array): string => [...bytes].map(byte => String.fromCharCode(byte)).join('');

describe('encodeMultipart', () => {
  it('writes RFC 7578 parts', () => {
    const encoded = encodeMultipart([
      { kind: 'field', name: 'email', value: 'a@b.test' },
      { kind: 'file', name: 'file', fileName: 'Report "Q1".pdf', mimeType: 'application/pdf', bytes: new Uint8Array([0x25, 0x50, 0xff]) },
    ]);
    const body = latin1(encoded.bytes);
    const b = encoded.boundary;
    expect(encoded.contentType).toBe(`multipart/form-data; boundary=${b}`);
    expect(body).toBe(
      `--${b}\r\nContent-Disposition: form-data; name="email"\r\n\r\na@b.test\r\n` +
        `--${b}\r\nContent-Disposition: form-data; name="file"; filename="Report \\"Q1\\".pdf"\r\n` +
        `Content-Type: application/pdf\r\n\r\n%P\u00ff\r\n--${b}--\r\n`,
    );
  });

  it('is deterministic and its boundary never occurs inside a part (Requirement 6.2)', () => {
    const partArb: fc.Arbitrary<MultipartPart> = fc.oneof(
      fc.record({ kind: fc.constant('field' as const), name: fc.string({ minLength: 1 }), value: fc.string() }),
      fc.record({
        kind: fc.constant('file' as const),
        name: fc.string({ minLength: 1 }),
        fileName: fc.string(),
        mimeType: fc.constant('application/octet-stream'),
        bytes: fc.uint8Array({ maxLength: 200 }),
      }),
    );
    fc.assert(
      fc.property(fc.array(partArb, { minLength: 1, maxLength: 5 }), parts => {
        const first = encodeMultipart(parts);
        expect(encodeMultipart(parts).bytes).toEqual(first.bytes);
        const marker = `--${first.boundary}`;
        for (const part of parts) {
          const content = part.kind === 'file' ? latin1(part.bytes) : latin1(utf8(part.value));
          expect(content.includes(marker)).toBe(false);
        }
      }),
    );
  });

  it('salts the boundary when a part contains the first boundary tried', () => {
    const probe = encodeMultipart([{ kind: 'field', name: 'x', value: '' }]);
    const hostile = encodeMultipart([{ kind: 'field', name: 'x', value: `--${probe.boundary}` }]);
    expect(hostile.boundary).not.toBe(probe.boundary);
  });
});

describe('base64', () => {
  it('round-trips any bytes and matches the platform encoder', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), bytes => {
        const encoded = encodeBase64(bytes);
        expect(decodeBase64(encoded)).toEqual(bytes);
        expect(encoded).toBe(btoa(latin1(bytes)));
      }),
    );
    expect(() => decodeBase64('ab$d')).toThrow(/Invalid/);
  });
});

describe('artifact helpers', () => {
  it('derives stable, well-formed ids', () => {
    const id = artifactId('run-1', 'node|abc|0', 'a.pdf');
    expect(id).toBe(artifactId('run-1', 'node|abc|0', 'a.pdf'));
    expect(id).not.toBe(artifactId('run-1', 'node|abc|1', 'a.pdf'));
    expect(isArtifactRef({ id, name: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 3 })).toBe(true);
    expect(isArtifactRef({ id: 'x', name: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 3 })).toBe(false);
  });

  it('sanitises any name into a safe file name (Requirement 3.7)', () => {
    fc.assert(
      fc.property(fc.string(), raw => {
        const name = sanitizeArtifactName(raw, 'pdf');
        expect(name.endsWith('.pdf')).toBe(true);
        expect(name.length).toBeLessThanOrEqual(ARTIFACT_NAME_MAX_CHARS);
        expect(/[\\/:*?"<>|\u0000-\u001f]/.test(name)).toBe(false);
        expect(name.startsWith('.')).toBe(false);
      }),
    );
    expect(sanitizeArtifactName('Ada / Acme: Report.PDF', 'pdf')).toBe('Ada - Acme- Report.pdf');
  });

  it('collects refs from paths and refuses non-refs', () => {
    const ref = { id: artifactId('r', 'k', 'a'), name: 'a', mimeType: 'text/plain', sizeBytes: 1 };
    const payload = JSON.stringify({ one: ref, many: [ref, null], bad: { id: 1 } });
    expect(collectArtifactRefs(payload, ['one', 'many'])).toEqual([ref, ref]);
    expect(() => collectArtifactRefs(payload, ['bad'])).toThrow(/not a file reference/);
    expect(() => collectArtifactRefs(payload, ['missing'])).toThrow(/No file reference/);
  });
});
