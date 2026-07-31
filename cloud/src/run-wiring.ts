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
