import { TestBed } from '@angular/core/testing';
import { ReplaySubject } from 'rxjs';
import { ClerkService } from 'ngx-clerk';

import { CloudService } from './cloud.service';
import { ConnectionStoreService } from './connection-store.service';
import { TauriService } from './tauri.service';
import { TerminalOutputService } from './terminal-output.service';
import { ToastService } from '../shared/toast/toast.service';
import { WorkflowService } from './workflow.service';
import { SettingsService } from './settings.service';
import type { HttpRequestNodeData, SqlQueryNodeData } from './workflow.model';

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
    // 17.13) — it must never block the push (Requirement 17.15).
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
