/**
 * The closed Counter_Catalog for anonymous usage telemetry.
 *
 * Structural twin of `cloud/src/telemetry-catalog.ts`. The two declare the same
 * counter names independently - there is no import across the package boundary -
 * and `scripts/check-telemetry-catalog.mjs` asserts they stay identical.
 *
 * This module is a LEAF: no Angular, no services, no DOM. Every import here is
 * type-only, so nothing in the studio's service graph is pulled in by depending
 * on the catalog.
 */

import type { AssistantMode } from './assistant-chat.model';
import type { DeployTargetId } from './deploy/deploy-targets';
import type { ExpandablePanelId } from './panel-expand.service';
import type { WorkflowNodeKind } from './workflow.model';

/** Rollup wire schema version. Bump only for a breaking payload change. */
export const TELEMETRY_SCHEMA_VERSION = 1;

/**
 * Version of the privacy disclosure this build acknowledges. The disclosure
 * itself is made on the download page, before the installer is fetched, not in
 * the app - this integer only RECORDS which policy version an install has
 * stamped, and bumping it re-stamps every install without touching anyone's
 * Consent_State.
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

// ─── Dimension lists ────────────────────────────────────────────────────────
//
// Each list is `satisfies` its dimension type, so a typo is a compile error, and
// each is paired with an exhaustiveness assertion below, so ADDING a member to
// the underlying union without adding its counter here is also a compile error.

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
  'render-document',
  'state-list',
] as const satisfies readonly WorkflowNodeKind[];

/**
 * Every default panel id that gets a `panel.opened:{id}` counter, in
 * `DEFAULT_TABS` order.
 *
 * `DEFAULT_TABS` in `core/panel-registry.service.ts` is a module-private value on
 * an Angular service and `PanelTab.id` is a plain `string`, so the ids are
 * declared literally here rather than imported. `ExpandablePanelId` is the only
 * panel-id union that exists, so it is the part that can be checked at compile
 * time; `scripts/check-telemetry-catalog.mjs` covers parity with the full
 * `DEFAULT_TABS` list.
 */
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
] as const satisfies readonly string[];

/** Every assistant mode that gets an `assistant.invoked:{mode}` counter. */
export const COUNTED_ASSISTANT_MODES = [
  'ask',
  'plan',
  'agent',
] as const satisfies readonly AssistantMode[];

/** Every deploy target that gets a `deploy.started:{target}` counter. */
export const COUNTED_DEPLOY_TARGETS = [
  'phorma',
  'cloudflare',
  'aws',
] as const satisfies readonly DeployTargetId[];

export type CountedNodeKind = (typeof COUNTED_NODE_KINDS)[number];
export type CountedPanelId = (typeof COUNTED_PANEL_IDS)[number];
export type CountedAssistantMode = (typeof COUNTED_ASSISTANT_MODES)[number];
export type CountedDeployTarget = (typeof COUNTED_DEPLOY_TARGETS)[number];

/**
 * Resolves to `never` only when every member of the union is covered. A missing
 * member surfaces as "Type '<member>' does not satisfy the constraint 'never'"
 * on the corresponding alias below.
 */
type AssertCovered<T extends never> = T;

/** Compile error when a `WorkflowNodeKind` has no `node.created` counter. */
export type NodeKindCoverage = AssertCovered<Exclude<WorkflowNodeKind, CountedNodeKind>>;
/** Compile error when an expandable panel has no `panel.opened` counter. */
export type PanelIdCoverage = AssertCovered<Exclude<ExpandablePanelId, CountedPanelId>>;
/** Compile error when an `AssistantMode` has no `assistant.invoked` counter. */
export type AssistantModeCoverage = AssertCovered<Exclude<AssistantMode, CountedAssistantMode>>;
/** Compile error when a `DeployTargetId` has no `deploy.started` counter. */
export type DeployTargetCoverage = AssertCovered<Exclude<DeployTargetId, CountedDeployTarget>>;

// ─── Families ───────────────────────────────────────────────────────────────

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
 * dimension with `:`; membership is verified against {@link COUNTER_CATALOG} at
 * increment time, so an unknown dimension is discarded rather than stored.
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
