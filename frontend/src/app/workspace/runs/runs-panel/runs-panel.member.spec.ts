import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';

import { RunsPanel } from './runs-panel';
import { CapabilityService } from '../../../core/capability.service';
import { RunControllerService } from '../../../core/run-controller.service';
import { TauriService } from '../../../core/tauri.service';
import type { CapabilityLevel } from '../../../core/capabilities';
import type { RunRecordUsage } from '@phorma/engine';

/**
 * The surface a member answers a gate on, and the cost it shows them
 * (multi-organisation Requirements 10.4, 10.7, 17.4; Property 38).
 *
 * Driven through the RENDERED panel rather than the component's methods, because
 * the claim is that the button a member clicks reaches the deployment: the pending
 * card is synthesized by `RunControllerService.apply` from a RunEvent the monitor
 * relayed, and its Approve resolves over the remote sender `CloudService` installed
 * when the socket opened. Calling `resolveApproval` directly would skip exactly the
 * part that can be wrong.
 *
 * A note on the browser: this repo has NO Playwright install (`docs/e2e-testing.md`
 * names `scripts/cdp.mjs` as the driver, which needs a running dev server and a
 * system Chrome). These assertions are the karma equivalent of the browser check
 * task 9 asks for - a real render, a real click through the real component, and the
 * duplicate-pane filter a browser test would need for the same reason.
 */
describe('The approval surface a member uses', () => {
  let fixture: ComponentFixture<RunsPanel>;
  let runController: RunControllerService;
  let capability: CapabilityService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RunsPanel],
      providers: [provideNoopAnimations(), { provide: TauriService, useValue: { isDesktop: false } }],
    }).compileComponents();

    runController = TestBed.inject(RunControllerService);
    capability = TestBed.inject(CapabilityService);
    fixture = TestBed.createComponent(RunsPanel);
    fixture.detectChanges();
  });

  /**
   * Visible elements only. Both sidebars receive every pane template, so two
   * instances of this panel body are in the DOM at once and a plain
   * `querySelector` can hit the hidden one with a zero rect.
   */
  function visible(selector: string): HTMLElement[] {
    return [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(selector)].filter(
      element => element.getBoundingClientRect().width > 0,
    );
  }

  /** The gate arriving the way a member's does: over the monitor, as a RunEvent. */
  function relayApprovalRequired(requestId: string): void {
    runController.apply({
      type: 'approval-required',
      runId: 'cloudrun-member-1',
      requestId,
      nodeId: 'gate',
      message: 'Post the June journal?',
      payload: '{"period":"2026-06"}',
      at: Date.now(),
    });
    fixture.detectChanges();
  }

  it('renders a card for a gate relayed from the deployment, and approves over the socket', () => {
    capability.resolveFrom('operator');
    const sent: { requestId: string; approved: boolean }[] = [];
    runController.remoteApprovalSender = (requestId, approved) => sent.push({ requestId, approved });

    relayApprovalRequired('approval:gate|abc|0');

    const cards = visible('.phorma-runs__approval');
    expect(cards.length).withContext('one card, in the visible pane instance').toBe(1);
    expect(cards[0].textContent).toContain('Post the June journal?');
    // Product rule: Tabler icons only.
    const icons = [...cards[0].querySelectorAll('i')].map(icon => icon.className);
    expect(icons.length).toBeGreaterThan(0);
    expect(icons.every(name => name.includes('ti '))).toBeTrue();
    expect(icons.some(name => name.includes('pi-'))).toBeFalse();

    const approve = visible('.phorma-runs__btn--approve')[0];
    expect(approve.textContent).toContain('Approve');
    approve.click();
    fixture.detectChanges();

    expect(sent)
      .withContext('the click reached the deployment, not a local resolver')
      .toEqual([{ requestId: 'approval:gate|abc|0', approved: true }]);
    expect(runController.pendingApprovals().length)
      .withContext('and the card is gone, so it cannot be answered twice')
      .toBe(0);
    expect(visible('.phorma-runs__approval').length).toBe(0);
  });

  it('sends a rejection as a rejection', () => {
    capability.resolveFrom('operator');
    const sent: { requestId: string; approved: boolean }[] = [];
    runController.remoteApprovalSender = (requestId, approved) => sent.push({ requestId, approved });

    relayApprovalRequired('approval:gate|abc|1');
    const buttons = visible('.phorma-runs__approval-actions button');
    const reject = buttons.find(button => button.textContent?.includes('Reject'));
    expect(reject).withContext('both outcomes are offered').toBeTruthy();
    reject!.click();

    expect(sent).toEqual([{ requestId: 'approval:gate|abc|1', approved: false }]);
  });

  it('scopes every rendered id, so two pane instances cannot collide', () => {
    capability.resolveFrom('operator');
    relayApprovalRequired('approval:gate|abc|2');

    const ids = [...(fixture.nativeElement as HTMLElement).querySelectorAll('[id]')].map(
      element => element.id,
    );
    expect(ids.length).toBe(new Set(ids).size);
  });

  // ── Requirement 10.7 / Property 38: credits, never dollars ────────────────

  describe('the cost split holds for a member exactly as for a builder', () => {
    function usage(costUsd: number, phormaCloudCostUsd?: number): RunRecordUsage {
      return {
        inputTokens: 1_000,
        outputTokens: 500,
        costUsd,
        ...(phormaCloudCostUsd === undefined ? {} : { phormaCloudCostUsd }),
      };
    }

    function costParts(level: CapabilityLevel, value: RunRecordUsage) {
      capability.resolveFrom(level);
      fixture.detectChanges();
      return (
        fixture.componentInstance as unknown as {
          costParts(u: RunRecordUsage): { credits: number | null; usd: number | null; estimated: boolean };
        }
      ).costParts(value);
    }

    it('renders a fully cloud-billed run as credits with no dollar figure at all', () => {
      const parts = costParts('operator', usage(0.04, 0.04));
      expect(parts.credits).toBeGreaterThan(0);
      expect(parts.usd).withContext('the Phorma Cloud share is never dollars').toBeNull();
    });

    it('renders only the BYO share in dollars', () => {
      const parts = costParts('operator', usage(0.05, 0.02));
      expect(parts.credits).toBeGreaterThan(0);
      expect(parts.usd).toBeCloseTo(0.03, 10);
    });

    it('answers identically at every level - the split is not a capability', () => {
      const levels: CapabilityLevel[] = ['operator', 'editor', 'builder', 'admin'];
      const cases = [usage(0.04, 0.04), usage(0.05, 0.02), usage(0.01), usage(0)];
      for (const value of cases) {
        const answers = levels.map(level => JSON.stringify(costParts(level, value)));
        expect(new Set(answers).size)
          .withContext(`one answer for ${JSON.stringify(value)}, got ${answers.join(' | ')}`)
          .toBe(1);
      }
    });

    it('reads a record with no split as BYO dollars, which is what it was', () => {
      const parts = costParts('operator', usage(0.01));
      expect(parts.credits).toBeNull();
      expect(parts.usd).toBeCloseTo(0.01, 10);
    });
  });
});
