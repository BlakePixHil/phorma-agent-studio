import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ReplaySubject } from 'rxjs';
import { ClerkService } from 'ngx-clerk';
import {
  AWS_CAPABILITIES,
  validateAgainstCapabilities,
  type CapabilityFinding,
  type ConnectionSummary,
  type RunEvent,
  type RunEventType,
  type RunScope,
} from '@phorma/engine';

import { CloudService } from './cloud.service';
import { RunControllerService } from './run-controller.service';
import { ConnectionStoreService } from './connection-store.service';
import { TauriService } from './tauri.service';
import { TerminalOutputService } from './terminal-output.service';
import { ToastService } from '../shared/toast/toast.service';
import { WorkflowService } from './workflow.service';
import { SettingsService } from './settings.service';
import { AwsCliService } from './deploy/aws-cli.service';
import { AwsDeployConfigService } from './deploy/aws-deploy-config.service';
import { AwsRequestService, type AwsRequestResult } from './deploy/aws-request.service';
import type { CloudTransport, HttpMethod } from './deploy/cloud-transport';
import {
  DEPLOY_TARGETS,
  type CloudEndpointContext,
  type CloudEndpointSpec,
  type CloudOperation,
  type DeployTargetId,
} from './deploy/deploy-targets';
import type { HttpRequestNodeData, SqlQueryNodeData, WorkflowSpec } from './workflow.model';

/**
 * Requirement 17.11: a push validates the active spec against Worker_Host's
 * OWN capability record and its OWN connection inventory (read back from the
 * worker) before the `POST /workflow` deployment request is ever sent. An
 * `error` finding aborts the push with no deployment request; a
 * `warning`-only finding never blocks it (Requirement 17.15).
 *
 * No real worker: `fetch` is a spy that answers the connection-metadata push,
 * the connection-inventory read-back and (only when the push should proceed)
 * the `/workflow` deployment route.
 */
describe('CloudService.pushWorkflow capability gating', () => {
  let cloud: CloudService;
  let workflow: WorkflowService;
  let toast: ToastService;
  let terminal: TerminalOutputService;
  let settings: SettingsService;

  beforeEach(() => {
    const clerk$ = new ReplaySubject<unknown>(1);
    const client$ = new ReplaySubject<unknown>(1);
    const session$ = new ReplaySubject<unknown>(1);
    const user$ = new ReplaySubject<unknown>(1);
    const organization$ = new ReplaySubject<unknown>(1);
    clerk$.next(undefined);
    client$.next(undefined);
    session$.next(undefined);
    user$.next(undefined);
    organization$.next(undefined);

    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: { isDesktop: false } },
        { provide: ClerkService, useValue: { clerk$, client$, session$, user$, organization$ } },
      ],
    });

    cloud = TestBed.inject(CloudService);
    workflow = TestBed.inject(WorkflowService);
    toast = TestBed.inject(ToastService);
    terminal = TestBed.inject(TerminalOutputService);
    settings = TestBed.inject(SettingsService);

    workflow.newWorkflow();
    settings.cloudProvider.set('cloudflare');
    cloud.setWorkerUrl('https://worker.example.test');
  });

  /** A manual trigger plus one http-request node, matching the palette shape. */
  function buildHttpGraph(data: Partial<HttpRequestNodeData>): void {
    const trigger = workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
    const httpNode = workflow.addNodeFromCatalog('data-http-request', { x: 200, y: 0 });
    expect(trigger).toBeTruthy();
    expect(httpNode).toBeTruthy();
    workflow.updateNodeData(httpNode!.id, data as Record<string, unknown>);
  }

  /** A manual trigger plus one sql-query node using a driver absent on the worker. */
  function buildSqlGraph(data: Partial<SqlQueryNodeData>): void {
    const trigger = workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
    const sqlNode = workflow.addNodeFromCatalog('data-sql-query', { x: 200, y: 0 });
    expect(trigger).toBeTruthy();
    expect(sqlNode).toBeTruthy();
    workflow.updateNodeData(sqlNode!.id, data as Record<string, unknown>);
  }

  /** Routes the three fetch calls `pushWorkflow` can make, in order of use. */
  function stubFetch(options: {
    connections?: unknown[];
    deployOk?: boolean;
  }): jasmine.Spy {
    return spyOn(window, 'fetch').and.callFake(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/connections') && method === 'POST') {
        return new Response(JSON.stringify({ ok: true, connections: [] }), { status: 200 });
      }
      if (url.endsWith('/connections') && method === 'GET') {
        return new Response(JSON.stringify({ connections: options.connections ?? [] }), { status: 200 });
      }
      if (url.endsWith('/workflow') && method === 'POST') {
        return options.deployOk === false
          ? new Response(JSON.stringify({ error: 'rejected' }), { status: 400 })
          : new Response(JSON.stringify({ ok: true, name: 'wf' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 404 });
    });
  }

  it('aborts the push and sends no deployment request when the validator returns an error finding', async () => {
    // sql-query with an mssql driver: not declared for Cloudflare Worker
    // (Requirement 17.3), so the validator returns an error finding.
    buildSqlGraph({ driver: 'mssql', statement: 'SELECT 1' });
    const fetchSpy = stubFetch({});
    const toastErrorSpy = spyOn(toast, 'error').and.callThrough();

    await cloud.pushWorkflow();

    const deployCalls = fetchSpy.calls.allArgs().filter(([input, init]) => {
      return String(input).endsWith('/workflow') && (init as RequestInit | undefined)?.method === 'POST';
    });
    expect(deployCalls.length).toBe(0);
    expect(toastErrorSpy).toHaveBeenCalledWith('Push aborted', jasmine.stringMatching(/problem/i));
    const problems = terminal.entries().filter(entry => entry.channel === 'problems');
    expect(problems.some(entry => entry.message.includes('mssql'))).toBeTrue();
  });

  it('proceeds to the deployment request when only warning findings are returned', async () => {
    // A templated (non-static) url is a warning finding only (Requirement
    // 17.13) - it must never block the push (Requirement 17.15).
    buildHttpGraph({ method: 'GET', url: '{{ base }}/items', responseMode: 'json', bodyMode: 'none' });
    const fetchSpy = stubFetch({ deployOk: true });
    const toastSuccessSpy = spyOn(toast, 'success').and.callThrough();
    const toastErrorSpy = spyOn(toast, 'error').and.callThrough();

    await cloud.pushWorkflow();

    const deployCalls = fetchSpy.calls.allArgs().filter(([input, init]) => {
      return String(input).endsWith('/workflow') && (init as RequestInit | undefined)?.method === 'POST';
    });
    expect(deployCalls.length).toBe(1);
    expect(toastErrorSpy).not.toHaveBeenCalledWith('Push aborted', jasmine.anything());
    expect(toastSuccessSpy).toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Feature: aws-byo-deploy, Property 21: Transport seam selects by target only
// ───────────────────────────────────────────────────────────────────────────────

/** Own-Cloudflare base URL. Https, so the monitor URL derives `wss`. */
const WORKER_BASE = 'https://worker.example.test';
/** Discovered Trigger_API base - AWS instances hang off `/workflows/{id}`. */
const TRIGGER_BASE = 'https://trigger.example.test';
/**
 * Phorma Cloud base, overridden away from the real production host so every
 * enumerated request is addressed at a synthetic name.
 */
const PHORMA_BASE = 'https://phorma-cloud.example.test';
/** The three configured bases - a request to anything else is not a dispatch. */
const TARGET_BASES = [PHORMA_BASE, WORKER_BASE, TRIGGER_BASE];
/**
 * The base each target must resolve, so a URL expectation is not built on
 * whatever base the service happened to pick.
 */
const TARGET_BASE_BY_ID: Readonly<Record<DeployTargetId, string>> = {
  phorma: PHORMA_BASE,
  cloudflare: WORKER_BASE,
  aws: TRIGGER_BASE,
};
/** The active document's id, pinned so an expected URL is computable. */
const ACTIVE_WORKFLOW_ID = 'wf-active';
/** A workflow addressed by id rather than by being open. */
const TARGET_WORKFLOW_ID = 'wf-alpha';
const RUN_ID = 'run-7';
const CONNECTION_ID = 'conn-1';
const SECRET_KEY = 'API_KEY';
/** The bearer both Cloudflare targets must carry, from the Clerk session. */
const CLERK_JWT = 'clerk-session-jwt';
/**
 * What `phorma-aws monitor-url` presigns. Carries a SigV4 query signature and
 * deliberately no `token` parameter - the AWS socket is authorized by the
 * signature, not by a bearer in the query string.
 */
const PRESIGNED_MONITOR_URL =
  'wss://monitor.example.test/socket?workflowId=wf-alpha&X-Amz-Signature=abc123';
/**
 * `AwsDeployConfigService.retentionDays`' own default.
 *
 * Restated here because the harness has to restore it: unlike every other AWS
 * config field, retention is not valid-when-empty - `0` is a malformed value, so
 * "cleared" for this one field means back to its default, not blank.
 */
const AWS_DEFAULT_RETENTION_DAYS = 30;

/**
 * One body every endpoint's reader accepts, so the stubs never have to know
 * which operation they are answering. Each field is the shape one
 * `CloudEndpointSpec.unwrap` (or its caller) reads.
 */
const RESPONSE_BODY = JSON.stringify({
  ok: true,
  name: 'wf',
  runId: RUN_ID,
  connections: [],
  hasWorkflow: true,
  savedAt: null,
  runs: [],
  activeRunId: null,
  items: [],
  record: { runId: RUN_ID },
  events: { items: [] },
  usage: [],
  secrets: [],
});

/** Every deploy target, read from the registry so a new one lands here. */
const TARGET_IDS = Object.keys(DEPLOY_TARGETS) as DeployTargetId[];

/**
 * Every operation ANY target declares, unioned from the registry rather than
 * copied. An endpoint added to one host without transport coverage enters this
 * enumeration on its own.
 */
const OPERATIONS: CloudOperation[] = [
  ...new Set(
    TARGET_IDS.flatMap(id => Object.keys(DEPLOY_TARGETS[id].endpoints) as CloudOperation[]),
  ),
].sort();

/** The one transport each target's credential model selects. */
function expectedTransportId(targetId: DeployTargetId): CloudTransport['id'] {
  return targetId === 'aws' ? 'aws-cli' : 'fetch-bearer';
}

/**
 * The context `CloudService` builds for one operation, mirrored here so an
 * expected URL can be derived from the registry.
 *
 * The switch is exhaustive on `CloudOperation`, so a twelfth operation fails to
 * compile rather than silently skipping its case.
 */
function contextFor(op: CloudOperation): CloudEndpointContext {
  switch (op) {
    // The three operations a push dispatches, all against the open document.
    case 'push-spec':
    case 'push-connections':
    case 'read-connections':
      return { workflowId: ACTIVE_WORKFLOW_ID };
    // `runId` is minted inside `triggerHttp` and no target's path reads it.
    case 'trigger':
    case 'purge':
    case 'status':
    case 'run-history':
      return { workflowId: TARGET_WORKFLOW_ID };
    case 'run-detail':
      return { workflowId: TARGET_WORKFLOW_ID, runId: RUN_ID };
    // `since` is left undefined for an unbounded window, so each target
    // supplies its own epoch form.
    case 'usage':
      return { workflowId: TARGET_WORKFLOW_ID };
    // Root-scoped: the connection vault belongs to the deployment.
    case 'put-secret':
      return { workflowId: '', connectionId: CONNECTION_ID, secretKey: SECRET_KEY };
    case 'list-secret-names':
      return { workflowId: '' };
  }
}

/**
 * The operations that address the deployment rather than one instance, read
 * from the registry: an operation every declaring target scopes to `root`.
 *
 * They take no workflow id at all, so an enumeration over workflow ids must not
 * invent one for them - `CloudService` passes the empty string and the URL never
 * carries an instance segment.
 */
const ROOT_SCOPED_OPERATIONS = new Set<CloudOperation>(
  OPERATIONS.filter(op =>
    TARGET_IDS.every(id => (DEPLOY_TARGETS[id].endpoints[op]?.scope ?? 'root') === 'root'),
  ),
);

/**
 * The context `CloudService` builds for one operation when the instance being
 * addressed is `workflowId`.
 *
 * {@link contextFor} supplies every other field; only the instance identity
 * varies across the workflow-id enumeration.
 */
function contextForId(op: CloudOperation, workflowId: string): CloudEndpointContext {
  const ctx = contextFor(op);
  return ROOT_SCOPED_OPERATIONS.has(op) ? ctx : { ...ctx, workflowId };
}

/** The instance id one operation's driver addresses, per {@link contextFor}. */
function driverWorkflowId(op: CloudOperation): string {
  return contextFor(op).workflowId;
}

/** How one operation is driven, and which operations that driver dispatches. */
interface OperationDriver {
  /** In the order `CloudService` issues them. */
  readonly dispatches: readonly CloudOperation[];
  /**
   * `workflowId` is the instance to address. The push driver pins it on the
   * active document, because a push addresses whatever is open rather than an id
   * it is handed; a root-scoped driver ignores it.
   */
  run(harness: CloudHarness, workflowId: string): Promise<unknown>;
}

/**
 * A push dispatches three operations in one call: connection metadata, the
 * inventory read-back, then the spec. A target that folds the metadata into the
 * spec push declares no `push-connections` route and must issue two requests,
 * not three.
 */
const PUSH_DRIVER: OperationDriver = {
  dispatches: ['push-connections', 'read-connections', 'push-spec'],
  run: (harness, workflowId) => {
    harness.setActiveWorkflowId(workflowId);
    return harness.cloud.pushWorkflow();
  },
};

/** One public entry point per operation - nothing reaches into `call`. */
const DRIVERS: Readonly<Record<CloudOperation, OperationDriver>> = {
  'push-spec': PUSH_DRIVER,
  'push-connections': PUSH_DRIVER,
  'read-connections': PUSH_DRIVER,
  trigger: {
    dispatches: ['trigger'],
    run: (harness, workflowId) => harness.cloud.triggerHttp(workflowId, 'hello'),
  },
  purge: {
    dispatches: ['purge'],
    run: (harness, workflowId) => harness.cloud.removeWorkflow(workflowId),
  },
  status: {
    dispatches: ['status'],
    run: (harness, workflowId) => harness.cloud.refreshStatus(workflowId),
  },
  'run-history': {
    dispatches: ['run-history'],
    run: (harness, workflowId) => harness.cloud.listRuns(workflowId),
  },
  'run-detail': {
    dispatches: ['run-detail'],
    run: (harness, workflowId) => harness.cloud.fetchRunRecord(workflowId, RUN_ID),
  },
  usage: {
    dispatches: ['usage'],
    run: (harness, workflowId) => harness.cloud.fetchUsage(workflowId, 0),
  },
  'put-secret': {
    dispatches: ['put-secret'],
    run: harness => harness.cloud.putConnectionSecret(CONNECTION_ID, SECRET_KEY, 'secret-value'),
  },
  'list-secret-names': {
    dispatches: ['list-secret-names'],
    run: harness => harness.cloud.connectionSecretNames(),
  },
};

/** One dispatched request, as the transport that carried it saw it. */
interface RecordedRequest {
  transport: CloudTransport['id'];
  method: string;
  url: string;
  /** The bearer header, or null when the request carried none. */
  authorization: string | null;
}

/** The comparable form: which transport carried what, to where. */
function describeRequest(request: RecordedRequest): string {
  return `${request.transport} ${request.method} ${request.url}`;
}

/**
 * The private `transport` computed.
 *
 * Reached deliberately for the monitor-URL half of the property:
 * `monitorSocketUrl` is the seam Requirements 11.1 and 11.4 constrain, and
 * driving it through `connect()` would mean replacing the global `WebSocket`
 * constructor - which karma itself uses to reach its server.
 */
function transportOf(cloud: CloudService): CloudTransport {
  return (cloud as unknown as { transport: () => CloudTransport }).transport();
}

/**
 * The one harness every property in this section runs on.
 *
 * One TestBed with all three targets configured at once, both transports
 * recording rather than performing, and the active document's id pinned so an
 * expected URL is computable. Shared rather than duplicated per property: they
 * ask different questions (which transport carried a request, where it was
 * addressed) of the same closed enumeration space.
 */
interface CloudHarness {
  readonly cloud: CloudService;
  readonly workflow: WorkflowService;
  readonly settings: SettingsService;
  readonly awsConfig: AwsDeployConfigService;
  readonly awsRequest: AwsRequestService;
  readonly awsCli: AwsCliService;
  /**
   * Every request either transport carried, in dispatch order. Cleared in place
   * (`log.length = 0`) so the reference handed to a caller stays live.
   */
  readonly log: RecordedRequest[];
  /**
   * Re-pins the id `exportActiveSpec` reports, which is the instance the three
   * push operations address.
   */
  setActiveWorkflowId(workflowId: string): void;
  /**
   * Undoes every write that outlives the injector.
   *
   * `triggerApiUrl`, the worker URL, the token, the Phorma Cloud URL and the
   * chosen provider all persist to localStorage (they have to survive a
   * restart), and karma runs ONE browser for the whole suite - so anything set
   * here leaks into every later spec's injector unless it is reset.
   */
  reset(): void;
}

/**
 * Every AWS deploy-config field back to its default.
 *
 * Used from both ends: {@link CloudHarness.reset} calls it so a malformed value
 * never outlives the injector, and Property 23 calls it before applying an
 * enumerated state so a case starts from a known store rather than from whatever
 * the previous spec persisted.
 *
 * Retention is the one field that is not valid-when-empty, so "cleared" for it
 * means back to its default rather than blank.
 */
function clearAwsDeployConfig(awsConfig: AwsDeployConfigService): void {
  awsConfig.setAccountId('');
  awsConfig.setRegion('');
  awsConfig.setNamePrefix('');
  awsConfig.setPermissionsBoundaryArn('');
  awsConfig.setBootstrapQualifier('');
  awsConfig.setVpcId('');
  awsConfig.setSubnetIds([]);
  awsConfig.setAppCmkArn('');
  awsConfig.setTagSet({});
  awsConfig.setRetentionDays(AWS_DEFAULT_RETENTION_DAYS);
  awsConfig.setNotificationTargetArn('');
  awsConfig.setCloudAwsDirectory('');
  awsConfig.setImageUri('');
  awsConfig.monitorApiUrl.set('');
}

/**
 * A complete, well-formed AWS configuration - every REQUIRED field populated.
 *
 * Requirement 2.4: the aggregate validity signal is true only when every required
 * field holds a value, so a store carrying nothing but the discovered
 * `triggerApiUrl` reports INVALID and `configured()` reads false for `aws`. Every
 * property here that drives an `aws` operation therefore needs a real
 * configuration, not just the endpoint.
 *
 * Optional fields are left empty deliberately: `appCmkArn` is set because the
 * `filled` validity case needs a cross-field agreement that holds, and the rest
 * (`vpc`, `imageUri`, `monitorApiUrl`) stay absent so the valid state does not
 * quietly depend on them.
 */
function applyValidAwsDeployConfig(awsConfig: AwsDeployConfigService): void {
  awsConfig.setAccountId('123456789012');
  awsConfig.setRegion('us-east-1');
  awsConfig.setNamePrefix('phorma-studio');
  awsConfig.setPermissionsBoundaryArn('arn:aws:iam::123456789012:policy/PlatformBoundary');
  awsConfig.setBootstrapQualifier('phorma');
  awsConfig.setAppCmkArn('arn:aws:kms:us-east-1:123456789012:key/1a2b3c4d');
  awsConfig.setNotificationTargetArn('arn:aws:sns:us-east-1:123456789012:platform-alarms');
  awsConfig.setTagSet({ app: 'phorma', owner: 'ops' });
  awsConfig.setRetentionDays(90);
  awsConfig.setCloudAwsDirectory('C:/Dev/phorma/cloud-aws');
}

/** Builds the TestBed and installs both recording transports. */
function configureCloudHarness(): CloudHarness {
  const clerk$ = new ReplaySubject<unknown>(1);
  const client$ = new ReplaySubject<unknown>(1);
  const session$ = new ReplaySubject<unknown>(1);
  const user$ = new ReplaySubject<unknown>(1);
  const organization$ = new ReplaySubject<unknown>(1);
  clerk$.next({});
  client$.next(undefined);
  // A signed-in session, so both Cloudflare targets resolve a real bearer
  // rather than falling back to the static token.
  session$.next({ getToken: async () => CLERK_JWT });
  user$.next(undefined);
  organization$.next(undefined);

  TestBed.configureTestingModule({
    providers: [
      { provide: TauriService, useValue: { isDesktop: false } },
      { provide: ClerkService, useValue: { clerk$, client$, session$, user$, organization$ } },
      // The local connection library is not under test here, and every push
      // case reads it - so it answers from memory instead of IndexedDB.
      { provide: ConnectionStoreService, useValue: { list: async () => [] } },
    ],
  });

  const cloud = TestBed.inject(CloudService);
  const workflow = TestBed.inject(WorkflowService);
  const settings = TestBed.inject(SettingsService);
  const awsConfig = TestBed.inject(AwsDeployConfigService);
  const awsRequest = TestBed.inject(AwsRequestService);
  const awsCli = TestBed.inject(AwsCliService);
  const log: RecordedRequest[] = [];

  // Every target configured at once, so a case only switches the provider. For
  // `aws` that means a COMPLETE configuration plus the discovered endpoint:
  // requirement 12.5 reads the aggregate validity too, and requirement 2.4 makes
  // an untouched store invalid.
  cloud.setWorkerUrl(WORKER_BASE);
  cloud.setToken('');
  cloud.setPhormaCloudUrl(PHORMA_BASE);
  applyValidAwsDeployConfig(awsConfig);
  awsConfig.triggerApiUrl.set(TRIGGER_BASE);

  workflow.newWorkflow();
  workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
  // A draft mints a fresh `wf-<base36>` id on every export, which no expected
  // URL could name. Pin it, keeping the real graph.
  const drafted = workflow.exportActiveSpec();
  expect(drafted).toBeTruthy();
  const pinned = { ...drafted!, id: ACTIVE_WORKFLOW_ID };
  let activeWorkflowId = ACTIVE_WORKFLOW_ID;
  spyOn(workflow, 'exportActiveSpec').and.callFake(() => ({
    ...structuredClone(pinned),
    id: activeWorkflowId,
  }));

  spyOn(window, 'fetch').and.callFake(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // `ModelPricingService` kicks an OpenRouter price sync from its
    // constructor, so every injector this suite builds issues one unrelated
    // request. Recording it would make the enumeration order-dependent on
    // whether that microtask happened to land inside a case.
    if (!TARGET_BASES.some(base => url.startsWith(base))) {
      return new Response('{}', { status: 200 });
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    log.push({
      transport: 'fetch-bearer',
      method: init?.method ?? 'GET',
      url,
      authorization: headers['Authorization'] ?? null,
    });
    return new Response(RESPONSE_BODY, { status: 200 });
  });

  type AwsSend = (
    url: string,
    init: { method: HttpMethod; body?: string },
  ) => Promise<AwsRequestResult>;
  const awsSend: AwsSend = async (url, init) => {
    log.push({ transport: 'aws-cli', method: init.method, url, authorization: null });
    return { ok: true, response: { status: 200, headers: {}, body: RESPONSE_BODY } };
  };
  spyOn(awsRequest, 'send').and.callFake(awsSend);
  spyOn(awsRequest, 'monitorUrl').and.resolveTo({ ok: true, url: PRESIGNED_MONITOR_URL });

  return {
    cloud,
    workflow,
    settings,
    awsConfig,
    awsRequest,
    awsCli,
    log,
    setActiveWorkflowId: workflowId => {
      activeWorkflowId = workflowId;
    },
    reset: () => {
      awsConfig.triggerApiUrl.set('');
      cloud.setWorkerUrl('');
      cloud.setToken('');
      // An empty argument restores `PHORMA_CLOUD_DEFAULT_URL`.
      cloud.setPhormaCloudUrl('');
      settings.cloudProvider.set(null);
      awsCli.running.set(false);
      // Every field the aggregate validity signal reads, back to its default.
      // Property 23 deliberately malforms these to drive `valid()` false, and a
      // leaked `accountId` of `'123'` would make `configured()` read FALSE for
      // `aws` in every later spec - the same leak in the other direction.
      clearAwsDeployConfig(awsConfig);
      // `AwsDeployConfigService` persists through `effect()`, not from its
      // setters, so the writes above are still queued at this point. Flush them
      // or the localStorage value the NEXT injector loads is the malformed one
      // this spec set, not the cleared one.
      TestBed.inject(ApplicationRef).tick();
    },
  };
}

/**
 * The requests one driver must produce against one target, derived from that
 * target's own route table: an operation the target does not declare contributes
 * nothing, which is how an absent route is asserted as no request at all rather
 * than as a request through some other transport.
 *
 * Every part of a URL comes from the registry - `instanceUrl` for an
 * instance-scoped route, the bare base for a root-scoped one, and `path` for the
 * rest. There is no path literal here either, so a route shape that changed in
 * the registry changes what this expects.
 */
function expectedRequests(
  targetId: DeployTargetId,
  driver: OperationDriver,
  base: string,
  workflowId: string,
): string[] {
  const target = DEPLOY_TARGETS[targetId];
  const lines: string[] = [];
  for (const op of driver.dispatches) {
    const endpoint = target.endpoints[op];
    if (!endpoint) continue;
    const ctx = contextForId(op, workflowId);
    const scoped =
      endpoint.scope === 'instance' ? target.instanceUrl(base, ctx.workflowId || 'default') : base;
    const url = `${scoped}${endpoint.path(ctx)}`;
    lines.push(`${expectedTransportId(targetId)} ${endpoint.method} ${url}`);
  }
  return lines;
}

/**
 * Property 21: the transport seam selects by Deploy_Target and by nothing else.
 *
 * Exhaustive enumeration over the closed space: every target in
 * `DEPLOY_TARGETS` crossed with every operation any target declares, each case
 * run twice - once with the Plan and Deploy concurrency signal idle and once
 * with it busy. `fast-check` is an `engine` dependency and must not be added
 * here, so "property" means the whole product, not sampling.
 *
 * Each case asserts the exact sequence of requests the driver produced,
 * including which transport carried each one, so one comparison catches a
 * transport chosen by operation, an AWS path that fell through to `fetch`, a
 * route borrowed from the other host's table, a missing request and an extra
 * one alike.
 *
 * **Validates: Requirements 1.6, 10.8, 10.10, 11.4**
 */
describe('Property 21: Transport seam selects by target only', () => {
  let harness: CloudHarness;
  let cloud: CloudService;
  let settings: SettingsService;
  let awsCli: AwsCliService;
  /** Every request either transport carried, in dispatch order. */
  let log: RecordedRequest[];

  beforeEach(() => {
    harness = configureCloudHarness();
    cloud = harness.cloud;
    settings = harness.settings;
    awsCli = harness.awsCli;
    log = harness.log;
  });

  afterEach(() => harness.reset());

  for (const targetId of TARGET_IDS) {
    for (const op of OPERATIONS) {
      const declared = DEPLOY_TARGETS[targetId].endpoints[op] !== undefined;
      const outcome = declared
        ? `dispatches through ${expectedTransportId(targetId)}`
        : 'makes no request at all';

      it(`${targetId} / ${op}: ${outcome}, idle or busy`, async () => {
        settings.cloudProvider.set(targetId);
        const driver = DRIVERS[op];
        expect(driver).withContext(`no driver registered for operation "${op}"`).toBeTruthy();

        // Requirement 10.10: an AWS HTTP call completes while a plan or deploy
        // streams, and neither reads nor writes that concurrency signal. Both
        // halves are asserted - the busy half proves the call is not gated, the
        // unchanged reading afterwards proves nothing wrote it.
        for (const busy of [false, true] as const) {
          log.length = 0;
          awsCli.running.set(busy);

          await driver.run(harness, driverWorkflowId(op));

          const context = `${targetId} / ${op} / running=${busy}`;
          expect(log.map(describeRequest))
            .withContext(context)
            .toEqual(
              expectedRequests(targetId, driver, cloud.effectiveWorkerUrl(), driverWorkflowId(op)),
            );
          expect(transportOf(cloud).id)
            .withContext(`${context}: transport selected for the target`)
            .toBe(expectedTransportId(targetId));
          expect(awsCli.running())
            .withContext(`${context}: the Plan and Deploy signal must not be written`)
            .toBe(busy);

          // Requirement 10.8: the two Cloudflare targets carry the bearer, and
          // the AWS path carries no bearer anywhere - it is signed instead.
          for (const request of log) {
            expect(request.authorization)
              .withContext(`${context}: ${request.method} ${request.url} authorization`)
              .toBe(targetId === 'aws' ? null : `Bearer ${CLERK_JWT}`);
          }
        }
      });
    }
  }

  for (const targetId of TARGET_IDS) {
    const carries = targetId === 'aws' ? 'no token parameter' : 'the token query parameter';

    it(`${targetId}: the monitor socket URL carries ${carries}, idle or busy`, async () => {
      settings.cloudProvider.set(targetId);
      const instanceBase = DEPLOY_TARGETS[targetId].instanceUrl(
        cloud.effectiveWorkerUrl(),
        TARGET_WORKFLOW_ID,
      );

      for (const busy of [false, true] as const) {
        awsCli.running.set(busy);
        const socketUrl = await transportOf(cloud).monitorSocketUrl(
          instanceBase,
          TARGET_WORKFLOW_ID,
        );
        const parsed = new URL(socketUrl);
        const context = `${targetId} / running=${busy}`;

        if (targetId === 'aws') {
          // Requirement 11.1: whatever the presign produced, verbatim.
          expect(socketUrl).withContext(context).toBe(PRESIGNED_MONITOR_URL);
          expect(parsed.searchParams.get('token')).withContext(context).toBeNull();
          expect(parsed.searchParams.get('X-Amz-Signature')).withContext(context).toBe('abc123');
        } else {
          // Requirement 11.4: the shape that shipped before this feature.
          expect(parsed.protocol).withContext(context).toBe('wss:');
          expect(parsed.searchParams.get('token')).withContext(context).toBe(CLERK_JWT);
        }
        expect(awsCli.running())
          .withContext(`${context}: the Plan and Deploy signal must not be written`)
          .toBe(busy);
      }
    });
  }

  it('enumerates every declared operation and every target', () => {
    // Guards the two ways this enumeration could quietly stop being
    // exhaustive: a target with no coverage, and an operation with no driver.
    expect(TARGET_IDS.length).toBe(3);
    expect(OPERATIONS.length).toBe(11);
    expect(OPERATIONS.every(op => DRIVERS[op] !== undefined)).toBeTrue();
    // The two operations the AWS host deliberately declares no route for, plus
    // the one it folds into `push-spec`.
    const awsEndpoints = DEPLOY_TARGETS['aws'].endpoints;
    expect(awsEndpoints['status']).toBeUndefined();
    expect(awsEndpoints['list-secret-names']).toBeUndefined();
    expect(awsEndpoints['push-connections']).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Feature: aws-byo-deploy, Property 22: Deployed URLs come from the registry
// ───────────────────────────────────────────────────────────────────────────────

/** One enumerated workflow id, and the mistake its shape exists to catch. */
interface WorkflowIdCase {
  /** Short, spec-name safe. */
  readonly label: string;
  readonly id: string;
  /** What this shape is in the enumeration to catch. */
  readonly catches: string;
}

/**
 * The enumerated workflow id set.
 *
 * A single well-behaved id proves almost nothing: `${base}/workflows/${id}` and
 * a registry call agree on it. These six disagree under every plausible way the
 * service could take over URL building - a literal segment, a `default`
 * fallback that moved, an id re-encoded or normalized on the way through, or a
 * `new URL()` round-trip that rewrites what the registry emitted.
 */
const WORKFLOW_ID_CASES: readonly WorkflowIdCase[] = [
  {
    label: 'minted',
    id: 'wf-m8k2p1q',
    catches: 'the ordinary `wf-<base36>` shape every saved workflow carries',
  },
  {
    label: 'empty',
    id: '',
    catches: 'an unsaved draft - the one id that must resolve to the `default` instance',
  },
  {
    label: 'needs-encoding',
    id: 'wf id with spaces',
    catches: 'an id a URL parse would percent-encode, so a round-trip through `URL` shows up',
  },
  {
    label: 'slash',
    id: 'wf/nested',
    catches: 'an id that would escape its own path segment and address a different route',
  },
  {
    label: 'query',
    id: 'wf?since=1',
    catches: 'an id that would turn the rest of the path into a query string',
  },
  {
    label: 'unicode',
    id: 'wf-café-日本語',
    catches: 'a non-ASCII id, which any normalization on the way through would rewrite',
  },
];

/** What the patched `instanceUrl` emits. No literal could produce it. */
const REGISTRY_INSTANCE_MARK = '@registry-instance';
/** What the patched `path` emits. Parenthesized so no `/status`-style substring forms. */
const REGISTRY_PATH_MARK = '@registry-path';

/**
 * Every path fragment the registry owns across both route tables.
 *
 * With the registry patched out, none of these may appear after the base in an
 * emitted URL: an occurrence is a literal path in the service.
 */
const REGISTRY_OWNED_FRAGMENTS: readonly string[] = [
  '/agents/workflow-agent/',
  '/workflows/',
  '/workflow',
  '/connections',
  '/trigger',
  '/status',
  '/runs',
  '/usage',
  '/api/connection-secrets',
  '/spec',
  '/secrets/',
];

/**
 * Which registry-owned fragments appear in `url` after `base`.
 *
 * Only after the base, because the synthetic host names carry fragment-like
 * substrings of their own: `https://trigger.example.test` contains `/trigger`
 * inside the scheme's `//`.
 */
function registryOwnedFragmentsIn(url: string, base: string): string[] {
  const tail = url.startsWith(base) ? url.slice(base.length) : url;
  return REGISTRY_OWNED_FRAGMENTS.filter(fragment => tail.includes(fragment));
}

/** What a patched registry function was asked for. */
interface RegistryCalls {
  readonly instanceUrl: { base: string; workflowId: string }[];
  readonly path: { op: CloudOperation; ctx: CloudEndpointContext }[];
}

/**
 * Runs `body` with the target's `instanceUrl` and every dispatched endpoint's
 * `path` replaced by a sentinel-emitting stand-in, recording what each was
 * asked for.
 *
 * This is the half of the property that URL equality cannot reach on its own: a
 * literal in the service that happens to agree with the registry today
 * satisfies the equality. Patch the registry and the equality holds only if the
 * service actually called it.
 *
 * Patched in place rather than through `spyOn` because the restore has to be
 * exact: `phorma` and `cloudflare` SHARE one endpoint table, so patching a spec
 * through one target patches it for the other too.
 */
async function withPatchedRegistry(
  targetId: DeployTargetId,
  ops: readonly CloudOperation[],
  body: (calls: RegistryCalls) => Promise<void>,
): Promise<void> {
  const target = DEPLOY_TARGETS[targetId];
  const calls: RegistryCalls = { instanceUrl: [], path: [] };
  const originalInstanceUrl = target.instanceUrl;
  const originalPaths = new Map<CloudOperation, CloudEndpointSpec['path']>();

  target.instanceUrl = (base, workflowId) => {
    calls.instanceUrl.push({ base, workflowId });
    return `${base}/${REGISTRY_INSTANCE_MARK}(${workflowId})`;
  };
  for (const op of ops) {
    const endpoint = target.endpoints[op];
    if (!endpoint) continue;
    originalPaths.set(op, endpoint.path);
    endpoint.path = ctx => {
      calls.path.push({ op, ctx });
      return `/${REGISTRY_PATH_MARK}(${op})`;
    };
  }
  try {
    await body(calls);
  } finally {
    target.instanceUrl = originalInstanceUrl;
    for (const [op, path] of originalPaths) {
      const endpoint = target.endpoints[op];
      if (endpoint) endpoint.path = path;
    }
  }
}

/** The requests one driver must produce while the registry is patched. */
function expectedPatchedRequests(
  targetId: DeployTargetId,
  driver: OperationDriver,
  base: string,
  workflowId: string,
): string[] {
  const target = DEPLOY_TARGETS[targetId];
  const lines: string[] = [];
  for (const op of driver.dispatches) {
    const endpoint = target.endpoints[op];
    if (!endpoint) continue;
    const ctx = contextForId(op, workflowId);
    // `scope` and `method` stay real - only the two URL-shaping functions are
    // patched, so this still reads the target's own route table for the rest.
    const scoped =
      endpoint.scope === 'instance'
        ? `${base}/${REGISTRY_INSTANCE_MARK}(${ctx.workflowId || 'default'})`
        : base;
    lines.push(
      `${expectedTransportId(targetId)} ${endpoint.method} ${scoped}/${REGISTRY_PATH_MARK}(${op})`,
    );
  }
  return lines;
}

/**
 * Property 22: every deployed URL is composed by the registry.
 *
 * Exhaustive enumeration over the closed space: 3 targets x 6 workflow id
 * shapes x 11 operations = 198 cases, asserted twice - once against the real
 * registry and once against a patched one. `fast-check` is an `engine`
 * dependency and must not be added here, so "property" means the whole product,
 * not sampling.
 *
 * The two halves answer different questions, and neither is sufficient alone:
 *
 * - The URL EQUALS `DEPLOY_TARGETS[target].instanceUrl(base, id)` joined with
 *   the path that target's endpoint spec yields (Requirements 12.4, 12.6). An
 *   operation the target declares no route for produces no URL at all.
 * - The URL FOLLOWS the registry: with `instanceUrl` and `path` patched to emit
 *   sentinels, every emitted URL carries the sentinels and no registry-owned
 *   path fragment survives. Equality alone would pass on a literal in the
 *   service that happens to agree with the registry today.
 *
 * Both `scope` values are covered: an instance-scoped URL must start with the
 * segment `instanceUrl` produced, a root-scoped one must hang off the bare base
 * and carry no instance segment at all.
 *
 * **Validates: Requirements 12.4, 12.6**
 */
describe('Property 22: Deployed URLs come from the registry', () => {
  let harness: CloudHarness;
  let cloud: CloudService;
  let settings: SettingsService;
  /** Every request either transport carried, in dispatch order. */
  let log: RecordedRequest[];

  beforeEach(() => {
    harness = configureCloudHarness();
    cloud = harness.cloud;
    settings = harness.settings;
    log = harness.log;
  });

  // Same leak as Property 21: these keys persist to localStorage and karma runs
  // ONE browser for the whole suite, so `configured()` would read true in every
  // later spec if they were left set.
  afterEach(() => harness.reset());

  for (const targetId of TARGET_IDS) {
    for (const op of OPERATIONS) {
      const declared = DEPLOY_TARGETS[targetId].endpoints[op] !== undefined;
      const outcome = declared
        ? 'addresses the URL the registry composes, for every workflow id shape'
        : 'makes no request at all, for every workflow id shape';

      it(`${targetId} / ${op}: ${outcome}`, async () => {
        settings.cloudProvider.set(targetId);
        const driver = DRIVERS[op];
        const target = DEPLOY_TARGETS[targetId];
        const base = cloud.effectiveWorkerUrl();
        // The base itself is registry-independent, and every expected URL is
        // built on it - so a wrong base would agree with itself.
        expect(base).withContext(`${targetId}: effective base`).toBe(TARGET_BASE_BY_ID[targetId]);

        for (const idCase of WORKFLOW_ID_CASES) {
          log.length = 0;
          await driver.run(harness, idCase.id);

          const context = `${targetId} / ${op} / ${idCase.label} (${idCase.catches})`;
          expect(log.map(describeRequest))
            .withContext(context)
            .toEqual(expectedRequests(targetId, driver, base, idCase.id));

          // Both `scope` values, as the shape difference they are. Indices line
          // up with the expectation above; a mismatch there has already failed.
          const dispatched = driver.dispatches.filter(each => target.endpoints[each]);
          dispatched.forEach((each, index) => {
            const request = log[index];
            if (!request) return;
            const endpoint = target.endpoints[each]!;
            const ctx = contextForId(each, idCase.id);
            const instanceSegment = target
              .instanceUrl(base, ctx.workflowId || 'default')
              .slice(base.length);
            if (endpoint.scope === 'instance') {
              expect(request.url)
                .withContext(`${context}: ${each} is instance-scoped`)
                .toBe(`${base}${instanceSegment}${endpoint.path(ctx)}`);
            } else {
              expect(request.url)
                .withContext(`${context}: ${each} is root-scoped, no instance segment`)
                .toBe(`${base}${endpoint.path(ctx)}`);
              expect(request.url.includes(instanceSegment))
                .withContext(`${context}: ${each} must not carry an instance segment`)
                .toBeFalse();
            }
          });
        }
      });

      const literalOutcome = declared
        ? 'follows the patched registry entry, so no URL comes from a literal path'
        : 'stays absent with the registry patched';

      it(`${targetId} / ${op}: ${literalOutcome}`, async () => {
        settings.cloudProvider.set(targetId);
        const driver = DRIVERS[op];
        const base = cloud.effectiveWorkerUrl();

        for (const idCase of WORKFLOW_ID_CASES) {
          await withPatchedRegistry(targetId, driver.dispatches, async calls => {
            log.length = 0;
            await driver.run(harness, idCase.id);

            const context = `${targetId} / ${op} / ${idCase.label} (${idCase.catches})`;
            expect(log.map(describeRequest))
              .withContext(context)
              .toEqual(expectedPatchedRequests(targetId, driver, base, idCase.id));

            // Requirement 12.4 stated as its contrapositive: with the registry
            // patched, a fragment the registry owns can only have come from a
            // literal in the service.
            for (const request of log) {
              expect(registryOwnedFragmentsIn(request.url, base))
                .withContext(`${context}: ${request.url} carries a literal path fragment`)
                .toEqual([]);
            }

            // Whatever asked for an instance URL asked for the configured base
            // and this id, with the `default` fallback applied - the guard reads
            // and the dispatch both go through here, so every call is checked.
            for (const call of calls.instanceUrl) {
              expect(`${call.base} | ${call.workflowId}`)
                .withContext(`${context}: instanceUrl arguments`)
                .toBe(`${base} | ${idCase.id || 'default'}`);
            }

            // Only the fields the expected context declares: `trigger` also
            // carries a freshly minted `runId` that no path reads, so a deep
            // comparison would be asserting the run-id generator instead.
            for (const call of calls.path) {
              const expected = contextForId(call.op, idCase.id);
              for (const key of Object.keys(expected) as (keyof CloudEndpointContext)[]) {
                expect(call.ctx[key])
                  .withContext(`${context}: ${call.op} path context "${key}"`)
                  .toBe(expected[key]);
              }
            }
          });
        }
      });
    }
  }

  it('enumerates every target, every workflow id shape and every operation', () => {
    // Guards the ways this enumeration could quietly stop being exhaustive.
    expect(TARGET_IDS.length).toBe(3);
    expect(WORKFLOW_ID_CASES.length).toBe(6);
    expect(OPERATIONS.length).toBe(11);
    expect(TARGET_IDS.length * WORKFLOW_ID_CASES.length * OPERATIONS.length).toBe(198);
    expect(new Set(WORKFLOW_ID_CASES.map(each => each.id)).size).toBe(WORKFLOW_ID_CASES.length);
    // The empty id has to be in the set: it is the only one that exercises the
    // `workflowId || 'default'` rule.
    expect(WORKFLOW_ID_CASES.some(each => each.id === '')).toBeTrue();
    // Both `scope` values are reachable, so neither branch is enumerated alone.
    expect(ROOT_SCOPED_OPERATIONS.size).toBe(2);
    expect(OPERATIONS.length - ROOT_SCOPED_OPERATIONS.size).toBe(9);
    // No sentinel can be mistaken for a route the registry owns.
    expect(registryOwnedFragmentsIn(`/${REGISTRY_INSTANCE_MARK}(wf/nested)`, '')).toEqual([]);
    expect(
      OPERATIONS.flatMap(op => registryOwnedFragmentsIn(`/${REGISTRY_PATH_MARK}(${op})`, '')),
    ).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Feature: aws-byo-deploy, Property 23: configured() truth table
// ───────────────────────────────────────────────────────────────────────────────

/**
 * The provider states `configured()` can be asked about: every registry target
 * plus the un-picked one.
 *
 * `none` stands for the persisted `null` - a fresh install that has never
 * visited Settings > Cloud. It is a state of the same axis, not an edge case, so
 * it is enumerated rather than tested once on the side.
 */
type ProviderState = 'none' | DeployTargetId;

/** Read from the registry, so a fourth target enters this enumeration on its own. */
const PROVIDER_STATES: readonly ProviderState[] = ['none', ...TARGET_IDS];

/**
 * The three endpoint values `configured()` can read - one per target, none
 * shared. Ordered so a presence label reads the same way every time.
 */
const ENDPOINT_KEYS = ['phormaCloudUrl', 'workerUrl', 'triggerApiUrl'] as const;
type EndpointKey = (typeof ENDPOINT_KEYS)[number];

/** Which of the three endpoints hold a value, independently of each other. */
type EndpointPresence = Readonly<Record<EndpointKey, boolean>>;

/** The value each endpoint holds when present. */
const ENDPOINT_VALUES: Readonly<Record<EndpointKey, string>> = {
  phormaCloudUrl: PHORMA_BASE,
  workerUrl: WORKER_BASE,
  triggerApiUrl: TRIGGER_BASE,
};

/**
 * All 2^3 present/absent combinations, generated from the key list rather than
 * written out: a hand-listed table is how a combination goes missing, and the
 * cross-target combinations are the point. `configured()` for `cloudflare` must
 * not be rescued by a populated `triggerApiUrl`, and `aws` must not be rescued
 * by the worker URL an operator happens to still have saved.
 */
const ENDPOINT_PRESENCE_CASES: readonly EndpointPresence[] = Array.from(
  { length: 1 << ENDPOINT_KEYS.length },
  (_unused, mask) =>
    Object.fromEntries(
      ENDPOINT_KEYS.map((key, index) => [key, (mask & (1 << index)) !== 0]),
    ) as EndpointPresence,
);

/** Which endpoints are populated, as a spec-name safe label. */
function presenceLabel(presence: EndpointPresence): string {
  const populated = ENDPOINT_KEYS.filter(key => presence[key]);
  return populated.length === 0 ? 'no endpoint' : populated.join('+');
}

/** One enumerated aggregate-validity state of the AWS configuration. */
interface ValidityCase {
  /** Short, spec-name safe. */
  readonly label: string;
  /** What `AwsDeployConfigService.valid()` must report in this state. */
  readonly valid: boolean;
  /** Why this state is in the enumeration. */
  readonly why: string;
  /** Mutates the store into this state, from cleared. */
  apply(awsConfig: AwsDeployConfigService): void;
}

/**
 * The enumerated aggregate-validity states.
 *
 * One valid and four invalid. `valid()` is the conjunction of the per-field
 * validity signals, where a REQUIRED field's validator fails on an empty value
 * and an OPTIONAL field's passes (requirement 2.4), so an untouched store reports
 * INVALID - it is the missing-required-field state, not a vacuously valid one.
 *
 * The single valid state is therefore a genuinely completed configuration, and
 * the four invalid states come from four independently shaped failures - a
 * missing required field, a plain pattern, a cross-field region agreement, and a
 * range check - so a single validator regressing cannot leave the invalid half
 * unexercised, and a `configured()` that dropped `awsConfig.valid()` entirely
 * still fails here.
 */
const AWS_VALIDITY_CASES: readonly ValidityCase[] = [
  {
    label: 'empty',
    valid: false,
    why: 'an untouched store, invalid because every required field is missing',
    apply: () => {},
  },
  {
    label: 'filled',
    valid: true,
    why: 'a genuinely completed configuration - every required field populated',
    apply: applyValidAwsDeployConfig,
  },
  {
    label: 'bad-account-id',
    valid: false,
    why: 'a single malformed field - an account id that is not 12 digits',
    apply: awsConfig => {
      applyValidAwsDeployConfig(awsConfig);
      awsConfig.setAccountId('123');
    },
  },
  {
    label: 'bad-cmk-region',
    valid: false,
    why: 'a cross-field disagreement - a well-formed key ARN in the wrong region',
    apply: awsConfig => {
      applyValidAwsDeployConfig(awsConfig);
      awsConfig.setAppCmkArn('arn:aws:kms:eu-west-1:123456789012:key/1a2b3c4d');
    },
  },
  {
    label: 'bad-retention',
    valid: false,
    why: 'a range check rather than a pattern - a retention window out of range',
    apply: awsConfig => {
      applyValidAwsDeployConfig(awsConfig);
      awsConfig.setRetentionDays(0);
    },
  },
];

/**
 * What requirement 12.5 and the two pre-existing target rules say, as data.
 *
 * Stated as a rule per target rather than as a copy of the `configured()`
 * expression, so the expectation is a reading of the requirement and not a
 * second spelling of the implementation:
 *
 * - `phorma` reports configured while its base URL holds a value.
 * - `cloudflare` reports configured while the operator's worker URL holds a value.
 * - `aws` reports configured while the aggregate configuration validity is true
 *   AND `triggerApiUrl` holds a value (requirement 12.5). A well-formed
 *   configuration that has never deployed reaches nothing.
 * - no target picked is never configured - there is no endpoint that could
 *   satisfy it.
 */
interface ConfiguredRule {
  /** The endpoint that must hold a value, or null when nothing suffices. */
  readonly endpoint: EndpointKey | null;
  /** Whether the aggregate AWS configuration validity is required as well. */
  readonly requiresAggregateValidity: boolean;
}

const CONFIGURED_RULES: Readonly<Record<ProviderState, ConfiguredRule>> = {
  none: { endpoint: null, requiresAggregateValidity: false },
  phorma: { endpoint: 'phormaCloudUrl', requiresAggregateValidity: false },
  cloudflare: { endpoint: 'workerUrl', requiresAggregateValidity: false },
  aws: { endpoint: 'triggerApiUrl', requiresAggregateValidity: true },
};

/** The oracle: whether `configured()` must be true in one enumerated state. */
function expectedConfigured(
  provider: ProviderState,
  presence: EndpointPresence,
  awsValid: boolean,
): boolean {
  const rule = CONFIGURED_RULES[provider];
  if (rule.endpoint === null) return false;
  if (!presence[rule.endpoint]) return false;
  return !rule.requiresAggregateValidity || awsValid;
}

/**
 * Property 23: `configured()` is true exactly under the conditions the
 * requirements state, per target.
 *
 * Exhaustive enumeration over the closed space: 4 provider states x 5
 * aggregate-validity states x 8 endpoint-presence combinations = 160 cases.
 * `fast-check` is an `engine` dependency and must not be added here, so
 * "property" means the whole product, not sampling.
 *
 * Each case asserts three things:
 *
 * - The aggregate validity signal reports what the enumerated state declares, so
 *   an invalid state that quietly became valid fails here rather than silently
 *   turning the validity half of the table into a tautology.
 * - `configured()` equals the oracle. Because the three endpoints vary
 *   independently of the chosen target, this also states the independence
 *   claims: no target is rescued by another target's endpoint, and only `aws`
 *   reads the aggregate validity at all.
 * - The observable consequence on a gated read path. `listRuns` is guarded by
 *   `configured()`, so a false reading must produce no request and the
 *   documented absent value `null`. The discriminating cases are the ones where
 *   the base URL is present and `configured()` is false anyway - `aws` with a
 *   malformed field, and a populated worker URL with no target picked - where
 *   the guard is the only thing that can stop the request.
 *
 * **Validates: Requirements 12.5**
 */
describe('Property 23: configured() truth table', () => {
  let harness: CloudHarness;
  let cloud: CloudService;
  let settings: SettingsService;
  let awsConfig: AwsDeployConfigService;
  /** Every request either transport carried, in dispatch order. */
  let log: RecordedRequest[];

  beforeEach(() => {
    harness = configureCloudHarness();
    cloud = harness.cloud;
    settings = harness.settings;
    awsConfig = harness.awsConfig;
    log = harness.log;
  });

  // Same leak as Properties 21 and 22, and this property widens it: the three
  // endpoints, the chosen provider and every AWS config field persist to
  // localStorage, and karma runs ONE browser for the whole suite. A leaked value
  // here would decide `configured()` in every later spec.
  afterEach(() => harness.reset());

  /** Puts the harness into one enumerated state. */
  function applyCase(
    provider: ProviderState,
    presence: EndpointPresence,
    validity: ValidityCase,
  ): void {
    settings.cloudProvider.set(provider === 'none' ? null : provider);
    // Written through the signals rather than the setters because
    // `setPhormaCloudUrl('')` restores `PHORMA_CLOUD_DEFAULT_URL` - the absent
    // state is not reachable through it, and it is half the truth table.
    cloud.phormaCloudUrl.set(presence.phormaCloudUrl ? ENDPOINT_VALUES.phormaCloudUrl : '');
    cloud.workerUrl.set(presence.workerUrl ? ENDPOINT_VALUES.workerUrl : '');
    awsConfig.triggerApiUrl.set(presence.triggerApiUrl ? ENDPOINT_VALUES.triggerApiUrl : '');
    // Always from a cleared store, so a case composes with neither the previous
    // one nor whatever an earlier spec persisted. The `empty` state is a real
    // enumerated state - it cannot be "whatever the injector loaded".
    clearAwsDeployConfig(awsConfig);
    validity.apply(awsConfig);
  }

  for (const provider of PROVIDER_STATES) {
    for (const validity of AWS_VALIDITY_CASES) {
      const rule = CONFIGURED_RULES[provider];
      const requirement =
        rule.endpoint === null
          ? 'is never configured'
          : rule.requiresAggregateValidity && !validity.valid
            ? 'is never configured while the aggregate configuration is invalid'
            : `is configured exactly while ${rule.endpoint} holds a value`;

      it(`${provider} / aws config ${validity.label}: ${requirement}`, async () => {
        for (const presence of ENDPOINT_PRESENCE_CASES) {
          applyCase(provider, presence, validity);

          const state = `${validity.label} (${validity.why})`;
          const context = `${provider} / ${state} / ${presenceLabel(presence)}`;
          expect(awsConfig.valid())
            .withContext(`${context}: aggregate configuration validity`)
            .toBe(validity.valid);

          const expected = expectedConfigured(provider, presence, validity.valid);
          expect(cloud.configured()).withContext(context).toBe(expected);

          // The observable consequence: `listRuns` is gated on `configured()`.
          log.length = 0;
          const runs = await cloud.listRuns(TARGET_WORKFLOW_ID);
          if (expected) {
            expect(log.length).withContext(`${context}: reads the deployed run history`).toBe(1);
            // Not a shape: the two hosts' `run-history` unwraps differ by
            // design, and this property is about the gate, not the parse. What
            // matters is that a configured target answered with something rather
            // than with the absent value.
            expect(runs).withContext(`${context}: run history`).not.toBeNull();
          } else {
            expect(log.map(describeRequest))
              .withContext(`${context}: an unconfigured target must make no request`)
              .toEqual([]);
            expect(runs).withContext(`${context}: the documented absent value`).toBeNull();
          }
        }
      });
    }
  }

  it('aws requires BOTH aggregate validity and a populated triggerApiUrl', () => {
    // The two halves of requirement 12.5 as the 2x2 they are. The enumeration
    // above already covers these states; stated again on their own because
    // dropping either half of the conjunction is the specific regression this
    // requirement exists to prevent, and a corner table names which half broke.
    settings.cloudProvider.set('aws');
    const invalid = AWS_VALIDITY_CASES.find(each => !each.valid);
    const complete = AWS_VALIDITY_CASES.find(each => each.valid);
    expect(invalid).withContext('an invalid state must exist to enumerate').toBeTruthy();
    expect(complete).withContext('a valid state must exist to enumerate').toBeTruthy();

    for (const validity of [true, false] as const) {
      for (const endpoint of [true, false] as const) {
        harness.reset();
        settings.cloudProvider.set('aws');
        awsConfig.triggerApiUrl.set(endpoint ? TRIGGER_BASE : '');
        // `harness.reset()` clears the store, and a cleared store is INVALID
        // (requirement 2.4), so the valid corner has to be applied rather than
        // left to the default.
        if (validity) complete!.apply(awsConfig);
        else invalid!.apply(awsConfig);

        const context = `aws / valid=${validity} / triggerApiUrl=${endpoint}`;
        expect(awsConfig.valid()).withContext(`${context}: aggregate validity`).toBe(validity);
        expect(cloud.configured())
          .withContext(`${context}: configured only in the both-true corner`)
          .toBe(validity && endpoint);
      }
    }
  });

  it('enumerates every provider state, validity state and endpoint combination', () => {
    // Guards the ways this enumeration could quietly stop being exhaustive.
    expect(PROVIDER_STATES.length).toBe(TARGET_IDS.length + 1);
    expect(PROVIDER_STATES.length).toBe(4);
    expect(AWS_VALIDITY_CASES.length).toBe(5);
    expect(ENDPOINT_PRESENCE_CASES.length).toBe(8);
    expect(
      PROVIDER_STATES.length * AWS_VALIDITY_CASES.length * ENDPOINT_PRESENCE_CASES.length,
    ).toBe(160);
    // Every provider state carries a rule, and every rule names a real endpoint
    // or none at all - so a target added to the registry cannot be enumerated
    // against an undefined rule.
    for (const provider of PROVIDER_STATES) {
      const rule = CONFIGURED_RULES[provider];
      expect(rule).withContext(`no configured() rule for "${provider}"`).toBeTruthy();
      if (rule.endpoint !== null) {
        expect(ENDPOINT_KEYS).withContext(`${provider}: endpoint key`).toContain(rule.endpoint);
      }
    }
    // Exactly one target reads the aggregate configuration validity.
    const validityReaders = PROVIDER_STATES.filter(
      each => CONFIGURED_RULES[each].requiresAggregateValidity,
    );
    expect(validityReaders).toEqual(['aws']);
    // Both validity outcomes are reachable, so neither half of the table is
    // asserted against a constant. The valid one is a genuinely completed
    // configuration: requirement 2.4 makes the untouched store invalid, so there
    // is no vacuously valid state left to mistake for a configured target.
    expect(AWS_VALIDITY_CASES.filter(each => each.valid).length).toBe(1);
    expect(AWS_VALIDITY_CASES.filter(each => !each.valid).length).toBe(4);
    // The untouched store is one of the enumerated INVALID states.
    expect(AWS_VALIDITY_CASES.find(each => each.label === 'empty')?.valid).toBeFalse();
    // Every presence combination is distinct, and both extremes are present.
    expect(new Set(ENDPOINT_PRESENCE_CASES.map(presenceLabel)).size).toBe(8);
    expect(ENDPOINT_PRESENCE_CASES.some(each => ENDPOINT_KEYS.every(key => each[key]))).toBeTrue();
    expect(ENDPOINT_PRESENCE_CASES.some(each => ENDPOINT_KEYS.every(key => !each[key]))).toBeTrue();
    // Every endpoint has a distinct populated value, so a target reading the
    // wrong one cannot agree with the right one by accident.
    expect(new Set(Object.values(ENDPOINT_VALUES)).size).toBe(ENDPOINT_KEYS.length);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Feature: aws-byo-deploy, Property 28: RunEvents reach the run controller untransformed
// ───────────────────────────────────────────────────────────────────────────────

/** The run every corpus frame belongs to. Distinct from Property 21's `RUN_ID`. */
const MONITOR_RUN_ID = 'run-monitor-1';
/** The node every corpus frame names, where the event carries one. */
const MONITOR_NODE_ID = 'node-a1';
/** One fixed timestamp, so a frame is byte-stable across runs. */
const MONITOR_AT = 1_755_000_000_000;

/**
 * A hostile string: non-ASCII, astral-plane, a control character, a quote and a
 * backslash. Every one of them survives `JSON.parse` and every one of them is a
 * plausible casualty of a re-encode on the way to the run controller.
 */
const UNICODE_OUTPUT = 'café 日本語 🙂 ✓ \u0000 \u200f "quoted" back\\slash';

/** ~40 kB of output - large enough that a copy is not free and shows up. */
const LARGE_OUTPUT = `${'section '.repeat(5000)}🙂`;

/**
 * A nested scope path: an array of objects, which is what a shallow copy shares
 * with the object it copied and a re-serialization does not.
 */
const SCOPE_PATH: RunScope[] = [
  {
    nodeId: 'node-exec-1',
    workflowId: 'wf-parent',
    workflowName: 'Parent',
    frameId: 'frame-1',
    depth: 0,
  },
  {
    nodeId: 'node-exec-2',
    workflowId: 'wf-child',
    workflowName: 'Child 日本語',
    frameId: 'frame-2',
    depth: 1,
  },
];

/**
 * One representative frame per `RunEvent` type - the whole union, not a sample.
 *
 * Typed as a total `Record<RunEventType, RunEvent>`, which is what keeps the
 * corpus honest: a new member of the union in `engine/src/events.ts` fails to
 * compile here rather than quietly leaving a type uncovered, and no entry can
 * carry a field the union does not declare.
 *
 * `scope` is present on the events a nested frame emits (the interior of an
 * Execute Workflow) and absent elsewhere, so both shapes are enumerated and
 * roughly half the corpus carries a nested array of objects.
 */
const RUN_EVENT_FRAMES: Readonly<Record<RunEventType, RunEvent>> = {
  'run-started': {
    type: 'run-started',
    runId: MONITOR_RUN_ID,
    input: 'Reconcile the ledger',
    source: 'manual',
    at: MONITOR_AT,
  },
  'node-started': {
    type: 'node-started',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    nodeName: 'Agent A',
    at: MONITOR_AT,
    scope: SCOPE_PATH,
  },
  'node-token': {
    type: 'node-token',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    token: 'Hel',
  },
  'node-thinking': {
    type: 'node-thinking',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    token: 'weighing options',
    scope: SCOPE_PATH,
  },
  'node-usage': {
    type: 'node-usage',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    usage: { inputTokens: 1234, outputTokens: 567, costUsd: 0.0123, costSource: 'reported' },
    at: MONITOR_AT,
  },
  'node-completed': {
    type: 'node-completed',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    nodeName: 'Agent A',
    output: 'ledger reconciled',
    at: MONITOR_AT,
    scope: SCOPE_PATH,
  },
  'node-failed': {
    type: 'node-failed',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    nodeName: 'Agent A',
    error: 'provider refused the request',
    at: MONITOR_AT,
  },
  'node-retrying': {
    type: 'node-retrying',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    nodeName: 'Agent A',
    attempt: 2,
    maxAttempts: 5,
    delayMs: 250,
    error: 'HTTP 429',
    at: MONITOR_AT,
    scope: SCOPE_PATH,
  },
  'node-fallback': {
    type: 'node-fallback',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    nodeName: 'Agent A',
    fromProvider: 'anthropic',
    fromModel: 'claude-sonnet-4',
    toProvider: 'openai',
    toModel: 'gpt-4.1',
    error: 'HTTP 503',
    at: MONITOR_AT,
  },
  'node-error-routed': {
    type: 'node-error-routed',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    nodeName: 'Agent A',
    error: 'routed to the error branch',
    at: MONITOR_AT,
  },
  'context-compressed': {
    type: 'context-compressed',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    beforeTokens: 8000,
    afterTokens: 2100,
    at: MONITOR_AT,
  },
  handoff: {
    type: 'handoff',
    runId: MONITOR_RUN_ID,
    connectionId: 'edge-1',
    fromNodeId: MONITOR_NODE_ID,
    toNodeId: 'node-b2',
    payload: '{"items":[1,2,3]}',
    at: MONITOR_AT,
    scope: SCOPE_PATH,
  },
  'tool-call': {
    type: 'tool-call',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    toolNodeId: 'node-tool-1',
    name: 'search_ledger',
    arguments: '{"q":"invoice 42"}',
    at: MONITOR_AT,
    scope: SCOPE_PATH,
  },
  'tool-result': {
    type: 'tool-result',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    toolNodeId: 'node-tool-1',
    name: 'search_ledger',
    result: '{"rows":2}',
    isError: false,
    at: MONITOR_AT,
  },
  'approval-required': {
    type: 'approval-required',
    runId: MONITOR_RUN_ID,
    requestId: 'req-1',
    nodeId: MONITOR_NODE_ID,
    message: 'Send the payment run?',
    payload: '{"total":1200}',
    at: MONITOR_AT,
  },
  'approval-resolved': {
    type: 'approval-resolved',
    runId: MONITOR_RUN_ID,
    requestId: 'req-1',
    nodeId: MONITOR_NODE_ID,
    approved: true,
    at: MONITOR_AT,
  },
  'ask-required': {
    type: 'ask-required',
    runId: MONITOR_RUN_ID,
    requestId: 'req-2',
    nodeId: MONITOR_NODE_ID,
    nodeName: 'Ask the owner',
    question: 'Which cost centre?',
    payload: '{"options":["ops","rnd"]}',
    at: MONITOR_AT,
  },
  'ask-resolved': {
    type: 'ask-resolved',
    runId: MONITOR_RUN_ID,
    requestId: 'req-2',
    nodeId: MONITOR_NODE_ID,
    response: 'ops',
    at: MONITOR_AT,
  },
  'loop-started': {
    type: 'loop-started',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    nodeName: 'For each invoice',
    total: 3,
    at: MONITOR_AT,
  },
  'loop-iteration': {
    type: 'loop-iteration',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    index: 1,
    total: 3,
    item: '{"invoice":"INV-2"}',
    at: MONITOR_AT,
    scope: SCOPE_PATH,
  },
  'loop-completed': {
    type: 'loop-completed',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    total: 3,
    succeeded: 2,
    failed: 1,
    at: MONITOR_AT,
  },
  'wait-started': {
    type: 'wait-started',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    nodeName: 'Wait for signature',
    correlationKey: 'esign:INV-2',
    message: 'Waiting for the counter-signature',
    payload: '{"doc":"INV-2"}',
    at: MONITOR_AT,
  },
  'wait-resolved': {
    type: 'wait-resolved',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    correlationKey: 'esign:INV-2',
    eventPayload: '{"signedAt":"2026-08-16T10:00:00Z"}',
    at: MONITOR_AT,
  },
  'subworkflow-started': {
    type: 'subworkflow-started',
    runId: MONITOR_RUN_ID,
    nodeId: 'node-exec-2',
    nodeName: 'Execute child',
    workflowId: 'wf-child',
    workflowName: 'Child 日本語',
    depth: 1,
    input: '{"invoice":"INV-2"}',
    at: MONITOR_AT,
    scope: SCOPE_PATH,
  },
  'subworkflow-completed': {
    type: 'subworkflow-completed',
    runId: MONITOR_RUN_ID,
    nodeId: 'node-exec-2',
    nodeName: 'Execute child',
    workflowId: 'wf-child',
    workflowName: 'Child 日本語',
    depth: 1,
    output: '{"posted":true}',
    at: MONITOR_AT,
    scope: SCOPE_PATH,
  },
  'subworkflow-failed': {
    type: 'subworkflow-failed',
    runId: MONITOR_RUN_ID,
    nodeId: 'node-exec-2',
    nodeName: 'Execute child',
    workflowId: 'wf-child',
    workflowName: 'Child 日本語',
    depth: 1,
    error: 'child run failed',
    at: MONITOR_AT,
    scope: SCOPE_PATH,
  },
  'http-request': {
    type: 'http-request',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    nodeName: 'Fetch invoices',
    method: 'POST',
    url: 'https://api.example.test/invoices?page=2',
    attempt: 1,
    body: '{"page":2}',
    at: MONITOR_AT,
  },
  'http-response': {
    type: 'http-response',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    status: 200,
    durationMs: 42,
    byteCount: 1024,
    truncated: false,
    body: '{"items":[]}',
    replayed: false,
    at: MONITOR_AT,
  },
  'page-fetched': {
    type: 'page-fetched',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    page: 2,
    items: 50,
    hasMore: true,
    at: MONITOR_AT,
  },
  'sql-query': {
    type: 'sql-query',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    nodeName: 'Read ledger',
    driver: 'postgres',
    statement: 'SELECT id FROM ledger WHERE posted_at > $1',
    paramCount: 1,
    at: MONITOR_AT,
  },
  'sql-result': {
    type: 'sql-result',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    rowCount: 7,
    durationMs: 0,
    truncated: false,
    replayed: true,
    at: MONITOR_AT,
  },
  'state-read': {
    type: 'state-read',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    key: 'watermark:ledger',
    found: true,
    at: MONITOR_AT,
  },
  'state-written': {
    type: 'state-written',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    key: 'watermark:ledger',
    semantics: 'watermark',
    changed: true,
    from: '2026-08-01T00:00:00Z',
    to: '2026-08-16T00:00:00Z',
    at: MONITOR_AT,
  },
  'assert-passed': {
    type: 'assert-passed',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    nodeName: 'Guard rows',
    checked: 4,
    at: MONITOR_AT,
  },
  'assert-breached': {
    type: 'assert-breached',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    nodeName: 'Guard rows',
    assertion: 'rows > 0',
    message: 'no rows returned',
    severity: 'warn',
    routed: false,
    at: MONITOR_AT,
  },
  'notify-sent': {
    type: 'notify-sent',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    channel: 'email',
    target: 'ops@example.test',
    at: MONITOR_AT,
  },
  'sync-summary': {
    type: 'sync-summary',
    runId: MONITOR_RUN_ID,
    summary: {
      sources: { [MONITOR_NODE_ID]: { rows: 10, pages: 2, truncated: false } },
      considered: 10,
      changed: 4,
      written: 4,
      skipped: 6,
      failed: 0,
      targetStatuses: { '200': 4, '429': 1 },
      guards: [{ name: 'row floor', passed: true }],
      watermark: { key: 'watermark:ledger', from: '2026-08-01', to: '2026-08-16' },
    },
    at: MONITOR_AT,
  },
  'run-paused': {
    type: 'run-paused',
    runId: MONITOR_RUN_ID,
    nodeId: MONITOR_NODE_ID,
    at: MONITOR_AT,
  },
  'run-resumed': { type: 'run-resumed', runId: MONITOR_RUN_ID, at: MONITOR_AT },
  'run-completed': {
    type: 'run-completed',
    runId: MONITOR_RUN_ID,
    output: 'ledger reconciled',
    at: MONITOR_AT,
  },
  'run-failed': {
    type: 'run-failed',
    runId: MONITOR_RUN_ID,
    error: 'child run failed',
    at: MONITOR_AT,
  },
  'run-stopped': { type: 'run-stopped', runId: MONITOR_RUN_ID, at: MONITOR_AT },
};

/** One frame the monitor socket delivers, and what its shape is here to catch. */
interface EventFrameCase {
  /** Short, spec-name safe. */
  readonly label: string;
  /** The exact bytes the socket carries. */
  readonly frame: string;
  /** What this frame is in the enumeration to catch. */
  readonly catches: string;
}

/**
 * Frames the `RunEvent` union cannot express, which is exactly why they belong
 * in the enumeration.
 *
 * The union is the Studio's reading of the wire, not the wire itself. A deployed
 * host is free to be newer than the Studio, and a member or a type the Studio
 * does not know about is the case a transform is most likely to eat: anything
 * that rebuilds the event from its declared fields drops them silently, and a
 * deep equality against the parsed frame is the only thing that notices.
 */
const WIRE_ODDITY_CASES: readonly EventFrameCase[] = [
  {
    label: 'unicode-output',
    frame: JSON.stringify({
      type: 'run-completed',
      runId: MONITOR_RUN_ID,
      output: UNICODE_OUTPUT,
      at: MONITOR_AT,
    }),
    catches: 'non-ASCII, astral-plane, control and escaped characters through a re-encode',
  },
  {
    label: 'large-payload',
    frame: JSON.stringify({
      type: 'node-completed',
      runId: MONITOR_RUN_ID,
      nodeId: MONITOR_NODE_ID,
      nodeName: 'Agent A',
      output: LARGE_OUTPUT,
      at: MONITOR_AT,
      scope: SCOPE_PATH,
    }),
    catches: 'a ~40 kB payload, where a truncation or a cap would show up',
  },
  {
    label: 'deep-nesting',
    frame: JSON.stringify({
      type: 'sync-summary',
      runId: MONITOR_RUN_ID,
      summary: {
        sources: { [MONITOR_NODE_ID]: { rows: 3, pages: 1 }, 'node-b2': { rows: 0 } },
        considered: 3,
        changed: 1,
        written: 1,
        skipped: 2,
        failed: 0,
        targetStatuses: { '200': 1 },
        guards: [
          { name: 'row floor', passed: false, message: 'below floor' },
          { name: 'freshness', passed: true },
        ],
        watermark: { key: 'watermark:ledger', to: '2026-08-16' },
      },
      at: MONITOR_AT,
      scope: SCOPE_PATH,
    }),
    catches: 'objects inside arrays inside objects - what a shallow copy shares',
  },
  {
    label: 'null-member',
    frame: `{"type":"run-paused","runId":"${MONITOR_RUN_ID}","nodeId":null,"at":${MONITOR_AT}}`,
    catches: 'a null member, which a defaulting or coercing copy turns into undefined or ""',
  },
  {
    label: 'unknown-member',
    frame:
      `{"at":${MONITOR_AT},"output":"ok","type":"run-completed","runId":"${MONITOR_RUN_ID}",` +
      '"hostVersion":"2.0","extra":{"nested":[1,2,{"deep":true}]}}',
    catches: 'members the union does not declare, plus a key order that is not the declared one',
  },
  {
    label: 'unknown-type',
    frame: `{"type":"future-event","runId":"${MONITOR_RUN_ID}","detail":{"n":1},"at":${MONITOR_AT}}`,
    catches: 'an event type a newer host emits, which the Studio must relay rather than drop',
  },
];

/**
 * The whole delivered corpus: every `RunEvent` type plus the wire shapes the
 * union cannot express.
 */
const EVENT_FRAME_CASES: readonly EventFrameCase[] = [
  ...(Object.entries(RUN_EVENT_FRAMES) as [RunEventType, RunEvent][]).map(([type, event]) => ({
    label: type,
    frame: JSON.stringify(event),
    catches: `the declared shape of the "${type}" event`,
  })),
  ...WIRE_ODDITY_CASES,
];

/** The replay-complete sentinel: monitor plumbing, never a run event. */
const MONITOR_SYNCED_FRAME = JSON.stringify({ type: 'monitor-synced' });

/** One frame that is not a run event at all, and what must happen to it. */
interface MalformedFrameCase {
  readonly label: string;
  readonly frame: string;
  /**
   * Whether the handler can read a `type` member off the parse result at all.
   *
   * `false` means the frame cannot reach `apply`: either `JSON.parse` throws or
   * the property read on the parsed value does, and the handler's `catch`
   * swallows both. `true` means the parse succeeded and produced something with
   * no `type` - the handler passes it on verbatim, which is still the untransformed
   * claim, and the run controller's own switch matches nothing.
   */
  readonly reachesApply: boolean;
  readonly why: string;
}

/**
 * Frames a socket can deliver that are not events.
 *
 * Two groups, and the split is a reading of the handler rather than a wish: the
 * frames whose parse throws (or whose parse yields `null`, so the `type` read
 * throws) are swallowed and never reach `apply`; a bare JSON scalar or array
 * parses fine and carries no `type`, so it reaches `apply` verbatim. Neither
 * group may throw out of the handler, and no frame in either group may reach
 * `apply` carrying a `type`.
 */
const MALFORMED_FRAMES: readonly MalformedFrameCase[] = [
  {
    label: 'not-json',
    frame: 'monitor connected, standing by',
    reachesApply: false,
    why: 'a plain text frame - `JSON.parse` throws and the handler swallows it',
  },
  {
    label: 'truncated-json',
    frame: `{"type":"run-completed","runId":"${MONITOR_RUN_ID}"`,
    reachesApply: false,
    why: 'a frame cut mid-object, which is what a dropped continuation looks like',
  },
  {
    label: 'json-null',
    frame: 'null',
    reachesApply: false,
    why: 'parses to null, so reading `type` throws and the handler swallows it',
  },
  {
    label: 'json-number',
    frame: '42',
    reachesApply: true,
    why: 'parses to a number with no `type`, so it is relayed verbatim and matches nothing',
  },
  {
    label: 'json-string',
    frame: '"just a string"',
    reachesApply: true,
    why: 'parses to a string with no `type`, so it is relayed verbatim and matches nothing',
  },
  {
    label: 'json-true',
    frame: 'true',
    reachesApply: true,
    why: 'parses to a boolean with no `type`, so it is relayed verbatim and matches nothing',
  },
  {
    label: 'json-array',
    frame: '[{"type":"run-completed"}]',
    reachesApply: true,
    why: 'an array has no `type` of its own, so nothing inside it is read as an event',
  },
];

/**
 * JSON with every object's keys sorted, at every depth.
 *
 * The comparison form for "deep-equal, order-independent": a host that emits its
 * members in a different order, or a relay that re-serializes them, is fine; a
 * dropped, added or coerced member is not. Sorting at every depth is what makes
 * the equality a statement about content rather than about key order.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, member: unknown) => {
    if (member === null || typeof member !== 'object' || Array.isArray(member)) return member;
    const entries = Object.keys(member as Record<string, unknown>).sort();
    return Object.fromEntries(entries.map(key => [key, (member as Record<string, unknown>)[key]]));
  });
}

/** The first index at which two strings differ, or -1 when they are equal. */
function firstDifference(got: string, want: string): number {
  const limit = Math.min(got.length, want.length);
  for (let index = 0; index < limit; index += 1) {
    if (got[index] !== want[index]) return index;
  }
  return got.length === want.length ? -1 : limit;
}

/** A readable window around one index of a possibly enormous payload. */
function excerpt(text: string, at: number): string {
  return JSON.stringify(text.slice(Math.max(0, at - 8), at + 24));
}

/**
 * Asserts `received` is deep-equal to `expected`, order-independently.
 *
 * Compared as canonical strings rather than with `toEqual` because a ~40 kB
 * payload printed twice is unreadable and Jasmine truncates whichever end
 * mattered. Length first, then the first differing index with a window around
 * it, so a failure names where the frames diverge.
 */
function expectSameEvent(received: unknown, expected: unknown, context: string): void {
  const got = canonicalJson(received);
  const want = canonicalJson(expected);
  expect(got.length).withContext(`${context}: canonical length`).toBe(want.length);
  const at = firstDifference(got, want);
  const detail =
    at < 0
      ? `${context}: deep-equal`
      : `${context}: diverges at index ${at} of ${want.length}: got ${excerpt(got, at)}, ` +
        `expected ${excerpt(want, at)}`;
  expect(at).withContext(detail).toBe(-1);
}

/**
 * Paths at which `a` and `b` share a nested object or array REFERENCE.
 *
 * This is the half deep equality cannot reach. `{ ...event }` is deep-equal to
 * what was parsed, so no content comparison can see it - but it shares every
 * nested object with the parse result, while a genuine re-serialization shares
 * none. So a copy is acceptable only when this comes back empty.
 */
function sharedNestedPaths(a: unknown, b: unknown, path = '$'): string[] {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return [];
  const found: string[] = [];
  for (const key of Object.keys(a as Record<string, unknown>)) {
    const left = (a as Record<string, unknown>)[key];
    const right = (b as Record<string, unknown>)[key];
    if (left === null || typeof left !== 'object') continue;
    if (left === right) found.push(`${path}.${key}`);
    else found.push(...sharedNestedPaths(left, right, `${path}.${key}`));
  }
  return found;
}

/**
 * The socket `connect()` opened, standing in for a real one.
 *
 * Only the four handler slots and `close` are implemented, because that is all
 * `connect()` and `disconnect()` touch. The point of the whole stand-in is
 * `onmessage`: the property has to run the handler the SERVICE installed, since a
 * copy of it in the spec would keep passing while the real one transformed events.
 */
class RecordingMonitorSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly sent: string[] = [];

  constructor(readonly url: string) {}

  close(): void {
    this.closed = true;
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

/**
 * Runs `connect()` with `window.WebSocket` swapped for a stand-in, and returns
 * the socket it opened - carrying the REAL `onmessage` handler.
 *
 * Karma reaches its own server over the global `WebSocket`, which is why
 * Property 21 drove `monitorSocketUrl` directly instead. Two things make the
 * swap safe here rather than merely convenient:
 *
 * - It is scoped to this one `await` and restored in a `finally`, and karma's
 *   own socket is long since open by the time any spec runs. Nothing between the
 *   presign and `new WebSocket(...)` yields to a macrotask, so no reconnect can
 *   land inside the window.
 * - The stand-in DELEGATES: any URL that is not one of this suite's synthetic
 *   `*.example.test` monitor hosts gets a real `WebSocket`. So even if something
 *   did open a socket inside the window, it would get a working one.
 */
async function openMonitorSocket(
  cloud: CloudService,
  workflowId: string,
): Promise<RecordingMonitorSocket> {
  const realWebSocket = window.WebSocket;
  const opened: RecordingMonitorSocket[] = [];
  const slot = window as unknown as { WebSocket: unknown };

  function MonitorWebSocketStandIn(url: string | URL, protocols?: string | string[]): unknown {
    const text = String(url);
    if (!text.includes('.example.test')) return new realWebSocket(text, protocols);
    const socket = new RecordingMonitorSocket(text);
    opened.push(socket);
    return socket;
  }
  // Keep the real prototype and the readyState constants, so a plain `WebSocket`
  // reference behaves normally for the duration of the swap.
  MonitorWebSocketStandIn.prototype = realWebSocket.prototype;
  Object.assign(MonitorWebSocketStandIn, {
    CONNECTING: realWebSocket.CONNECTING,
    OPEN: realWebSocket.OPEN,
    CLOSING: realWebSocket.CLOSING,
    CLOSED: realWebSocket.CLOSED,
  });

  slot.WebSocket = MonitorWebSocketStandIn;
  try {
    await cloud.connect(workflowId);
  } finally {
    slot.WebSocket = realWebSocket;
  }

  expect(opened.length).withContext(`connect(${workflowId}) must open exactly one socket`).toBe(1);
  const socket = opened[0];
  expect(socket.onmessage)
    .withContext('connect() must install the onmessage handler under test')
    .toBeTruthy();
  return socket;
}

/** Delivers one frame through the handler `connect()` installed. */
function deliverFrame(socket: RecordingMonitorSocket, frame: string): void {
  socket.onmessage!(new MessageEvent('message', { data: frame }));
}

/**
 * The object the HANDLER's own `JSON.parse` produced for `frame`.
 *
 * Needed for the reference half of the property: the handler's parse result is
 * not otherwise observable, and without it a shallow copy is indistinguishable
 * from the real thing.
 */
function parsedByHandler(parseSpy: jasmine.Spy<typeof JSON.parse>, frame: string): unknown {
  const calls = parseSpy.calls.all().filter(call => call.args[0] === frame);
  expect(calls.length).withContext('the handler must parse the frame exactly once').toBe(1);
  return calls[0]?.returnValue as unknown;
}

/**
 * Property 28: a RunEvent arriving on the monitor socket reaches
 * `RunControllerService.apply` untransformed, and the `monitor-synced` sentinel
 * never reaches it at all.
 *
 * Exhaustive enumeration over the closed space: 48 frames (one per member of the
 * `RunEvent` union in `engine/src/events.ts`, plus six wire shapes the union
 * cannot express) x 3 Deploy_Targets = 144 cases, plus 7 malformed frames x 3
 * targets and one sentinel-only delivery per target - 168 in all. `fast-check` is
 * an `engine` dependency and must not be added here, so "property" means the
 * whole product, not sampling.
 *
 * The handler under test is the one `connect()` installs, reached by swapping
 * `window.WebSocket` for a delegating stand-in for the duration of that one call
 * (see {@link openMonitorSocket}). A copy of the handler in the spec would keep
 * passing forever while the real one transformed events, which is the whole point.
 *
 * Each case asserts four things:
 *
 * - `apply` received a value deep-equal to `JSON.parse(frame)`,
 *   order-independently: a host that reorders members or a relay that
 *   re-serializes them is fine, a dropped, added or coerced member is not.
 * - It is either the very object the handler parsed or a COMPLETE copy of it. A
 *   shallow copy is deep-equal and invisible to the comparison above, so it is
 *   caught by the nested references it would share.
 * - Nothing mutated the value after `apply` returned.
 * - The sentinel delivered before and after the event never reached `apply`, and
 *   did not stop the event from arriving.
 *
 * Both credential models, because requirement 11.6 must hold identically on the
 * presigned AWS socket and on the query-token Cloudflare one.
 *
 * **Validates: Requirements 11.6**
 */
describe('Property 28: RunEvents reach the run controller untransformed', () => {
  let harness: CloudHarness;
  let cloud: CloudService;
  let settings: SettingsService;
  let applySpy: jasmine.Spy<(event: RunEvent) => void>;
  let parseSpy: jasmine.Spy<typeof JSON.parse>;
  /** One canonical snapshot per `apply` call, taken AT the call. */
  let applySnapshots: string[];

  beforeEach(() => {
    harness = configureCloudHarness();
    cloud = harness.cloud;
    settings = harness.settings;
    applySnapshots = [];
    // Stubbed rather than called through: this property is about what reaches
    // the run controller, not about what the controller then animates.
    applySpy = spyOn(TestBed.inject(RunControllerService), 'apply').and.callFake(event => {
      applySnapshots.push(canonicalJson(event));
    });
    // Installed last, so the harness's own parsing is not in the recording, and
    // `callThrough` so the handler still gets its real parse result.
    parseSpy = spyOn(JSON, 'parse').and.callThrough();
  });

  // Same leak as Properties 21, 22 and 23: the endpoints, the provider and every
  // AWS config field persist to localStorage and karma runs ONE browser for the
  // whole suite. `disconnect()` first, so no stand-in socket outlives the spec.
  afterEach(() => {
    cloud.disconnect();
    harness.reset();
  });

  /** Clears everything recorded, between targets and between frames. */
  function resetRecording(): void {
    applySpy.calls.reset();
    applySnapshots.length = 0;
    parseSpy.calls.reset();
  }

  for (const frameCase of EVENT_FRAME_CASES) {
    it(`${frameCase.label}: reaches apply untransformed, on every target`, async () => {
      for (const targetId of TARGET_IDS) {
        settings.cloudProvider.set(targetId);
        const socket = await openMonitorSocket(cloud, TARGET_WORKFLOW_ID);
        const context = `${targetId} / ${frameCase.label} (${frameCase.catches})`;

        // Requirements 11.1 and 11.4 as the two credential models they are: the
        // AWS socket is the presigned one, and only it.
        expect(socket.url === PRESIGNED_MONITOR_URL)
          .withContext(`${context}: only the AWS socket is the presigned one`)
          .toBe(targetId === 'aws');

        resetRecording();
        // The sentinel on both sides of the event: the early return must swallow
        // it, and must not stop the handler from delivering what follows.
        deliverFrame(socket, MONITOR_SYNCED_FRAME);
        deliverFrame(socket, frameCase.frame);
        deliverFrame(socket, MONITOR_SYNCED_FRAME);

        expect(applySpy.calls.count())
          .withContext(`${context}: exactly the event, never the sentinel`)
          .toBe(1);
        const received = applySpy.calls.mostRecent().args[0] as unknown;

        // Read BEFORE this spec parses the frame itself, so the recording still
        // holds exactly one parse of it - the handler's own.
        const parsed = parsedByHandler(parseSpy, frameCase.frame);
        expectSameEvent(received, JSON.parse(frameCase.frame) as unknown, context);

        // Deep equality cannot see `{ ...event }`. Either it IS the parsed
        // object, or it is a complete copy sharing none of its nested members.
        if (received !== parsed) {
          expect(sharedNestedPaths(received, parsed))
            .withContext(`${context}: apply received a shallow copy, not the parsed event`)
            .toEqual([]);
        }

        expect(canonicalJson(received))
          .withContext(`${context}: the event was mutated after apply returned`)
          .toBe(applySnapshots[0]);

        cloud.disconnect();
      }
    });
  }

  it('never passes the monitor-synced sentinel, on every target', async () => {
    for (const targetId of TARGET_IDS) {
      settings.cloudProvider.set(targetId);
      const socket = await openMonitorSocket(cloud, TARGET_WORKFLOW_ID);
      resetRecording();

      deliverFrame(socket, MONITOR_SYNCED_FRAME);
      deliverFrame(socket, MONITOR_SYNCED_FRAME);
      expect(applySpy.calls.count())
        .withContext(`${targetId}: the replay-complete sentinel is not a run event`)
        .toBe(0);

      // The early return must not have ended the handler's usefulness: the live
      // events that follow the sentinel are the whole reason it exists.
      deliverFrame(socket, EVENT_FRAME_CASES[0].frame);
      expect(applySpy.calls.count())
        .withContext(`${targetId}: the first live event after the sentinel must arrive`)
        .toBe(1);

      cloud.disconnect();
    }
  });

  it('swallows every frame that is not a run event, on every target', async () => {
    for (const targetId of TARGET_IDS) {
      settings.cloudProvider.set(targetId);
      const socket = await openMonitorSocket(cloud, TARGET_WORKFLOW_ID);

      for (const malformed of MALFORMED_FRAMES) {
        const context = `${targetId} / ${malformed.label} (${malformed.why})`;
        resetRecording();

        expect(() => deliverFrame(socket, malformed.frame))
          .withContext(`${context}: the handler must not throw`)
          .not.toThrow();
        expect(applySpy.calls.count())
          .withContext(`${context}: whether this frame can reach apply at all`)
          .toBe(malformed.reachesApply ? 1 : 0);

        if (malformed.reachesApply) {
          const received = applySpy.calls.mostRecent().args[0] as unknown;
          // Still the untransformed claim: whatever parsed is what was passed.
          expectSameEvent(received, JSON.parse(malformed.frame) as unknown, context);
          // And none of these can be mistaken for an event: no `type` member, so
          // the run controller's switch matches nothing.
          expect((received as { type?: unknown } | null)?.type)
            .withContext(`${context}: no malformed frame may reach apply carrying a type`)
            .toBeUndefined();
        }

        resetRecording();
        deliverFrame(socket, EVENT_FRAME_CASES[0].frame);
        expect(applySpy.calls.count())
          .withContext(`${context}: the handler still delivers the next real event`)
          .toBe(1);
      }

      cloud.disconnect();
    }
  });

  it('enumerates the whole RunEvent union, both socket shapes and every target', () => {
    // Guards the ways this enumeration could quietly stop being exhaustive. The
    // total `Record<RunEventType, RunEvent>` already makes a new member of the
    // union a compile error; these cover the rest.
    const types = Object.keys(RUN_EVENT_FRAMES) as RunEventType[];
    expect(types.length).toBe(42);
    for (const type of types) {
      expect(RUN_EVENT_FRAMES[type].type).withContext(`corpus entry "${type}"`).toBe(type);
    }
    expect(WIRE_ODDITY_CASES.length).toBe(6);
    expect(EVENT_FRAME_CASES.length).toBe(48);
    expect(new Set(EVENT_FRAME_CASES.map(each => each.label)).size).toBe(48);
    expect(new Set(EVENT_FRAME_CASES.map(each => each.frame)).size).toBe(48);
    expect(TARGET_IDS.length).toBe(3);
    expect(EVENT_FRAME_CASES.length * TARGET_IDS.length).toBe(144);
    expect(MALFORMED_FRAMES.length * TARGET_IDS.length).toBe(21);
    expect(144 + 21 + TARGET_IDS.length).toBe(168);

    // Both malformed groups are populated, or one of the two branches above is
    // asserted against nothing.
    expect(MALFORMED_FRAMES.filter(each => each.reachesApply).length).toBe(4);
    expect(MALFORMED_FRAMES.filter(each => !each.reachesApply).length).toBe(3);

    // The shallow-copy half needs frames that HAVE nested members: with both
    // arguments the same object, every nested member is a shared reference, so a
    // non-empty result is exactly "this frame carries nesting".
    const nesting = EVENT_FRAME_CASES.filter(each => {
      const value = JSON.parse(each.frame) as unknown;
      return sharedNestedPaths(value, value).length > 0;
    });
    // 16 of the 48 today: the ten scoped events, `node-usage`, `sync-summary`
    // and four of the six wire oddities. A frame with no nested member cannot
    // catch a shallow copy, so this is what gives that half its teeth.
    expect(nesting.length).toBeGreaterThanOrEqual(16);
    // All three kinds of nesting are represented, not sixteen of the same one.
    expect(nesting.some(each => each.frame.includes('"scope"'))).toBeTrue();
    expect(nesting.some(each => each.label === 'sync-summary')).toBeTrue();
    expect(nesting.some(each => each.label === 'unknown-member')).toBeTrue();

    // Both event shapes are enumerated: a nested frame carries a scope path, a
    // top-level one carries none.
    const scoped = EVENT_FRAME_CASES.filter(each => each.frame.includes('"scope"'));
    expect(scoped.length).toBeGreaterThan(0);
    expect(EVENT_FRAME_CASES.length - scoped.length).toBeGreaterThan(0);

    // The large frame is genuinely large, and the unicode frame really does carry
    // the characters a re-encode would damage.
    const large = EVENT_FRAME_CASES.find(each => each.label === 'large-payload');
    expect(large?.frame.length).toBeGreaterThan(40_000);
    const unicode = EVENT_FRAME_CASES.find(each => each.label === 'unicode-output');
    expect(unicode?.frame).toContain('\\u0000');
    expect(unicode?.frame).toContain('🙂');

    // The sentinel is not itself in the corpus, or "never passed" and "always
    // passed" would be asserted about the same frame.
    expect(EVENT_FRAME_CASES.some(each => each.frame === MONITOR_SYNCED_FRAME)).toBeFalse();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Feature: aws-byo-deploy, Property 29: Capability findings gate the push
// ───────────────────────────────────────────────────────────────────────────────

/**
 * What one slot of the gate graph contributes to the finding set.
 *
 * `clean` contributes nothing, `warning` exactly one warning-severity finding
 * and `error` exactly one error-severity finding - so an assignment of kinds
 * across the slots IS a finding set, which is what lets the enumeration below
 * vary the SET rather than hand-craft a graph per case.
 */
type GateSlotKind = 'clean' | 'warning' | 'error';

/** The closed severity lattice, per slot: nothing, a warning, an error. */
const GATE_SLOT_KINDS: readonly GateSlotKind[] = ['clean', 'warning', 'error'];

/**
 * How many slots the gate graph carries.
 *
 * Four is the smallest width that reaches every lattice point the requirements
 * turn on: the empty set, warning-only and error-only sets of size one AND of
 * size n, mixed sets in every interleaving, and the case requirement 12.2 exists
 * for - a single error hidden among several warnings.
 */
const GATE_SLOT_COUNT = 4;

/** One enumerated finding set, as a per-slot assignment. */
type GateAssignment = readonly GateSlotKind[];

/**
 * Every assignment across the slots: 3^4 = 81 finding sets, generated from the
 * kind list rather than written out. A hand-listed table is how a lattice point
 * goes missing, and the interleavings are the point - a set whose only error sits
 * among warnings is a different claim from an error-only set.
 */
const GATE_ASSIGNMENTS: readonly GateAssignment[] = Array.from(
  { length: GATE_SLOT_KINDS.length ** GATE_SLOT_COUNT },
  (_unused, index) =>
    Array.from(
      { length: GATE_SLOT_COUNT },
      (_slot, position) =>
        GATE_SLOT_KINDS[
          Math.floor(index / GATE_SLOT_KINDS.length ** position) % GATE_SLOT_KINDS.length
        ],
    ),
);

/** How many slots of one assignment carry `kind`. */
function countSlots(assignment: GateAssignment, kind: GateSlotKind): number {
  return assignment.filter(each => each === kind).length;
}

/** One assignment as a spec-name safe label, for example `c-w-e-c`. */
function assignmentLabel(assignment: GateAssignment): string {
  return assignment.map(kind => kind[0]).join('-');
}

/** The one declared secret name an `error` slot's connection is missing. */
const GATE_SECRET_KEY = 'API_KEY';
/** The `baseUrl` that makes a slot node's outbound host statically knowable. */
const GATE_CONNECTION_BASE_URL = 'https://slots.example.test';
/**
 * Every slot node's url: a PATH, never absolute, so the node's outbound host can
 * only come from its connection's `baseUrl`. That is what puts the finding set
 * under the INVENTORY's control rather than the graph's.
 */
const GATE_NODE_PATH = 'items';
/** Fixed, so an inventory entry is byte-stable across runs. */
const GATE_TIMESTAMP = '2026-08-16T00:00:00.000Z';

/** The connection the slot at `index` references. */
function gateConnectionId(index: number): string {
  return `conn-gate-${index + 1}`;
}

/**
 * The inventory entry that puts one slot into one state.
 *
 * All three states are PRESENT in the inventory and differ only in two fields,
 * which is what keeps the graph fixed and makes the finding set a function of the
 * inventory alone:
 *
 * - `clean`: a resolvable host and nothing missing, so no rule fires.
 * - `warning`: no `baseUrl`, so the node's outbound host is not statically
 *   determinable - the validator's only warning-severity rule.
 * - `error`: a resolvable host, so no warning, but one declared secret the host
 *   does not hold - an error-severity rule that says nothing about egress.
 */
function gateConnection(index: number, kind: GateSlotKind): ConnectionSummary {
  const declared = kind === 'error' ? [GATE_SECRET_KEY] : [];
  return {
    id: gateConnectionId(index),
    name: `Gate connection ${index + 1}`,
    type: 'http',
    config: kind === 'warning' ? {} : { baseUrl: GATE_CONNECTION_BASE_URL },
    secretKeys: declared,
    secretsPresent: 0,
    missingSecretKeys: declared,
    auth: { mode: 'none' },
    createdAt: GATE_TIMESTAMP,
    updatedAt: GATE_TIMESTAMP,
  };
}

/** The inventory the AWS connections route answers with, for one assignment. */
function gateInventory(assignment: GateAssignment): ConnectionSummary[] {
  return assignment.map((kind, index) => gateConnection(index, kind));
}

/**
 * Trigger_Route `connections` - the inventory read this property is about.
 *
 * Written out rather than composed from the registry ON PURPOSE: the concrete
 * claim in requirement 12.1 is that the inventory comes from
 * `GET /workflows/{id}/connections`. Property 22 owns the separate claim that the
 * service composes it from the registry, and the enumeration guard below pins the
 * two spellings to each other so this literal cannot drift.
 */
const GATE_INVENTORY_URL = `${TRIGGER_BASE}/workflows/${ACTIVE_WORKFLOW_ID}/connections`;
/** Trigger_Route `spec-push` - the deployment request the gate allows or blocks. */
const GATE_SPEC_URL = `${TRIGGER_BASE}/workflows/${ACTIVE_WORKFLOW_ID}/spec`;
/** The inventory read, carried by the transport a signed AWS route requires. */
const GATE_INVENTORY_REQUEST = `aws-cli GET ${GATE_INVENTORY_URL}`;
/** The deployment request, which an error-carrying set must never produce. */
const GATE_DEPLOY_REQUEST = `aws-cli POST ${GATE_SPEC_URL}`;
/** The host's own rejection message, distinct from anything the validator says. */
const GATE_HOST_ERROR = 'The host refused this spec.';

/** What this case's host answers with. */
interface GateHostAnswer {
  /** The inventory `GET /workflows/{id}/connections` returns. */
  readonly connections: readonly ConnectionSummary[];
  /** The rejection the spec push returns, or null when the host accepts it. */
  readonly rejection: { error: string; findings?: readonly CapabilityFinding[] } | null;
}

/**
 * Re-targets the harness's `AwsRequestService.send` spy at this case's answers.
 *
 * Deliberately not a second harness, and deliberately not an edit to
 * `RESPONSE_BODY`: that body is shared module state Properties 21 and 22 assert
 * against, so a connection inventory added to it would change what they see.
 * Requests are recorded into the harness's own log, so a request that escaped to
 * `fetch` still shows up in the comparison as the wrong transport.
 */
function stubGateHost(harness: CloudHarness, answer: GateHostAnswer): void {
  const respond = (status: number, body: unknown): AwsRequestResult => ({
    ok: true,
    response: { status, headers: {}, body: JSON.stringify(body) },
  });
  const spy = harness.awsRequest.send as jasmine.Spy;
  spy.and.callFake(async (url: string, init: { method: HttpMethod; body?: string }) => {
    harness.log.push({ transport: 'aws-cli', method: init.method, url, authorization: null });
    if (url === GATE_INVENTORY_URL && init.method === 'GET') {
      return respond(200, { connections: answer.connections });
    }
    if (url === GATE_SPEC_URL && init.method === 'POST') {
      return answer.rejection
        ? respond(400, answer.rejection)
        : respond(200, { ok: true, name: 'wf' });
    }
    return respond(404, { error: `unexpected request: ${init.method} ${url}` });
  });
}

/** The Problems console, as `level | message` lines in the order written. */
function problemsConsole(terminal: TerminalOutputService): string[] {
  return terminal
    .entries()
    .filter(entry => entry.channel === 'problems')
    .map(entry => `${entry.level} | ${entry.message}`);
}

/**
 * The console line one finding must produce.
 *
 * The severity mapping is part of the claim: an `error` finding writes at the
 * `error` level and a `warning` at `warning`, so a gate that reported everything
 * as one level would fail here rather than pass on message text alone.
 */
function expectedConsoleLine(finding: CapabilityFinding): string {
  return `${finding.severity} | ${finding.message}`;
}

/**
 * The gate graph: the harness's manual trigger plus one `http-request` node per
 * slot, each referencing its own connection by id. Returns the node ids in slot
 * order, so a finding can be attributed to the slot that produced it.
 */
function buildGateGraph(workflow: WorkflowService): string[] {
  const nodeIds: string[] = [];
  for (let index = 0; index < GATE_SLOT_COUNT; index += 1) {
    const node = workflow.addNodeFromCatalog('data-http-request', { x: 200 * (index + 1), y: 0 });
    expect(node).withContext(`gate slot ${index + 1}`).toBeTruthy();
    if (!node) continue;
    // Distinct names, so a finding names the slot it came from rather than the
    // catalog's default label four times over.
    workflow.updateNode(node.id, { name: `Gate slot ${index + 1}` });
    workflow.updateNodeData(node.id, {
      method: 'GET',
      url: GATE_NODE_PATH,
      responseMode: 'json',
      bodyMode: 'none',
      connectionId: gateConnectionId(index),
    });
    nodeIds.push(node.id);
  }
  return nodeIds;
}

/** One enumerated Host_Adapter rejection body. */
interface GateHostRejectionCase {
  /** Short, spec-name safe. */
  readonly label: string;
  /** The findings the host returned, or null when the body carries none. */
  readonly findings: readonly CapabilityFinding[] | null;
  /** Why this rejection shape is in the enumeration. */
  readonly why: string;
}

/**
 * The host's own finding sets, over the same severity lattice.
 *
 * Requirement 16.8 makes these authoritative, so they are enumerated rather than
 * exercised once: a host is free to reject a spec the Studio validated clean, and
 * the operator has nothing else to go on.
 */
const GATE_HOST_REJECTIONS: readonly GateHostRejectionCase[] = [
  {
    label: 'no-findings',
    findings: null,
    why: 'a rejection with no findings member at all, which must not be read as one',
  },
  {
    label: 'one-error',
    findings: [
      {
        severity: 'error',
        message: 'Host: connection "ledger" has no entry in AWS Secrets Manager.',
      },
    ],
    why: 'a single error-severity finding from the host',
  },
  {
    label: 'one-warning',
    findings: [
      { severity: 'warning', message: 'Host: egress to internal.corp is outside the allow-list.' },
    ],
    why: 'a warning-severity finding on a push the host rejected anyway',
  },
  {
    label: 'mixed',
    findings: [
      { severity: 'error', message: 'Host: the task role cannot reach 10.0.0.0/8.' },
      { severity: 'warning', message: 'Host: the image digest is older than the deployed task.' },
      { severity: 'error', message: 'Host: no subnet in the configured VPC has egress.' },
    ],
    why: 'errors and warnings together, so the severity mapping is exercised here too',
  },
];

/**
 * The error-free local sets the host-rejection enumeration runs on: nothing, one
 * warning, and every slot a warning. An error-carrying set never reaches the host
 * at all - that IS the gate, and it is enumerated exhaustively above.
 */
const GATE_HOST_LOCAL_SETS: readonly GateAssignment[] = [
  Array.from({ length: GATE_SLOT_COUNT }, () => 'clean' as GateSlotKind),
  Array.from({ length: GATE_SLOT_COUNT }, (_slot, index) =>
    index === 1 ? ('warning' as GateSlotKind) : ('clean' as GateSlotKind),
  ),
  Array.from({ length: GATE_SLOT_COUNT }, () => 'warning' as GateSlotKind),
];

/**
 * Property 29: capability findings gate the push, and every finding reaches the
 * Problems console either way.
 *
 * Exhaustive enumeration over the closed severity lattice of finding SETS: 3
 * per-slot states across 4 slots = 81 sets, plus 4 Host_Adapter rejection sets
 * across 3 error-free local sets = 12 - 93 enumerated pushes in all, plus one
 * case that pins the inventory read as load-bearing. `fast-check` is an `engine`
 * dependency and must not be added here, so "property" means the whole product,
 * not sampling.
 *
 * The set is what varies, not the graph. The graph is fixed - one `http-request`
 * node per slot, each with a relative url and its own connection id - and the
 * finding set is driven entirely by the inventory the AWS connections route
 * answers with, because that is the one input to `validateAgainstCapabilities`
 * this property can address from outside the service. A spy on the validator was
 * the other option and is not available: `CloudService` imports it as a named
 * binding that the bundler resolves to a direct call, so there is no namespace
 * object left to patch at run time.
 *
 * Each case asserts four things:
 *
 * - The inventory read happens, at `GET /workflows/{id}/connections`, through the
 *   AWS transport (Requirement 12.1). Asserted as the full request sequence, so a
 *   read that fell through to `fetch` or addressed another route fails here.
 * - The deployment request is issued exactly when the set carries no
 *   error-severity finding (Requirements 12.2, 12.3), including a set whose only
 *   error sits among several warnings, and `pushWorkflow` resolves accordingly.
 * - Every finding is written to the Problems console in BOTH branches, in order,
 *   at the level its severity maps to, and the console is brought to the front
 *   exactly when there is something in it.
 * - A rejection carrying the host's own findings writes those too and gives them
 *   the last word (Requirement 16.8).
 *
 * The enumerated lattice point is stated twice, on purpose: once through the
 * validator (which supplies the message text this spec deliberately does not
 * copy) and once independently, as one finding per non-clean slot at that slot's
 * severity attributed to that slot's node. The second reading is what stops a
 * case from silently drifting off the lattice point it claims to be.
 *
 * Distinct from Property 32 in `deploy/capability-gate.spec.ts`, which is not
 * touched: that one is about Studio-vs-validator equivalence and the `deployOnly`
 * tagging that keeps a deploy finding from blocking a local run. This one is
 * about the severity lattice deciding the push and every finding reaching the
 * console.
 *
 * **Validates: Requirements 12.1, 12.2, 12.3**
 */
describe('Property 29: Capability findings gate the push', () => {
  let harness: CloudHarness;
  let cloud: CloudService;
  let workflow: WorkflowService;
  let terminal: TerminalOutputService;
  /** The spec `pushWorkflow` exports, so the validator can be asked about it. */
  let gateSpec: WorkflowSpec;
  /** One node id per slot, in slot order. */
  let slotNodeIds: string[];
  let toastErrorSpy: jasmine.Spy;
  let toastSuccessSpy: jasmine.Spy;

  beforeEach(() => {
    harness = configureCloudHarness();
    cloud = harness.cloud;
    workflow = harness.workflow;
    terminal = TestBed.inject(TerminalOutputService);
    // Requirement 12.1: the gate under test is the one the `aws` target selects,
    // which is also what puts the inventory read on the signed transport.
    harness.settings.cloudProvider.set('aws');

    // The harness pins `exportActiveSpec` on a single manual-trigger graph.
    // Re-target that SAME spy: a second harness would be a second TestBed.
    const base = workflow.exportActiveSpec();
    expect(base).withContext('the harness must pin an exportable spec').toBeTruthy();
    slotNodeIds = buildGateGraph(workflow);
    gateSpec = { ...base!, id: ACTIVE_WORKFLOW_ID, graph: structuredClone(workflow.graph()) };
    (workflow.exportActiveSpec as jasmine.Spy).and.callFake(() => structuredClone(gateSpec));

    toastErrorSpy = spyOn(TestBed.inject(ToastService), 'error').and.callThrough();
    toastSuccessSpy = spyOn(TestBed.inject(ToastService), 'success').and.callThrough();
  });

  // Same leak as Properties 21, 22, 23 and 28: the discovered endpoint, the
  // worker URL, the token and the chosen provider all persist to localStorage,
  // and karma runs ONE browser for the whole suite.
  afterEach(() => harness.reset());

  /** What one push did, as the three things this property asks about. */
  interface GatePushResult {
    /** `pushWorkflow`'s own answer - callers act on it, so it is part of the claim. */
    readonly pushed: boolean;
    /** Every request either transport carried, in dispatch order. */
    readonly requests: string[];
    /** The Problems console, as `level | message` lines. */
    readonly problems: string[];
  }

  /** Runs one push against `answer`. */
  async function pushWith(answer: GateHostAnswer): Promise<GatePushResult> {
    stubGateHost(harness, answer);
    harness.log.length = 0;
    const pushed = await cloud.pushWorkflow();
    return {
      pushed,
      requests: harness.log.map(describeRequest),
      problems: problemsConsole(terminal),
    };
  }

  /**
   * The finding set one assignment must produce, read from the same pure
   * validator the service calls and then checked against the enumerated lattice
   * point independently of anything the validator says.
   */
  function expectedFindings(assignment: GateAssignment): CapabilityFinding[] {
    const findings = validateAgainstCapabilities(
      gateSpec,
      AWS_CAPABILITIES,
      gateInventory(assignment),
    );
    const nonClean = assignment
      .map((kind, slot) => ({ kind, slot }))
      .filter(each => each.kind !== 'clean');
    const label = assignmentLabel(assignment);
    expect(findings.length)
      .withContext(`${label}: one finding per non-clean slot and no others`)
      .toBe(nonClean.length);
    nonClean.forEach((slot, index) => {
      const finding = findings[index];
      expect(finding?.severity)
        .withContext(`${label}: slot ${slot.slot + 1} severity`)
        .toBe(slot.kind === 'error' ? 'error' : 'warning');
      expect(finding?.nodeId)
        .withContext(`${label}: slot ${slot.slot + 1} attribution`)
        .toBe(slotNodeIds[slot.slot]);
    });
    return findings;
  }

  for (const assignment of GATE_ASSIGNMENTS) {
    const errors = countSlots(assignment, 'error');
    const warnings = countSlots(assignment, 'warning');
    const outcome = errors === 0 ? 'proceeds to the deployment request' : 'blocks the push';

    it(`${assignmentLabel(assignment)} (${errors} error, ${warnings} warning): ${outcome}, and every finding reaches the Problems console`, async () => {
      const expected = expectedFindings(assignment);
      const context = `${assignmentLabel(assignment)}: ${errors} error, ${warnings} warning`;

      const result = await pushWith({ connections: gateInventory(assignment), rejection: null });

      // Requirements 12.1, 12.2 and 12.3 as one comparison: the inventory read
      // always happens, at the AWS connections route and through the signed
      // transport, and the deployment request happens exactly when the set
      // carries no error-severity finding.
      expect(result.requests)
        .withContext(`${context}: the requests a push made`)
        .toEqual(
          errors === 0
            ? [GATE_INVENTORY_REQUEST, GATE_DEPLOY_REQUEST]
            : [GATE_INVENTORY_REQUEST],
        );
      expect(result.pushed).withContext(`${context}: pushWorkflow's answer`).toBe(errors === 0);

      // Requirement 12.2's other half, in BOTH branches: every finding, in order,
      // at the level its severity maps to, and nothing else.
      expect(result.problems).withContext(`${context}: Problems console`).toEqual(
        expected.map(expectedConsoleLine),
      );
      // A console nobody surfaced does not display anything, so the channel is
      // brought forward exactly when there is a finding to read.
      expect(terminal.activeChannel())
        .withContext(`${context}: the surfaced console channel`)
        .toBe(expected.length > 0 ? 'problems' : 'run');

      if (errors === 0) {
        expect(toastErrorSpy).withContext(`${context}: nothing failed`).not.toHaveBeenCalled();
        expect(toastSuccessSpy.calls.mostRecent()?.args[0])
          .withContext(`${context}: the operator is told it went out`)
          .toBe('Workflow pushed');
      } else {
        expect(toastSuccessSpy)
          .withContext(`${context}: nothing was pushed`)
          .not.toHaveBeenCalled();
        const [title, detail] = toastErrorSpy.calls.mostRecent().args as [string, string];
        expect(title).withContext(`${context}: the abort is reported`).toBe('Push aborted');
        // The count is the errors alone: a warning is not a problem that would
        // prevent the workflow from running.
        expect(detail).withContext(`${context}: names the blocking count`).toContain(
          `${errors} problem`,
        );
        expect(detail)
          .withContext(`${context}: names the host it would not run on`)
          .toContain(AWS_CAPABILITIES.label);
      }
    });
  }

  for (const localSet of GATE_HOST_LOCAL_SETS) {
    for (const rejection of GATE_HOST_REJECTIONS) {
      const label = `${assignmentLabel(localSet)} then ${rejection.label}`;

      it(`${label}: the host's own findings reach the Problems console and have the last word`, async () => {
        const local = expectedFindings(localSet);
        expect(local.every(finding => finding.severity === 'warning'))
          .withContext(`${label}: a local set that reaches the host carries no error`)
          .toBeTrue();

        const result = await pushWith({
          connections: gateInventory(localSet),
          rejection: {
            error: GATE_HOST_ERROR,
            ...(rejection.findings ? { findings: rejection.findings } : {}),
          },
        });

        const context = `${label} (${rejection.why})`;
        // The gate let it through and the HOST is what rejected it, so both
        // requests went out and the push still resolved false.
        expect(result.requests)
          .withContext(`${context}: the push reached the host`)
          .toEqual([GATE_INVENTORY_REQUEST, GATE_DEPLOY_REQUEST]);
        expect(result.pushed).withContext(`${context}: a rejected push`).toBeFalse();
        const [title, detail] = toastErrorSpy.calls.mostRecent().args as [string, string];
        expect(title).withContext(`${context}: the failure is reported`).toBe('Push failed');
        expect(detail).withContext(`${context}: the host's own message`).toBe(GATE_HOST_ERROR);

        // Requirement 16.8: the host's findings are authoritative, so they reach
        // the console in full, at their own severities, and everything after the
        // local set came from the host - it has the final word on a spec it
        // refused, even when the Studio's own validation was clean.
        const hostLines = (rejection.findings ?? []).map(expectedConsoleLine);
        expect(result.problems)
          .withContext(`${context}: Problems console`)
          .toEqual([...local.map(expectedConsoleLine), ...hostLines]);
        expect(result.problems.slice(result.problems.length - hostLines.length))
          .withContext(`${context}: the host's findings are the last thing written`)
          .toEqual(hostLines);
      });
    }
  }

  it('validates against the inventory the AWS connections route returned', async () => {
    // The same graph, answered with an EMPTY inventory: every slot's connection
    // is suddenly absent, so every slot produces both an unknown-connection error
    // and an undeterminable-egress warning. This is what a gate that skipped the
    // read - or read the local library, which the harness stubs empty - would see
    // for every case above, so it pins the read as load-bearing rather than
    // decorative.
    const expected = validateAgainstCapabilities(gateSpec, AWS_CAPABILITIES, []);
    expect(expected.filter(finding => finding.severity === 'error').length).toBe(GATE_SLOT_COUNT);
    expect(expected.filter(finding => finding.severity === 'warning').length).toBe(GATE_SLOT_COUNT);

    const result = await pushWith({ connections: [], rejection: null });

    expect(result.requests).toEqual([GATE_INVENTORY_REQUEST]);
    expect(result.pushed).toBeFalse();
    expect(result.problems).toEqual(expected.map(expectedConsoleLine));
    for (let index = 0; index < GATE_SLOT_COUNT; index += 1) {
      expect(result.problems.some(line => line.includes(gateConnectionId(index))))
        .withContext(`slot ${index + 1}'s connection is named in the console`)
        .toBeTrue();
    }
  });

  it('enumerates the whole severity lattice over finding sets', () => {
    // Guards the ways this enumeration could quietly stop being exhaustive.
    expect(GATE_SLOT_KINDS.length).toBe(3);
    expect(GATE_SLOT_COUNT).toBe(4);
    expect(GATE_ASSIGNMENTS.length).toBe(81);
    expect(new Set(GATE_ASSIGNMENTS.map(assignmentLabel)).size).toBe(81);
    expect(GATE_ASSIGNMENTS.every(each => each.length === GATE_SLOT_COUNT)).toBeTrue();

    // Every lattice point the claims turn on is in the enumeration, named.
    const has = (errors: number, warnings: number) =>
      GATE_ASSIGNMENTS.some(
        each => countSlots(each, 'error') === errors && countSlots(each, 'warning') === warnings,
      );
    expect(has(0, 0)).withContext('the empty set').toBeTrue();
    expect(has(0, 1)).withContext('one warning').toBeTrue();
    expect(has(0, GATE_SLOT_COUNT)).withContext('warnings only, n of them').toBeTrue();
    expect(has(1, 0)).withContext('one error').toBeTrue();
    expect(has(GATE_SLOT_COUNT, 0)).withContext('errors only, n of them').toBeTrue();
    expect(has(1, GATE_SLOT_COUNT - 1))
      .withContext('one error hidden among the warnings - the case 12.2 exists for')
      .toBeTrue();

    // Both halves of the gate are populated, so neither branch is asserted alone.
    const proceeding = GATE_ASSIGNMENTS.filter(each => countSlots(each, 'error') === 0);
    expect(proceeding.length).toBe(16);
    expect(GATE_ASSIGNMENTS.length - proceeding.length).toBe(65);
    // And the proceeding half is not all empty sets: a push that goes out while
    // the console carries warnings is requirement 12.3.
    expect(proceeding.filter(each => countSlots(each, 'warning') > 0).length).toBe(15);

    // The host-rejection half, over the same lattice.
    expect(GATE_HOST_REJECTIONS.length).toBe(4);
    expect(GATE_HOST_LOCAL_SETS.length).toBe(3);
    expect(GATE_HOST_LOCAL_SETS.every(each => countSlots(each, 'error') === 0)).toBeTrue();
    expect(GATE_HOST_REJECTIONS.some(each => each.findings === null)).toBeTrue();
    expect(
      GATE_HOST_REJECTIONS.some(each =>
        (each.findings ?? []).some(finding => finding.severity === 'error'),
      ),
    ).toBeTrue();
    expect(
      GATE_HOST_REJECTIONS.some(each =>
        (each.findings ?? []).some(finding => finding.severity === 'warning'),
      ),
    ).toBeTrue();
    const hostCases = GATE_HOST_REJECTIONS.length * GATE_HOST_LOCAL_SETS.length;
    expect(GATE_ASSIGNMENTS.length + hostCases).toBe(93);

    // The two spellings of the inventory read agree, so the literal URL this
    // property asserts cannot drift from the route the registry composes.
    const aws = DEPLOY_TARGETS['aws'];
    const inventory = aws.endpoints['read-connections'];
    const specPush = aws.endpoints['push-spec'];
    expect(inventory?.method).toBe('GET');
    expect(inventory?.scope).toBe('instance');
    const instance = aws.instanceUrl(TRIGGER_BASE, ACTIVE_WORKFLOW_ID);
    expect(`${instance}${inventory!.path({ workflowId: ACTIVE_WORKFLOW_ID })}`).toBe(
      GATE_INVENTORY_URL,
    );
    expect(specPush?.method).toBe('POST');
    expect(`${instance}${specPush!.path({ workflowId: ACTIVE_WORKFLOW_ID })}`).toBe(GATE_SPEC_URL);
    // The transport half of the claim, from the same table Property 21 reads.
    expect(expectedTransportId('aws')).toBe('aws-cli');
    // The gate validates against the AWS record, not the Cloudflare default.
    expect(aws.capabilities).toBe(AWS_CAPABILITIES);
  });
});
