/**
 * The single core-shape-to-SDK-command compiler.
 *
 * `src/core/` decides WHAT to write as pure data (`core/table-ops.ts`); this
 * module is the only place that turns such a decision into an
 * `@aws-sdk/lib-dynamodb` command input. Nothing else in `src/aws/` may build a
 * `TransactWriteCommandInput` by hand: every run-scoped write goes
 * `lease.fencedWrite(...)` -> `compileTransact(...)` -> `table.transactWrite(...)`,
 * so the fencing invariant has exactly one compilation path to audit.
 *
 * Every attribute reference is emitted as a `#name` placeholder and every
 * literal as a `:value` placeholder, so reserved words and arbitrary attribute
 * names are safe. The maps are supplied by the caller and mutated in place,
 * which keeps them observable: a test can compile a condition and evaluate the
 * resulting expression against the same maps.
 *
 * A `path` in a core shape names ONE top-level attribute, exactly as the pure
 * evaluator reads it (`item[path]`). It is never split on `.` or `[n]`, so an
 * attribute literally named `a.b` compiles to a single `#name` and the compiled
 * verdict always agrees with direct evaluation of the node.
 *
 * Feature: aws-byo-deploy
 * Requirements: 8.4
 */

import type {
  TransactWriteCommandInput,
  UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';

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

// ---------------------------------------------------------------------------
// Placeholder maps
// ---------------------------------------------------------------------------

/** `ExpressionAttributeNames`: `#nN` -> attribute name. */
export type NameMap = Record<string, string>;

/** `ExpressionAttributeValues`: `:vN` -> native document value. */
export type ValueMap = Record<string, unknown>;

/** The element type of `TransactWriteCommandInput.TransactItems`. */
export type CompiledTransactItem = NonNullable<
  TransactWriteCommandInput['TransactItems']
>[number];

/**
 * Reserve a `#name` placeholder for an attribute name, reusing the existing
 * placeholder when the same name has already been reserved.
 */
function placeName(names: NameMap, path: string): string {
  for (const [placeholder, reserved] of Object.entries(names)) {
    if (reserved === path) return placeholder;
  }
  let index = Object.keys(names).length;
  while (`#n${index}` in names) index++;
  const placeholder = `#n${index}`;
  names[placeholder] = path;
  return placeholder;
}

/**
 * Reserve a fresh `:value` placeholder. Values are never deduplicated: two
 * structurally equal values may be distinct document types, so each occurrence
 * gets its own placeholder.
 */
function placeValue(values: ValueMap, value: unknown): string {
  let index = Object.keys(values).length;
  while (`:v${index}` in values) index++;
  const placeholder = `:v${index}`;
  values[placeholder] = value;
  return placeholder;
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/**
 * Compile an `ExprValue` operand, appending any placeholders it needs.
 */
function compileExprValue(expr: ExprValue, names: NameMap, values: ValueMap): string {
  switch (expr.type) {
    case 'path':
      return placeName(names, expr.path);
    case 'literal':
      return placeValue(values, expr.value);
    case 'if_not_exists':
      return `if_not_exists(${placeName(names, expr.path)}, ${compileExprValue(
        expr.fallback,
        names,
        values,
      )})`;
  }
}

/**
 * Compile a `ConditionNode` into a DynamoDB condition expression, appending
 * placeholders to `names` and `values`.
 *
 * An empty `and` is a tautology and an empty `or` a contradiction, matching how
 * the pure evaluator folds them (`every` over nothing is true, `some` over
 * nothing is false). DynamoDB has no empty-conjunction syntax, so each is
 * emitted as the corresponding attribute existence identity.
 */
export function compileCondition(
  node: ConditionNode,
  names: NameMap,
  values: ValueMap,
): string {
  switch (node.type) {
    case 'attribute_not_exists':
      return `attribute_not_exists(${placeName(names, node.path)})`;

    case 'attribute_exists':
      return `attribute_exists(${placeName(names, node.path)})`;

    case 'compare': {
      const left = compileExprValue(node.left, names, values);
      const right = compileExprValue(node.right, names, values);
      return `${left} ${node.op} ${right}`;
    }

    case 'and':
      return compileJunction(node.children, 'AND', names, values);

    case 'or':
      return compileJunction(node.children, 'OR', names, values);
  }
}

function compileJunction(
  children: ConditionNode[],
  operator: 'AND' | 'OR',
  names: NameMap,
  values: ValueMap,
): string {
  if (children.length === 0) {
    // AND over nothing is always true, OR over nothing always false. Both
    // identities hold for any item, present or absent.
    const probe = placeName(names, 'pk');
    return operator === 'AND'
      ? `(attribute_exists(${probe}) OR attribute_not_exists(${probe}))`
      : `(attribute_exists(${probe}) AND attribute_not_exists(${probe}))`;
  }
  const parts = children.map((child) => `(${compileCondition(child, names, values)})`);
  return parts.length === 1 ? parts[0] : parts.join(` ${operator} `);
}

// ---------------------------------------------------------------------------
// UpdateItem
// ---------------------------------------------------------------------------

function keyOf(key: ItemKey): Record<string, unknown> {
  return { pk: key.pk, sk: key.sk };
}

/** An item always carries its own key attributes, as the table requires. */
function itemWithKey(key: ItemKey, item: Item): Item {
  return { ...item, pk: key.pk, sk: key.sk };
}

/**
 * ADD takes a value operand only. The core layer only ever emits a literal
 * there (the fence increment); anything else is a caller bug, not something to
 * silently mistranslate.
 */
function compileAddValue(action: AddAction, values: ValueMap): string {
  if (action.value.type !== 'literal') {
    throw new Error(
      `ADD on '${action.path}' requires a literal value, received '${action.value.type}'`,
    );
  }
  return placeValue(values, action.value.value);
}

function compileSetClause(action: SetAction, names: NameMap, values: ValueMap): string {
  return `${placeName(names, action.path)} = ${compileExprValue(action.value, names, values)}`;
}

/**
 * Compile an `UpdateItemRequest` into an `UpdateCommandInput`.
 *
 * SET clauses come first, then ADD, then the condition, so the emitted
 * expression reads in the same order the request declares it.
 */
export function compileUpdate(
  tableName: string,
  req: UpdateItemRequest,
): UpdateCommandInput {
  const names: NameMap = {};
  const values: ValueMap = {};

  const clauses: string[] = [];
  const sets = (req.set ?? []).map((action) => compileSetClause(action, names, values));
  if (sets.length > 0) clauses.push(`SET ${sets.join(', ')}`);
  const adds = (req.add ?? []).map(
    (action) => `${placeName(names, action.path)} ${compileAddValue(action, values)}`,
  );
  if (adds.length > 0) clauses.push(`ADD ${adds.join(', ')}`);

  const condition = req.condition
    ? compileCondition(req.condition, names, values)
    : undefined;

  const input: UpdateCommandInput = {
    TableName: tableName,
    Key: keyOf(req.key),
  };
  if (clauses.length > 0) input.UpdateExpression = clauses.join(' ');
  if (condition !== undefined) input.ConditionExpression = condition;
  if (Object.keys(names).length > 0) input.ExpressionAttributeNames = names;
  if (Object.keys(values).length > 0) input.ExpressionAttributeValues = values;
  return input;
}

// ---------------------------------------------------------------------------
// TransactWriteItems
// ---------------------------------------------------------------------------

function compilePutItem(tableName: string, put: PutItemRequest): CompiledTransactItem {
  const names: NameMap = {};
  const values: ValueMap = {};
  const condition = put.condition ? compileCondition(put.condition, names, values) : undefined;
  return {
    Put: {
      TableName: tableName,
      Item: itemWithKey(put.key, put.item),
      ...(condition !== undefined ? { ConditionExpression: condition } : {}),
      ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
      ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
    },
  };
}

function compileUpdateItem(
  tableName: string,
  update: UpdateItemRequest,
): CompiledTransactItem {
  const compiled = compileUpdate(tableName, update);
  return {
    Update: {
      TableName: tableName,
      Key: compiled.Key ?? keyOf(update.key),
      UpdateExpression: compiled.UpdateExpression,
      ...(compiled.ConditionExpression !== undefined
        ? { ConditionExpression: compiled.ConditionExpression }
        : {}),
      ...(compiled.ExpressionAttributeNames !== undefined
        ? { ExpressionAttributeNames: compiled.ExpressionAttributeNames }
        : {}),
      ...(compiled.ExpressionAttributeValues !== undefined
        ? { ExpressionAttributeValues: compiled.ExpressionAttributeValues }
        : {}),
    },
  };
}

function compileDeleteItem(
  tableName: string,
  del: { key: ItemKey; condition?: ConditionNode },
): CompiledTransactItem {
  const names: NameMap = {};
  const values: ValueMap = {};
  const condition = del.condition ? compileCondition(del.condition, names, values) : undefined;
  return {
    Delete: {
      TableName: tableName,
      Key: keyOf(del.key),
      ...(condition !== undefined ? { ConditionExpression: condition } : {}),
      ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
      ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
    },
  };
}

function compileConditionCheckItem(
  tableName: string,
  check: { key: ItemKey; condition: ConditionNode },
): CompiledTransactItem {
  const names: NameMap = {};
  const values: ValueMap = {};
  const condition = compileCondition(check.condition, names, values);
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: keyOf(check.key),
      ConditionExpression: condition,
      ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
      ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
    },
  };
}

function compileTransactItem(
  tableName: string,
  item: TransactWriteItem,
): CompiledTransactItem {
  switch (item.type) {
    case 'put':
      if (!item.put) throw new Error("transact item of type 'put' carries no put request");
      return compilePutItem(tableName, item.put);

    case 'update':
      if (!item.update) {
        throw new Error("transact item of type 'update' carries no update request");
      }
      return compileUpdateItem(tableName, item.update);

    case 'delete':
      if (!item.delete) {
        throw new Error("transact item of type 'delete' carries no delete request");
      }
      return compileDeleteItem(tableName, item.delete);

    case 'conditionCheck':
      if (!item.conditionCheck) {
        throw new Error("transact item of type 'conditionCheck' carries no condition check");
      }
      return compileConditionCheckItem(tableName, item.conditionCheck);
  }
}

/**
 * Compile a `TransactWriteRequest` into a `TransactWriteCommandInput`,
 * preserving item order verbatim.
 *
 * For a fenced write built by `lease.fencedWrite`, that means item 0 is the
 * `ConditionCheck` on `{ pk: 'wf#{workflowId}', sk: 'lease' }` asserting
 * equality with the held fencing token, and item 1 is the data write. The order
 * is the auditable part of the fencing invariant, so it is never reordered,
 * merged, or optimised.
 */
export function compileTransact(
  tableName: string,
  req: TransactWriteRequest,
): TransactWriteCommandInput {
  return {
    TransactItems: req.items.map((item) => compileTransactItem(tableName, item)),
  };
}
