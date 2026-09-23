import { ComponentFixture, TestBed } from '@angular/core/testing';
import fc from 'fast-check';

import { CloudLibrary } from './cloud-library';
import { DesktopAuthService } from '../../core/desktop-auth.service';
import { DeploymentsService } from '../../core/deployments.service';
import { PhormaCloudService } from '../../core/phorma-cloud.service';
import { SettingsService } from '../../core/settings.service';
import { WorkflowService } from '../../core/workflow.service';
import { ToastService } from '../../shared/toast/toast.service';
import { WORKFLOW_SPEC_VERSION, type WorkflowSpec } from '../../core/workflow.model';
import type { DeploymentSummary } from '../../core/deployments.model';

/**
 * The Cloud_Library surface (multi-organisation Requirements 9.1, 9.2, 9.8;
 * Properties 18, 19).
 *
 * Driven through the REAL `DeploymentsService` with `fetch` stubbed, rather than a
 * stubbed service: Requirement 9.8 is a claim about how a TRANSPORT failure reaches
 * the screen, and a stub that sets `error()` itself would be asserting the stub's
 * own classification. `WorkflowService` IS stubbed, because what the open must do
 * with the spec it read is pinned against the real service in
 * `core/workflow.service.deployed.spec.ts`.
 */
describe('CloudLibrary', () => {
  /** One recorded outbound request. */
  interface Recorded {
    url: string;
    method: string;
  }

  let fixture: ComponentFixture<CloudLibrary>;
  let deployments: DeploymentsService;
  let log: Recorded[];
  /** The next response each request gets, in order. Empty = a 200 empty list. */
  let responses: { status: number; body: unknown }[];
  /** When set, `fetch` rejects instead - a network loss, not an HTTP answer. */
  let networkError: Error | null;
  let openDeployedSpec: jasmine.Spy;
  let fetchSpy: jasmine.Spy;

  function summary(overrides: Partial<DeploymentSummary> = {}): DeploymentSummary {
    return {
      workflowId: 'wf-org-one',
      workflowName: 'Invoice triage',
      deployedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_100_000,
      specHash: 'abc123',
      cronArmed: false,
      portalSlug: null,
      creditsSpent: 4,
      runsThisMonth: 2,
      ...overrides,
    };
  }

  function deployedSpec(id = 'wf-org-one'): WorkflowSpec {
    return {
      version: WORKFLOW_SPEC_VERSION,
      id,
      name: 'Invoice triage',
      graph: { nodes: [], connections: [] },
      savedAt: '2026-09-01T09:00:00.000Z',
    };
  }

  /** Visible elements only: both sidebars render a duplicate pane instance. */
  function visible(selector: string, root: ParentNode = document): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>(selector)].filter(
      element => element.getBoundingClientRect().width > 0,
    );
  }

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  function hasFailure(): boolean {
    return visible('.phorma-cloud-library__failure', fixture.nativeElement).length > 0;
  }

  function hasEmptyState(): boolean {
    return visible('.phorma-cloud-library__placeholder', fixture.nativeElement).length > 0;
  }

  /**
   * Lets the refresh the constructor effect started actually finish.
   *
   * `whenStable()` alone is not enough here: the request chain runs through the
   * shared dispatcher and the stubbed bearer, so it settles over several macrotask
   * turns, and a component asserted too early is still rendering its loading note.
   */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 10; turn += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    log = [];
    responses = [];
    networkError = null;
    openDeployedSpec = jasmine.createSpy('openDeployedSpec');

    fetchSpy = spyOn(globalThis, 'fetch').and.callFake(async (input, init) => {
      log.push({ url: String(input), method: init?.method ?? 'GET' });
      if (networkError) throw networkError;
      const next = responses.shift() ?? {
        status: 200,
        body: { month: '2026-09', deployments: [] },
      };
      return new Response(JSON.stringify(next.body), { status: next.status });
    });

    TestBed.configureTestingModule({
      providers: [
        {
          provide: PhormaCloudService,
          useValue: { signedIn: () => true, sessionToken: async () => 'clerk-jwt' },
        },
        { provide: DesktopAuthService, useValue: { token: async () => null } },
        {
          // An empty library: a member has no local data at all, which is the
          // state Requirement 9.1 describes.
          provide: WorkflowService,
          useValue: { library: () => [], restoreSpec: async () => 'restored', openDeployedSpec },
        },
        {
          provide: ToastService,
          useValue: { success: () => undefined, error: () => undefined, warning: () => undefined },
        },
        { provide: SettingsService, useValue: { cloudProvider: () => 'aws' } },
      ],
    });
    deployments = TestBed.inject(DeploymentsService);
  });

  // ── The list (Requirement 9.1) ────────────────────────────────────────────

  it('lists the organisation deployments for a member with no local library', async () => {
    responses = [
      {
        status: 200,
        body: { month: '2026-09', deployments: [summary(), summary({ workflowId: 'wf-org-two', workflowName: 'Payroll check', cronArmed: true })] },
      },
    ];

    fixture = TestBed.createComponent(CloudLibrary);
    fixture.detectChanges();
    await settle();

    expect(log.filter(entry => entry.url.endsWith('/api/deployments')).length)
      .withContext('the list comes from GET /api/deployments through DeploymentsService')
      .toBe(1);
    const titles = visible('.phorma-card__title', fixture.nativeElement).map(el => el.textContent?.trim());
    expect(titles).toEqual(['Invoice triage', 'Payroll check']);
    expect(hasEmptyState()).toBeFalse();
    expect(hasFailure()).toBeFalse();
    // Credits, never dollars.
    expect(text()).toContain('4 credits this month');
    expect(text()).toContain('Scheduled');
  });

  it('renders the empty state only for a completed read that found nothing', async () => {
    fixture = TestBed.createComponent(CloudLibrary);
    fixture.detectChanges();
    await settle();

    expect(hasEmptyState()).toBeTrue();
    expect(hasFailure()).toBeFalse();
  });

  it('says spend is unavailable rather than zero when the worker binds no ledger', async () => {
    responses = [
      {
        status: 200,
        body: { month: '2026-09', deployments: [summary({ creditsSpent: null, runsThisMonth: null })] },
      },
    ];

    fixture = TestBed.createComponent(CloudLibrary);
    fixture.detectChanges();
    await settle();

    expect(text()).toContain('spend unavailable');
    expect(text()).not.toContain('0 credits');
  });

  // ── The open (Requirements 9.2, 9.3) ──────────────────────────────────────

  it('opens the DEPLOYED spec, read off the instance, by its own id', async () => {
    responses = [
      { status: 200, body: { month: '2026-09', deployments: [summary()] } },
      // `GET /workflow` answers `{ spec, savedAt }`, which the route table unwraps.
      { status: 200, body: { spec: deployedSpec(), savedAt: '2026-09-01T09:00:00.000Z' } },
    ];

    fixture = TestBed.createComponent(CloudLibrary);
    fixture.detectChanges();
    await settle();

    visible('.phorma-card', fixture.nativeElement)[0].click();
    await settle();

    const specRead = log.find(entry => entry.url.endsWith('/workflow'));
    expect(specRead)
      .withContext('the spec must be read from the workflow instance, not from the list row')
      .toBeDefined();
    expect(specRead!.url).toContain('wf-org-one');
    expect(openDeployedSpec).toHaveBeenCalledTimes(1);
    expect(openDeployedSpec.calls.mostRecent().args[0].id).toBe('wf-org-one');
  });

  it('opens nothing when the deployed spec cannot be read', async () => {
    responses = [
      { status: 200, body: { month: '2026-09', deployments: [summary()] } },
      { status: 404, body: { error: 'Nothing is deployed.' } },
    ];

    fixture = TestBed.createComponent(CloudLibrary);
    fixture.detectChanges();
    await settle();

    visible('.phorma-card', fixture.nativeElement)[0].click();
    await settle();

    expect(openDeployedSpec).not.toHaveBeenCalled();
  });

  // ── Duplicate pane instances ──────────────────────────────────────────────

  it('keeps element ids unique with two instances of the pane in the DOM', async () => {
    responses = [{ status: 200, body: { month: '2026-09', deployments: [summary()] } }];

    fixture = TestBed.createComponent(CloudLibrary);
    fixture.detectChanges();
    await settle();

    // Angular's test renderer detaches the previous root when a second fixture is
    // created, so the first host is re-appended by hand - otherwise there is only
    // ever one instance in the document and the duplicate hazard is not reproduced.
    const firstHost = fixture.nativeElement as HTMLElement;
    const second = TestBed.createComponent(CloudLibrary);
    document.body.appendChild(firstHost);
    second.detectChanges();
    fixture.detectChanges();
    await second.whenStable();
    second.detectChanges();

    try {
      expect(visible('.phorma-cloud-library', document).length)
        .withContext('both pane instances should be rendered and visible')
        .toBe(2);
      const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
      expect(ids.length)
        .withContext(`duplicate element id(s): ${ids.filter((id, index) => ids.indexOf(id) !== index).join(', ')}`)
        .toBe(new Set(ids).size);
    } finally {
      second.destroy();
    }
  });

  // ── Property 19 ───────────────────────────────────────────────────────────

  /**
   * Property 19: for ANY transport failure - a refusal, a server error or a network
   * loss - the failure is rendered and the empty state never is.
   *
   * The fixture and the `fetch` spy are hoisted out of the property: jasmine allows
   * one `spyOn` per property per spec, and `TestBed.configureTestingModule` throws
   * once the module is instantiated. Each iteration re-arms the response instead.
   *
   * **Validates: Requirements 9.8**
   */
  it('reports every failure and never presents an empty organisation', async () => {
    fixture = TestBed.createComponent(CloudLibrary);
    fixture.detectChanges();
    await settle();
    // The opening read succeeded with nothing, so the empty state is on screen -
    // which is what makes each iteration's assertion meaningful rather than vacuous.
    expect(hasEmptyState())
      .withContext('the empty state should be reachable at all')
      .toBeTrue();

    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.record({
            kind: fc.constant('refusal' as const),
            status: fc.constantFrom(401, 403, 404),
          }),
          fc.record({
            kind: fc.constant('server' as const),
            status: fc.constantFrom(500, 502, 503),
          }),
          fc.record({ kind: fc.constant('network' as const), status: fc.constant(0) }),
        ),
        async failure => {
          networkError =
            failure.kind === 'network' ? new TypeError('Failed to fetch') : null;
          responses =
            failure.kind === 'network'
              ? []
              : [{ status: failure.status, body: { error: 'Refused.' } }];

          await deployments.refresh();
          fixture.detectChanges();

          if (deployments.error() === null) {
            throw new Error(`a ${failure.kind} (${failure.status}) was not recorded as a failure`);
          }
          if (!hasFailure()) throw new Error(`the ${failure.kind} failure was not rendered`);
          if (hasEmptyState()) {
            throw new Error(`a ${failure.kind} rendered the empty state`);
          }
          return true;
        },
      ),
      { numRuns: 40 },
    );

    expect(fetchSpy).toHaveBeenCalled();
  });
});
