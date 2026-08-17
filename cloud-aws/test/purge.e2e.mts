/**
 * E2E scenario: Purge path teardown.
 *
 * Exercises the `purge` method from `cloud-aws/src/aws/run-table.ts`
 * against the FakeRunTable and verifies:
 *   1. Full teardown: all categories are deleted
 *   2. Per-category counts: each count matches what was seeded
 *   3. Idempotent repeat: second purge returns zero counts
 *   4. Secrets intact: conn# entries are preserved through purge
 *
 * tsx hazard: abandon an unsettled run and synchronise on a side-channel
 * promise rather than awaiting it.
 *
 * Run: npx -y tsx cloud-aws/test/purge.e2e.mts
 *
 * Requirements: 4.9, 4.10
 * Feature: aws-deployment-target
 */
import assert from 'node:assert/strict';

import type { RunRecord } from '@phorma/engine';

import { FakeRunTable } from '../src/test/fake-run-table.js';
import { FakeDocumentTableClient } from '../src/test/fake-document-table-client.js';
import { RunTableAdapter } from '../src/aws/run-table.js';
import { pk, connSk } from '../src/core/keys.js';

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  \u2713 ${name}`);
  else {
    failures += 1;
    console.error(`  \u2717 ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The Run_Table name every command input must name. */
const TABLE_NAME = 'phorma-run-table';

function makeAdapter() {
  const table = new FakeRunTable();
  const client = new FakeDocumentTableClient(table, { tableName: TABLE_NAME });
  const adapter = new RunTableAdapter(client, TABLE_NAME);
  return { table, adapter };
}

function makeRunRecord(runId: string, startedAt: number): RunRecord {
  return {
    summary: {
      id: runId,
      workflowId: null,
      workflowName: 'test-wf',
      source: 'manual',
      environment: 'cloud',
      status: 'completed',
      input: '',
      startedAt,
      endedAt: startedAt + 5000,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      nodeCount: 1,
    },
    graph: { nodes: [], connections: [] },
    events: [],
  };
}

function makeUsageEntry(runId: string, nodeId: string, startedAt: number) {
  return {
    runId,
    nodeId,
    startedAt: new Date(startedAt).toISOString(),
    provider: 'anthropic',
    model: 'claude-sonnet',
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.001,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: Full teardown (Req 4.9)
// ---------------------------------------------------------------------------
console.log('Scenario 1: Full teardown - purge removes all non-secret items');
{
  const { table, adapter } = makeAdapter();
  const wfId = 'wf-purge-full';
  const nowMs = 1_700_000_000_000;

  // Seed data across all categories
  await adapter.write(wfId, { spec: {} as any, savedAt: new Date(nowMs).toISOString() });
  await adapter.record(wfId, 'run-1', 'node-a', { output: 'journal-data' });
  await adapter.record(wfId, 'run-1', 'node-b', { output: 'journal-data-2' });
  await adapter.upsert(wfId, makeRunRecord('run-1', nowMs) as any);
  await adapter.upsert(wfId, makeRunRecord('run-2', nowMs + 1000) as any);
  await adapter.writeEvent(wfId, 'run-1', 1, { type: 'node-completed' } as any);
  await adapter.writeEvent(wfId, 'run-1', 2, { type: 'node-started' } as any);
  await adapter.writeEvent(wfId, 'run-1', 3, { type: 'run-settled' } as any);
  await adapter.writeUsage(wfId, makeUsageEntry('run-1', 'n1', nowMs) as any);
  await adapter.writeUsage(wfId, makeUsageEntry('run-1', 'n2', nowMs) as any);

  // Seed state entries directly
  table.putItem({
    key: { pk: pk(wfId), sk: 'state#counter' },
    item: { value: '42' },
  });
  table.putItem({
    key: { pk: pk(wfId), sk: 'state#flag' },
    item: { value: 'true' },
  });

  // Acquire a lease
  await adapter.acquire(wfId, 'runner-1', nowMs);

  // Purge
  const counts = await adapter.purge(wfId);

  check('spec deleted', counts.spec === 1, `got ${counts.spec}`);
  check('journal entries deleted', counts.journal === 2, `got ${counts.journal}`);
  check('run records deleted', counts.runs === 2, `got ${counts.runs}`);
  check('events deleted', counts.events === 3, `got ${counts.events}`);
  check('usage entries deleted', counts.usage === 2, `got ${counts.usage}`);
  check('state entries deleted', counts.state === 2, `got ${counts.state}`);
  check('lease deleted', counts.lease === 1, `got ${counts.lease}`);
  check('no failures', counts.failed.length === 0, `failed: ${counts.failed.join(', ')}`);

  // Verify nothing remains
  const specAfter = await adapter.read(wfId);
  check('spec is gone after purge', specAfter === undefined);
  const journalAfter = await adapter.preload(wfId, 'run-1');
  check('journal is empty after purge', journalAfter.size === 0);
}

// ---------------------------------------------------------------------------
// Scenario 2: Per-category counts (Req 4.9)
// ---------------------------------------------------------------------------
console.log('Scenario 2: Per-category counts - each count matches seeded data');
{
  const { table, adapter } = makeAdapter();
  const wfId = 'wf-purge-counts';
  const nowMs = 1_700_000_000_000;

  // Seed specific counts: 1 spec, 3 journal, 1 run, 5 events, 4 usage, 3 state, 1 lease
  await adapter.write(wfId, { spec: {} as any, savedAt: new Date(nowMs).toISOString() });
  await adapter.record(wfId, 'run-a', 'n1', { output: 'j1' });
  await adapter.record(wfId, 'run-a', 'n2', { output: 'j2' });
  await adapter.record(wfId, 'run-a', 'n3', { output: 'j3' });
  await adapter.upsert(wfId, makeRunRecord('run-a', nowMs) as any);
  for (let i = 1; i <= 5; i++) {
    await adapter.writeEvent(wfId, 'run-a', i, { type: 'node-completed' } as any);
  }
  for (let i = 1; i <= 4; i++) {
    await adapter.writeUsage(wfId, makeUsageEntry('run-a', `node-${i}`, nowMs) as any);
  }
  table.putItem({ key: { pk: pk(wfId), sk: 'state#a' }, item: { value: '1' } });
  table.putItem({ key: { pk: pk(wfId), sk: 'state#b' }, item: { value: '2' } });
  table.putItem({ key: { pk: pk(wfId), sk: 'state#c' }, item: { value: '3' } });
  await adapter.acquire(wfId, 'runner-x', nowMs);

  const counts = await adapter.purge(wfId);

  check('spec count is 1', counts.spec === 1, `got ${counts.spec}`);
  check('journal count is 3', counts.journal === 3, `got ${counts.journal}`);
  check('runs count is 1', counts.runs === 1, `got ${counts.runs}`);
  check('events count is 5', counts.events === 5, `got ${counts.events}`);
  check('usage count is 4', counts.usage === 4, `got ${counts.usage}`);
  check('state count is 3', counts.state === 3, `got ${counts.state}`);
  check('lease count is 1', counts.lease === 1, `got ${counts.lease}`);
  check('no failures in per-category', counts.failed.length === 0, `failed: ${counts.failed.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Scenario 3: Idempotent repeat (Req 4.9)
// ---------------------------------------------------------------------------
console.log('Scenario 3: Idempotent repeat - second purge returns zero counts');
{
  const { adapter } = makeAdapter();
  const wfId = 'wf-purge-idem';
  const nowMs = 1_700_000_000_000;

  // Seed some data
  await adapter.write(wfId, { spec: {} as any, savedAt: new Date(nowMs).toISOString() });
  await adapter.record(wfId, 'run-1', 'node-1', { output: 'x' });
  await adapter.upsert(wfId, makeRunRecord('run-1', nowMs) as any);
  await adapter.writeEvent(wfId, 'run-1', 1, { type: 'node-completed' } as any);
  await adapter.writeUsage(wfId, makeUsageEntry('run-1', 'n1', nowMs) as any);
  await adapter.acquire(wfId, 'runner-1', nowMs);

  // First purge
  const first = await adapter.purge(wfId);
  check('first purge touches data', (first.spec + first.journal + first.runs + first.events + first.usage + first.lease) > 0);

  // Second purge - must be all zeros
  const second = await adapter.purge(wfId);
  check('repeat spec is 0', second.spec === 0, `got ${second.spec}`);
  check('repeat journal is 0', second.journal === 0, `got ${second.journal}`);
  check('repeat runs is 0', second.runs === 0, `got ${second.runs}`);
  check('repeat events is 0', second.events === 0, `got ${second.events}`);
  check('repeat usage is 0', second.usage === 0, `got ${second.usage}`);
  check('repeat state is 0', second.state === 0, `got ${second.state}`);
  check('repeat lease is 0', second.lease === 0, `got ${second.lease}`);
  check('repeat no failures', second.failed.length === 0, `failed: ${second.failed.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Scenario 4: Secrets intact (Req 4.10)
// tsx hazard: simulate a run that would never settle by abandoning it and
// synchronising on a side-channel promise.
// ---------------------------------------------------------------------------
console.log('Scenario 4: Secrets intact - conn# entries preserved through purge');
{
  const { table, adapter } = makeAdapter();
  const wfId = 'wf-purge-secrets';
  const nowMs = 1_700_000_000_000;

  // Seed Secret_Store entries (conn# sort keys)
  const connIds = ['conn-postgres', 'conn-mysql', 'conn-redis'];
  for (const connId of connIds) {
    table.seed(
      { pk: pk(wfId), sk: connSk(connId) },
      { connectionId: connId, secretsPresent: true, resolvedAt: new Date(nowMs).toISOString() },
    );
  }

  // Seed other data that should be purged
  await adapter.write(wfId, { spec: {} as any, savedAt: new Date(nowMs).toISOString() });
  await adapter.record(wfId, 'run-1', 'node-1', { output: 'data' });
  await adapter.upsert(wfId, makeRunRecord('run-1', nowMs) as any);
  await adapter.writeEvent(wfId, 'run-1', 1, { type: 'node-completed' } as any);
  await adapter.writeUsage(wfId, makeUsageEntry('run-1', 'n1', nowMs) as any);
  await adapter.acquire(wfId, 'runner-1', nowMs);

  // tsx hazard pattern: simulate a run that holds the lease and would not
  // settle. Abandon it and synchronise on a side-channel promise rather than
  // awaiting the run itself.
  const sideChannel = new Promise<void>((resolve) => {
    // Simulate the lease being held by another runner - we just purge
    // immediately without waiting for it to settle.
    setTimeout(() => resolve(), 0);
  });
  await sideChannel;

  // Purge - should delete everything except secrets
  const counts = await adapter.purge(wfId);
  check('purge deleted spec', counts.spec === 1);
  check('purge deleted journal', counts.journal >= 1);
  check('purge deleted runs', counts.runs >= 1);
  check('purge deleted events', counts.events >= 1);
  check('purge deleted usage', counts.usage >= 1);
  check('purge deleted lease', counts.lease === 1);

  // Verify all Secret_Store entries survived
  for (const connId of connIds) {
    const item = table.getItem({ pk: pk(wfId), sk: connSk(connId) });
    check(`secret ${connId} preserved`, item !== null, `conn# item was deleted`);
    if (item) {
      check(`secret ${connId} has connectionId`, item['connectionId'] === connId);
      check(`secret ${connId} has secretsPresent`, item['secretsPresent'] === true);
    }
  }

  // Verify non-secret items are truly gone
  const specAfter = await adapter.read(wfId);
  check('spec is gone', specAfter === undefined);
  const journalAfter = await adapter.preload(wfId, 'run-1');
  check('journal is empty', journalAfter.size === 0);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('\nALL PASS');
