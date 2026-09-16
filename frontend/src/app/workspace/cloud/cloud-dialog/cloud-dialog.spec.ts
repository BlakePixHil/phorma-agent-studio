// Behavioural examples for the deploy dialog's readiness gate.
//
// Two things this file exists to hold, both of which regressed in the surface
// it replaced:
//
// 1. THE DEPLOY BUTTON IS DISABLED FOR A REASON THE USER CAN READ. Every branch
//    of `deployBlockedReason` is also enforced inside `CloudService.pushWorkflow`,
//    so a gap here means the user learns from a toast after pressing.
// 2. A PUSH CANNOT BE STARTED TWICE. `pushWorkflow` does four sequential network
//    round trips with no busy state before this change, so a double click fired
//    two concurrent pushes.
//
// `CloudService` is stubbed rather than driven: the real one reaches Clerk, the
// connection store and the network on construction paths this file has no
// opinion about. What is real is the component, its computeds and the template.

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { signal } from '@angular/core';

import { CloudDialog } from './cloud-dialog';
import { CloudDialogService } from '../cloud-dialog.service';
import { CloudService } from '../../../core/cloud.service';
import { ConnectionStoreService } from '../../../core/connection-store.service';
import { PhormaCloudService } from '../../../core/phorma-cloud.service';
import { SettingsService } from '../../../core/settings.service';
import { WorkflowService } from '../../../core/workflow.service';
import { WorkflowVersionsService } from '../../../core/workflow-versions.service';
import type { WorkflowSpec } from '../../../core/workflow.model';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SPEC: WorkflowSpec = {
  version: 1,
  id: 'wf-1',
  name: 'Nightly report',
  graph: {
    nodes: [
      {
        id: 'a1',
        name: 'Writer',
        kind: 'agent',
        category: 'agent',
        icon: 'ti ti-robot',
        position: { x: 0, y: 0 },
        ports: [{ id: 'a1-in', name: 'In', role: 'message-in' }],
        data: { prompt: 'Write it', provider: 'openai', model: 'gpt-4o-mini' },
      },
    ],
    connections: [],
  },
  savedAt: '2026-09-16T00:00:00Z',
};

/** The parts of `CloudService` this surface touches. */
function cloudStub() {
  return {
    pushing: signal(false),
    pushPhase: signal<string | null>(null),
    lastPushFindings: signal<unknown[]>([]),
    deployedStatus: signal<{ hasWorkflow: boolean; savedAt: string | null } | null>(null),
    deployedStatusWorkflowId: signal<string | null>(null),
    statusLoading: signal(false),
    connection: signal('disconnected'),
    connected: signal(false),
    configured: signal(true),
    effectiveWorkerUrl: signal('https://worker.example.test'),
    deployedStatusFor: () => null,
    refreshStatus: () => Promise.resolve(),
    pushWorkflow: () => Promise.resolve(true),
    connect: () => Promise.resolve(),
    disconnect: () => undefined,
    removeWorkflow: () => Promise.resolve(true),
  };
}

function workflowStub() {
  return {
    activeDoc: signal<{ workflowId: string | null; readOnly?: boolean } | null>({
      workflowId: 'wf-1',
    }),
    activeName: signal('Nightly report'),
    graph: signal(SPEC.graph),
    isDirty: signal(false),
    exportActiveSpec: () => SPEC,
    saveActive: () => Promise.resolve(SPEC),
  };
}

function phormaStub() {
  return {
    signedIn: signal(true),
    subscribed: signal(true),
    pastDue: signal(false),
    profile: signal({ status: 'active', provisioned: true }),
    refresh: () => Promise.resolve(),
  };
}

type CloudStub = ReturnType<typeof cloudStub>;
type WorkflowStub = ReturnType<typeof workflowStub>;
type PhormaStub = ReturnType<typeof phormaStub>;

let cloud: CloudStub;
let workflow: WorkflowStub;
let phorma: PhormaStub;

function mount(): ComponentFixture<CloudDialog> {
  TestBed.inject(CloudDialogService).open();
  const fixture = TestBed.createComponent(CloudDialog);
  fixture.detectChanges();
  return fixture;
}

/** The dialog's primary action, found by its accessible name. */
function deployButton(fixture: ComponentFixture<CloudDialog>): HTMLButtonElement {
  const host = fixture.nativeElement as HTMLElement;
  const match = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button =>
    /Publish workflow|Deploy workflow|Validating|Uploading|Syncing connections/.test(
      button.textContent ?? '',
    ),
  );
  if (!match) {
    const names = [...host.querySelectorAll('button')].map(b => b.textContent?.trim());
    throw new Error(`No deploy button. Buttons: ${names.join(' | ') || '(none)'}`);
  }
  return match;
}

/** Every `__note--warn` line currently rendered, whitespace collapsed. */
function warnings(fixture: ComponentFixture<CloudDialog>): string[] {
  return [
    ...(fixture.nativeElement as HTMLElement).querySelectorAll('.phorma-cloud__note--warn'),
  ].map(element => (element.textContent ?? '').replace(/\s+/g, ' ').trim());
}

/**
 * FILE-SCOPE HOOKS WOULD POISON THE WHOLE SUITE, so everything lives inside this
 * describe. `@angular/core/testing` resets the TestBed from a GLOBAL `afterEach`
 * (the `destroyAfterEach` default makes its `beforeEach` hook a no-op), and a
 * hook declared at file scope registers on that same global suite AFTER
 * Angular's. A `TestBed.inject` in one therefore re-instantiates the TestBed
 * after the reset has already run, and every later spec in the browser dies on
 * `Cannot configure the test module when the test module has already been
 * instantiated`. Inside a describe the hooks are inner-scoped, so they always
 * run before the global reset.
 */
describe('CloudDialog', () => {
  beforeEach(() => {
    cloud = cloudStub();
    workflow = workflowStub();
    phorma = phormaStub();
    TestBed.configureTestingModule({
      providers: [
        provideNoopAnimations(),
        { provide: CloudService, useValue: cloud },
        { provide: WorkflowService, useValue: workflow },
        { provide: ConnectionStoreService, useValue: { list: () => Promise.resolve([]) } },
        {
          provide: WorkflowVersionsService,
          useValue: { versions: signal([]), load: () => Promise.resolve([]) },
        },
        { provide: PhormaCloudService, useValue: phorma },
      ],
    });
    TestBed.inject(SettingsService).cloudProvider.set('cloudflare');
  });

  afterEach(() => {
    TestBed.inject(SettingsService).cloudProvider.set(null);
    TestBed.inject(CloudDialogService).close();
    localStorage.clear();
  });

  describe('deploy readiness', () => {
    it('enables the deploy button when nothing is blocking', () => {
      const fixture = mount();
      expect(deployButton(fixture).disabled).toBeFalse();
      expect(warnings(fixture)).toEqual([]);
    });

    it('blocks a read-only version preview and says so', () => {
      workflow.activeDoc.set({ workflowId: 'wf-1', readOnly: true });
      const fixture = mount();

      expect(deployButton(fixture).disabled).toBeTrue();
      expect(warnings(fixture).join(' ')).toContain('read-only');
    });

    it('blocks an unsaved draft and offers to save it', () => {
      workflow.activeDoc.set({ workflowId: null });
      const fixture = mount();

      expect(deployButton(fixture).disabled).toBeTrue();
      expect(warnings(fixture).join(' ')).toContain('Save this workflow');
    });

    it('blocks when the chosen target is not configured', () => {
      cloud.configured.set(false);
      const fixture = mount();

      expect(deployButton(fixture).disabled).toBeTrue();
      expect(warnings(fixture).join(' ')).toContain('not configured');
    });

    it('blocks a signed-out Phorma Cloud account', () => {
      TestBed.inject(SettingsService).cloudProvider.set('phorma');
      phorma.signedIn.set(false);
      const fixture = mount();

      expect(deployButton(fixture).disabled).toBeTrue();
      expect(warnings(fixture).join(' ')).toContain('Sign in');
    });

    it('blocks while a push is already in flight', () => {
      cloud.pushing.set(true);
      const fixture = mount();

      expect(deployButton(fixture).disabled).toBeTrue();
    });

    it('names the running step on the button so a push never looks idle', () => {
      cloud.pushing.set(true);
      cloud.pushPhase.set('uploading');
      const fixture = mount();

      expect(deployButton(fixture).textContent).toContain('Uploading');
    });
  });

  describe('what goes live', () => {
    it('states that a workflow has never been deployed rather than showing an empty diff', () => {
      const fixture = mount();
      const text = ((fixture.nativeElement as HTMLElement).textContent ?? '').replace(/\s+/g, ' ');

      expect(text).toContain('has not been deployed before');
    });

    it('warns that unsaved canvas edits travel with the deploy', () => {
      workflow.isDirty.set(true);
      const fixture = mount();

      expect(warnings(fixture).join(' ')).toContain('unsaved edits');
    });
  });
});
