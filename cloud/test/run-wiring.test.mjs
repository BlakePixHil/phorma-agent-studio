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
  dataPathSettings,
  notificationDetail,
  notificationEndpoint,
  notificationTriggerFor,
  notificationWanted,
  resolveRunRetention,
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

console.log(failures === 0 ? '\nAll run-wiring checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
