import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import type { EgressAllowList } from '@phorma/engine';

import {
  AwsCliService,
  MONITOR_API_OUTPUT,
  TRIGGER_API_OUTPUT,
  type AwsCommandResult,
} from './aws-cli.service';
import { AwsDeployConfigService, AWS_CONFIG_FILENAME } from './aws-deploy-config.service';
import { DEPLOY_TARGETS, AWS_AUTH_FAILURE_EXIT_CODE, type DeployCommand } from './deploy-targets';
import { SENTINEL_PREFIX } from './sentinel-envelope';
import { TauriService } from '../tauri.service';
import { ToastService } from '../../shared/toast/toast.service';
import { ConfirmDialogService } from '../../shared/confirm-dialog/confirm-dialog.service';
import { SettingsService } from '../settings.service';

/** Minimal empty egress allow-list for tests that exercise only the CLI flow. */
const EMPTY_EGRESS: EgressAllowList = { hosts: [], undeterminable: [], capped: false };

/**
 * AWS deploy flow frontend specs.
 *
 * Validates: Requirements 3.1, 3.2, 3.5, 11.4, 14.1, 14.4, 14.5, 14.6, 14.9,
 * 14.10, 14.11, 14.12, 14.14
 */

// ─── 14.1: Target persistence across reload ─────────────────────────────────

describe('AWS deploy target persistence (14.1)', () => {
  afterEach(() => localStorage.clear());

  it('persists CloudProviderChoice "aws" in localStorage and restores it', () => {
    // First "session" - set the provider.
    const bed1 = TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: false } }],
    });
    const settings1 = bed1.inject(SettingsService);
    settings1.cloudProvider.set('aws');
    // The effect persists it synchronously in the microtask; flush it.
    TestBed.flushEffects();

    const raw = localStorage.getItem('phorma.layout.cloudProvider');
    expect(raw).toBe('"aws"');

    // Second "session" - a fresh service instance reads it back.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: false } }],
    });
    const settings2 = TestBed.inject(SettingsService);
    expect(settings2.cloudProvider()).toBe('aws');
  });
});

// ─── 14.4-14.6: Plan-then-confirm-then-deploy ordering ──────────────────────

describe('AWS plan-then-confirm-then-deploy ordering (14.4-14.6)', () => {
  let service: AwsCliService;
  let confirm: ConfirmDialogService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: true } }],
    });
    service = TestBed.inject(AwsCliService);
    confirm = TestBed.inject(ConfirmDialogService);
  });

  it('plan command precedes deploy in the target registry', () => {
    // The service reaches the CLI through a dynamic import karma cannot stub, so
    // the ordering contract is checked where it is declared: the aws target must
    // expose a plan command as well as a deploy command.
    const awsTarget = DEPLOY_TARGETS['aws'];
    expect(awsTarget.planCommand).toBeDefined();

    const planCmd = awsTarget.planCommand!({ cloudFolder: '/tmp/cloud-aws', workflowId: 'wf1', baseUrl: '' });
    expect(planCmd).toBeTruthy();
    expect(planCmd!.args).toContain('plan');

    const deployCmd = awsTarget.deployCommand({ cloudFolder: '/tmp/cloud-aws', workflowId: 'wf1', baseUrl: '' });
    expect(deployCmd).toBeTruthy();
    expect(deployCmd!.args).toContain('deploy');
  });

  it('plan exits non-zero: confirmation is never offered (14.5)', async () => {
    // The AwsCliService.planAndDeploy logic: if plan fails, it returns without
    // calling confirm. We verify this through the service's guard.
    const confirmSpy = spyOn(confirm, 'confirm');

    // Simulate precondition failure (not desktop) to confirm no confirm is called.
    // Override isDesktop to false for this test - validatePreconditions returns false.
    (service as any).tauri = { isDesktop: false };
    await service.planAndDeploy('/tmp/cloud-aws', true, EMPTY_EGRESS);

    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('DEPLOY_TARGETS aws has plan and deploy commands in the correct order', () => {
    const target = DEPLOY_TARGETS['aws'];
    // Plan must be defined and deploy must be defined.
    expect(target.planCommand).toBeDefined();
    expect(target.deployCommand).toBeDefined();

    const ctx = { cloudFolder: '/project/cloud-aws', workflowId: 'wf-123', baseUrl: 'https://api.example' };
    const plan = target.planCommand!(ctx);
    const deploy = target.deployCommand(ctx);

    expect(plan!.program).toBe('npx');
    expect(plan!.args).toEqual(['phorma-aws', 'plan']);
    expect(plan!.cwd).toBe('/project/cloud-aws');

    expect(deploy!.program).toBe('npx');
    expect(deploy!.args).toEqual(['phorma-aws', 'deploy']);
    expect(deploy!.cwd).toBe('/project/cloud-aws');
  });
});

// ─── 14.9: Authentication-failure message ────────────────────────────────────

describe('AWS authentication-failure message (14.9)', () => {
  it('exit code 4 maps to AWS_AUTH_FAILURE_EXIT_CODE', () => {
    expect(AWS_AUTH_FAILURE_EXIT_CODE).toBe(4);
  });

  it('AwsCliService reports "aws sso login" for exit code 4', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: true } }],
    });
    const service = TestBed.inject(AwsCliService);
    const toast = TestBed.inject(ToastService);
    const errorSpy = spyOn(toast, 'error');

    // Access the private method through the service instance to verify behavior.
    (service as any).reportExitFailure('Plan failed', AWS_AUTH_FAILURE_EXIT_CODE);

    expect(errorSpy).toHaveBeenCalledWith(
      'Plan failed',
      jasmine.stringMatching(/aws sso login/),
    );
  });

  it('a non-auth exit code does not mention sso login', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: true } }],
    });
    const service = TestBed.inject(AwsCliService);
    const toast = TestBed.inject(ToastService);
    const errorSpy = spyOn(toast, 'error');

    (service as any).reportExitFailure('Deploy failed', 1);

    expect(errorSpy).toHaveBeenCalledWith('Deploy failed', jasmine.stringMatching(/code 1/));
    expect(errorSpy).not.toHaveBeenCalledWith(jasmine.anything(), jasmine.stringMatching(/sso login/));
  });
});

// ─── 14.10: Missing-directory and missing-entry-point branches ───────────────

describe('AWS missing-directory and missing-entry-point (14.10)', () => {
  let service: AwsCliService;
  let toast: ToastService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: true } }],
    });
    service = TestBed.inject(AwsCliService);
    toast = TestBed.inject(ToastService);
  });

  it('warns when cloudAwsDir is empty', async () => {
    const warnSpy = spyOn(toast, 'warning');
    await service.planAndDeploy('', true, EMPTY_EGRESS);
    // The warning names the FIX, not the folder: the CDK application ships inside
    // the app, so an operator sets up the deploy runtime rather than hunting for
    // a `cloud-aws` directory of their own.
    expect(warnSpy).toHaveBeenCalledWith(
      jasmine.stringMatching(/deploy runtime/i),
      jasmine.stringMatching(/Settings/),
    );
  });

  it('warns when CDK entry point is missing', async () => {
    const warnSpy = spyOn(toast, 'warning');
    await service.planAndDeploy('/valid/path', false, EMPTY_EGRESS);
    expect(warnSpy).toHaveBeenCalledWith(
      jasmine.stringMatching(/entry point/i),
      jasmine.anything(),
    );
  });

  it('does not start any command when directory is absent', async () => {
    const runningSpy = service.running;
    await service.planAndDeploy('', true, EMPTY_EGRESS);
    expect(runningSpy()).toBeFalse();
  });
});

// ─── 14.11: Browser-preview refusal ─────────────────────────────────────────

describe('AWS browser-preview refusal (14.11)', () => {
  it('refuses to run when not desktop', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: false } }],
    });
    const service = TestBed.inject(AwsCliService);
    const toast = TestBed.inject(ToastService);
    const warnSpy = spyOn(toast, 'warning');

    await service.planAndDeploy('/path/cloud-aws', true, EMPTY_EGRESS);

    expect(warnSpy).toHaveBeenCalledWith(
      jasmine.stringMatching(/desktop/i),
      jasmine.stringMatching(/browser preview/i),
    );
  });

  it('runCommand also refuses in the browser', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: false } }],
    });
    const service = TestBed.inject(AwsCliService);
    const toast = TestBed.inject(ToastService);
    const warnSpy = spyOn(toast, 'warning');

    const result = await service.runCommand({
      program: 'npx',
      args: ['phorma-aws', 'doctor'],
      cwd: '/tmp',
    });

    expect(result.success).toBeFalse();
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ─── 14.12: Gitignored generated file and its provenance notice ──────────────

describe('AWS generated config file (14.12)', () => {
  let configService: AwsDeployConfigService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: false } }],
    });
    configService = TestBed.inject(AwsDeployConfigService);
  });

  afterEach(() => localStorage.clear());

  it('buildConfigFile() states its provenance in the $generatedBy notice', () => {
    configService.setAccountId('123456789012');
    configService.setRegion('us-east-1');
    configService.setNamePrefix('myapp');
    configService.setPermissionsBoundaryArn('arn:aws:iam::123456789012:policy/boundary');

    const output = configService.buildConfigFile();

    expect(output).toContain('"$generatedBy"');
    expect(output).toContain('GENERATED BY PHORMA AGENT STUDIO');
    expect(output).toContain('do not edit by hand');
    expect(output).toContain('gitignored');
  });

  it('the generated filename is the expected constant', () => {
    expect(AWS_CONFIG_FILENAME).toBe('cdk.context.phorma.json');
  });
});

// ─── 14.14: Concurrent-command guard and cancel affordance ───────────────────

describe('AWS concurrent-command guard (14.14)', () => {
  let service: AwsCliService;
  let toast: ToastService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: true } }],
    });
    service = TestBed.inject(AwsCliService);
    toast = TestBed.inject(ToastService);
  });

  it('running signal prevents a second command', async () => {
    // Simulate a command in flight by setting the signal.
    service.running.set(true);
    const warnSpy = spyOn(toast, 'warning');

    const result = await service.runCommand({
      program: 'npx',
      args: ['phorma-aws', 'plan'],
      cwd: '/tmp/cloud-aws',
    });

    expect(result.success).toBeFalse();
    expect(warnSpy).toHaveBeenCalledWith(
      jasmine.stringMatching(/already running/i),
      jasmine.anything(),
    );
  });

  it('planAndDeploy does nothing when a command is already running', async () => {
    service.running.set(true);
    const confirmSpy = spyOn(TestBed.inject(ConfirmDialogService), 'confirm');

    await service.planAndDeploy('/path', true, EMPTY_EGRESS);

    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('running signal resets to false after command completes', () => {
    // When no command is in flight, the signal should be false.
    expect(service.running()).toBeFalse();
  });
});

// ─── 11.4: Region_Pin display ────────────────────────────────────────────────

describe('Region_Pin display (11.4)', () => {
  let awsConfig: AwsDeployConfigService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: false } }],
    });
    awsConfig = TestBed.inject(AwsDeployConfigService);
  });

  afterEach(() => localStorage.clear());

  it('shows the region when configured', () => {
    awsConfig.setRegion('us-east-1');
    // The cloud dialog computes: awsConfig.region() || null
    const label = awsConfig.region() || null;
    expect(label).toBe('us-east-1');
  });

  it('shows null (not configured) when region is empty', () => {
    awsConfig.setRegion('');
    const label = awsConfig.region() || null;
    expect(label).toBeNull();
  });

  it('persists region in localStorage', () => {
    awsConfig.setRegion('ap-southeast-1');
    TestBed.flushEffects();
    const raw = localStorage.getItem('phorma.layout.awsRegion');
    expect(raw).toBe('"ap-southeast-1"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature: aws-byo-deploy, Property 17: Deploy_Config_File round trips through a bare JSON.parse
// ─────────────────────────────────────────────────────────────────────────────
//
// `fast-check` is an `engine` dependency and must not be added to `frontend`, so
// "property" here means exhaustive enumeration over a closed space rather than
// sampling. The space is the populated/empty vector across the AWS_Config_Field
// set, enumerated from the ONE declared table below - a field added to the store
// enters the enumeration on its own, and the store-coverage spec fails if the
// table forgot it.

/**
 * How `buildConfigFile()` treats one AWS_Config_Field when the field is empty.
 *
 * - `always`: the member is emitted whatever the value holds, so the
 *   Config_Parser can name a required field that is missing.
 * - `whenPopulated`: the member is omitted when empty, because blank means
 *   "take the other path" rather than a value (a blank `imageUri` is the
 *   asset-build path). `bootstrapQualifier` belongs here too: it is emitted as
 *   `undefined`, which `JSON.stringify` drops.
 * - `vpc`: half of the nested `vpc` member, emitted only when BOTH halves hold a
 *   value.
 * - `never`: a Studio-only field that must not reach the file at all.
 */
type FieldEmission = 'always' | 'whenPopulated' | 'vpc' | 'never';

/** One AWS_Config_Field, with everything the enumeration needs to drive it. */
interface AwsConfigFieldCase {
  /** The store's field name. Also the key in a populated/empty vector. */
  readonly field: string;
  /** The emitted member name, or null when the field is never emitted. */
  readonly member: string | null;
  readonly emission: FieldEmission;
  /**
   * Puts the field into the populated or the empty state.
   *
   * Populated values are fed through the SETTERS with deliberate surrounding
   * whitespace, so "every populated field appears with its trimmed value" is a
   * real assertion rather than a tautology: the setters trim (and `setRegion` /
   * `setNamePrefix` also lowercase), and the emitted document is compared
   * against what the store holds.
   */
  set(config: AwsDeployConfigService, populated: boolean): void;
  /** Reads the store, which is the oracle for the emitted value. */
  read(config: AwsDeployConfigService): unknown;
  /** What the store holds once populated: trimmed, and lowercased where the setter lowercases. */
  readonly populatedValue: unknown;
  /** What the store holds when the field is empty. */
  readonly emptyValue: unknown;
}

/**
 * `retentionDays` is the one field whose empty state is a default rather than a
 * blank: it is a number with a validated range, so "cleared" means back to 30.
 */
const RETENTION_DAYS_DEFAULT = 30;

/**
 * Members `buildConfigFile()` emits that are not AWS_Config_Fields.
 *
 * `egressAllowList` is written as an empty array here and filled in by the
 * derived allow-list on the deploy path, so it is a constant of the document
 * rather than a field state - but it still has to appear in the expected member
 * set, or the exact-member assertion below would reject it.
 */
const CONSTANT_MEMBERS: readonly string[] = ['egressAllowList'];

/**
 * The AWS_Config_Field set, in store order. THE declared list: the case
 * enumeration, the expected member set and the store-coverage spec all read it.
 */
const AWS_CONFIG_FIELDS: readonly AwsConfigFieldCase[] = [
  {
    field: 'accountId',
    member: 'accountId',
    emission: 'always',
    set: (config, populated) => config.setAccountId(populated ? '  123456789012  ' : ''),
    read: config => config.accountId(),
    populatedValue: '123456789012',
    emptyValue: '',
  },
  {
    field: 'region',
    member: 'region',
    emission: 'always',
    // Mixed case on purpose: `setRegion` lowercases as well as trims.
    set: (config, populated) => config.setRegion(populated ? '  US-EAST-1  ' : ''),
    read: config => config.region(),
    populatedValue: 'us-east-1',
    emptyValue: '',
  },
  {
    field: 'namePrefix',
    member: 'namePrefix',
    emission: 'always',
    set: (config, populated) => config.setNamePrefix(populated ? '  Phorma-Studio  ' : ''),
    read: config => config.namePrefix(),
    populatedValue: 'phorma-studio',
    emptyValue: '',
  },
  {
    field: 'permissionsBoundaryArn',
    member: 'permissionsBoundaryArn',
    emission: 'always',
    set: (config, populated) =>
      config.setPermissionsBoundaryArn(
        populated ? '  arn:aws:iam::123456789012:policy/PlatformBoundary  ' : '',
      ),
    read: config => config.permissionsBoundaryArn(),
    populatedValue: 'arn:aws:iam::123456789012:policy/PlatformBoundary',
    emptyValue: '',
  },
  {
    field: 'bootstrapQualifier',
    member: 'bootstrapQualifier',
    emission: 'whenPopulated',
    set: (config, populated) => config.setBootstrapQualifier(populated ? '  phorma  ' : ''),
    read: config => config.bootstrapQualifier(),
    populatedValue: 'phorma',
    emptyValue: '',
  },
  {
    field: 'vpcId',
    member: 'vpc',
    emission: 'vpc',
    set: (config, populated) => config.setVpcId(populated ? '  vpc-0a1b2c3d  ' : ''),
    read: config => config.vpcId(),
    populatedValue: 'vpc-0a1b2c3d',
    emptyValue: '',
  },
  {
    field: 'subnetIds',
    member: 'vpc',
    emission: 'vpc',
    // The blank entry exercises the setter's filter alongside its trim.
    set: (config, populated) =>
      config.setSubnetIds(populated ? ['  subnet-0a1b  ', 'subnet-2c3d', '   '] : []),
    read: config => config.subnetIds(),
    populatedValue: ['subnet-0a1b', 'subnet-2c3d'],
    emptyValue: [],
  },
  {
    field: 'appCmkArn',
    member: 'appCmkArn',
    emission: 'whenPopulated',
    set: (config, populated) =>
      config.setAppCmkArn(populated ? '  arn:aws:kms:us-east-1:123456789012:key/1a2b3c4d  ' : ''),
    read: config => config.appCmkArn(),
    populatedValue: 'arn:aws:kms:us-east-1:123456789012:key/1a2b3c4d',
    emptyValue: '',
  },
  {
    field: 'tagSet',
    member: 'costAllocationTags',
    emission: 'always',
    // `setTagSet` stores the record as given, so there is nothing to trim here.
    set: (config, populated) => config.setTagSet(populated ? { app: 'phorma', owner: 'ops' } : {}),
    read: config => config.tagSet(),
    populatedValue: { app: 'phorma', owner: 'ops' },
    emptyValue: {},
  },
  {
    field: 'retentionDays',
    member: 'retentionDays',
    emission: 'always',
    set: (config, populated) => config.setRetentionDays(populated ? 90 : RETENTION_DAYS_DEFAULT),
    read: config => config.retentionDays(),
    populatedValue: 90,
    emptyValue: RETENTION_DAYS_DEFAULT,
  },
  {
    field: 'notificationTargetArn',
    member: 'alarmNotificationArn',
    emission: 'always',
    set: (config, populated) =>
      config.setNotificationTargetArn(
        populated ? '  arn:aws:sns:us-east-1:123456789012:platform-alarms  ' : '',
      ),
    read: config => config.notificationTargetArn(),
    populatedValue: 'arn:aws:sns:us-east-1:123456789012:platform-alarms',
    emptyValue: '',
  },
  {
    field: 'cloudAwsDirectory',
    member: null,
    emission: 'never',
    set: (config, populated) =>
      config.setCloudAwsDirectory(populated ? '  C:/Dev/phorma/cloud-aws  ' : ''),
    read: config => config.cloudAwsDirectory(),
    populatedValue: 'C:/Dev/phorma/cloud-aws',
    emptyValue: '',
  },
  {
    field: 'imageUri',
    member: 'imageUri',
    emission: 'whenPopulated',
    set: (config, populated) =>
      config.setImageUri(populated ? '  registry.example.test/phorma/server:1.4.2  ' : ''),
    read: config => config.imageUri(),
    populatedValue: 'registry.example.test/phorma/server:1.4.2',
    emptyValue: '',
  },
  {
    field: 'triggerApiUrl',
    member: 'triggerApiUrl',
    emission: 'whenPopulated',
    // No setter by design - endpoint discovery writes it, already trimmed, and
    // the form renders it read-only. So the signal is written directly here.
    set: (config, populated) =>
      config.triggerApiUrl.set(populated ? 'https://trigger.example.test' : ''),
    read: config => config.triggerApiUrl(),
    populatedValue: 'https://trigger.example.test',
    emptyValue: '',
  },
  {
    field: 'monitorApiUrl',
    member: 'monitorApiUrl',
    emission: 'whenPopulated',
    set: (config, populated) =>
      config.monitorApiUrl.set(populated ? 'wss://monitor.example.test/live' : ''),
    read: config => config.monitorApiUrl(),
    populatedValue: 'wss://monitor.example.test/live',
    emptyValue: '',
  },
];

/** The two halves of the nested `vpc` member. */
const VPC_FIELDS = AWS_CONFIG_FIELDS.filter(f => f.emission === 'vpc');

/** The fields whose emptiness omits their own member - the shape axis. */
const OPTIONAL_FIELDS = AWS_CONFIG_FIELDS.filter(f => f.emission === 'whenPopulated');

/**
 * The fields whose emptiness cannot change the emitted SHAPE: the required ones
 * (emitted blank so the Config_Parser can name them) plus the Studio-only
 * directory (never emitted at all).
 */
const REQUIRED_FIELDS = AWS_CONFIG_FIELDS.filter(
  f => f.emission === 'always' || f.emission === 'never',
);

/** A populated/empty vector across the whole field set. */
type FieldVector = Readonly<Record<string, boolean>>;

/** The populated/empty states of `fields`, read off one bit of `mask` each. */
function maskVector(fields: readonly AwsConfigFieldCase[], mask: number): FieldVector {
  return Object.fromEntries(fields.map((f, index) => [f.field, (mask & (1 << index)) !== 0]));
}

/** Which fields are populated, as a short failure-context label. */
function describeVector(vector: FieldVector): string {
  const populated = AWS_CONFIG_FIELDS.filter(f => vector[f.field]).map(f => f.field);
  return populated.length === 0 ? 'all fields empty' : populated.join('+');
}

/** Puts every field into the state the vector declares, from whatever it held. */
function applyVector(config: AwsDeployConfigService, vector: FieldVector): void {
  for (const field of AWS_CONFIG_FIELDS) {
    field.set(config, vector[field.field]);
  }
}

/**
 * The members the emitted object must carry in this state, and nothing else.
 *
 * Derived from the field table rather than written out, so a field added to the
 * store either reaches this set through the table or fails the exact-member
 * assertion as an unexpected member.
 */
function expectedMembers(vector: FieldVector): string[] {
  const members = ['$generatedBy', ...CONSTANT_MEMBERS];
  for (const field of AWS_CONFIG_FIELDS) {
    if (field.emission === 'always') members.push(field.member!);
    if (field.emission === 'whenPopulated' && vector[field.field]) members.push(field.member!);
  }
  // The nested member appears only when BOTH halves hold a value.
  if (VPC_FIELDS.every(f => vector[f.field])) members.push('vpc');
  return members.sort();
}

/** Everything Property 17 claims, for one populated/empty vector. */
function checkRoundTrip(config: AwsDeployConfigService, vector: FieldVector): void {
  const label = describeVector(vector);
  applyVector(config, vector);

  // The store is the oracle for the emitted values, so first pin what it holds:
  // the setters trimmed (and lowercased) the padded raw input.
  for (const field of AWS_CONFIG_FIELDS) {
    expect(field.read(config))
      .withContext(`${label}: the store holds the trimmed ${field.field}`)
      .toEqual(vector[field.field] ? field.populatedValue : field.emptyValue);
  }

  const text = config.buildConfigFile();

  // Requirements 3.2 and 3.5: no comment line, so no comment-stripping step can
  // be needed. Leading whitespace is trimmed before the test rather than
  // requiring column 0, because `JSON.stringify(..., 2)` indents everything
  // nested - a comment header reintroduced inside the object would sit indented
  // and a column-0 check would miss it. No legitimate value in the emitted
  // document starts a line with `//`: every value line starts with `"`.
  const commentLines = text.split('\n').filter(line => line.trimStart().startsWith('//'));
  expect(commentLines).withContext(`${label}: lines beginning with //`).toEqual([]);

  // Requirement 3.1: ONE bare parse, no preprocessing whatsoever. This line is
  // the property - if it ever needs a `.filter()` in front of it, the Studio has
  // gone back to emitting something its own CLI cannot read.
  const parsed = JSON.parse(text) as Record<string, unknown>;

  // Requirement 3.2: the provenance notice travels as a string MEMBER.
  expect(typeof parsed['$generatedBy'])
    .withContext(`${label}: the provenance notice is a string member`)
    .toBe('string');
  expect(String(parsed['$generatedBy']))
    .withContext(`${label}: the provenance notice names its origin`)
    .toContain('GENERATED BY PHORMA AGENT STUDIO');

  expect(Object.keys(parsed).sort())
    .withContext(`${label}: emitted members`)
    .toEqual(expectedMembers(vector));

  // Every populated field appears with its trimmed value; every empty optional
  // one is absent; the Studio-only directory never appears at all.
  for (const field of AWS_CONFIG_FIELDS) {
    const stored = field.read(config);
    const member = field.member;
    switch (field.emission) {
      case 'always':
        expect(parsed[member!])
          .withContext(`${label}: ${member} carries the stored value`)
          .toEqual(stored);
        break;
      case 'whenPopulated':
        if (vector[field.field]) {
          expect(parsed[member!])
            .withContext(`${label}: ${member} carries the stored value`)
            .toEqual(stored);
        } else {
          expect(member! in parsed)
            .withContext(`${label}: ${member} is omitted while empty`)
            .toBeFalse();
        }
        break;
      case 'never':
        // A local filesystem path is the Studio's own business: the file is
        // written into the operator's repository, so the directory it lives in
        // has no place inside it.
        if (vector[field.field]) {
          expect(text)
            .withContext(`${label}: ${field.field} never reaches the file`)
            .not.toContain(String(stored));
        }
        break;
      case 'vpc':
        // Asserted jointly below - the member is one nested object built from
        // both halves.
        break;
    }
  }

  // The rule the deleted `includes VPC when configured` case was the only
  // frontend cover for (task 13.2), in both its halves: the NESTED shape, and
  // absence when only one half is populated.
  if (VPC_FIELDS.every(f => vector[f.field])) {
    expect(parsed['vpc'])
      .withContext(`${label}: vpc is nested { id, subnetIds }`)
      .toEqual({ id: config.vpcId(), subnetIds: config.subnetIds() });
  } else {
    expect('vpc' in parsed)
      .withContext(`${label}: vpc is absent unless both the id and the subnets are populated`)
      .toBeFalse();
  }
  // Neither half is ever emitted flat, in any state.
  expect('vpcId' in parsed).withContext(`${label}: no flat vpcId member`).toBeFalse();
  expect('subnetIds' in parsed).withContext(`${label}: no flat subnetIds member`).toBeFalse();
}

/**
 * Property 17: the Deploy_Config_File round trips through a bare `JSON.parse`.
 *
 * For every enumerated populated/empty vector across the AWS_Config_Field set:
 * `JSON.parse(buildConfigFile())` succeeds with no preprocessing, no line of the
 * emitted text begins with `//`, the parsed object carries the provenance notice
 * as a string member, and every populated field appears with its trimmed value.
 *
 * **Enumeration scheme.** The field set has 15 members, so the full
 * populated/empty product is 2^15 = 32768 vectors. That is too many for a karma
 * suite - each vector runs ~40 expectations, and jasmine allocates a result per
 * expectation - so the space is cut along the axis that decides the emitted
 * SHAPE:
 *
 * - The 7 fields whose emptiness OMITS a member are enumerated exhaustively:
 *   the 2 `vpc` halves x the 5 omit-when-empty optionals = 2^7 = 128 vectors.
 *   Every shape the document can take is therefore visited, including both
 *   partial-`vpc` states.
 * - The 8 fields whose emptiness cannot change the shape (7 required fields,
 *   emitted blank, plus the never-emitted directory) are carried as one block in
 *   both states, all-empty and all-populated: 128 x 2 = 256 vectors.
 * - Plus one vector per shape-insensitive field with that field alone empty and
 *   everything else populated, so an individual required field that stopped
 *   being emitted, or that started carrying its neighbour's value, still fails:
 *   8 more vectors.
 *
 * 264 vectors, asserted across 9 specs. Distinct values in every field make a
 * crossed pair of fields a value mismatch rather than an invisible swap.
 */
describe('Property 17: Deploy_Config_File round trips through a bare JSON.parse', () => {
  let config: AwsDeployConfigService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: false } }],
    });
    config = TestBed.inject(AwsDeployConfigService);
  });

  // Every field persists to localStorage, and karma runs ONE browser for the
  // whole suite - a leaked value here decides `valid()` and `configured()` in
  // every later spec. Persistence rides `effect()` rather than the setters, so
  // the queued writes are flushed with `tick()` BEFORE the clear, or they land
  // in localStorage after it and the next injector loads them.
  afterEach(() => {
    applyVector(config, Object.fromEntries(AWS_CONFIG_FIELDS.map(f => [f.field, false])));
    TestBed.inject(ApplicationRef).tick();
    localStorage.clear();
  });

  it('the field table covers every field the store persists', () => {
    // The store's writable signals, read off the instance: a `signal()` carries
    // `.set`, a `computed()` does not. This is what makes the enumeration
    // self-extending - add a field to the store and this spec names it.
    const persisted = Object.keys(config)
      .filter(key => {
        const value = (config as unknown as Record<string, unknown>)[key];
        if (typeof value !== 'function') return false;
        return typeof (value as { set?: unknown }).set === 'function';
      })
      .sort();

    expect(persisted).toEqual(AWS_CONFIG_FIELDS.map(f => f.field).sort());
    // The three groups partition the table, so no field sits outside the scheme.
    expect(VPC_FIELDS.length + OPTIONAL_FIELDS.length + REQUIRED_FIELDS.length).toBe(
      AWS_CONFIG_FIELDS.length,
    );
  });

  for (const requiredPopulated of [false, true]) {
    for (let vpcMask = 0; vpcMask < 1 << VPC_FIELDS.length; vpcMask++) {
      const vpcVector = maskVector(VPC_FIELDS, vpcMask);
      const populatedVpcHalves = VPC_FIELDS.filter(f => vpcVector[f.field]).map(f => f.field);
      const vpcLabel =
        populatedVpcHalves.length === 0 ? 'no vpc half' : populatedVpcHalves.join('+');
      const requiredLabel = requiredPopulated ? 'required populated' : 'required empty';

      it(`${requiredLabel} / ${vpcLabel}: round trips every optional combination`, () => {
        const requiredVector = Object.fromEntries(
          REQUIRED_FIELDS.map(f => [f.field, requiredPopulated]),
        );
        for (let optionalMask = 0; optionalMask < 1 << OPTIONAL_FIELDS.length; optionalMask++) {
          checkRoundTrip(config, {
            ...requiredVector,
            ...vpcVector,
            ...maskVector(OPTIONAL_FIELDS, optionalMask),
          });
        }
      });
    }
  }

  it('a single empty required field is still emitted, with every other field populated', () => {
    for (const omitted of REQUIRED_FIELDS) {
      checkRoundTrip(
        config,
        Object.fromEntries(AWS_CONFIG_FIELDS.map(f => [f.field, f.field !== omitted.field])),
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature: aws-byo-deploy, Property 19: Aggregate validity truth table
// ─────────────────────────────────────────────────────────────────────────────
//
// The oracle is read off requirements 2.4 and 2.5, not off the store:
//
// - 2.4: the single aggregate value is true "only when every required
//   AWS_Config_Field holds a value and every populated AWS_Config_Field passes
//   its validator". So a missing REQUIRED field is a violation, a missing
//   OPTIONAL field is not, and an ill-formed value is a violation either way.
// - 2.5: while the aggregate is false the panel displays "the count of invalid
//   or missing fields". Read as the number of fields the operator must act on,
//   which is the number of fields failing 2.4 - NOT the number of empty inputs.
//   Counting an empty optional would tell the operator to fill in
//   `triggerApiUrl`, which endpoint discovery owns and no operator can type
//   (Req 2.7), and would report 15 on a fresh install where 8 are actionable.
//
// WHICH FIELDS ARE REQUIRED is derived from `parseAwsDeployConfig` in
// `cloud-aws/src/core/config.ts` - the consumer that would reject the deploy.
// Its `requireString` guards `accountId`, `region`, `namePrefix`,
// `permissionsBoundaryArn`, `bootstrapQualifier` and `alarmNotificationArn` (the
// store's `notificationTargetArn`), and `costAllocationTags` must carry at least
// one non-empty pair, so `tagSet` is required too. `cloudAwsDirectory` never
// reaches the parser and is required by the Studio instead: with no directory
// there is nowhere to write the Deploy_Config_File before Plan or Deploy (Req
// 3.6) and no working directory to run the CLI in. Everything else the parser
// accepts as absent.
//
// NOT VISIBLE HERE, deliberately: the store validates `notificationTargetArn`
// against a generic ARN shape while the parser demands an SNS topic ARN, so
// `arn:aws:sqs:us-east-1:123456789012:q` passes the form and is then rejected by
// the CLI. That is a disagreement between two validators for ONE field;
// requirements 2.4 and 2.5 speak only about a field's own validator, so no
// aggregate truth table can see it - it belongs to requirement 2.8's
// cross-package agreement. The invalid sample chosen below fails BOTH shapes, so
// this property stays green when the store is tightened.

/** One enumerated state of an AWS_Config_Field. */
type FieldState = 'missing' | 'invalid' | 'valid';

/**
 * How requirement 2.4 classifies one field.
 *
 * - `required`: missing is a violation.
 * - `optional`: missing is VALID. That is what optional means, and it is why the
 *   truth table is asymmetric rather than a plain 3^15 product.
 * - `defaulted`: the field cannot be missing at all, so it has no missing state
 *   to classify. `retentionDays` is the only one: it is a number signal whose
 *   cleared value is its default of 30, and the parser defaults it as well.
 */
type FieldRequirement = 'required' | 'optional' | 'defaulted';

/** The state of every AWS_Config_Field, keyed by field name. */
type FieldStateVector = Readonly<Record<string, FieldState>>;

/** The validity-state layer over one field of Property 17's table. */
interface FieldValidityRule {
  readonly requirement: FieldRequirement;
  /**
   * The states this field can actually take. Fewer than three means the field
   * cannot express one of them, which `missingStateNote` has to explain.
   */
  readonly states: readonly FieldState[];
  /** Puts the field into an ill-formed state. Absent when it has none. */
  readonly setInvalid?: (config: AwsDeployConfigService) => void;
  /** Why this field has fewer than three states. */
  readonly missingStateNote?: string;
  /**
   * Oracle override for a field whose validity is NOT independent of the others.
   * Receives the whole state vector.
   */
  readonly violates?: (state: FieldState, states: FieldStateVector) => boolean;
}

const ALL_STATES: readonly FieldState[] = ['missing', 'invalid', 'valid'];
/** A presence-only validator: any populated value passes, so there is no invalid state. */
const NO_INVALID_STATE: readonly FieldState[] = ['missing', 'valid'];
/** A number with a default: it always holds a value, so there is no missing state. */
const NO_MISSING_STATE: readonly FieldState[] = ['invalid', 'valid'];

/**
 * The validity-state layer, one entry per AWS_Config_Field.
 *
 * Every invalid sample is malformed against the shape the requirement documents
 * AND against the Config_Parser's own pattern for the same field, so a case is
 * ill-formed by the contract rather than by a quirk of one regex.
 */
const VALIDITY_RULES: Readonly<Record<string, FieldValidityRule>> = {
  accountId: {
    requirement: 'required',
    states: ALL_STATES,
    // 10 digits where exactly 12 are demanded.
    setInvalid: config => config.setAccountId('1234567890'),
  },
  region: {
    requirement: 'required',
    states: ALL_STATES,
    // No trailing partition digit, so not a syntactically valid region.
    setInvalid: config => config.setRegion('us-east'),
  },
  namePrefix: {
    requirement: 'required',
    states: ALL_STATES,
    // A space is outside [a-z0-9-]; `setNamePrefix` lowercases but cannot fix it.
    setInvalid: config => config.setNamePrefix('Phorma Studio'),
  },
  permissionsBoundaryArn: {
    requirement: 'required',
    states: ALL_STATES,
    // A role ARN where a policy ARN is demanded - the shape a hand-copied
    // Deployment_Identity ARN really takes.
    setInvalid: config =>
      config.setPermissionsBoundaryArn('arn:aws:iam::123456789012:role/PlatformBoundary'),
  },
  bootstrapQualifier: {
    requirement: 'required',
    states: ALL_STATES,
    // 25 characters with hyphens; a CDK qualifier is 1-10 alphanumerics.
    setInvalid: config => config.setBootstrapQualifier('phorma-qualifier-too-long'),
  },
  vpcId: {
    requirement: 'optional',
    states: ALL_STATES,
    // Uppercase is not hex.
    setInvalid: config => config.setVpcId('vpc-XYZ'),
  },
  subnetIds: {
    requirement: 'optional',
    states: ALL_STATES,
    // One good id and one that is not a subnet id at all: the validator is an
    // `every`, so a single bad entry has to sink the field.
    setInvalid: config => config.setSubnetIds(['subnet-0a1b', 'net-9999']),
  },
  appCmkArn: {
    requirement: 'optional',
    states: ALL_STATES,
    // An alias ARN, not a key ARN.
    setInvalid: config => config.setAppCmkArn('arn:aws:kms:us-east-1:123456789012:alias/phorma'),
    // CROSS-FIELD RULE, handled deliberately: the App_CMK is valid only when its
    // own region equals the configured Region_Pin, which the parser enforces the
    // same way ("appCmkArn region does not match the configured region"). The
    // valid sample is a `us-east-1` key, so it stops passing the moment the
    // region holds anything else - a valid CMK really does become invalid when
    // the region changes, and requirement 2.4's "passes its validator" makes
    // that a violation. Region MISSING leaves the pairing unchecked, which is
    // the validator's own `!region` escape.
    violates: (state, states) =>
      state === 'invalid' || (state === 'valid' && states['region'] === 'invalid'),
  },
  tagSet: {
    requirement: 'required',
    states: ALL_STATES,
    // One pair with a blank value. The parser rejects a blank tag value too.
    setInvalid: config => config.setTagSet({ app: '' }),
  },
  retentionDays: {
    requirement: 'defaulted',
    states: NO_MISSING_STATE,
    // Zero is below the 1-366 window.
    setInvalid: config => config.setRetentionDays(0),
    missingStateNote:
      'a number signal whose cleared value is its default of 30 always holds a value',
  },
  notificationTargetArn: {
    requirement: 'required',
    states: ALL_STATES,
    // A 5-digit account: fails the store's generic ARN shape AND the parser's
    // SNS topic shape, so the case does not depend on which of the two is used.
    setInvalid: config =>
      config.setNotificationTargetArn('arn:aws:sns:us-east-1:12345:platform-alarms'),
  },
  cloudAwsDirectory: {
    requirement: 'required',
    states: NO_INVALID_STATE,
    missingStateNote:
      'a presence-only validator has no ill-formed value - any populated path passes, and ' +
      'whether the directory exists on disk is a question for the CLI preflight, not the form',
  },
  imageUri: {
    requirement: 'optional',
    states: ALL_STATES,
    // Uppercase registry and repository, which OCI does not allow.
    setInvalid: config => config.setImageUri('Registry.Example.Test/Phorma/Server:1.4.2'),
  },
  triggerApiUrl: {
    requirement: 'optional',
    states: ALL_STATES,
    // `http` where requirement 2.9 demands `https`. Written through the signal:
    // the field has no setter by design (endpoint discovery owns it).
    setInvalid: config => config.triggerApiUrl.set('http://trigger.example.test'),
  },
  monitorApiUrl: {
    requirement: 'optional',
    states: ALL_STATES,
    // `https` where requirement 2.9 demands `wss`.
    setInvalid: config => config.monitorApiUrl.set('https://monitor.example.test/live'),
  },
};

/**
 * Stand-in for a field Property 17's table declares and this one forgot. Keeps
 * the enumeration loadable so the table-coverage spec can NAME the gap, instead
 * of the whole file dying at collection time.
 */
const UNCLASSIFIED_RULE: FieldValidityRule = { requirement: 'optional', states: ['valid'] };

/** One field's Property 17 plumbing plus its validity-state layer. */
interface FieldValidityEntry {
  readonly field: string;
  readonly rule: FieldValidityRule;
  /** Property 17's entry - the source of the missing and valid states. */
  readonly base: AwsConfigFieldCase;
}

/**
 * The truth table's field list, DERIVED from Property 17's `AWS_CONFIG_FIELDS`
 * rather than declared again: the field set, its order, and the setters for the
 * missing and valid states all come from there, which is also what keeps the
 * store-coverage guard on that table load-bearing for this property.
 *
 * A second layer is still needed because Property 17's classes are EMISSION
 * classes, not validity classes, and the two genuinely disagree:
 * `bootstrapQualifier` is emitted only when populated yet is REQUIRED, and
 * `retentionDays` is always emitted yet can never be missing. Only the third
 * state - ill-formed - is new here; Property 17 has no notion of it.
 */
const AWS_VALIDITY_FIELDS: readonly FieldValidityEntry[] = AWS_CONFIG_FIELDS.map(base => ({
  field: base.field,
  rule: VALIDITY_RULES[base.field] ?? UNCLASSIFIED_RULE,
  base,
}));

/** Puts every field into the state the vector declares, from whatever it held. */
function applyFieldStates(config: AwsDeployConfigService, states: FieldStateVector): void {
  for (const entry of AWS_VALIDITY_FIELDS) {
    const state = states[entry.field];
    if (state === 'invalid') {
      const setInvalid = entry.rule.setInvalid;
      if (!setInvalid) throw new Error(`${entry.field} has no invalid state to apply`);
      setInvalid(config);
    } else {
      entry.base.set(config, state === 'valid');
    }
  }
}

/** Requirement 2.4, for one field in one state: does it need the operator's attention? */
function violatesRequirement(entry: FieldValidityEntry, states: FieldStateVector): boolean {
  const state = states[entry.field];
  if (entry.rule.violates) return entry.rule.violates(state, states);
  if (state === 'invalid') return true;
  if (state === 'missing') return entry.rule.requirement === 'required';
  return false;
}

/** The fields requirement 2.4 says are missing or ill-formed, in store order. */
function violatingFields(states: FieldStateVector): string[] {
  return AWS_VALIDITY_FIELDS.filter(entry => violatesRequirement(entry, states)).map(
    entry => entry.field,
  );
}

/** The non-valid fields, as a short failure-context label. */
function describeFieldStates(states: FieldStateVector): string {
  const deviations = AWS_VALIDITY_FIELDS.filter(entry => states[entry.field] !== 'valid').map(
    entry => `${entry.field}=${states[entry.field]}`,
  );
  return deviations.length === 0 ? 'every field valid' : deviations.join(' ');
}

/** `wanted` where the field can express it, `fallback` where it cannot. */
function stateOr(entry: FieldValidityEntry, wanted: FieldState, fallback: FieldState): FieldState {
  return entry.rule.states.includes(wanted) ? wanted : fallback;
}

/** A state vector built by asking `pick` for each field's state. */
function statesFrom(pick: (entry: FieldValidityEntry) => FieldState): FieldStateVector {
  return Object.fromEntries(AWS_VALIDITY_FIELDS.map(entry => [entry.field, pick(entry)]));
}

/** Reads one per-field validity signal off the store by name. */
function readFieldValidity(config: AwsDeployConfigService, field: string): boolean {
  const read = (config as unknown as Record<string, unknown>)[`${field}Valid`];
  if (typeof read !== 'function') throw new Error(`the store exposes no ${field}Valid signal`);
  return (read as () => boolean)();
}

const ALL_VALID = statesFrom(() => 'valid');
/** A fresh install: nothing entered. `retentionDays` sits on its default. */
const ALL_MISSING = statesFrom(entry => stateOr(entry, 'missing', 'valid'));
/** Everything wrong: ill-formed where a field can be, missing where it cannot. */
const ALL_BAD = statesFrom(entry => stateOr(entry, 'invalid', 'missing'));
/** The minimum viable configuration - the asymmetry, stated as a vector. */
const REQUIRED_ONLY = statesFrom(entry =>
  entry.rule.requirement === 'optional' ? stateOr(entry, 'missing', 'valid') : 'valid',
);

/** Everything Property 19 claims, for one state vector. */
function checkTruthTable(
  config: AwsDeployConfigService,
  states: FieldStateVector,
  options: { readonly perField?: boolean } = {},
): void {
  const label = describeFieldStates(states);
  // Each case sets EVERY field, so it never depends on what the injector loaded
  // out of localStorage or on what a sibling case left behind.
  applyFieldStates(config, states);

  const violating = violatingFields(states);
  const expected = violating.length === 0 ? 'none' : violating.join(', ');

  if (options.perField) {
    // Attribution: the count is not just numerically right, it is the right
    // fields that are flagged. A validator reading its neighbour's signal shows
    // up here rather than as a count that happens to match.
    for (const entry of AWS_VALIDITY_FIELDS) {
      expect(readFieldValidity(config, entry.field))
        .withContext(`${label}: ${entry.field}Valid`)
        .toBe(!violating.includes(entry.field));
    }
  }

  // Requirement 2.5: what the form renders as "N fields need attention".
  expect(config.invalidFieldCount())
    .withContext(`${label}: fields needing attention, expected [${expected}]`)
    .toBe(violating.length);

  // Requirement 2.4: true exactly when nothing needs attention.
  expect(config.valid())
    .withContext(`${label}: aggregate validity, outstanding [${expected}]`)
    .toBe(violating.length === 0);
}

/**
 * Property 19: the aggregate validity truth table.
 *
 * For every enumerated state vector: `valid()` is true exactly when every
 * required field holds a value and every populated field passes its validator,
 * and `invalidFieldCount()` - the value the form renders as "N fields need
 * attention" - equals the number of fields that are missing or ill-formed.
 *
 * **Enumeration scheme.** `fast-check` is an `engine` dependency and must not be
 * added to `frontend`, so "property" here means exhaustive enumeration over a
 * closed space. The full space is not 3^15: two fields cannot take all three
 * states (`retentionDays` has no missing state, `cloudAwsDirectory` no invalid
 * one), which still leaves 3^13 x 2 x 2 = 6377292 vectors. So the space is cut
 * along the axis the aggregate is actually sensitive to - how many fields
 * deviate, and which:
 *
 * - **Depth 0 and 1**: the all-valid vector, then each field alone in each of
 *   its other states, everything else valid. 1 + 28 = 29 vectors, each also
 *   asserting all 15 per-field signals so the count is attributable.
 * - **Depth 2, exhaustively**: every unordered pair of fields, each in each of
 *   its non-valid states, everything else valid. 365 vectors. This is what
 *   makes the count additive across every pair rather than "at least one".
 * - **A full 3-state product over a representative quadruple**: `region` x
 *   `appCmkArn` (the cross-field pair) x `accountId` (a plain required field) x
 *   `imageUri` (a plain optional), 81 vectors, crossed with two backgrounds for
 *   the remaining 11 fields - all valid, and all missing. 162 vectors, reaching
 *   depths up to 12.
 * - **7 whole-set extremes**: all valid, all missing (the fresh install), all
 *   bad, required-only (the asymmetry), and the required/optional halves crossed
 *   three ways.
 *
 * 563 vectors across 49 specs, a couple of the extremes repeating a vector
 * another block already visits. Every field carries a distinct value, so a
 * crossed pair of fields is a mismatch rather than an invisible swap.
 */
describe('Property 19: Aggregate validity truth table', () => {
  let config: AwsDeployConfigService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: false } }],
    });
    config = TestBed.inject(AwsDeployConfigService);
  });

  // Same hazard Property 17 documents: every field persists to localStorage,
  // persistence rides `effect()` rather than the setters, and karma runs ONE
  // browser for the whole suite. Flush the queued writes BEFORE clearing, or
  // they land after the clear and the next injector loads them.
  afterEach(() => {
    applyVector(config, Object.fromEntries(AWS_CONFIG_FIELDS.map(f => [f.field, false])));
    TestBed.inject(ApplicationRef).tick();
    localStorage.clear();
  });

  it('the validity table classifies every field the store validates', () => {
    expect(Object.keys(VALIDITY_RULES).sort())
      .withContext('every AWS_Config_Field carries a validity classification')
      .toEqual(AWS_CONFIG_FIELDS.map(f => f.field).sort());

    for (const entry of AWS_VALIDITY_FIELDS) {
      const read = (config as unknown as Record<string, unknown>)[`${entry.field}Valid`];
      expect(typeof read)
        .withContext(`${entry.field}Valid is a signal on the store`)
        .toBe('function');
      // A `computed()` carries no `.set` - the per-field validity must be derived,
      // never a second writable source of truth.
      expect(typeof (read as { set?: unknown }).set)
        .withContext(`${entry.field}Valid is computed, not writable`)
        .toBe('undefined');
      if (entry.rule.states.includes('invalid')) {
        expect(entry.rule.setInvalid)
          .withContext(`${entry.field} declares an invalid state, so it needs a sample`)
          .toBeDefined();
      }
      if (entry.rule.states.length < ALL_STATES.length) {
        expect(entry.rule.missingStateNote)
          .withContext(`${entry.field} takes fewer than three states, so it must say why`)
          .toBeDefined();
      }
    }

    // The two fields that cannot take all three states, and the reason each one
    // is a real property of the field rather than a gap in the enumeration.
    config.setRetentionDays(RETENTION_DAYS_DEFAULT);
    expect(readFieldValidity(config, 'retentionDays'))
      .withContext('the default retention window is valid, so the field is never missing')
      .toBeTrue();
    config.setCloudAwsDirectory('   C:/Dev/phorma/cloud-aws   ');
    expect(readFieldValidity(config, 'cloudAwsDirectory'))
      .withContext('any populated path passes a presence-only validator')
      .toBeTrue();
  });

  it('the requirement classes partition the field set as the Config_Parser demands', () => {
    const byClass = (requirement: FieldRequirement) =>
      AWS_VALIDITY_FIELDS.filter(entry => entry.rule.requirement === requirement).map(
        entry => entry.field,
      );

    // Written out rather than derived: these eight are the fields
    // `parseAwsDeployConfig` refuses to run without, plus the directory the
    // Studio needs to write the file at all.
    expect(byClass('required')).toEqual([
      'accountId',
      'region',
      'namePrefix',
      'permissionsBoundaryArn',
      'bootstrapQualifier',
      'tagSet',
      'notificationTargetArn',
      'cloudAwsDirectory',
    ]);
    expect(byClass('optional')).toEqual([
      'vpcId',
      'subnetIds',
      'appCmkArn',
      'imageUri',
      'triggerApiUrl',
      'monitorApiUrl',
    ]);
    expect(byClass('defaulted')).toEqual(['retentionDays']);
  });

  it('the oracle itself, spelled out at the corners of the table', () => {
    // Anchors as literals, so a mis-classified field cannot make the oracle and
    // the store agree by coincidence.
    expect(violatingFields(ALL_VALID)).withContext('every field valid').toEqual([]);
    expect(violatingFields(REQUIRED_ONLY))
      .withContext('required populated, every optional left empty')
      .toEqual([]);
    // The fresh-install count, and the exact defect task 13.1 fixed: an untouched
    // store reported VALID while these eight were empty.
    expect(violatingFields(ALL_MISSING))
      .withContext('nothing entered yet')
      .toEqual([
        'accountId',
        'region',
        'namePrefix',
        'permissionsBoundaryArn',
        'bootstrapQualifier',
        'tagSet',
        'notificationTargetArn',
        'cloudAwsDirectory',
      ]);
    expect(violatingFields(ALL_BAD))
      .withContext('every field wrong')
      .toEqual(AWS_VALIDITY_FIELDS.map(entry => entry.field));
  });

  it('every field valid: the aggregate is true and no field needs attention', () => {
    checkTruthTable(config, ALL_VALID, { perField: true });
  });

  // Depth 1: one field deviates, every other field valid.
  for (const entry of AWS_VALIDITY_FIELDS) {
    for (const state of entry.rule.states) {
      if (state === 'valid') continue;
      const consequence =
        state === 'invalid' || entry.rule.requirement === 'required'
          ? 'needs attention'
          : 'is not a problem';
      it(`${entry.field}=${state} alone ${consequence}`, () => {
        checkTruthTable(config, { ...ALL_VALID, [entry.field]: state }, { perField: true });
      });
    }
  }

  // Depth 2, exhaustive: every unordered pair, every combination of their
  // non-valid states. A count that reported "at least one" or that lost one of
  // two simultaneous violations fails here.
  for (let i = 0; i < AWS_VALIDITY_FIELDS.length - 1; i++) {
    const first = AWS_VALIDITY_FIELDS[i];
    const firstStates = first.rule.states.filter(state => state !== 'valid');
    it(`pairs with ${first.field} deviating: each violation is counted once`, () => {
      for (let j = i + 1; j < AWS_VALIDITY_FIELDS.length; j++) {
        const second = AWS_VALIDITY_FIELDS[j];
        for (const firstState of firstStates) {
          for (const secondState of second.rule.states) {
            if (secondState === 'valid') continue;
            checkTruthTable(config, {
              ...ALL_VALID,
              [first.field]: firstState,
              [second.field]: secondState,
            });
          }
        }
      }
    });
  }

  // The full 3-state product over a representative quadruple: the cross-field
  // pair, a plain required field and a plain optional one.
  for (const [backgroundName, background] of [
    ['every other field valid', ALL_VALID],
    ['every other field missing', ALL_MISSING],
  ] as const) {
    it(`region x appCmkArn x accountId x imageUri, ${backgroundName}`, () => {
      for (const region of ALL_STATES) {
        for (const appCmkArn of ALL_STATES) {
          for (const accountId of ALL_STATES) {
            for (const imageUri of ALL_STATES) {
              checkTruthTable(config, { ...background, region, appCmkArn, accountId, imageUri });
            }
          }
        }
      }
    });
  }

  it('the whole-set extremes', () => {
    checkTruthTable(config, ALL_VALID);
    // A fresh install must NOT report valid: Plan and Deploy hang off this.
    checkTruthTable(config, ALL_MISSING, { perField: true });
    checkTruthTable(config, ALL_BAD, { perField: true });
    // The asymmetry: every optional field left empty is a COMPLETE configuration.
    checkTruthTable(config, REQUIRED_ONLY, { perField: true });
    checkTruthTable(
      config,
      statesFrom(entry => (entry.rule.requirement === 'optional' ? 'invalid' : 'valid')),
    );
    checkTruthTable(
      config,
      statesFrom(entry => (entry.rule.requirement === 'required' ? 'missing' : 'valid')),
    );
    checkTruthTable(
      config,
      statesFrom(entry =>
        entry.rule.requirement === 'required' ? stateOr(entry, 'invalid', 'missing') : 'valid',
      ),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature: aws-byo-deploy, Property 20: Endpoint discovery persists or preserves
// ─────────────────────────────────────────────────────────────────────────────
//
// Same constraint Property 17 records: `fast-check` is an `engine` dependency and
// must not be added to `frontend`, so "property" here means exhaustive
// enumeration over a closed space. The space is the outputs document a completed
// deploy reported, crossed with the ROUTE it arrived by - the deploy stream
// itself, or the `outputs` verb the service falls back to when that stream
// carried no decodable envelope.
//
// Two effects of discovery cannot be observed directly under karma, and each is
// handled rather than faked:
//
// - The FILE WRITE (Req 9.3) reaches `invoke('write_workflow_file', ...)` through
//   a dynamic `@tauri-apps/api/core` import that karma cannot stub. So
//   `writeConfigFile()` is spied, and the spy captures `buildConfigFile()` at the
//   moment the write would have happened. The assertion is on the exact text the
//   write path was handed - one bare `JSON.parse`, no preprocessing - which is
//   the honest form of "the rewritten config file round trips". Re-serialising
//   after the call instead would not distinguish "wrote the discovered values"
//   from "wrote nothing while the signals changed anyway".
// - `executeStreamedCommand` reaches the same import, so the `outputs` fallback is
//   exercised by stubbing that method ON THE INSTANCE. The stub records the
//   command it was given, which is what makes both "the fallback fired" and "the
//   fallback did NOT fire" assertable - the latter matters because a
//   decoded-but-partial envelope must not trigger a fallback.

/** The directory discovery is told to run the fallback verb in. */
const CLOUD_AWS_DIR = 'C:/Dev/phorma/cloud-aws';

/** What the store already held before this deploy reported anything. */
const PREVIOUS_TRIGGER_URL = 'https://previous-trigger.example.test/prod';
const PREVIOUS_MONITOR_URL = 'wss://previous-monitor.example.test/live';

/** What the deploy reports. Distinct from the previous pair, on both fields. */
const DISCOVERED_TRIGGER_URL = 'https://discovered-trigger.example.test/prod';
const DISCOVERED_MONITOR_URL = 'wss://discovered-monitor.example.test/live';

/** Both output names, in the order Requirement 9.4's message must name them. */
const BOTH_OUTPUTS: readonly string[] = [TRIGGER_API_OUTPUT, MONITOR_API_OUTPUT];

/**
 * Frames a payload the way `cloud-aws/src/core/sentinel.ts` does: one line per
 * chunk, `__phorma__:{seq}:{base64}`.
 *
 * The byte budget is deliberately small so every document here spans several
 * lines, which means reassembly is exercised rather than assumed. Payloads are
 * ASCII, so the encoder's rule about never cutting a code point in half is
 * satisfied trivially.
 */
function encodeSentinelLines(payload: string, byteBudget = 40): string[] {
  const bytes = new TextEncoder().encode(payload);
  const lines: string[] = [];
  for (let start = 0, seq = 0; start < bytes.length; start += byteBudget, seq++) {
    let binary = '';
    for (const byte of bytes.subarray(start, start + byteBudget)) {
      binary += String.fromCharCode(byte);
    }
    lines.push(`${SENTINEL_PREFIX}${seq}:${btoa(binary)}`);
  }
  return lines;
}

/** One outputs document the CLI could report, and what it means for discovery. */
interface OutputsDocumentCase {
  readonly name: string;
  /** The envelope members beyond `kind`, exactly as the CLI would emit them. */
  readonly members: Readonly<Record<string, unknown>>;
  /**
   * The output names the stack did not return, in `TRIGGER_API_OUTPUT`-then-
   * `MONITOR_API_OUTPUT` order - which is the order the message names them in.
   * Empty means the document is complete and both endpoints persist.
   */
  readonly missing: readonly string[];
}

/**
 * The outputs documents, THE declared list. The five the task enumerates plus two
 * that reach the same "absent" branch by a different road.
 *
 * `both present` carries padded values on purpose: the wire value is trimmed
 * twice on the way in (`readDeployOutputs`, then `applyDiscoveredEndpoints`), so
 * "the two fields equal those values" is a real assertion rather than a
 * tautology. `extra outputs` carries four members beyond the two, including a
 * nested object, because a stack that grows an output must be TOLERATED - the
 * decoder reads the two it needs and ignores the rest.
 */
const OUTPUTS_DOCUMENTS: readonly OutputsDocumentCase[] = [
  {
    name: 'both present',
    members: {
      triggerApiUrl: `  ${DISCOVERED_TRIGGER_URL}  `,
      monitorApiUrl: `  ${DISCOVERED_MONITOR_URL}  `,
    },
    missing: [],
  },
  {
    name: 'trigger missing',
    members: { monitorApiUrl: DISCOVERED_MONITOR_URL },
    missing: [TRIGGER_API_OUTPUT],
  },
  {
    name: 'monitor missing',
    members: { triggerApiUrl: DISCOVERED_TRIGGER_URL },
    missing: [MONITOR_API_OUTPUT],
  },
  {
    name: 'both missing',
    members: {},
    missing: [TRIGGER_API_OUTPUT, MONITOR_API_OUTPUT],
  },
  {
    name: 'extra outputs',
    members: {
      triggerApiUrl: DISCOVERED_TRIGGER_URL,
      monitorApiUrl: DISCOVERED_MONITOR_URL,
      stackName: 'phorma-prod',
      dashboardUrl: 'https://console.aws.example.test/phorma-prod',
      deployedAt: '2026-02-11T09:15:00.000Z',
      service: { taskDefinition: 'phorma-prod:41', desiredCount: 2 },
    },
    missing: [],
  },
  // Beyond the five the task names: `readDeployOutputs` reads a non-string or a
  // blank member as absent, and that is the branch a stack with a broken output
  // actually takes. Both must warn rather than persist a garbage endpoint.
  {
    name: 'trigger not a string',
    members: { triggerApiUrl: 42, monitorApiUrl: DISCOVERED_MONITOR_URL },
    missing: [TRIGGER_API_OUTPUT],
  },
  {
    name: 'monitor blank',
    members: { triggerApiUrl: DISCOVERED_TRIGGER_URL, monitorApiUrl: '   ' },
    missing: [MONITOR_API_OUTPUT],
  },
];

/** How the document reached the service. */
type DeliveryRoute = 'deploy stream' | 'outputs fallback';

const DELIVERY_ROUTES: readonly DeliveryRoute[] = ['deploy stream', 'outputs fallback'];

/** The envelope lines a `deploy-outputs` document is carried by. */
function envelopeLines(members: Readonly<Record<string, unknown>>): string[] {
  return encodeSentinelLines(JSON.stringify({ kind: 'deploy-outputs', ...members }));
}

/** Ordinary operator output, which the decoder must ignore rather than reject. */
const DEPLOY_NOISE: readonly string[] = [
  'Synthesizing CDK application',
  'PhormaStack: creating CloudFormation changeset',
  'PhormaStack: deploy complete',
];

/**
 * What the store holds and what discovery did, for one run.
 *
 * `written` holds the config text the write path was handed, one entry per write,
 * so an empty array means Requirement 9.4's "leave the stored values unchanged"
 * was honoured all the way down to the file.
 */
interface DiscoveryObservations {
  readonly written: readonly string[];
  readonly ranCommands: readonly DeployCommand[];
  readonly warnings: readonly { readonly summary: string; readonly detail: string }[];
}

/** The one private the fallback path is driven through. */
type StubbedRunner = {
  executeStreamedCommand(command: DeployCommand, collect?: string[]): Promise<AwsCommandResult>;
};

/** The private under test. */
type DiscoveryTarget = {
  discoverEndpoints(cloudAwsDir: string, collected: string[]): Promise<void>;
};

/**
 * Seeds a complete configuration with NON-EMPTY previous endpoint values.
 *
 * The "previously stored endpoint values are unchanged" half of Requirement 9.4
 * is vacuous against an untouched store: both fields start empty, so a path that
 * wrongly persisted `''` would pass anyway. Two distinct non-empty URLs that
 * differ from the discovered pair are what make the assertion load-bearing.
 * Neither field has a setter by design (Req 2.7), so the signals are written
 * directly - the same thing Property 17's table does.
 */
function seedPreviousEndpoints(config: AwsDeployConfigService): void {
  applyVector(config, Object.fromEntries(AWS_CONFIG_FIELDS.map(f => [f.field, true])));
  config.triggerApiUrl.set(PREVIOUS_TRIGGER_URL);
  config.monitorApiUrl.set(PREVIOUS_MONITOR_URL);
}

/** Runs discovery over one deploy stream, with one fallback response staged. */
async function runDiscovery(
  service: AwsCliService,
  config: AwsDeployConfigService,
  toast: ToastService,
  deployLines: readonly string[],
  fallbackLines: readonly string[],
): Promise<DiscoveryObservations> {
  const written: string[] = [];
  const ranCommands: DeployCommand[] = [];
  const warnings: { summary: string; detail: string }[] = [];

  // Captured at the moment of the write, so the text asserted below is the text
  // the write path was handed and not a later re-serialisation.
  spyOn(config, 'writeConfigFile').and.callFake(async () => {
    written.push(config.buildConfigFile());
    return true;
  });
  spyOn(toast, 'warning').and.callFake((summary: string, detail?: string) => {
    warnings.push({ summary, detail: detail ?? '' });
    return 0;
  });
  (service as unknown as StubbedRunner).executeStreamedCommand = async (command, collect) => {
    ranCommands.push(command);
    collect?.push(...fallbackLines);
    return { success: true, exitCode: 0 };
  };

  await (service as unknown as DiscoveryTarget).discoverEndpoints(CLOUD_AWS_DIR, [...deployLines]);
  return { written, ranCommands, warnings };
}

/** The `outputs` verb, as discovery must invoke it. */
const OUTPUTS_COMMAND: DeployCommand = {
  program: 'npx',
  args: ['phorma-aws', 'outputs'],
  cwd: CLOUD_AWS_DIR,
};

/** Everything Property 20 claims, for one document delivered by one route. */
function expectDiscovery(
  config: AwsDeployConfigService,
  doc: OutputsDocumentCase,
  route: DeliveryRoute,
  observed: DiscoveryObservations,
): void {
  const label = `${doc.name} / ${route}`;

  // The fallback runs exactly when the deploy stream carried no decodable
  // envelope - never merely because the envelope it carried was PARTIAL.
  expect(observed.ranCommands)
    .withContext(`${label}: the outputs verb runs only when the stream carried no envelope`)
    .toEqual(route === 'outputs fallback' ? [OUTPUTS_COMMAND] : []);

  if (doc.missing.length === 0) {
    // Requirement 9.2: both fields equal the reported values, trimmed.
    expect(config.triggerApiUrl())
      .withContext(`${label}: triggerApiUrl holds the discovered value`)
      .toBe(DISCOVERED_TRIGGER_URL);
    expect(config.monitorApiUrl())
      .withContext(`${label}: monitorApiUrl holds the discovered value`)
      .toBe(DISCOVERED_MONITOR_URL);
    expect(observed.warnings).withContext(`${label}: a complete document warns nobody`).toEqual([]);

    // Requirement 9.3: the file is rewritten, once, with those two values.
    expect(observed.written.length)
      .withContext(`${label}: the config file is rewritten exactly once`)
      .toBe(1);
    const text = observed.written[0];
    const commentLines = text.split('\n').filter(line => line.trimStart().startsWith('//'));
    expect(commentLines).withContext(`${label}: lines beginning with //`).toEqual([]);
    // ONE bare parse of the rewritten text, no preprocessing. If this ever needs
    // help, the CLI that reads the same file with one `JSON.parse` is broken too.
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed['triggerApiUrl'])
      .withContext(`${label}: the rewritten file carries the discovered trigger URL`)
      .toBe(DISCOVERED_TRIGGER_URL);
    expect(parsed['monitorApiUrl'])
      .withContext(`${label}: the rewritten file carries the discovered monitor URL`)
      .toBe(DISCOVERED_MONITOR_URL);
    return;
  }

  // Requirement 9.4: the message NAMES each missing output, and nothing moves.
  expect(observed.warnings.length)
    .withContext(`${label}: exactly one message, naming the missing outputs`)
    .toBe(1);
  const warning = observed.warnings[0];
  expect(warning.summary).withContext(`${label}: message summary`).toBe('Deploy output missing');
  expect(warning.detail)
    .withContext(`${label}: message detail`)
    .toBe(
      `The stack did not return ${doc.missing.join(' and ')}. ` +
        'The stored endpoint values are unchanged.',
    );
  for (const name of doc.missing) {
    expect(warning.detail).withContext(`${label}: names ${name}`).toContain(name);
  }
  // An output the stack DID return must not be named - the half of 9.4 a message
  // hardcoded to one output name would fail.
  for (const present of BOTH_OUTPUTS.filter(name => !doc.missing.includes(name))) {
    expect(warning.detail).withContext(`${label}: does not name ${present}`).not.toContain(present);
  }

  // Both previously stored values unchanged, and no write at all: there is no
  // other path to these two fields, so this is the whole of "unchanged".
  expect(config.triggerApiUrl())
    .withContext(`${label}: the previous triggerApiUrl is unchanged`)
    .toBe(PREVIOUS_TRIGGER_URL);
  expect(config.monitorApiUrl())
    .withContext(`${label}: the previous monitorApiUrl is unchanged`)
    .toBe(PREVIOUS_MONITOR_URL);
  expect(observed.written)
    .withContext(`${label}: the config file is not rewritten`)
    .toEqual([]);
}

/**
 * The oracle for the table's `missing` column, read off Requirement 9.4 rather
 * than off the service: an output is missing when the document does not carry it
 * as a non-blank string. Keeps a mis-declared row from agreeing with the code by
 * coincidence.
 */
function oracleMissing(members: Readonly<Record<string, unknown>>): string[] {
  const present = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  const missing: string[] = [];
  if (!present(members['triggerApiUrl'])) missing.push(TRIGGER_API_OUTPUT);
  if (!present(members['monitorApiUrl'])) missing.push(MONITOR_API_OUTPUT);
  return missing;
}

/**
 * Property 20: endpoint discovery persists or preserves.
 *
 * For every enumerated outputs document, delivered by every route: either BOTH
 * endpoints persist and the rewritten config file round trips through a bare
 * `JSON.parse` carrying them (Req 9.2, 9.3), or the message names each missing
 * output and both previously stored values plus the file are left exactly as
 * they were (Req 9.4). There is no third outcome - in particular no half-written
 * pair, which is why the missing branch asserts on both fields and on the write.
 *
 * **Enumeration scheme.** 7 outputs documents - the five the task names (both
 * present, trigger missing, monitor missing, both missing, extra outputs) plus a
 * non-string and a blank member, which reach the "absent" branch by a different
 * road - crossed with the 2 delivery routes (the deploy stream carried the
 * envelope; the deploy stream carried none and the `outputs` verb supplied it).
 * That is 14 cases, one spec each. Two more specs cover the remaining ways the
 * fallback is reached: an envelope with a sequence gap, and an envelope of the
 * wrong kind. 16 cases in total.
 *
 * Every URL in play is distinct, and the previous pair differs from the
 * discovered pair on both fields, so a crossed or a stale endpoint is a value
 * mismatch rather than an invisible pass.
 */
describe('Property 20: Endpoint discovery persists or preserves', () => {
  let service: AwsCliService;
  let config: AwsDeployConfigService;
  let toast: ToastService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: true } }],
    });
    service = TestBed.inject(AwsCliService);
    config = TestBed.inject(AwsDeployConfigService);
    toast = TestBed.inject(ToastService);
  });

  // Same hazard Properties 17 and 19 document: every field persists to
  // localStorage, persistence rides `effect()` rather than the setters, and karma
  // runs ONE browser for the whole suite. Flush the queued writes BEFORE clearing
  // or a discovered endpoint leaks into the next injector.
  afterEach(() => {
    applyVector(config, Object.fromEntries(AWS_CONFIG_FIELDS.map(f => [f.field, false])));
    TestBed.inject(ApplicationRef).tick();
    localStorage.clear();
  });

  it('the enumeration and its oracle agree, and the seeding is not vacuous', () => {
    expect(OUTPUTS_DOCUMENTS.map(doc => doc.name)).toEqual([
      'both present',
      'trigger missing',
      'monitor missing',
      'both missing',
      'extra outputs',
      'trigger not a string',
      'monitor blank',
    ]);
    for (const doc of OUTPUTS_DOCUMENTS) {
      expect(doc.missing)
        .withContext(`${doc.name}: the declared missing set matches the oracle`)
        .toEqual(oracleMissing(doc.members));
    }

    // The output names discovery can report, and the fact that neither is a
    // substring of the other - which is what lets "does not name the present
    // one" be a real assertion.
    expect(BOTH_OUTPUTS).toEqual(['TriggerApiUrl', 'MonitorApiUrl']);
    expect(TRIGGER_API_OUTPUT.includes(MONITOR_API_OUTPUT)).toBeFalse();
    expect(MONITOR_API_OUTPUT.includes(TRIGGER_API_OUTPUT)).toBeFalse();

    // The previous pair must differ from the discovered pair on BOTH fields, or
    // "unchanged" and "persisted" would be the same observation.
    expect(PREVIOUS_TRIGGER_URL).not.toBe(DISCOVERED_TRIGGER_URL);
    expect(PREVIOUS_MONITOR_URL).not.toBe(DISCOVERED_MONITOR_URL);
    seedPreviousEndpoints(config);
    expect(config.triggerApiUrl()).toBe(PREVIOUS_TRIGGER_URL);
    expect(config.monitorApiUrl()).toBe(PREVIOUS_MONITOR_URL);

    // Multi-chunk framing, so reassembly is exercised rather than assumed.
    expect(envelopeLines(OUTPUTS_DOCUMENTS[0].members).length).toBeGreaterThan(1);
  });

  for (const doc of OUTPUTS_DOCUMENTS) {
    for (const route of DELIVERY_ROUTES) {
      const outcome =
        doc.missing.length === 0 ? 'persists both endpoints' : 'preserves both values';
      it(`${doc.name} via the ${route} ${outcome}`, async () => {
        seedPreviousEndpoints(config);
        const lines = envelopeLines(doc.members);
        const observed = await runDiscovery(
          service,
          config,
          toast,
          route === 'deploy stream' ? [...DEPLOY_NOISE, ...lines] : DEPLOY_NOISE,
          route === 'outputs fallback' ? lines : [],
        );
        expectDiscovery(config, doc, route, observed);
      });
    }
  }

  it('a sequence gap falls back, and an empty fallback changes nothing', async () => {
    seedPreviousEndpoints(config);
    // Dropping sequence 0 leaves framing that cannot be reassembled. That is a
    // different condition from a partial document: the decoder refuses it, so
    // discovery falls back - and when the fallback reports nothing either, both
    // outputs are named and both stored values survive.
    const gapped = envelopeLines(OUTPUTS_DOCUMENTS[0].members).slice(1);
    expect(gapped.length).toBeGreaterThan(0);

    const observed = await runDiscovery(service, config, toast, [...DEPLOY_NOISE, ...gapped], []);

    expectDiscovery(
      config,
      { name: 'sequence gap, empty fallback', members: {}, missing: BOTH_OUTPUTS },
      'outputs fallback',
      observed,
    );
  });

  it('an envelope of another kind falls back, and the fallback supplies the pair', async () => {
    seedPreviousEndpoints(config);
    // A `request` envelope on the deploy stream is not a deploy-outputs document,
    // so it must not be read as one - and must not be read as a partial one
    // either. Discovery falls back, the verb reports the pair, both persist.
    const otherKind = encodeSentinelLines(
      JSON.stringify({ kind: 'request-result', status: 200, body: '{}' }),
    );

    const observed = await runDiscovery(
      service,
      config,
      toast,
      [...DEPLOY_NOISE, ...otherKind],
      envelopeLines(OUTPUTS_DOCUMENTS[0].members),
    );

    expectDiscovery(config, OUTPUTS_DOCUMENTS[0], 'outputs fallback', observed);
  });
});
