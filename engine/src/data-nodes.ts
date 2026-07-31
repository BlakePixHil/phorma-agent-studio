/**
 * Pure data-node executors (design §5).
 *
 * Everything in this module is a plain function of `(node, payload, ctx)`: no
 * `this`, no host capability, no I/O and no clock beyond `EvalContext.nowMs`
 * (Requirement 1.5). That is what makes `transform` and `aggregate` reproducible
 * across the desktop, the browser preview and the worker — and trivially
 * property-testable.
 *
 * Two rules hold for every function here:
 *
 * 1. **Nothing reachable from the incoming payload is ever written to.** The
 *    projection builds fresh objects and copies on write when it descends into a
 *    structure it does not own (Requirement 5.13).
 * 2. **Identical input produces a byte-identical output string.** Key order comes
 *    from field declaration order, never from a sort, and no ambient clock or
 *    random source is read (Requirement 5.14).
 */

import {
  ExpressionError,
  compileExpression,
  truthy,
  type CompiledExpression,
  type EvalContext,
  type Json,
} from './expr.js';
import { resolveJsonPath } from './payload.js';
import { canonicalJson } from './state.js';
import type {
  AggregateMetric,
  AggregateNodeData,
  GroupSpec,
  JoinSpec,
  PivotSpec,
  TransformField,
  TransformNodeData,
  WorkflowNode,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Bounds and failures
// ─────────────────────────────────────────────────────────────────────────────

/** Most fields one `transform` node may declare (Requirement 5.2). */
export const MAX_TRANSFORM_FIELDS = 200;

/**
 * Most elements a data node will project or accumulate (Requirements 5.5, 6.12).
 * A larger source array fails the node before any record is produced rather than
 * quietly spending the run's memory budget.
 */
export const MAX_DATA_ELEMENTS = 100_000;

/**
 * A data node rejected its own configuration or input.
 *
 * Carries the offending field `target` and, for a failed expression compile, the
 * zero-based character `position` the expression module reported, so the
 * properties panel can point at the character rather than the node.
 */
export class DataNodeError extends Error {
  constructor(
    message: string,
    readonly target?: string,
    readonly position?: number,
  ) {
    super(message);
    this.name = 'DataNodeError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5.2 transform
// ─────────────────────────────────────────────────────────────────────────────

/** A field paired with its compiled expression and its normalised target path. */
interface PreparedField {
  readonly field: TransformField;
  readonly target: string;
  readonly segments: readonly string[];
  readonly expression: CompiledExpression;
}

/**
 * Projects the incoming payload through the node's field list (design §5.2).
 *
 * Every expression is compiled up front, in declaration order, so a typo in the
 * last field fails the node before the first record is projected
 * (Requirement 5.1). Per field the order is fixed: expression, then `default`,
 * then `cast`, then the `required` check (Requirements 5.7-5.9).
 *
 * Array mode is selected by `mode: 'array'`, by a set `itemsPath`, or simply by a
 * source value that is an array; it returns one record per source element in
 * source order, under `resultKey` when one is declared. Record mode returns a
 * single object.
 *
 * @param node    the `transform` node; `node.data` is read as `TransformNodeData`
 * @param payload the raw incoming payload text. Kept for parity with the other
 *                node executors — the projection reads the payload only through
 *                `ctx.$` (parsed) and `ctx.$text` (raw), which the caller derives
 *                from this string.
 * @param ctx     the run's evaluation context; `nowMs` is the only clock
 * @returns the output payload as a JSON string
 * @throws {DataNodeError} for an empty or oversized field list, an invalid target
 *   path, an expression that does not compile, a non-array source where an array
 *   is required, a source array above {@link MAX_DATA_ELEMENTS}, or a `required`
 *   field left null
 */
export function runTransform(node: WorkflowNode, payload: string, ctx: EvalContext): string {
  void payload; // read only through ctx.$ / ctx.$text; see the doc comment above.
  const data = (node.data ?? {}) as TransformNodeData;
  const prepared = prepareFields(node, data);

  const itemsPath = typeof data.itemsPath === 'string' ? data.itemsPath.trim() : '';
  const source = (itemsPath === '' ? ctx.$ : resolveJsonPath(ctx.$, itemsPath)) as Json | undefined;

  // `mode: 'record'` is the only way to opt out of array projection; an
  // `itemsPath` without a mode means the author expects a list (Requirement 5.4).
  const arrayRequired = data.mode === 'array' || (itemsPath !== '' && data.mode !== 'record');
  const resultKey = typeof data.resultKey === 'string' ? data.resultKey.trim() : '';
  const itemContext: EvalContext = data.lookups ? { ...ctx, lookups: data.lookups } : ctx;

  if (!Array.isArray(source)) {
    if (arrayRequired) {
      throw new DataNodeError(
        `Transform "${node.name}" expected an array at ${describeSource(itemsPath)}, found ${describeType(source)}.`,
      );
    }
    return JSON.stringify(projectOne(source ?? null, prepared, data, itemContext, 0));
  }

  if (source.length > MAX_DATA_ELEMENTS) {
    throw new DataNodeError(
      `Transform "${node.name}" received ${source.length} elements at ${describeSource(itemsPath)}, above the maximum of ${MAX_DATA_ELEMENTS}.`,
    );
  }

  const out: Json[] = [];
  for (let index = 0; index < source.length; index += 1) {
    // Loop invariant: out.length === index, and every record already appended
    // satisfies the required-field contract for its source element.
    out.push(projectOne(source[index] ?? null, prepared, data, itemContext, index));
  }
  return JSON.stringify(resultKey === '' ? out : { [resultKey]: out });
}

/**
 * Validates the field list and compiles every expression before any projection
 * runs (Requirements 5.1, 5.2).
 */
function prepareFields(node: WorkflowNode, data: TransformNodeData): PreparedField[] {
  const fields = Array.isArray(data.fields) ? data.fields : [];
  if (fields.length === 0) {
    throw new DataNodeError(
      `Transform "${node.name}" declares no fields; 1 to ${MAX_TRANSFORM_FIELDS} are required.`,
    );
  }
  if (fields.length > MAX_TRANSFORM_FIELDS) {
    throw new DataNodeError(
      `Transform "${node.name}" declares ${fields.length} fields, above the maximum of ${MAX_TRANSFORM_FIELDS}.`,
    );
  }

  const prepared: PreparedField[] = [];
  for (const field of fields) {
    const target = typeof field?.target === 'string' ? field.target.trim() : '';
    const segments = target.split('.');
    if (target === '' || segments.some((segment) => segment.trim() === '')) {
      throw new DataNodeError(
        `Transform "${node.name}" declares the invalid target path ${JSON.stringify(field?.target ?? null)}.`,
        target,
      );
    }
    try {
      prepared.push({
        field,
        target,
        segments: segments.map((segment) => segment.trim()),
        expression: compileExpression(field.expression),
      });
    } catch (error) {
      if (error instanceof ExpressionError) {
        const position = error.position ?? 0;
        throw new DataNodeError(
          `Transform "${target}" expression is invalid at position ${position}: ${error.message}`,
          target,
          position,
        );
      }
      throw error;
    }
  }
  return prepared;
}

/**
 * Projects one source element into one output record (design §5.2 `projectOne`).
 *
 * `passthrough` copies the element's own top-level fields first, so a mapped
 * target replaces a copied field of the same name (Requirement 5.11).
 */
function projectOne(
  element: Json,
  prepared: readonly PreparedField[],
  data: TransformNodeData,
  ctx: EvalContext,
  index: number,
): Json {
  const record: Record<string, Json> = data.passthrough === true ? shallowCopy(element) : {};
  const elementContext: EvalContext = { ...ctx, item: element, index };

  for (const { field, target, segments, expression } of prepared) {
    const raw = expression.evaluate(elementContext);
    let value: Json = isNullish(raw) ? (field.default ?? null) : raw;
    if (field.cast) value = castValue(value, field.cast);

    if (field.required === true && isNullish(value)) {
      throw new DataNodeError(`Transform "${target}" produced no value.`, target);
    }
    // A null optional target is omitted rather than written as null
    // (Requirement 5.10).
    if (!isNullish(value)) setPath(record, segments, value);
  }
  return record;
}

/**
 * Writes `value` at a dotted target path, creating one object per absent
 * intermediate segment (Requirement 5.10).
 *
 * Copy-on-write: an intermediate object reached through a `passthrough` copy is
 * still owned by the incoming payload, so it is replaced by a shallow copy before
 * being descended into. Nothing reachable from the payload is written to
 * (Requirement 5.13).
 */
function setPath(record: Record<string, Json>, segments: readonly string[], value: Json): void {
  let cursor = record;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    const existing = cursor[segment];
    const next: Record<string, Json> = isJsonObject(existing) ? { ...existing } : {};
    cursor[segment] = next;
    cursor = next;
  }
  cursor[segments[segments.length - 1]!] = value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Casts
// ─────────────────────────────────────────────────────────────────────────────

/** Parsed by the expression language, so cast and `parseDate()` cannot drift. */
const PARSE_DATE = compileExpression('parseDate($)');

/** Strict numeric literal: no partial parses, matching `toNumber` in §4.3. */
const NUMERIC_PATTERN = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

const TRUE_WORDS: ReadonlySet<string> = new Set(['true', '1', 'yes', 'on', 'y']);
const FALSE_WORDS: ReadonlySet<string> = new Set(['false', '0', 'no', 'off', 'n']);

/**
 * Epoch-millisecond bounds of the four-digit-year ISO range: exactly
 * `0000-01-01T00:00:00.000Z` and `9999-12-31T23:59:59.999Z`.
 *
 * Deliberately narrower than the ECMAScript time range (±8.64e15). `date-iso`
 * renders with `Date#toISOString`, which switches to the ISO-8601 expanded-year
 * form (`+033658-09-27T…`) outside years 0000-9999, while `parseDate()` accepts an
 * unsigned four-to-six digit year only — so an expanded-year string cast a second
 * time would come back `null`. Clamping the input instead keeps the cast total and
 * idempotent (Requirement 5.8) and keeps every output in `YYYY-MM-DDTHH:mm:ss.sssZ`.
 */
const MIN_DATE_ISO_EPOCH_MS = -62_167_219_200_000;
const MAX_DATE_ISO_EPOCH_MS = 253_402_300_799_999;

/**
 * Total value cast (design §5.2, Requirement 5.8).
 *
 * Every cast returns `null` rather than throwing when the value cannot be
 * converted, and `null` in is always `null` out — so a `required` field cannot be
 * satisfied by a cast artefact such as `false` or `0`.
 *
 * - `string` — scalars render as text; an array or object renders as canonical
 *   JSON, matching `toString()` in the expression table.
 * - `number` — a finite number, a boolean, or a string holding a complete decimal
 *   literal; anything else is `null`.
 * - `integer` — as `number`, then truncated toward zero.
 * - `boolean` — a boolean, a finite number (`0` is false), or one of the
 *   true/false words; any other string is `null`.
 * - `date-iso` — epoch milliseconds or an ISO-8601 string, always emitted as
 *   `YYYY-MM-DDTHH:mm:ss.sssZ`; an instant outside years 0000-9999 is `null`, so
 *   the output is always a string `parseDate()` reads back unchanged.
 */
export function castValue(value: Json, cast: NonNullable<TransformField['cast']>): Json {
  if (value === null || value === undefined) return null;

  switch (cast) {
    case 'string': {
      if (typeof value === 'string') return value;
      if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
      if (typeof value === 'boolean') return value ? 'true' : 'false';
      try {
        return canonicalJson(value);
      } catch {
        return null;
      }
    }

    case 'number':
    case 'integer': {
      const numeric = toNumber(value);
      if (numeric === undefined) return null;
      if (cast === 'number') return numeric;
      const truncated = Math.trunc(numeric);
      // `-0` serialises as `0` but compares unequal under Object.is; normalise so
      // repeated runs stay byte-identical.
      return truncated === 0 ? 0 : truncated;
    }

    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return Number.isFinite(value) ? value !== 0 : null;
      if (typeof value === 'string') {
        const text = value.trim().toLowerCase();
        if (TRUE_WORDS.has(text)) return true;
        if (FALSE_WORDS.has(text)) return false;
        return null;
      }
      return null;
    }

    case 'date-iso': {
      const epochMs = PARSE_DATE.evaluate({ $: value, $text: '', nowMs: 0 });
      if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return null;
      if (epochMs < MIN_DATE_ISO_EPOCH_MS || epochMs > MAX_DATE_ISO_EPOCH_MS) return null;
      return new Date(epochMs).toISOString();
    }
  }
}

/** A finite number from a number, a boolean or a complete decimal literal. */
function toNumber(value: Json): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!NUMERIC_PATTERN.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

function isNullish(value: Json | undefined): boolean {
  return value === null || value === undefined;
}

/** A JSON object — not null, not an array. */
function isJsonObject(value: Json | undefined): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The element's own top-level fields; a non-object element contributes none. */
function shallowCopy(element: Json): Record<string, Json> {
  return isJsonObject(element) ? { ...element } : {};
}

function describeSource(itemsPath: string): string {
  return itemsPath === '' ? 'the payload root' : `"${itemsPath}"`;
}

function describeType(value: Json | undefined): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5.3 aggregate
// ─────────────────────────────────────────────────────────────────────────────

/** Most `by` paths one `group` spec may declare (Requirement 6.1). */
export const MAX_GROUP_BY_PATHS = 10;

/** Most metrics one `group` spec may declare (Requirement 6.2). */
export const MAX_GROUP_METRICS = 50;

/** Most `keyFields` one `pivot` spec may declare (Requirement 6.9). */
export const MAX_PIVOT_KEY_FIELDS = 5;

/** Applied to a right-hand field name that collides (Requirement 6.8). */
const DEFAULT_COLLISION_PREFIX = 'right_';

/** Joins the pivot `keyFields` values into one key (Requirement 6.9). */
const DEFAULT_PIVOT_SEPARATOR = '_';

const METRIC_FUNCTIONS: ReadonlySet<string> = new Set<AggregateMetric['fn']>([
  'count',
  'countIf',
  'sum',
  'min',
  'max',
  'avg',
  'first',
  'distinct',
]);

/** A validated `by` path: the dotted source path plus its output segments. */
interface PreparedPath {
  readonly path: string;
  readonly segments: readonly string[];
}

/** A validated metric with its `countIf` predicate already compiled. */
interface PreparedMetric {
  readonly name: string;
  readonly fn: AggregateMetric['fn'];
  readonly path: string;
  readonly where?: CompiledExpression;
}

/** Per-metric accumulator. One variant per accumulation strategy. */
type MetricState =
  /** `count` and `countIf` — a row tally. */
  | { kind: 'tally'; n: number }
  /**
   * `sum` and `avg` — a Neumaier-compensated running total plus the count of
   * numeric values, so the total does not drift with the row order
   * (Requirement 6.10) and `avg` over zero values stays `null` (Requirement 6.4).
   */
  | { kind: 'total'; mode: 'sum' | 'avg'; sum: number; compensation: number; n: number }
  /** `min` and `max` — the extreme numeric value seen so far. */
  | { kind: 'extreme'; mode: 'min' | 'max'; value: number | undefined }
  /** `first` — the value from the earliest source row in the group. */
  | { kind: 'first'; has: boolean; value: Json }
  /** `distinct` — canonical JSON of each value seen, so `null` counts once. */
  | { kind: 'distinct'; seen: Set<string> };

/** One insertion-ordered group: its `by` tuple and its metric accumulators. */
interface GroupBucket {
  readonly keyValues: readonly Json[];
  readonly states: MetricState[];
}

/**
 * Groups, joins or pivots the incoming payload (design §5.3).
 *
 * The whole spec is validated first — the populated operation spec, the `by`
 * paths, uniquely named metrics, every `countIf` predicate, and the array and
 * size preconditions of every source path — so a misconfigured node fails before
 * a single row is accumulated and emits no output payload (Requirement 6.12).
 *
 * Order is taken from source order alone: groups appear in first-appearance order
 * of their `by` tuple, join rows in left-then-right source order, and pivot keys
 * in grouped-row order. Nothing is sorted, so no locale can change the result
 * (Requirement 6.10).
 *
 * @param node    the `aggregate` node; `node.data` is read as `AggregateNodeData`
 * @param payload the raw incoming payload text. Kept for parity with the other
 *                node executors — the rows are read through `ctx.$`, which the
 *                caller derives from this string.
 * @param ctx     the run's evaluation context; `nowMs` is the only clock
 * @returns the output payload as a JSON string, under `resultKey` when one is set
 * @throws {DataNodeError} for an unknown `op`, an absent operation spec, an
 *   invalid or duplicated metric, a `countIf` without a compiling `where`, a
 *   source path that is not an array, an array above {@link MAX_DATA_ELEMENTS},
 *   or two grouped rows producing the same pivot key
 */
export function runAggregate(node: WorkflowNode, payload: string, ctx: EvalContext): string {
  void payload; // read only through ctx.$ / ctx.$text; see the doc comment above.
  const data = (node.data ?? {}) as AggregateNodeData;
  const resultKey = typeof data.resultKey === 'string' ? data.resultKey.trim() : '';

  let out: Json;
  switch (data.op) {
    case 'group':
      out = aggregateGroup(node, data, ctx);
      break;
    case 'join':
      out = aggregateJoin(node, data, ctx);
      break;
    case 'pivot':
      out = aggregatePivot(node, data, ctx);
      break;
    default:
      throw new DataNodeError(
        `Aggregate "${node.name}" declares the unsupported operation ${JSON.stringify(data.op ?? null)}; expected "group", "join" or "pivot".`,
        'op',
      );
  }

  return JSON.stringify(resultKey === '' ? out : { [resultKey]: out });
}

/**
 * One output row per distinct `by` tuple, in first-appearance order
 * (Requirement 6.1, design §5.3 `aggregateGroup`).
 */
function aggregateGroup(node: WorkflowNode, data: AggregateNodeData, ctx: EvalContext): Json[] {
  const spec = requireSpec<GroupSpec>(node, data.group, 'group');
  const by = prepareGroupBy(node, spec);
  const metrics = prepareMetrics(node, spec);
  const rows = resolveRows(node, ctx, pathOf(data.itemsPath), 'itemsPath');

  // Insertion-ordered: a Map preserves first-appearance order, so grouping needs
  // no sort at all. The key is canonical JSON of the resolved tuple, which is
  // exactly JSON structural equality (Requirement 6.1).
  const buckets = new Map<string, GroupBucket>();
  for (let index = 0; index < rows.length; index += 1) {
    // Loop invariant: the bucket row counts sum to `index`.
    const row = rows[index] ?? null;
    const keyValues = by.map((entry) => asJson(resolveJsonPath(row, entry.path)));
    const key = canonicalJson(keyValues);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { keyValues, states: metrics.map(newMetricState) };
      buckets.set(key, bucket);
    }
    accumulate(bucket, metrics, row, index, ctx);
  }

  const out: Json[] = [];
  for (const bucket of buckets.values()) out.push(finaliseBucket(bucket, by, metrics));
  return out;
}

/** Folds one row into its bucket (design §5.3 `accumulate`). */
function accumulate(
  bucket: GroupBucket,
  metrics: readonly PreparedMetric[],
  row: Json,
  index: number,
  ctx: EvalContext,
): void {
  for (let i = 0; i < metrics.length; i += 1) {
    const metric = metrics[i]!;
    const state = bucket.states[i]!;

    switch (state.kind) {
      case 'tally': {
        if (metric.fn === 'count') {
          state.n += 1;
        } else if (truthy(metric.where!.evaluate({ ...ctx, item: row, index }))) {
          // Exactly one predicate evaluation per row, with `item` bound to the row
          // and `index` to its source position (Requirement 6.5).
          state.n += 1;
        }
        break;
      }

      case 'total': {
        const value = metricNumber(resolveJsonPath(row, metric.path));
        if (value !== undefined) {
          addCompensated(state, value);
          state.n += 1;
        }
        break;
      }

      case 'extreme': {
        const value = metricNumber(resolveJsonPath(row, metric.path));
        if (value !== undefined) {
          state.value =
            state.value === undefined
              ? value
              : state.mode === 'min'
                ? Math.min(state.value, value)
                : Math.max(state.value, value);
        }
        break;
      }

      case 'first': {
        if (!state.has) {
          state.has = true;
          state.value = asJson(resolveJsonPath(row, metric.path));
        }
        break;
      }

      case 'distinct': {
        state.seen.add(canonicalJson(resolveJsonPath(row, metric.path)));
        break;
      }
    }
  }
}

/**
 * Turns one bucket into an output record: the `by` values at their own dotted
 * paths, then every metric under its name, both in declaration order so the
 * serialised key order is stable (Requirement 6.11).
 */
function finaliseBucket(
  bucket: GroupBucket,
  by: readonly PreparedPath[],
  metrics: readonly PreparedMetric[],
): Json {
  const record: Record<string, Json> = {};
  for (let i = 0; i < by.length; i += 1) setPath(record, by[i]!.segments, bucket.keyValues[i] ?? null);
  for (let i = 0; i < metrics.length; i += 1) {
    record[metrics[i]!.name] = finaliseMetric(bucket.states[i]!);
  }
  return record;
}

/** Requirements 6.2-6.4: an empty `avg`/`min`/`max` is `null`, an empty `sum` is `0`. */
function finaliseMetric(state: MetricState): Json {
  switch (state.kind) {
    case 'tally':
      return state.n;
    case 'total': {
      // `avg` over zero numeric values is null, never a silent zero
      // (Requirement 6.4); an empty `sum` is 0 (Requirement 6.2).
      if (state.n === 0) return state.mode === 'sum' ? 0 : null;
      const total = finiteOrNull(state.sum + state.compensation);
      if (total === null) return null;
      return state.mode === 'sum' ? total : finiteOrNull(total / state.n);
    }
    case 'extreme':
      return state.value === undefined ? null : state.value;
    case 'first':
      return state.has ? state.value : null;
    case 'distinct':
      return state.seen.size;
  }
}

/** A fresh accumulator per metric, chosen by the metric's function. */
function newMetricState(metric: PreparedMetric): MetricState {
  switch (metric.fn) {
    case 'count':
    case 'countIf':
      return { kind: 'tally', n: 0 };
    case 'sum':
    case 'avg':
      return { kind: 'total', mode: metric.fn, sum: 0, compensation: 0, n: 0 };
    case 'min':
      return { kind: 'extreme', mode: 'min', value: undefined };
    case 'max':
      return { kind: 'extreme', mode: 'max', value: undefined };
    case 'first':
      return { kind: 'first', has: false, value: null };
    case 'distinct':
      return { kind: 'distinct', seen: new Set<string>() };
  }
}

/**
 * Neumaier compensated addition.
 *
 * Plain `+=` makes a float total depend on row order, which Requirement 6.10
 * forbids; carrying the lost low-order bits keeps the total stable for any
 * permutation of the same values.
 */
function addCompensated(state: { sum: number; compensation: number }, value: number): void {
  const next = state.sum + value;
  state.compensation +=
    Math.abs(state.sum) >= Math.abs(value)
      ? state.sum - next + value
      : value - next + state.sum;
  state.sum = next;
}

/**
 * Inner and left join over two resolved arrays (design §5.3 `aggregateJoin`,
 * Requirements 6.6-6.8).
 */
function aggregateJoin(node: WorkflowNode, data: AggregateNodeData, ctx: EvalContext): Json[] {
  const spec = requireSpec<JoinSpec>(node, data.join, 'join');
  if (spec.type !== 'inner' && spec.type !== 'left') {
    throw new DataNodeError(
      `Aggregate "${node.name}" declares the unsupported join type ${JSON.stringify(spec.type ?? null)}; expected "inner" or "left".`,
      'join.type',
    );
  }
  const leftKey = requirePath(node, spec.leftKey, 'join.leftKey').path;
  const rightKey = requirePath(node, spec.rightKey, 'join.rightKey').path;
  const prefix =
    typeof spec.collisionPrefix === 'string' && spec.collisionPrefix !== ''
      ? spec.collisionPrefix
      : DEFAULT_COLLISION_PREFIX;

  const left = resolveRows(node, ctx, pathOf(spec.leftPath), 'join.leftPath');
  const right = resolveRows(node, ctx, pathOf(spec.rightPath), 'join.rightPath');

  // Right rows indexed by canonical key, each bucket in right source order, so
  // the output order is left position then right position (Requirement 6.6).
  const index = new Map<string, Json[]>();
  for (const row of right) {
    const key = canonicalJson(resolveJsonPath(row, rightKey));
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [row ?? null]);
    else bucket.push(row ?? null);
  }

  const out: Json[] = [];
  for (const row of left) {
    const matches = index.get(canonicalJson(resolveJsonPath(row, leftKey))) ?? [];
    if (matches.length === 0) {
      // An unmatched left row is dropped by `inner` and emitted bare by `left`
      // (Requirements 6.6, 6.7).
      if (spec.type === 'left') out.push(shallowCopy(row ?? null));
      continue;
    }
    for (const match of matches) out.push(mergeWithPrefix(row ?? null, match, prefix));
  }
  return out;
}

/**
 * Left fields keep their own names; a colliding right field moves under
 * `prefix + name` (Requirement 6.8).
 */
function mergeWithPrefix(left: Json, right: Json, prefix: string): Json {
  const merged = shallowCopy(left);
  if (!isJsonObject(right)) return merged;
  for (const [key, value] of Object.entries(right)) {
    merged[Object.prototype.hasOwnProperty.call(merged, key) ? `${prefix}${key}` : key] =
      value ?? null;
  }
  return merged;
}

/**
 * One flat object keyed by the grouped rows' `keyFields` (Requirements 6.9, 6.13).
 *
 * `columns` is read defensively: when a spec declares the pivot's column
 * vocabulary, every declared column absent from the grouped rows is emitted as
 * `fillValue` so the output width does not depend on which columns the source
 * happened to return.
 */
function aggregatePivot(node: WorkflowNode, data: AggregateNodeData, ctx: EvalContext): Json {
  const spec = requireSpec<PivotSpec>(node, data.pivot, 'pivot');
  const keyFields = preparePathList(
    node,
    spec.keyFields,
    'pivot.keyFields',
    1,
    MAX_PIVOT_KEY_FIELDS,
  );
  const valueField = requirePath(node, spec.valueField, 'pivot.valueField').path;
  const separator =
    typeof spec.separator === 'string' ? spec.separator : DEFAULT_PIVOT_SEPARATOR;
  const fillValue = spec.fillValue === undefined ? null : spec.fillValue;

  const rowsPath = pathOf(spec.rowsPath);
  const sourcePath = rowsPath === '' ? pathOf(data.itemsPath) : rowsPath;
  const rows = resolveRows(
    node,
    ctx,
    sourcePath,
    rowsPath === '' && pathOf(data.itemsPath) !== '' ? 'itemsPath' : 'pivot.rowsPath',
  );

  const cells = new Map<string, Json>();
  for (const row of rows) {
    const key = keyFields
      .map((entry) => pivotKeyPart(resolveJsonPath(row, entry.path)))
      .join(separator);
    if (cells.has(key)) {
      // Fail before writing, so no already-computed value is overwritten
      // (Requirement 6.13).
      throw new DataNodeError(
        `Aggregate "${node.name}" produced the duplicate pivot key "${key}".`,
        key,
      );
    }
    cells.set(key, asJson(resolveJsonPath(row, valueField)));
  }

  const declared: unknown[] = Array.isArray(spec.columns) ? spec.columns : [];
  for (const column of declared) {
    if (typeof column === 'string' && !cells.has(column)) cells.set(column, fillValue);
  }

  // fromEntries defines own properties, so a key such as `__proto__` stays data.
  return Object.fromEntries(cells) as Json;
}

/** A pivot key segment: a string as written, anything else as canonical JSON. */
function pivotKeyPart(value: unknown): string {
  return typeof value === 'string' ? value : canonicalJson(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate validation — everything here runs before the first row
// ─────────────────────────────────────────────────────────────────────────────

/** Requirement 6.12: the spec named by `op` must be present. */
function requireSpec<T>(node: WorkflowNode, spec: T | undefined, name: 'group' | 'join' | 'pivot'): T {
  if (!isJsonObject(spec as unknown as Json | undefined)) {
    throw new DataNodeError(
      `Aggregate "${node.name}" declares op "${name}" but no "${name}" spec.`,
      name,
    );
  }
  return spec as T;
}

function prepareGroupBy(node: WorkflowNode, spec: GroupSpec): PreparedPath[] {
  return preparePathList(node, spec.by, 'group.by', 1, MAX_GROUP_BY_PATHS);
}

/**
 * Validates the metric list and compiles every `countIf` predicate up front, so a
 * duplicated name or a broken predicate fails the node before any accumulation
 * (Requirements 6.2, 6.12).
 */
function prepareMetrics(node: WorkflowNode, spec: GroupSpec): PreparedMetric[] {
  const metrics = Array.isArray(spec.metrics) ? spec.metrics : [];
  if (metrics.length > MAX_GROUP_METRICS) {
    throw new DataNodeError(
      `Aggregate "${node.name}" declares ${metrics.length} metrics, above the maximum of ${MAX_GROUP_METRICS}.`,
      'group.metrics',
    );
  }

  const prepared: PreparedMetric[] = [];
  const names = new Set<string>();
  for (const metric of metrics) {
    const name = typeof metric?.name === 'string' ? metric.name.trim() : '';
    if (name === '') {
      throw new DataNodeError(
        `Aggregate "${node.name}" declares a metric with the invalid name ${JSON.stringify(metric?.name ?? null)}.`,
        'group.metrics',
      );
    }
    if (names.has(name)) {
      throw new DataNodeError(
        `Aggregate "${node.name}" declares the metric name "${name}" more than once.`,
        name,
      );
    }
    names.add(name);

    const fn = metric?.fn;
    if (typeof fn !== 'string' || !METRIC_FUNCTIONS.has(fn)) {
      throw new DataNodeError(
        `Aggregate metric "${name}" declares the unsupported function ${JSON.stringify(fn ?? null)}.`,
        name,
      );
    }

    if (fn === 'countIf') {
      prepared.push({ name, fn, path: '', where: compileMetricWhere(node, name, metric.where) });
      continue;
    }
    if (fn === 'count') {
      prepared.push({ name, fn, path: '' });
      continue;
    }
    prepared.push({ name, fn, path: requirePath(node, metric.path, `metric "${name}" path`).path });
  }
  return prepared;
}

/** Requirement 6.12: `countIf` needs a `where` and that `where` must compile. */
function compileMetricWhere(
  node: WorkflowNode,
  name: string,
  where: string | undefined,
): CompiledExpression {
  if (typeof where !== 'string' || where.trim() === '') {
    throw new DataNodeError(
      `Aggregate metric "${name}" is a countIf but declares no "where" predicate.`,
      name,
    );
  }
  try {
    return compileExpression(where);
  } catch (error) {
    if (error instanceof ExpressionError) {
      const position = error.position ?? 0;
      throw new DataNodeError(
        `Aggregate metric "${name}" where predicate is invalid at position ${position}: ${error.message}`,
        name,
        position,
      );
    }
    throw error;
  }
}

/** A list of 1..max dotted paths, each with non-empty segments. */
function preparePathList(
  node: WorkflowNode,
  paths: readonly string[] | undefined,
  label: string,
  min: number,
  max: number,
): PreparedPath[] {
  const list = Array.isArray(paths) ? paths : [];
  if (list.length < min || list.length > max) {
    throw new DataNodeError(
      `Aggregate "${node.name}" declares ${list.length} "${label}" paths; ${min} to ${max} are required.`,
      label,
    );
  }
  return list.map((path) => requirePath(node, path, label));
}

/** Validates one dotted path, rejecting an empty path or an empty segment. */
function requirePath(node: WorkflowNode, path: string | undefined, label: string): PreparedPath {
  const trimmed = typeof path === 'string' ? path.trim() : '';
  const segments = trimmed.split('.').map((segment) => segment.trim());
  if (trimmed === '' || segments.some((segment) => segment === '')) {
    throw new DataNodeError(
      `Aggregate "${node.name}" declares the invalid ${label} ${JSON.stringify(path ?? null)}.`,
      label,
    );
  }
  return { path: segments.join('.'), segments };
}

/**
 * Resolves a source array and checks its size before any accumulation
 * (Requirement 6.12). An absent path means the payload root.
 */
function resolveRows(node: WorkflowNode, ctx: EvalContext, path: string, label: string): Json[] {
  const source = path === '' ? ctx.$ : (resolveJsonPath(ctx.$, path) as Json | undefined);
  if (!Array.isArray(source)) {
    throw new DataNodeError(
      `Aggregate "${node.name}" expected an array at ${describeSource(path)} for "${label}", found ${describeType(source)}.`,
      label,
    );
  }
  if (source.length > MAX_DATA_ELEMENTS) {
    throw new DataNodeError(
      `Aggregate "${node.name}" received ${source.length} elements at ${describeSource(path)} for "${label}", above the maximum of ${MAX_DATA_ELEMENTS}.`,
      label,
    );
  }
  return source;
}

function pathOf(path: string | undefined): string {
  return typeof path === 'string' ? path.trim() : '';
}

/** `resolveJsonPath` returns `unknown`; an absent path is `null` here. */
function asJson(value: unknown): Json {
  return (value ?? null) as Json;
}

/**
 * A metric value (Requirement 6.3).
 *
 * Only a finite number or a string holding a complete decimal literal counts; a
 * boolean, an object, an array, `null` and an absent path are excluded from the
 * metric rather than coerced, so no metric can report `NaN` or a value invented
 * by coercion.
 */
function metricNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!NUMERIC_PATTERN.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5.5 for-each batch mode
// ─────────────────────────────────────────────────────────────────────────────

/** Smallest `batchSize` that turns the loop into batch mode (Requirement 9.8). */
export const MIN_BATCH_SIZE = 2;

/**
 * Largest accepted `batchSize` (Requirement 9.8).
 *
 * A value above this is not clamped: it falls back to per-item iteration, the
 * same as any other out-of-range value, so an author who typed an extra zero gets
 * today's behaviour rather than one giant batch (Requirement 9.9).
 */
export const MAX_BATCH_SIZE = 10_000;

/**
 * Normalises a `ForEachNodeData.batchSize` into an effective batch size.
 *
 * The single place the range rule lives, so `batchItems` and the caller that has
 * to decide what to report as `loop-started.total` cannot disagree.
 *
 * @param batchSize the raw node-data value; anything at all is accepted
 * @returns the batch size when it is an integer in
 *   {@link MIN_BATCH_SIZE}..{@link MAX_BATCH_SIZE}, otherwise `undefined` for
 *   per-item iteration (Requirement 9.9). `undefined` covers an absent value, a
 *   non-number, a non-integer, `NaN`, an infinity, zero, one, a negative value
 *   and anything above {@link MAX_BATCH_SIZE}.
 */
export function resolveBatchSize(batchSize: unknown): number | undefined {
  if (typeof batchSize !== 'number' || !Number.isInteger(batchSize)) return undefined;
  if (batchSize < MIN_BATCH_SIZE || batchSize > MAX_BATCH_SIZE) return undefined;
  return batchSize;
}

/**
 * Regroups a `for-each` node's source items into batches (design §5.5).
 *
 * **Contract.** The return value is always the list the loop iterates, one
 * element per iteration, so a caller materialises items with
 * `batchItems(items, data.batchSize)` and needs no other change:
 *
 * - `resolveBatchSize(batchSize) === undefined` — the **same array reference** is
 *   returned, so each element is a single item and the loop keeps today's
 *   per-item behaviour (Requirement 9.9). Reference identity is part of the
 *   contract: `batchItems(xs, 1) === xs`.
 * - otherwise — a fresh array of `ceil(items.length / batchSize)` fresh batch
 *   arrays, each element an array of items (Requirement 9.8). Every batch but the
 *   last holds exactly `batchSize` items; the last holds 1 to `batchSize`.
 *
 * Callers that must distinguish the two cases (to report the batch count as
 * `loop-started.total` and a batch array as `loop-iteration.item`, Requirement
 * 9.11) ask {@link resolveBatchSize} rather than inspecting the returned
 * elements, since a source item may itself be an array.
 *
 * Concatenating the result in order always reproduces `items` with the same order
 * and multiplicity, and an empty source yields an empty result — zero iterations —
 * in both cases (Requirement 9.10).
 *
 * Pure and total: no clock, no failure mode, and neither `items` nor any element
 * is read for anything but its position, so the source list is never mutated.
 *
 * @param items     the materialised source item list
 * @param batchSize the raw `ForEachNodeData.batchSize`
 * @returns the iteration list: `items` itself, or its batches
 */
export function batchItems<T>(
  items: readonly T[],
  batchSize: unknown,
): readonly T[] | readonly T[][] {
  const size = resolveBatchSize(batchSize);
  if (size === undefined) return items;

  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    // Loop invariant: the concatenation of `out` is items[0 .. i-1], and every
    // batch already appended holds exactly `size` items.
    out.push(items.slice(i, Math.min(i + size, items.length)));
  }
  return out;
}
