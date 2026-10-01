/**
 * Worker run-path decisions (task 18.4, Requirements 13.7, 13.10, 15.12, 15.13).
 *
 * No worker, no Durable Object and no network: these are the pure decisions
 * `WorkflowAgent` acts on — how many runs a workflow keeps, whether an event
 * fires a notification at all, and where that notification is addressed.
 *
 * Run: npx -y tsx cloud/test/run-wiring.test.mjs
 */

import {
  MAX_KEEP_RUNS,
  MAX_MAX_AGE_DAYS,
  attributeGateActor,
  dataPathSettings,
  gateActorKey,
  notificationDetail,
  notificationEndpoint,
  notificationTriggerFor,
  notificationWanted,
  persistableJournalRow,
  JOURNAL_ROW_MAX_BYTES,
  resolveRunRetention,
  resolvedGateKey,
} from '../src/run-wiring.ts';

const DEFAULT_KEEP = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

// ── Retention overrides (15.12) ─────────────────────────────────────────────

console.log('\nRetention overrides');
{
  const absent = resolveRunRetention(undefined, DEFAULT_KEEP);
  check(
    'no policy keeps the host default and no age bound',
    absent.keepRuns === DEFAULT_KEEP && absent.maxAgeMs === null,
    JSON.stringify(absent),
  );

  const both = resolveRunRetention({ keepRuns: 5, maxAgeDays: 7 }, DEFAULT_KEEP);
  check(
    'in-range settings replace the default',
    both.keepRuns === 5 && both.maxAgeMs === 7 * DAY_MS,
    JSON.stringify(both),
  );

  const edges = resolveRunRetention({ keepRuns: MAX_KEEP_RUNS, maxAgeDays: MAX_MAX_AGE_DAYS }, DEFAULT_KEEP);
  check(
    'the range boundaries are accepted',
    edges.keepRuns === MAX_KEEP_RUNS && edges.maxAgeMs === MAX_MAX_AGE_DAYS * DAY_MS,
    JSON.stringify(edges),
  );
}

// ── Invalid retention is ignored AND reported (15.13) ───────────────────────

console.log('\nInvalid retention');
for (const [label, policy, expectAge] of [
  ['zero keepRuns', { keepRuns: 0 }, null],
  ['negative keepRuns', { keepRuns: -3 }, null],
  ['fractional keepRuns', { keepRuns: 2.5 }, null],
  ['over-range keepRuns', { keepRuns: MAX_KEEP_RUNS + 1 }, null],
  ['string keepRuns', { keepRuns: '10' }, null],
  ['over-range maxAgeDays', { maxAgeDays: MAX_MAX_AGE_DAYS + 1 }, null],
]) {
  const reported = [];
  const resolved = resolveRunRetention(policy, DEFAULT_KEEP, (message) => reported.push(message));
  const setting = Object.keys(policy)[0];
  check(
    `${label} falls back to the host default`,
    resolved.keepRuns === DEFAULT_KEEP && resolved.maxAgeMs === expectAge,
    JSON.stringify(resolved),
  );
  check(
    `${label} is reported naming the setting`,
    reported.length === 1 && reported[0].includes(`retention.${setting}`),
    JSON.stringify(reported),
  );
}

// ── Notification triggers (13.7, 13.10) ────────────────────────────────────

console.log('\nNotification triggers');
{
  const at = 1;
  const failed = { type: 'run-failed', runId: 'r1', error: 'boom', at };
  const completed = { type: 'run-completed', runId: 'r1', output: 'payload', at };
  const breached = {
    type: 'assert-breached',
    runId: 'r1',
    nodeId: 'n1',
    nodeName: 'Guard',
    assertion: 'rowCount > 0',
    message: 'No rows.',
    severity: 'error',
    routed: false,
    at,
  };

  check(
    'each terminal/guard event maps to its trigger',
    notificationTriggerFor(failed) === 'failure' &&
      notificationTriggerFor(completed) === 'completion' &&
      notificationTriggerFor(breached) === 'guard-breach',
  );
  check(
    'an unrelated event fires nothing',
    notificationTriggerFor({ type: 'node-started', runId: 'r1', nodeId: 'n1', nodeName: 'A', at }) ===
      undefined,
  );

  // Requirement 13.10: absent policy, absent `on`, and a non-matching `on`.
  check('no policy wants no notification', notificationWanted(undefined, 'failure') === false);
  check('policy without `on` wants nothing', notificationWanted({ to: 'https://h.test' }, 'failure') === false);
  check(
    'a policy only wants the triggers it names',
    notificationWanted({ on: ['completion'] }, 'failure') === false &&
      notificationWanted({ on: ['completion', 'failure'] }, 'failure') === true,
  );

  check('a failure carries its error text', notificationDetail(failed) === 'boom');
  check(
    'a breach names the node, the assertion and the severity',
    notificationDetail(breached).includes('Guard') &&
      notificationDetail(breached).includes('rowCount > 0') &&
      notificationDetail(breached).includes('error'),
  );
  check(
    'a completion carries no run output',
    notificationDetail(completed) === 'Run completed.' &&
      !notificationDetail(completed).includes('payload'),
  );
}

// ── Notification endpoint ──────────────────────────────────────────────────

console.log('\nNotification endpoint');
{
  const conn = (config) => ({
    id: 'conn-mail',
    type: 'http',
    config,
    secrets: {},
    auth: { mode: 'none' },
    allowWrites: false,
  });

  check(
    'an https `to` is the endpoint',
    notificationEndpoint('  https://hooks.test/abc  ', undefined) === 'https://hooks.test/abc',
  );
  check(
    'an email `to` falls back to the connection endpoint',
    notificationEndpoint('ops@example.com', conn({ notifyUrl: 'https://api.mailer.test/v1/send' })) ===
      'https://api.mailer.test/v1/send',
  );
  check(
    'baseUrl and notifyPath join with exactly one slash',
    notificationEndpoint('ops@example.com', conn({ baseUrl: 'https://api.mailer.test/', notifyPath: '/v1/send' })) ===
      'https://api.mailer.test/v1/send',
  );
  check(
    'baseUrl alone is the endpoint',
    notificationEndpoint('', conn({ baseUrl: 'https://api.mailer.test' })) === 'https://api.mailer.test',
  );
  check(
    'no target anywhere yields no endpoint (so no request is made)',
    notificationEndpoint('ops@example.com', conn({})) === '' &&
      notificationEndpoint('', undefined) === '',
  );
}

// ── Settings block reading ─────────────────────────────────────────────────

console.log('\nSettings');
{
  check('an absent spec reads as empty settings', Object.keys(dataPathSettings(null)).length === 0);
  check('an absent settings block reads as empty', Object.keys(dataPathSettings({})).length === 0);
  check(
    'a pushed retention block is read through',
    dataPathSettings({ settings: { retention: { keepRuns: 3 } } }).retention?.keepRuns === 3,
  );
}

// ── Who settled a gate (multi-organisation Requirement 10.5) ────────────────

console.log('\nGate attribution');
{
  const at = 7;
  const approvalResolved = (requestId, approved = true) => ({
    type: 'approval-resolved',
    runId: 'r1',
    requestId,
    nodeId: 'n1',
    approved,
    at,
  });
  const askResolved = (requestId) => ({
    type: 'ask-resolved',
    runId: 'r1',
    requestId,
    nodeId: 'n2',
    response: 'Q1 FY26',
    at,
  });
  const waitResolved = (correlationKey) => ({
    type: 'wait-resolved',
    runId: 'r1',
    nodeId: 'n3',
    correlationKey,
    eventPayload: '{"signed":true}',
    at,
  });

  // The key scheme. A bare id would attribute a correlation key that happens to
  // equal a request id to the wrong gate, which is the whole reason for the prefix.
  check(
    'each gate kind keys on its own identity',
    resolvedGateKey(approvalResolved('approval:x')) === gateActorKey('approval', 'approval:x') &&
      resolvedGateKey(askResolved('ask:x')) === gateActorKey('question', 'ask:x') &&
      resolvedGateKey(waitResolved('signed:J42')) === gateActorKey('event', 'signed:J42'),
  );
  check(
    'a correlation key equal to a request id is a DIFFERENT gate',
    resolvedGateKey(waitResolved('same')) !== resolvedGateKey(approvalResolved('same')),
  );
  check(
    'an event that settles no gate has no key',
    resolvedGateKey({ type: 'node-started', runId: 'r1', nodeId: 'n1', nodeName: 'A', at }) ===
      null &&
      resolvedGateKey({ type: 'approval-required', runId: 'r1', requestId: 'approval:x', nodeId: 'n1', message: 'm', payload: '', at }) ===
        null,
  );

  // Stamping.
  {
    const actors = new Map([[gateActorKey('approval', 'approval:x'), 'user_ada']]);
    const stamped = attributeGateActor(approvalResolved('approval:x', false), actors);
    check(
      'the acting id joins the outcome without disturbing it',
      stamped.actor === 'user_ada' &&
        stamped.approved === false &&
        stamped.type === 'approval-resolved' &&
        stamped.requestId === 'approval:x',
      JSON.stringify(stamped),
    );
    check('the entry is CONSUMED, so a repeated gate is not re-attributed', actors.size === 0);
    const again = attributeGateActor(approvalResolved('approval:x'), actors);
    check(
      'the second occurrence of the same request id is unattributed',
      again.actor === undefined,
      JSON.stringify(again),
    );
  }

  {
    const actors = new Map([
      [gateActorKey('approval', 'approval:x'), 'user_ada'],
      [gateActorKey('question', 'ask:x'), 'user_grace'],
      [gateActorKey('event', 'signed:J42'), 'user_omar'],
    ]);
    check(
      'three gates in one run are attributed independently',
      attributeGateActor(approvalResolved('approval:x'), actors).actor === 'user_ada' &&
        attributeGateActor(askResolved('ask:x'), actors).actor === 'user_grace' &&
        attributeGateActor(waitResolved('signed:J42'), actors).actor === 'user_omar',
    );
    check('and each consumed exactly its own entry', actors.size === 0);
  }

  // The absent cases. Every one of these returns the SAME OBJECT, which is what
  // keeps "nobody is recorded" byte-identical to the pre-feature event rather than
  // a copy carrying `actor: undefined`.
  {
    const empty = new Map();
    const event = approvalResolved('approval:x');
    check('an empty actor map changes nothing', attributeGateActor(event, empty) === event);

    const other = new Map([[gateActorKey('approval', 'approval:other'), 'user_ada']]);
    check(
      'a gate nobody settled is left alone, even with other gates attributed',
      attributeGateActor(event, other) === event && other.size === 1,
    );

    const node = { type: 'node-completed', runId: 'r1', nodeId: 'n1', nodeName: 'A', output: 'o', at };
    check(
      'a non-gate event is never touched',
      attributeGateActor(node, new Map([[gateActorKey('approval', 'approval:x'), 'user_ada']])) ===
        node,
    );
  }
}

console.log('\nJournal rows that Durable Object SQLite can hold');
{
  // Durable Object SQLite refuses a string over 2 MB (measured: SQLITE_TOOBIG at
  // 3.4 MB in workerd). One large API response must not fail a deployed run.
  const small = { output: '{"ok":true}', viaPortIds: ['p-out'] };
  const smallRow = persistableJournalRow(small);
  check('a normal entry persists, verbatim', smallRow === JSON.stringify(small), String(smallRow));

  const atLimit = { output: 'x'.repeat(JOURNAL_ROW_MAX_BYTES - JSON.stringify({ output: '' }).length) };
  check('an entry of exactly the limit still persists', persistableJournalRow(atLimit) !== null);

  const overLimit = { output: 'x'.repeat(JOURNAL_ROW_MAX_BYTES) };
  check('an entry over the limit is not persisted', persistableJournalRow(overLimit) === null);

  const feed = { output: 'x'.repeat(3_400_000) };
  check('a 3.4 MB feed response is not persisted', persistableJournalRow(feed) === null);

  // Bytes, not characters: 700k three-byte characters are 2.1 MB of UTF-8.
  const wide = { output: '\u20ac'.repeat(700_000) };
  check('the limit is measured in UTF-8 bytes', persistableJournalRow(wide) === null);
  check('and leaves room under the 2 MB platform cap', JOURNAL_ROW_MAX_BYTES < 2_000_000);
}

console.log(failures === 0 ? '\nAll run-wiring checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
