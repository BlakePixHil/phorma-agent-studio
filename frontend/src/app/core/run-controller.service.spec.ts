import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';

import { RunControllerService } from './run-controller.service';
import { RunHistoryService } from './run-history.service';
import { TauriService } from './tauri.service';
import { TerminalOutputService } from './terminal-output.service';
import { WorkflowService } from './workflow.service';
import { ToastService } from '../shared/toast/toast.service';
import type { HttpRequestNodeData } from './workflow.model';

/**
 * Requirements 17.9, 17.10, 17.15: a local run validates the active graph
 * against the local host's capability record and connection inventory
 * BEFORE `startRun` is ever reached. An `error` finding blocks the run
 * entirely — no run record is created and the run never reaches 'running'
 * — while a `warning`-only result never blocks it.
 */
describe('RunControllerService capability gating', () => {
  let runController: RunControllerService;
  let workflow: WorkflowService;
  let terminal: TerminalOutputService;
  let runHistory: RunHistoryService;
  let toast: ToastService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideNoopAnimations(), { provide: TauriService, useValue: { isDesktop: false } }],
    });
    runController = TestBed.inject(RunControllerService);
    workflow = TestBed.inject(WorkflowService);
    terminal = TestBed.inject(TerminalOutputService);
    runHistory = TestBed.inject(RunHistoryService);
    toast = TestBed.inject(ToastService);
    workflow.newWorkflow();
  });

  /** A manual trigger plus one http-request node referencing `connectionId`. */
  function buildGraph(connectionId: string): string {
    const trigger = workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
    const httpNode = workflow.addNodeFromCatalog('data-http-request', { x: 200, y: 0 });
    expect(trigger).toBeTruthy();
    expect(httpNode).toBeTruthy();
    workflow.updateNodeData(httpNode!.id, { connectionId } satisfies Partial<HttpRequestNodeData>);
    return httpNode!.id;
  }

  /** Polls until `predicate()` is true or the attempt budget runs out. */
  async function waitFor(predicate: () => boolean, attempts = 50): Promise<void> {
    for (let attempt = 0; attempt < attempts && !predicate(); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  it('blocks the run and creates no run record when a finding is severity error', async () => {
    buildGraph('conn-does-not-exist');
    const beginRunSpy = spyOn(runHistory, 'beginRun');
    const toastErrorSpy = spyOn(toast, 'error').and.callThrough();

    runController.start();
    // The validator's connection-inventory read is async; let it settle.
    await waitFor(() => terminal.phase() !== 'starting');

    expect(beginRunSpy).not.toHaveBeenCalled();
    expect(toastErrorSpy).toHaveBeenCalled();
    expect(runController.running()).toBeFalse();
    expect(terminal.phase()).toBe('idle');
    const problems = terminal.entries().filter(entry => entry.channel === 'problems');
    expect(problems.some(entry => entry.message.includes('conn-does-not-exist'))).toBeTrue();
  });

  it('does not block the run for a warning-only finding (non-static url)', async () => {
    const nodeId = buildGraph('');
    // A templated url is a warning (non-statically-determinable egress), not
    // an error — Requirement 17.15 says a warning alone never blocks a run.
    workflow.updateNodeData(nodeId, { url: '{{ base }}/items' } satisfies Partial<HttpRequestNodeData>);
    const beginRunSpy = spyOn(runHistory, 'beginRun').and.callThrough();

    runController.start();
    await waitFor(() => beginRunSpy.calls.count() > 0 || terminal.phase() === 'idle');

    expect(beginRunSpy).toHaveBeenCalled();
    runController.stop();
  });
});
