/**
 * The closed Counter_Catalog for anonymous usage telemetry, Worker side.
 *
 * Structural twin of `frontend/src/app/core/telemetry-catalog.ts`. The two
 * declare the same counter names, the same schema version and the same error
 * categories INDEPENDENTLY - there is no import across the package boundary, and
 * `scripts/check-telemetry-catalog.mjs` asserts they stay identical.
 *
 * The frontend twin can pin its dimension lists to the studio's own unions
 * (`WorkflowNodeKind`, `AssistantMode`, `DeployTargetId`) with `satisfies`, so a
 * new node kind without its counter is a compile error there. None of those
 * unions exist here, so the lists are plain literal arrays and the CI guard is
 * what keeps them honest.
 *
 * This module is a LEAF: no bindings, no request handling, no imports at all.
 */

/** Rollup wire schema version. Bump only for a breaking payload change. */
export const TELEMETRY_SCHEMA_VERSION = 1;

/**
 * Every schema version the Ingest_Endpoint accepts. A Rollup carrying anything
 * else is rejected rather than stored under a shape the admin aggregates cannot
 * read.
 */
export const KNOWN_SCHEMA_VERSIONS: readonly number[] = [1];

/**
 * Version of the privacy disclosure the studio records against an install.
 * Carried here for twin fidelity: the Worker never reads it, but the guard
 * compares the two modules field for field.
 */
export const CURRENT_DISCLOSURE_VERSION = 1;

/** The closed set of error-category dimensions. A category, never a message. */
export const ERROR_CATEGORIES = [
  'model-call',
  'tool-call',
  'mcp',
  'network',
  'storage',
  'deploy',
  'auth',
  'validation',
  'engine',
  'unknown',
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

// --- Dimension lists -------------------------------------------------------

/** Every node kind that gets a `node.created:{kind}` counter. */
export const COUNTED_NODE_KINDS = [
  'agent',
  'manual-trigger',
  'schedule-trigger',
  'webhook-trigger',
  'portal-trigger',
  'http-tool',
  'web-search-tool',
  'mcp-tool',
  'router',
  'parallel',
  'aggregator',
  'approval-gate',
  'for-each',
  'wait-event',
  'ask-user',
  'execute-workflow',
  'error-handler',
  'http-request',
  'sql-query',
  'transform',
  'aggregate',
  'assert',
  'state-get',
  'state-set',
  'notify',
  'decide',
] as const;

/** Every default panel id that gets a `panel.opened:{id}` counter. */
export const COUNTED_PANEL_IDS = [
  'agents',
  'workflows',
  'runs',
  'skills',
  'connections',
  'prompt',
  'properties',
  'usage',
  'evals',
  'assistant',
  'portal',
] as const;

/** Every assistant mode that gets an `assistant.invoked:{mode}` counter. */
export const COUNTED_ASSISTANT_MODES = ['ask', 'plan', 'agent'] as const;

/** Every deploy target that gets a `deploy.started:{target}` counter. */
export const COUNTED_DEPLOY_TARGETS = ['phorma', 'cloudflare', 'aws'] as const;

export type CountedNodeKind = (typeof COUNTED_NODE_KINDS)[number];
export type CountedPanelId = (typeof COUNTED_PANEL_IDS)[number];
export type CountedAssistantMode = (typeof COUNTED_ASSISTANT_MODES)[number];
export type CountedDeployTarget = (typeof COUNTED_DEPLOY_TARGETS)[number];

// --- Families --------------------------------------------------------------

/** Counter families that carry no dimension: the whole name is the family. */
export const DIMENSIONLESS_COUNTER_FAMILIES = [
  'session.started',
  'run.started',
  'run.completed',
  'run.error',
] as const;

/** Counter families crossed with a dimension list to produce their names. */
export const DIMENSIONED_COUNTER_FAMILIES = {
  'node.created': COUNTED_NODE_KINDS,
  'panel.opened': COUNTED_PANEL_IDS,
  'assistant.invoked': COUNTED_ASSISTANT_MODES,
  'deploy.started': COUNTED_DEPLOY_TARGETS,
  error: ERROR_CATEGORIES,
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type DimensionlessCounterFamily = (typeof DIMENSIONLESS_COUNTER_FAMILIES)[number];
export type DimensionedCounterFamily = keyof typeof DIMENSIONED_COUNTER_FAMILIES;
export type CounterFamily = DimensionlessCounterFamily | DimensionedCounterFamily;

/** Separator between a family and its dimension. */
const DIMENSION_SEPARATOR = ':';

/**
 * The only way to build a counter name. Joins a family and its optional
 * dimension with `:`; membership is verified against {@link COUNTER_CATALOG}
 * during ingest normalization, so an unknown name is dropped rather than stored.
 */
export function counterName(family: CounterFamily, dimension?: string): string {
  return dimension === undefined ? family : `${family}${DIMENSION_SEPARATOR}${dimension}`;
}

/**
 * Every permitted counter name: the families crossed with their dimension lists,
 * expanded once at module load. 57 names.
 */
export const COUNTER_CATALOG: ReadonlySet<string> = expandCounterCatalog();

function expandCounterCatalog(): ReadonlySet<string> {
  const names: string[] = [];
  for (const family of DIMENSIONLESS_COUNTER_FAMILIES) {
    names.push(counterName(family));
  }
  for (const family of Object.keys(DIMENSIONED_COUNTER_FAMILIES) as DimensionedCounterFamily[]) {
    for (const dimension of DIMENSIONED_COUNTER_FAMILIES[family]) {
      names.push(counterName(family, dimension));
    }
  }
  return new Set(names);
}
