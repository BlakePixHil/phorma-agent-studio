/**
 * Unit tests for the production `SchedulerBackend`.
 *
 * The Check_Pipeline runs with no AWS credentials present and this file is part
 * of it, so the shape assertion doubles as the credential-free construction
 * check: importing the module builds no client, and calling the factory
 * resolves no credentials and reaches no network.
 *
 * The expression translation is the only decision this module makes, so it is
 * asserted directly. Behaviour that needs a schedule group behind it is covered
 * against the in-memory port implementation in `scheduler.spec.ts`.
 *
 * Feature: aws-byo-deploy
 * Requirements: 8.1, 8.2, 8.3
 */

import { describe, expect, it } from 'vitest';

import {
  createSchedulerBackend,
  scheduleExpression,
  unwrapScheduleExpression,
} from './scheduler-backend.js';
import type { SchedulerBackend } from './ports.js';

const PORT_METHODS: (keyof SchedulerBackend)[] = [
  'createSchedule',
  'deleteSchedule',
  'listSchedules',
];

describe('createSchedulerBackend', () => {
  it('exposes exactly the three SchedulerBackend operations', () => {
    const backend = createSchedulerBackend({ region: 'eu-west-1' });

    for (const method of PORT_METHODS) {
      expect(typeof backend[method]).toBe('function');
    }
    expect(Object.keys(backend).sort()).toEqual([...PORT_METHODS].sort());
  });

  it('builds an independent backend per call', () => {
    const first = createSchedulerBackend({ region: 'eu-west-1' });
    const second = createSchedulerBackend({ region: 'us-east-1' });

    expect(second).not.toBe(first);
    expect(second.listSchedules).not.toBe(first.listSchedules);
  });
});

describe('scheduleExpression', () => {
  it('wraps an AWS six-field body', () => {
    expect(scheduleExpression('0 3 * * ? *')).toBe('cron(0 3 * * ? *)');
    expect(scheduleExpression('0 3 * * ? 2030')).toBe('cron(0 3 * * ? 2030)');
  });

  it('trims surrounding whitespace', () => {
    expect(scheduleExpression('  0 3 * * ? *  ')).toBe('cron(0 3 * * ? *)');
  });

  it('adds the wrapper and nothing else', () => {
    // Dialect translation belongs to `core/cron.ts` and has already run. This
    // function used to append a year wildcard itself, which is what turned
    // `0 12 * * *` into the both-day-fields-wildcarded expression AWS rejects.
    // Anything arriving here is already six fields.
    const body = '30 2 ? * 2-6 *';
    expect(scheduleExpression(body)).toBe(`cron(${body})`);
  });
});

describe('unwrapScheduleExpression', () => {
  it('strips the cron wrapper', () => {
    expect(unwrapScheduleExpression('cron(0 3 * * ? *)')).toBe('0 3 * * ? *');
  });

  it('leaves a non-cron expression verbatim', () => {
    expect(unwrapScheduleExpression('rate(5 minutes)')).toBe('rate(5 minutes)');
  });

  it('inverts scheduleExpression for a six-field cron', () => {
    const cron = '0 3 * * ? 2030';
    expect(unwrapScheduleExpression(scheduleExpression(cron))).toBe(cron);
  });

  it('round trips every shape the translator emits', () => {
    for (const body of ['0 12 * * ? *', '0 0 ? * 2 *', '15 10 ? * 6L 2022-2023']) {
      expect(unwrapScheduleExpression(scheduleExpression(body))).toBe(body);
    }
  });
});
