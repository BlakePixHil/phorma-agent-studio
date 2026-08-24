import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ReplaySubject } from 'rxjs';
import { ClerkService } from 'ngx-clerk';

import {
  DataTransportError,
  serializeConnectorBundle,
  type ModelRequest,
  type RunEvent,
  type WorkflowNode,
} from '@phorma/engine';

import { AssistantChatService } from './assistant-chat.service';
import { CloudService } from './cloud.service';
import { ConnectionStoreService } from './connection-store.service';
import { ConnectorsService } from './connectors.service';
import { DataFetchService } from './data-fetch.service';
import { IndexedDbStorageService } from './indexed-db-storage.service';
import { ModelTransportService } from './model-transport.service';
import { PanelRegistryService } from './panel-registry.service';
import { PhormaCloudService } from './phorma-cloud.service';
import { RunControllerService } from './run-controller.service';
import { SettingsService } from './settings.service';
import { TauriService } from './tauri.service';
import { TelemetryErrorHandler } from './telemetry-error-handler';
import { counterName, type ErrorCategory } from './telemetry-catalog';
import { TelemetryService } from './telemetry.service';
import { ToolHostService } from './tool-host.service';
import { WorkflowBuilderService } from './workflow-builder.service';
import { WorkflowService } from './workflow.service';
import { AwsCliService } from './deploy/aws-cli.service';
import { AwsDeployConfigService } from './deploy/aws-deploy-config.service';
import { AwsRequestService } from './deploy/aws-request.service';
import { ConfirmDialogService } from '../shared/confirm-dialog/confirm-dialog.service';
import type { EgressAllowList } from '@phorma/engine';
import type { SqlQueryNodeData } from './workflow.model';

/**
 * The counter CALL SITES, one spec per seam.
 *
 * Task 6.7 of the telemetry-phone-home spec. The catalog, the state algebra and
 * the service itself are covered by their own suites; what is unchecked without
 * this file is the wiring: that the seam that already knows a fact reports it
 * ONCE, and reports it under the name the Counter_Catalog actually declares.
 *
 * Two rules shape every spec here.
 *
 *  1. **Exactly one call.** Each assertion compares the full list of names the
 *     interaction produced against a literal list, so a seam that counts twice,
 *     counts on a path it should not, or counts an extra neighbouring counter
 *     fails just as loudly as one that counts nothing.
 *  2. **Names come from `counterName`.** Nothing here writes `'run.started'` or
 *     `'error:engine'` by hand, so a change to the family/dimension separator
 *     cannot pass by agreeing with itself in two places.
 *
 * `recordError(category)` is implemented as `count(counterName('error', ...))`,
 * so spying on `count` observes both APIs through one seam and lets every spec
 * make the same shape of assertion.
 *
 * These are EXAMPLE tests: one deliberate interaction per seam, no generated
 * input and no iteration floor.
 *
 * _Requirements: 3.1, 3.2_
 */

/** Records every counter name the interaction under test produced, in order. */
function watchCounters(): () => string[] {
  const spy = spyOn(TestBed.inject(TelemetryService), 'count');
  return () => spy.calls.allArgs().map(([name]) => String(name));
}

/** The catalog name for one error category, built the way the code builds it. */
function errorCounter(category: ErrorCategory): string {
  return counterName('error', category);
}

/** A Clerk stub that reports nobody signed in. Nothing here needs a session. */
function signedOutClerk(): Record<string, ReplaySubject<unknown>> {
  const subjects: Record<string, ReplaySubject<unknown>> = {};
  for (const name of ['clerk$', 'client$', 'session$', 'user$', 'organization$']) {
    const subject = new ReplaySubject<unknown>(1);
    subject.next(undefined);
    subjects[name] = subject;
  }
  return subjects;
}

// ─── Runs and engine errors: RunControllerService.apply() ───────────────────

describe('telemetry call site: RunControllerService.apply', () => {
  const RUN_ID = 'run-telemetry-call-sites';
  let runController: RunControllerService;
  let names: () => string[];

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideNoopAnimations(),
        { provide: TauriService, useValue: { isDesktop: false } },
      ],
    });
    runController = TestBed.inject(RunControllerService);
    TestBed.inject(WorkflowService).newWorkflow();
    names = watchCounters();
  });

  it('counts run.started once on the run-started event', () => {
    runController.apply({ type: 'run-started', runId: RUN_ID, input: '{}', at: 1 } as RunEvent);

    expect(names()).toEqual([counterName('run.started')]);
  });

  it('counts run.completed once on the run-completed event', () => {
    runController.apply({ type: 'run-completed', runId: RUN_ID, at: 2 } as RunEvent);

    expect(names()).toEqual([counterName('run.completed')]);
  });

  it('counts run.error and error:engine exactly once each on the run-failed event', () => {
    runController.apply({
      type: 'run-failed',
      runId: RUN_ID,
      error: 'the engine blew up at node n1',
      at: 3,
    } as RunEvent);

    // Two counters for one failure, and no third: the run outcome and the error
    // category are different questions about the same event.
    expect(names()).toEqual([counterName('run.error'), errorCounter('engine')]);
  });

  it('counts nothing for an event that is neither a start nor an outcome', () => {
    runController.apply({
      type: 'node-started',
      runId: RUN_ID,
      nodeId: 'n1',
      nodeName: 'Step',
      at: 2,
    } as RunEvent);

    expect(names()).toEqual([]);
  });
});

// ─── Node instantiation: WorkflowService.addNodeFromCatalog() ───────────────

describe('telemetry call site: WorkflowService.addNodeFromCatalog', () => {
  let workflow: WorkflowService;
  let names: () => string[];

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: false } }],
    });
    workflow = TestBed.inject(WorkflowService);
    workflow.newWorkflow();
    names = watchCounters();
  });

  it('counts node.created once, on the RESOLVED node kind rather than the palette id', () => {
    const node = workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });

    expect(node).toBeTruthy();
    // The palette entry id is `trigger-manual`; the node kind is
    // `manual-trigger`. Only the kind is a catalog dimension, and counting the
    // entry id would silently produce a name the catalog discards.
    expect(node!.kind).toBe('manual-trigger');
    expect(names()).toEqual([counterName('node.created', node!.kind)]);
  });

  it('counts nothing when the palette id resolves to no catalog entry', () => {
    expect(workflow.addNodeFromCatalog('no-such-palette-entry', { x: 0, y: 0 })).toBeNull();
    expect(names()).toEqual([]);
  });
});

// ─── Panel opens: PanelRegistryService.setActive() ──────────────────────────

describe('telemetry call site: PanelRegistryService.setActive', () => {
  let panels: PanelRegistryService;
  let names: () => string[];

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: false } }],
    });
    panels = TestBed.inject(PanelRegistryService);
    names = watchCounters();
  });

  it('counts panel.opened once when a tab becomes active on a side', () => {
    panels.setActive('left', 'runs');

    expect(names()).toEqual([counterName('panel.opened', 'runs')]);
  });

  it('counts nothing when the tab was already active on that side', () => {
    panels.setActive('left', 'runs');
    panels.setActive('left', 'runs');

    // The second call is a re-render, not an open.
    expect(names()).toEqual([counterName('panel.opened', 'runs')]);
  });
});

// ─── Assistant invocations ─────────────────────────────────────────────────

describe('telemetry call site: AssistantChatService.send', () => {
  let chat: AssistantChatService;
  let builder: WorkflowBuilderService;
  let names: () => string[];

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: { isDesktop: false } },
        { provide: ClerkService, useValue: signedOutClerk() },
      ],
    });
    chat = TestBed.inject(AssistantChatService);
    builder = TestBed.inject(WorkflowBuilderService);
    TestBed.inject(WorkflowService).newWorkflow();

    // The turn itself is not under test: the model round trip and the thread
    // write are stubbed so the spec asserts the counter and nothing else.
    const storage = TestBed.inject(IndexedDbStorageService);
    spyOn(storage, 'saveChatThread').and.resolveTo(undefined);
    spyOn(storage, 'listChatThreads').and.resolveTo([]);
    spyOn(builder, 'runAskTurn').and.resolveTo('an answer');
    names = watchCounters();
  });

  it('counts assistant.invoked once for the mode the turn was sent in', async () => {
    await chat.send('what does this workflow do?', 'ask');

    expect(names()).toEqual([counterName('assistant.invoked', 'ask')]);
  });

  it('counts nothing for a blank request', async () => {
    await chat.send('   ', 'ask');

    expect(names()).toEqual([]);
  });
});

describe('telemetry call site: WorkflowBuilderService.run', () => {
  let builder: WorkflowBuilderService;
  let names: () => string[];

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: { isDesktop: false } },
        { provide: ClerkService, useValue: signedOutClerk() },
      ],
    });
    builder = TestBed.inject(WorkflowBuilderService);
    TestBed.inject(WorkflowService).newWorkflow();

    // The Ctrl+P builder's plan pass and its trailing quota refresh are both
    // stubbed: the seam under test is the counter, not the build.
    spyOn(builder as unknown as { runPlanMode: () => Promise<void> }, 'runPlanMode').and.resolveTo(
      undefined,
    );
    spyOn(TestBed.inject(PhormaCloudService), 'refresh').and.resolveTo(undefined);
    names = watchCounters();
  });

  it('counts assistant.invoked once for the palette mode', async () => {
    await builder.run('add a webhook trigger', 'plan');

    expect(names()).toEqual([counterName('assistant.invoked', 'plan')]);
  });
});

// ─── Deploy starts: CloudService.pushWorkflow() ─────────────────────────────

describe('telemetry call site: CloudService.pushWorkflow', () => {
  const WORKER_BASE = 'https://worker.telemetry.example.test';
  const TRIGGER_BASE = 'https://trigger.telemetry.example.test';

  let cloud: CloudService;
  let workflow: WorkflowService;
  let settings: SettingsService;
  let awsConfig: AwsDeployConfigService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: { isDesktop: false } },
        { provide: ClerkService, useValue: signedOutClerk() },
        // The local connection library is not part of this seam and every push
        // reads it, so it answers from memory instead of IndexedDB.
        { provide: ConnectionStoreService, useValue: { list: async () => [] } },
      ],
    });
    cloud = TestBed.inject(CloudService);
    workflow = TestBed.inject(WorkflowService);
    settings = TestBed.inject(SettingsService);
    awsConfig = TestBed.inject(AwsDeployConfigService);

    workflow.newWorkflow();
    workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
    cloud.setWorkerUrl(WORKER_BASE);
  });

  afterEach(() => {
    // The worker URL, the Phorma Cloud URL, the chosen provider and the AWS
    // endpoint all persist, and karma runs ONE browser for the whole suite.
    settings.cloudProvider.set(null);
    cloud.setWorkerUrl('');
    cloud.setToken('');
    awsConfig.triggerApiUrl.set('');
    TestBed.flushEffects();
  });

  /** Answers the three requests a push can make. */
  function stubFetch(options: { deployOk?: boolean } = {}): void {
    spyOn(window, 'fetch').and.callFake(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/connections') && method === 'POST') {
        return new Response(JSON.stringify({ ok: true, connections: [] }), { status: 200 });
      }
      if (url.endsWith('/connections') && method === 'GET') {
        return new Response(JSON.stringify({ connections: [] }), { status: 200 });
      }
      if (url.endsWith('/workflow') && method === 'POST') {
        return options.deployOk === false
          ? new Response(JSON.stringify({ error: 'rejected' }), { status: 400 })
          : new Response(JSON.stringify({ ok: true, name: 'wf' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 404 });
    });
  }

  it('counts deploy.started for the SELECTED provider, once, on a successful push', async () => {
    settings.cloudProvider.set('cloudflare');
    stubFetch({ deployOk: true });
    const names = watchCounters();

    await expectAsync(cloud.pushWorkflow()).toBeResolvedTo(true);

    expect(names()).toEqual([counterName('deploy.started', 'cloudflare')]);
  });

  it('counts deploy.started:phorma when Phorma Cloud is the chosen target', async () => {
    settings.cloudProvider.set('phorma');
    cloud.setPhormaCloudUrl(WORKER_BASE);
    stubFetch({ deployOk: true });
    const names = watchCounters();

    await cloud.pushWorkflow();

    // The dimension is read from the selected provider, not assumed.
    expect(names()).toEqual([counterName('deploy.started', 'phorma')]);
  });

  it('counts NO deploy.started for aws - that deploy starts in AwsCliService', async () => {
    settings.cloudProvider.set('aws');
    awsConfig.triggerApiUrl.set(TRIGGER_BASE);
    spyOn(TestBed.inject(AwsRequestService), 'send').and.resolveTo({
      ok: true,
      response: { status: 200, headers: {}, body: '{"ok":true}' },
    });
    stubFetch({ deployOk: true });
    const names = watchCounters();

    await cloud.pushWorkflow();

    // Counting here as well as at `cdk deploy` would fold two different
    // operator actions into one counter.
    expect(names().filter((name) => name.startsWith('deploy.started'))).toEqual([]);
  });

  it('counts error:validation once when a capability error finding aborts the push', async () => {
    settings.cloudProvider.set('cloudflare');
    // An `mssql` driver is not declared for the Cloudflare Worker, so the
    // validator returns an error finding and the push is abandoned.
    const sqlNode = workflow.addNodeFromCatalog('data-sql-query', { x: 200, y: 0 });
    workflow.updateNodeData(sqlNode!.id, {
      driver: 'mssql',
      statement: 'SELECT 1',
    } as Partial<SqlQueryNodeData> as Record<string, unknown>);
    stubFetch({ deployOk: true });
    const names = watchCounters();

    await expectAsync(cloud.pushWorkflow()).toBeResolvedTo(false);

    // `validation` and not `deploy`: the deploy never started. The abort
    // returns rather than throwing, so the catch cannot count it a second time.
    expect(names()).toEqual([
      counterName('deploy.started', 'cloudflare'),
      errorCounter('validation'),
    ]);
  });

  it('counts error:deploy once when the deployment request is refused', async () => {
    settings.cloudProvider.set('cloudflare');
    stubFetch({ deployOk: false });
    const names = watchCounters();

    await expectAsync(cloud.pushWorkflow()).toBeResolvedTo(false);

    expect(names()).toEqual([counterName('deploy.started', 'cloudflare'), errorCounter('deploy')]);
  });
});

// ─── Deploy starts: AwsCliService.planAndDeploy() ───────────────────────────

describe('telemetry call site: AwsCliService.planAndDeploy', () => {
  const EMPTY_EGRESS: EgressAllowList = { hosts: [], undeterminable: [], capped: false };
  const CLOUD_AWS_DIR = 'C:/phorma/deploy/cloud-aws';

  let awsCli: AwsCliService;
  let confirm: ConfirmDialogService;
  /** The plan and deploy verbs, which reach the CLI through a dynamic import. */
  let plan: jasmine.Spy;
  let deploy: jasmine.Spy;

  beforeEach(() => {
    TestBed.configureTestingModule({
      // The whole flow refuses to run in browser preview.
      providers: [{ provide: TauriService, useValue: { isDesktop: true } }],
    });
    awsCli = TestBed.inject(AwsCliService);
    confirm = TestBed.inject(ConfirmDialogService);

    // Both CLI invocations and the endpoint read-back are stubbed: the seam
    // under test is where the counter sits in the plan/confirm/deploy order,
    // not the `phorma-aws` process, which karma cannot spawn.
    const internals = awsCli as unknown as Record<string, unknown>;
    plan = spyOn(internals as never, 'runPlanCommand' as never).and.resolveTo({
      success: true,
      exitCode: 0,
    } as never);
    deploy = spyOn(internals as never, 'runDeployCommand' as never).and.resolveTo({
      success: true,
      exitCode: 0,
    } as never);
    spyOn(internals as never, 'discoverEndpoints' as never).and.resolveTo(undefined as never);
  });

  it('counts deploy.started:aws once, after the plan succeeds and the operator confirms', async () => {
    spyOn(confirm, 'confirm').and.resolveTo(true);
    const names = watchCounters();

    await awsCli.planAndDeploy(CLOUD_AWS_DIR, true, EMPTY_EGRESS);

    expect(plan).toHaveBeenCalled();
    expect(deploy).toHaveBeenCalled();
    expect(names()).toEqual([counterName('deploy.started', 'aws')]);
  });

  it('counts nothing when the plan fails - a failed plan starts no deploy', async () => {
    plan.and.resolveTo({ success: false, exitCode: 1 });
    const confirmSpy = spyOn(confirm, 'confirm').and.resolveTo(true);
    const names = watchCounters();

    await awsCli.planAndDeploy(CLOUD_AWS_DIR, true, EMPTY_EGRESS);

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(names()).toEqual([]);
  });

  it('counts nothing when the operator declines the confirmation', async () => {
    spyOn(confirm, 'confirm').and.resolveTo(false);
    const names = watchCounters();

    await awsCli.planAndDeploy(CLOUD_AWS_DIR, true, EMPTY_EGRESS);

    expect(deploy).not.toHaveBeenCalled();
    expect(names()).toEqual([]);
  });

  it('counts error:deploy once alongside the start when the deploy exits non-zero', async () => {
    spyOn(confirm, 'confirm').and.resolveTo(true);
    deploy.and.resolveTo({ success: false, exitCode: 1 });
    const names = watchCounters();

    await awsCli.planAndDeploy(CLOUD_AWS_DIR, true, EMPTY_EGRESS);

    expect(names()).toEqual([counterName('deploy.started', 'aws'), errorCounter('deploy')]);
  });
});

// ─── Error categories ───────────────────────────────────────────────────────

describe('telemetry call site: ModelTransportService counted client', () => {
  /** A keyless provider, so no stored key is needed to reach the transport. */
  const REQUEST: ModelRequest = {
    provider: 'ollama',
    model: 'llama3.2',
    system: '',
    messages: [{ role: 'user', content: 'hello' }],
    ollamaBaseUrl: 'https://ollama.telemetry.example.test',
  };

  let transport: ModelTransportService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: { isDesktop: false } },
        { provide: ClerkService, useValue: signedOutClerk() },
      ],
    });
    transport = TestBed.inject(ModelTransportService);
  });

  /** Drains the stream, returning the error it threw. */
  async function drain(): Promise<unknown> {
    try {
      for await (const _chunk of transport.create().stream(REQUEST)) {
        void _chunk;
      }
      return null;
    } catch (error) {
      return error;
    }
  }

  it('counts error:model-call once when a provider answers with a failure', async () => {
    spyOn(window, 'fetch').and.resolveTo(new Response('upstream is angry', { status: 500 }));
    const names = watchCounters();

    expect(await drain()).toBeTruthy();

    // One failed inference call, one counter: the decorator wraps the composite
    // rather than each inner client.
    expect(names()).toEqual([errorCounter('model-call')]);
  });

  it('counts error:network once when the request never produced a response', async () => {
    // A bare `TypeError` is the only signal the browser gives for a DNS,
    // connect, TLS or CORS failure.
    spyOn(window, 'fetch').and.rejectWith(new TypeError('Failed to fetch'));
    const names = watchCounters();

    expect(await drain()).toBeTruthy();

    expect(names()).toEqual([errorCounter('network')]);
  });

  it('counts nothing when the stream completes', async () => {
    spyOn(window, 'fetch').and.resolveTo(
      new Response('{"done":true,"message":{"content":"hi"}}\n', { status: 200 }),
    );
    const names = watchCounters();

    await drain();

    expect(names()).toEqual([]);
  });
});

describe('telemetry call site: ToolHostService', () => {
  let toolHost: ToolHostService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: false } }],
    });
    toolHost = TestBed.inject(ToolHostService);
  });

  /** A minimal tool node of the given kind. */
  function toolNode(kind: string, data: Record<string, unknown>): WorkflowNode {
    return {
      id: `tool-${kind}`,
      kind,
      name: 'Spec tool',
      position: { x: 0, y: 0 },
      data,
    } as unknown as WorkflowNode;
  }

  it('counts error:tool-call once when a tool call throws', async () => {
    spyOn(window, 'fetch').and.rejectWith(new TypeError('Failed to fetch'));
    const node = toolNode('http-tool', {
      method: 'GET',
      url: 'https://tool.telemetry.example.test/things',
    });
    const names = watchCounters();

    await expectAsync(toolHost.callTool(node, 'spec_tool', '{}')).toBeRejected();

    expect(names()).toEqual([errorCounter('tool-call')]);
  });

  it('counts error:mcp once when the MCP connect path fails', async () => {
    // A stdio MCP server is unreachable in browser preview, which is one of the
    // ways `listMcpTools` can fail.
    const node = toolNode('mcp-tool', { transport: 'stdio', command: 'npx' });
    const names = watchCounters();

    await expectAsync(toolHost.listTools(node)).toBeRejected();

    // `mcp` and not `tool-call`: `listMcpTools` owns the connect seam, and one
    // failure gets one counter.
    expect(names()).toEqual([errorCounter('mcp')]);
  });

  it('counts nothing when a tool answers with an error RESULT the model can recover from', async () => {
    // No URL configured: the model receives an `Error: ...` string and the run
    // continues, so this is a tool answer rather than a failed call.
    const node = toolNode('http-tool', { method: 'GET', url: '' });
    const names = watchCounters();

    await expectAsync(toolHost.callTool(node, 'spec_tool', '{}')).toBeResolved();

    expect(names()).toEqual([]);
  });
});

describe('telemetry call site: DataFetchService', () => {
  let dataFetch: DataFetchService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: false } }],
    });
    dataFetch = TestBed.inject(DataFetchService);
  });

  it('counts error:network once for a request that produced no response', async () => {
    spyOn(window, 'fetch').and.rejectWith(new TypeError('Failed to fetch'));
    const names = watchCounters();

    const failure = await dataFetch
      .fetch({ url: 'https://data.telemetry.example.test/rows', method: 'GET', headers: {} })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(failure instanceof DataTransportError).toBeTrue();
    expect(names()).toEqual([errorCounter('network')]);
  });

  it('counts nothing for an HTTP error status - a 500 is a response, not a failure', async () => {
    spyOn(window, 'fetch').and.resolveTo(new Response('nope', { status: 500 }));
    const names = watchCounters();

    const response = await dataFetch.fetch({
      url: 'https://data.telemetry.example.test/rows',
      method: 'GET',
      headers: {},
    });

    expect(response.status).toBe(500);
    expect(names()).toEqual([]);
  });
});

describe('telemetry call site: IndexedDbStorageService', () => {
  let storage: IndexedDbStorageService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: false } }],
    });
    storage = TestBed.inject(IndexedDbStorageService);
  });

  it('counts error:storage once for a failed store request', async () => {
    // Every store operation in the service funnels through the private
    // `request` helper, so that is the seam. It is driven with a stand-in
    // `IDBRequest` deliberately: the reachable real failures either throw
    // synchronously (an invalid key, a non-cloneable value) or need the shared
    // browser database to be broken for the rest of the suite.
    const failing = { onsuccess: null, onerror: null, error: new Error('quota exceeded') } as {
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
      error: Error;
    };
    const names = watchCounters();

    const settled = (
      storage as unknown as { request: (request: unknown) => Promise<unknown> }
    ).request(failing);
    failing.onerror?.();

    await expectAsync(settled).toBeRejected();
    expect(names()).toEqual([errorCounter('storage')]);
  });
});

describe('telemetry call site: PhormaCloudService', () => {
  beforeEach(() => {
    const clerk = signedOutClerk();
    // A signed-in user with a mintable session: `refresh()` returns before the
    // request otherwise.
    clerk['user$'].next({ id: 'user_spec' });
    clerk['session$'].next({ getToken: async () => 'clerk-session-jwt' });
    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: { isDesktop: false } },
        { provide: ClerkService, useValue: clerk },
      ],
    });
  });

  /**
   * The service refreshes eagerly from a constructor effect as soon as Clerk
   * reports a signed-in user, so the spy has to be installed AFTER that first
   * refresh settles - otherwise the eager call is indistinguishable from the one
   * under test and "exactly one" means nothing.
   */
  async function armedService(status: number): Promise<PhormaCloudService> {
    spyOn(window, 'fetch').and.resolveTo(new Response(JSON.stringify({ error: 'nope' }), { status }));
    const phormaCloud = TestBed.inject(PhormaCloudService);
    TestBed.flushEffects();
    for (let attempt = 0; attempt < 50 && phormaCloud.loading(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(phormaCloud.loading()).toBeFalse();
    return phormaCloud;
  }

  it('counts error:auth once when the control plane rejects the session with a 401', async () => {
    const phormaCloud = await armedService(401);
    const names = watchCounters();

    await phormaCloud.refresh();

    expect(names()).toEqual([errorCounter('auth')]);
  });

  it('counts nothing for a non-401 control-plane failure', async () => {
    const phormaCloud = await armedService(500);
    const names = watchCounters();

    await phormaCloud.refresh();

    // 401 is the one authentication failure this service can observe.
    expect(names()).toEqual([]);
  });
});

describe('telemetry call site: ConnectorsService', () => {
  let connectors: ConnectorsService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: false } }],
    });
    connectors = TestBed.inject(ConnectorsService);
  });

  it('counts error:validation once for a refused connector file', () => {
    const names = watchCounters();

    expect(connectors.parse('this is not a connector bundle').ok).toBeFalse();

    expect(names()).toEqual([errorCounter('validation')]);
  });

  it('counts nothing for a file that parses', () => {
    const bundle = serializeConnectorBundle({
      format: 1,
      id: 'cx-telemetry-spec',
      name: 'Spec connector',
      version: '1.0.0',
      connection: {
        type: 'http',
        configFields: [{ name: 'baseUrl', label: 'Base URL', required: true }],
        secretFields: [{ name: 'apiToken', label: 'API token' }],
        auth: { mode: 'bearer', secretKey: 'apiToken' },
      },
      steps: [
        {
          id: 'list-things',
          label: 'List things',
          kind: 'http-request',
          data: { method: 'GET', url: '/things', responseMode: 'json' },
        },
      ],
    });
    const names = watchCounters();

    expect(connectors.parse(bundle).ok).toBeTrue();

    expect(names()).toEqual([]);
  });
});

describe('telemetry call site: TelemetryErrorHandler', () => {
  let handler: TelemetryErrorHandler;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: { isDesktop: false } },
        TelemetryErrorHandler,
      ],
    });
    handler = TestBed.inject(TelemetryErrorHandler);
  });

  it('counts error:unknown once for an unclassified throw, and still reports it', () => {
    // Angular's own handler logs the error; the counter must not displace it.
    const reported = spyOn(console, 'error');
    const names = watchCounters();

    handler.handleError(new Error('nobody handled me'));

    expect(names()).toEqual([errorCounter('unknown')]);
    expect(reported).toHaveBeenCalled();
  });
});
