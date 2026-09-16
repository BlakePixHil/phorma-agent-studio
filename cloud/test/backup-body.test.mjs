/**
 * `BackupBodyStore` - the R2 half of hosted workflow backup
 * (cloud-workflow-backup, Requirements 10, 11).
 *
 * ## What is actually at risk here
 *
 * 1. **The round trip.** A backup that cannot be read back is not a backup. The
 *    property below pushes generated specs through the real
 *    `JSON -> gzip -> AES-GCM -> R2 -> AES-GCM -> gunzip -> JSON` pipeline and
 *    compares the PARSED result, because that is what a restore actually consumes
 *    (Requirement 10.12).
 * 2. **The order of gzip and encrypt.** Ciphertext does not compress, so encrypting
 *    first would store every workflow at full size forever. Asserted by measuring:
 *    a repetitive spec must come out of the pipeline much smaller than it went in.
 * 3. **Nothing readable at rest.** The stored object must not contain the plaintext
 *    JSON, and its metadata must not leak the workflow's name through a bucket
 *    listing.
 * 4. **The retention bound.** At most `keep` bodies survive, and the NEWEST is
 *    always among them - a prune that dropped the newest would leave a metadata row
 *    pointing at nothing (Requirement 10.13).
 *
 * ## Harness
 *
 * Miniflare's real R2 binding, reached from Node. `CompressionStream`,
 * `DecompressionStream` and `crypto.subtle` are all present in Node 22+, so the
 * pipeline runs unmodified - this exercises the shipping code rather than a
 * re-implementation.
 *
 * Run: npx tsx cloud/test/backup-body.test.mjs
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import fc from 'fast-check';

import { BackupBodyStore, bodyKey, bodyPrefix } from '../src/backup-store.ts';
import { decryptBytes, encryptBytes } from '../src/tenants.ts';

void dirname(fileURLToPath(import.meta.url));

/** A 32-byte base64 AES-GCM key, as `KEY_ENC_SECRET` carries. */
const KEY_ENC_SECRET = Buffer.from(
  Uint8Array.from({ length: 32 }, (_unused, index) => (index * 7 + 11) % 256),
).toString('base64');

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch: () => new Response("ok") };',
  compatibilityDate: '2025-05-01',
  r2Buckets: { BACKUPS: 'phorma-backups-test' },
});

const BACKUPS = await mf.getR2Bucket('BACKUPS');
const store = new BackupBodyStore({ BACKUPS, KEY_ENC_SECRET });

/** A realistically repetitive workflow spec. */
function spec(id, nodes = 12) {
  return {
    version: 1,
    id,
    name: `Workflow ${id}`,
    savedAt: '2026-09-01T00:00:00.000Z',
    graph: {
      nodes: Array.from({ length: nodes }, (_unused, index) => ({
        id: `agent-${index}`,
        name: `Step ${index}`,
        kind: 'agent',
        category: 'flow',
        icon: 'ti ti-robot',
        position: { x: index * 220, y: 0 },
        ports: [
          { id: `agent-${index}-in`, name: 'In', role: 'message-in' },
          { id: `agent-${index}-out`, name: 'Out', role: 'message-out' },
        ],
        data: { prompt: 'Summarize the input in one short paragraph.', provider: 'ollama' },
      })),
      connections: Array.from({ length: nodes - 1 }, (_unused, index) => ({
        id: `edge-${index}`,
        outputId: `agent-${index}-out`,
        inputId: `agent-${index + 1}-in`,
        kind: 'handoff',
      })),
    },
  };
}

// --- 1. Availability ------------------------------------------------------

console.log('\nAvailability reports which binding is missing');
{
  check('a bound bucket and key is enabled', store.enabled === true);
  check('unavailable() is null when enabled', store.unavailable() === null);

  const noBucket = new BackupBodyStore({ KEY_ENC_SECRET });
  check('no bucket reports no-bucket', noBucket.unavailable()?.reason === 'no-bucket', JSON.stringify(noBucket.unavailable()));

  // Two distinct refusals rather than one boolean, because the remedies are
  // different operator actions: create the bucket, or set the secret.
  const noKey = new BackupBodyStore({ BACKUPS });
  check('no key reports no-key', noKey.unavailable()?.reason === 'no-key', JSON.stringify(noKey.unavailable()));
  check('either refusal disables the store', noBucket.enabled === false && noKey.enabled === false);
}

// --- 2. Keys -------------------------------------------------------------

console.log('\nKey shape');
{
  check('the key is backup/{tenant}/{workflow}/{revision}', bodyKey('user_1', 'wf-a', 3) === 'backup/user_1/wf-a/3');
  // The tenant id is the FIRST segment, which is what makes a prefix list
  // naturally scoped to one account - no second index needed for delete-all.
  check('the prefix scopes to one workflow', bodyPrefix('user_1', 'wf-a') === 'backup/user_1/wf-a/');
  check('the workflow prefix is inside the tenant prefix', bodyPrefix('user_1', 'wf-a').startsWith('backup/user_1/'));
}

// --- 3. Round trip -------------------------------------------------------

console.log('\nStore and read back');
{
  const body = spec('wf-round');
  const json = JSON.stringify(body);
  await store.put('user_1', 'wf-round', 1, json);

  const read = await store.get('user_1', 'wf-round', 1);
  check('the JSON comes back byte-identical', read === json, `${read?.length} vs ${json.length}`);
  check('and parses to the same spec', JSON.stringify(JSON.parse(read)) === json);
  check('a revision that was never written reads null', (await store.get('user_1', 'wf-round', 9)) === null);
  check('another tenant cannot read it', (await store.get('user_2', 'wf-round', 1)) === null);
}

console.log('\nCompression happens BEFORE encryption');
{
  const json = JSON.stringify(spec('wf-size', 40));
  await store.put('user_1', 'wf-size', 1, json);
  const object = await BACKUPS.get(bodyKey('user_1', 'wf-size', 1));
  const storedBytes = (await object.arrayBuffer()).byteLength;

  // Ciphertext does not compress. If the pipeline encrypted first, the stored size
  // would be at or above the plaintext size instead of a fraction of it.
  check(
    'the stored object is much smaller than the plaintext',
    storedBytes < json.length / 2,
    `${storedBytes} stored vs ${json.length} plaintext`,
  );
  check('and is not empty', storedBytes > 0, String(storedBytes));
}

console.log('\nNothing readable at rest');
{
  const json = JSON.stringify(spec('wf-secret'));
  await store.put('user_1', 'wf-secret', 1, json);
  const object = await BACKUPS.get(bodyKey('user_1', 'wf-secret', 1));
  const raw = Buffer.from(await object.arrayBuffer());

  check('the stored bytes do not contain the workflow name', !raw.includes(Buffer.from('Workflow wf-secret')));
  check('the stored bytes do not contain a prompt', !raw.includes(Buffer.from('Summarize the input')));
  check('the stored bytes are not JSON', raw[0] !== 0x7b, String(raw[0]));

  // Metadata records the format so an operator can identify an opaque object, and
  // NOTHING about the workflow - a name here would leak through a bucket listing
  // the body itself encrypts.
  check('metadata names the format', object.customMetadata?.format === 'gzip+aes-gcm', JSON.stringify(object.customMetadata));
  check('metadata carries the revision', object.customMetadata?.revision === '1');
  check(
    'metadata leaks nothing about the workflow',
    !JSON.stringify(object.customMetadata ?? {}).includes('Workflow'),
    JSON.stringify(object.customMetadata),
  );
}

console.log('\nA wrong key fails loudly, never as an empty backup');
{
  await store.put('user_1', 'wf-wrongkey', 1, JSON.stringify(spec('wf-wrongkey')));
  const otherKey = Buffer.alloc(32, 9).toString('base64');
  const wrong = new BackupBodyStore({ BACKUPS, KEY_ENC_SECRET: otherKey });

  let threw = false;
  try {
    await wrong.get('user_1', 'wf-wrongkey', 1);
  } catch {
    threw = true;
  }
  // "Not here" and "here and unreadable" need different answers; the second is an
  // incident, and answering null would hide it.
  check('a wrong key throws rather than answering null', threw === true);
}

console.log('\nProperty: backup body round trip (Requirement 10.12)');
{
  await fc.assert(
    fc.asyncProperty(
      fc.stringMatching(/^wf-[a-z0-9]{4,10}$/),
      fc.integer({ min: 1, max: 25 }),
      async (workflowId, nodes) => {
        const body = spec(workflowId, nodes);
        const json = JSON.stringify(body);
        await store.put('user_prop', workflowId, 1, json);
        const read = await store.get('user_prop', workflowId, 1);
        await store.deleteWorkflow('user_prop', workflowId);
        if (read === null) return false;
        // Compared as PARSED specs, because that is what a restore consumes.
        return JSON.stringify(JSON.parse(read)) === json;
      },
    ),
    { numRuns: 60 },
  );
  check('every generated spec survives the pipeline unchanged', true);
}

// --- 4. Revisions and retention ------------------------------------------

console.log('\nRevisions');
{
  for (const revision of [1, 2, 3]) {
    await store.put('user_rev', 'wf-r', revision, JSON.stringify(spec('wf-r', revision)));
  }
  const listed = await store.revisions('user_rev', 'wf-r');
  check('revisions come back newest first', listed.join(',') === '3,2,1', listed.join(','));
  check('an unknown workflow has no revisions', (await store.revisions('user_rev', 'wf-none')).length === 0);

  // Read from R2 rather than from a D1 counter, so a half-completed prune cannot
  // make the list promise a body it cannot serve.
  await BACKUPS.delete(bodyKey('user_rev', 'wf-r', 2));
  check('the list reflects what R2 actually holds', (await store.revisions('user_rev', 'wf-r')).join(',') === '3,1');
}

console.log('\nProperty: retention keeps at most N and always the newest (10.13)');
{
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 14 }),
      fc.integer({ min: 1, max: 5 }),
      async (uploads, keep) => {
        const workflowId = `wf-keep-${Math.random().toString(36).slice(2, 10)}`;
        for (let revision = 1; revision <= uploads; revision += 1) {
          await store.put('user_keep', workflowId, revision, JSON.stringify(spec(workflowId, 2)));
          await store.prune('user_keep', workflowId, keep);
        }
        const left = await store.revisions('user_keep', workflowId);
        await store.deleteWorkflow('user_keep', workflowId);
        // At most `keep`, and the newest is present - a prune that dropped the
        // newest would leave a metadata row pointing at nothing.
        return left.length <= keep && left[0] === uploads;
      },
    ),
    { numRuns: 40 },
  );
  check('at most `keep` bodies survive, newest always among them', true);
}

{
  // A cap of 0 must still keep the newest: `Math.max(1, keep)` inside `prune`. A
  // misconfigured cap cannot be allowed to orphan a metadata row.
  await store.put('user_zero', 'wf-z', 1, JSON.stringify(spec('wf-z', 2)));
  await store.put('user_zero', 'wf-z', 2, JSON.stringify(spec('wf-z', 2)));
  const pruned = await store.prune('user_zero', 'wf-z', 0);
  check('pruning with keep=0 still leaves the newest', (await store.revisions('user_zero', 'wf-z')).join(',') === '2', JSON.stringify(pruned));
}

// --- 5. Deletion ---------------------------------------------------------

console.log('\nDeletion');
{
  await store.put('user_dele', 'wf-a', 1, JSON.stringify(spec('wf-a', 2)));
  await store.put('user_dele', 'wf-a', 2, JSON.stringify(spec('wf-a', 2)));
  await store.put('user_dele', 'wf-b', 1, JSON.stringify(spec('wf-b', 2)));

  check('deleteWorkflow reports how many bodies went', (await store.deleteWorkflow('user_dele', 'wf-a')) === 2);
  check('every revision of that workflow is gone', (await store.revisions('user_dele', 'wf-a')).length === 0);
  check('the sibling workflow survives', (await store.revisions('user_dele', 'wf-b')).length === 1);
  check('deleteWorkflow is idempotent', (await store.deleteWorkflow('user_dele', 'wf-a')) === 0);
}

{
  await store.put('user_wipe', 'wf-a', 1, JSON.stringify(spec('wf-a', 2)));
  await store.put('user_wipe', 'wf-b', 1, JSON.stringify(spec('wf-b', 2)));
  await store.put('user_keepme', 'wf-c', 1, JSON.stringify(spec('wf-c', 2)));

  // A prefix scan, not a loop over known ids: this is the "delete everything"
  // control a user reaches for on privacy grounds, and an object whose metadata row
  // was already gone must still go or the promise is false.
  const removed = await store.deleteTenant('user_wipe');
  check('deleteTenant removes every body it owns', removed === 2, String(removed));
  check('nothing of that tenant is left', (await store.revisions('user_wipe', 'wf-a')).length === 0);
  check("another tenant's bodies are untouched", (await store.revisions('user_keepme', 'wf-c')).length === 1);
  check('deleteTenant is idempotent', (await store.deleteTenant('user_wipe')) === 0);
}

// --- 6. The byte cipher itself -------------------------------------------

console.log('\nencryptBytes / decryptBytes');
{
  const plain = new Uint8Array([0, 1, 2, 250, 251, 255]);
  const sealed = await encryptBytes(plain, KEY_ENC_SECRET);
  check('the IV is prefixed, so the output is longer', sealed.length > plain.length + 12 - 1);
  check('the ciphertext differs from the plaintext', Buffer.compare(Buffer.from(sealed.slice(12)), Buffer.from(plain)) !== 0);

  const opened = await decryptBytes(sealed, KEY_ENC_SECRET);
  check('bytes round-trip exactly', Buffer.compare(Buffer.from(opened), Buffer.from(plain)) === 0);

  // A fresh IV per call, so the same plaintext never produces the same object.
  const again = await encryptBytes(plain, KEY_ENC_SECRET);
  check('two encryptions of the same bytes differ', Buffer.compare(Buffer.from(sealed), Buffer.from(again)) !== 0);

  const empty = await decryptBytes(await encryptBytes(new Uint8Array(0), KEY_ENC_SECRET), KEY_ENC_SECRET);
  check('an empty payload round-trips', empty.length === 0);
}

await mf.dispose();

console.log(failures === 0 ? '\nAll backup-body checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
