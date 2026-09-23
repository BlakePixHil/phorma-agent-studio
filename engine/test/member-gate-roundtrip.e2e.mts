/**
 * The gate round trip a MEMBER drives, and the identity it leaves behind
 * (multi-organisation Requirements 10.2, 10.4, 10.5; task 9).
 *
 * Three suspensions in one run - an approval, an Ask-User question and a
 * Wait-for-Event - each settled OUT OF BAND, the way the deployed runtime settles
 * them: the host parks a resolver, a later request from an authenticated member
 * settles it, and the run resumes. That is the shape `WorkflowAgent` has
 * (`approvals` / `questions` / `waits` plus `POST /approvals`, `/questions`,
 * `/events`), reproduced here with no worker, no Durable Object and no network.
 *
 * What it pins:
 *  - RunEvents remain the ONLY contract. A member's run emits exactly the
 *    `*-required` / `*-resolved` pairs a builder's does, in order, and the run
 *    completes with the merged payload.
 *  - A host-supplied `actor` on a resolved gate survives `createRunRecorder`, so
 *    the acting member reaches run history through the RECORDER rather than a
 *    table of its own (Requirement 10.5, Property 20).
 *  - The three gates are attributed INDEPENDENTLY: two members answering two
 *    gates in one run are not folded into one.
 *  - An unattributed gate leaves `actor` ABSENT - "nobody is recorded" stays
 *    distinguishable from "recorded as nobody", which is every local run and every
 *    gate no human settled.
 *
 * The worker's own decision about WHICH pending gate an outcome belongs to lives
 * in `cloud/src/run-wiring.ts` (`resolvedGateKey`, `attributeGateActor`) and is
 * driven by `cloud/test/run-wiring.test.mjs`. This script deliberately does not
 * import it: the engine has no dependency on `cloud/`, and what is under test here
 * is the round trip plus the record, not the worker's key derivation.
 *
 * Run: npx -y tsx engine/test/member-gate-roundtrip.e2e.mts
 */
import { createRunRecorder, startRun } from '../src/index.js';
import type { RunEvent, RunLogEvent, WorkflowGraph } from '../src/index.js';

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

// ── Graph helpers (same shape as flow-primitives.e2e.mts) ────────────────────

function node(
  id: string,
  kind: string,
  ports: { id: string; name: string; role: 'message-in' | 'message-out' | 'tools' }[],
  data: object = {},
) {
  return { id, name: id, kind, category: 'flow', icon: '', position: { x: 0, y: 0 }, ports, data };
}
function edge(id: string, fromPort: string, toPort: string) {
  return { id, outputId: `${fromPort}-out`, inputId: `${toPort}-in`, kind: 'handoff' as const };
}

/** trigger -> approval gate -> ask user -> wait for event. */
function gateGraph(): WorkflowGraph {
  return {
    nodes: [
      node('trig', 'manual-trigger', [{ id: 'trig-start', name: 'Start', role: 'message-out' }]),
      node(
        'gate',
        'approval-gate',
        [
          { id: 'gate-in', name: 'In', role: 'message-in' },
          { id: 'gate-yes', name: 'Approved', role: 'message-out' },
          { id: 'gate-no', name: 'Rejected', role: 'message-out' },
        ],
        { message: 'Post the journal?' },
      ),
      node(
        'ask',
        'ask-user',
        [
          { id: 'ask-in', name: 'In', role: 'message-in' },
          { id: 'ask-out', name: 'Answered', role: 'message-out' },
        ],
        { question: 'Which period?', responseKey: 'period' },
      ),
      node(
        'wait',
        'wait-event',
        [
          { id: 'wait-in', name: 'In', role: 'message-in' },
          { id: 'wait-out', name: 'Resumed', role: 'message-out' },
        ],
        { correlationKey: 'signed:{{jobId}}' },
      ),
    ],
    connections: [
      edge('e1', 'trig-start', 'gate-in'),
      edge('e2', 'gate-yes', 'ask-in'),
      edge('e3', 'ask-out', 'wait-in'),
    ],
  };
}

/**
 * A stand-in for the deployed host: parks every gate, lets a named member settle
 * one later, and stamps that member onto the outcome event on its way out.
 *
 * `attribute` is the three lines `WorkflowAgent`'s emit tee spends on this, NOT a
 * copy of its key derivation - the map here is keyed by the engine's own
 * `requestId` / correlation key, so nothing about the worker's `kind:id` scheme is
 * restated (and therefore nothing about it can pass vacuously).
 */
function memberHost() {
  const approvals = new Map<string, (approved: boolean) => void>();
  const questions = new Map<string, (response: string) => void>();
  const waits = new Map<string, (payload: string) => void>();
  /** requestId or correlation key -> the member who settled it. */
  const actors = new Map<string, string>();

  return {
    approvals,
    questions,
    waits,
    /** What an authenticated settle request does, in one call. */
    settleApproval(requestId: string, approved: boolean, userId?: string) {
      if (userId) actors.set(requestId, userId);
      approvals.get(requestId)?.(approved);
      approvals.delete(requestId);
    },
    settleQuestion(requestId: string, response: string, userId?: string) {
      if (userId) actors.set(requestId, userId);
      questions.get(requestId)?.(response);
      questions.delete(requestId);
    },
    settleEvent(correlationKey: string, payload: string, userId?: string) {
      if (userId) actors.set(correlationKey, userId);
      waits.get(correlationKey)?.(payload);
      waits.delete(correlationKey);
    },
    /** The emit-tee stamp: the acting id joins the outcome, or nothing does. */
    attribute(event: RunEvent): RunEvent {
      if (event.type === 'approval-resolved' || event.type === 'ask-resolved') {
        const actor = actors.get(event.requestId);
        return actor ? { ...event, actor } : event;
      }
      if (event.type === 'wait-resolved') {
        const actor = actors.get(event.correlationKey);
        return actor ? { ...event, actor } : event;
      }
      return event;
    },
  };
}

/** Awaits a condition the run reaches on its own microtask turns. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/**
 * Drives one whole run through the three gates.
 *
 * `actingIds` names who settles each gate; an absent entry settles it with no
 * identity at all, which is the local-host and machine-settled case.
 */
async function driveRun(
  runId: string,
  actingIds: { approval?: string; question?: string; event?: string },
): Promise<{ events: RunEvent[]; log: RunLogEvent[]; output: string | undefined }> {
  const graph = gateGraph();
  const host = memberHost();
  const events: RunEvent[] = [];
  const recorder = createRunRecorder({
    runId,
    workflowId: 'wf-org-ias',
    workflowName: 'IAS lodgement',
    source: 'manual',
    environment: 'cloud',
    graph,
  });

  const handle = startRun({
    runId,
    graph,
    input: JSON.stringify({ jobId: 'J42' }),
    model: {
      stream: async function* () {
        throw new Error('no model needed');
      },
    } as never,
    emit: raw => {
      const event = host.attribute(raw);
      events.push(event);
      recorder.record(event);
    },
    requestApproval: (_nodeId, _message, _payload, requestId) =>
      new Promise<boolean>(resolve => host.approvals.set(requestId, resolve)),
    requestInput: (_nodeId, _question, _payload, requestId) =>
      new Promise<string>(resolve => host.questions.set(requestId, resolve)),
    waitForEvent: (_nodeId, correlationKey) =>
      new Promise<string>(resolve => host.waits.set(correlationKey, resolve)),
  });

  await until(() => host.approvals.size === 1, 'the approval gate to suspend');
  host.settleApproval([...host.approvals.keys()][0], true, actingIds.approval);

  await until(() => host.questions.size === 1, 'the Ask-User gate to suspend');
  host.settleQuestion([...host.questions.keys()][0], 'Q1 FY26', actingIds.question);

  await until(() => host.waits.size === 1, 'the wait to suspend');
  host.settleEvent([...host.waits.keys()][0], '{"signed":true}', actingIds.event);

  await handle.done;

  const completed = events.find(event => event.type === 'run-completed');
  return {
    events,
    log: recorder.snapshot().events,
    output: completed?.type === 'run-completed' ? completed.output : undefined,
  };
}

// ── The round trip ──────────────────────────────────────────────────────────

console.log('\nMember gate round trip');
const attributed = await driveRun('cloudrun-member-1', {
  approval: 'user_operator_ada',
  question: 'user_operator_ada',
  event: 'user_editor_grace',
});

{
  const types = attributed.events.map(event => event.type);
  const order = [
    'approval-required',
    'approval-resolved',
    'ask-required',
    'ask-resolved',
    'wait-started',
    'wait-resolved',
  ];
  const seen = types.filter(type => order.includes(type));
  check(
    'each gate suspended and resumed, in order, with no extra pair',
    JSON.stringify(seen) === JSON.stringify(order),
    JSON.stringify(seen),
  );
  check('the run completed after the third gate', attributed.output !== undefined);

  const merged = JSON.parse(attributed.output ?? '{}') as {
    jobId?: string;
    period?: string;
    signed?: boolean;
  };
  check(
    'every gate folded its answer into the payload',
    merged.jobId === 'J42' && merged.period === 'Q1 FY26' && merged.signed === true,
    attributed.output,
  );
}

// ── Requirement 10.5: the acting id rides the outcome ───────────────────────

console.log('\nThe acting member on the outcome');
{
  const approval = attributed.events.find(event => event.type === 'approval-resolved');
  const ask = attributed.events.find(event => event.type === 'ask-resolved');
  const wait = attributed.events.find(event => event.type === 'wait-resolved');

  check(
    'the approval outcome names who approved, beside the outcome itself',
    approval?.type === 'approval-resolved' &&
      approval.approved === true &&
      approval.actor === 'user_operator_ada',
    JSON.stringify(approval),
  );
  check(
    'the answered question names who answered',
    ask?.type === 'ask-resolved' && ask.actor === 'user_operator_ada',
    JSON.stringify(ask),
  );
  check(
    'the delivered event names a DIFFERENT member, so the three are not folded',
    wait?.type === 'wait-resolved' && wait.actor === 'user_editor_grace',
    JSON.stringify(wait),
  );
}

// ── Property 20: the run's history carries it ──────────────────────────────

console.log('\nRun history carries the actor');
{
  const logged = attributed.log.filter(
    event =>
      event.type === 'approval-resolved' ||
      event.type === 'ask-resolved' ||
      event.type === 'wait-resolved',
  );
  check('all three outcomes are in the persisted log', logged.length === 3, String(logged.length));
  check(
    'each persisted outcome carries the same actor the live event did',
    logged.every(event => 'actor' in event && typeof event.actor === 'string') &&
      logged.map(event => ('actor' in event ? event.actor : null)).join(',') ===
        'user_operator_ada,user_operator_ada,user_editor_grace',
    JSON.stringify(logged.map(event => ('actor' in event ? event.actor : null))),
  );
  check(
    'the record is JSON-safe, so the actor survives persistence verbatim',
    JSON.parse(JSON.stringify(attributed.log)).filter(
      (event: { actor?: string }) => event.actor === 'user_editor_grace',
    ).length === 1,
  );
}

// ── An unattributed gate stays unattributed ────────────────────────────────

console.log('\nAn unattributed gate');
const anonymous = await driveRun('cloudrun-member-2', {});
{
  const outcomes = anonymous.events.filter(
    event =>
      event.type === 'approval-resolved' ||
      event.type === 'ask-resolved' ||
      event.type === 'wait-resolved',
  );
  check('the same three outcomes fire', outcomes.length === 3, String(outcomes.length));
  check(
    'no outcome carries an actor at all - absent, never an empty string',
    outcomes.every(event => !('actor' in event) || event.actor === undefined),
    JSON.stringify(outcomes),
  );
  check(
    'and the persisted log has no `actor` key to mistake for one',
    !JSON.stringify(anonymous.log).includes('"actor"'),
  );
  check('the run still completed', anonymous.output !== undefined);
}

console.log(
  failures === 0
    ? '\nAll member gate round-trip checks passed.\n'
    : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
