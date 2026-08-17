/**
 * End-to-end scenario: a cron schedule from spec push to a started run.
 *
 * This is the whole path the previous arrangement could not walk. It exercises,
 * in order:
 *
 * 1. Spec push creates one schedule per `schedule-trigger` node with a non-blank
 *    cron, stores the TRANSLATED AWS six-field expression, and points the target
 *    at the Schedule_Shim function rather than at an `execute-api` route.
 * 2. A cron AWS cannot express is refused on the push, before any mutation.
 * 3. Pushing one workflow leaves another workflow's schedules alone.
 * 4. The real Schedule_Shim handler, driven against the real Server_Entry over
 *    loopback, mints a run id and starts a run through the ordinary trigger route.
 * 5. A second fire while the first run holds the lease resolves as
 *    `already-running` rather than throwing, so Scheduler does not retry and the
 *    error metric stays quiet.
 * 6. A fire for a purged workflow deletes the orphaned schedule, publishes the
 *    skipped-scheduled-run metric and resolves as `not-deployed`.
 *
 * No AWS client and no credential: the host is composed through
 * `composeHostAdapter`'s `factories` seam over the fakes, and the shim's network
 * call is the one real thing, aimed at the loopback listener. The shim's SigV4
 * signer is replaced by a plain fetch for the same reason - signing is covered by
 * unit tests and would need credentials here.
 *
 * Run: npx -y tsx cloud-aws/test/schedule-fire.e2e.mts
 *
 * Feature: aws-byo-deploy
 */

import { scheduleName, schedulePrefix } from '../src/core/schedule-name.js';
import { translateCron } from '../src/core/cron.js';
import { leaseSk, pk } from '../src/core/keys.js';
import type { LogWriter, MetricPublisher } from '../src/aws/ports.js';
import { FakeDocumentTableClient } from '../src/test/fake-document-table-client.js';
import { FakeRunTable } from '../src/test/fake-run-table.js';
import { FakeMonitorBackend } from '../src/test/fake-monitor.js';
import { FakeSchedulerBackend } from '../src/test/fake-scheduler.js';
import { FakeSecretsManager } from '../src/test/fake-secrets-manager.js';
import type { ServerEnv } from '../src/server/env.js';
import { composeHostAdapter } from '../src/server/startup.js';
import type { HostFactories } from '../src/server/startup.js';
import { shutdown, startServer } from '../src/server/index.js';
import type { ServerHandle } from '../src/server/index.js';
import { runShim, type TriggerOutcome } from '../src/shim/schedule-shim.js';

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  \u2713 ${name}`);
  else {
    failures += 1;
    console.error(`  \u2717 ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Fixture identifiers
// ---------------------------------------------------------------------------

const TABLE_NAME = 'phorma-runs-sched';
const RUNNER_ID = 'runner-sched';
const GROUP = 'phorma-sched-group';
const SHIM_ARN = 'arn:aws:lambda:eu-west-1:123456789012:function:phorma-schedule-shim';

const WF = 'wf-cron';
const WF_OTHER = 'wf-cron-other';
const NODE = 'sched-node';

/** What the operator types, and what AWS must end up storing. */
const UNIX_CRON = '0 12 * * *';
const AWS_CRON = '0 12 * * ? *';

// ---------------------------------------------------------------------------
// The host, composed from fakes
// ---------------------------------------------------------------------------

const runTable = new FakeRunTable();
const table = new FakeDocumentTableClient(runTable, { tableName: TABLE_NAME });
const monitor = new FakeMonitorBackend();
const secrets = new FakeSecretsManager();
const scheduler = new FakeSchedulerBackend();

const logLines: string[] = [];
const logWriter: LogWriter = {
  write: async (line) => {
    logLines.push(line);
  },
};

/** Every metric the host published, so the orphan path can be checked. */
const metrics: { name: string; dimensions: Record<string, string> }[] = [];
const metricPublisher: MetricPublisher = {
  publish: async (point) => {
    const p = point as unknown as { name: string; dimensions?: Record<string, string> };
    metrics.push({ name: p.name, dimensions: p.dimensions ?? {} });
  },
};

const factories: Partial<HostFactories> = {
  createDocumentTableClient: () => table,
  createMonitorBackend: () => monitor,
  createSecretsBackend: () => secrets,
  createSchedulerBackend: () => scheduler,
  createMetricPublisher: () => metricPublisher,
  createStdoutLogWriter: () => logWriter,
};

const env: ServerEnv = {
  region: 'eu-west-1',
  runTableName: TABLE_NAME,
  monitorEndpoint: 'https://monitor.example.com',
  secretPrefix: 'phorma/sched',
  metricNamespace: 'Phorma/Sched',
  scheduleGroup: GROUP,
  // The Schedule_Shim function, which is the only target EventBridge Scheduler
  // can actually reach on the way to a trigger route.
  scheduleTargetArn: SHIM_ARN,
  scheduleRoleArn: 'arn:aws:iam::123456789012:role/phorma-scheduler-invoke',
  runnerId: RUNNER_ID,
  port: 0,
};

// ---------------------------------------------------------------------------
// Spec builders
// ---------------------------------------------------------------------------

function specWithCron(workflowId: string, cron: string): unknown {
  return {
    version: 1,
    id: workflowId,
    name: 'Cron E2E',
    savedAt: new Date().toISOString(),
    graph: {
      nodes: [
        {
          id: NODE,
          name: 'Every day at noon',
          kind: 'schedule-trigger',
          category: 'trigger',
          icon: '',
          position: { x: 0, y: 0 },
          ports: [{ id: `${NODE}-out`, name: 'Out', role: 'message-out' }],
          data: { cron },
        },
      ],
      connections: [],
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP over the bound port
// ---------------------------------------------------------------------------

let base = '';

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json };
}

/**
 * The shim's transport, unsigned.
 *
 * The loopback listener enforces no IAM, and signing needs credentials the check
 * pipeline does not have. What is under test here is the shim's decision making
 * and the route it calls, not SigV4, which `schedule-shim.spec.ts` covers.
 */
const unsignedSend = async (
  url: string,
  method: string,
  body: string,
): Promise<TriggerOutcome> => {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body,
  });
  return { status: response.status, body: await response.text() };
};

/** Fire the schedule exactly as EventBridge Scheduler would. */
function fire(workflowId: string) {
  return runShim(
    { workflowId, nodeId: NODE, source: 'schedule' },
    {
      env: { PHORMA_TRIGGER_API_URL: base, PHORMA_REGION: env.region },
      send: unsignedSend,
      log: () => {},
    },
  );
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

console.log('Scenario: cron schedule from spec push to started run');

const exitCodes: number[] = [];
const host = composeHostAdapter(env, { factories });

let handle: ServerHandle;
try {
  handle = await startServer(env, {
    host,
    drainIntervalMs: 25,
    registerSignals: false,
    exit: (code) => exitCodes.push(code),
  });
} catch (thrown) {
  console.error(`  \u2717 startServer threw - ${String(thrown)}`);
  process.exit(1);
}

base = `http://127.0.0.1:${handle.port}`;

try {
  // ─── 1. Push creates a schedule with the translated cron ─────────────────
  console.log('\nSpec push creates the schedule');
  {
    const push = await call('POST', `/workflows/${WF}/spec`, { spec: specWithCron(WF, UNIX_CRON) });
    check('the push succeeds', push.status === 200, `got ${push.status} ${push.text}`);

    const name = scheduleName(WF, NODE);
    check('one schedule exists', scheduler.size === 1, `size ${scheduler.size}`);
    check('it carries the derived name', scheduler.has(name));

    const entry = scheduler.peek(name);
    check(
      'the stored expression is the translated AWS form',
      entry?.cron === AWS_CRON,
      `stored "${entry?.cron}", expected "${AWS_CRON}"`,
    );
    check(
      'exactly one day field defers',
      (entry?.cron ?? '').split(' ').filter((f, i) => f === '?' && (i === 2 || i === 4)).length === 1,
      entry?.cron,
    );
    check('the timezone is UTC', entry?.timezone === 'UTC', entry?.timezone);
    check('the group is the IaC-owned one', entry?.groupName === GROUP, entry?.groupName);

    // The defect this whole change exists for: an `execute-api` target is not a
    // thing EventBridge Scheduler accepts.
    check(
      'the target is the Schedule_Shim function',
      entry?.target.arn === SHIM_ARN,
      entry?.target.arn,
    );
    check(
      'the target is not an execute-api route',
      !(entry?.target.arn ?? '').includes('execute-api'),
      entry?.target.arn,
    );

    const input = JSON.parse(entry?.target.input ?? '{}') as Record<string, unknown>;
    check('the input names the workflow and node', input.workflowId === WF && input.nodeId === NODE);
    check(
      'the input carries no runId, which would be reused on every fire',
      input.runId === undefined,
    );
  }

  // ─── 2. An untranslatable cron is refused before any mutation ────────────
  console.log('\nAn untranslatable cron is refused');
  {
    const before = scheduler.size;
    // Both day fields constrained. AWS accepts one or the other, never both.
    const push = await call('POST', `/workflows/${WF}/spec`, { spec: specWithCron(WF, '0 0 1 * 1') });
    check('the push fails', push.status >= 400, `got ${push.status}`);
    check('the schedule set is unchanged', scheduler.size === before, `size ${scheduler.size}`);
    check('the surviving schedule still holds the good cron',
      scheduler.peek(scheduleName(WF, NODE))?.cron === AWS_CRON);
  }

  // ─── 3. A push for one workflow leaves another alone ─────────────────────
  console.log('\nCross-workflow isolation');
  {
    const other = await call('POST', `/workflows/${WF_OTHER}/spec`, {
      spec: specWithCron(WF_OTHER, '30 3 * * *'),
    });
    check('the second workflow pushes', other.status === 200, `got ${other.status}`);
    check('both schedules now exist', scheduler.size === 2, `size ${scheduler.size}`);

    // Re-push the first. Before names were workflow-scoped, this deleted the
    // second workflow's schedule with no way to notice.
    const repush = await call('POST', `/workflows/${WF}/spec`, {
      spec: specWithCron(WF, '15 6 * * *'),
    });
    check('the re-push succeeds', repush.status === 200, `got ${repush.status}`);
    check('both schedules still exist', scheduler.size === 2, `size ${scheduler.size}`);
    check(
      'the other workflow kept its own expression',
      scheduler.peek(scheduleName(WF_OTHER, NODE))?.cron === translateCronOrThrow('30 3 * * *'),
    );
    check(
      'the re-pushed workflow took the new expression',
      scheduler.peek(scheduleName(WF, NODE))?.cron === translateCronOrThrow('15 6 * * *'),
    );

    const lists = scheduler.log.filter((e) => e.operation === 'list');
    check(
      'every list was scoped to one workflow prefix',
      lists.length > 0 && lists.every(
        (e) => e.namePrefix === schedulePrefix(WF) || e.namePrefix === schedulePrefix(WF_OTHER),
      ),
      lists.map((e) => e.namePrefix).join(', '),
    );
  }

  // ─── 4. A fired schedule starts a run ────────────────────────────────────
  console.log('\nA fired schedule starts a run');
  let firstRunId = '';
  {
    const result = await fire(WF);
    firstRunId = result.runId;

    check('the shim reports the run started', result.outcome === 'started', result.outcome);
    check('the trigger route accepted it', result.status === 202, `got ${result.status}`);
    check('a run id was minted', result.runId.length > 0);
    check('the lease is held', storedLease(WF) !== undefined);
  }

  // ─── 5. A second fire while running is not an error ──────────────────────
  console.log('\nA second fire while the lease is held');
  {
    const result = await fire(WF);
    check(
      'the shim reports already-running',
      result.outcome === 'already-running',
      result.outcome,
    );
    check('the trigger route answered 409', result.status === 409, `got ${result.status}`);
    check('a fresh run id was still minted', result.runId !== firstRunId);
    // The shim resolving rather than throwing is what keeps Scheduler from
    // retrying and keeps the Lambda error metric meaningful.
    check('exactly one skip record exists', skipRecords(WF).length === 1,
      `${skipRecords(WF).length} skip records`);
  }

  // ─── 6. A fire for a purged workflow deletes the orphan ──────────────────
  console.log('\nA fired schedule for a purged workflow');
  {
    const purge = await call('DELETE', `/workflows/${WF_OTHER}`);
    check('the purge succeeds', purge.status === 200, `got ${purge.status}`);

    // Purge removes the schedules too, so re-create one directly to stand for a
    // schedule that outlived its spec.
    const orphanName = scheduleName(WF_OTHER, NODE);
    scheduler.seed(orphanName, {
      name: orphanName,
      groupName: GROUP,
      cron: AWS_CRON,
      timezone: 'UTC',
      target: { arn: SHIM_ARN, roleArn: env.scheduleRoleArn },
    });
    const metricsBefore = metrics.length;

    const result = await fire(WF_OTHER);

    check('the shim reports not-deployed', result.outcome === 'not-deployed', result.outcome);
    check('the trigger route answered 404', result.status === 404, `got ${result.status}`);
    check('the orphaned schedule was deleted', !scheduler.has(orphanName));
    check(
      'the skipped-scheduled-run metric was published',
      metrics.slice(metricsBefore).some((m) => m.name === 'skipped-scheduled-run'),
      metrics.slice(metricsBefore).map((m) => m.name).join(', '),
    );
    check(
      'the lease was released rather than left held',
      leaseExpired(WF_OTHER),
      JSON.stringify(storedLease(WF_OTHER)),
    );
  }
} finally {
  await shutdown(handle, 'SIGTERM');
}

// ---------------------------------------------------------------------------
// Table helpers
// ---------------------------------------------------------------------------

function storedLease(workflowId: string): Record<string, unknown> | undefined {
  return runTable.getItem({ pk: pk(workflowId), sk: leaseSk() }) ?? undefined;
}

/**
 * A released lease keeps its fencing token and sets `expiresAtMs` to now, so
 * "released" reads as "not in the future" rather than "absent".
 */
function leaseExpired(workflowId: string): boolean {
  const lease = storedLease(workflowId);
  if (!lease) return true;
  const expires = lease.expiresAtMs;
  return typeof expires === 'number' && expires <= Date.now();
}

function skipRecords(workflowId: string): { sk: string }[] {
  return runTable.query({ pk: pk(workflowId), skPrefix: 'skip#' }).items as { sk: string }[];
}

function translateCronOrThrow(cron: string): string {
  const result = translateCron(cron);
  if (!result.ok) throw new Error(`fixture cron "${cron}" does not translate: ${result.reason}`);
  return result.expression;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

console.log('');
if (failures > 0) {
  console.error(`schedule-fire scenario FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('schedule-fire scenario passed.');
