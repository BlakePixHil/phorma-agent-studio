/**
 * `DeploymentsService` - the Reconciliation_List (cloud-workflow-backup Phase 1).
 *
 * Three things here are worth pinning, and none of them is obvious from reading
 * the file:
 *
 * 1. **A failed refresh must KEEP the previous rows.** The one answer that would
 *    defeat this whole surface is an empty list: a user who came looking for
 *    unexplained spend and is told "you have no deployments" stops looking
 *    (Requirement 6.7). Offline is not proof of absence.
 *
 * 2. **Orphan marking is a live join, not a snapshot.** The row's `orphan` flag
 *    comes from a `computed` over `WorkflowService.library()`, so restoring an
 *    orphan clears its badge with no second network call. A snapshot taken at
 *    refresh time would leave the badge stale until the next poll.
 *
 * 3. **The request is pinned to Phorma Cloud, not to the chosen deploy target.**
 *    A subscriber deploying to AWS still has a Phorma Cloud account, and their
 *    deployment list lives on the hosted worker. Asserted through the URL,
 *    because that is the only place the mistake would show.
 */

import { TestBed } from '@angular/core/testing';

import { DesktopAuthService } from './desktop-auth.service';
import { DeploymentsService } from './deployments.service';
import { PhormaCloudService } from './phorma-cloud.service';
import { SettingsService } from './settings.service';
import { WorkflowService } from './workflow.service';
import { PHORMA_CLOUD_DEFAULT_URL } from './phorma-cloud-url';
import { ToastService } from '../shared/toast/toast.service';
import { WORKFLOW_SPEC_VERSION, type WorkflowSpec } from './workflow.model';
import type { DeploymentSummary } from './deployments.model';

/** One recorded outbound request. */
interface Recorded {
  url: string;
  method: string;
  authorization: string | null;
}

function summary(overrides: Partial<DeploymentSummary> = {}): DeploymentSummary {
  return {
    workflowId: 'wf-one',
    workflowName: 'Invoice triage',
    deployedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    specHash: 'abc123',
    cronArmed: false,
    portalSlug: null,
    creditsSpent: 0,
    runsThisMonth: 0,
    ...overrides,
  };
}

function librarySpec(id: string, name: string): WorkflowSpec {
  return {
    version: WORKFLOW_SPEC_VERSION,
    id,
    name,
    savedAt: '2026-01-01T00:00:00.000Z',
    graph: { nodes: [], connections: [] },
  };
}

describe('DeploymentsService', () => {
  let service: DeploymentsService;
  let library: WorkflowSpec[];
  let log: Recorded[];
  /** The next response each request gets, in order. */
  let responses: { status: number; body: unknown }[];
  let restoreSpec: jasmine.Spy;
  let toastError: jasmine.Spy;
  let toastSuccess: jasmine.Spy;

  /**
   * Swaps the library the stub reports. The stub closes over the VARIABLE, so
   * reassigning it is enough - and `deployments` is a `computed`, so the rows
   * re-derive on the next read rather than needing a refresh.
   */
  function setLibrary(specs: WorkflowSpec[]): void {
    library = specs;
  }

  /**
   * The one request this spec is about, found by method rather than by position.
   *
   * `log[0]` used to be read directly, and that quietly assumed no OTHER service in
   * the root injector issues a request in the same window - which nothing sharing an
   * injector can promise. It made these two specs FLAKY and, worse, made them blame
   * `DeploymentsService` for a stray request from elsewhere in the suite. Asserting
   * that exactly one request of this method happened is strictly stronger than
   * asserting the first one was it.
   */
  function only(method: string): Recorded {
    const matching = log.filter(entry => entry.method === method);
    expect(matching.length)
      .withContext(`expected exactly one ${method}, saw: ${log.map(e => `${e.method} ${e.url}`).join(', ')}`)
      .toBe(1);
    return matching[0];
  }

  beforeEach(() => {
    library = [];
    log = [];
    responses = [];
    restoreSpec = jasmine.createSpy('restoreSpec').and.resolveTo('restored');
    toastError = jasmine.createSpy('error');
    toastSuccess = jasmine.createSpy('success');

    spyOn(globalThis, 'fetch').and.callFake(async (input, init) => {
      log.push({
        url: String(input),
        method: init?.method ?? 'GET',
        authorization: new Headers(init?.headers).get('Authorization'),
      });
      const next = responses.shift() ?? { status: 200, body: { month: '2026-09', deployments: [] } };
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
          provide: WorkflowService,
          useValue: { library: () => library, restoreSpec },
        },
        {
          provide: ToastService,
          useValue: { success: toastSuccess, error: toastError, warning: () => undefined },
        },
        { provide: SettingsService, useValue: { cloudProvider: () => 'aws' } },
      ],
    });
    service = TestBed.inject(DeploymentsService);
  });

  // ── Refresh ───────────────────────────────────────────────────────────────

  it('reads the hosted control plane, not the chosen deploy target', async () => {
    // `cloudProvider` is 'aws' above on purpose: a provider-dependent dispatcher
    // would send this to the AWS Trigger_API, or nowhere at all.
    responses = [{ status: 200, body: { month: '2026-09', deployments: [summary()] } }];

    await service.refresh();

    expect(log.length).toBe(1);
    expect(log[0].url).toBe(`${PHORMA_CLOUD_DEFAULT_URL}/api/deployments`);
    expect(log[0].method).toBe('GET');
    expect(log[0].authorization).toBe('Bearer clerk-jwt');
    expect(service.month()).toBe('2026-09');
    expect(service.deployments().length).toBe(1);
    expect(service.error()).toBeNull();
    expect(service.loaded()).toBeTrue();
  });

  it('keeps the previous rows when a refresh fails (6.7)', async () => {
    responses = [{ status: 200, body: { month: '2026-09', deployments: [summary()] } }];
    await service.refresh();
    expect(service.deployments().length).toBe(1);

    responses = [{ status: 503, body: { error: 'Control plane unavailable.' } }];
    await service.refresh();

    expect(service.deployments().length)
      .withContext('an offline control plane must not read as "no deployments"')
      .toBe(1);
    expect(service.error()).toBe('Control plane unavailable.');
    expect(service.loading()).toBeFalse();
  });

  it('issues no request and lists nothing while signed out', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: PhormaCloudService,
          useValue: { signedIn: () => false, sessionToken: async () => null },
        },
        { provide: DesktopAuthService, useValue: { token: async () => null } },
        { provide: WorkflowService, useValue: { library: () => [], restoreSpec } },
        {
          provide: ToastService,
          useValue: { success: toastSuccess, error: toastError, warning: () => undefined },
        },
      ],
    });
    const signedOut = TestBed.inject(DeploymentsService);

    await signedOut.refresh();

    expect(log.length).toBe(0);
    expect(signedOut.deployments()).toEqual([]);
    expect(signedOut.loaded()).toBeTrue();
  });

  it('prefers the desktop device token over a Clerk session', async () => {
    // The measured order from `CloudService.resolveAuthToken`: a packaged build
    // never loads a Clerk session, so a Clerk-first order sent every request with
    // no Authorization header at all and the hosted worker failed them closed.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: PhormaCloudService,
          useValue: { signedIn: () => true, sessionToken: async () => 'clerk-jwt' },
        },
        { provide: DesktopAuthService, useValue: { token: async () => 'phd_device' } },
        { provide: WorkflowService, useValue: { library: () => [], restoreSpec } },
        {
          provide: ToastService,
          useValue: { success: toastSuccess, error: toastError, warning: () => undefined },
        },
      ],
    });

    await TestBed.inject(DeploymentsService).refresh();

    expect(log[0].authorization).toBe('Bearer phd_device');
  });

  // ── Orphan marking ────────────────────────────────────────────────────────

  it('marks a deployment with no local counterpart as an orphan', async () => {
    setLibrary([librarySpec('wf-local', 'Kept locally')]);
    responses = [
      {
        status: 200,
        body: {
          month: '2026-09',
          deployments: [
            summary({ workflowId: 'wf-local', workflowName: 'Kept locally' }),
            summary({ workflowId: 'wf-gone', workflowName: 'Nightly report' }),
          ],
        },
      },
    ];

    await service.refresh();

    const rows = service.deployments();
    expect(rows.find(row => row.workflowId === 'wf-local')!.orphan).toBeFalse();
    expect(rows.find(row => row.workflowId === 'wf-gone')!.orphan).toBeTrue();
    expect(service.orphanCount()).toBe(1);
  });

  it('reports a local name that has drifted from the deployed one', async () => {
    setLibrary([librarySpec('wf-one', 'Renamed locally')]);
    responses = [
      { status: 200, body: { month: '2026-09', deployments: [summary({ workflowName: 'Old name' })] } },
    ];

    await service.refresh();

    expect(service.deployments()[0].localName).toBe('Renamed locally');
  });

  it('surfaces an armed schedule, which is what spends credits unattended', async () => {
    responses = [
      { status: 200, body: { month: '2026-09', deployments: [summary({ cronArmed: true })] } },
    ];
    await service.refresh();
    expect(service.hasArmedCron()).toBeTrue();
  });

  it('carries a null spend through as null, never as zero', async () => {
    // A BYO worker binds no D1, so it cannot report spend. Rendering that as 0
    // would tell a user a runaway cron deployment costs nothing.
    responses = [
      {
        status: 200,
        body: {
          month: '2026-09',
          deployments: [summary({ creditsSpent: null, runsThisMonth: null })],
        },
      },
    ];
    await service.refresh();
    expect(service.deployments()[0].creditsSpent).toBeNull();
    expect(service.deployments()[0].runsThisMonth).toBeNull();
  });

  // ── Read back and restore ─────────────────────────────────────────────────

  it('reads the deployed spec off its own instance', async () => {
    const spec = librarySpec('wf-one', 'Deployed copy');
    responses = [{ status: 200, body: { spec, savedAt: '2026-09-01T00:00:00.000Z' } }];

    const read = await service.readDeployedSpec('wf-one');

    expect(read?.id).toBe('wf-one');
    expect(log[0].url).toBe(
      `${PHORMA_CLOUD_DEFAULT_URL}/agents/workflow-agent/wf-one/workflow`,
    );
  });

  it('explains a 404 read-back in terms of the deployment, not the status', async () => {
    responses = [{ status: 404, body: { error: 'Nothing is deployed on this instance.' } }];

    expect(await service.readDeployedSpec('wf-one')).toBeNull();
    expect(toastError).toHaveBeenCalled();
    expect(toastError.calls.mostRecent().args[1]).toContain('Nothing is deployed');
  });

  it('restores through the identity-preserving rail (7.7)', async () => {
    const spec = librarySpec('wf-one', 'Deployed copy');
    responses = [{ status: 200, body: { spec } }];

    const outcome = await service.restoreToLibrary('wf-one');

    expect(outcome).toBe('restored');
    // `restoreSpec`, never `importSpec`: an import mints a new id and the restored
    // copy would stop addressing its own deployment.
    expect(restoreSpec).toHaveBeenCalled();
    expect(restoreSpec.calls.mostRecent().args[0].id).toBe('wf-one');
    expect(service.busyWorkflowId()).toBeNull();
  });

  // ── Undeploy and purge ────────────────────────────────────────────────────

  it('undeploys through DELETE /workflow and drops the row', async () => {
    responses = [{ status: 200, body: { month: '2026-09', deployments: [summary()] } }];
    await service.refresh();
    log.length = 0;

    responses = [{ status: 200, body: { ok: true } }];
    expect(await service.undeploy('wf-one')).toBeTrue();

    expect(only('DELETE').url).toBe(
      `${PHORMA_CLOUD_DEFAULT_URL}/agents/workflow-agent/wf-one/workflow`,
    );
    expect(service.deployments()).toEqual([]);
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('purges through DELETE /workflow/purge and drops the row', async () => {
    responses = [{ status: 200, body: { month: '2026-09', deployments: [summary()] } }];
    await service.refresh();
    log.length = 0;

    responses = [{ status: 200, body: { ok: true, purged: true } }];
    expect(await service.purge('wf-one')).toBeTrue();

    expect(only('DELETE').url).toBe(
      `${PHORMA_CLOUD_DEFAULT_URL}/agents/workflow-agent/wf-one/workflow/purge`,
    );
    expect(service.deployments()).toEqual([]);
  });

  it('surfaces the worker 409 verbatim and keeps the row (7.5)', async () => {
    responses = [{ status: 200, body: { month: '2026-09', deployments: [summary()] } }];
    await service.refresh();

    responses = [
      { status: 409, body: { error: 'Stop the running run before removing this workflow.' } },
    ];
    expect(await service.undeploy('wf-one')).toBeFalse();

    // The worker knows why it refused; paraphrasing it would lose the remedy.
    expect(toastError.calls.mostRecent().args[1]).toBe(
      'Stop the running run before removing this workflow.',
    );
    expect(service.deployments().length)
      .withContext('a failed undeploy must not remove the row')
      .toBe(1);
    expect(service.busyWorkflowId()).toBeNull();
  });
});
