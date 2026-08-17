/**
 * Execution_Lease decision layer - the correctness core.
 *
 * This module is PURE: it takes the current stored item and clock values and
 * returns the write operations to attempt. No I/O, no AWS SDK import.
 *
 * Feature: aws-deployment-target
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.9, 2.10, 2.11, 2.12
 */

import type { HeldLease } from './host-contract.js';
import type {
  ConditionNode,
  ExprValue,
  Item,
  ItemKey,
  TransactWriteItem,
  TransactWriteRequest,
  UpdateItemRequest,
} from './table-ops.js';
import { pk, leaseSk } from './keys.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Heartbeat interval in milliseconds (Req 2.3, 2.9: between 5s and 20s). */
export const HEARTBEAT_MS = 10_000;

/**
 * Lease TTL in milliseconds. Expiry is always now + LEASE_TTL_MS.
 * At least 3x HEARTBEAT_MS (30s) and at most 300s (Req 2.9).
 * 60s gives room for two missed heartbeats before takeover.
 */
export const LEASE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Lease item shape (what the stored DynamoDB item looks like)
// ---------------------------------------------------------------------------

/** The stored lease item as read from Run_Table. */
export interface LeaseItem {
  pk: string;
  sk: string;
  fence: number;
  expiresAtMs: number;
  runnerId: string;
  workflowId: string;
}

// ---------------------------------------------------------------------------
// Write shapes (over the pure core/table-ops.ts request types)
// ---------------------------------------------------------------------------

/** A conditional UpdateItem write. */
export interface ConditionalWrite {
  type: 'update';
  request: UpdateItemRequest;
}

/** A TransactWriteItems write containing a condition check on the lease plus a data write. */
export interface TransactWrite {
  type: 'transact';
  request: TransactWriteRequest;
}

/** Any item destined for Run_Table. */
export interface RunTableItem {
  key: ItemKey;
  item: Item;
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Next fence token value. 1 for a fresh lease, stored + 1 for a takeover.
 * (Req 2.2: strictly greater than every previously stored token.)
 */
export function nextFence(stored: LeaseItem | undefined): number {
  if (!stored) return 1;
  return stored.fence + 1;
}

/**
 * Expiry timestamp for a lease write at the given clock time.
 * (Req 2.9: at least 3x heartbeat, at most 300s.)
 */
export function expiryFor(nowMs: number): number {
  return nowMs + LEASE_TTL_MS;
}

/**
 * Build the acquire conditional write for a workflow.
 *
 * Condition: `attribute_not_exists(pk) OR expiresAtMs <= :now`
 * Sets: fence = if_not_exists(fence, 0) + 1, expiresAtMs, runnerId, workflowId
 *
 * This is ONE conditional write that both checks availability and establishes
 * the fencing token atomically (Req 2.1, 2.2, 2.13).
 */
export function acquireWrite(workflowId: string, runnerId: string, nowMs: number): ConditionalWrite {
  const key: ItemKey = { pk: pk(workflowId), sk: leaseSk() };

  // Condition: no item exists OR the existing item has expired
  const condition: ConditionNode = {
    type: 'or',
    children: [
      { type: 'attribute_not_exists', path: 'pk' },
      {
        type: 'compare',
        op: '<=',
        left: { type: 'path', path: 'expiresAtMs' } as ExprValue,
        right: { type: 'literal', value: nowMs } as ExprValue,
      },
    ],
  };

  const request: UpdateItemRequest = {
    key,
    condition,
    set: [
      { path: 'expiresAtMs', value: { type: 'literal', value: expiryFor(nowMs) } },
      { path: 'runnerId', value: { type: 'literal', value: runnerId } },
      { path: 'workflowId', value: { type: 'literal', value: workflowId } },
    ],
    add: [
      // ADD fence 1: on a missing attribute starts at 0 + 1 = 1.
      // On existing fence = N gives N + 1. Exactly if_not_exists(fence, 0) + 1.
      { path: 'fence', value: { type: 'literal', value: 1 } },
    ],
  };

  return { type: 'update', request };
}

/**
 * Build the heartbeat conditional write.
 *
 * Condition: fence = :mine (Req 2.3)
 * Sets: expiresAtMs = now + LEASE_TTL_MS
 */
export function heartbeatWrite(lease: HeldLease, nowMs: number): ConditionalWrite {
  const key: ItemKey = { pk: pk(lease.workflowId), sk: leaseSk() };

  const condition: ConditionNode = {
    type: 'compare',
    op: '=',
    left: { type: 'path', path: 'fence' },
    right: { type: 'literal', value: lease.fence },
  };

  const request: UpdateItemRequest = {
    key,
    condition,
    set: [{ path: 'expiresAtMs', value: { type: 'literal', value: expiryFor(nowMs) } }],
  };

  return { type: 'update', request };
}

/**
 * Build the release conditional write.
 *
 * Condition: fence = :mine (Req 2.4)
 * Sets: expiresAtMs = :now, retains fence
 *
 * Release sets expiry to now so the lease is immediately acquirable by the
 * next Runner, while retaining the fence so the highest token ever issued
 * for this workflow is never lost.
 */
export function releaseWrite(lease: HeldLease, nowMs: number): ConditionalWrite {
  const key: ItemKey = { pk: pk(lease.workflowId), sk: leaseSk() };

  const condition: ConditionNode = {
    type: 'compare',
    op: '=',
    left: { type: 'path', path: 'fence' },
    right: { type: 'literal', value: lease.fence },
  };

  const request: UpdateItemRequest = {
    key,
    condition,
    set: [{ path: 'expiresAtMs', value: { type: 'literal', value: nowMs } }],
  };

  return { type: 'update', request };
}

/**
 * Build a fenced TransactWriteItems for a run-scoped data write.
 *
 * Every run-scoped write is a TransactWriteItems with a ConditionCheck on
 * the lease item (fence = :mine), plus the actual data write (Req 2.5).
 * The only exemption is the unfenced skip record.
 */
export function fencedWrite(lease: HeldLease, item: RunTableItem): TransactWrite {
  const dataWriteItem: TransactWriteItem = {
    type: 'put',
    put: {
      key: item.key,
      item: item.item,
    },
  };

  return {
    type: 'transact',
    request: {
      items: [leaseConditionCheck(lease), dataWriteItem],
    },
  };
}

/**
 * Build a fenced TransactWriteItems for one or more run-scoped deletes.
 *
 * Same shape as `fencedWrite`: item 0 is the lease ConditionCheck asserting
 * `fence = :mine`, the remaining items are the deletes. A run-scoped delete is
 * a Run_Table write like any other, so it carries the same fence (Req 2.5).
 *
 * Callers chunk the keys - DynamoDB caps a transaction at 100 items and
 * rejects two operations on the same item, so the lease item is never among
 * the keys.
 */
export function fencedDeletes(lease: HeldLease, keys: ItemKey[]): TransactWrite {
  const deleteItems: TransactWriteItem[] = keys.map((key) => ({
    type: 'delete',
    delete: { key },
  }));

  return {
    type: 'transact',
    request: {
      items: [leaseConditionCheck(lease), ...deleteItems],
    },
  };
}

/**
 * The `ConditionCheck` on the lease item asserting the caller still holds the
 * fencing token. Item 0 of every fenced transaction.
 */
function leaseConditionCheck(lease: HeldLease): TransactWriteItem {
  return {
    type: 'conditionCheck',
    conditionCheck: {
      key: { pk: pk(lease.workflowId), sk: leaseSk() },
      condition: {
        type: 'compare',
        op: '=',
        left: { type: 'path', path: 'fence' },
        right: { type: 'literal', value: lease.fence },
      },
    },
  };
}

/**
 * Classify a DynamoDB error into one of three categories.
 *
 * - 'condition': the conditional check failed, meaning another Runner holds
 *   the lease or has taken it over (answers 409, never retried - Req 2.7, 2.16)
 * - 'transient': a throttle, network or service error that may succeed on retry
 * - 'fatal': an unrecoverable error (bad request, validation, access denied)
 *
 * Keeping these distinguishable prevents the adapter from telling an operator
 * "already running" when the truth is "DynamoDB throttled us".
 */
export function classify(error: unknown): 'condition' | 'transient' | 'fatal' {
  if (error === null || error === undefined) return 'fatal';

  if (typeof error === 'object') {
    const e = error as Record<string, unknown>;

    // Check for condition failure error codes
    const code = e['code'] ?? e['Code'] ?? e['name'] ?? e['__type'] ?? '';
    const codeStr = typeof code === 'string' ? code : '';

    if (
      codeStr === 'ConditionalCheckFailedException' ||
      codeStr === 'ConditionalCheckFailed' ||
      codeStr === 'TransactionCanceledException' ||
      codeStr === 'TransactionCancelledException'
    ) {
      return 'condition';
    }

    // Transient errors: throttling, service unavailable, network
    if (
      codeStr === 'ProvisionedThroughputExceededException' ||
      codeStr === 'ThrottlingException' ||
      codeStr === 'RequestLimitExceeded' ||
      codeStr === 'InternalServerError' ||
      codeStr === 'ServiceUnavailable' ||
      codeStr === 'ItemCollectionSizeLimitExceededException'
    ) {
      return 'transient';
    }

    // Check HTTP status codes for transient signals
    const statusCode = e['$metadata'] as Record<string, unknown> | undefined;
    const httpStatus = statusCode?.['httpStatusCode'] ?? e['statusCode'] ?? e['status'];
    if (typeof httpStatus === 'number') {
      if (httpStatus === 429 || httpStatus >= 500) return 'transient';
    }

    // Network errors
    if (e instanceof Error) {
      const msg = e.message?.toLowerCase() ?? '';
      if (
        msg.includes('timeout') ||
        msg.includes('econnreset') ||
        msg.includes('econnrefused') ||
        msg.includes('socket hang up') ||
        msg.includes('network')
      ) {
        return 'transient';
      }
    }
  }

  // Everything else is fatal (bad request, validation, access denied, etc.)
  return 'fatal';
}

/**
 * Determine whether a Runner is a zombie.
 *
 * A Runner is a zombie when the stored lease item's fence is higher than the
 * Runner's fence - meaning another Runner has acquired the lease (Req 2.6, 2.15).
 *
 * Also returns true when the stored item is absent (lease was deleted/purged),
 * since the Runner cannot prove it still holds the lease.
 */
export function isZombie(lease: HeldLease, stored: LeaseItem | undefined): boolean {
  if (!stored) return true;
  return stored.fence !== lease.fence;
}
