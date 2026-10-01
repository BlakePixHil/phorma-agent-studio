/**
 * Run artifacts on the Run_Table (document delivery G2).
 *
 * The engine's `ArtifactStore` contract, held against the real adapter over
 * the in-memory `DocumentTableClient`: bytes round-trip exactly across the
 * part boundary, a replacement overwrites rather than adds, `list` reports
 * creation order, every write is fenced while a lease is held, no read scans,
 * and purge removes every artifact item.
 *
 * Feature: aws-deployment-target, document-delivery-primitives
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { StoredArtifact } from '@phorma/engine';

import { FakeRunTable } from '../test/fake-run-table.js';
import { FakeDocumentTableClient } from '../test/fake-document-table-client.js';
import { RunTableAdapter } from './run-table.js';

const TABLE_NAME = 'phorma-run-table';
const WORKFLOW = 'wf-artifacts';
/** Raw bytes that encode to exactly one 300,000-character base64 part. */
const ONE_PART_BYTES = 225_000;

function makeAdapter() {
  const table = new FakeRunTable();
  const client = new FakeDocumentTableClient(table, { tableName: TABLE_NAME });
  const adapter = new RunTableAdapter(client, TABLE_NAME);
  return { adapter, client, store: adapter.createArtifactStore(WORKFLOW) };
}

function artifact(id: string, bytes: Uint8Array, createdAt = 1_790_000_000_000): StoredArtifact {
  return {
    ref: { id, name: `${id}.pdf`, mimeType: 'application/pdf', sizeBytes: bytes.length },
    nodeId: 'node-render',
    createdAt,
    bytes,
  };
}

function bytesOf(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Sizes on and around every part boundary, up to the engine's 1 MiB cap. */
const boundarySize = fc.constantFrom(
  0,
  1,
  ONE_PART_BYTES - 1,
  ONE_PART_BYTES,
  ONE_PART_BYTES + 1,
  2 * ONE_PART_BYTES,
  1_048_576,
);

describe('Run_Table ArtifactStore', () => {
  it('round-trips bytes exactly, small and across part boundaries', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.uint8Array({ maxLength: 4096 }), boundarySize.map(size => bytesOf(size, 7))),
        async bytes => {
          const { store } = makeAdapter();
          await store.put('run-1', artifact('art-a', bytes));
          const read = await store.get('run-1', 'art-a');
          expect(read?.ref).toEqual({
            id: 'art-a',
            name: 'art-a.pdf',
            mimeType: 'application/pdf',
            sizeBytes: bytes.length,
          });
          expect(read?.nodeId).toBe('node-render');
          expect(read !== undefined && sameBytes(read.bytes, bytes)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('a replacement overwrites, including a shorter one, and leaves no stale part', async () => {
    await fc.assert(
      fc.asyncProperty(boundarySize, boundarySize, async (first, second) => {
        const { adapter, store } = makeAdapter();
        await store.put('run-1', artifact('art-a', bytesOf(first, 1)));
        await store.put('run-1', artifact('art-a', bytesOf(second, 2)));
        const read = await store.get('run-1', 'art-a');
        expect(read !== undefined && sameBytes(read.bytes, bytesOf(second, 2))).toBe(true);
        expect(await store.list('run-1')).toHaveLength(1);
        // Header plus exactly the parts the second write needs.
        const expectedItems = 1 + Math.max(1, Math.ceil(Math.ceil(second / 3) * 4 / 300_000));
        expect((await adapter.purge(WORKFLOW)).artifacts).toBe(expectedItems);
      }),
      { numRuns: 100 },
    );
  });

  it('lists a run in creation order and keeps runs apart', async () => {
    const { store } = makeAdapter();
    await store.put('run-1', artifact('art-b', bytesOf(10, 1), 2_000));
    await store.put('run-1', artifact('art-a', bytesOf(10, 2), 1_000));
    await store.put('run-2', artifact('art-c', bytesOf(10, 3), 500));
    expect((await store.list('run-1')).map(ref => ref.id)).toEqual(['art-a', 'art-b']);
    expect((await store.list('run-2')).map(ref => ref.id)).toEqual(['art-c']);
    expect(await store.get('run-2', 'art-a')).toBeUndefined();
  });

  it('fences every write while a lease is held, and never scans', async () => {
    const { adapter, client, store } = makeAdapter();
    const lease = await adapter.acquire(WORKFLOW, 'runner-1', Date.now());
    expect(lease.granted).toBe(true);
    client.requests.length = 0;
    await store.put('run-1', artifact('art-a', bytesOf(2 * ONE_PART_BYTES + 5, 4)));
    await store.put('run-1', artifact('art-a', bytesOf(10, 5)));
    await store.list('run-1');
    const writes = client.requests.filter(request =>
      ['PutItem', 'DeleteItem', 'BatchWriteItem', 'TransactWriteItems'].includes(request.operation),
    );
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every(request => request.operation === 'TransactWriteItems')).toBe(true);
    expect(client.requests.some(request => (request.operation as string) === 'Scan')).toBe(false);
  });

  it('purge removes every artifact item and reports the count', async () => {
    const { adapter, store } = makeAdapter();
    await store.put('run-1', artifact('art-a', bytesOf(ONE_PART_BYTES + 1, 1)));
    await store.put('run-2', artifact('art-b', bytesOf(5, 2)));
    const counts = await adapter.purge(WORKFLOW);
    expect(counts.artifacts).toBe(5);
    expect(counts.failed).toEqual([]);
    expect(await store.list('run-1')).toEqual([]);
    expect(await store.get('run-2', 'art-b')).toBeUndefined();
  });
});
