/**
 * The run-failed billing toast: does a hosted refusal reach the RIGHT remedy?
 *
 * This is the site where getting it wrong is most expensive, because the toast is
 * the only thing most users will ever read about a failed hosted run. Two claims
 * matter and both are checked against the real `apply()` path rather than the
 * classifier alone:
 *
 *  1. a CODED refusal picks the CTA that code earns, even when the message prose
 *     would have picked a different one (requirement 19);
 *  2. a CODE-LESS refusal from an older worker still picks its historical CTA
 *     through the prose fallback (requirement 20).
 *
 * _Requirements: 19, 20_
 */

import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';

import type { RunEvent } from '@phorma/engine';

import type { BillingRemedy } from './billing-refusal';
import { RunControllerService } from './run-controller.service';
import { TauriService } from './tauri.service';
import { WorkflowService } from './workflow.service';
import { BillingCtaService } from '../shared/billing/billing-cta.service';
import { ToastService, type ToastEntry } from '../shared/toast/toast.service';

describe('RunControllerService billing CTAs on run-failed', () => {
  let runController: RunControllerService;
  let toast: ToastService;
  let run: jasmine.Spy;

  beforeEach(() => {
    run = jasmine.createSpy('run');
    TestBed.configureTestingModule({
      providers: [
        provideNoopAnimations(),
        { provide: TauriService, useValue: { isDesktop: false } },
        // Stubbed because the real one reaches `ClerkService`. What it would DO
        // is `billing-cta.service`'s business; what it is HANDED is this one's.
        { provide: BillingCtaService, useValue: { run, updateCard: () => Promise.resolve(true) } },
      ],
    });
    runController = TestBed.inject(RunControllerService);
    toast = TestBed.inject(ToastService);
    TestBed.inject(WorkflowService).newWorkflow();
    toast.clear();
  });

  const RUN_ID = 'run-billing-spec';

  /** Feeds a terminal failure exactly as the engine or the cloud socket would. */
  function fail(error: string, code?: string): void {
    runController.apply({ type: 'run-started', runId: RUN_ID, input: '{}', at: 1 });
    runController.apply({ type: 'run-failed', runId: RUN_ID, error, code, at: 2 } as RunEvent);
  }

  function onlyToast(): ToastEntry {
    const entries = toast.entries();
    expect(entries.length).toBe(1);
    return entries[0];
  }

  /** Presses the toast's action and reports the remedy it dispatched. */
  function pressCta(): BillingRemedy | undefined {
    onlyToast().action?.onClick();
    return run.calls.mostRecent()?.args[0] as BillingRemedy | undefined;
  }

  // ── The code decides (requirement 19) ─────────────────────────────────────

  it('sends a past-due run to the card, never to a top-up or a plan', () => {
    // Note the prose: it contains "subscription", "payment failed" and a 402,
    // and the pre-code studio's narrow regex raised NO toast for it at all
    // while the builder's broad one raised "Buy credits". The code settles it.
    fail(
      'Phorma Cloud request failed (402): Your last Phorma Cloud payment failed. Update your card in Settings > Cloud to resume hosted runs.',
      'subscription_past_due',
    );

    const entry = onlyToast();
    expect(entry.action?.label).toBe('Update card');
    expect(entry.detail).toContain('still here');
    expect(pressCta()).toBe('update-card');
  });

  it('keeps credits_exhausted on the existing Buy credits toast', () => {
    fail('Phorma Cloud request failed (402): Monthly credits exhausted.', 'credits_exhausted');

    expect(onlyToast().summary).toBe('Monthly credits exhausted');
    expect(pressCta()).toBe('buy-credits');
  });

  it('sends an unsubscribed tenant to the plan cards', () => {
    fail(
      'Phorma Cloud request failed (402): No active Phorma Cloud subscription.',
      'no_subscription',
    );

    expect(onlyToast().action?.label).toBe('View plans');
    expect(pressCta()).toBe('subscribe');
  });

  it('treats a spent run allowance as a limit, not a purchase failure', () => {
    // A 429, not a 402. The copy leads with the free remedy - next month - and
    // the button is a deep link to the plan cards, never a checkout.
    fail('Monthly run limit reached (100). Resets next month.', 'runs_exhausted');

    const entry = onlyToast();
    expect(entry.summary).toBe('Monthly run limit reached');
    expect(entry.detail).toContain('Resets next month');
    expect(pressCta()).toBe('upgrade-plan');
  });

  it('offers NO purchase when the fault is ours', () => {
    fail('Phorma Cloud is not provisioned for this account.', 'no_runtime_key');

    const entry = onlyToast();
    expect(entry.action).toBeUndefined();
    expect(entry.detail).toContain('nothing to buy');
  });

  it('shows nothing extra for a token this build has never heard of', () => {
    // A newer worker. The console still carries the message; the studio does not
    // invent a CTA for a remedy it does not know, and above all does not fall
    // back to prose that would have said "Buy credits".
    fail('Phorma Cloud request failed (402): Your subscription needs attention.', 'card_expired');

    expect(toast.entries().length).toBe(0);
  });

  // ── The prose fallback stays live (requirement 20) ────────────────────────

  it('still raises Buy credits for a CODE-LESS refusal from an older worker', () => {
    fail('Phorma Cloud request failed (402): Monthly credits exhausted (500 credits).');

    expect(onlyToast().action?.label).toBe('Buy credits');
    expect(pressCta()).toBe('buy-credits');
  });

  it('leaves an ordinary failure toast-free, as before', () => {
    fail('Ollama is not running on port 11434.');

    expect(toast.entries().length).toBe(0);
  });

  it('raises ONE toast for a refusal that failed several nested frames', () => {
    // A propagating failure emits `node-failed` per ancestor frame. Only the
    // terminal event raises the toast, or a nested workflow would stack one per
    // frame for a single wall.
    runController.apply({ type: 'run-started', runId: RUN_ID, input: '{}', at: 1 });
    for (const nodeId of ['child-1', 'exec-1']) {
      runController.apply({
        type: 'node-failed',
        runId: RUN_ID,
        nodeId,
        nodeName: nodeId,
        error: 'Monthly credits exhausted.',
        code: 'credits_exhausted',
        at: 2,
      } as RunEvent);
    }
    runController.apply({
      type: 'run-failed',
      runId: RUN_ID,
      error: 'Monthly credits exhausted.',
      code: 'credits_exhausted',
      at: 3,
    } as RunEvent);

    expect(toast.entries().length).toBe(1);
  });
});
