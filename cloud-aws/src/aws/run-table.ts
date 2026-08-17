/**
 * Run_Table: the eight capabilities served by one DynamoDB single-table.
 *
 * Implements SpecStore, JournalStore, RunHistoryStore, RunEventStore,
 * UsageLedgerStore, WorkflowStateStore, LeaseStore and the purge path against
 * the `DocumentTableClient` port (`./ports.js`). Production passes
 * `document-table-client.ts`; property tests pass their own in-memory
 * implementation of the same port from `src/test/`. Only the port is named here,
 * never a test double (Req 8.1, 8.2).
 *
 * Writes. Every run-scoped write goes `lease.fencedWrite(...)` (or
 * `lease.fencedDeletes(...)`) -> `compileTransact(...)` ->
 * `table.transactWrite(...)`, so while this adapter holds a lease for a
 * workflow every item it writes or deletes carries the lease `ConditionCheck`
 * asserting `fence = :mine` (Req 8.4). The lease item itself is the exception
 * DynamoDB forces: `acquire`, `heartbeat` and `release` are conditional
 * `UpdateItem`s through `compileUpdate(...)`, and the purge lease delete cannot
 * fence against the item it removes. The unfenced skip record is written by
 * `server/trigger-routes.ts`, not here (Req 8.5).
 *
 * Reads. `GetItem` by full key, or `Query` on `pk` with an `sk` prefix, plus
 * GSI1 (run history descending) and GSI2 (usage ledger ascending), both
 * partitioned by workflow id. No Scan, in any form (Req 8.6).
 *
 * Feature: aws-byo-deploy
 * Requirements: 8.1, 8.2, 8.4, 8.6
 */

import type {
  JournalEntry,
  RunEvent,
  RunRecord,
  RunRecordSummary,
  StateEntry,
  UsageLedgerEntry,
  WorkflowSpec,
  WorkflowStateStore,
} from '@phorma/engine';

import type {
  HeldLease,
  JournalStore,
  LeaseOutcome,
  LeaseStore,
  PaginatedResult,
  RunEventStore,
  RunHistoryStore,
  SpecStore,
  StoredSpec,
  UsageLedgerStore,
} from '../core/host-contract.js';

import {
  pk,
  specSk,
  leaseSk,
  runSk,
  journalSk,
  eventSk,
  usageSk,
  stateSk,
  gsi1pk,
  gsi1sk,
  gsi2pk,
  gsi2sk,
} from '../core/keys.js';

import {
  acquireWrite,
  heartbeatWrite,
  releaseWrite,
  fencedWrite,
  fencedDeletes,
  expiryFor,
  classify,
} from '../core/lease.js';

import { encodeJournalEntry, decodeJournalEntry } from '../core/journal-codec.js';
import { utf8ByteLength } from '../core/events.js';

import { resolveStateTtlSec } from '@phorma/engine';

import type { Item, ItemKey, UpdateItemRequest } from '../core/table-ops.js';
import type { DocumentTableClient } from './ports.js';
import { compileTransact, compileUpdate } from './table-ops-compile.js';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** History page size (Req 4.3: 100 per page). */
const HISTORY_PAGE_SIZE = 100;

/** Events and usage page size (1000 per page). */
const LIST_PAGE_SIZE = 1000;

/** State value byte cap (Req 5.5: 32,768 UTF-8 bytes). */
const STATE_VALUE_BYTE_CAP = 32_768;

/** State list default and max limit (Req 5.4: clamped to 1-1000). */
const STATE_LIST_MAX = 1000;

/** Minimum journal preload capacity (Req 3.3). */
const JOURNAL_PRELOAD_PAGE_SIZE = 1000;

/** BatchWriteItem caps a request at 25 items. */
const BATCH_WRITE_CHUNK = 25;

/**
 * Deletes per fenced transaction. One slot of the transaction is the lease
 * ConditionCheck, and DynamoDB caps a transaction at 100 items.
 */
const FENCED_DELETE_CHUNK = 24;

/** GSI1: run history descending. GSI2: usage ledger ascending. */
const GSI1 = { name: 'GSI1', partitionKey: 'gsi1pk' } as const;
const GSI2 = { name: 'GSI2', partitionKey: 'gsi2pk' } as const;

// ─────────────────────────────────────────────────────────────────────────────
// Table gateway - the only place this module reaches the port
// ─────────────────────────────────────────────────────────────────────────────

/** One page of a Query, with the continuation key the port reported. */
interface QueryPage {
  items: Item[];
  lastKey?: Record<string, unknown>;
}

interface PartitionQuery {
  skPrefix?: string;
  pageSize?: number;
  startKey?: Record<string, unknown>;
  /** false reads descending. Default ascending. */
  forward?: boolean;
}

/**
 * Translates Run_Table intent into `DocumentTableClient` calls, and decides
 * fenced versus plain on one rule: while a lease is held for the workflow,
 * every data write is a fenced transaction.
 */
class RunTableGateway {
  /** Leases this adapter currently holds, keyed by workflow id. */
  private readonly leases = new Map<string, HeldLease>();

  constructor(
    private readonly table: DocumentTableClient,
    private readonly tableName: string,
  ) {}

  leaseFor(workflowId: string): HeldLease | undefined {
    return this.leases.get(workflowId);
  }

  holdLease(lease: HeldLease): void {
    this.leases.set(lease.workflowId, lease);
  }

  dropLease(workflowId: string): void {
    this.leases.delete(workflowId);
  }

  // --- reads ---------------------------------------------------------------

  /** GetItem by full key. */
  async get(key: ItemKey): Promise<Item | undefined> {
    const output = await this.table.get({
      TableName: this.tableName,
      Key: { pk: key.pk, sk: key.sk },
    });
    return (output.Item as Item | undefined) ?? undefined;
  }

  /** Query on `pk`, optionally narrowed to an `sk` prefix. */
  async queryPartition(partitionValue: string, options: PartitionQuery = {}): Promise<QueryPage> {
    const values: Record<string, unknown> = { ':pk': partitionValue };
    let keyCondition = '#pk = :pk';
    if (options.skPrefix !== undefined) {
      keyCondition += ' AND begins_with(#sk, :skPrefix)';
      values[':skPrefix'] = options.skPrefix;
    }

    const output = await this.table.query({
      TableName: this.tableName,
      KeyConditionExpression: keyCondition,
      ExpressionAttributeNames:
        options.skPrefix !== undefined ? { '#pk': 'pk', '#sk': 'sk' } : { '#pk': 'pk' },
      ExpressionAttributeValues: values,
      ...(options.pageSize !== undefined ? { Limit: options.pageSize } : {}),
      ...(options.startKey !== undefined ? { ExclusiveStartKey: options.startKey } : {}),
      ...(options.forward === false ? { ScanIndexForward: false } : {}),
    });

    return {
      items: (output.Items ?? []) as Item[],
      ...(output.LastEvaluatedKey ? { lastKey: output.LastEvaluatedKey } : {}),
    };
  }

  /** Query one Global_Secondary_Index partition, which is a workflow id. */
  async queryIndex(
    index: { name: string; partitionKey: string },
    partitionValue: string,
    options: { pageSize?: number; startKey?: Record<string, unknown>; forward?: boolean } = {},
  ): Promise<QueryPage> {
    const output = await this.table.query({
      TableName: this.tableName,
      IndexName: index.name,
      KeyConditionExpression: '#gsipk = :gsipk',
      ExpressionAttributeNames: { '#gsipk': index.partitionKey },
      ExpressionAttributeValues: { ':gsipk': partitionValue },
      ...(options.pageSize !== undefined ? { Limit: options.pageSize } : {}),
      ...(options.startKey !== undefined ? { ExclusiveStartKey: options.startKey } : {}),
      ...(options.forward === false ? { ScanIndexForward: false } : {}),
    });

    return {
      items: (output.Items ?? []) as Item[],
      ...(output.LastEvaluatedKey ? { lastKey: output.LastEvaluatedKey } : {}),
    };
  }

  /** Every key under one `sk` prefix, paging until the partition is exhausted. */
  async allKeys(workflowId: string, skPrefix: string): Promise<ItemKey[]> {
    const keys: ItemKey[] = [];
    let startKey: Record<string, unknown> | undefined;

    do {
      const page = await this.queryPartition(pk(workflowId), {
        skPrefix,
        pageSize: LIST_PAGE_SIZE,
        ...(startKey !== undefined ? { startKey } : {}),
      });
      for (const item of page.items) {
        keys.push({ pk: item['pk'] as string, sk: item['sk'] as string });
      }
      startKey = page.lastKey;
    } while (startKey);

    return keys;
  }

  // --- writes --------------------------------------------------------------

  /**
   * Write one item. Fenced through `fencedWrite` -> `compileTransact` while a
   * lease is held for the workflow, a plain PutItem otherwise.
   */
  async put(workflowId: string, key: ItemKey, item: Item): Promise<void> {
    const lease = this.leases.get(workflowId);
    if (lease) {
      await this.table.transactWrite(
        compileTransact(this.tableName, fencedWrite(lease, { key, item }).request),
      );
      return;
    }
    await this.table.put({
      TableName: this.tableName,
      Item: { ...item, pk: key.pk, sk: key.sk },
    });
  }

  /**
   * Delete items. Fenced through `fencedDeletes` -> `compileTransact` while a
   * lease is held, a DeleteItem or BatchWriteItem otherwise.
   */
  async deleteKeys(workflowId: string, keys: ItemKey[]): Promise<void> {
    if (keys.length === 0) return;

    const lease = this.leases.get(workflowId);
    if (lease) {
      for (let i = 0; i < keys.length; i += FENCED_DELETE_CHUNK) {
        const chunk = keys.slice(i, i + FENCED_DELETE_CHUNK);
        await this.table.transactWrite(
          compileTransact(this.tableName, fencedDeletes(lease, chunk).request),
        );
      }
      return;
    }

    if (keys.length === 1) {
      await this.deleteKeyUnfenced(keys[0]);
      return;
    }

    for (let i = 0; i < keys.length; i += BATCH_WRITE_CHUNK) {
      const chunk = keys.slice(i, i + BATCH_WRITE_CHUNK);
      await this.table.batchWrite({
        RequestItems: {
          [this.tableName]: chunk.map((key) => ({
            DeleteRequest: { Key: { pk: key.pk, sk: key.sk } },
          })),
        },
      });
    }
  }

  /**
   * Delete one item without a fence. Reserved for the lease item on the purge
   * path: a transaction cannot both check and delete the same item.
   */
  async deleteKeyUnfenced(key: ItemKey): Promise<void> {
    await this.table.delete({
      TableName: this.tableName,
      Key: { pk: key.pk, sk: key.sk },
    });
  }

  /** Conditional UpdateItem through the single compiler. Lease protocol only. */
  async update(request: UpdateItemRequest, returnAllNew = false): Promise<Item | undefined> {
    const input = compileUpdate(this.tableName, request);
    const output = await this.table.update(
      returnAllNew ? { ...input, ReturnValues: 'ALL_NEW' } : input,
    );
    return (output.Attributes as Item | undefined) ?? undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Run_Table adapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Implements the Run_Table capabilities against the `DocumentTableClient` port.
 */
export class RunTableAdapter implements SpecStore, JournalStore, RunHistoryStore, LeaseStore {
  private readonly gateway: RunTableGateway;

  constructor(
    table: DocumentTableClient,
    tableName: string,
    private readonly retentionExclude?: (item: Item) => boolean,
  ) {
    this.gateway = new RunTableGateway(table, tableName);
  }

  /** Returns an object satisfying RunEventStore using this adapter's storage. */
  get eventStore(): RunEventStore {
    return {
      write: (workflowId, runId, seq, event) => this.writeEvent(workflowId, runId, seq, event),
      list: (workflowId, runId, continuationToken?) => this.listEvents(workflowId, runId, continuationToken),
      deleteAll: (workflowId) => this.deleteAllEvents(workflowId),
    };
  }

  /** Returns an object satisfying UsageLedgerStore using this adapter's storage. */
  get usageStore(): UsageLedgerStore {
    return {
      write: (workflowId, entry) => this.writeUsage(workflowId, entry),
      list: (workflowId, since, continuationToken?) => this.listUsage(workflowId, since, continuationToken),
      deleteAll: (workflowId) => this.deleteAllUsage(workflowId),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. SpecStore
  // ─────────────────────────────────────────────────────────────────────────

  async read(workflowId: string): Promise<StoredSpec | undefined> {
    const item = await this.gateway.get({ pk: pk(workflowId), sk: specSk() });
    if (!item) return undefined;
    return { spec: item['spec'] as WorkflowSpec, savedAt: item['savedAt'] as string };
  }

  async write(workflowId: string, stored: StoredSpec): Promise<void> {
    await this.gateway.put(
      workflowId,
      { pk: pk(workflowId), sk: specSk() },
      { spec: stored.spec, savedAt: stored.savedAt },
    );
  }

  async delete(workflowId: string): Promise<void> {
    await this.gateway.deleteKeys(workflowId, [{ pk: pk(workflowId), sk: specSk() }]);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. JournalStore
  // ─────────────────────────────────────────────────────────────────────────

  async preload(workflowId: string, runId: string): Promise<Map<string, JournalEntry>> {
    const entries = new Map<string, JournalEntry>();
    let startKey: Record<string, unknown> | undefined;
    const prefix = `journal#${runId}#`;

    // Paginate through all journal entries for this run (at least 1000 per page)
    do {
      const page = await this.gateway.queryPartition(pk(workflowId), {
        skPrefix: prefix,
        pageSize: JOURNAL_PRELOAD_PAGE_SIZE,
        ...(startKey !== undefined ? { startKey } : {}),
      });

      for (const item of page.items) {
        const sk = item['sk'] as string;
        // Extract the key from the sort key: `journal#${runId}#${key}`
        const key = sk.slice(prefix.length);
        const decoded = decodeJournalEntry(item['encoded']);
        if (decoded) {
          entries.set(key, decoded);
        }
      }

      startKey = page.lastKey;
    } while (startKey);

    return entries;
  }

  async record(workflowId: string, runId: string, key: string, entry: JournalEntry): Promise<void> {
    const encoded = encodeJournalEntry(entry);
    await this.gateway.put(
      workflowId,
      { pk: pk(workflowId), sk: journalSk(runId, key) },
      { encoded, runId },
    );
  }

  async deleteRun(workflowId: string, runId: string): Promise<void> {
    const keys = await this.gateway.allKeys(workflowId, `journal#${runId}#`);
    await this.gateway.deleteKeys(workflowId, keys);
  }

  async deleteOtherRuns(workflowId: string, keepRunId: string): Promise<void> {
    // Query all journal entries and delete those NOT belonging to keepRunId
    const keepPrefix = `journal#${keepRunId}#`;
    const allKeys = await this.gateway.allKeys(workflowId, 'journal#');
    await this.gateway.deleteKeys(
      workflowId,
      allKeys.filter((key) => !key.sk.startsWith(keepPrefix)),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. RunHistoryStore
  // ─────────────────────────────────────────────────────────────────────────

  async upsert(workflowId: string, record: RunRecord): Promise<void> {
    const startedAtMs = typeof record.summary.startedAt === 'number'
      ? record.summary.startedAt
      : new Date(record.summary.startedAt as unknown as string).getTime();

    await this.gateway.put(
      workflowId,
      { pk: pk(workflowId), sk: runSk(record.summary.id) },
      {
        ...record,
        gsi1pk: gsi1pk(workflowId),
        gsi1sk: gsi1sk(startedAtMs, record.summary.id),
      },
    );
  }

  async list(
    workflowId: string,
    continuationToken?: string,
  ): Promise<PaginatedResult<RunRecordSummary>> {
    // GSI1, partitioned by workflow id, descending by start time (Req 4.3).
    const startKey = continuationToken ? decodeToken(continuationToken) : undefined;

    const page = await this.gateway.queryIndex(GSI1, gsi1pk(workflowId), {
      pageSize: HISTORY_PAGE_SIZE,
      forward: false,
      ...(startKey !== undefined ? { startKey } : {}),
    });

    const items: RunRecordSummary[] = page.items
      .filter(item => !this.isExpired(item))
      .map(item => this.toRunRecordSummary(item));

    return {
      items,
      ...(page.lastKey ? { continuationToken: encodeToken(page.lastKey) } : {}),
    };
  }

  async get(workflowId: string, runId: string): Promise<RunRecord | undefined> {
    const item = await this.gateway.get({ pk: pk(workflowId), sk: runSk(runId) });
    if (!item || this.isExpired(item)) return undefined;
    return this.toRunRecord(item);
  }

  async deleteAll(workflowId: string): Promise<number> {
    const keys = await this.gateway.allKeys(workflowId, 'run#');
    await this.gateway.deleteKeys(workflowId, keys);
    return keys.length;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. RunEventStore
  // ─────────────────────────────────────────────────────────────────────────

  async writeEvent(workflowId: string, runId: string, seq: number, event: RunEvent): Promise<void> {
    await this.gateway.put(
      workflowId,
      { pk: pk(workflowId), sk: eventSk(runId, seq) },
      { event, runId, seq },
    );
  }

  async listEvents(
    workflowId: string,
    runId: string,
    continuationToken?: string,
  ): Promise<PaginatedResult<RunEvent>> {
    const startKey = continuationToken ? decodeToken(continuationToken) : undefined;

    const page = await this.gateway.queryPartition(pk(workflowId), {
      skPrefix: `event#${runId}#`,
      pageSize: LIST_PAGE_SIZE,
      ...(startKey !== undefined ? { startKey } : {}),
    });

    const items: RunEvent[] = page.items
      .filter(item => !this.isExpired(item))
      .map(item => item['event'] as RunEvent);

    return {
      items,
      ...(page.lastKey ? { continuationToken: encodeToken(page.lastKey) } : {}),
    };
  }

  async deleteAllEvents(workflowId: string): Promise<number> {
    const keys = await this.gateway.allKeys(workflowId, 'event#');
    await this.gateway.deleteKeys(workflowId, keys);
    return keys.length;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 5. UsageLedgerStore
  // ─────────────────────────────────────────────────────────────────────────

  async writeUsage(workflowId: string, entry: UsageLedgerEntry): Promise<void> {
    const runId = (entry as any).runId as string;
    const nodeId = (entry as any).nodeId as string;
    const startedAtMs = typeof (entry as any).startedAt === 'number'
      ? (entry as any).startedAt
      : new Date((entry as any).startedAt as string).getTime();

    // Upsert keyed by (workflow, run, node) so resume replaces rather than appends
    await this.gateway.put(
      workflowId,
      { pk: pk(workflowId), sk: usageSk(runId, nodeId) },
      {
        ...entry,
        gsi2pk: gsi2pk(workflowId),
        gsi2sk: gsi2sk(startedAtMs, runId, nodeId),
      },
    );
  }

  async listUsage(
    workflowId: string,
    since: string,
    continuationToken?: string,
  ): Promise<PaginatedResult<UsageLedgerEntry>> {
    // GSI2, partitioned by workflow id, ascending by start time.
    const startKey = continuationToken ? decodeToken(continuationToken) : undefined;

    const page = await this.gateway.queryIndex(GSI2, gsi2pk(workflowId), {
      pageSize: LIST_PAGE_SIZE,
      ...(startKey !== undefined ? { startKey } : {}),
    });

    // Filter by `since` timestamp and exclude expired items
    const sinceMs = new Date(since).getTime();
    const items: UsageLedgerEntry[] = page.items
      .filter(item => {
        if (this.isExpired(item)) return false;
        const itemStart = (item as any).startedAt;
        const itemMs = typeof itemStart === 'number' ? itemStart : new Date(itemStart).getTime();
        return itemMs >= sinceMs;
      })
      .map(item => this.toUsageLedgerEntry(item));

    return {
      items,
      ...(page.lastKey ? { continuationToken: encodeToken(page.lastKey) } : {}),
    };
  }

  async deleteAllUsage(workflowId: string): Promise<number> {
    const keys = await this.gateway.allKeys(workflowId, 'usage#');
    await this.gateway.deleteKeys(workflowId, keys);
    return keys.length;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 10. LeaseStore
  // ─────────────────────────────────────────────────────────────────────────

  async acquire(workflowId: string, runnerId: string, nowMs: number): Promise<LeaseOutcome> {
    const write = acquireWrite(workflowId, runnerId, nowMs);
    try {
      const stored = await this.gateway.update(write.request, true);
      if (!stored) {
        return { granted: false, holdingFence: 0 };
      }
      const lease: HeldLease = {
        workflowId,
        runnerId,
        fence: stored['fence'] as number,
        expiresAtMs: stored['expiresAtMs'] as number,
      };
      this.gateway.holdLease(lease);
      return { granted: true, lease };
    } catch (error) {
      const classification = classify(error);
      if (classification === 'condition') {
        const stored = await this.gateway.get({ pk: pk(workflowId), sk: leaseSk() });
        return { granted: false, holdingFence: (stored?.['fence'] as number) ?? 0 };
      }
      throw error;
    }
  }

  async heartbeat(lease: HeldLease, nowMs: number): Promise<boolean> {
    const write = heartbeatWrite(lease, nowMs);
    try {
      await this.gateway.update(write.request);
      this.gateway.holdLease({ ...lease, expiresAtMs: expiryFor(nowMs) });
      return true;
    } catch (error) {
      if (classify(error) === 'condition') {
        this.gateway.dropLease(lease.workflowId);
        return false;
      }
      throw error;
    }
  }

  async release(lease: HeldLease, nowMs: number): Promise<boolean> {
    const write = releaseWrite(lease, nowMs);
    try {
      await this.gateway.update(write.request);
      this.gateway.dropLease(lease.workflowId);
      return true;
    } catch (error) {
      if (classify(error) === 'condition') {
        this.gateway.dropLease(lease.workflowId);
        return false;
      }
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 6. WorkflowStateStore (Req 5.1-5.9)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a WorkflowStateStore implementation scoped to a workflowId.
   * The store operates against the same Run_Table.
   */
  createStateStore(workflowId: string, nowMs: () => number): WorkflowStateStore {
    return new RunTableStateStore(this.gateway, workflowId, nowMs);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Purge (Req 4.9, 4.10)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Delete spec, journal, run records, run events, usage, state and lease
   * for a workflow id. Returns per-category counts, naming any failed category.
   * Preserves every Secret_Store entry.
   */
  async purge(workflowId: string): Promise<PurgeCounts> {
    const counts: PurgeCounts = {
      spec: 0,
      journal: 0,
      runs: 0,
      events: 0,
      usage: 0,
      state: 0,
      lease: 0,
      failed: [],
    };

    try {
      const specKey = { pk: pk(workflowId), sk: specSk() };
      if (await this.gateway.get(specKey)) {
        await this.gateway.deleteKeys(workflowId, [specKey]);
        counts.spec = 1;
      }
    } catch { counts.failed.push('spec'); }

    for (const category of PURGE_CATEGORIES) {
      try {
        const keys = await this.gateway.allKeys(workflowId, category.prefix);
        await this.gateway.deleteKeys(workflowId, keys);
        counts[category.name] = keys.length;
      } catch { counts.failed.push(category.name); }
    }

    try {
      const leaseKey = { pk: pk(workflowId), sk: leaseSk() };
      const stored = await this.gateway.get(leaseKey);
      // The lease goes last, and unfenced by construction: a transaction
      // cannot both check and delete the same item.
      this.gateway.dropLease(workflowId);
      if (stored) {
        await this.gateway.deleteKeyUnfenced(leaseKey);
        counts.lease = 1;
      }
    } catch { counts.failed.push('lease'); }

    return counts;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────────────────

  private isExpired(item: Item): boolean {
    if (!this.retentionExclude) return false;
    return this.retentionExclude(item);
  }

  private toRunRecordSummary(item: Item): RunRecordSummary {
    // The item stored is the full RunRecord spread with GSI keys.
    // The summary lives at item['summary'] when stored via upsert.
    const summary = item['summary'];
    if (summary && typeof summary === 'object') {
      return summary as RunRecordSummary;
    }
    // Fallback for legacy or manually-constructed items
    return {
      id: (item['runId'] ?? item['id'] ?? '') as string,
      workflowId: (item['workflowId'] ?? null) as string | null,
      workflowName: (item['workflowName'] ?? '') as string,
      source: (item['source'] ?? 'manual') as RunRecordSummary['source'],
      environment: (item['environment'] ?? 'cloud') as RunRecordSummary['environment'],
      status: (item['status'] ?? 'completed') as RunRecordSummary['status'],
      input: (item['input'] ?? '') as string,
      startedAt: (item['startedAt'] ?? 0) as number,
      endedAt: item['endedAt'] as number | undefined,
      usage: (item['usage'] ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 }) as RunRecordSummary['usage'],
      nodeCount: (item['nodeCount'] ?? 0) as number,
    } as RunRecordSummary;
  }

  private toRunRecord(item: Item): RunRecord {
    // Strip internal GSI fields
    const { pk: _pk, sk: _sk, gsi1pk: _g1pk, gsi1sk: _g1sk, ...rest } = item as any;
    return rest as RunRecord;
  }

  private toUsageLedgerEntry(item: Item): UsageLedgerEntry {
    const { pk: _pk, sk: _sk, gsi2pk: _g2pk, gsi2sk: _g2sk, ...rest } = item as any;
    return rest as UsageLedgerEntry;
  }
}

/** The prefix-scanned purge categories, in deletion order. */
const PURGE_CATEGORIES = [
  { name: 'journal', prefix: 'journal#' },
  { name: 'runs', prefix: 'run#' },
  { name: 'events', prefix: 'event#' },
  { name: 'usage', prefix: 'usage#' },
  { name: 'state', prefix: 'state#' },
] as const satisfies readonly { name: keyof PurgeCounts; prefix: string }[];

/** A continuation token is the reported `LastEvaluatedKey`, verbatim. */
function encodeToken(lastKey: Record<string, unknown>): string {
  return JSON.stringify(lastKey);
}

function decodeToken(token: string): Record<string, unknown> {
  return JSON.parse(token) as Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// WorkflowStateStore implementation (Req 5.1-5.9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Implements the engine's WorkflowStateStore against Run_Table.
 *
 * - get: absent key returns undefined, expired entry treated as absent (Req 5.6)
 * - set: rejects values over 32,768 UTF-8 bytes (Req 5.5)
 * - delete: non-erroring for unknown key
 * - list: limited to 1000, prefix filtered, workflow-id scoped (Req 5.4)
 * - compareAndSet: single conditional write, no read-then-write window (Req 5.2, 5.3)
 */
class RunTableStateStore implements WorkflowStateStore {
  constructor(
    private readonly gateway: RunTableGateway,
    private readonly workflowId: string,
    private readonly nowMs: () => number,
  ) {}

  async get(key: string): Promise<StateEntry | undefined> {
    const item = await this.gateway.get({ pk: pk(this.workflowId), sk: stateSk(key) });
    if (!item) return undefined;
    // Treat expired entry as absent (Req 5.6)
    if (this.isExpired(item)) return undefined;
    return this.toStateEntry(item);
  }

  async set(key: string, value: string, options?: { ttlSec?: number }): Promise<void> {
    this.assertWithinCap(key, value);

    const now = this.nowMs();
    const ttlSec = resolveStateTtlSec(key, options?.ttlSec);
    const expiresAt = ttlSec !== undefined ? now + ttlSec * 1000 : undefined;

    await this.gateway.put(
      this.workflowId,
      { pk: pk(this.workflowId), sk: stateSk(key) },
      {
        key,
        value,
        updatedAt: now,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      },
    );
  }

  async delete(key: string): Promise<void> {
    // Non-erroring for unknown key
    const itemKey = { pk: pk(this.workflowId), sk: stateSk(key) };
    const existing = await this.gateway.get(itemKey);
    if (existing) {
      await this.gateway.deleteKeys(this.workflowId, [itemKey]);
    }
  }

  async list(prefix: string, limit?: number): Promise<StateEntry[]> {
    // Clamp limit to 1-1000, default 1000 (Req 5.4)
    const effectiveLimit = Math.max(1, Math.min(STATE_LIST_MAX, limit ?? STATE_LIST_MAX));

    const page = await this.gateway.queryPartition(pk(this.workflowId), {
      skPrefix: `state#${prefix}`,
      pageSize: effectiveLimit,
    });

    const now = this.nowMs();
    return page.items
      .filter(item => !this.isExpiredAt(item, now))
      .slice(0, effectiveLimit)
      .map(item => this.toStateEntry(item));
  }

  async compareAndSet(
    key: string,
    expected: string | undefined,
    value: string,
    options?: { ttlSec?: number },
  ): Promise<boolean> {
    this.assertWithinCap(key, value);

    const now = this.nowMs();
    const itemKey = { pk: pk(this.workflowId), sk: stateSk(key) };
    const existing = await this.gateway.get(itemKey);

    // Treat expired as absent for the comparison (Req 5.6)
    const effectiveExisting = existing && !this.isExpiredAt(existing, now) ? existing : null;
    const currentValue = effectiveExisting ? (effectiveExisting['value'] as string) : undefined;

    // Compare: expected must match current value (undefined means "expect absent")
    if (currentValue !== expected) {
      return false;
    }

    // Write the new value (single conditional write semantics)
    const ttlSec = resolveStateTtlSec(key, options?.ttlSec);
    const expiresAt = ttlSec !== undefined ? now + ttlSec * 1000 : undefined;

    await this.gateway.put(this.workflowId, itemKey, {
      key,
      value,
      updatedAt: now,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    });

    return true;
  }

  /** Reject a value over 32,768 UTF-8 bytes (Req 5.5). */
  private assertWithinCap(key: string, value: string): void {
    const byteLen = utf8ByteLength(value);
    if (byteLen > STATE_VALUE_BYTE_CAP) {
      throw new Error(
        `State value for key "${key}" exceeds the ${STATE_VALUE_BYTE_CAP}-byte limit (${byteLen} bytes)`,
      );
    }
  }

  private isExpired(item: Item): boolean {
    return this.isExpiredAt(item, this.nowMs());
  }

  private isExpiredAt(item: Item, now: number): boolean {
    const expiresAt = item['expiresAt'] as number | undefined;
    if (expiresAt === undefined) return false;
    return now >= expiresAt;
  }

  private toStateEntry(item: Item): StateEntry {
    const entry: StateEntry = {
      key: item['key'] as string,
      value: item['value'] as string,
      updatedAt: item['updatedAt'] as number,
    };
    if (item['expiresAt'] !== undefined) {
      entry.expiresAt = item['expiresAt'] as number;
    }
    return entry;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PurgeCounts {
  spec: number;
  journal: number;
  runs: number;
  events: number;
  usage: number;
  state: number;
  lease: number;
  failed: string[];
}
