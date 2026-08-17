/**
 * Run_Table write shapes - the pure declaration site.
 *
 * These types describe a DynamoDB write as a value: a key, an optional
 * condition expression AST, and the SET/ADD clauses. They are pure data with
 * no AWS SDK import, so `core/` can decide what to write and `aws/` can compile
 * that decision into an SDK command input (see `aws/table-ops-compile.ts`).
 *
 * They previously lived in `src/test/fake-run-table.ts`, which inverted the
 * layering: the pure decision layer depended on a test fixture. `FakeRunTable`
 * now re-exports them from here.
 *
 * Feature: aws-byo-deploy
 * Requirements: 8.4, 8.10
 */

/** A single DynamoDB item, keyed by pk + sk. */
export type Item = Record<string, unknown>;

/** Composite key identifying one item in the table. */
export interface ItemKey {
  pk: string;
  sk: string;
}

/**
 * Condition expression AST node.
 * Supports: attribute_not_exists, attribute_exists, comparisons (=, <=, <, >, >=, <>).
 */
export type ConditionNode =
  | { type: 'attribute_not_exists'; path: string }
  | { type: 'attribute_exists'; path: string }
  | { type: 'compare'; op: '=' | '<=' | '<' | '>' | '>=' | '<>'; left: ExprValue; right: ExprValue }
  | { type: 'and'; children: ConditionNode[] }
  | { type: 'or'; children: ConditionNode[] };

export type ExprValue =
  | { type: 'path'; path: string }
  | { type: 'literal'; value: unknown }
  | { type: 'if_not_exists'; path: string; fallback: ExprValue };

/** SET clause action. */
export interface SetAction {
  path: string;
  value: ExprValue;
}

/** ADD clause action (numeric increment or set addition). */
export interface AddAction {
  path: string;
  value: ExprValue;
}

/** UpdateItem request shape. */
export interface UpdateItemRequest {
  key: ItemKey;
  condition?: ConditionNode;
  set?: SetAction[];
  add?: AddAction[];
}

/** PutItem request shape. */
export interface PutItemRequest {
  key: ItemKey;
  item: Item;
  condition?: ConditionNode;
}

/** TransactWriteItems request shape. */
export interface TransactWriteItem {
  type: 'put' | 'update' | 'delete' | 'conditionCheck';
  put?: PutItemRequest;
  update?: UpdateItemRequest;
  delete?: { key: ItemKey; condition?: ConditionNode };
  conditionCheck?: { key: ItemKey; condition: ConditionNode };
}

export interface TransactWriteRequest {
  items: TransactWriteItem[];
}
