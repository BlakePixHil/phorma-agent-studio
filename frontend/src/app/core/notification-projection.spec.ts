/**
 * Which facts become notifications, and what they say.
 *
 * The rules worth testing here are the exclusions, because they are the ones that
 * decide whether the bell is usable or is a wall of noise, and none of them is
 * visible from the type system:
 *
 *  - a COMPLETION is news only for an unattended trigger. A run the user just
 *    started is a run they are watching.
 *  - a FAILURE is news for every source except `eval`, which has its own panel and
 *    would otherwise push everything else out of the feed one case at a time.
 *  - an approval carrying a payload is NOT inline-resolvable. Approving a payment
 *    from a dropdown without seeing what is being approved is the failure that rule
 *    exists to prevent.
 *  - a notification id is stable across polls, which is the single property that
 *    lets the deployed feed be re-derived instead of persisted.
 */

import fc from 'fast-check';

import {
  NOTIFICATION_DETAIL_CHARS,
  UNATTENDED_RUN_SOURCES,
  clipDetail,
  completionIsWorthReporting,
  failureIsWorthReporting,
  isInlineResolvable,
  notificationFromIssue,
  notificationFromLocalRun,
  notificationFromRun,
  notificationId,
  notificationsFromNotice,
  orphanNotification,
  pendingRowsFromNotice,
  presentationFor,
} from './notification-projection';
import type {
  DeploymentNotice,
  NoticePending,
  NoticeRun,
  NotificationKind,
} from './notifications.model';

const ALL_SOURCES = ['manual', 'schedule', 'webhook', 'eval', 'portal', 'resume'] as const;

function run(overrides: Partial<NoticeRun> = {}): NoticeRun {
  return {
    runId: 'cloudrun-1',
    status: 'failed',
    source: 'schedule',
    startedAt: 1_000,
    endedAt: 2_000,
    error: 'The model refused the request.',
    ...overrides,
  };
}

function pending(overrides: Partial<NoticePending> = {}): NoticePending {
  return {
    kind: 'approval',
    id: 'req-1',
    nodeId: 'n1',
    nodeName: 'Approve payment',
    message: 'Release this payment?',
    hasPayload: false,
    runId: 'cloudrun-1',
    since: 500,
    ...overrides,
  };
}

function notice(overrides: Partial<DeploymentNotice> = {}): DeploymentNotice {
  return {
    workflowId: 'wf-a',
    workflowName: 'Invoice triage',
    runs: [],
    pending: [],
    issues: [],
    ...overrides,
  };
}

describe('notification projection', () => {
  // ── Which sources earn which notice ─────────────────────────────────────────

  describe('source rules', () => {
    it('reports a completion only for an unattended trigger', () => {
      for (const source of ALL_SOURCES) {
        const expected = source === 'schedule' || source === 'webhook';
        expect(completionIsWorthReporting(source))
          .withContext(`completion for source "${source}"`)
          .toBe(expected);
      }
      expect([...UNATTENDED_RUN_SOURCES].sort()).toEqual(['schedule', 'webhook']);
    });

    it('reports a failure for every source except eval', () => {
      for (const source of ALL_SOURCES) {
        expect(failureIsWorthReporting(source))
          .withContext(`failure for source "${source}"`)
          .toBe(source !== 'eval');
      }
    });

    it('drops a manual completion but keeps a manual failure', () => {
      expect(notificationFromRun(run({ status: 'completed', source: 'manual' }), 'wf-a', 'A')).toBeNull();
      expect(notificationFromRun(run({ status: 'failed', source: 'manual' }), 'wf-a', 'A')).not.toBeNull();
    });

    it('reports a portal failure, because the visitor saw an error', () => {
      const entry = notificationFromRun(run({ status: 'failed', source: 'portal' }), 'wf-a', 'A');

      expect(entry?.kind).toBe('deployed-run-failed');
      // But not a portal COMPLETION - that fires once per visitor message and
      // would bury everything else on a busy portal.
      expect(notificationFromRun(run({ status: 'completed', source: 'portal' }), 'wf-a', 'A')).toBeNull();
    });

    it('says nothing at all about an eval run', () => {
      for (const status of ['completed', 'failed', 'stopped'] as const) {
        expect(notificationFromRun(run({ status, source: 'eval' }), 'wf-a', 'A'))
          .withContext(`eval run ${status}`)
          .toBeNull();
      }
    });

    it('reports a stopped run only when nobody asked for the stop', () => {
      // The only stop button is in the studio, so a stopped SCHEDULED run means a
      // timeout or a deploy replaced it - which is worth saying.
      expect(notificationFromRun(run({ status: 'stopped', source: 'schedule' }), 'wf-a', 'A')?.kind)
        .toBe('deployed-run-stopped');
      expect(notificationFromRun(run({ status: 'stopped', source: 'manual' }), 'wf-a', 'A')).toBeNull();
    });
  });

  // ── Content ───────────────────────────────────────────────────────────────

  describe('content', () => {
    it('carries the failure message and the run identity', () => {
      const entry = notificationFromRun(run({ error: 'Upstream returned 500.' }), 'wf-a', 'Invoice triage');

      expect(entry?.detail).toBe('Upstream returned 500.');
      expect(entry?.runId).toBe('cloudrun-1');
      expect(entry?.workflowId).toBe('wf-a');
      expect(entry?.workflowName).toBe('Invoice triage');
      expect(entry?.origin).toBe('deployed');
      expect(entry?.tone).toBe('error');
    });

    it('dates a run by when it ended, not by when it was polled', () => {
      const entry = notificationFromRun(run({ endedAt: 7_777 }), 'wf-a', 'A');

      // A failure that happened before the user last read the feed is not new to
      // them, so the timestamp has to be the worker's and not ours.
      expect(entry?.at).toBe(7_777);
    });

    it('carries no detail on a completion', () => {
      const entry = notificationFromRun(
        run({ status: 'completed', source: 'schedule', error: 'stale' }),
        'wf-a',
        'A',
      );

      expect(entry?.detail).toBeUndefined();
      expect(entry?.tone).toBe('success');
    });

    it('resolves a refusal code into a billing remedy', () => {
      const entry = notificationFromRun(
        run({ error: 'Monthly credits exhausted.', code: 'credits_exhausted' }),
        'wf-a',
        'A',
      );

      expect(entry?.remedy).toBe('buy-credits');
    });

    it('offers nothing for an unrecognised refusal code', () => {
      // A code present means a NEWER worker. Falling back to prose there would let
      // a future `card_expired`, whose message says "subscription", sell credits.
      const entry = notificationFromRun(
        run({ error: 'Your subscription had a problem.', code: 'card_expired_someday' }),
        'wf-a',
        'A',
      );

      expect(entry?.remedy).toBeUndefined();
    });

    it('falls back to prose when a worker sends no code', () => {
      const entry = notificationFromRun(run({ error: 'Monthly credits exhausted.' }), 'wf-a', 'A');

      expect(entry?.remedy).toBe('buy-credits');
    });

    it('does not raise a billing remedy for ordinary workflow prose', () => {
      // The run-controller regex is deliberately narrow: a data node whose HTTP
      // error body mentions a subscription must not sell anything.
      const entry = notificationFromRun(
        run({ error: 'GET /v1/subscription returned 404 Not Found' }),
        'wf-a',
        'A',
      );

      expect(entry?.remedy).toBeUndefined();
    });

    it('names a scheduled run as scheduled', () => {
      expect(notificationFromRun(run({ source: 'schedule' }), 'wf-a', 'Nightly sync')?.title)
        .toBe('Scheduled run of "Nightly sync" failed');
      expect(notificationFromRun(run({ source: 'webhook' }), 'wf-a', 'Nightly sync')?.title)
        .toBe('"Nightly sync" failed in the cloud');
    });

    it('clips a long detail line', () => {
      const long = 'x'.repeat(NOTIFICATION_DETAIL_CHARS + 50);
      const clipped = clipDetail(long);

      expect(clipped?.length).toBe(NOTIFICATION_DETAIL_CHARS + 1);
      expect(clipped?.endsWith('…')).toBe(true);
    });

    it('flattens whitespace and treats an empty detail as absent', () => {
      expect(clipDetail('  a\n\n  b  ')).toBe('a b');
      expect(clipDetail('   ')).toBeUndefined();
      expect(clipDetail('')).toBeUndefined();
      expect(clipDetail(undefined)).toBeUndefined();
    });

    it('gives every kind an icon and a tone', () => {
      const kinds: NotificationKind[] = [
        'deployed-run-failed',
        'deployed-run-completed',
        'deployed-run-stopped',
        'deployment-issue',
        'local-run-failed',
        'local-run-completed',
        'local-run-stopped',
        'orphan-deployment',
      ];
      for (const kind of kinds) {
        const { icon, tone } = presentationFor(kind);
        // Tabler only - `primeicons` is uninstalled, so a `pi ` prefix renders blank.
        expect(icon.startsWith('ti-')).withContext(kind).toBe(true);
        expect(['error', 'warning', 'info', 'success']).toContain(tone);
      }
    });
  });

  // ── Identity ──────────────────────────────────────────────────────────────

  describe('identity', () => {
    it('is stable across repeated projections of the same run', () => {
      const first = notificationFromRun(run(), 'wf-a', 'A');
      const second = notificationFromRun(run(), 'wf-a', 'A');

      // The property the whole re-derivation design rests on.
      expect(first?.id).toBe(second?.id);
    });

    it('separates the same run id under two different kinds', () => {
      const failed = notificationFromRun(run({ status: 'failed' }), 'wf-a', 'A');
      const stopped = notificationFromRun(run({ status: 'stopped', source: 'schedule' }), 'wf-a', 'A');

      expect(failed?.id).not.toBe(stopped?.id);
    });

    it('scopes a draft run under the draft key', () => {
      expect(notificationId(null, 'run-1', 'local-run-failed')).toBe('draft:run-1:local-run-failed');
      // The same `workflowKey` convention every workflow-scoped IndexedDB store
      // uses, so the two never disagree about what a draft is.
      expect(notificationId('wf-a', 'run-1', 'local-run-failed')).toBe('wf-a:run-1:local-run-failed');
    });

    it('gives the same issue text the same id, and different text a different one', () => {
      const a = notificationFromIssue('Schedule "Nightly" was not armed.', 'wf-a', 'A', 1_000);
      const b = notificationFromIssue('Schedule "Nightly" was not armed.', 'wf-a', 'A', 9_000);
      const c = notificationFromIssue('A redaction rule was rejected.', 'wf-a', 'A', 1_000);

      // `settingsIssues` carries no identity and no timestamp, so the text IS the
      // identity - otherwise the same complaint is a new notification every poll.
      expect(a.id).toBe(b.id);
      expect(a.id).not.toBe(c.id);
    });

    it('gives an orphan deployment one row forever', () => {
      const a = orphanNotification({ workflowId: 'wf-a', workflowName: 'A', now: 1 });
      const b = orphanNotification({ workflowId: 'wf-a', workflowName: 'A', now: 2 });

      expect(a.id).toBe(b.id);
    });
  });

  // ── Pending actions ───────────────────────────────────────────────────────

  describe('pending actions', () => {
    it('resolves a payload-free approval inline and nothing else', () => {
      expect(isInlineResolvable(pending({ kind: 'approval', hasPayload: false }))).toBe(true);
      // Approving a payment from a dropdown without seeing what is being approved.
      expect(isInlineResolvable(pending({ kind: 'approval', hasPayload: true }))).toBe(false);
      // A question needs free text; a wait needs an event body.
      expect(isInlineResolvable(pending({ kind: 'question', hasPayload: false }))).toBe(false);
      expect(isInlineResolvable(pending({ kind: 'wait', hasPayload: false }))).toBe(false);
    });

    it('stamps a pending row with its deployment identity', () => {
      const rows = pendingRowsFromNotice(
        notice({ workflowId: 'wf-b', workflowName: 'Payments', pending: [pending()] }),
      );

      expect(rows.length).toBe(1);
      expect(rows[0].workflowId).toBe('wf-b');
      expect(rows[0].workflowName).toBe('Payments');
      expect(rows[0].origin).toBe('deployed');
      expect(rows[0].resolvableInline).toBe(true);
      // The gate's own fields survive - a row with no message cannot be acted on.
      expect(rows[0].message).toBe('Release this payment?');
      expect(rows[0].nodeName).toBe('Approve payment');
    });
  });

  // ── Whole-notice projection ───────────────────────────────────────────────

  describe('notificationsFromNotice', () => {
    it('projects runs and issues together, skipping what is not news', () => {
      const entries = notificationsFromNotice(
        notice({
          runs: [
            run({ runId: 'r1', status: 'failed', source: 'schedule' }),
            run({ runId: 'r2', status: 'completed', source: 'manual' }),
            run({ runId: 'r3', status: 'completed', source: 'schedule' }),
          ],
          issues: ['Schedule "Nightly" was not armed.'],
        }),
        5_000,
      );

      expect(entries.map(entry => entry.kind).sort()).toEqual([
        'deployed-run-completed',
        'deployed-run-failed',
        'deployment-issue',
      ]);
      // The manual completion is the one dropped.
      expect(entries.some(entry => entry.runId === 'r2')).toBe(false);
    });

    it('projects an empty notice to nothing', () => {
      expect(notificationsFromNotice(notice(), 1_000).length).toBe(0);
    });
  });

  // ── Local runs ────────────────────────────────────────────────────────────

  describe('local runs', () => {
    it('reports a local failure and a local completion', () => {
      const failed = notificationFromLocalRun({
        runId: 'run-1',
        status: 'failed',
        source: 'manual',
        workflowId: 'wf-a',
        workflowName: 'Invoice triage',
        endedAt: 3_000,
        error: 'Tool call failed.',
      });
      const done = notificationFromLocalRun({
        runId: 'run-2',
        status: 'completed',
        source: 'manual',
        workflowId: 'wf-a',
        workflowName: 'Invoice triage',
        endedAt: 4_000,
      });

      expect(failed?.kind).toBe('local-run-failed');
      expect(failed?.origin).toBe('local');
      expect(failed?.detail).toBe('Tool call failed.');
      // Unlike the deployed side, a local completion IS reported: the point is that
      // the user was looking at a different workflow when it landed.
      expect(done?.kind).toBe('local-run-completed');
      expect(done?.tone).toBe('success');
    });

    it('says nothing about a local eval run', () => {
      for (const status of ['completed', 'failed', 'stopped'] as const) {
        expect(
          notificationFromLocalRun({
            runId: 'run-1',
            status,
            source: 'eval',
            workflowId: 'wf-a',
            workflowName: 'A',
            endedAt: 1,
          }),
        )
          .withContext(`local eval ${status}`)
          .toBeNull();
      }
    });

    it('handles a run of an unsaved draft', () => {
      const entry = notificationFromLocalRun({
        runId: 'run-1',
        status: 'failed',
        source: 'manual',
        workflowId: null,
        workflowName: 'Untitled workflow',
        endedAt: 1,
        error: 'nope',
      });

      expect(entry?.workflowId).toBeNull();
      expect(entry?.id).toBe('draft:run-1:local-run-failed');
    });
  });

  // ── Properties ────────────────────────────────────────────────────────────

  it('Property: a projected run always carries identity and a bounded detail', () => {
    fc.assert(
      fc.property(
        fc.record({
          runId: fc.string({ minLength: 1, maxLength: 12 }),
          status: fc.constantFrom('completed' as const, 'failed' as const, 'stopped' as const),
          source: fc.constantFrom(...ALL_SOURCES),
          startedAt: fc.integer({ min: 0, max: 100_000 }),
          endedAt: fc.integer({ min: 0, max: 100_000 }),
          error: fc.option(fc.string({ maxLength: 600 }), { nil: undefined }),
        }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (candidate, workflowName) => {
          const entry = notificationFromRun(candidate as NoticeRun, 'wf-x', workflowName);
          if (entry === null) return;

          // Identity is the summary's own, never invented.
          expect(entry.runId).toBe(candidate.runId);
          expect(entry.at).toBe(candidate.endedAt);
          expect(entry.id).toBe(notificationId('wf-x', candidate.runId, entry.kind));
          // The detail is bounded whatever the worker sent, because a 4 KB string
          // in a signal is a cost paid on every change detection.
          if (entry.detail !== undefined) {
            expect(entry.detail.length).toBeLessThanOrEqual(NOTIFICATION_DETAIL_CHARS + 1);
          }
          // And a title is never empty - a blank row reads as a rendering bug.
          expect(entry.title.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('Property: only an unattended source ever produces a non-failure notice', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_SOURCES),
        fc.constantFrom('completed' as const, 'stopped' as const),
        (source, status) => {
          const entry = notificationFromRun(run({ status, source }), 'wf-a', 'A');
          const unattended = UNATTENDED_RUN_SOURCES.includes(source);

          expect(entry !== null).toBe(unattended);
          if (entry) expect(entry.tone).not.toBe('error');
        },
      ),
      { numRuns: 100 },
    );
  });
});
