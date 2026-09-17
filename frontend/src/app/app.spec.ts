import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { App } from './app';
import { NotificationCenterService } from './core/notification-center.service';
import { PanelRegistryService } from './core/panel-registry.service';
import { RunControllerService } from './core/run-controller.service';
import { WorkflowService } from './core/workflow.service';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideNoopAnimations()],
    }).compileComponents();
  });

  it('should create the app shell', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render the toolbar, canvas, and both sidebars', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('app-toolbar')).toBeTruthy();
    expect(compiled.querySelector('app-graph-canvas')).toBeTruthy();
    expect(compiled.querySelectorAll('app-sidebar').length).toBe(2);
  });

  /**
   * The notification wiring, in ONE test on purpose.
   *
   * The shell is the only place allowed to hold the notification centre and
   * `CloudService` at once - the centre must not inject it, because that closes the
   * known NG0200 cycle - so "the seam was installed" has no other witness, and an
   * uninstalled handler is a bell whose rows silently do nothing when clicked.
   *
   * Why one test and not three: constructing `App` arms `WorkflowBackupService`'s
   * and `LibraryExportService`'s library-watching effects, and those outlive
   * `TestBed.resetTestingModule()`. A late upload from an abandoned instance lands
   * in a LATER spec's `fetch` spy and fails it - which is exactly what three extra
   * `App` fixtures here started doing to `WorkflowBackupService`'s own suite. Every
   * `App` construction in this file is a cost paid by the whole run, so this asserts
   * everything it can from a single one.
   *
   * The "no poll without a subscription" claim is deliberately NOT here: it belongs
   * to `deployed-notifications.service.spec.ts`, which already owns it and needs no
   * shell at all.
   */
  it('installs the notification deep-link handler and takes it to the run', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const centre = TestBed.inject(NotificationCenterService);
    const panels = TestBed.inject(PanelRegistryService);
    const runController = TestBed.inject(RunControllerService);
    const openSpy = spyOn(TestBed.inject(WorkflowService), 'openWorkflow');
    panels.setActive('left', 'agents');

    expect(centre.deepLinkHandler).not.toBeNull();

    centre.deepLinkHandler!({ workflowId: 'wf-a', runId: 'run-7', deployed: false });

    expect(openSpy).toHaveBeenCalledWith('wf-a');
    expect(panels.activeLeft()).toBe('runs');
    // Handed to the panel rather than opened here: a cloud run's history arrives
    // one request later, so the request has to outlive this call.
    expect(runController.focusRunId()).toBe('run-7');
  });
});
