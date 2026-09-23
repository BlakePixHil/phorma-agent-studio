/**
 * `GET /api/notifications` - what has happened, and what is waiting, across
 * every workflow deployed in this account.
 *
 * ## Why this route exists
 *
 * A deployed workflow can fail, or suspend on a human approval, with nobody
 * finding out. The only real-time channel is the monitor WebSocket, and that is
 * one socket attached to one workflow - the one the user happens to have open -
 * with an in-memory replay buffer holding the CURRENT run only. So a cron run
 * that failed at 3am, or an approval gate a run has been sitting on since
 * yesterday, is discoverable solely by opening that workflow and reading its
 * Runs panel. This route is the account-wide answer to "is anything wrong, and
 * is anything waiting on me".
 *
 * ## Why it is a fan-out and not a feed
 *
 * There is deliberately NO durable per-owner event stream behind this. The
 * facts already exist, spread across the account:
 *
 *  - `PortalIndex`'s `deploy:{ownerId}:` key space enumerates the deployments,
 *    and is the only enumeration possible, because a Durable Object namespace
 *    cannot be listed.
 *  - each `WorkflowAgent` persists its own settled runs to its embedded SQLite
 *    `runs` table, which is what makes "while the app was closed" work at all.
 *  - each `WorkflowAgent` holds its live pending gates in memory, which is the
 *    only place a pending approval exists.
 *
 * So this reads them, per tick, rather than adding a fourth Durable Object class
 * and a second write path for facts that are already written. The cost is
 * honest and bounded: one subrequest per deployment, capped at
 * {@link NOTIFY_FANOUT_MAX}.
 *
 * D1 is NOT consulted, and cannot be: the `usage` table carries
 * `cost_usd`/`tokens_*`/`duration_ms` and has no run OUTCOME column at all, so a
 * failure is not derivable from it. The Durable Objects are the only record of
 * what happened.
 *
 * ## Why the fan-out is RPC
 *
 * A worker-to-DO `stub.fetch()` carries no `Authorization` header and would trip
 * `WorkflowAgent.authorized()`. RPC is already how this worker makes internal
 * calls into an instance (`purgeSelf`, `startPortalTurn`, `answerPortalQuestion`),
 * and it means no new HTTP route on the DO and no new route-table entry in the
 * studio. Authorization happens here, once, against the verified identity - and
 * the instance names come from the owner-scoped registry prefix, so isolation is
 * structural rather than a filter. The instance re-checks anyway.
 *
 * ## Two placement decisions, both copied from `/api/deployments`
 *
 * Mounted ABOVE the `store.enabled` gate, because the registry lives in a
 * Durable Object a BYO worker binds too, and a BYO owner has deployments that
 * can fail exactly like a hosted one's.
 *
 * NOT subscription-gated on the worker. The STUDIO gates polling on an active
 * subscription, which is where the product decision belongs; refusing here would
 * additionally hide a cron deployment's failures from a lapsed subscriber who is
 * still being billed for it.
 */

import { verifyRequest, isHosted, type AuthEnv } from './auth';
import { applyImpersonation, type Impersonation } from './impersonation';
import {
  deploymentOwner,
  portalIndex,
  workflowAgentInstance,
  type DeploymentRecord,
  type PortalRegistryEnv,
} from './portal-registry';
import { ProposalStore, type ProposalNotice } from './proposals';
import type { TenantEnv } from './tenants';

/** The one path this module answers. */
export const NOTIFICATIONS_PATH = '/api/notifications';

/**
 * How many deployments one request will ask.
 *
 * Each one is a subrequest, and Cloudflare's per-request subrequest ceiling is
 * 50 on the free plan and 1000 on paid - so 40 keeps a single tick inside BOTH,
 * with headroom for the registry read. An account past the cap gets its
 * most-recently-updated deployments and `truncated: true`, never a silent
 * half-answer: the studio renders that as a stated limit.
 *
 * This is a real ceiling rather than a solution. The fix, if accounts grow past
 * it, is a durable per-owner feed - not a bigger number.
 */
export const NOTIFY_FANOUT_MAX = 40;

/** Settled runs one deployment reports per tick, newest first. */
export const NOTICE_RUNS_PER_DEPLOYMENT = 20;

/**
 * How a settled run ended.
 *
 * The three terminal `RunRecordStatus` values. A run still in flight is absent
 * rather than reported with a `running` status: "this run is going" is not a
 * notification, and a run that never settled because its instance was evicted
 * would otherwise be announced forever.
 */
export type NoticeRunStatus = 'completed' | 'failed' | 'stopped';

/** One settled run, as a notification needs it. */
export interface NoticeRun {
  runId: string;
  status: NoticeRunStatus;
  /**
   * The engine's `RunSource` - `schedule` is the case that matters most here,
   * because it is the one nobody was watching.
   *
   * Typed `string` and not the union, for the reason `RunFailureCode` is: a
   * deployed worker is routinely a different version than the studio reading it,
   * and a source added to the engine tomorrow must be CARRIABLE by a studio
   * built today. Consumers branch with a default.
   */
  source: string;
  startedAt: number;
  endedAt: number;
  /** Failure message. Present only when `status` is `failed`. */
  error?: string;
  /**
   * The append-only entitlement refusal token, when the failure was one - read
   * from the run's terminal event, so the studio can pick the right billing call
   * to action without matching prose. Absent on every other failure.
   */
  code?: string;
}

/** Which kind of human-in-the-loop gate a run is suspended on. */
export type NoticePendingKind = 'approval' | 'question' | 'wait';

/**
 * What a suspended gate is waiting for, beyond its resolver.
 *
 * The engine hands `nodeId`, the prompt text and the payload to every
 * `requestApproval` / `requestInput` / `waitForEvent` callback, and `WorkflowAgent`
 * used to discard all three. That made a pending gate describable ONLY to a
 * monitor which happened to be attached when the `approval-required` event went
 * past, because `GET /status` could report correlation KEYS and nothing else - so
 * "something is waiting on you" was unanswerable for any client that connected
 * late, which is every client after an app restart.
 */
export interface PendingGateMeta {
  /** Display metadata only - never an identity to key a map on. */
  nodeId: string;
  /** The authored node name, or the id when the node is not in the root graph. */
  nodeName: string;
  /** The gate's own prompt text. */
  message: string;
  /**
   * True when the gate carries context worth opening the run to read.
   *
   * The payload itself is deliberately NOT here. A notification feed is an
   * account-wide surface and a run payload is arbitrary customer data; this flag
   * is what lets the studio decide between an inline Approve/Reject and sending
   * the user to the run, without copying any of it.
   */
  hasPayload: boolean;
  runId: string;
  /** Epoch ms the gate started waiting. */
  since: number;
}

/**
 * One gate waiting on a human, right now.
 *
 * This is LIVE state, not history: it comes from the instance's in-memory
 * resolver maps, so it disappears if the Durable Object is evicted and reappears
 * when the resumed run re-registers the gate. A consumer must treat a pending
 * entry as a snapshot that can vanish, never as a durable record.
 */
export interface NoticePending extends PendingGateMeta {
  kind: NoticePendingKind;
  /** `requestId` for an approval or question; the correlation key for a wait. */
  id: string;
}

/**
 * A gate's payload is "worth opening the run for" when it carries anything
 * beyond emptiness.
 *
 * Stated once, here, because it decides whether the studio offers an inline
 * Approve/Reject or sends the user to the run to read the context first - and a
 * per-call-site guess would drift between the three gate kinds.
 */
export function payloadIsSubstantive(payload: unknown): boolean {
  if (typeof payload !== 'string') return payload !== null && payload !== undefined;
  const trimmed = payload.trim();
  // `''`, `'{}'`, `'null'` and `'""'` are all what an unset payload serializes
  // to somewhere on the path, and none of them is context a human needs.
  return trimmed.length > 0 && trimmed !== '{}' && trimmed !== 'null' && trimmed !== '""';
}

/**
 * A recorded run's status as a notification reports it, or null when the run is
 * not an OUTCOME.
 *
 * `running` is not an outcome: it means either a live run, or an instance evicted
 * mid-run that never resumed, and announcing the latter as news every tick
 * forever is worse than saying nothing. Neither is `skipped`, which describes a
 * run the recorder never executed - a notification is a claim that something
 * happened.
 *
 * Typed against `string` rather than the engine's `RunRecordStatus` so this
 * module stays free of engine imports and a status added later fails closed
 * (unreported) instead of failing to compile in the worker.
 */
export function terminalNoticeStatus(status: string): NoticeRunStatus | null {
  return status === 'completed' || status === 'failed' || status === 'stopped' ? status : null;
}

/** The subset of a `RunRecordSummary` the projection reads. */
export interface ProjectableRunSummary {
  id: string;
  status: string;
  source: string;
  startedAt: number;
  endedAt?: number;
  error?: string;
}

/**
 * Projects one recorded run, or null when it should not be reported.
 *
 * The cursor is compared against when the run ENDED, not when it started, and
 * that is the whole subtlety of this function: a run that began before the cursor
 * and failed after it is exactly the notification somebody is waiting for, and a
 * `started_at > cursor` filter drops it silently. A run with no `endedAt` has not
 * settled, whatever its status column claims.
 */
export function projectSettledRun(
  summary: ProjectableRunSummary,
  cursor: number,
): NoticeRun | null {
  const status = terminalNoticeStatus(summary.status);
  if (!status) return null;
  const endedAt = summary.endedAt;
  if (typeof endedAt !== 'number' || endedAt <= cursor) return null;
  return {
    runId: summary.id,
    status,
    source: summary.source,
    startedAt: summary.startedAt,
    endedAt,
    // Only a failure carries a message, and an explicit `error: undefined` would
    // serialize as a present-but-null field.
    ...(status === 'failed' && summary.error ? { error: summary.error } : {}),
  };
}

/** Everything one deployment has to report. */
export interface DeploymentNotice {
  workflowId: string;
  workflowName: string;
  /** Runs that settled after the caller's cursor, newest first. */
  runs: NoticeRun[];
  /** Gates waiting on a human right now. */
  pending: NoticePending[];
  /**
   * Operator-facing problems collected on this instance: a schedule the tier cap
   * refused to arm, an undelivered workflow notification, a rejected redaction
   * rule. Already surfaced on `GET /status`; repeated here so the account-wide
   * view does not need a second round trip per deployment to find them.
   */
  issues: string[];
}

/**
 * What an instance returns for itself, identity excluded.
 *
 * The aggregator supplies `workflowId` and `workflowName` from the registry
 * record it already holds, because an RPC-reached instance cannot read
 * `this.name` at all (partyserver only sets it for requests routed through
 * `routePartykitRequest`) and asking it to re-derive its own id from held state
 * would be a second, worse copy of `workflowKey()`.
 */
export type DeploymentNoticePayload = Omit<DeploymentNotice, 'workflowId' | 'workflowName'>;

/** `GET /api/notifications` body. */
export interface NotificationsResponse {
  /**
   * Server clock when this answer was assembled - the cursor for the next call.
   *
   * Taken from the SERVER rather than the client, so a machine with a skewed
   * clock cannot silently skip its own notifications.
   */
  at: number;
  /**
   * Deployments the fan-out could not reach, by workflow id.
   *
   * Named rather than dropped, for the reason `/api/deployments` returns null
   * spend rather than zero: "I could not ask this one" and "this one had nothing
   * to say" are different answers, and collapsing them turns an outage into a
   * clean bill of health.
   */
  unreachable: string[];
  /** True when the deployment list was longer than {@link NOTIFY_FANOUT_MAX}. */
  truncated: boolean;
  deployments: DeploymentNotice[];
  /**
   * The CALLER's own proposals that were published or rejected since the cursor
   * (multi-organisation-phorma, Requirement 12.11).
   *
   * ADDITIVE and OPTIONAL, which is what makes it safe on both sides of a version
   * gap: an older studio ignores it, and a BYO worker - which binds no D1 and has
   * no proposal queue - never sends it. Absent and empty mean the same thing to a
   * consumer, so neither has to be special-cased.
   *
   * This half is a D1 read rather than a fan-out, because the fact lives in D1:
   * `workflow_proposals` records who submitted a proposal and when its status last
   * moved, so it is one indexed query instead of one subrequest per deployment -
   * and it reports a decision about a workflow this account may no longer have
   * deployed at all.
   */
  proposals?: ProposalNotice[];
}

/** The RPC surface this route needs from an instance. */
interface NotifiableInstance {
  notificationsSince(ownerId: string, cursor: number): Promise<DeploymentNoticePayload>;
}

/**
 * Bindings this route needs.
 *
 * `TenantEnv` folds in the OPTIONAL `DB` binding, for the proposal-outcome half
 * alone. It stays optional: a BYO worker binds no D1, and the deployment fan-out -
 * which is what this route is for - must keep working there exactly as it does
 * today (Requirement 16.6).
 */
export type NotificationsEnv = AuthEnv &
  TenantEnv &
  PortalRegistryEnv & {
    WorkflowAgent: DurableObjectNamespace;
  };

/**
 * Answers `GET /api/notifications`, or null when the request is for another path.
 *
 * Returning null on a non-match keeps this consistent with the other route
 * modules, so `routeApiRequest` reads as one ordered list of `if (matched)
 * return it` branches.
 */
export async function handleNotificationsRequest(
  request: Request,
  env: NotificationsEnv,
  url: URL,
  respond: (body: unknown, status?: number) => Response,
  impersonation: Impersonation | null = null,
): Promise<Response | null> {
  if (url.pathname !== NOTIFICATIONS_PATH) return null;
  if (request.method !== 'GET') return respond({ error: 'Method not allowed.' }, 405);

  const verified = await verifyRequest(env, request);
  if (!verified) return respond({ error: 'Unauthorized.' }, 401);
  // The operator act-as owner, when the router resolved one - already allowlisted,
  // already restricted to a GET and already audited by `api.ts`, so this is a
  // SUBSTITUTION rather than a second decision (Requirement 14.5). The fan-out
  // below re-checks the substituted owner against each instance's stamp, so an
  // operator sees only what that owner really owns.
  const auth = applyImpersonation(verified, impersonation);
  // Hosted mode is per-tenant, so an anonymous identity has no account to read.
  // A BYO worker has ONE owner and answers for it.
  if (isHosted(env) && !auth.userId) return respond({ error: 'Unauthorized.' }, 401);
  if (!env.PortalIndex) {
    return respond({ error: 'This deployment has no deployment registry binding.' }, 501);
  }

  // Scoped by the RESOLVED owner off the VERIFIED identity, never by a request
  // field - which is what makes tenant isolation structural rather than a filter
  // somebody could forget to write.
  //
  // `auth.ownerId` and not `auth.userId` (multi-organisation-phorma,
  // Requirement 4.5): the registry prefix and the instance stamp are both the
  // resolved owner, so scoping by the caller would fan out over an EMPTY registry
  // prefix for every member of every organisation - a silent "nothing is wrong"
  // about deployments nobody looked at.
  const ownerId = deploymentOwner(auth.ownerId);
  const cursor = readCursor(url);

  const all = await portalIndex(env).listDeployments(ownerId);
  // `listDeployments` already sorts by `updatedAt` desc, so the cap keeps the
  // deployments most likely to have something to say.
  const selected = all.slice(0, NOTIFY_FANOUT_MAX);

  const unreachable: string[] = [];
  const deployments: DeploymentNotice[] = [];

  const settled = await Promise.allSettled(
    selected.map(record => askInstance(env, record, ownerId, cursor)),
  );
  for (let index = 0; index < settled.length; index += 1) {
    const outcome = settled[index];
    const record = selected[index];
    if (outcome.status === 'rejected') {
      // One unreachable instance must never blank the account's whole feed:
      // an eviction mid-fan-out, a transient RPC failure, or an instance
      // running an older worker with no such method all land here.
      unreachable.push(record.workflowId);
      continue;
    }
    const notice = outcome.value;
    // An instance with nothing to report is omitted rather than sent as three
    // empty arrays, so the response size tracks what actually happened.
    if (notice.runs.length === 0 && notice.pending.length === 0 && notice.issues.length === 0) {
      continue;
    }
    deployments.push({
      workflowId: record.workflowId,
      workflowName: record.workflowName,
      ...notice,
    });
  }

  return respond({
    at: Date.now(),
    unreachable,
    truncated: all.length > selected.length,
    deployments,
    ...(await proposalOutcomes(env, ownerId, auth.userId, cursor)),
  } satisfies NotificationsResponse);
}

/**
 * The caller's own decided proposals since the cursor, as a spreadable fragment
 * (Requirement 12.11).
 *
 * Three ways it contributes NOTHING, and all three are deliberate: no D1 binding
 * (a BYO worker), no caller identity (an anonymous BYO request), and no decided
 * row. A READ FAILURE also contributes nothing and logs, rather than failing the
 * whole request - the deployment feed is what this route exists for, and losing it
 * because a proposal query failed would trade the important half for the additive
 * one.
 */
async function proposalOutcomes(
  env: NotificationsEnv,
  ownerId: string,
  userId: string | null | undefined,
  cursor: number,
): Promise<{ proposals?: ProposalNotice[] }> {
  if (!userId) return {};
  const store = new ProposalStore(env);
  if (!store.enabled) return {};
  try {
    const proposals = await store.outcomesForAuthor(ownerId, userId, cursor);
    return proposals.length > 0 ? { proposals } : {};
  } catch (error) {
    console.error('Proposal outcome read failed for the notification feed:', error);
    return {};
  }
}

/**
 * The `since` query parameter as epoch ms.
 *
 * A missing, negative, non-numeric or non-finite value reads as 0, which asks
 * for everything the instance still retains. That is deliberately the SAFE
 * default: a first call, or a client whose stored cursor was lost, should
 * over-report and let the studio dedupe on notification identity, rather than
 * silently skip the window nobody has seen.
 */
function readCursor(url: URL): number {
  const raw = Number(url.searchParams.get('since') ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

/** One RPC call into one deployment's instance. */
async function askInstance(
  env: NotificationsEnv,
  record: DeploymentRecord,
  ownerId: string,
  cursor: number,
): Promise<DeploymentNoticePayload> {
  // Through `workflowAgentInstance`, never a hand-built string, and the reason is
  // not style. The gateway writes `encodeURIComponent('{owner}:{workflowId}')`
  // into the path and partyserver hashes that path segment WITHOUT decoding it,
  // so `idFromName('org_a:wf')` and `idFromName('org_a%3Awf')` are two DIFFERENT
  // Durable Objects. This function built the raw colon form, so in hosted mode
  // the whole fan-out addressed blank instances: every one answered successfully
  // with empty state, the feed read as "nothing has happened", and nothing logged
  // a thing. Fixed here; measured in `organisation-isolation.test.mjs` against the
  // real deploy bundle.
  //
  // `ownerId` is the `default` literal in BYO and instances there are named by the
  // bare workflow id with no prefix to encode, so null is passed rather than the
  // literal - exactly as `index.ts` routes them.
  const name = workflowAgentInstance(isHosted(env) ? ownerId : null, record.workflowId);
  const id = env.WorkflowAgent.idFromName(name);
  const stub = env.WorkflowAgent.get(id) as unknown as NotifiableInstance;
  return stub.notificationsSince(ownerId, cursor);
}
