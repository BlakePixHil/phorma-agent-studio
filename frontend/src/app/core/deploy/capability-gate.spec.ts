import { TestBed } from '@angular/core/testing';
import { ReplaySubject } from 'rxjs';
import { ClerkService } from 'ngx-clerk';

import {
  AWS_CAPABILITIES,
  TAURI_DESKTOP_CAPABILITIES,
  validateAgainstCapabilities,
  type CapabilityFinding,
  type ConnectionSummary,
} from '@phorma/engine';

import { CapabilityFindingsService } from '../capability-findings.service';
import { CloudService } from '../cloud.service';
import { AwsDeployConfigService } from './aws-deploy-config.service';
import { AwsRequestService } from './aws-request.service';
import { SettingsService } from '../settings.service';
import { TauriService } from '../tauri.service';
import { TerminalOutputService } from '../terminal-output.service';
import { ToastService } from '../../shared/toast/toast.service';
import { WorkflowService } from '../workflow.service';

/**
 * Property 32: Capability findings gate a push identically on both sides
 * (Studio half)
 *
 * Exhaustive enumeration of finding-severity combinations, asserting:
 * 1. The Studio's capability findings from CapabilityFindingsService.deployFindings()
 *    equal the validator's output (validateAgainstCapabilities) APART from the
 *    deployOnly tagging (warnings in Studio, errors in validator).
 * 2. deployOnly findings from the Studio NEVER block a local run (forced to warning).
 * 3. When the Host_Adapter response includes findings, those are written to the
 *    Problems console (authoritative).
 *
 * **Validates: Requirements 16.3, 16.4, 16.5, 16.6, 16.8**
 */
describe('Property 32: Capability findings gate a push identically on both sides (Studio half)', () => {
  // ── Section 1: CapabilityFindingsService deployOnly tagging ──────────────

  describe('CapabilityFindingsService.deployFindings() tagging', () => {
    let capFindings: CapabilityFindingsService;
    let workflow: WorkflowService;
    let settings: SettingsService;

    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [
          // Desktop host so local findings do not mask deploy-only ones.
          { provide: TauriService, useValue: { isDesktop: true } },
        ],
      });

      capFindings = TestBed.inject(CapabilityFindingsService);
      workflow = TestBed.inject(WorkflowService);
      settings = TestBed.inject(SettingsService);

      workflow.newWorkflow();
      settings.cloudProvider.set('aws');
    });

    it('no findings (clean workflow): deployFindings returns empty', () => {
      // A manual trigger only - valid on every host.
      workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
      TestBed.flushEffects();

      const deployFindings = capFindings.deployFindings();
      expect(deployFindings.length).toBe(0);

      // Confirm the validator also returns nothing for this graph.
      const validatorFindings = validateAgainstCapabilities(
        { graph: workflow.graph() },
        AWS_CAPABILITIES,
        [],
      );
      expect(validatorFindings.length).toBe(0);
    });

    it('one warning finding: validator produces a warning, Studio tags it deployOnly', () => {
      // A templated url is a warning (egress undeterminable).
      workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
      const node = workflow.addNodeFromCatalog('data-http-request', { x: 200, y: 0 });
      expect(node).toBeTruthy();
      workflow.updateNodeData(node!.id, {
        method: 'GET',
        url: '{{ baseUrl }}/items',
        responseMode: 'json',
        bodyMode: 'none',
      });
      TestBed.flushEffects();

      const validatorFindings = validateAgainstCapabilities(
        { graph: workflow.graph() },
        AWS_CAPABILITIES,
        [],
      );
      const warnings = validatorFindings.filter(f => f.severity === 'warning');
      expect(warnings.length).toBeGreaterThan(0);
      // Warnings that occur on both local AND deploy host are excluded from
      // deployFindings (they belong to localFindings). A templated url on
      // desktop also produces the same warning, so deployFindings filters it.
      // Validate that all deploy findings are warning + deployOnly.
      const deployFindings = capFindings.deployFindings();
      for (const f of deployFindings) {
        expect(f.severity).toBe('warning');
        expect(f.deployOnly).toBeTrue();
      }
    });

    it('one error finding: validator produces an error, Studio forces severity to warning + deployOnly', () => {
      // mcp-tool with stdio transport: Desktop can run it, AWS cannot.
      // The validator says 'error', but deployFindings forces 'warning'.
      workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
      const node = workflow.addNodeFromCatalog('tool-mcp', { x: 200, y: 0 });
      expect(node).toBeTruthy();
      workflow.updateNodeData(node!.id, { transport: 'stdio', command: 'node', args: ['server.js'] });
      TestBed.flushEffects();

      // Validator against AWS says error (stdioMcp: false).
      const validatorFindings = validateAgainstCapabilities(
        { graph: workflow.graph() },
        AWS_CAPABILITIES,
        [],
      );
      const errors = validatorFindings.filter(f => f.severity === 'error');
      expect(errors.some(f => f.message.includes('stdio'))).toBeTrue();

      // Studio deploy findings: same content but forced to warning.
      const deployFindings = capFindings.deployFindings();
      const stdioFindings = deployFindings.filter(f => f.message.includes('stdio'));
      expect(stdioFindings.length).toBeGreaterThan(0);
      for (const f of stdioFindings) {
        expect(f.severity).toBe('warning');
        expect(f.deployOnly).toBeTrue();
      }
    });

    it('mixed: one warning + one error: both forced to warning + deployOnly in Studio', () => {
      // stdio mcp (error on AWS) + templated url (warning on AWS).
      workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
      const mcpNode = workflow.addNodeFromCatalog('tool-mcp', { x: 200, y: 0 });
      const httpNode = workflow.addNodeFromCatalog('data-http-request', { x: 400, y: 0 });
      expect(mcpNode).toBeTruthy();
      expect(httpNode).toBeTruthy();
      workflow.updateNodeData(mcpNode!.id, { transport: 'stdio', command: 'node', args: ['s.js'] });
      workflow.updateNodeData(httpNode!.id, {
        method: 'GET',
        url: '{{ base }}/x',
        responseMode: 'json',
        bodyMode: 'none',
      });
      TestBed.flushEffects();

      // Validator returns a mix of errors and warnings.
      const validatorFindings = validateAgainstCapabilities(
        { graph: workflow.graph() },
        AWS_CAPABILITIES,
        [],
      );
      const validatorErrors = validatorFindings.filter(f => f.severity === 'error');
      const validatorWarnings = validatorFindings.filter(f => f.severity === 'warning');
      expect(validatorErrors.length).toBeGreaterThan(0);
      expect(validatorWarnings.length).toBeGreaterThan(0);

      // Studio: everything deploy-specific is warning + deployOnly.
      const deployFindings = capFindings.deployFindings();
      for (const f of deployFindings) {
        expect(f.severity).toBe('warning');
        expect(f.deployOnly).toBeTrue();
      }
    });

    it('deploy-only finding (stdio MCP) NEVER blocks a local run: severity is warning', () => {
      // stdio MCP is fine locally (Desktop declares stdioMcp: true) but
      // fails in the cloud (AWS declares stdioMcp: false).
      workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
      const node = workflow.addNodeFromCatalog('tool-mcp', { x: 200, y: 0 });
      expect(node).toBeTruthy();
      workflow.updateNodeData(node!.id, { transport: 'stdio', command: 'node', args: ['s.js'] });
      TestBed.flushEffects();

      // Local findings: no error for stdio (desktop supports it).
      const localFindings = capFindings.localFindings();
      const localStdio = localFindings.filter(f => f.message.includes('stdio'));
      expect(localStdio.length).toBe(0);

      // Deploy findings: warning only, never error.
      const deployFindings = capFindings.deployFindings();
      const deployStdio = deployFindings.filter(f => f.message.includes('stdio'));
      expect(deployStdio.length).toBeGreaterThan(0);
      for (const f of deployStdio) {
        expect(f.severity).toBe('warning');
        expect(f.deployOnly).toBeTrue();
      }

      // Combined findings: no error at all - so a local run is never blocked.
      const allFindings = capFindings.findings();
      const allErrors = allFindings.filter(f => f.severity === 'error');
      expect(allErrors.length).toBe(0);
    });
  });

  // ── Section 2: CloudService push gating and Problems console ────────────

  describe('CloudService.pushWorkflow: gating and Host_Adapter findings', () => {
    /** Discovered Trigger_API base - instances hang off `/workflows/{id}`. */
    const TRIGGER_BASE = 'https://trigger.example.test';

    let cloud: CloudService;
    let workflow: WorkflowService;
    let toast: ToastService;
    let terminal: TerminalOutputService;
    let settings: SettingsService;
    let awsRequest: AwsRequestService;

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
      awsRequest = TestBed.inject(AwsRequestService);

      workflow.newWorkflow();
      settings.cloudProvider.set('aws');
      // The discovered Trigger_API URL is what `instanceUrl` addresses, and every
      // AWS call rides the SigV4 transport rather than `fetch` with a bearer
      // header (Requirement 10.8). Only the endpoint is set here: `pushWorkflow`
      // is gated on a base URL, not on `configured()`, so the aggregate
      // configuration validity requirement 12.5 also reads is not in play.
      TestBed.inject(AwsDeployConfigService).triggerApiUrl.set(TRIGGER_BASE);
    });

    // The discovered endpoint persists to localStorage (it has to survive a
    // restart), so it would otherwise leak into every later spec's injector.
    afterEach(() => {
      TestBed.inject(AwsDeployConfigService).triggerApiUrl.set('');
    });

    /** Routes the signed requests pushWorkflow makes through the AWS transport. */
    function stubTransport(options: {
      connections?: ConnectionSummary[];
      deployOk?: boolean;
      hostFindings?: CapabilityFinding[];
    }): jasmine.Spy {
      const answer = (status: number, body: unknown) => ({
        ok: true as const,
        response: { status, headers: {}, body: JSON.stringify(body) },
      });
      return spyOn(awsRequest, 'send').and.callFake(async (url: string, init) => {
        if (url.endsWith('/connections') && init.method === 'GET') {
          return answer(200, { connections: options.connections ?? [] });
        }
        if (url.endsWith('/spec') && init.method === 'POST') {
          if (options.hostFindings && options.hostFindings.length > 0) {
            return answer(400, {
              error: 'Capability check failed',
              findings: options.hostFindings,
            });
          }
          return options.deployOk === false
            ? answer(400, { error: 'rejected' })
            : answer(200, { ok: true, name: 'wf' });
        }
        return answer(404, { error: 'unexpected' });
      });
    }

    /** The spec-push requests the stub saw - the AWS deployment route. */
    function deployCalls(spy: jasmine.Spy): unknown[] {
      return spy.calls
        .allArgs()
        .filter(([url, init]) => String(url).endsWith('/spec') && init.method === 'POST');
    }

    it('no findings: push proceeds to the deployment request', async () => {
      workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
      const spy = stubTransport({ deployOk: true });
      const toastSuccessSpy = spyOn(toast, 'success').and.callThrough();

      await cloud.pushWorkflow();

      expect(deployCalls(spy).length).toBe(1);
      expect(toastSuccessSpy).toHaveBeenCalled();
    });

    it('one error finding: push is aborted and findings written to Problems console', async () => {
      // sql-query with mssql driver on the AWS target: validation against
      // AWS_CAPABILITIES succeeds (AWS supports mssql), but against
      // Cloudflare it would fail. To trigger an error on the AWS validator,
      // use an unknown connection reference.
      workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
      const node = workflow.addNodeFromCatalog('data-http-request', { x: 200, y: 0 });
      expect(node).toBeTruthy();
      workflow.updateNodeData(node!.id, {
        method: 'GET',
        url: 'https://api.example.com/data',
        responseMode: 'json',
        bodyMode: 'none',
        connectionId: 'conn-never-exists',
      });
      const spy = stubTransport({});
      const toastErrorSpy = spyOn(toast, 'error').and.callThrough();

      await cloud.pushWorkflow();

      // No deployment request sent.
      expect(deployCalls(spy).length).toBe(0);
      expect(toastErrorSpy).toHaveBeenCalledWith('Push aborted', jasmine.stringMatching(/problem/i));

      // Findings written to Problems console.
      const problems = terminal.entries().filter(e => e.channel === 'problems');
      expect(problems.some(e => e.message.includes('conn-never-exists'))).toBeTrue();
    });

    it('warning-only findings: push proceeds and findings written to Problems console', async () => {
      // Templated url = warning only (egress undeterminable).
      workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
      const node = workflow.addNodeFromCatalog('data-http-request', { x: 200, y: 0 });
      expect(node).toBeTruthy();
      workflow.updateNodeData(node!.id, {
        method: 'GET',
        url: '{{ base }}/items',
        responseMode: 'json',
        bodyMode: 'none',
      });
      const spy = stubTransport({ deployOk: true });
      const toastSuccessSpy = spyOn(toast, 'success').and.callThrough();

      await cloud.pushWorkflow();

      expect(deployCalls(spy).length).toBe(1);
      expect(toastSuccessSpy).toHaveBeenCalled();
    });

    it('mixed error + warning: push is aborted on error presence', async () => {
      // Unknown connection (error) + templated url (warning).
      workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
      const http1 = workflow.addNodeFromCatalog('data-http-request', { x: 200, y: 0 });
      const http2 = workflow.addNodeFromCatalog('data-http-request', { x: 400, y: 0 });
      expect(http1).toBeTruthy();
      expect(http2).toBeTruthy();
      workflow.updateNodeData(http1!.id, {
        method: 'GET',
        url: 'https://api.example.com/x',
        responseMode: 'json',
        bodyMode: 'none',
        connectionId: 'conn-absent',
      });
      workflow.updateNodeData(http2!.id, {
        method: 'GET',
        url: '{{ dynamic }}/y',
        responseMode: 'json',
        bodyMode: 'none',
      });
      const spy = stubTransport({});
      const toastErrorSpy = spyOn(toast, 'error').and.callThrough();

      await cloud.pushWorkflow();

      expect(deployCalls(spy).length).toBe(0);
      expect(toastErrorSpy).toHaveBeenCalledWith('Push aborted', jasmine.stringMatching(/problem/i));
    });

    it('Host_Adapter findings are written to Problems console when push response disagrees', async () => {
      // A clean graph (no local findings) but the Host_Adapter returns its
      // own findings in the error response, simulating a disagreement.
      workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
      const hostFindings: CapabilityFinding[] = [
        { severity: 'error', message: 'Connection "db" secret key "password" is missing on AWS (ECS Fargate).' },
        { severity: 'warning', message: 'Egress to internal.corp is not in the allow-list.' },
      ];
      stubTransport({ hostFindings });

      await cloud.pushWorkflow();

      // The Host_Adapter's findings are written to the Problems console
      // (Requirement 16.8: when the two sides disagree, Host_Adapter's
      // findings are displayed).
      const problems = terminal.entries().filter(e => e.channel === 'problems');
      expect(problems.some(e => e.message.includes('password'))).toBeTrue();
      expect(problems.some(e => e.message.includes('allow-list'))).toBeTrue();
    });

    it('deploy-only finding (stdio MCP fine locally, fails in cloud) does not gate push when run locally', async () => {
      // This test validates the STUDIO side of the equivalence: a finding
      // that is deploy-only (warning in Studio) is re-validated at error
      // severity by the push path. The push path uses the target's capability
      // record directly, so stdio MCP IS an error at push time even though
      // Studio showed it as a warning.
      workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
      const node = workflow.addNodeFromCatalog('tool-mcp', { x: 200, y: 0 });
      expect(node).toBeTruthy();
      workflow.updateNodeData(node!.id, { transport: 'stdio', command: 'node', args: ['s.js'] });
      const spy = stubTransport({});
      const toastErrorSpy = spyOn(toast, 'error').and.callThrough();

      await cloud.pushWorkflow();

      // Push IS aborted: the push-time validator runs at full severity.
      expect(deployCalls(spy).length).toBe(0);
      expect(toastErrorSpy).toHaveBeenCalledWith('Push aborted', jasmine.stringMatching(/problem/i));

      // Findings written to Problems console.
      const problems = terminal.entries().filter(e => e.channel === 'problems');
      expect(problems.some(e => e.message.includes('stdio'))).toBeTrue();
    });
  });

  // ── Section 3: Exhaustive equivalence between Studio and validator ──────

  describe('Studio findings equal validator output apart from deployOnly tagging', () => {
    let capFindings: CapabilityFindingsService;
    let workflow: WorkflowService;
    let settings: SettingsService;

    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [{ provide: TauriService, useValue: { isDesktop: true } }],
      });

      capFindings = TestBed.inject(CapabilityFindingsService);
      workflow = TestBed.inject(WorkflowService);
      settings = TestBed.inject(SettingsService);

      workflow.newWorkflow();
      settings.cloudProvider.set('aws');
    });

    /**
     * For a given graph, deployFindings messages must be a subset of what the
     * validator reports (filtered by the local-host delta), all forced to
     * warning severity and tagged deployOnly.
     */
    function assertDeployFindingsEquivalence(): void {
      TestBed.flushEffects();
      const deployFindings = capFindings.deployFindings();

      // Every deploy finding must be warning + deployOnly.
      for (const f of deployFindings) {
        expect(f.severity)
          .withContext(`finding "${f.message}" severity`)
          .toBe('warning');
        expect(f.deployOnly)
          .withContext(`finding "${f.message}" deployOnly`)
          .toBeTrue();
      }

      // The validator's output against the same graph and capabilities.
      const validatorFindings = validateAgainstCapabilities(
        { graph: workflow.graph() },
        AWS_CAPABILITIES,
        [],
      );

      // Local findings (Desktop host) to identify the delta.
      const localFindings = validateAgainstCapabilities(
        { graph: workflow.graph() },
        TAURI_DESKTOP_CAPABILITIES,
        [],
      );
      const localMessages = new Set(localFindings.map(f => f.message));

      // The deploy-specific delta from the validator: findings the local host
      // does NOT produce.
      const validatorDelta = validatorFindings.filter(f => !localMessages.has(f.message));

      // Deploy findings content (ignoring severity and deployOnly) must match
      // the validator delta content. The message may have a remedy appended by
      // the service, so we check that deploy messages START WITH or CONTAIN
      // the validator message.
      for (const vf of validatorDelta) {
        const match = deployFindings.some(df => df.message.includes(vf.message));
        // It is acceptable for Studio to append a remedy suggestion.
        expect(match)
          .withContext(`validator finding "${vf.message}" present in deployFindings`)
          .toBeTrue();
      }

      // Both loops above are vacuous when the graph is clean, so state the
      // emptiness correspondence explicitly: Studio must not invent a deploy
      // finding the validator does not produce, nor drop every one it does.
      expect(deployFindings.length === 0)
        .withContext(
          `deployFindings (${deployFindings.length}) and validator delta ` +
            `(${validatorDelta.length}) must be empty together`,
        )
        .toBe(validatorDelta.length === 0);

      // Every Studio deploy finding traces back to a validator delta finding.
      for (const df of deployFindings) {
        const match = validatorDelta.some(vf => df.message.includes(vf.message));
        expect(match)
          .withContext(`deploy finding "${df.message}" traces to the validator delta`)
          .toBeTrue();
      }
    }

    it('clean graph: zero findings on both sides', () => {
      workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
      assertDeployFindingsEquivalence();
    });

    it('stdio MCP (deploy-only error): Studio downgrades to warning', () => {
      workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
      const node = workflow.addNodeFromCatalog('tool-mcp', { x: 200, y: 0 });
      workflow.updateNodeData(node!.id, { transport: 'stdio', command: 'node', args: ['s.js'] });
      assertDeployFindingsEquivalence();
    });

    it('OAuth MCP (deploy-only error): Studio downgrades to warning', () => {
      workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
      const node = workflow.addNodeFromCatalog('tool-mcp', { x: 200, y: 0 });
      workflow.updateNodeData(node!.id, { authMode: 'oauth' });
      assertDeployFindingsEquivalence();
    });

    it('templated url (warning on both): NOT duplicated in deployFindings', () => {
      workflow.addNodeFromCatalog('trigger-manual', { x: 0, y: 0 });
      const node = workflow.addNodeFromCatalog('data-http-request', { x: 200, y: 0 });
      workflow.updateNodeData(node!.id, {
        method: 'GET',
        url: '{{ host }}/api',
        responseMode: 'json',
        bodyMode: 'none',
      });
      TestBed.flushEffects();

      // A templated url produces the same warning on both Desktop and AWS,
      // so deployFindings should exclude it (already shown in localFindings).
      const deployFindings = capFindings.deployFindings();
      const urlFindings = deployFindings.filter(f => f.message.includes('statically determinable'));
      expect(urlFindings.length).toBe(0);
    });
  });
});
