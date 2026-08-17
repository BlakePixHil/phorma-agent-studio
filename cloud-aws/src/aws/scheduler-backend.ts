/**
 * The production `SchedulerBackend`: schedule management over EventBridge
 * Scheduler.
 *
 * This is the owning module for the `schedules` capability, as
 * `./capability-map.json` declares. Every schedule derived from a
 * `schedule-trigger` node reaches AWS through the client built here.
 *
 * Thin translation only. `SchedulerAdapter` in `./scheduler.ts` owns
 * validation, the delete-before-create ordering, the retry budget and the
 * rollback; this module turns each of its three port calls into one Scheduler
 * API call and nothing else.
 *
 * Three translation decisions live here because they are API-shape concerns
 * rather than domain rules:
 *
 * - Scheduler takes a wrapped `cron(...)` expression over six fields. A domain
 *   cron already carrying a wrapper is passed through verbatim; a bare
 *   five-field expression gets the year wildcard appended.
 * - The flexible time window is `OFF`, so a schedule fires at its cron instant
 *   rather than inside a jitter window.
 * - `ListSchedules` returns summaries that carry no cron, timezone or role, so
 *   filling a `ScheduleEntry` needs a `GetSchedule` per name. Every page is
 *   walked before any detail read, so a group larger than one page still
 *   returns completely.
 *
 * No client is constructed at module load: the Check_Pipeline runs with no AWS
 * credentials, so credential resolution happens inside
 * `createSchedulerBackend`, which the Server_Entry calls after `readServerEnv`
 * succeeds.
 *
 * Feature: aws-byo-deploy
 * Requirements: 8.1, 8.2, 8.3
 */

import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  FlexibleTimeWindowMode,
  GetScheduleCommand,
  ListSchedulesCommand,
  SchedulerClient,
} from '@aws-sdk/client-scheduler';
import type { ScheduleSummary } from '@aws-sdk/client-scheduler';

import type { SchedulerBackend } from './ports.js';
import type { ScheduleEntry, ScheduleTarget } from './scheduler.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Page size for `ListSchedules`. The API caps `MaxResults` at 100. */
const LIST_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SchedulerBackendOptions {
  /** The region the schedule group lives in - `AWS_REGION` on the task definition. */
  region: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the production `SchedulerBackend`.
 *
 * Credentials come from the default provider chain, which resolves the
 * Runtime_Identity task role on Fargate. Calling this function is the first
 * point at which a client exists. The IaC-owned group name arrives per call
 * from `SchedulerAdapter`, which reads it from `PHORMA_SCHEDULE_GROUP`.
 */
export function createSchedulerBackend(options: SchedulerBackendOptions): SchedulerBackend {
  const client = new SchedulerClient({ region: options.region });

  /** Walk every `ListSchedules` page for one group, scoped to a name prefix. */
  const listSummaries = async (
    groupName: string,
    namePrefix: string,
  ): Promise<ScheduleSummary[]> => {
    const summaries: ScheduleSummary[] = [];
    let nextToken: string | undefined;

    do {
      const page = await client.send(
        new ListSchedulesCommand({
          GroupName: groupName,
          // Server-side scoping. Filtering client-side would still page through
          // every other workflow's schedules to find this workflow's few.
          NamePrefix: namePrefix,
          MaxResults: LIST_PAGE_SIZE,
          ...(nextToken === undefined ? {} : { NextToken: nextToken }),
        }),
      );
      if (page.Schedules) summaries.push(...page.Schedules);
      nextToken = page.NextToken ? page.NextToken : undefined;
    } while (nextToken !== undefined);

    return summaries;
  };

  return {
    async createSchedule(
      groupName: string,
      name: string,
      cron: string,
      timezone: string,
      target: ScheduleTarget,
    ): Promise<void> {
      await client.send(
        new CreateScheduleCommand({
          GroupName: groupName,
          Name: name,
          ScheduleExpression: scheduleExpression(cron),
          ScheduleExpressionTimezone: timezone,
          FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
          Target: {
            Arn: target.arn,
            RoleArn: target.roleArn,
            ...(target.input === undefined ? {} : { Input: target.input }),
          },
        }),
      );
    },

    async deleteSchedule(groupName: string, name: string): Promise<void> {
      await client.send(new DeleteScheduleCommand({ GroupName: groupName, Name: name }));
    },

    async listSchedules(groupName: string, namePrefix: string): Promise<ScheduleEntry[]> {
      const summaries = await listSummaries(groupName, namePrefix);
      const names = summaries
        .map((summary) => summary.Name)
        .filter((name): name is string => name !== undefined);

      return Promise.all(
        names.map(async (name) => {
          const detail = await client.send(
            new GetScheduleCommand({ GroupName: groupName, Name: name }),
          );
          return {
            name,
            groupName: detail.GroupName ?? groupName,
            cron: unwrapScheduleExpression(detail.ScheduleExpression ?? ''),
            timezone: detail.ScheduleExpressionTimezone ?? 'UTC',
            target: {
              arn: detail.Target?.Arn ?? '',
              roleArn: detail.Target?.RoleArn ?? '',
              ...(detail.Target?.Input === undefined ? {} : { input: detail.Target.Input }),
            },
          } satisfies ScheduleEntry;
        }),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Expression translation
// ---------------------------------------------------------------------------

/**
 * Wrap an AWS six-field cron body in the `cron(...)` Scheduler expects.
 *
 * Only the wrapper is added here. The dialect translation - five Unix fields to
 * six AWS fields, Unix day-of-week numbering to AWS numbering, and the `?`
 * reconciliation between the two day fields - belongs to `core/cron.ts` and has
 * already run by the time `SchedulerAdapter` calls this backend.
 *
 * That split is deliberate and was previously wrong. This function used to do
 * the translation itself by appending a year wildcard, which turned the ordinary
 * `0 12 * * *` into `cron(0 12 * * * *)` and had AWS reject it for carrying `*`
 * in both day fields.
 *
 * Exported for the round-trip assertion in `./scheduler-backend.spec.ts`.
 */
export function scheduleExpression(cron: string): string {
  return `cron(${cron.trim()})`;
}

/**
 * Strip the `cron(...)` wrapper so a listed entry reads back in the same shape
 * the domain pushed. A `rate(...)` or `at(...)` expression, which this backend
 * never writes, is returned verbatim.
 *
 * Exported for the round-trip assertion in `./scheduler-backend.spec.ts`.
 */
export function unwrapScheduleExpression(expression: string): string {
  const match = /^cron\((.*)\)$/s.exec(expression.trim());
  return match ? match[1]! : expression;
}
