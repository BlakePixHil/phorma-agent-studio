/**
 * The capability vocabulary, worker copy.
 *
 * ## What lives here, and why not in `auth.ts`
 *
 * The level TOKENS, so `resolveRole` can answer in the vocabulary the Role_Gate
 * compares; the raw-claim mapping, so a `clerk` credential's organisation role
 * claim can short-circuit the `org_members` read; the `Capability` token union
 * and the per-level table; and the three comparisons every gate is built from.
 * All of it lives here rather than in `auth.ts` on purpose: `auth.ts` is about
 * VERIFICATION and must not own the capability vocabulary (design section 2.1).
 *
 * This file is a LEAF. It imports nothing, so the Role_Gate, `resolveRole` and a
 * test script can all reach it without pulling a binding or a Durable Object
 * into the graph.
 *
 * ## Structural twin
 *
 * `frontend/src/app/core/capabilities.ts` declares the same contract
 * INDEPENDENTLY - there is no import across the package boundary, the same
 * discipline the workflow-model twins follow. The two are named as a pair in
 * `.kiro/steering/structure.md` (Requirements 5.7, 16.3), and
 * `cloud/test/capabilities.test.mjs` loads both and asserts the token sets are
 * identical, so a one-sided change fails rather than drifting (Property 36).
 *
 * ## Why named tokens rather than a numeric ladder
 *
 * A level is persisted in an `org_members` row, cached in KV and read by a studio
 * that may be three versions old. An ordinal renumbers every level above it the
 * day one is inserted, silently, with no type error anywhere - and a number in a
 * refusal body or an audit row is unreadable. So the wire form is a token, and
 * the vocabulary is APPEND-ONLY: a released token is never renamed or repurposed
 * (Requirement 5.11).
 */

/** The four capability levels, as wire tokens. Append-only (Requirement 5.11). */
export type CapabilityLevel = 'operator' | 'editor' | 'builder' | 'admin';

/**
 * Every level, in DISPLAY order (least capable first).
 *
 * Display order only. Nothing derives a comparison from this array's indices -
 * `atLeast` below compares capability SETS, so a level added later is
 * automatically correct rather than correct by virtue of where it was inserted.
 * A property asserts that this order AGREES with the inclusion order, so the two
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
 * Raw Clerk organisation role claim to capability level.
 *
 * An OPTIMISATION, not the authority. `org_members` is the authoritative source
 * (design section 2.5) because a `device` credential carries no role claim at
 * all, so this map only saves a `clerk` credential one cached read. An unmapped
 * value is NOT an error here - `resolveRole` falls through to the table, and only
 * "neither source has an answer" is `role_unknown`.
 *
 * Two key shapes for one role because the two session-token layouts spell it
 * differently: the long-standing top-level `org_role` claim carries the `org:`
 * prefix, while the compacted organisation object carries the bare role in `rol`.
 * `readOrgClaim` hands back whichever the instance emitted, unmapped and
 * unvalidated, so the tolerance belongs here.
 *
 * Clerk's built-in organisation roles are `admin` and `member`; four
 * distinguishable levels need custom roles, which is plan-dependent. That
 * question is deliberately NOT on the critical path: if custom roles are
 * unavailable this map covers `admin` alone and the table answers for everybody
 * else, which is what it was going to do anyway.
 */
export const CLERK_ROLE_LEVELS: Readonly<Record<string, CapabilityLevel>> = {
  'org:admin': 'admin',
  admin: 'admin',
};
/**
 * Every capability a level can hold, as wire tokens.
 *
 * Append-only for the same reason the level tokens are: a capability name reaches
 * an audit row, a refusal body and a studio that may be three versions old. The
 * grouping comments below say which level INTRODUCES a token, not which levels
 * hold it - every higher level holds it too, by construction (see
 * `CAPABILITIES_BY_LEVEL`).
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
 * whole point of having an editor level, and `cloud/test/capabilities.test.mjs`
 * pins it by name rather than by set size.
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
 * Both are declared here regardless of whether a route exercises them in this
 * release. `billing.manage` is reachable only over a personal Owner_Id
 * (Requirement 19.4) and `member.manage` is reachable over no route at all
 * (Requirement 13.7) - and a released token is never renamed or repurposed to
 * reflect that, so they are declared now and the routes arrive later.
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
 * Fails CLOSED on a token outside the table, in either position. Nothing should
 * reach here with one (`resolveRole` validates through `isCapabilityLevel`), but
 * a gate that admitted an unrecognised level is a worse failure than a refusal.
 */
export function atLeast(level: CapabilityLevel, required: CapabilityLevel): boolean {
  if (!CAPABILITY_SETS.has(level) || !CAPABILITY_SETS.has(required)) return false;
  for (const capability of capabilitiesOf(required)) {
    if (!holds(level, capability)) return false;
  }
  return true;
}
