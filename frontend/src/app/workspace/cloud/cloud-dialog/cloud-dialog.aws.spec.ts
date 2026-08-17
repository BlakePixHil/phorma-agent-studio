// Feature: aws-byo-deploy, task 15.2 - examples for the Cloud dialog AWS controls
//
// Behavioural examples, not a property: the surface is two buttons, one console
// link and two read-only fields, so there is nothing to enumerate. `fast-check`
// is an `engine` dependency and must not be added to `frontend`.
//
// Validates Requirements 1.8 (browser preview cannot deploy), 3.6 (the
// Deploy_Config_File is rewritten before the CLI runs), 5.7 (a `doctor` exit of 4
// names `aws sso login`) and 12.7 (no cancel affordance; the run console is the
// affordance offered instead).
//
// Three readings this file makes explicit.
//
// 1. THE ORDERING IN REQUIREMENT 3.6 IS "WRITTEN", NOT "STARTED". A call-order
//    log alone passes for a `runAwsPlanAndDeploy` that kicks the write off and
//    does not await it, which would race the CLI against its own config file. So
//    the write is GATED here: the spec releases it by hand and asserts
//    `planAndDeploy` had not been reached while it was still in flight.
// 2. "NO CANCEL CONTROL" IS ASSERTED AS A CLOSED SET, not as the absence of a
//    word. The running state's controls are pinned exactly - Plan and deploy,
//    Doctor, Open console - and every control in the whole card is listed, so a
//    Cancel added later fails by name instead of slipping past a regex.
// 3. THE `doctor` EXIT-4 PATH IS DRIVEN AT `executeStreamedCommand`, the one
//    private that stands between `AwsCliService` and the dynamic
//    `@tauri-apps/api/core` import karma cannot stub. Everything above it is
//    real: the rendered button, `runAwsDoctor`, the public `runCommand`, the exit
//    code mapping and the `ToastService` call. What it does NOT cover is the IPC
//    itself and whether the CLI really exits 4 on an expired session - that half
//    lives in `cloud-aws`.
//
// The endpoint field ids are scoped per component instance (`cloud-aws-1-...`),
// so every query here resolves the prefix off the DOM or goes through the
// `<label for>` association, and one example mounts two visible instances to pin
// that the ids stay unique.

import { ApplicationRef } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';

import { CloudDialog } from './cloud-dialog';
import { CloudDialogService } from '../cloud-dialog.service';
import { CloudService } from '../../../core/cloud.service';
import { SettingsService } from '../../../core/settings.service';
import { TauriService } from '../../../core/tauri.service';
import { TerminalOutputService } from '../../../core/terminal-output.service';
import { ToastService } from '../../../shared/toast/toast.service';
import { AwsCliService, type AwsCommandResult } from '../../../core/deploy/aws-cli.service';
import {
  AWS_CONFIG_FILENAME,
  AwsDeployConfigService,
} from '../../../core/deploy/aws-deploy-config.service';
import {
  AWS_AUTH_FAILURE_EXIT_CODE,
  type DeployCommand,
} from '../../../core/deploy/deploy-targets';

/** The configured `cloud-aws/` directory every example seeds. */
const CLOUD_AWS_DIR = 'C:/Dev/phorma/cloud-aws';

/** The one private the CLI-facing examples are driven through. */
type StubbedRunner = {
  executeStreamedCommand(command: DeployCommand, collect?: string[]): Promise<AwsCommandResult>;
};

// ── DOM helpers ──────────────────────────────────────────────────────────────

/**
 * Elements of `root` matching `selector` that the browser actually lays out.
 *
 * Two instances of a panel body are routinely in the DOM at once in this app, so
 * a DOM query has to say WHICH instance it means. Zero width is how the hidden
 * one presents.
 */
function laidOut<E extends HTMLElement>(root: ParentNode, selector: string): E[] {
  return Array.from(root.querySelectorAll<E>(selector)).filter(
    (element) => element.getBoundingClientRect().width > 0,
  );
}

/** An element's visible text, whitespace collapsed and nbsp normalized. */
function text(element: Element | null | undefined): string {
  return (element?.textContent ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The one laid-out dialog card. */
function card(root: ParentNode): HTMLElement {
  const cards = laidOut<HTMLElement>(root, '.phorma-cloud__card');
  if (cards.length !== 1) throw new Error(`Expected 1 laid-out cloud card, found ${cards.length}.`);
  return cards[0];
}

/** The one laid-out body section whose heading contains `needle`. */
function section(root: ParentNode, needle: string): HTMLElement {
  const matches = laidOut<HTMLElement>(root, '.phorma-cloud__section').filter((element) =>
    text(element.querySelector('.phorma-cloud__heading')).includes(needle),
  );
  if (matches.length !== 1) {
    const headings = laidOut<HTMLElement>(root, '.phorma-cloud__heading').map(text);
    throw new Error(
      `Expected 1 section whose heading contains "${needle}", found ${matches.length}. ` +
        `Headings: ${headings.join(' | ') || '(none)'}`,
    );
  }
  return matches[0];
}

/** The "1 · Plan and deploy" section of a fixture. */
function deploySection(fixture: ComponentFixture<CloudDialog>): HTMLElement {
  return section(fixture.nativeElement as HTMLElement, 'Plan and deploy');
}

/** The accessible name of a control: its `aria-label` if it has one, else its text. */
function controlName(element: HTMLElement): string {
  return element.getAttribute('aria-label')?.trim() || text(element);
}

/** Every laid-out control under `root`, by accessible name, in DOM order. */
function controlNames(root: ParentNode): string[] {
  return laidOut<HTMLElement>(root, 'button, [role="button"], a[href]').map(controlName);
}

/** The one laid-out control named `name` under `root`. */
function control(root: ParentNode, name: string): HTMLButtonElement {
  const matches = laidOut<HTMLButtonElement>(root, 'button').filter(
    (button) => controlName(button) === name,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected 1 control named "${name}", found ${matches.length}. ` +
        `Controls: ${controlNames(root).join(' | ') || '(none)'}`,
    );
  }
  return matches[0];
}

/** Whether a control renders the in-flight spinner. */
function hasSpinner(button: HTMLElement): boolean {
  return button.querySelector('.ti-loader-2.phorma-icon-spin') !== null;
}

/** Every `__hint` line under `root`, whitespace collapsed. */
function hints(root: ParentNode): string[] {
  return laidOut<HTMLElement>(root, '.phorma-cloud__hint').map(text);
}

/** Every `__note` line under `root`, whitespace collapsed. */
function notes(root: ParentNode): string[] {
  return laidOut<HTMLElement>(root, '.phorma-cloud__note').map(text);
}

// ── Config seeding ───────────────────────────────────────────────────────────

/**
 * Puts every AWS_Config_Field into a state that passes its validator, so
 * `valid()` is true and the controls are governed by the desktop flag and the
 * in-flight flag alone.
 *
 * Values mirror `applyValidConfig` in
 * `workspace/settings/settings-dialog/settings-dialog.aws.spec.ts`: task 13.1 made
 * `valid()` enforce required fields, so an untouched store is INVALID and the
 * controls start disabled.
 */
function applyValidConfig(config: AwsDeployConfigService): void {
  config.setAccountId('123456789012');
  config.setRegion('eu-west-1');
  config.setNamePrefix('acme-agents');
  config.setPermissionsBoundaryArn('arn:aws:iam::123456789012:policy/PlatformBoundary');
  config.setBootstrapQualifier('phorma');
  config.setVpcId('vpc-0a1b2c3d4e5f60718');
  config.setSubnetIds(['subnet-0a1b2c3d']);
  config.setAppCmkArn('arn:aws:kms:eu-west-1:123456789012:key/2f9a1b2c');
  config.setTagSet({ app: 'phorma' });
  config.setRetentionDays(30);
  config.setNotificationTargetArn('arn:aws:sns:eu-west-1:123456789012:platform-alarms');
  config.setCloudAwsDirectory(CLOUD_AWS_DIR);
  config.setImageUri('registry.example.test/phorma/server:1.4.2');
  config.triggerApiUrl.set('https://trigger.example.test');
  config.monitorApiUrl.set('wss://monitor.example.test/live');
}

/**
 * Empties every field, so nothing leaks into the next spec through localStorage.
 *
 * `retentionDays` is the one field whose cleared value is its default of 30
 * rather than blank - it is the only validator that is not valid-when-empty.
 */
function clearConfig(config: AwsDeployConfigService): void {
  config.setAccountId('');
  config.setRegion('');
  config.setNamePrefix('');
  config.setPermissionsBoundaryArn('');
  config.setBootstrapQualifier('');
  config.setVpcId('');
  config.setSubnetIds([]);
  config.setAppCmkArn('');
  config.setTagSet({});
  config.setRetentionDays(30);
  config.setNotificationTargetArn('');
  config.setCloudAwsDirectory('');
  config.setImageUri('');
  config.triggerApiUrl.set('');
  config.monitorApiUrl.set('');
}

/**
 * Mounts the Cloud dialog with `aws` selected and the dialog OPEN.
 *
 * The whole template is wrapped in `@if (dialog.visible())`, so nothing renders
 * until it is opened. `refreshStatus` is stubbed out: the constructor effect
 * fires it whenever the dialog opens, and a live deployment-status probe against
 * a synthetic endpoint is not what this file is about.
 */
function mount(seed?: (config: AwsDeployConfigService) => void): ComponentFixture<CloudDialog> {
  const config = TestBed.inject(AwsDeployConfigService);
  clearConfig(config);
  seed?.(config);
  TestBed.inject(SettingsService).cloudProvider.set('aws');
  spyOn(TestBed.inject(CloudService), 'refreshStatus').and.resolveTo();
  TestBed.inject(CloudDialogService).open();
  const fixture = TestBed.createComponent(CloudDialog);
  fixture.detectChanges();
  return fixture;
}

/**
 * Every AWS field persists to localStorage through an `effect()` rather than from
 * its setters, and karma runs ONE browser for the whole suite. So the queued
 * writes are flushed with `tick()` BEFORE the clear, or they land after it and
 * the next injector loads them - which decides `valid()` and `configured()` in
 * every later spec.
 */
function cleanUp(): void {
  clearConfig(TestBed.inject(AwsDeployConfigService));
  TestBed.inject(SettingsService).cloudProvider.set(null);
  TestBed.inject(CloudDialogService).close();
  TestBed.inject(ApplicationRef).tick();
  localStorage.clear();
}

/** The desktop injector every enabled-state example uses. */
function configureDesktop(): void {
  TestBed.configureTestingModule({
    providers: [
      provideNoopAnimations(),
      {
        provide: TauriService,
        useValue: { isDesktop: true, selectFolderDialog: () => Promise.resolve(null) },
      },
    ],
  });
}

// ── Async helpers ────────────────────────────────────────────────────────────

/**
 * Drains the pending async work of a click handler.
 *
 * `runAwsPlanAndDeploy` reaches a dynamic `@tauri-apps/api/core` import and an
 * IndexedDB read on its way to `planAndDeploy`, so microtask flushes alone are
 * not enough - both are macrotasks.
 */
async function settle(fixture: ComponentFixture<CloudDialog>): Promise<void> {
  for (let pass = 0; pass < 5; pass += 1) {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  fixture.detectChanges();
}

/** Waits until `done()` holds, failing on a deadline rather than hanging karma. */
async function waitFor(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Whether `done()` becomes true within `budgetMs`. Never throws. */
async function happensWithin(done: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (!done()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

// ── Requirement 3.6: the config file is written before planAndDeploy ─────────

describe('The Cloud dialog writes the deploy configuration before planAndDeploy', () => {
  beforeEach(configureDesktop);
  afterEach(cleanUp);

  it('awaits the write, then hands the configured folder to planAndDeploy', async () => {
    const config = TestBed.inject(AwsDeployConfigService);
    const cli = TestBed.inject(AwsCliService);
    const order: string[] = [];
    let releaseWrite = (): void => {};
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });

    spyOn(config, 'writeConfigFile').and.callFake(async () => {
      order.push('write:start');
      await writeGate;
      order.push('write:done');
      return true;
    });
    const planAndDeploy = spyOn(cli, 'planAndDeploy').and.callFake(async () => {
      order.push('planAndDeploy');
    });

    const fixture = mount(applyValidConfig);
    control(deploySection(fixture), 'Plan and deploy').click();

    // The write is held pending and the deploy path is given REAL TIME to overtake
    // it. This is the half a call-order log cannot see: an implementation that
    // kicks the write off without awaiting it reaches `planAndDeploy` in this
    // window. A fixed number of task turns is not enough, because the two probes
    // `planAndDeploy` takes as arguments are themselves macrotasks - a dynamic
    // import and an IndexedDB read - and a wrong ordering hides behind them.
    //
    // No flake either way: a correct implementation can never reach
    // `planAndDeploy` here however long the window is, so the budget only bounds
    // how much of a wrong implementation's head start is observed.
    const overtook = await happensWithin(() => planAndDeploy.calls.any(), 750);
    expect(overtook)
      .withContext('planAndDeploy ran while the config write was still in flight')
      .toBeFalse();
    expect(order)
      .withContext('while the config write is still in flight')
      .toEqual(['write:start']);

    releaseWrite();
    await waitFor(() => planAndDeploy.calls.any(), 'planAndDeploy after the write completed');

    expect(order).toEqual(['write:start', 'write:done', 'planAndDeploy']);
    expect(planAndDeploy).toHaveBeenCalledTimes(1);
    expect(planAndDeploy.calls.mostRecent().args[0])
      .withContext('planAndDeploy runs in the configured cloud-aws folder')
      .toBe(CLOUD_AWS_DIR);
  });

  it('a failed write aborts the deploy and names the file the Studio could not write', async () => {
    const config = TestBed.inject(AwsDeployConfigService);
    const cli = TestBed.inject(AwsCliService);
    const write = spyOn(config, 'writeConfigFile').and.resolveTo(false);
    const planAndDeploy = spyOn(cli, 'planAndDeploy');
    const errors = spyOn(TestBed.inject(ToastService), 'error');

    const fixture = mount(applyValidConfig);
    control(deploySection(fixture), 'Plan and deploy').click();
    // A real-time window rather than a few task turns: the probes on the way to
    // `planAndDeploy` are macrotasks, so a dropped early return needs time to show
    // itself. `settle` afterwards flushes the toast into the rendered state.
    const ran = await happensWithin(() => planAndDeploy.calls.any(), 750);
    await settle(fixture);

    expect(write).toHaveBeenCalledTimes(1);
    // The CLI reads the file the Studio just failed to write, so running it would
    // plan against a stale configuration.
    expect(ran).withContext('planAndDeploy ran after the config write failed').toBeFalse();
    expect(planAndDeploy).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledTimes(1);
    const [summary, detail] = errors.calls.mostRecent().args;
    expect(summary).toBe('Could not write the deploy configuration');
    expect(detail).toContain(AWS_CONFIG_FILENAME);
  });
});

// ── Requirement 1.8: browser preview cannot deploy ───────────────────────────

describe('The Cloud dialog AWS controls under browser preview', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideNoopAnimations(),
        { provide: TauriService, useValue: { isDesktop: false } },
      ],
    });
  });

  afterEach(cleanUp);

  it('disables both controls and says the desktop app is needed', () => {
    const fixture = mount(applyValidConfig);
    const body = deploySection(fixture);

    // A complete configuration, so nothing here is disabled by validity - the
    // missing desktop shell is the only reason.
    expect(TestBed.inject(AwsDeployConfigService).valid())
      .withContext('the seeded configuration is valid')
      .toBeTrue();
    expect(control(body, 'Plan and deploy').disabled).withContext('Plan and deploy').toBeTrue();
    expect(control(body, 'Doctor').disabled).withContext('Doctor').toBeTrue();
    expect(notes(body)).toContain('Deploying to AWS needs the desktop app.');
  });

  it('presses through to nothing: no config write and no CLI invocation', async () => {
    const config = TestBed.inject(AwsDeployConfigService);
    const cli = TestBed.inject(AwsCliService);
    const write = spyOn(config, 'writeConfigFile').and.resolveTo(true);
    const planAndDeploy = spyOn(cli, 'planAndDeploy');
    const runCommand = spyOn(cli, 'runCommand').and.resolveTo({ success: true, exitCode: 0 });

    const fixture = mount(applyValidConfig);
    const body = deploySection(fixture);
    control(body, 'Plan and deploy').click();
    control(body, 'Doctor').click();
    // Real time, not task turns: were the controls wrongly enabled, the handlers
    // they would run reach the CLI through macrotasks.
    const reached = await happensWithin(
      () => write.calls.any() || planAndDeploy.calls.any() || runCommand.calls.any(),
      750,
    );
    await settle(fixture);

    // Disabled is behaviour, not chrome: neither press reaches the filesystem or
    // the Deploy_Runner.
    expect(reached).withContext('a disabled control reached the CLI').toBeFalse();
    expect(write).not.toHaveBeenCalled();
    expect(planAndDeploy).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });
});

// ── Requirement 12.7: in-flight state, no cancel, a console link instead ─────

describe('The Cloud dialog AWS section while a command is in flight', () => {
  beforeEach(configureDesktop);

  afterEach(() => {
    TestBed.inject(AwsCliService).running.set(false);
    cleanUp();
  });

  /** Every control the card offers while running, in DOM order. */
  const RUNNING_CONTROLS = [
    'Change cloud provider',
    'Plan and deploy',
    'Doctor',
    'Open console',
    'Push workflow',
    'Connect monitor',
    'Close',
  ];

  /** The same set with the console link absent, which is the idle card. */
  const IDLE_CONTROLS = RUNNING_CONTROLS.filter((name) => name !== 'Open console');

  function mountRunning(): ComponentFixture<CloudDialog> {
    const fixture = mount(applyValidConfig);
    TestBed.inject(AwsCliService).running.set(true);
    fixture.detectChanges();
    return fixture;
  }

  it('disables both controls and replaces the idle hint with the streaming line', () => {
    const fixture = mountRunning();
    const body = deploySection(fixture);

    expect(control(body, 'Plan and deploy').disabled).withContext('Plan and deploy').toBeTrue();
    expect(control(body, 'Doctor').disabled).withContext('Doctor').toBeTrue();
    expect(hints(body)).toEqual(['Running. Output is streaming to the console.']);
  });

  it('offers a console link rather than a cancel control', () => {
    const idle = mount(applyValidConfig);
    // The link is in-flight state, not permanent chrome.
    expect(controlNames(card(idle.nativeElement as HTMLElement))).toEqual(IDLE_CONTROLS);

    TestBed.inject(AwsCliService).running.set(true);
    idle.detectChanges();

    // A CLOSED SET, so a Cancel added later fails by name here instead of
    // slipping past a keyword search. `run_streamed_command` exposes no
    // cancellation, and killing a `cdk deploy` mid-flight is worse than letting
    // it settle, so the console link is the whole affordance.
    const names = controlNames(card(idle.nativeElement as HTMLElement));
    expect(names).toEqual(RUNNING_CONTROLS);
    for (const name of names) {
      expect(name)
        .withContext(`"${name}" reads as a cancel affordance`)
        .not.toMatch(/\b(cancel|abort|stop|kill|terminate)\b/i);
    }
  });

  it('the console link opens the run console', () => {
    const fixture = mountRunning();
    const terminal = TestBed.inject(TerminalOutputService);
    terminal.close();
    terminal.setActiveChannel('problems');

    control(deploySection(fixture), 'Open console').click();

    expect(terminal.collapsed()).withContext('the console dock is open').toBeFalse();
    expect(terminal.activeChannel()).withContext('on the run channel').toBe('run');
  });

  it('the console link is never disabled, so the operator can always reach the output', () => {
    const fixture = mountRunning();
    expect(control(deploySection(fixture), 'Open console').disabled).toBeFalse();
  });
});

// ── Requirement 5.7: a doctor exit of 4 names `aws sso login` ────────────────

/**
 * The seam, and what it does and does not prove.
 *
 * `AwsCliService.runCommand` reaches the CLI through `executeStreamedCommand`,
 * which dynamically imports `@tauri-apps/api/core` - karma cannot stub that, so a
 * real exit code cannot be driven end to end. The private IS assignable on the
 * instance, which is the seam `aws-deploy.spec.ts` already uses for the `outputs`
 * fallback, and replacing it leaves every layer above it real: the rendered
 * Doctor button, `runAwsDoctor`, the command it builds, the public `runCommand`,
 * the exit-code mapping and the `ToastService` call.
 *
 * NOT covered here: the Tauri IPC itself, and whether the CLI really exits 4 on
 * an expired session. That contract lives in `cloud-aws` and is exercised there.
 */
describe('The Cloud dialog Doctor control', () => {
  beforeEach(configureDesktop);

  afterEach(cleanUp);

  interface DoctorRun {
    readonly commands: DeployCommand[];
    readonly errors: jasmine.Spy;
    readonly fixture: ComponentFixture<CloudDialog>;
  }

  /** Presses Doctor with the Deploy_Runner answering `result`. */
  async function pressDoctor(result: AwsCommandResult): Promise<DoctorRun> {
    const cli = TestBed.inject(AwsCliService);
    const commands: DeployCommand[] = [];
    (cli as unknown as StubbedRunner).executeStreamedCommand = async (command) => {
      commands.push(command);
      return result;
    };
    const errors = spyOn(TestBed.inject(ToastService), 'error');

    const fixture = mount(applyValidConfig);
    control(deploySection(fixture), 'Doctor').click();
    await settle(fixture);
    return { commands, errors, fixture };
  }

  it('runs `npx phorma-aws doctor` in the configured folder', async () => {
    const { commands } = await pressDoctor({ success: true, exitCode: 0 });

    expect(commands).toEqual([
      { program: 'npx', args: ['phorma-aws', 'doctor'], cwd: CLOUD_AWS_DIR },
    ]);
  });

  it('an exit code of 4 surfaces the `aws sso login` next step', async () => {
    const { commands, errors } = await pressDoctor({
      success: false,
      exitCode: AWS_AUTH_FAILURE_EXIT_CODE,
    });

    // The command really ran, so the message is a report of that exit code rather
    // than a precondition refusal.
    expect(commands.length).withContext('the doctor verb reached the Deploy_Runner').toBe(1);
    expect(errors).toHaveBeenCalledTimes(1);
    const [summary, detail] = errors.calls.mostRecent().args;
    expect(summary).withContext('the failure names the verb').toBe('Doctor failed');
    expect(detail).withContext('the detail names the next step').toContain('aws sso login');
  });

  it('a clean doctor run surfaces nothing', async () => {
    const { errors } = await pressDoctor({ success: true, exitCode: 0 });

    // Otherwise the exit-4 example above would pass for a message shown always.
    expect(errors).not.toHaveBeenCalled();
  });

  it('a non-auth exit code names the code instead of the login step', async () => {
    const { errors } = await pressDoctor({ success: false, exitCode: 1 });

    expect(errors).toHaveBeenCalledTimes(1);
    const [summary, detail] = errors.calls.mostRecent().args;
    expect(summary).toBe('Doctor failed');
    expect(detail).toContain('code 1');
    expect(detail).not.toContain('sso login');
  });

  it('spins the control the operator pressed, not both', async () => {
    const cli = TestBed.inject(AwsCliService);
    let releaseRun = (): void => {};
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    (cli as unknown as StubbedRunner).executeStreamedCommand = async () => {
      await runGate;
      return { success: true, exitCode: 0 };
    };

    const fixture = mount(applyValidConfig);
    control(deploySection(fixture), 'Doctor').click();
    await waitFor(() => cli.running(), 'the doctor command to start');
    fixture.detectChanges();

    // `AwsCliService.running()` is one shared boolean, so the spinner is targeted
    // by the dialog's own record of which control was pressed.
    const body = deploySection(fixture);
    expect(hasSpinner(control(body, 'Doctor'))).withContext('Doctor spins').toBeTrue();
    expect(hasSpinner(control(body, 'Plan and deploy')))
      .withContext('Plan and deploy does not')
      .toBeFalse();

    releaseRun();
    await settle(fixture);
    expect(cli.running()).toBeFalse();
    expect(hasSpinner(control(deploySection(fixture), 'Doctor')))
      .withContext('the spinner clears when the command settles')
      .toBeFalse();
  });
});

// ── The discovered-endpoint fields are scoped per instance ───────────────────

describe('The Cloud dialog discovered-endpoint fields', () => {
  beforeEach(configureDesktop);

  afterEach(cleanUp);

  it('renders both endpoints read-only, resolved through their labels', () => {
    const fixture = mount(applyValidConfig);
    const body = section(fixture.nativeElement as HTMLElement, 'Discovered endpoints');
    const config = TestBed.inject(AwsDeployConfigService);

    for (const [label, expected] of [
      ['Trigger API', config.triggerApiUrl()],
      ['Monitor API', config.monitorApiUrl()],
    ] as const) {
      const labels = laidOut<HTMLLabelElement>(body, 'label').filter((el) => text(el) === label);
      expect(labels.length).withContext(`${label}: labels`).toBe(1);
      // The browser's own `for` -> control resolution, which only works while the
      // scoped id is unique in the document.
      const field = labels[0].control as HTMLInputElement | null;
      expect(field).withContext(`${label}: the label resolves to its control`).toBeTruthy();
      expect(field!.readOnly).withContext(`${label}: is read-only`).toBeTrue();
      expect(field!.value).withContext(`${label}: shows the discovered value`).toBe(expected);
    }
  });

  it('keeps every element id unique with two instances mounted', () => {
    const first = mount(applyValidConfig);
    // TestBed's DOM renderer removes every previous root element when it inserts
    // the next one, so a second fixture alone does NOT reproduce the hazard this
    // example exists for. Re-attaching the first root is the point: the app really
    // does host two instances of a body at once.
    const firstRoot = first.nativeElement as HTMLElement;
    const second = TestBed.createComponent(CloudDialog);
    if (!firstRoot.isConnected) document.body.appendChild(firstRoot);
    second.detectChanges();
    first.detectChanges();

    const ids = Array.from(document.querySelectorAll('[id]')).map((element) => element.id);
    expect(ids.length).withContext('total ids vs unique ids').toBe(new Set(ids).size);

    // Which is why a query for one instance must be scoped: document-wide, each
    // endpoint field now has two controls.
    for (const suffix of ['triggerApiUrl', 'monitorApiUrl']) {
      const across = laidOut<HTMLInputElement>(document, `input[id$="-${suffix}"]`);
      expect(across.length).withContext(`${suffix}: controls across both instances`).toBe(2);
      expect(new Set(across.map((input) => input.id)).size)
        .withContext(`${suffix}: the two ids differ`)
        .toBe(2);
    }

    second.destroy();
  });
});
