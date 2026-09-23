/**
 * The capability vocabulary, studio copy.
 *
 * Structural twin of `cloud/src/capabilities.ts`. The two declare the same
 * contract INDEPENDENTLY - there is no import across the package boundary, the
 * same discipline `workflow.model.ts` follows against `engine/src/types.ts` - and
 * the pair is named in `.kiro/steering/structure.md` (Requirements 5.7, 16.3).
 * `cloud/test/capabilities.test.mjs` loads both modules and asserts the token sets
 * are identical, so a one-sided change fails rather than drifting (Property 36).
 *
 * The worker copy additionally owns `CLERK_ROLE_LEVELS`, the raw-claim mapping.
 * That is not part of the twin: a claim only exists on a verified credential, and
 * the studio is told its level by the server rather than reading one.
 *
 * This module is a LEAF: no Angular, no services, no DOM, and no imports at all.
 * `CapabilityService` is the only thing in the studio that resolves a level, and
 * it depends on this file rather than the reverse.
 *
 * ## Why named tokens rather than a numeric ladder
 *
 * A level is persisted in an `org_members` row, cached in KV and read by a studio
 * that may be three versions old. An ordinal renumbers every level above it the
 * day one is inserted, silently, with no type error anywhere - and a number in a
 * refusal body or an audit row is unreadable. So the wire form is a token, and the
 * vocabulary is APPEND-ONLY: a released token is never renamed or repurposed
 * (Requirement 5.11). A studio that meets a fifth level renders the literal and
 * treats it as unknown, the same default branch it already needs for an
 * unrecognised refusal code.
 */

/** The four capability levels, as wire tokens. Append-only (Requirement 5.11). */
export type CapabilityLevel = 'operator' | 'editor' | 'builder' | 'admin';

/**
 * Every level, in DISPLAY order (least capable first).
 *
 * Display order only. Nothing derives a comparison from this array's indices -
 * `atLeast` below compares capability SETS, so a level added later is
 * automatically correct rather than correct by virtue of where it was inserted. A
 * property asserts that this order AGREES with the inclusion order, so the two
 * cannot drift.
 */
export const CAPABILITY_LEVELS: readonly CapabilityLevel[] = [
  'operator',
  'editor',
  'builder',
  'admin',
];

/** True for a value that is one of the declared level tokens. */
export function isCapabilityLevel(value: unknown): value is CapabilityLevel {
  return typeof value === 'string' && (CAPABILITY_LEVELS as readonly string[]).includes(value);
}

/**
 * Every capability a level can hold, as wire tokens.
 *
 * Append-only for the same reason the level tokens are. The grouping comments
 * below say which level INTRODUCES a token, not which levels hold it - every
 * higher level holds it too, by construction (see `CAPABILITIES_BY_LEVEL`).
 */
export type Capability =
  // operator - trigger, watch, answer a gate, and read
  | 'run.trigger'
  | 'run.monitor'
  | 'run.answer_gate'
  | 'read.runs'
  | 'read.traces'
  | 'read.usage'
  | 'read.notifications'
  | 'read.workflows'
  // editor - change values inside an existing graph
  | 'edit.prompt'
  | 'edit.cron'
  | 'edit.node_config'
  | 'edit.connection_secret'
  // builder - change the graph itself, and everything around it
  | 'workflow.create'
  | 'graph.structure'
  | 'deploy.push'
  | 'deploy.delete'
  | 'connection.manage'
  | 'eval.manage'
  | 'portal.manage'
  // admin - the organisation itself
  | 'member.manage'
  | 'billing.manage';

/**
 * What `operator` may do (Requirement 5.2): trigger a run, monitor a run, approve
 * and answer gates, and read runs, traces, usage, notifications and workflows.
 *
 * Answering a gate is the ONLY write an operator holds. Reads are deliberately
 * open at this level and every level above it: the boundary this feature defends
 * is BETWEEN organisations, not within one.
 */
const OPERATOR_CAPABILITIES: readonly Capability[] = [
  'run.trigger',
  'run.monitor',
  'run.answer_gate',
  'read.runs',
  'read.traces',
  'read.usage',
  'read.notifications',
  'read.workflows',
];

/**
 * What `editor` adds (Requirement 5.3): values inside an EXISTING graph - prompt
 * text, a cron expression, node configuration, a connection secret value.
 *
 * Deliberately NOT `graph.structure` and NOT `workflow.create`. That line is the
 * whole point of having an editor level, and the spec beside this file pins it by
 * name rather than by set size.
 */
const EDITOR_CAPABILITIES: readonly Capability[] = [
  ...OPERATOR_CAPABILITIES,
  'edit.prompt',
  'edit.cron',
  'edit.node_config',
  'edit.connection_secret',
];

/**
 * What `builder` adds (Requirement 5.4): create a workflow, change graph
 * structure, deploy, and manage connections, evals and the portal - all scoped to
 * the builder's own organisation, which is the owner seam's job rather than this
 * table's.
 */
const BUILDER_CAPABILITIES: readonly Capability[] = [
  ...EDITOR_CAPABILITIES,
  'workflow.create',
  'graph.structure',
  'deploy.push',
  'deploy.delete',
  'connection.manage',
  'eval.manage',
  'portal.manage',
];

/**
 * What `admin` adds (Requirement 5.5): member management and billing.
 *
 * Both are declared here regardless of whether a surface exercises them in this
 * release. `billing.manage` is reachable only over a personal Owner_Id
 * (Requirement 19.4) and `member.manage` is reachable over no route at all
 * (Requirement 13.7) - and a released token is never renamed or repurposed to
 * reflect that, so they are declared now and the surfaces arrive later.
 */
const ADMIN_CAPABILITIES: readonly Capability[] = [
  ...BUILDER_CAPABILITIES,
  'member.manage',
  'billing.manage',
];

/**
 * Every level's capabilities, CUMULATIVE BY CONSTRUCTION.
 *
 * `editor` spreads `operator`'s array, `builder` spreads `editor`'s, `admin`
 * spreads `builder`'s. Requirement 5.6 - a higher level holds every capability of
 * every lower level - is therefore a property OF this table rather than a claim
 * ABOUT it: there is no way to add a capability to a lower level and forget the
 * higher ones, because the higher ones do not list it themselves.
 */
export const CAPABILITIES_BY_LEVEL: Readonly<Record<CapabilityLevel, readonly Capability[]>> = {
  operator: OPERATOR_CAPABILITIES,
  editor: EDITOR_CAPABILITIES,
  builder: BUILDER_CAPABILITIES,
  admin: ADMIN_CAPABILITIES,
};

/**
 * The table as sets, derived once at load from `CAPABILITY_LEVELS`.
 *
 * Derived from the level LIST rather than written out, so a level added to the
 * union, the list and the table needs no change here and `atLeast` keeps working
 * with no comparison to update.
 */
const CAPABILITY_SETS: ReadonlyMap<CapabilityLevel, ReadonlySet<Capability>> = new Map(
  CAPABILITY_LEVELS.map(level => [level, new Set(CAPABILITIES_BY_LEVEL[level])]),
);

/**
 * A level outside the table holds NOTHING, which is what makes both directions of
 * `atLeast` refuse rather than admit.
 */
const EMPTY_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>();

/** Every capability of a level, including every capability of every lower level. */
export function capabilitiesOf(level: CapabilityLevel): ReadonlySet<Capability> {
  return CAPABILITY_SETS.get(level) ?? EMPTY_CAPABILITIES;
}

/** True when `level` holds `capability`. */
export function holds(level: CapabilityLevel, capability: Capability): boolean {
  return capabilitiesOf(level).has(capability);
}

/**
 * True when `level` holds EVERY capability of `required`.
 *
 * Set INCLUSION, not an index into `CAPABILITY_LEVELS`. Two consequences worth
 * stating, because they are the reason the cheaper comparison was rejected: a
 * level added later is automatically correct without touching this function, and
 * a mistake in the table - a capability missing from a higher level - becomes a
 * FAILING comparison rather than a silently wrong one.
 *
 * Fails CLOSED on a token outside the table, in either position. A level arrives
 * from the server, so a build that meets a token it does not know must subtract a
 * surface rather than reveal one.
 */
export function atLeast(level: CapabilityLevel, required: CapabilityLevel): boolean {
  if (!CAPABILITY_SETS.has(level) || !CAPABILITY_SETS.has(required)) return false;
  for (const capability of capabilitiesOf(required)) {
    if (!holds(level, capability)) return false;
  }
  return true;
}
