/**
 * The notification store.
 *
 * Three claims carry this feature and each one is asserted with CONTENTS rather
 * than shape, because all three hold trivially for an empty feed:
 *
 * 1. `add` is idempotent on notification id. This is what makes the deployed feed
 *    safe to RE-DERIVE from the worker instead of persisting it - a poll reports
 *    the same settled run every tick until the cursor passes it, so an appending
 *    merge would grow a row every few seconds forever.
 * 2. Unread is measured against when something HAPPENED, never against when it
 *    was polled. Otherwise a cron failure that predates the last "mark all read"
 *    but arrives on this machine afterwards reads as news.
 * 3. `markAllRead` always advances the cursor past the newest notification, so a
 *    worker clock running ahead of this machine cannot leave a badge that nothing
 *    can clear.
 *
 * `localStorage` is real here rather than mocked. The read marker is the poll
 * cursor as well as the read state, so "does it survive a restart" is the actual
 * behaviour under test, and a fake would be asserting on itself.
 */

import { TestBed } from '@angular/core/testing';
import fc from 'fast-check';

import {
  MUTABLE_NOTIFICATION_KINDS,
  NOTIFICATION_FEED_LIMIT,
  NotificationsService,
  isMutableKind,
} from './notifications.service';
import type { NotificationKind, StudioNotification } from './notifications.model';

/** Both `phorma.layout.*` keys this service owns. */
const KEYS = ['phorma.layout.notificationsReadAt', 'phorma.layout.notificationsMutedKinds'];

function notification(overrides: Partial<StudioNotification> = {}): StudioNotification {
  return {
    id: 'wf-a:run-1:deployed-run-failed',
    kind: 'deployed-run-failed',
    origin: 'deployed',
    tone: 'error',
    title: 'Invoice triage failed',
    icon: 'ti-alert-triangle',
    at: 1_000,
    workflowId: 'wf-a',
    workflowName: 'Invoice triage',
    runId: 'run-1',
    ...overrides,
  };
}

describe('NotificationsService', () => {
  let service: NotificationsService;

  beforeEach(() => {
    for (const key of KEYS) localStorage.removeItem(key);
    TestBed.configureTestingModule({});
    service = TestBed.inject(NotificationsService);
  });

  afterEach(() => {
    for (const key of KEYS) localStorage.removeItem(key);
  });

  // ── Idempotent merge ──────────────────────────────────────────────────────

  it('merges a repeated notification instead of appending it', () => {
    service.add([notification()]);
    service.add([notification()]);
    service.add([notification()]);

    expect(service.feed().length).toBe(1);
    expect(service.feed()[0].id).toBe('wf-a:run-1:deployed-run-failed');
  });

  it('lets a later read replace an earlier one under the same id', () => {
    service.add([notification({ title: 'first', detail: 'stale' })]);
    service.add([notification({ title: 'second', detail: 'fresh' })]);

    expect(service.feed().length).toBe(1);
    // Contents, not just the count: the newer read is the better one.
    expect(service.feed()[0].title).toBe('second');
    expect(service.feed()[0].detail).toBe('fresh');
  });

  it('pins the original timestamp when a notification is re-merged', () => {
    // The defect this prevents: a deployment issue carries no natural clock, so
    // its `at` is "when we first saw it". Bumping that on every poll pushes it
    // back above the read marker seconds after the user clears the badge, and
    // there is then no way to make it stay cleared.
    service.add([notification({ id: 'issue', kind: 'deployment-issue', at: 1_000 })]);
    service.markAllRead();
    expect(service.unreadCount()).toBe(0);

    service.add([notification({ id: 'issue', kind: 'deployment-issue', at: Date.now() + 60_000 })]);

    expect(service.feed()[0].at).toBe(1_000);
    expect(service.unreadCount()).toBe(0);
  });

  it('keeps distinct notifications about the same run apart', () => {
    // A run can produce a failure row AND leave a pending gate behind, and the
    // kind is part of the identity precisely so those do not collapse.
    service.add([
      notification({ id: 'wf-a:run-1:deployed-run-failed', kind: 'deployed-run-failed' }),
      notification({ id: 'wf-a:run-1:deployment-issue', kind: 'deployment-issue' }),
    ]);

    expect(service.feed().length).toBe(2);
  });

  it('orders the feed newest first regardless of arrival order', () => {
    service.add([notification({ id: 'old', at: 1_000, title: 'old' })]);
    service.add([notification({ id: 'new', at: 3_000, title: 'new' })]);
    service.add([notification({ id: 'mid', at: 2_000, title: 'mid' })]);

    expect(service.feed().map(entry => entry.title)).toEqual(['new', 'mid', 'old']);
  });

  it('evicts the oldest past the feed limit', () => {
    const many: StudioNotification[] = [];
    for (let index = 0; index < NOTIFICATION_FEED_LIMIT + 10; index += 1) {
      many.push(notification({ id: `n-${index}`, at: 1_000 + index }));
    }
    service.add(many);

    expect(service.feed().length).toBe(NOTIFICATION_FEED_LIMIT);
    // The newest survive and the oldest are the ones dropped.
    expect(service.feed()[0].id).toBe(`n-${NOTIFICATION_FEED_LIMIT + 9}`);
    expect(service.feed().some(entry => entry.id === 'n-0')).toBe(false);
  });

  it('ignores an empty batch without touching the feed', () => {
    service.add([notification()]);
    const before = service.feed();
    service.add([]);

    expect(service.feed()).toBe(before);
  });

  // ── Unread arithmetic ─────────────────────────────────────────────────────

  it('counts unread against when the event happened, not when it arrived', () => {
    service.add([notification({ id: 'a', at: 5_000 })]);
    service.markAllRead();

    // A cron failure that happened BEFORE the mark but only reached this machine
    // afterwards. It is not news, and dating it by arrival would resurrect it.
    service.add([notification({ id: 'b', at: 4_000 })]);

    expect(service.unreadCount()).toBe(0);
  });

  it('counts a notification that happened after the mark', () => {
    service.add([notification({ id: 'a', at: 5_000 })]);
    service.markAllRead();
    service.add([notification({ id: 'b', at: Date.now() + 60_000, title: 'later' })]);

    expect(service.unreadCount()).toBe(1);
    expect(service.unread()[0].title).toBe('later');
  });

  it('clears the badge even when a notification is timestamped ahead of this clock', () => {
    // The worker stamps `at`, so a second of clock skew is ordinary. A cursor set
    // to `Date.now()` alone would leave this permanently unread.
    service.add([notification({ id: 'future', at: Date.now() + 5 * 60_000 })]);
    expect(service.unreadCount()).toBe(1);

    service.markAllRead();

    expect(service.unreadCount()).toBe(0);
  });

  it('never moves the read marker backwards', () => {
    service.add([notification({ id: 'a', at: Date.now() + 60_000 })]);
    service.markAllRead();
    const advanced = service.readAt();

    service.clear();
    service.markAllRead();

    expect(service.readAt()).toBeGreaterThanOrEqual(advanced);
  });

  it('tints on an unread failure only', () => {
    service.add([notification({ id: 'ok', tone: 'success', kind: 'deployed-run-completed' })]);
    expect(service.hasUnreadProblem()).toBe(false);

    service.add([notification({ id: 'bad', tone: 'error', at: 2_000 })]);
    expect(service.hasUnreadProblem()).toBe(true);

    service.markAllRead();
    expect(service.hasUnreadProblem()).toBe(false);
  });

  // ── The read marker is the poll cursor ────────────────────────────────────

  it('persists the read marker so a restart resumes the cursor', () => {
    service.add([notification({ id: 'a', at: 7_000 })]);
    service.markAllRead();
    const persisted = service.readAt();

    // The write must already be on disk with no change detection in between - the
    // cursor is persisted synchronously precisely so killing the app here cannot
    // lose it. Asserting on storage directly is what pins that down; an `effect()`
    // implementation passes the service-level check below and fails this one.
    expect(Number(localStorage.getItem('phorma.layout.notificationsReadAt'))).toBe(persisted);

    // A fresh injector over the same storage: this is the restart.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const afterRestart = TestBed.inject(NotificationsService);

    expect(afterRestart.readAt()).toBe(persisted);
    // And the bodies are NOT persisted - they come back from the next poll.
    expect(afterRestart.feed().length).toBe(0);
  });

  it('persists a mute synchronously too', () => {
    service.setMuted('local-run-completed', true);

    expect(localStorage.getItem('phorma.layout.notificationsMutedKinds')).toBe(
      JSON.stringify(['local-run-completed']),
    );

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    expect(TestBed.inject(NotificationsService).isMuted('local-run-completed')).toBe(true);
  });

  it('starts a fresh install at cursor zero so nothing retained is skipped', () => {
    expect(service.readAt()).toBe(0);
  });

  it('dismissing does not advance the cursor', () => {
    service.add([notification({ id: 'a', at: 9_000 })]);
    const cursorBefore = service.readAt();
    service.dismiss('a');

    expect(service.feed().length).toBe(0);
    // Dismissal is "off my screen", not "I have dealt with this". Advancing here
    // would make dismissing a row hide every older unread one too.
    expect(service.readAt()).toBe(cursorBefore);
  });

  // ── Muting ────────────────────────────────────────────────────────────────

  it('drops a muted kind at the store rather than at the call site', () => {
    service.setMuted('local-run-completed', true);
    service.add([
      notification({ id: 'muted', kind: 'local-run-completed', origin: 'local' }),
      notification({ id: 'kept', kind: 'deployed-run-failed', at: 2_000 }),
    ]);

    expect(service.feed().map(entry => entry.id)).toEqual(['kept']);
  });

  it('refuses to mute a failure kind', () => {
    for (const kind of ['deployed-run-failed', 'local-run-failed', 'deployment-issue'] as const) {
      expect(isMutableKind(kind)).toBe(false);
      service.setMuted(kind, false);
      service.setMuted(kind, true);
      expect(service.isMuted(kind)).toBe(false);
    }

    service.add([notification({ id: 'problem', kind: 'deployed-run-failed' })]);
    expect(service.feed().length).toBe(1);
  });

  it('persists mutes and unmutes cleanly', () => {
    service.setMuted('orphan-deployment', true);
    expect(service.isMuted('orphan-deployment')).toBe(true);

    service.setMuted('orphan-deployment', true);
    expect(service.muted().filter(kind => kind === 'orphan-deployment').length)
      .withContext('muting twice must not store a duplicate')
      .toBe(1);

    service.setMuted('orphan-deployment', false);
    expect(service.isMuted('orphan-deployment')).toBe(false);
  });

  it('offers a label for every mutable kind', () => {
    // The settings block is generated from this list, so an entry with no label
    // would render a blank row rather than fail to compile.
    for (const entry of MUTABLE_NOTIFICATION_KINDS) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(isMutableKind(entry.kind)).toBe(true);
    }
  });

  // ── Workflow removal ──────────────────────────────────────────────────────

  it('drops every notification for a removed workflow', () => {
    service.add([
      notification({ id: 'a', workflowId: 'wf-gone' }),
      notification({ id: 'b', workflowId: 'wf-gone', at: 2_000 }),
      notification({ id: 'c', workflowId: 'wf-stays', at: 3_000 }),
    ]);

    service.dropWorkflow('wf-gone');

    expect(service.feed().map(entry => entry.id)).toEqual(['c']);
  });

  it('leaves draft notifications alone when a workflow is removed', () => {
    service.add([notification({ id: 'draft', workflowId: null })]);
    service.dropWorkflow('wf-anything');

    expect(service.feed().length).toBe(1);
  });

  // ── Property: the merge is a set union keyed on id ─────────────────────────

  it('Property: the feed is the id-keyed union of everything merged, newest first', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 4 }),
            at: fc.integer({ min: 1, max: 10_000 }),
          }),
          { minLength: 0, maxLength: 60 },
        ),
        batches => {
          const store = freshStore();
          for (const entry of batches) {
            store.add([notification({ id: entry.id, at: entry.at })]);
          }

          const ids = new Set(batches.map(entry => entry.id));
          // Size is the shape claim, and it holds for an empty feed - so it is
          // paired with two content claims below rather than left alone.
          expect(store.feed().length).toBe(Math.min(ids.size, NOTIFICATION_FEED_LIMIT));
          // Nothing invented, and every id really came from a merge.
          expect(store.feed().every(entry => ids.has(entry.id))).toBe(true);
          // And ordering holds across the WHOLE feed, not just its head.
          const times = store.feed().map(entry => entry.at);
          expect(times.every((value, index) => index === 0 || times[index - 1] >= value)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property: markAllRead clears the badge for any feed, whatever the timestamps', () => {
    fc.assert(
      fc.property(
        // Deliberately spanning both sides of now, because the interesting case is
        // a notification stamped by a worker whose clock runs AHEAD of this
        // machine: a cursor of `Date.now()` alone leaves that unread forever.
        fc.array(
          fc.integer({ min: Date.now() - 86_400_000, max: Date.now() + 86_400_000 }),
          { minLength: 0, maxLength: 30 },
        ),
        times => {
          const store = freshStore();
          times.forEach((at, index) => store.add([notification({ id: `n-${index}`, at })]));

          store.markAllRead();

          expect(store.unreadCount()).toBe(0);
          expect(store.hasUnreadProblem()).toBe(false);
          // The feed itself is untouched - reading is not dismissing.
          expect(store.feed().length).toBe(Math.min(new Set(times.map((_, i) => `n-${i}`)).size, NOTIFICATION_FEED_LIMIT));
        },
      ),
      { numRuns: 100 },
    );
  });
});

/** A store with empty storage behind it, for the property bodies. */
function freshStore(): NotificationsService {
  TestBed.resetTestingModule();
  for (const key of KEYS) localStorage.removeItem(key);
  TestBed.configureTestingModule({});
  return TestBed.inject(NotificationsService);
}

/** Kinds referenced above must all be real members of the union. */
const KIND_COVERAGE: readonly NotificationKind[] = [
  'deployed-run-failed',
  'deployed-run-completed',
  'deployed-run-stopped',
  'deployment-issue',
  'local-run-failed',
  'local-run-completed',
  'local-run-stopped',
  'orphan-deployment',
];
void KIND_COVERAGE;
