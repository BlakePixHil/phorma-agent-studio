/**
 * Pure helpers for the worker's run path (design §10, §13; task 18.4).
 *
 * Everything here answers a question about a PUSHED SPEC — "how many runs does
 * this workflow keep?", "does this policy care about this event?", "where does a
 * notification go?" — and nothing here touches storage, the network or the
 * Durable Object. That split is deliberate: `WorkflowAgent` owns the effects,
 * this module owns the decisions, and the decisions are testable without a DO.
 *
 * A pushed spec is JSON from the network, so every value is treated as
 * untrusted: an out-of-range retention number is ignored and reported rather
 * than trusted or fatal (Requirements 15.12, 15.13).
 */

import type { RedactionRule, ResolvedConnection, RunEvent, WorkflowSpec } from '@phorma/engine';

// ─────────────────────────────────────────────────────────────────────────────
// Settings the worker reads but never writes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * P1-10 / P1-12 workflow settings.
 *
 * The studio persists these in `WorkflowSettings` (`notifications`,
 * `retention`); the worker only ever reads them, so they are declared
 * structurally here rather than by widening the engine's spec contract.
 */
export interface DataPathSettings {
  notifications?: WorkflowNotificationPolicy;
  retention?: WorkflowRetentionPolicy;
}

/** Trigger names a workflow notification policy may subscribe to (13.6). */
export type NotifyTrigger = 'failure' | 'guard-breach' | 'completion';

/** `WorkflowSettings.notifications` (Requirement 13.6). Identifiers only. */
export interface WorkflowNotificationPolicy {
  on?: NotifyTrigger[];
  connectionId?: string;
  to?: string;
}

/** `WorkflowSettings.retention` (Requirements 15.11, 15.12). */
export interface WorkflowRetentionPolicy {
  keepRuns?: number;
  maxAgeDays?: number;
  noPersistNodeIds?: string[];
  redact?: RedactionRule[];
}

/**
 * The P1 settings block of a pushed spec. Never throws: `settings` may carry
 * anything at all, including nothing.
 */
export function dataPathSettings(spec: WorkflowSpec | null | undefined): DataPathSettings {
  const settings = spec?.settings as DataPathSettings | undefined;
  return settings !== null && typeof settings === 'object' ? settings : {};
}

// ─────────────────────────────────────────────────────────────────────────────
// Run-history retention (Requirements 15.12, 15.13)
// ─────────────────────────────────────────────────────────────────────────────

/** Supported `retention.keepRuns` range; anything else is ignored (15.13). */
export const MIN_KEEP_RUNS = 1;
export const MAX_KEEP_RUNS = 1000;
/** Supported `retention.maxAgeDays` range; anything else is ignored (15.13). */
export const MIN_MAX_AGE_DAYS = 1;
export const MAX_MAX_AGE_DAYS = 3650;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Effective run-history retention for one workflow. */
export interface RunRetention {
  /** Runs kept, newest first. */
  keepRuns: number;
  /** Age cut-off in ms, or null when only the count bound applies. */
  maxAgeMs: number | null;
}

/**
 * Resolves the retention bounds a run record is pruned against.
 *
 * `keepRuns` and `maxAgeDays` override the host default only while they are
 * positive integers inside their supported ranges (Requirement 15.12). Anything
 * else — a float, a zero, a string, an out-of-range number — is ignored, passed
 * to `report` naming the offending setting, and replaced by `defaultKeepRuns`
 * (Requirement 15.13).
 */
export function resolveRunRetention(
  policy: WorkflowRetentionPolicy | undefined,
  defaultKeepRuns: number,
  report: (message: string) => void = () => undefined,
): RunRetention {
  const keepRuns = boundedSetting(
    policy?.keepRuns,
    'keepRuns',
    MIN_KEEP_RUNS,
    MAX_KEEP_RUNS,
    defaultKeepRuns,
    report,
  );
  const maxAgeDays = boundedSetting(
    policy?.maxAgeDays,
    'maxAgeDays',
    MIN_MAX_AGE_DAYS,
    MAX_MAX_AGE_DAYS,
    defaultKeepRuns,
    report,
  );
  return {
    keepRuns: keepRuns ?? defaultKeepRuns,
    maxAgeMs: maxAgeDays === undefined ? null : maxAgeDays * DAY_MS,
  };
}

/** One retention number: in range, or ignored with an error naming it (15.13). */
function boundedSetting(
  value: unknown,
  name: 'keepRuns' | 'maxAgeDays',
  min: number,
  max: number,
  defaultKeepRuns: number,
  report: (message: string) => void,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) {
    return value;
  }
  report(
    `Ignoring retention.${name}=${JSON.stringify(value)}: it must be an integer between ${min} and ` +
      `${max}. Applying the host default of ${defaultKeepRuns} runs instead.`,
  );
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow-level notifications (Requirements 13.7, 13.10)
// ─────────────────────────────────────────────────────────────────────────────

/** Delivery attempts per workflow notification (Requirement 13.7). */
export const NOTIFY_MAX_ATTEMPTS = 3;
/** Per-attempt delivery timeout, matching the engine's `notify` node (13.2). */
export const NOTIFY_TIMEOUT_MS = 30_000;
/** Longest reason text carried in a notification body. */
export const NOTIFY_DETAIL_CHARS = 512;

/** The run events a workflow notification policy can subscribe to (13.7). */
const NOTIFY_TRIGGER_BY_EVENT: Readonly<Record<string, NotifyTrigger>> = {
  'run-failed': 'failure',
  'run-completed': 'completion',
  'assert-breached': 'guard-breach',
};

/**
 * The trigger this event would fire, or undefined for an event no policy can
 * subscribe to (Requirement 13.7).
 */
export function notificationTriggerFor(event: RunEvent): NotifyTrigger | undefined {
  return NOTIFY_TRIGGER_BY_EVENT[event.type];
}

/**
 * True when `policy` subscribes to `trigger`. An absent policy, an absent `on`
 * list and a list that does not name the trigger all mean no notification and no
 * outbound request (Requirement 13.10).
 */
export function notificationWanted(
  policy: WorkflowNotificationPolicy | undefined,
  trigger: NotifyTrigger,
): policy is WorkflowNotificationPolicy {
  return !!policy && Array.isArray(policy.on) && policy.on.includes(trigger);
}

/**
 * Where a workflow notification is posted: the policy's own `to` when it is an
 * http(s) target, otherwise the connection's declared endpoint (`notifyUrl`, or
 * `baseUrl` joined with `notifyPath`).
 *
 * That is exactly the non-secret config the engine's `notify` node reads, so a
 * workflow policy and a `notify` node pointed at one provider agree on the
 * address. Empty when neither source declares one — the caller then issues no
 * request at all.
 */
export function notificationEndpoint(to: string, conn: ResolvedConnection | undefined): string {
  const target = to.trim();
  if (/^https?:\/\//i.test(target)) return target;
  const config = conn?.config ?? {};
  const explicit = (config['notifyUrl'] ?? '').trim();
  if (explicit.length > 0) return explicit;
  const baseUrl = (config['baseUrl'] ?? '').trim();
  if (baseUrl.length === 0) return '';
  const path = (config['notifyPath'] ?? '').trim();
  if (path.length === 0) return baseUrl;
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * The reason text a notification carries: metadata and messages only.
 *
 * A completion notice deliberately does NOT carry the run output — the run
 * record holds what the run produced, and a notification target is not a place
 * to put a payload.
 */
export function notificationDetail(event: RunEvent): string {
  switch (event.type) {
    case 'run-failed':
      return event.error;
    case 'assert-breached':
      return `${event.nodeName}: ${event.assertion} — ${event.message} (${event.severity})`;
    case 'run-completed':
      return 'Run completed.';
    default:
      return event.type;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Who settled a gate (multi-organisation Requirement 10.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three suspension kinds a member can settle, as the maps `WorkflowAgent`
 * holds them in: an approval, an Ask-User question, and a Wait-for-Event.
 *
 * Named tokens rather than the map objects themselves, because the identity a
 * gate is settled BY differs per kind - an approval and a question are keyed on
 * the engine's `requestId`, a wait on the author's correlation key - and a single
 * flat map would attribute a correlation key that happened to equal a request id
 * to the wrong gate.
 */
export type GateKind = 'approval' | 'question' | 'event';

/** The map key an acting user id is remembered under. */
export function gateActorKey(kind: GateKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * The gate key this event SETTLES, or null when the event is not a gate outcome.
 *
 * Derived from the event rather than recorded beside the resolver, because the
 * resolver is deleted from its map at settle time and the engine emits the
 * resolved event afterwards - so by the time there is an outcome to attribute,
 * the entry that held the metadata is gone.
 */
export function resolvedGateKey(event: RunEvent): string | null {
  switch (event.type) {
    case 'approval-resolved':
      return gateActorKey('approval', event.requestId);
    case 'ask-resolved':
      return gateActorKey('question', event.requestId);
    case 'wait-resolved':
      return gateActorKey('event', event.correlationKey);
    default:
      return null;
  }
}

/**
 * Stamps the acting user id onto a resolved gate event, CONSUMING the entry.
 *
 * A reducer over the pending-actor map rather than a pure read, and consuming is
 * the load-bearing half: a `requestId` is derived from the journal key plus the
 * node occurrence, so the same gate reached twice in one run - a loop, a retried
 * sub-workflow frame - produces the same key, and an entry left behind would
 * attribute the SECOND outcome to whoever answered the FIRST.
 *
 * Returns the event UNCHANGED (same object) when there is nothing to stamp, which
 * is every event on a BYO worker with an open endpoint, every scheduled or webhook
 * run that resolved a gate through no human at all, and every gate abandoned by
 * `drainPendingGates`. An absent `actor` therefore means "nobody is recorded",
 * never "recorded as nobody".
 */
export function attributeGateActor(event: RunEvent, actors: Map<string, string>): RunEvent {
  if (actors.size === 0) return event;
  // Narrowed by a switch rather than by the key lookup, because only these three
  // members of the union declare `actor` - spreading the whole union and adding the
  // field is not assignable back to `RunEvent`, which is the type system saying
  // exactly the right thing.
  switch (event.type) {
    case 'approval-resolved':
    case 'ask-resolved':
    case 'wait-resolved': {
      const key = resolvedGateKey(event);
      if (key === null) return event;
      const actor = actors.get(key);
      if (actor === undefined) return event;
      actors.delete(key);
      return { ...event, actor };
    }
    default:
      return event;
  }
}
