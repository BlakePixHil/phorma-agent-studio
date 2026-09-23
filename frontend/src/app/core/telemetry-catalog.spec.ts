/**
 * Property 5 for the telemetry Counter_Catalog.
 *
 * The catalog is closed by construction - a family list crossed with a dimension
 * list, expanded once at module load - so the claim has two halves:
 *
 * - COMPLETE: every `WorkflowNodeKind`, every default panel id, every
 *   `AssistantMode`, every `DeployTargetId` and every error category has a
 *   counter name.
 * - CLOSED: nothing else is in the catalog. This is the half that matters, so it
 *   is driven by generators that build plausible-but-wrong names: arbitrary
 *   strings, mutations of valid names, and cross-family pairings such as
 *   `node.created:{a panel id}`.
 *
 * The oracle is an independent re-expansion of the exported family and dimension
 * lists that joins with a literal `':'` rather than calling `counterName`, so the
 * separator and the expansion rule are both pinned rather than assumed.
 *
 * The node-kind, panel-id and assistant-mode lists below are independent
 * transcriptions of their sources, each paired with a compile-time exhaustiveness
 * assertion, so a member added to a union without reaching this spec is a build
 * error rather than a silently passing test.
 *
 * **Validates: Requirements 3.1**
 */

import fc from 'fast-check';

import type { AssistantMode } from './assistant-chat.model';
import { DEPLOY_TARGETS, type DeployTargetId } from './deploy/deploy-targets';
import { EXPANDABLE_PANEL_IDS } from './panel-expand.service';
import {
  COUNTED_ASSISTANT_MODES,
  COUNTED_DEPLOY_TARGETS,
  COUNTED_NODE_KINDS,
  COUNTED_PANEL_IDS,
  COUNTER_CATALOG,
  DIMENSIONED_COUNTER_FAMILIES,
  DIMENSIONLESS_COUNTER_FAMILIES,
  ERROR_CATEGORIES,
  type DimensionedCounterFamily,
  counterName,
} from './telemetry-catalog';
import type { WorkflowNodeKind } from './workflow.model';

/** Minimum iterations for every property in this suite. */
const RUNS = { numRuns: 200 };

// ─── Independent transcriptions of the dimension sources ────────────────────

/** Resolves to `never` only when the transcription below covers the union. */
type AssertCovered<T extends never> = T;

/** Every member of `WorkflowNodeKind`, transcribed from `workflow.model.ts`. */
const UNION_NODE_KINDS = [
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
] as const satisfies readonly WorkflowNodeKind[];

/** Compile error when a `WorkflowNodeKind` is missing from the list above. */
type NodeKindsTranscribed = AssertCovered<
  Exclude<WorkflowNodeKind, (typeof UNION_NODE_KINDS)[number]>
>;

/**
 * Every default panel id, transcribed from `DEFAULT_TABS` in
 * `core/panel-registry.service.ts`. `DEFAULT_TABS` is module-private on an
 * Angular service and `PanelTab.id` is a plain `string`, so this is the only
 * source available to a leaf spec; `EXPANDABLE_PANEL_IDS` covers the part that
 * is a union and is asserted separately below.
 */
const DEFAULT_PANEL_TAB_IDS = [
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

/** Every member of `AssistantMode`, transcribed from `assistant-chat.model.ts`. */
const UNION_ASSISTANT_MODES = ['ask', 'plan', 'agent'] as const satisfies readonly AssistantMode[];

/** Compile error when an `AssistantMode` is missing from the list above. */
type AssistantModesTranscribed = AssertCovered<
  Exclude<AssistantMode, (typeof UNION_ASSISTANT_MODES)[number]>
>;

/** Every deploy target id, read from the exported registry at runtime. */
const REGISTERED_DEPLOY_TARGETS = Object.keys(DEPLOY_TARGETS) as DeployTargetId[];

// ─── The oracle ─────────────────────────────────────────────────────────────

const DIMENSIONED_FAMILIES = Object.keys(
  DIMENSIONED_COUNTER_FAMILIES,
) as DimensionedCounterFamily[];

/**
 * The expansion the catalog is supposed to be: every dimensionless family name,
 * plus every dimensioned family joined to each member of its own dimension list
 * with a literal `':'`.
 */
function expandDeclaredFamilies(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const family of DIMENSIONLESS_COUNTER_FAMILIES) {
    names.add(family);
  }
  for (const family of DIMENSIONED_FAMILIES) {
    for (const dimension of DIMENSIONED_COUNTER_FAMILIES[family] as readonly string[]) {
      names.add(`${family}:${dimension}`);
    }
  }
  return names;
}

const EXPANSION = expandDeclaredFamilies();
const EXPANSION_NAMES = [...EXPANSION];

/** Every dimension value any family declares, deduplicated. */
const ALL_DIMENSIONS = [
  ...new Set<string>([
    ...COUNTED_NODE_KINDS,
    ...COUNTED_PANEL_IDS,
    ...COUNTED_ASSISTANT_MODES,
    ...COUNTED_DEPLOY_TARGETS,
    ...ERROR_CATEGORIES,
  ]),
];

/**
 * Names that are NOT in the expansion: arbitrary strings, mutations of valid
 * names, and valid names carrying an extra dimension. Kept deliberately close to
 * the real names so closure is tested at the boundary rather than far from it.
 */
const nearMissName = fc.oneof(
  fc.string(),
  fc.string({ minLength: 1, maxLength: 12 }).map(s => `node.created:${s}`),
  fc.string({ minLength: 1, maxLength: 12 }).map(s => `${s}:agent`),
  fc.constantFrom(...EXPANSION_NAMES).chain(name =>
    fc.oneof(
      fc.constant(name.toUpperCase()),
      fc.constant(`${name} `),
      fc.constant(` ${name}`),
      fc.constant(name.replace(':', '.')),
      fc.constant(name.replace(':', '::')),
      fc.constant(`${name}:extra`),
      fc.constant(name.slice(0, -1)),
      fc.string({ minLength: 1, maxLength: 8 }).map(suffix => `${name}${suffix}`),
      fc.string({ minLength: 1, maxLength: 8 }).map(prefix => `${prefix}${name}`),
    ),
  ),
);

describe('telemetry Counter_Catalog', () => {
  // ─── Closed ───────────────────────────────────────────────────────────────

  // Feature: telemetry-phone-home, Property 5: The Counter_Catalog is closed and complete
  it('contains a name exactly when the family expansion contains it', () => {
    fc.assert(
      fc.property(fc.oneof(fc.constantFrom(...EXPANSION_NAMES), nearMissName), candidate => {
        expect(COUNTER_CATALOG.has(candidate)).toBe(EXPANSION.has(candidate));
      }),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 5: The Counter_Catalog is closed and complete
  it('rejects a family paired with a dimension from another family', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DIMENSIONED_FAMILIES),
        fc.constantFrom(...ALL_DIMENSIONS),
        (family, dimension) => {
          const own = DIMENSIONED_COUNTER_FAMILIES[family] as readonly string[];
          fc.pre(!own.includes(dimension));
          expect(COUNTER_CATALOG.has(counterName(family, dimension))).toBe(false);
        },
      ),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 5: The Counter_Catalog is closed and complete
  it('rejects a dimensionless family carrying a dimension', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DIMENSIONLESS_COUNTER_FAMILIES),
        fc.oneof(fc.constantFrom(...ALL_DIMENSIONS), fc.string({ minLength: 1, maxLength: 12 })),
        (family, dimension) => {
          expect(COUNTER_CATALOG.has(counterName(family, dimension))).toBe(false);
        },
      ),
      RUNS,
    );
  });

  // Feature: telemetry-phone-home, Property 5: The Counter_Catalog is closed and complete
  it('rejects a dimensioned family with its dimension omitted', () => {
    fc.assert(
      fc.property(fc.constantFrom(...DIMENSIONED_FAMILIES), family => {
        expect(COUNTER_CATALOG.has(counterName(family))).toBe(false);
      }),
      RUNS,
    );
  });

  // ─── Complete ─────────────────────────────────────────────────────────────

  // Feature: telemetry-phone-home, Property 5: The Counter_Catalog is closed and complete
  it('has a counter for every node kind, panel id, assistant mode, deploy target and error category', () => {
    const expected: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['node.created', UNION_NODE_KINDS],
      ['panel.opened', DEFAULT_PANEL_TAB_IDS],
      ['assistant.invoked', UNION_ASSISTANT_MODES],
      ['deploy.started', REGISTERED_DEPLOY_TARGETS],
      ['error', ERROR_CATEGORIES],
    ];
    fc.assert(
      fc.property(
        fc
          .constantFrom(...expected)
          .chain(([family, dimensions]) =>
            fc.constantFrom(...dimensions).map(dimension => `${family}:${dimension}`),
          ),
        name => {
          expect(COUNTER_CATALOG.has(name)).toBe(true);
        },
      ),
      RUNS,
    );
  });

  // ─── Exact contents, asserted once ────────────────────────────────────────

  it('equals its family expansion and holds 57 names', () => {
    expect([...COUNTER_CATALOG].sort()).toEqual(EXPANSION_NAMES.sort());
    expect(COUNTER_CATALOG.size).toBe(57);
  });

  it('sizes each dimension list as the design declares', () => {
    expect(UNION_NODE_KINDS.length).toBe(26);
    expect(DEFAULT_PANEL_TAB_IDS.length).toBe(11);
    expect(UNION_ASSISTANT_MODES.length).toBe(3);
    expect(REGISTERED_DEPLOY_TARGETS.length).toBe(3);
    expect(ERROR_CATEGORIES.length).toBe(10);
    expect(DIMENSIONLESS_COUNTER_FAMILIES.length).toBe(4);
  });

  it('counts each dimension list exactly once in the catalog', () => {
    const dimensionsOf = (family: string) =>
      [...COUNTER_CATALOG].filter(name => name.startsWith(`${family}:`));
    expect(dimensionsOf('node.created').length).toBe(UNION_NODE_KINDS.length);
    expect(dimensionsOf('panel.opened').length).toBe(DEFAULT_PANEL_TAB_IDS.length);
    expect(dimensionsOf('assistant.invoked').length).toBe(UNION_ASSISTANT_MODES.length);
    expect(dimensionsOf('deploy.started').length).toBe(REGISTERED_DEPLOY_TARGETS.length);
    expect(dimensionsOf('error').length).toBe(ERROR_CATEGORIES.length);
  });

  it('matches its dimension lists against the sources they transcribe', () => {
    expect([...COUNTED_NODE_KINDS].sort()).toEqual([...UNION_NODE_KINDS].sort());
    expect([...COUNTED_PANEL_IDS].sort()).toEqual([...DEFAULT_PANEL_TAB_IDS].sort());
    expect([...COUNTED_ASSISTANT_MODES].sort()).toEqual([...UNION_ASSISTANT_MODES].sort());
    expect([...COUNTED_DEPLOY_TARGETS].sort()).toEqual([...REGISTERED_DEPLOY_TARGETS].sort());
  });

  it('covers every expandable panel id', () => {
    for (const id of EXPANDABLE_PANEL_IDS) {
      expect(COUNTER_CATALOG.has(counterName('panel.opened', id))).toBe(true);
    }
  });
});

// Keep the compile-time coverage assertions load-bearing rather than unused.
export type { AssistantModesTranscribed, NodeKindsTranscribed };
