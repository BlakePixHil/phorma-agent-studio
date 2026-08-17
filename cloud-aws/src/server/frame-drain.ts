/**
 * The Frame_Inbox drain: inbound ControlFrames from Run_Table to the Runner.
 *
 * The Monitor_API `$default` integration writes every frame a Studio client
 * sends straight into the workflow partition as
 * `frame#{arrivedAtMs}#{connectionId}#{n}`, with the raw text in `body`. No
 * Lambda sits in that path, so this drain is what moves a frame from the table
 * into the running graph. Server_Entry calls it on `FRAME_DRAIN_INTERVAL_MS`
 * (500 ms), inside the 1000 ms ceiling of Req 7.7.
 *
 * Ordering is a property of the sort key, not of this module: `keys.ts frameSk`
 * zero-pads `arrivedAtMs` to 13 digits AHEAD of the connection id and the
 * counter, so lexicographic order equals arrival order and a plain ascending
 * prefix `Query` is already correctly ordered. Nothing here re-sorts by a
 * parsed timestamp - doing so would reorder frames whose stored key says
 * otherwise, which is exactly what Req 7.7 forbids.
 *
 * Deleting a frame is a run-scoped Run_Table write, so it is fenced like every
 * other one: `lease.fencedDeletes(...)` -> `compileTransact(...)` ->
 * `table.transactWrite(...)`, with the lease `ConditionCheck` asserting
 * `fence = :mine` (Req 2.5). A Zombie Runner therefore cannot consume the inbox
 * out from under the Runner that actually holds the lease.
 *
 * Routing stays with the Runner. `runner.ts` calls `routeFrame` against its
 * LIVE pending approvals, questions and waits the moment it takes a frame, so
 * pre-routing here against a stale snapshot could drop an approval that arrives
 * a tick before its suspension registers. What this module does use `routeFrame`
 * for is the one decision that needs no snapshot: a frame that routes to
 * `ignore` for every possible pending state (an `event` with a blank
 * correlationKey) can never do anything, so it is deleted and not delivered.
 *
 * Feature: aws-byo-deploy
 * Requirements: 7.7
 */

import type { ControlFrame, PendingSuspensions } from '../core/frames.js';
import { parseFrame, routeFrame } from '../core/frames.js';
import type { HeldLease } from '../core/host-contract.js';
import { pk } from '../core/keys.js';
import { fencedDeletes } from '../core/lease.js';
import type { ItemKey } from '../core/table-ops.js';
import type { DocumentTableClient } from '../aws/ports.js';
import { compileTransact } from '../aws/table-ops-compile.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The sort-key prefix every Frame_Inbox item shares - the literal head of
 * `keys.ts frameSk`, which is the single derivation site for the rest of the
 * key. Stated the same way `run-table.ts` states `journal#` and `event#`.
 */
const FRAME_SK_PREFIX = 'frame#';

/** Items per `Query` page. Frames are small; this bounds one drain's memory. */
const FRAME_PAGE_SIZE = 100;

/**
 * Deletes per fenced transaction. One slot of the transaction is the lease
 * `ConditionCheck` and DynamoDB caps a transaction at 100 items, exactly as
 * `run-table.ts` chunks its own fenced deletes.
 */
const FENCED_DELETE_CHUNK = 24;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface DrainDeps {
  /** Run_Table access. The production client, or the fake in tests. */
  table: DocumentTableClient;
  /** The Run_Table name - `PHORMA_RUN_TABLE` on the task definition. */
  tableName: string;
  /**
   * The lease the Runner currently holds, or undefined when no run is active.
   * Read through a function so the drain always sees the current fence rather
   * than a value captured when the interval was created.
   */
  lease: () => HeldLease | undefined;
  /** Hand one frame to the Runner, which routes it against its live state. */
  deliver(frame: ControlFrame): void;
}

// ---------------------------------------------------------------------------
// Inert frames
// ---------------------------------------------------------------------------

/**
 * True when `routeFrame` answers `ignore` no matter what the Runner has
 * pending, so delivering the frame could not change anything.
 *
 * The probe is the most generous pending state the frame could ever meet: its
 * own ids, already registered. If `routeFrame` still ignores it, no later state
 * would route it either. This asks `frames.ts` rather than restating its rules,
 * so the two cannot drift.
 */
function isInert(frame: ControlFrame): boolean {
  const mostGenerous: PendingSuspensions = {
    approvals: new Set(frame.type === 'approval' ? [frame.requestId] : []),
    questions: new Set(frame.type === 'question' ? [frame.requestId] : []),
    waits: new Set(frame.type === 'event' ? [frame.correlationKey?.trim() ?? ''] : []),
  };
  return routeFrame(frame, mostGenerous).action === 'ignore';
}

/**
 * Read the raw frame text off a stored item. The `$default` integration writes
 * it as `body`; anything else is treated as unparseable, which `parseFrame`
 * already answers with `undefined`.
 */
function bodyOf(item: Record<string, unknown>): string {
  const body = item['body'];
  return typeof body === 'string' ? body : '';
}

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------

/**
 * Drain the Frame_Inbox for the workflow whose lease is currently held.
 *
 * Does nothing and returns 0 while no lease is held: with no run active there
 * is no Runner to deliver to, and no fence to write under. Otherwise every page
 * of `pk = wf#{workflowId}` with `begins_with(sk, 'frame#')` is read in
 * ascending key order, so a large backlog drains completely in one call.
 *
 * Each item is parsed with `parseFrame`, delivered to the Runner unless it is
 * unparseable or inert, and then deleted through the fenced transact path -
 * including the unparseable ones, so a malformed frame is consumed once and
 * never retried (Req 7.15).
 *
 * @returns the number of items removed from the inbox, parseable or not.
 */
export async function drainFrameInbox(deps: DrainDeps): Promise<number> {
  const lease = deps.lease();
  if (!lease) return 0;

  const partition = pk(lease.workflowId);
  let drained = 0;
  let startKey: Record<string, unknown> | undefined;

  do {
    const page = await deps.table.query({
      TableName: deps.tableName,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':pk': partition, ':prefix': FRAME_SK_PREFIX },
      Limit: FRAME_PAGE_SIZE,
      ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
    });

    // The page arrives in ascending sort-key order, which IS arrival order.
    const keys: ItemKey[] = [];
    for (const raw of page.Items ?? []) {
      const item = raw as Record<string, unknown>;
      const sk = item['sk'];
      if (typeof sk !== 'string') continue;
      keys.push({ pk: partition, sk });

      const frame = parseFrame(bodyOf(item));
      if (frame && !isInert(frame)) {
        deps.deliver(frame);
      }
    }

    // Deleted after delivery, so a failed delete never loses a frame the
    // Runner has not seen. A fence mismatch rejects the transaction, which is
    // the zombie case and is meant to throw.
    await deleteFrames(deps, lease, keys);
    drained += keys.length;

    startKey = page.LastEvaluatedKey;
  } while (startKey !== undefined);

  return drained;
}

/** Delete the drained keys as fenced transactions, chunked to fit the cap. */
async function deleteFrames(deps: DrainDeps, lease: HeldLease, keys: ItemKey[]): Promise<void> {
  for (let i = 0; i < keys.length; i += FENCED_DELETE_CHUNK) {
    const chunk = keys.slice(i, i + FENCED_DELETE_CHUNK);
    await deps.table.transactWrite(
      compileTransact(deps.tableName, fencedDeletes(lease, chunk).request),
    );
  }
}
