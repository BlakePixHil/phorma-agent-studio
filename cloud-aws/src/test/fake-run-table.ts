/**
 * FakeRunTable - in-memory DynamoDB simulator for property testing.
 *
 * Reproduces the conditional-write semantics the Host_Adapter depends on:
 * PutItem, UpdateItem, TransactWriteItems, Query, BatchWriteItem, plus
 * per-request failure injection and an inspectable recorded request log.
 *
 * Feature: aws-deployment-target
 * Requirements: 18.3, 2.13
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// The write shapes are declared in the pure layer (`core/table-ops.ts`) so
// `core/lease.ts` does not depend on this fixture. Re-exported here so every
// existing importer of the fake keeps working unchanged.
import type {
  AddAction,
  ConditionNode,
  ExprValue,
  Item,
  ItemKey,
  PutItemRequest,
  SetAction,
  TransactWriteItem,
  TransactWriteRequest,
  UpdateItemRequest,
} from '../core/table-ops.js';

export type {
  AddAction,
  ConditionNode,
  ExprValue,
  Item,
  ItemKey,
  PutItemRequest,
  SetAction,
  TransactWriteItem,
  TransactWriteRequest,
  UpdateItemRequest,
};

/** Recorded entry for the request log. */
export interface RequestLogEntry {
  operation: string;
  key: ItemKey | ItemKey[];
  condition?: string;
}

/** Query request shape. */
export interface QueryRequest {
  pk: string;
  skPrefix?: string;
  /** Maximum items to return per page. */
  pageSize?: number;
  /** Exclusive start key for pagination. */
  startKey?: ItemKey;
  /** Sort direction: true = descending. Default ascending. */
  scanIndexForward?: boolean;
}

/** Query response shape. */
export interface QueryResponse {
  items: Item[];
  lastKey?: ItemKey;
}

/** BatchWriteItem request shape. */
export interface BatchWriteRequest {
  puts?: { key: ItemKey; item: Item }[];
  deletes?: ItemKey[];
}

/** Error thrown when a condition expression fails. */
export class ConditionalCheckFailedError extends Error {
  readonly code = 'ConditionalCheckFailedException';
  /** The current item that caused the condition to fail, if present. */
  readonly currentItem?: Item;

  constructor(message?: string, currentItem?: Item) {
    super(message ?? 'The conditional request failed');
    this.name = 'ConditionalCheckFailedException';
    this.currentItem = currentItem;
  }
}

/** Error thrown when a transaction fails due to a condition check. */
export class TransactionCancelledError extends Error {
  readonly code = 'TransactionCanceledException';
  readonly reasons: Array<{ code: string; item?: Item } | undefined>;

  constructor(reasons: Array<{ code: string; item?: Item } | undefined>) {
    super('Transaction cancelled, reasons: ' + JSON.stringify(reasons));
    this.name = 'TransactionCanceledException';
    this.reasons = reasons;
  }
}

// ---------------------------------------------------------------------------
// Failure injection
// ---------------------------------------------------------------------------

/**
 * A callback invoked before each operation executes. If it throws, the
 * operation is aborted and the error propagates to the caller.
 */
export type FailureInjector = (operation: string, key: ItemKey | ItemKey[]) => void;

// ---------------------------------------------------------------------------
// FakeRunTable
// ---------------------------------------------------------------------------

export class FakeRunTable {
  /** In-memory store: Map<pk, Map<sk, Item>> */
  private readonly store = new Map<string, Map<string, Item>>();

  /** Recorded request log for assertions. */
  readonly log: RequestLogEntry[] = [];

  /** Per-request failure injector. */
  private injector: FailureInjector | undefined;

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /** Set the failure injector. Pass undefined to clear. */
  setFailureInjector(injector: FailureInjector | undefined): void {
    this.injector = injector;
  }

  /** Reset the table and logs to empty state. */
  reset(): void {
    this.store.clear();
    this.log.length = 0;
    this.injector = undefined;
  }

  /** Seed an item directly (bypasses conditions and logging). */
  seed(key: ItemKey, item: Item): void {
    const partition = this.getOrCreatePartition(key.pk);
    partition.set(key.sk, { ...item, pk: key.pk, sk: key.sk });
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  /** PutItem with an optional condition expression. */
  putItem(req: PutItemRequest): void {
    const condStr = req.condition ? conditionToString(req.condition) : undefined;
    this.recordLog('PutItem', req.key, condStr);
    this.injectFailure('PutItem', req.key);

    const existing = this.getItem(req.key);
    if (req.condition && !this.evaluateCondition(req.condition, existing)) {
      throw new ConditionalCheckFailedError(undefined, existing ?? undefined);
    }

    const partition = this.getOrCreatePartition(req.key.pk);
    partition.set(req.key.sk, { ...req.item, pk: req.key.pk, sk: req.key.sk });
  }

  /** UpdateItem with optional condition and SET/ADD expressions. */
  updateItem(req: UpdateItemRequest): void {
    const condStr = req.condition ? conditionToString(req.condition) : undefined;
    this.recordLog('UpdateItem', req.key, condStr);
    this.injectFailure('UpdateItem', req.key);

    const existing = this.getItem(req.key);
    if (req.condition && !this.evaluateCondition(req.condition, existing)) {
      throw new ConditionalCheckFailedError(undefined, existing ?? undefined);
    }

    // Start from existing item or empty
    const item: Item = existing ? { ...existing } : { pk: req.key.pk, sk: req.key.sk };

    // Apply SET actions
    if (req.set) {
      for (const action of req.set) {
        item[action.path] = this.resolveExprValue(action.value, item);
      }
    }

    // Apply ADD actions (numeric increment)
    if (req.add) {
      for (const action of req.add) {
        const addValue = this.resolveExprValue(action.value, item);
        const current = item[action.path];
        if (typeof current === 'number' && typeof addValue === 'number') {
          item[action.path] = current + addValue;
        } else if (current === undefined && typeof addValue === 'number') {
          item[action.path] = addValue;
        } else {
          // For sets, just assign (simplified)
          item[action.path] = addValue;
        }
      }
    }

    const partition = this.getOrCreatePartition(req.key.pk);
    partition.set(req.key.sk, item);
  }

  /** DeleteItem. */
  deleteItem(key: ItemKey, condition?: ConditionNode): void {
    const condStr = condition ? conditionToString(condition) : undefined;
    this.recordLog('DeleteItem', key, condStr);
    this.injectFailure('DeleteItem', key);

    const existing = this.getItem(key);
    if (condition && !this.evaluateCondition(condition, existing)) {
      throw new ConditionalCheckFailedError(undefined, existing ?? undefined);
    }

    const partition = this.store.get(key.pk);
    if (partition) {
      partition.delete(key.sk);
      if (partition.size === 0) this.store.delete(key.pk);
    }
  }

  /** GetItem - read a single item. */
  getItem(key: ItemKey): Item | null {
    const partition = this.store.get(key.pk);
    if (!partition) return null;
    return partition.get(key.sk) ?? null;
  }

  /**
   * TransactWriteItems - all-or-nothing.
   * Evaluates all conditions first; if any fail, none are applied.
   */
  transactWrite(req: TransactWriteRequest): void {
    const keys = req.items.map((i) => this.transactItemKey(i));
    const condStr = req.items
      .map((i) => {
        const cond = this.transactItemCondition(i);
        return cond ? conditionToString(cond) : undefined;
      })
      .filter(Boolean)
      .join(' AND ');
    this.recordLog('TransactWriteItems', keys, condStr || undefined);
    this.injectFailure('TransactWriteItems', keys);

    // Phase 1: evaluate all conditions - collect failures
    const reasons: Array<{ code: string; item?: Item } | undefined> = [];
    let anyFailed = false;

    for (const txItem of req.items) {
      const key = this.transactItemKey(txItem);
      const condition = this.transactItemCondition(txItem);
      const existing = this.getItem(key);

      if (condition && !this.evaluateCondition(condition, existing)) {
        reasons.push({
          code: 'ConditionalCheckFailed',
          item: existing ?? undefined,
        });
        anyFailed = true;
      } else {
        reasons.push(undefined);
      }
    }

    if (anyFailed) {
      throw new TransactionCancelledError(reasons);
    }

    // Phase 2: apply all writes (conditions already passed)
    for (const txItem of req.items) {
      switch (txItem.type) {
        case 'put': {
          const put = txItem.put!;
          const partition = this.getOrCreatePartition(put.key.pk);
          partition.set(put.key.sk, { ...put.item, pk: put.key.pk, sk: put.key.sk });
          break;
        }
        case 'update': {
          const upd = txItem.update!;
          const existing = this.getItem(upd.key);
          const item: Item = existing ? { ...existing } : { pk: upd.key.pk, sk: upd.key.sk };
          if (upd.set) {
            for (const action of upd.set) {
              item[action.path] = this.resolveExprValue(action.value, item);
            }
          }
          if (upd.add) {
            for (const action of upd.add) {
              const addValue = this.resolveExprValue(action.value, item);
              const current = item[action.path];
              if (typeof current === 'number' && typeof addValue === 'number') {
                item[action.path] = current + addValue;
              } else if (current === undefined && typeof addValue === 'number') {
                item[action.path] = addValue;
              } else {
                item[action.path] = addValue;
              }
            }
          }
          const partition = this.getOrCreatePartition(upd.key.pk);
          partition.set(upd.key.sk, item);
          break;
        }
        case 'delete': {
          const del = txItem.delete!;
          const partition = this.store.get(del.key.pk);
          if (partition) {
            partition.delete(del.key.sk);
            if (partition.size === 0) this.store.delete(del.key.pk);
          }
          break;
        }
        case 'conditionCheck':
          // Already validated, no mutation needed
          break;
      }
    }
  }

  /**
   * Query by partition key with optional sort key prefix and pagination.
   */
  query(req: QueryRequest): QueryResponse {
    this.recordLog('Query', { pk: req.pk, sk: req.skPrefix ?? '' }, undefined);
    this.injectFailure('Query', { pk: req.pk, sk: req.skPrefix ?? '' });

    const partition = this.store.get(req.pk);
    if (!partition) return { items: [] };

    // Collect matching items sorted by sk
    let entries = [...partition.entries()];

    // Filter by sk prefix if provided
    if (req.skPrefix) {
      entries = entries.filter(([sk]) => sk.startsWith(req.skPrefix!));
    }

    // Sort by sk
    const forward = req.scanIndexForward !== false;
    entries.sort(([a], [b]) => (forward ? a.localeCompare(b) : b.localeCompare(a)));

    // Apply startKey (exclusive)
    if (req.startKey) {
      const startIdx = entries.findIndex(([sk]) => sk === req.startKey!.sk);
      if (startIdx >= 0) {
        entries = entries.slice(startIdx + 1);
      } else {
        // If start key not found, filter to items after the start key
        entries = entries.filter(([sk]) =>
          forward ? sk > req.startKey!.sk : sk < req.startKey!.sk,
        );
      }
    }

    // Apply page size
    const pageSize = req.pageSize ?? entries.length;
    const page = entries.slice(0, pageSize);
    const items = page.map(([, item]) => ({ ...item }));
    const hasMore = entries.length > pageSize;

    return {
      items,
      lastKey: hasMore ? { pk: req.pk, sk: page[page.length - 1][0] } : undefined,
    };
  }

  /**
   * BatchWriteItem - batch puts and deletes. No conditions.
   */
  batchWrite(req: BatchWriteRequest): void {
    const keys: ItemKey[] = [];
    if (req.puts) keys.push(...req.puts.map((p) => p.key));
    if (req.deletes) keys.push(...req.deletes);
    this.recordLog('BatchWriteItem', keys.length === 1 ? keys[0] : keys, undefined);
    this.injectFailure('BatchWriteItem', keys.length === 1 ? keys[0] : keys);

    if (req.puts) {
      for (const put of req.puts) {
        const partition = this.getOrCreatePartition(put.key.pk);
        partition.set(put.key.sk, { ...put.item, pk: put.key.pk, sk: put.key.sk });
      }
    }

    if (req.deletes) {
      for (const key of req.deletes) {
        const partition = this.store.get(key.pk);
        if (partition) {
          partition.delete(key.sk);
          if (partition.size === 0) this.store.delete(key.pk);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private getOrCreatePartition(pk: string): Map<string, Item> {
    let partition = this.store.get(pk);
    if (!partition) {
      partition = new Map();
      this.store.set(pk, partition);
    }
    return partition;
  }

  private recordLog(operation: string, key: ItemKey | ItemKey[], condition?: string): void {
    this.log.push({ operation, key, condition });
  }

  private injectFailure(operation: string, key: ItemKey | ItemKey[]): void {
    if (this.injector) {
      this.injector(operation, key);
    }
  }

  private evaluateCondition(condition: ConditionNode, item: Item | null): boolean {
    switch (condition.type) {
      case 'attribute_not_exists':
        return item === null || !(condition.path in item) || item[condition.path] === undefined;

      case 'attribute_exists':
        return item !== null && condition.path in item && item[condition.path] !== undefined;

      case 'compare': {
        const left = this.resolveExprValue(condition.left, item ?? {});
        const right = this.resolveExprValue(condition.right, item ?? {});
        return this.compare(condition.op, left, right);
      }

      case 'and':
        return condition.children.every((c) => this.evaluateCondition(c, item));

      case 'or':
        return condition.children.some((c) => this.evaluateCondition(c, item));
    }
  }

  private resolveExprValue(expr: ExprValue, item: Item): unknown {
    switch (expr.type) {
      case 'literal':
        return expr.value;

      case 'path':
        return item[expr.path];

      case 'if_not_exists': {
        const val = item[expr.path];
        if (val === undefined || val === null) {
          return this.resolveExprValue(expr.fallback, item);
        }
        return val;
      }
    }
  }

  private compare(op: string, left: unknown, right: unknown): boolean {
    // Handle null/undefined
    if (left === undefined || left === null || right === undefined || right === null) {
      if (op === '=') return left === right;
      if (op === '<>') return left !== right;
      return false;
    }

    if (typeof left === 'number' && typeof right === 'number') {
      switch (op) {
        case '=': return left === right;
        case '<>': return left !== right;
        case '<=': return left <= right;
        case '<': return left < right;
        case '>=': return left >= right;
        case '>': return left > right;
      }
    }

    if (typeof left === 'string' && typeof right === 'string') {
      switch (op) {
        case '=': return left === right;
        case '<>': return left !== right;
        case '<=': return left <= right;
        case '<': return left < right;
        case '>=': return left >= right;
        case '>': return left > right;
      }
    }

    // Fallback: equality/inequality for other types
    if (op === '=') return left === right;
    if (op === '<>') return left !== right;
    return false;
  }

  private transactItemKey(txItem: TransactWriteItem): ItemKey {
    switch (txItem.type) {
      case 'put': return txItem.put!.key;
      case 'update': return txItem.update!.key;
      case 'delete': return txItem.delete!.key;
      case 'conditionCheck': return txItem.conditionCheck!.key;
    }
  }

  private transactItemCondition(txItem: TransactWriteItem): ConditionNode | undefined {
    switch (txItem.type) {
      case 'put': return txItem.put!.condition;
      case 'update': return txItem.update!.condition;
      case 'delete': return txItem.delete!.condition;
      case 'conditionCheck': return txItem.conditionCheck!.condition;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Serialize a condition node to a human-readable string (for the request log). */
function conditionToString(node: ConditionNode): string {
  switch (node.type) {
    case 'attribute_not_exists':
      return `attribute_not_exists(${node.path})`;
    case 'attribute_exists':
      return `attribute_exists(${node.path})`;
    case 'compare':
      return `${exprValueToString(node.left)} ${node.op} ${exprValueToString(node.right)}`;
    case 'and':
      return node.children.map((c) => `(${conditionToString(c)})`).join(' AND ');
    case 'or':
      return node.children.map((c) => `(${conditionToString(c)})`).join(' OR ');
  }
}

function exprValueToString(expr: ExprValue): string {
  switch (expr.type) {
    case 'literal':
      return JSON.stringify(expr.value);
    case 'path':
      return expr.path;
    case 'if_not_exists':
      return `if_not_exists(${expr.path}, ${exprValueToString(expr.fallback)})`;
  }
}
