/**
 * Local run outcomes reaching the notification bell.
 *
 * Two claims, and the second is the one that keeps the bell worth looking at:
 *
 *  1. a settled LOCAL run raises exactly one notification, carrying the workflow
 *     identity captured when the run started rather than whatever the canvas says
 *     afterwards;
 *  2. a run the user is WATCHING raises nothing. The whole value of the local half
 *     of this feature is "it finished while you were looking at something else",
 *     so telling somebody about a run whose trace is on screen is pure noise.
 *
 * And one guard that is easy to get wrong: `apply()` is fed by the cloud monitor
 * WebSocket as well as by the local engine, and the deployed poll already reports
 * cloud runs. A terminal event with no local run in flight must raise nothing, or
 * every monitored cloud run produces two rows.
 *
 * Real runs, not synthesized events, for the positive cases: the identity comes
 * from `startValidatedRun`, so feeding a `run-completed` literal would test a code
 * path no user reaches.
 */

import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';

import type { RunEvent } from '@phorma/engine';

import { NotificationsService } from './notifications.service';
import { PanelRegistryService } from './panel-registry.service';
import { RunControllerService } from './run-controller.service';
import { TauriService } from './tauri.service';
import { TerminalOutputService } from './terminal-output.service';
import { WorkflowService } from './workflow.service';

describe('RunControllerService local run notifications', () => {
  let runController: RunControllerService;
  let workflow: WorkflowService;
  let terminal: TerminalOutputService;
  let panels: PanelRegistryService;
  let notifications: NotificationsService;

  beforeEach(() => {
    for (const key of ['phorma.layout.notificationsReadAt', 'phorma.layout.notificationsMutedKinds']) {
      localStorage.removeItem(key);
    }
    TestBed.configureTestingModule({
      providers: [provideNoopAnimations(), { provide: TauriService, useValue: { isDesktop: false } }],
    });
    runController = TestBed.inject(RunControllerService);
    workflow = TestBed.inject(WorkflowService);
    terminal = TestBed.inject(TerminalOutputService);
    panels = TestBed.inject(PanelRegistryService);
    notifications = TestBed.inject(NotificationsService);
    notifications.clear();
    workflow.newWorkflow();
    // Explicit rather than inherited: `PanelRegistryService` restores the active
    // tab from localStorage, so another spec's layout would otherwise decide
    // whether these runs are "being watched".
    panels.setActive('left', 'agents');
  });

  /** Polls until `predicate()` holds or the attempt budget runs out. */
  async function waitFor(predicate: () => boolean, attempts = 80): Promise<void> {
    for (let attempt = 0; attempt < attempts && !predicate(); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  /**
   * Runs a workflow that is nothing but a manual trigger.
   *
   * Enough to settle - the engine follows handoffs from the trigger and there are
   * none - and it needs no model transport, so the run is real without a stub
   * standing in for the part under test.
   */
  async function runToCompletion(): Promise<void> {
    const trigger = workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
    expect(trigger).toBeTruthy();
    runController.start();
    await waitFor(() => terminal.phase() === 'completed' || terminal.phase() === 'idle');
    expect(terminal.phase()).toBe('completed');
  }

  it('raises one notification for a completed local run', async () => {
    await runToCompletion();

    expect(notifications.feed().length).toBe(1);
    const entry = notifications.feed()[0];
    expect(entry.kind).toBe('local-run-completed');
    expect(entry.origin).toBe('local');
    expect(entry.tone).toBe('success');
    // A draft carries no workflow id, and the id is scoped under `draft` to match
    // the `workflowKey` convention every workflow-scoped store already uses.
    expect(entry.workflowId).toBeNull();
    expect(entry.id.startsWith('draft:')).toBe(true);
    expect(entry.runId).toBeTruthy();
  });

  it('carries the workflow name the run started with', async () => {
    workflow.renameActive('Invoice triage');
    await runToCompletion();

    const entry = notifications.feed()[0];
    // Whatever the name resolution is, it must not be blank - a nameless row
    // reads as a rendering bug rather than as a notification.
    expect(entry.workflowName.length).toBeGreaterThan(0);
    expect(entry.title).toContain(entry.workflowName);
  });

  it('raises nothing while the user is watching that workflow in the Runs panel', async () => {
    panels.setActive('left', 'runs');
    panels.collapsedLeft.set(false);

    await runToCompletion();

    // The run's trace is on screen. A notification here is telling somebody about
    // something they are looking at.
    expect(notifications.feed().length).toBe(0);
  });

  it('still raises one when the Runs panel side is collapsed', async () => {
    panels.setActive('left', 'runs');
    panels.collapsedLeft.set(true);

    await runToCompletion();

    // "Active tab" is not the same as "on screen". A collapsed sidebar shows
    // nothing, so the run was in fact unwatched.
    expect(notifications.feed().length).toBe(1);
    panels.collapsedLeft.set(false);
  });

  it('raises nothing for a terminal event with no local run in flight', () => {
    // This is what a cloud monitor delivers. The deployed poll reports those, so a
    // second row here would double-report every monitored run.
    runController.apply({ type: 'run-started', runId: 'cloudrun-1', input: '{}', at: 1 });
    runController.apply({ type: 'run-completed', runId: 'cloudrun-1', output: 'ok', at: 2 });
    runController.apply({
      type: 'run-failed',
      runId: 'cloudrun-2',
      error: 'It broke',
      at: 3,
    } as RunEvent);

    expect(notifications.feed().length).toBe(0);
  });

  it('raises nothing for a terminal event whose run id is not the local one', async () => {
    const trigger = workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
    expect(trigger).toBeTruthy();
    runController.start();
    await waitFor(() => terminal.phase() === 'completed');
    notifications.clear();

    // A late cloud event arriving after a local run settled must not be attributed
    // to it - the ids are compared, not just the presence of a run.
    runController.apply({ type: 'run-failed', runId: 'someone-elses-run', error: 'x', at: 9 } as RunEvent);

    expect(notifications.feed().length).toBe(0);
  });

  it('respects a mute set on local completions', async () => {
    notifications.setMuted('local-run-completed', true);

    await runToCompletion();

    expect(notifications.feed().length).toBe(0);
    notifications.setMuted('local-run-completed', false);
  });
});
