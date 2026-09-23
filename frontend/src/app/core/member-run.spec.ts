import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ClerkService } from 'ngx-clerk';
import { ReplaySubject } from 'rxjs';

import { CapabilityService } from './capability.service';
import { CloudService } from './cloud.service';
import { ConnectionStoreService } from './connection-store.service';
import { RunControllerService } from './run-controller.service';
import { SettingsService } from './settings.service';
import { TauriService } from './tauri.service';
import { TerminalOutputService } from './terminal-output.service';
import { WorkflowService } from './workflow.service';
import { describeRunEvent } from './run-trace';
import type { RunLogEvent } from '@phorma/engine';

/**
 * A member's Run: where it goes, what it addresses, and what the trace says about
 * who answered a gate (multi-organisation Requirements 10.1, 10.2, 10.3, 10.5;
 * Property 20's studio half).
 *
 * The defect these exist against is not a crash. A Cloud_Library session never
 * picks a deploy target, so before this feature `CloudService.configured()`
 * answered false for it and `effectiveWorkerUrl()` answered the empty BYO worker
 * URL - which made Run start a LOCAL run of a read-only deployed spec, in a browser
 * holding no provider credential. That fails, spends nothing, and reads as though
 * the organisation's workflow were broken.
 */
describe('A member runs a deployed workflow', () => {
  const PHORMA_BASE = 'https://cloud.member-run.example.test';
  const WORKFLOW_ID = 'wf-member-run';
  const CLERK_JWT = 'clerk-jwt-member-run';

  /** One request the studio made to the hosted worker. */
  interface Recorded {
    url: string;
    method: string;
    authorization: string | null;
    body: string | null;
  }

  /** A socket `connect()` opened, carrying the handlers the SERVICE installed. */
  class RecordingMonitorSocket {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    readonly sent: string[] = [];
    readyState = 1;
    constructor(readonly url: string) {}
    close(): void {
      this.readyState = 3;
    }
    send(data: string): void {
      this.sent.push(data);
    }
  }

  let cloud: CloudService;
  let capability: CapabilityService;
  let runController: RunControllerService;
  let workflow: WorkflowService;
  let settings: SettingsService;
  let terminal: TerminalOutputService;
  let log: Recorded[];
  let opened: RecordingMonitorSocket[];
  let realWebSocket: typeof WebSocket;

  beforeEach(() => {
    log = [];
    opened = [];

    const clerk$ = new ReplaySubject<unknown>(1);
    const session$ = new ReplaySubject<unknown>(1);
    const user$ = new ReplaySubject<unknown>(1);
    clerk$.next({});
    session$.next({ getToken: async () => CLERK_JWT });
    user$.next({ id: 'user_member_ada' });

    TestBed.configureTestingModule({
      providers: [
        provideNoopAnimations(),
        { provide: TauriService, useValue: { isDesktop: false } },
        {
          provide: ClerkService,
          useValue: {
            clerk$,
            client$: new ReplaySubject<unknown>(1),
            session$,
            user$,
            organization$: new ReplaySubject<unknown>(1),
          },
        },
        // `DesktopAuthService` is deliberately REAL: `isDesktop` is false here, so
        // it holds no device token and the Clerk session is the only bearer, which
        // is what the Authorization assertions below pin. A stub would have to
        // restate its whole surface (`PhormaCloudService` calls `restore()` from
        // its constructor) to assert less.
        // The local connection library is not what these specs are about, and
        // every run path reads it - so it answers from memory rather than
        // IndexedDB. Both seams are stubbed: `list` for the pre-run validator and
        // `forWorkflow` for the engine host the local-run cases reach.
        {
          provide: ConnectionStoreService,
          useValue: {
            list: async () => [],
            forWorkflow: () => ({
              list: async () => [],
              resolve: async () => null,
              hasSecret: async () => false,
            }),
          },
        },
      ],
    });

    cloud = TestBed.inject(CloudService);
    capability = TestBed.inject(CapabilityService);
    runController = TestBed.inject(RunControllerService);
    workflow = TestBed.inject(WorkflowService);
    settings = TestBed.inject(SettingsService);
    terminal = TestBed.inject(TerminalOutputService);

    cloud.setPhormaCloudUrl(PHORMA_BASE);

    spyOn(window, 'fetch').and.callFake(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      // Two unrelated background reads are answered but NOT recorded, or the
      // enumeration would depend on when their microtask landed:
      // `ModelPricingService` syncs OpenRouter prices from its constructor, and
      // `PhormaCloudService` polls `/api/me`.
      if (!url.startsWith(PHORMA_BASE) || url.includes('/api/me')) {
        return new Response('{}', { status: 200 });
      }
      const headers = (init?.headers ?? {}) as Record<string, string>;
      log.push({
        url,
        method: init?.method ?? 'GET',
        authorization: headers['Authorization'] ?? null,
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return new Response(JSON.stringify({ ok: true, runId: 'cloudrun-1' }), { status: 200 });
    });

    // Scoped per spec and restored in `afterEach`: karma reaches its own server
    // over the global `WebSocket`, so the stand-in DELEGATES any URL that is not
    // this suite's synthetic host.
    realWebSocket = window.WebSocket;
    const slot = window as unknown as { WebSocket: unknown };
    function MonitorWebSocketStandIn(url: string | URL, protocols?: string | string[]): unknown {
      const text = String(url);
      if (!text.includes('member-run.example.test')) return new realWebSocket(text, protocols);
      const socket = new RecordingMonitorSocket(text);
      opened.push(socket);
      return socket;
    }
    MonitorWebSocketStandIn.prototype = realWebSocket.prototype;
    Object.assign(MonitorWebSocketStandIn, {
      CONNECTING: realWebSocket.CONNECTING,
      OPEN: realWebSocket.OPEN,
      CLOSING: realWebSocket.CLOSING,
      CLOSED: realWebSocket.CLOSED,
    });
    slot.WebSocket = MonitorWebSocketStandIn;

    // The shell's wiring, reproduced: `RunControllerService` may not inject
    // `CloudService`, so the launcher is installed from outside both.
    runController.deployedRunLauncher = input => void cloud.runDeployedActive(input);
  });

  afterEach(() => {
    (window as unknown as { WebSocket: unknown }).WebSocket = realWebSocket;
    cloud.disconnect();
    // Karma runs ONE browser for the whole suite and each of these persists to
    // localStorage, so a spec that sets one must put it back or an innocent file
    // fails on a later random order.
    cloud.setPhormaCloudUrl('');
    cloud.setWorkerUrl('');
    settings.cloudProvider.set(null);
  });

  /**
   * The member's actual state: the organisation's DEPLOYED spec on the canvas,
   * read-only, carrying its own workflow id and written to nothing.
   *
   * `openDeployedSpec` rather than a stubbed `activeDoc`, because the id a
   * member's Run addresses IS the one that path preserves - a stub would let these
   * assertions pass over a document shape the studio never produces.
   */
  function openDeployedWorkflow(): void {
    workflow.newWorkflow();
    workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
    const drafted = workflow.exportActiveSpec();
    expect(drafted).toBeTruthy();
    workflow.openDeployedSpec({ ...drafted!, id: WORKFLOW_ID });
    expect(workflow.activeDoc()?.workflowId).toBe(WORKFLOW_ID);
    expect(workflow.activeDoc()?.readOnly).toBeTrue();
  }

  async function settle(): Promise<void> {
    for (let turn = 0; turn < 12; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  }

  // ── Requirement 10.1: a member has a runtime without choosing one ──────────

  it('pins the hosted target for a Cloud_Library session that never picked one', () => {
    settings.cloudProvider.set(null);

    capability.resolveFrom('operator');
    expect(cloud.provider()).withContext('an operator runs out of the hosted cloud').toBe('phorma');
    expect(cloud.effectiveWorkerUrl()).toBe(PHORMA_BASE);
    expect(cloud.configured())
      .withContext('so Run, Stop and the monitor are reachable at all')
      .toBeTrue();

    capability.resolveFrom('editor');
    expect(cloud.provider()).toBe('phorma');
  });

  it('leaves a builder with no target exactly as unconfigured as before', () => {
    settings.cloudProvider.set(null);
    capability.resolveFrom('builder');

    expect(cloud.provider())
      .withContext('a builder chooses a deploy target; nothing is pinned for them')
      .toBeNull();
    expect(cloud.configured()).toBeFalse();
  });

  it('does not override a target a builder already chose', () => {
    settings.cloudProvider.set('cloudflare');
    capability.resolveFrom('builder');
    expect(cloud.provider()).toBe('cloudflare');
  });

  // ── Where Run goes ────────────────────────────────────────────────────────

  it('sends Run to the deployment for a member, and never to the local engine', async () => {
    capability.resolveFrom('operator');
    openDeployedWorkflow();
    const launcher = jasmine.createSpy('deployedRunLauncher');
    runController.deployedRunLauncher = launcher;
    runController.runInput.set('  Post the June journal  ');

    runController.start();
    await settle();

    expect(launcher).toHaveBeenCalledOnceWith('Post the June journal');
    expect(terminal.phase())
      .withContext('no local run was started, so the phase never left idle')
      .toBe('idle');
  });

  it('sends Run to the local engine for a builder, launcher installed or not', async () => {
    capability.resolveFrom('builder');
    workflow.newWorkflow();
    workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
    const launcher = jasmine.createSpy('deployedRunLauncher');
    runController.deployedRunLauncher = launcher;

    runController.start();
    await settle();

    expect(launcher).not.toHaveBeenCalled();
    expect(terminal.phase()).not.toBe('idle');
    runController.stop();
  });

  it('falls back to the local engine when no launcher was installed', () => {
    capability.resolveFrom('operator');
    workflow.newWorkflow();
    workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
    runController.deployedRunLauncher = null;

    runController.start();

    // Nothing is silently swallowed: with no seam installed, Run behaves exactly
    // as it did before this feature rather than doing nothing at all.
    expect(terminal.phase()).not.toBe('idle');
    runController.stop();
  });

  // ── Requirements 10.1, 10.3: what a member's Run actually does ─────────────

  it('attaches the monitor and triggers the deployed instance over POST /trigger', async () => {
    capability.resolveFrom('operator');
    openDeployedWorkflow();

    await cloud.runDeployedActive('Post the June journal');
    await settle();

    const instance = `${PHORMA_BASE}/agents/workflow-agent/${WORKFLOW_ID}`;
    const triggers = log.filter(entry => entry.url === `${instance}/trigger`);
    expect(triggers.length).withContext('exactly one trigger, over HTTP').toBe(1);
    expect(triggers[0].method).toBe('POST');
    expect(JSON.parse(triggers[0].body ?? '{}').input).toBe('Post the June journal');
    expect(triggers[0].authorization)
      .withContext("the member's own verified credential, not a static token")
      .toBe(`Bearer ${CLERK_JWT}`);

    expect(opened.length).withContext('the EXISTING monitor socket, one of them').toBe(1);
    expect(opened[0].url).toBe(
      `wss://cloud.member-run.example.test/agents/workflow-agent/${WORKFLOW_ID}?token=${CLERK_JWT}`,
    );
  });

  it('routes a monitored run through RunControllerService.apply, not a second path', async () => {
    capability.resolveFrom('operator');
    openDeployedWorkflow();
    await cloud.runDeployedActive('go');
    await settle();

    const socket = opened[0];
    socket.onopen?.();
    expect(cloud.connected()).toBeTrue();
    // The remote senders are what make the Runs panel's Approve reach the
    // deployment rather than a local resolver.
    expect(runController.remoteApprovalSender).not.toBeNull();
    expect(runController.remoteQuestionSender).not.toBeNull();
    expect(runController.remoteEventSender).not.toBeNull();

    socket.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'approval-required',
          runId: 'cloudrun-1',
          requestId: 'approval:gate|abc|0',
          nodeId: 'gate',
          message: 'Post the June journal?',
          payload: '{"period":"2026-06"}',
          at: Date.now(),
        }),
      }),
    );

    const pending = runController.pendingApprovals();
    expect(pending.length).withContext('a RunEvent alone built the pending gate').toBe(1);
    expect(pending[0].requestId).toBe('approval:gate|abc|0');

    runController.resolveApproval('approval:gate|abc|0', true);
    expect(socket.sent.map(frame => JSON.parse(frame) as unknown)).toEqual([
      { type: 'approval', requestId: 'approval:gate|abc|0', approved: true },
    ]);
    expect(runController.pendingApprovals().length).toBe(0);
  });

  it('reports a refused trigger with the worker sentence and opens no run', async () => {
    capability.resolveFrom('operator');
    openDeployedWorkflow();
    (window.fetch as jasmine.Spy).and.callFake(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.startsWith(PHORMA_BASE)) return new Response('{}', { status: 200 });
      log.push({ url, method: 'POST', authorization: null, body: null });
      return new Response(
        JSON.stringify({ error: 'Plan credits exhausted.', code: 'credits_exhausted' }),
        { status: 402 },
      );
    });
    const toastError = spyOn(cloud['toast'], 'error');

    await cloud.runDeployedActive('go');
    await settle();

    expect(toastError).toHaveBeenCalled();
    expect(String(toastError.calls.mostRecent().args[1])).toContain('Plan credits exhausted.');
    expect(terminal.phase()).toBe('idle');
  });

  it('asks for a deployment rather than guessing when no workflow is open', async () => {
    capability.resolveFrom('operator');
    workflow.newWorkflow();
    const toastWarning = spyOn(cloud['toast'], 'warning');

    await cloud.runDeployedActive('go');
    await settle();

    expect(toastWarning).toHaveBeenCalled();
    expect(log.length).withContext('an unsaved draft addresses no deployment').toBe(0);
    expect(opened.length).toBe(0);
  });

  // ── Requirement 10.5 / Property 20: the trace says who answered ───────────

  describe('the trace names the member who settled a gate', () => {
    function description(event: RunLogEvent) {
      return describeRunEvent(event, (id: string) => id);
    }

    it('renders the approving member on the outcome', () => {
      const entry = description({
        type: 'approval-resolved',
        runId: 'cloudrun-1',
        requestId: 'approval:gate|abc|0',
        nodeId: 'gate',
        approved: true,
        actor: 'user_member_ada',
        at: 1,
      });
      expect(entry?.label)
        .withContext('never shortened: two members can share a long id prefix')
        .toBe('Approved by user_member_ada');
    });

    it('renders a rejection the same way', () => {
      const entry = description({
        type: 'approval-resolved',
        runId: 'cloudrun-1',
        requestId: 'approval:gate|abc|0',
        nodeId: 'gate',
        approved: false,
        actor: 'user_member_ada',
        at: 1,
      });
      expect(entry?.label).toBe('Rejected by user_member_ada');
    });

    it('keeps a delivered event payload copyable, putting the member in the label', () => {
      const entry = description({
        type: 'wait-resolved',
        runId: 'cloudrun-1',
        nodeId: 'wait',
        correlationKey: 'signed:J42',
        eventPayload: '{"signed":true}',
        actor: 'user_member_grace',
        at: 1,
      });
      expect(entry?.label).toBe('Event "signed:J42" arrived (delivered by user_member_grace)');
      expect(entry?.detail)
        .withContext('the detail is what the copy button hands over - payload only')
        .toBe('{"signed":true}');
    });

    it('renders an unattributed outcome exactly as it did before', () => {
      const approval = description({
        type: 'approval-resolved',
        runId: 'run-1',
        requestId: 'approval:gate|abc|0',
        nodeId: 'gate',
        approved: true,
        at: 1,
      });
      const wait = description({
        type: 'wait-resolved',
        runId: 'run-1',
        nodeId: 'wait',
        correlationKey: 'signed:J42',
        eventPayload: '{}',
        at: 1,
      });
      expect(approval?.label).toBe('Approved');
      expect(wait?.label).toBe('Event "signed:J42" arrived');
    });
  });
});
