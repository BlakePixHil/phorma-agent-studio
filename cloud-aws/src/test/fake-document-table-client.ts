/**
 * FakeDocumentTableClient - the `DocumentTableClient` port over `FakeRunTable`.
 *
 * Production code names only the port (`aws/ports.ts`), so the test fixture has
 * to speak the same language: real `@aws-sdk/lib-dynamodb` command inputs. This
 * adapter decodes such an input back into the pure `core/table-ops.ts` shapes
 * `FakeRunTable` already executes - resolving `#name` and `:value` placeholders,
 * parsing `ConditionExpression`, `UpdateExpression` and `KeyConditionExpression`
 * - then replays it against the fake.
 *
 * Everything the existing property tests rely on survives:
 *
 * - `FakeRunTable`'s DynamoDB conditional-write semantics, `TransactWriteItems`
 *   all-or-nothing behaviour, `Query` paging and failure injection are untouched:
 *   this class only translates, it never decides.
 * - The recorded request log (`table.log`) keeps receiving one entry per
 *   operation under the same operation names, so the partition-scope and no-Scan
 *   assertions keep working. `GetItem` is recorded here because
 *   `FakeRunTable.getItem` is a plain read that records nothing.
 * - `requests` additionally keeps the verbatim command input per operation, so a
 *   test can assert on the shape of a write (for example that item 0 of a
 *   `TransactWriteItems` is the lease `ConditionCheck`) rather than on a
 *   stringified condition.
 *
 * There is deliberately no `.query` path that reads a whole table: every read
 * addresses one partition key, and no Scan operation exists in any form.
 *
 * Feature: aws-byo-deploy
 * Requirements: 8.2, 8.6
 */

import type {
  BatchWriteCommandInput,
  BatchWriteCommandOutput,
  DeleteCommandInput,
  DeleteCommandOutput,
  GetCommandInput,
  GetCommandOutput,
  PutCommandInput,
  PutCommandOutput,
  QueryCommandInput,
  QueryCommandOutput,
  TransactWriteCommandInput,
  TransactWriteCommandOutput,
  UpdateCommandInput,
  UpdateCommandOutput,
} from '@aws-sdk/lib-dynamodb';

import type { DocumentTableClient } from '../aws/ports.js';

import type {
  AddAction,
  ConditionNode,
  ExprValue,
  Item,
  ItemKey,
  SetAction,
  TransactWriteItem,
} from '../core/table-ops.js';

import { FakeRunTable, type RequestLogEntry } from './fake-run-table.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A command input recorded verbatim, alongside the operation that carried it. */
export interface RecordedRequest {
  operation:
    | 'GetItem'
    | 'PutItem'
    | 'UpdateItem'
    | 'DeleteItem'
    | 'Query'
    | 'BatchWriteItem'
    | 'TransactWriteItems';
  input: unknown;
}

/**
 * One Global_Secondary_Index as the fixture models it.
 *
 * `FakeRunTable` stores a single base table, so an index query is served by
 * reading the base partition the index entries live in and then projecting:
 * filter on `partitionKey`, order on `sortKey`. `basePartition` maps an index
 * partition key value back to that base partition - for the Run_Table key
 * scheme, `wf#{id}#runs` and `wf#{id}#usage` both live in `wf#{id}`.
 */
export interface FakeIndexDefinition {
  name: string;
  partitionKey: string;
  sortKey: string;
  basePartition(indexPartitionValue: string): string;
}

export interface FakeDocumentTableClientOptions {
  /** When set, every command input must name this table, or the call throws. */
  tableName?: string;
  /** Index definitions. Defaults to Run_Table's GSI1 and GSI2. */
  indexes?: FakeIndexDefinition[];
}

/** Strip the `#runs` / `#usage` suffix a Run_Table GSI partition key carries. */
function baseOfSuffixed(suffix: string): (indexPartitionValue: string) => string {
  return (value) => (value.endsWith(suffix) ? value.slice(0, -suffix.length) : value);
}

/** GSI1 (run history, descending) and GSI2 (usage ledger, ascending). */
export const RUN_TABLE_FAKE_INDEXES: FakeIndexDefinition[] = [
  {
    name: 'GSI1',
    partitionKey: 'gsi1pk',
    sortKey: 'gsi1sk',
    basePartition: baseOfSuffixed('#runs'),
  },
  {
    name: 'GSI2',
    partitionKey: 'gsi2pk',
    sortKey: 'gsi2sk',
    basePartition: baseOfSuffixed('#usage'),
  },
];

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class FakeDocumentTableClient implements DocumentTableClient {
  private readonly tableName: string | undefined;
  private readonly indexes: FakeIndexDefinition[];

  /** Every command input, in call order. */
  readonly requests: RecordedRequest[] = [];

  constructor(
    readonly table: FakeRunTable = new FakeRunTable(),
    options?: FakeDocumentTableClientOptions,
  ) {
    this.tableName = options?.tableName;
    this.indexes = options?.indexes ?? RUN_TABLE_FAKE_INDEXES;
  }

  /** The fake's recorded request log, unchanged in shape. */
  get log(): RequestLogEntry[] {
    return this.table.log;
  }

  /** Clear the stored items, the fake's log and the recorded command inputs. */
  reset(): void {
    this.table.reset();
    this.requests.length = 0;
  }

  // -------------------------------------------------------------------------
  // GetItem
  // -------------------------------------------------------------------------

  async get(input: GetCommandInput): Promise<GetCommandOutput> {
    this.assertTableName(input.TableName, 'GetItem');
    const key = itemKeyOf(asRecord(input.Key, 'GetItem Key'), 'GetItem Key');
    this.record('GetItem', input);
    // FakeRunTable.getItem records nothing, so the read is logged here to keep
    // the partition-scope assertion able to see it.
    this.table.log.push({ operation: 'GetItem', key });

    const item = this.table.getItem(key);
    return item ? { $metadata: {}, Item: outputItem(item) } : { $metadata: {} };
  }

  // -------------------------------------------------------------------------
  // PutItem
  // -------------------------------------------------------------------------

  async put(input: PutCommandInput): Promise<PutCommandOutput> {
    this.assertTableName(input.TableName, 'PutItem');
    const item = asRecord(input.Item, 'PutItem Item');
    const key = itemKeyOf(item, 'PutItem Item');
    const condition = this.decodeCondition(input);
    this.record('PutItem', input);

    const before = input.ReturnValues === 'ALL_OLD' ? this.table.getItem(key) : null;
    this.table.putItem({ key, item, condition });
    return before ? { $metadata: {}, Attributes: outputItem(before) } : { $metadata: {} };
  }

  // -------------------------------------------------------------------------
  // UpdateItem
  // -------------------------------------------------------------------------

  async update(input: UpdateCommandInput): Promise<UpdateCommandOutput> {
    this.assertTableName(input.TableName, 'UpdateItem');
    const key = itemKeyOf(asRecord(input.Key, 'UpdateItem Key'), 'UpdateItem Key');
    const condition = this.decodeCondition(input);
    const clauses = input.UpdateExpression
      ? new ExpressionReader(
          input.UpdateExpression,
          input.ExpressionAttributeNames,
          input.ExpressionAttributeValues,
        ).readUpdate()
      : { set: [] as SetAction[], add: [] as AddAction[] };
    this.record('UpdateItem', input);

    const before = this.table.getItem(key);
    this.table.updateItem({
      key,
      condition,
      ...(clauses.set.length > 0 ? { set: clauses.set } : {}),
      ...(clauses.add.length > 0 ? { add: clauses.add } : {}),
    });
    const after = this.table.getItem(key);

    const touched = [...clauses.set, ...clauses.add].map((action) => action.path);
    return { $metadata: {}, ...returnedAttributes(input.ReturnValues, before, after, touched) };
  }

  // -------------------------------------------------------------------------
  // DeleteItem
  // -------------------------------------------------------------------------

  async delete(input: DeleteCommandInput): Promise<DeleteCommandOutput> {
    this.assertTableName(input.TableName, 'DeleteItem');
    const key = itemKeyOf(asRecord(input.Key, 'DeleteItem Key'), 'DeleteItem Key');
    const condition = this.decodeCondition(input);
    this.record('DeleteItem', input);

    const before = input.ReturnValues === 'ALL_OLD' ? this.table.getItem(key) : null;
    this.table.deleteItem(key, condition);
    return before ? { $metadata: {}, Attributes: outputItem(before) } : { $metadata: {} };
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  async query(input: QueryCommandInput): Promise<QueryCommandOutput> {
    this.assertTableName(input.TableName, 'Query');
    if (input.FilterExpression !== undefined) {
      throw unsupported('Query', 'FilterExpression is not modelled by FakeRunTable');
    }
    if (input.KeyConditionExpression === undefined) {
      throw unsupported('Query', 'a KeyConditionExpression is required');
    }
    const terms = new ExpressionReader(
      input.KeyConditionExpression,
      input.ExpressionAttributeNames,
      input.ExpressionAttributeValues,
    ).readKeyTerms();
    this.record('Query', input);

    return input.IndexName === undefined
      ? this.queryBase(input, terms)
      : this.queryIndex(input, terms, input.IndexName);
  }

  // -------------------------------------------------------------------------
  // BatchWriteItem
  // -------------------------------------------------------------------------

  async batchWrite(input: BatchWriteCommandInput): Promise<BatchWriteCommandOutput> {
    const tables = Object.keys(input.RequestItems ?? {});
    if (tables.length !== 1) {
      throw unsupported(
        'BatchWriteItem',
        `RequestItems must name exactly one table, found ${tables.length}`,
      );
    }
    this.assertTableName(tables[0], 'BatchWriteItem');
    const puts: { key: ItemKey; item: Item }[] = [];
    const deletes: ItemKey[] = [];

    for (const request of input.RequestItems?.[tables[0]] ?? []) {
      if (request.PutRequest) {
        const item = asRecord(request.PutRequest.Item, 'BatchWriteItem PutRequest Item');
        puts.push({ key: itemKeyOf(item, 'BatchWriteItem PutRequest Item'), item });
      } else if (request.DeleteRequest) {
        const key = asRecord(request.DeleteRequest.Key, 'BatchWriteItem DeleteRequest Key');
        deletes.push(itemKeyOf(key, 'BatchWriteItem DeleteRequest Key'));
      } else {
        throw unsupported('BatchWriteItem', 'each request must carry a PutRequest or DeleteRequest');
      }
    }
    this.record('BatchWriteItem', input);

    this.table.batchWrite({
      ...(puts.length > 0 ? { puts } : {}),
      ...(deletes.length > 0 ? { deletes } : {}),
    });
    return { $metadata: {}, UnprocessedItems: {} };
  }

  // -------------------------------------------------------------------------
  // TransactWriteItems
  // -------------------------------------------------------------------------

  async transactWrite(input: TransactWriteCommandInput): Promise<TransactWriteCommandOutput> {
    const items = (input.TransactItems ?? []).map((element) => this.decodeTransactItem(element));
    this.record('TransactWriteItems', input);
    this.table.transactWrite({ items });
    return { $metadata: {} };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private record(operation: RecordedRequest['operation'], input: unknown): void {
    this.requests.push({ operation, input });
  }

  private assertTableName(name: string | undefined, operation: string): void {
    if (this.tableName === undefined) return;
    if (name !== this.tableName) {
      throw unsupported(operation, `expected table '${this.tableName}', found '${String(name)}'`);
    }
  }

  private decodeCondition(input: {
    ConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
  }): ConditionNode | undefined {
    if (input.ConditionExpression === undefined) return undefined;
    return new ExpressionReader(
      input.ConditionExpression,
      input.ExpressionAttributeNames,
      input.ExpressionAttributeValues,
    ).readCondition();
  }

  private decodeTransactItem(
    element: NonNullable<TransactWriteCommandInput['TransactItems']>[number],
  ): TransactWriteItem {
    if (element.ConditionCheck) {
      const check = element.ConditionCheck;
      this.assertTableName(check.TableName, 'TransactWriteItems ConditionCheck');
      if (check.ConditionExpression === undefined) {
        throw unsupported('TransactWriteItems', 'a ConditionCheck requires a ConditionExpression');
      }
      return {
        type: 'conditionCheck',
        conditionCheck: {
          key: itemKeyOf(asRecord(check.Key, 'ConditionCheck Key'), 'ConditionCheck Key'),
          condition: this.decodeCondition(check)!,
        },
      };
    }

    if (element.Put) {
      const put = element.Put;
      this.assertTableName(put.TableName, 'TransactWriteItems Put');
      const item = asRecord(put.Item, 'Put Item');
      const condition = this.decodeCondition(put);
      return {
        type: 'put',
        put: { key: itemKeyOf(item, 'Put Item'), item, ...(condition ? { condition } : {}) },
      };
    }

    if (element.Delete) {
      const del = element.Delete;
      this.assertTableName(del.TableName, 'TransactWriteItems Delete');
      const condition = this.decodeCondition(del);
      return {
        type: 'delete',
        delete: {
          key: itemKeyOf(asRecord(del.Key, 'Delete Key'), 'Delete Key'),
          ...(condition ? { condition } : {}),
        },
      };
    }

    if (element.Update) {
      const update = element.Update;
      this.assertTableName(update.TableName, 'TransactWriteItems Update');
      const condition = this.decodeCondition(update);
      const clauses = update.UpdateExpression
        ? new ExpressionReader(
            update.UpdateExpression,
            update.ExpressionAttributeNames,
            update.ExpressionAttributeValues,
          ).readUpdate()
        : { set: [] as SetAction[], add: [] as AddAction[] };
      return {
        type: 'update',
        update: {
          key: itemKeyOf(asRecord(update.Key, 'Update Key'), 'Update Key'),
          ...(condition ? { condition } : {}),
          ...(clauses.set.length > 0 ? { set: clauses.set } : {}),
          ...(clauses.add.length > 0 ? { add: clauses.add } : {}),
        },
      };
    }

    throw unsupported(
      'TransactWriteItems',
      'each item must carry exactly one of ConditionCheck, Put, Delete or Update',
    );
  }

  private queryBase(input: QueryCommandInput, terms: KeyTerm[]): QueryCommandOutput {
    const { partition, sort } = splitKeyTerms(terms, 'pk');
    const prefix = sort === undefined ? undefined : String(sort.value);
    const exact = sort?.op === '=';

    const response = this.table.query({
      pk: partition,
      ...(prefix !== undefined ? { skPrefix: prefix } : {}),
      ...(input.Limit !== undefined ? { pageSize: input.Limit } : {}),
      ...(input.ExclusiveStartKey !== undefined
        ? {
            startKey: itemKeyOf(
              asRecord(input.ExclusiveStartKey, 'Query ExclusiveStartKey'),
              'Query ExclusiveStartKey',
            ),
          }
        : {}),
      ...(input.ScanIndexForward !== undefined ? { scanIndexForward: input.ScanIndexForward } : {}),
    });

    const items = exact
      ? response.items.filter((item) => item['sk'] === prefix)
      : response.items;

    return {
      $metadata: {},
      Items: items.map(outputItem),
      Count: items.length,
      ScannedCount: items.length,
      ...(response.lastKey !== undefined
        ? { LastEvaluatedKey: outputItem({ ...response.lastKey }) }
        : {}),
    };
  }

  private queryIndex(
    input: QueryCommandInput,
    terms: KeyTerm[],
    indexName: string,
  ): QueryCommandOutput {
    const index = this.indexes.find((candidate) => candidate.name === indexName);
    if (!index) throw unsupported('Query', `unknown index '${indexName}'`);

    const { partition, sort } = splitKeyTerms(terms, index.partitionKey);
    // One partition read through the fake, so the Query is recorded with a
    // partition key exactly as the base-table path is.
    const stored = this.table.query({ pk: index.basePartition(partition) });

    let rows = stored.items.filter(
      (item) =>
        item[index.partitionKey] === partition && typeof item[index.sortKey] === 'string',
    );

    if (sort !== undefined) {
      const value = String(sort.value);
      rows = rows.filter((item) => {
        const sortValue = item[index.sortKey] as string;
        return sort.op === 'begins_with' ? sortValue.startsWith(value) : compare(sort.op, sortValue, value);
      });
    }

    const forward = input.ScanIndexForward !== false;
    rows.sort((a, b) => {
      const left = a[index.sortKey] as string;
      const right = b[index.sortKey] as string;
      return forward ? left.localeCompare(right) : right.localeCompare(left);
    });

    if (input.ExclusiveStartKey !== undefined) {
      const startKey = asRecord(input.ExclusiveStartKey, 'Query ExclusiveStartKey');
      const after = startKey[index.sortKey];
      if (typeof after !== 'string') {
        throw unsupported(
          'Query',
          `ExclusiveStartKey on index '${indexName}' must carry '${index.sortKey}'`,
        );
      }
      const position = rows.findIndex((item) => item[index.sortKey] === after);
      rows =
        position >= 0
          ? rows.slice(position + 1)
          : rows.filter((item) => {
              const sortValue = item[index.sortKey] as string;
              return forward ? sortValue > after : sortValue < after;
            });
    }

    const pageSize = input.Limit ?? rows.length;
    const page = rows.slice(0, pageSize);
    const hasMore = rows.length > pageSize;
    const last = page[page.length - 1];

    return {
      $metadata: {},
      Items: page.map(outputItem),
      Count: page.length,
      ScannedCount: page.length,
      ...(hasMore && last !== undefined
        ? {
            LastEvaluatedKey: outputItem({
              pk: last['pk'],
              sk: last['sk'],
              [index.partitionKey]: last[index.partitionKey],
              [index.sortKey]: last[index.sortKey],
            }),
          }
        : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Command input helpers
// ---------------------------------------------------------------------------

function unsupported(operation: string, detail: string): Error {
  return new Error(`FakeDocumentTableClient: ${operation} - ${detail}`);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    throw new Error(`FakeDocumentTableClient: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function itemKeyOf(record: Record<string, unknown>, label: string): ItemKey {
  const pk = record['pk'];
  const sk = record['sk'];
  if (typeof pk !== 'string' || typeof sk !== 'string') {
    throw new Error(`FakeDocumentTableClient: ${label} must carry string 'pk' and 'sk' attributes`);
  }
  return { pk, sk };
}

/** Widen a stored item to the document-client output shape. */
function outputItem(item: Item): NonNullable<GetCommandOutput['Item']> {
  return { ...item } as NonNullable<GetCommandOutput['Item']>;
}

/** Project the attributes an `UpdateItem` `ReturnValues` asks for. */
function returnedAttributes(
  returnValues: string | undefined,
  before: Item | null,
  after: Item | null,
  touched: string[],
): { Attributes?: NonNullable<GetCommandOutput['Item']> } {
  switch (returnValues) {
    case 'ALL_NEW':
      return after ? { Attributes: outputItem(after) } : {};
    case 'ALL_OLD':
      return before ? { Attributes: outputItem(before) } : {};
    case 'UPDATED_NEW':
      return after ? { Attributes: outputItem(project(after, touched)) } : {};
    case 'UPDATED_OLD':
      return before ? { Attributes: outputItem(project(before, touched)) } : {};
    default:
      return {};
  }
}

function project(item: Item, paths: string[]): Item {
  const projected: Item = {};
  for (const path of paths) {
    if (item[path] !== undefined) projected[path] = item[path];
  }
  return projected;
}

function compare(op: KeyTerm['op'], left: string, right: string): boolean {
  switch (op) {
    case '=':
      return left === right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    case '<>':
      return left !== right;
    case 'begins_with':
      return left.startsWith(right);
  }
}

// ---------------------------------------------------------------------------
// Expression decoding
// ---------------------------------------------------------------------------

/** One term of a `KeyConditionExpression`. */
export interface KeyTerm {
  attr: string;
  op: '=' | '<' | '<=' | '>' | '>=' | '<>' | 'begins_with';
  value: unknown;
}

const COMPARE_OPS = new Set(['=', '<', '<=', '>', '>=', '<>']);

function splitKeyTerms(
  terms: KeyTerm[],
  partitionAttr: string,
): { partition: string; sort?: KeyTerm } {
  const partitionTerm = terms.find((term) => term.attr === partitionAttr && term.op === '=');
  if (!partitionTerm) {
    throw unsupported('Query', `the key condition must fix '${partitionAttr}' with '='`);
  }
  if (typeof partitionTerm.value !== 'string') {
    throw unsupported('Query', `the '${partitionAttr}' value must be a string`);
  }
  const rest = terms.filter((term) => term !== partitionTerm);
  if (rest.length > 1) {
    throw unsupported('Query', 'at most one sort key condition is supported');
  }
  return { partition: partitionTerm.value, ...(rest[0] ? { sort: rest[0] } : {}) };
}

/**
 * Recursive-descent reader over the expression dialect `aws/table-ops-compile.ts`
 * emits, plus the `begins_with` key condition the Run_Table reads use.
 *
 * Anything outside that dialect throws by name rather than being silently
 * mistranslated: a fixture that guesses would let a real bug pass.
 */
class ExpressionReader {
  private index = 0;
  private readonly tokens: string[];

  constructor(
    private readonly source: string,
    private readonly names: Record<string, string> | undefined,
    private readonly values: Record<string, unknown> | undefined,
  ) {
    this.tokens = tokenize(source);
  }

  // --- condition expression ------------------------------------------------

  readCondition(): ConditionNode {
    const node = this.readOr();
    if (!this.atEnd()) throw this.fail(`unexpected trailing token '${String(this.peek())}'`);
    return node;
  }

  private readOr(): ConditionNode {
    const children = [this.readAnd()];
    while (this.peekUpper() === 'OR') {
      this.next();
      children.push(this.readAnd());
    }
    return children.length === 1 ? children[0] : { type: 'or', children };
  }

  private readAnd(): ConditionNode {
    const children = [this.readFactor()];
    while (this.peekUpper() === 'AND') {
      this.next();
      children.push(this.readFactor());
    }
    return children.length === 1 ? children[0] : { type: 'and', children };
  }

  private readFactor(): ConditionNode {
    if (this.peek() === '(') {
      this.expect('(');
      const inner = this.readOr();
      this.expect(')');
      return inner;
    }

    const token = this.next();
    const keyword = token.toLowerCase();

    if (keyword === 'attribute_exists' || keyword === 'attribute_not_exists') {
      this.expect('(');
      const path = this.resolveName(this.next());
      this.expect(')');
      return keyword === 'attribute_exists'
        ? { type: 'attribute_exists', path }
        : { type: 'attribute_not_exists', path };
    }
    if (keyword === 'not' || keyword === 'begins_with' || keyword === 'contains') {
      throw this.fail(`'${token}' is not part of the compiled condition dialect`);
    }

    const left = this.readOperand(token);
    const op = this.next();
    if (!COMPARE_OPS.has(op)) throw this.fail(`unsupported comparison operator '${op}'`);
    const right = this.readOperand(this.next());
    return { type: 'compare', op: op as '=' | '<=' | '<' | '>' | '>=' | '<>', left, right };
  }

  private readOperand(token: string): ExprValue {
    if (token.toLowerCase() === 'if_not_exists') {
      this.expect('(');
      const path = this.resolveName(this.next());
      this.expect(',');
      const fallback = this.readOperand(this.next());
      this.expect(')');
      return { type: 'if_not_exists', path, fallback };
    }
    if (token.startsWith(':')) return { type: 'literal', value: this.resolveValue(token) };
    return { type: 'path', path: this.resolveName(token) };
  }

  // --- update expression ---------------------------------------------------

  readUpdate(): { set: SetAction[]; add: AddAction[] } {
    const set: SetAction[] = [];
    const add: AddAction[] = [];

    while (!this.atEnd()) {
      const clause = this.next().toUpperCase();
      if (clause !== 'SET' && clause !== 'ADD') {
        throw this.fail(`unsupported update clause '${clause}'`);
      }
      for (;;) {
        const path = this.resolveName(this.next());
        if (clause === 'SET') {
          this.expect('=');
          set.push({ path, value: this.readOperand(this.next()) });
        } else {
          add.push({ path, value: this.readOperand(this.next()) });
        }
        if (this.peek() !== ',') break;
        this.next();
      }
    }

    return { set, add };
  }

  // --- key condition expression -------------------------------------------

  readKeyTerms(): KeyTerm[] {
    const terms: KeyTerm[] = [];
    for (;;) {
      const token = this.next();
      if (token.toLowerCase() === 'begins_with') {
        this.expect('(');
        const attr = this.resolveName(this.next());
        this.expect(',');
        const value = this.resolveValue(this.next());
        this.expect(')');
        terms.push({ attr, op: 'begins_with', value });
      } else {
        const attr = this.resolveName(token);
        const op = this.next();
        if (!COMPARE_OPS.has(op)) throw this.fail(`unsupported key operator '${op}'`);
        terms.push({ attr, op: op as KeyTerm['op'], value: this.resolveValue(this.next()) });
      }
      if (this.atEnd()) return terms;
      const joiner = this.next().toUpperCase();
      if (joiner !== 'AND') throw this.fail(`key conditions join with AND only, found '${joiner}'`);
    }
  }

  // --- cursor --------------------------------------------------------------

  private peek(): string | undefined {
    return this.tokens[this.index];
  }

  private peekUpper(): string | undefined {
    return this.tokens[this.index]?.toUpperCase();
  }

  private next(): string {
    const token = this.tokens[this.index++];
    if (token === undefined) throw this.fail('unexpected end of expression');
    return token;
  }

  private expect(token: string): void {
    const found = this.next();
    if (found !== token) throw this.fail(`expected '${token}', found '${found}'`);
  }

  private atEnd(): boolean {
    return this.index >= this.tokens.length;
  }

  private resolveName(token: string): string {
    if (token.startsWith(':')) {
      throw this.fail(`expected an attribute name, found value placeholder '${token}'`);
    }
    if (!token.startsWith('#')) return token;
    const name = this.names?.[token];
    if (name === undefined) throw this.fail(`no ExpressionAttributeNames entry for '${token}'`);
    return name;
  }

  private resolveValue(token: string): unknown {
    if (!token.startsWith(':')) {
      throw this.fail(`expected a value placeholder, found '${token}'`);
    }
    if (!this.values || !(token in this.values)) {
      throw this.fail(`no ExpressionAttributeValues entry for '${token}'`);
    }
    return this.values[token];
  }

  private fail(message: string): Error {
    return new Error(`FakeDocumentTableClient: ${message} (in "${this.source}")`);
  }
}

/**
 * Split an expression into tokens: parentheses, commas, comparison operators
 * and identifiers (`#name` placeholders, `:value` placeholders, keywords and
 * bare attribute names).
 */
function tokenize(expression: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < expression.length) {
    const char = expression[index];

    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === '(' || char === ')' || char === ',') {
      tokens.push(char);
      index++;
      continue;
    }
    if (char === '=') {
      tokens.push('=');
      index++;
      continue;
    }
    if (char === '<' || char === '>') {
      const nextChar = expression[index + 1];
      if (nextChar === '=' || (char === '<' && nextChar === '>')) {
        tokens.push(char + nextChar);
        index += 2;
      } else {
        tokens.push(char);
        index++;
      }
      continue;
    }

    const identifier = /^[#:]?[A-Za-z0-9_.]+/.exec(expression.slice(index));
    if (!identifier) {
      throw new Error(
        `FakeDocumentTableClient: unexpected character '${char}' in expression "${expression}"`,
      );
    }
    tokens.push(identifier[0]);
    index += identifier[0].length;
  }

  return tokens;
}
