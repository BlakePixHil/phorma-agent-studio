// Feature: aws-byo-deploy, Property 18: The AWS form covers every field with the required chrome
//
// For every member of the AWS_Config_Field set, the rendered AWS body section
// contains exactly one control whose label is associated with it, editing it
// stores the trimmed value, an invalid value renders a message naming that field
// and its expected shape, every PrimeNG control in the section carries an
// explicit small size, and no element in the section carries a non-Tabler icon
// class. Validates Requirements 1.9, 2.1, 2.2, 2.3, with the browser-parity and
// disabled-control examples (Requirements 1.7, 1.8) beside it.
//
// Three readings this file makes explicit, because the section does not have the
// shape a naive reading of "one control per field" assumes:
//
// 1. TEXT FIELDS ARE BESPOKE `<input class="phorma-settings__input">`, not
//    `pInputText`. That class already applies `shared/_field.scss`'s `chrome()`
//    mixin plus `font-size: 12px`, and adding `pInputText` would mean overriding
//    font-size on a PrimeNG control, which the conventions forbid because the
//    size token drives height. So "every PrimeNG control carries an explicit
//    small size" is an assertion about the PrimeNG controls the section really
//    does render - the folder picker, the tag add/remove buttons and the Plan,
//    Deploy and Doctor buttons, all `pButton` - and the spec additionally pins
//    that no OTHER kind of PrimeNG control has appeared unchecked.
// 2. `tagSet` RENDERS AS KEY/VALUE ROWS, so it has one labelled control per row
//    rather than one for the field. Its canonical labelled control is the first
//    row's key input, which carries the visible label "Cost allocation tags";
//    later rows are labelled "Tag 2", "Tag 3" and the value cells carry indexed
//    `aria-label`s. A dedicated spec pins that row structure.
// 3. `triggerApiUrl` AND `monitorApiUrl` ARE DISCOVERY-WRITTEN. They are rendered
//    `readonly` and the store exposes no setter for them, so "editing stores the
//    trimmed value" cannot apply; the spec asserts the read-only contract
//    instead of skipping them.
//
// Element ids are scoped per component instance (`aws-1-accountId`,
// `aws-2-accountId`, ...) because two instances of a panel body are routinely in
// the DOM at once. Every query here therefore resolves the scope prefix off the
// DOM instead of hardcoding it, filters to the instance the browser actually
// lays out (`getBoundingClientRect().width > 0`), and one spec mounts two visible
// instances to pin that every id in the document stays unique.

import { ApplicationRef } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';

import { SettingsDialog } from './settings-dialog';
import { SettingsDialogService } from '../settings-dialog.service';
import { AwsDeployConfigService } from '../../../core/deploy/aws-deploy-config.service';
import { AwsCliService } from '../../../core/deploy/aws-cli.service';
import { SettingsService } from '../../../core/settings.service';
import { TauriService } from '../../../core/tauri.service';

// ── The AWS_Config_Field set ─────────────────────────────────────────────────

/**
 * How a field is edited in the form.
 *
 * - `text`: a bespoke text input; whitespace round the typed value must be
 *   trimmed on write.
 * - `number`: `retentionDays`. A `type="number"` input discards a non-numeric
 *   assignment, so whitespace cannot be delivered through it - the store's own
 *   trimming is covered by Property 17 in `core/deploy/aws-deploy.spec.ts`.
 * - `tagRow`: `tagSet`, edited as key/value rows.
 * - `readOnly`: the two discovery-written endpoints, which have no setter.
 */
type FieldKind = 'text' | 'number' | 'tagRow' | 'readOnly';

interface AwsFormField {
  /** The store's field name. Must match the writable-signal probe below. */
  readonly field: string;
  /** The id suffix after the per-instance scope, e.g. `aws-1-` + this. */
  readonly idSuffix: string;
  /** The visible label text. The failure message must name the field with it. */
  readonly label: string;
  readonly kind: FieldKind;
  /** What the operator types into the labelled control. */
  readonly typed?: string;
  /** For a `tagRow` only: what goes into the value cell. */
  readonly typedValue?: string;
  /** What the store must hold after that edit. */
  readonly stored?: unknown;
  read(config: AwsDeployConfigService): unknown;
  /** Puts the field into a state that passes its validator. */
  makeValid(config: AwsDeployConfigService): void;
  /** Puts the field into a state that fails its validator. */
  makeInvalid(config: AwsDeployConfigService): void;
  /** Text proving the message describes the EXPECTED SHAPE (Requirement 2.3). */
  readonly shape: string;
}

/**
 * The AWS_Config_Field set in form order, 15 fields.
 *
 * Values agree with the `AWS_CONFIG_FIELDS` table in
 * `core/deploy/aws-deploy.spec.ts` (that table is not exported, and lives with
 * the store rather than the form). The list is not trusted on its own: the first
 * spec derives the real field set off the store instance - a `signal()` carries
 * `.set`, a `computed()` does not - and fails if this table drifts from it.
 */
const AWS_FORM_FIELDS: readonly AwsFormField[] = [
  {
    field: 'accountId',
    idSuffix: 'accountId',
    label: 'Account ID',
    kind: 'text',
    typed: '  123456789012  ',
    stored: '123456789012',
    read: (config) => config.accountId(),
    makeValid: (config) => config.setAccountId('123456789012'),
    makeInvalid: (config) => config.setAccountId('12345'),
    shape: '12 digits',
  },
  {
    field: 'region',
    idSuffix: 'region',
    label: 'Region',
    kind: 'text',
    // Mixed case on purpose: `setRegion` lowercases as well as trims.
    typed: '  EU-WEST-1  ',
    stored: 'eu-west-1',
    read: (config) => config.region(),
    makeValid: (config) => config.setRegion('eu-west-1'),
    makeInvalid: (config) => config.setRegion('europe'),
    shape: 'eu-west-1',
  },
  {
    field: 'namePrefix',
    idSuffix: 'namePrefix',
    label: 'Name prefix',
    kind: 'text',
    typed: '  Acme-Agents  ',
    stored: 'acme-agents',
    read: (config) => config.namePrefix(),
    makeValid: (config) => config.setNamePrefix('acme-agents'),
    makeInvalid: (config) => config.setNamePrefix('Acme Agents!'),
    shape: '1 to 32',
  },
  {
    field: 'permissionsBoundaryArn',
    idSuffix: 'permissionsBoundaryArn',
    label: 'Permissions boundary',
    kind: 'text',
    typed: '  arn:aws:iam::123456789012:policy/PlatformBoundary  ',
    stored: 'arn:aws:iam::123456789012:policy/PlatformBoundary',
    read: (config) => config.permissionsBoundaryArn(),
    makeValid: (config) =>
      config.setPermissionsBoundaryArn('arn:aws:iam::123456789012:policy/PlatformBoundary'),
    makeInvalid: (config) => config.setPermissionsBoundaryArn('PlatformBoundary'),
    shape: 'IAM policy ARN',
  },
  {
    field: 'bootstrapQualifier',
    idSuffix: 'bootstrapQualifier',
    label: 'Bootstrap qualifier',
    kind: 'text',
    typed: '  phorma  ',
    stored: 'phorma',
    read: (config) => config.bootstrapQualifier(),
    makeValid: (config) => config.setBootstrapQualifier('phorma'),
    makeInvalid: (config) => config.setBootstrapQualifier('qualifier-too-long'),
    shape: '1 to 10',
  },
  {
    field: 'vpcId',
    idSuffix: 'vpcId',
    label: 'VPC ID',
    kind: 'text',
    typed: '  vpc-0a1b2c3d4e5f60718  ',
    stored: 'vpc-0a1b2c3d4e5f60718',
    read: (config) => config.vpcId(),
    makeValid: (config) => config.setVpcId('vpc-0a1b2c3d4e5f60718'),
    // `z` is not hex, so the id shape fails rather than the prefix.
    makeInvalid: (config) => config.setVpcId('vpc-zzzz'),
    shape: 'vpc-0a1b2c3d4e5f60718',
  },
  {
    field: 'subnetIds',
    idSuffix: 'subnetIds',
    label: 'Subnet IDs',
    kind: 'text',
    // Comma separated in the form, split and trimmed on write. The trailing
    // empty entry exercises the setter's filter alongside its trim.
    typed: '  subnet-0a1b2c3d , subnet-0c2d4e6f ,  ',
    stored: ['subnet-0a1b2c3d', 'subnet-0c2d4e6f'],
    read: (config) => config.subnetIds(),
    makeValid: (config) => config.setSubnetIds(['subnet-0a1b2c3d']),
    makeInvalid: (config) => config.setSubnetIds(['sub-0a1b2c3d']),
    shape: 'subnet-0a1b2c3d',
  },
  {
    field: 'appCmkArn',
    idSuffix: 'appCmkArn',
    label: 'App CMK ARN',
    kind: 'text',
    typed: '  arn:aws:kms:eu-west-1:123456789012:key/2f9a1b2c  ',
    stored: 'arn:aws:kms:eu-west-1:123456789012:key/2f9a1b2c',
    read: (config) => config.appCmkArn(),
    makeValid: (config) => config.setAppCmkArn('arn:aws:kms:eu-west-1:123456789012:key/2f9a1b2c'),
    makeInvalid: (config) => config.setAppCmkArn('arn:aws:kms:eu-west-1:123456789012:alias/phorma'),
    shape: 'KMS key ARN',
  },
  {
    field: 'tagSet',
    // The first row's key input carries the visible label; later rows are
    // labelled "Tag 2", "Tag 3" and their value cells carry indexed aria-labels.
    idSuffix: 'tagSet-key-0',
    label: 'Cost allocation tags',
    kind: 'tagRow',
    // Deliberately different from the seeded row, so both cells have to reach
    // the store for the assertion to pass.
    typed: '  cost-centre  ',
    typedValue: '  agents  ',
    stored: { 'cost-centre': 'agents' },
    read: (config) => config.tagSet(),
    makeValid: (config) => config.setTagSet({ app: 'phorma' }),
    makeInvalid: (config) => config.setTagSet({}),
    shape: 'at least one row',
  },
  {
    field: 'retentionDays',
    idSuffix: 'retentionDays',
    label: 'Log retention',
    kind: 'number',
    typed: '90',
    stored: 90,
    read: (config) => config.retentionDays(),
    makeValid: (config) => config.setRetentionDays(30),
    makeInvalid: (config) => config.setRetentionDays(0),
    shape: '1 to 366',
  },
  {
    field: 'notificationTargetArn',
    idSuffix: 'notificationTargetArn',
    label: 'Alarm topic ARN',
    kind: 'text',
    typed: '  arn:aws:sns:eu-west-1:123456789012:platform-alarms  ',
    stored: 'arn:aws:sns:eu-west-1:123456789012:platform-alarms',
    read: (config) => config.notificationTargetArn(),
    makeValid: (config) =>
      config.setNotificationTargetArn('arn:aws:sns:eu-west-1:123456789012:platform-alarms'),
    makeInvalid: (config) => config.setNotificationTargetArn('arn:aws:sns:platform-alarms'),
    shape: 'region and account',
  },
  {
    field: 'cloudAwsDirectory',
    idSuffix: 'cloudAwsDirectory',
    label: 'Runtime folder',
    kind: 'text',
    typed: '  C:/Dev/phorma/cloud-aws  ',
    stored: 'C:/Dev/phorma/cloud-aws',
    read: (config) => config.cloudAwsDirectory(),
    makeValid: (config) => config.setCloudAwsDirectory('C:/Dev/phorma/cloud-aws'),
    makeInvalid: (config) => config.setCloudAwsDirectory(''),
    shape: 'required',
  },
  {
    field: 'imageUri',
    idSuffix: 'imageUri',
    label: 'Image URI',
    kind: 'text',
    typed: '  registry.example.test/phorma/server:1.4.2  ',
    stored: 'registry.example.test/phorma/server:1.4.2',
    read: (config) => config.imageUri(),
    makeValid: (config) => config.setImageUri('registry.example.test/phorma/server:1.4.2'),
    makeInvalid: (config) => config.setImageUri('registry.example.test/phorma/server latest'),
    shape: 'OCI reference',
  },
  {
    field: 'triggerApiUrl',
    idSuffix: 'triggerApiUrl',
    label: 'Trigger API URL',
    kind: 'readOnly',
    read: (config) => config.triggerApiUrl(),
    // No setter by design - endpoint discovery writes the signal directly.
    makeValid: (config) => config.triggerApiUrl.set('https://trigger.example.test'),
    makeInvalid: (config) => config.triggerApiUrl.set('http://trigger.example.test'),
    shape: 'https',
  },
  {
    field: 'monitorApiUrl',
    idSuffix: 'monitorApiUrl',
    label: 'Monitor API URL',
    kind: 'readOnly',
    read: (config) => config.monitorApiUrl(),
    makeValid: (config) => config.monitorApiUrl.set('wss://monitor.example.test/live'),
    makeInvalid: (config) => config.monitorApiUrl.set('https://monitor.example.test/live'),
    shape: 'wss',
  },
];

/** The two fields an operator can never type into (Requirement 2.7). */
const READ_ONLY_FIELDS = AWS_FORM_FIELDS.filter((f) => f.kind === 'readOnly');

/** The 13 fields the form writes back to the store (Requirement 2.2). */
const EDITABLE_FIELDS = AWS_FORM_FIELDS.filter((f) => f.kind !== 'readOnly');

// ── PrimeNG size expectations ────────────────────────────────────────────────

/**
 * Every PrimeNG leaf control class mapped to the class an explicit `small` size
 * emits. `p-button-sm` and friends appear ONLY when the size is set, so a missing
 * one is exactly the silent default-size regression Requirement 1.9 exists to
 * prevent.
 *
 * Leaf controls are enough to cover the composites: `p-inputnumber` and
 * `p-selectbutton` carry no size class themselves, they push the size onto an
 * inner `p-inputtext` / `p-button`, which this table already checks.
 *
 * Listed for every control kind the conventions cover, not just the ones the
 * section renders today, so a control added later is checked rather than silently
 * ignored - and a PrimeNG component host outside this table fails by name.
 */
const PRIMENG_SMALL_CLASS: Readonly<Record<string, string>> = {
  'p-button': 'p-button-sm',
  'p-select': 'p-select-sm',
  'p-inputtext': 'p-inputtext-sm',
  'p-textarea': 'p-textarea-sm',
  'p-checkbox': 'p-checkbox-sm',
};

const PRIMENG_BASE_CLASSES = Object.keys(PRIMENG_SMALL_CLASS);

/**
 * PrimeNG component host tags whose own class carries no size, because the size
 * lands on an inner leaf control that {@link PRIMENG_SMALL_CLASS} covers.
 *
 * `p-popover` is here for a different reason: it is an overlay container, not a
 * control. It has no size token at all, and its own trigger is the plain
 * `<button>` `app-info-popover` renders. The platform-prerequisites card uses one
 * to carry the request checklist that used to be a pointer at a repository file.
 */
const PRIMENG_COMPOSITE_TAGS: readonly string[] = [
  'p-inputnumber',
  'p-inputNumber',
  'p-selectbutton',
  'p-selectButton',
  'p-select-button',
  'p-popover',
];

// ── Harness ──────────────────────────────────────────────────────────────────

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

/**
 * The one visible AWS body section of a fixture.
 *
 * The Cloud page carries exactly one section, and with the Deploy_Target set to
 * `aws` its bespoke template renders the provider tab strip plus the AWS body -
 * so the section element IS the AWS body section for the chrome assertions.
 */
function awsSection(fixture: ComponentFixture<SettingsDialog>): HTMLElement {
  const root = fixture.nativeElement as HTMLElement;
  const sections = laidOut<HTMLElement>(root, '.phorma-settings__section');
  if (sections.length !== 1) {
    throw new Error(`Expected 1 laid-out settings section, found ${sections.length}.`);
  }
  return sections[0];
}

/**
 * The per-instance id scope, read off the DOM rather than assumed.
 *
 * `awsFieldId` prefixes every id with `aws-<n>-` from a static counter, so the
 * second component built in one browser gets `aws-2-`. Hardcoding `aws-1-` would
 * make this whole file order-dependent under karma's randomized spec order.
 */
function scopePrefix(section: HTMLElement): string {
  const anchor = laidOut<HTMLInputElement>(section, 'input[id]').find((input) =>
    /^aws-\d+-accountId$/.test(input.id),
  );
  if (!anchor) {
    throw new Error('No aws-<n>-accountId input in the laid-out section: the id scope is missing.');
  }
  return anchor.id.slice(0, anchor.id.length - 'accountId'.length);
}

/** The laid-out controls carrying exactly the scoped id for one field. */
function controlsFor(section: HTMLElement, prefix: string, suffix: string): HTMLInputElement[] {
  const id = `${prefix}${suffix}`;
  return laidOut<HTMLInputElement>(section, 'input').filter((input) => input.id === id);
}

/** Types into a control the way an operator does, then re-renders. */
function typeInto(
  fixture: ComponentFixture<SettingsDialog>,
  input: HTMLInputElement,
  value: string,
): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

/** Every field message currently rendered in the section, whitespace collapsed. */
function hints(section: HTMLElement): string[] {
  return laidOut<HTMLElement>(section, '.phorma-settings__hint').map((hint) =>
    (hint.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );
}

/** Every `__note` line currently rendered in the section, whitespace collapsed. */
function notes(section: HTMLElement): string[] {
  return laidOut<HTMLElement>(section, '.phorma-settings__note').map((note) =>
    (note.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );
}

/**
 * The Plan, Deploy and Doctor buttons, in template order.
 *
 * Found by their labels rather than by position: the section's last action row
 * is also the one the tag editor uses a variant of, and a positional lookup
 * would silently follow a reordering instead of failing on it.
 */
function actionButtons(section: HTMLElement): Record<string, HTMLButtonElement> {
  const wanted = ['Plan', 'Deploy', 'Doctor'];
  const found: Record<string, HTMLButtonElement> = {};
  for (const button of laidOut<HTMLButtonElement>(section, 'button')) {
    const label = (button.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (wanted.includes(label)) found[label] = button;
  }
  for (const label of wanted) {
    if (!found[label]) throw new Error(`No "${label}" control in the AWS section.`);
  }
  return found;
}

/** Puts every field into a state that passes its validator. */
function applyValidConfig(config: AwsDeployConfigService): void {
  for (const field of AWS_FORM_FIELDS) field.makeValid(config);
}

/** Empties every field, so nothing leaks into the next spec through localStorage. */
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
 * Mounts the Settings dialog on the Cloud page with `aws` selected.
 *
 * The store is seeded BEFORE the component exists on purpose: the dialog seeds
 * its two local drafts (the comma-separated subnet text and the tag rows) in its
 * constructor rather than in an `effect()`, because an effect that read the store
 * and wrote a draft, while every keystroke writes the store from that draft, is
 * the read-and-write-the-same-signal loop that has already OOM'd this dialog.
 */
function mount(seed?: (config: AwsDeployConfigService) => void): ComponentFixture<SettingsDialog> {
  const config = TestBed.inject(AwsDeployConfigService);
  clearConfig(config);
  seed?.(config);
  TestBed.inject(SettingsService).cloudProvider.set('aws');
  TestBed.inject(SettingsDialogService).open('cloud');
  const fixture = TestBed.createComponent(SettingsDialog);
  fixture.detectChanges();
  return fixture;
}

// ── Property 18 ──────────────────────────────────────────────────────────────

/**
 * Exhaustive over the closed AWS_Config_Field set: 15 fields, each visited by the
 * label-association spec, the invalid-message spec and the write-through spec
 * (13 editable fields) or the read-only-contract spec (2 discovery-written
 * fields). 15 x 3 = 45 field cases, plus the derivation guard, the
 * valid-configuration silence spec, the tag-row structure spec, the two
 * section-wide chrome specs and the id-uniqueness spec.
 *
 * `fast-check` is not a frontend dependency, and it would add nothing here: the
 * field set is closed and small, so enumerating it IS the property.
 */
describe('Property 18: The AWS form covers every field with the required chrome', () => {
  let config: AwsDeployConfigService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideNoopAnimations(),
        // Desktop, so the folder picker renders and the action controls are
        // governed by validity alone. The browser-preview half of the surface is
        // the examples below.
        {
          provide: TauriService,
          useValue: { isDesktop: true, selectFolderDialog: () => Promise.resolve(null) },
        },
      ],
    });
    config = TestBed.inject(AwsDeployConfigService);
  });

  // Every AWS field persists to localStorage and karma runs ONE browser for the
  // whole suite, so a leaked value decides `valid()` in every later spec.
  // Persistence rides `effect()` rather than the setters, so the queued writes
  // are flushed with `tick()` BEFORE the clear, or they land after it and the
  // next injector loads them.
  afterEach(() => {
    clearConfig(config);
    TestBed.inject(SettingsService).cloudProvider.set(null);
    TestBed.inject(ApplicationRef).tick();
    localStorage.clear();
  });

  it('the field table covers every field the store persists', () => {
    // The store's writable signals, read off the instance: a `signal()` carries
    // `.set`, a `computed()` does not. This is what makes the enumeration
    // self-extending - add a field to the store and this spec names it.
    const persisted = Object.keys(config)
      .filter((key) => {
        const value = (config as unknown as Record<string, unknown>)[key];
        if (typeof value !== 'function') return false;
        return typeof (value as { set?: unknown }).set === 'function';
      })
      .sort();

    expect(persisted).toEqual(AWS_FORM_FIELDS.map((f) => f.field).sort());
    expect(READ_ONLY_FIELDS.length + EDITABLE_FIELDS.length).toBe(AWS_FORM_FIELDS.length);
  });

  for (const field of AWS_FORM_FIELDS) {
    it(`${field.field}: renders exactly one control with an associated label`, () => {
      const fixture = mount(applyValidConfig);
      const section = awsSection(fixture);
      const prefix = scopePrefix(section);
      const id = `${prefix}${field.idSuffix}`;

      const controls = controlsFor(section, prefix, field.idSuffix);
      expect(controls.length).withContext(`${field.field}: controls carrying id "${id}"`).toBe(1);

      const labels = laidOut<HTMLLabelElement>(section, `label[for="${id}"]`);
      expect(labels.length).withContext(`${field.field}: labels for "${id}"`).toBe(1);
      // Guarded so a missing association reports itself once, instead of
      // cascading into a TypeError that buries the field name.
      if (labels.length === 1 && controls.length === 1) {
        expect((labels[0].textContent ?? '').replace(/\s+/g, ' ').trim())
          .withContext(`${field.field}: label text`)
          .toBe(field.label);
        // The browser's own resolution of `for` -> control, which only works
        // while the id is unique in the document.
        expect(labels[0].control)
          .withContext(`${field.field}: the label resolves to its control`)
          .toBe(controls[0]);
      }
    });
  }

  for (const field of EDITABLE_FIELDS) {
    it(`${field.field}: editing stores the trimmed value`, () => {
      const fixture = mount(applyValidConfig);
      const section = awsSection(fixture);
      const prefix = scopePrefix(section);
      const control = controlsFor(section, prefix, field.idSuffix)[0];

      expect(control.readOnly).withContext(`${field.field}: is editable`).toBeFalse();
      expect(control.disabled).withContext(`${field.field}: is enabled`).toBeFalse();

      typeInto(fixture, control, field.typed!);
      if (field.kind === 'tagRow') {
        // A tag is a key/value pair, so the row is two controls and both have to
        // write through for the stored record to be right.
        const valueCell = controlsFor(section, prefix, 'tagSet-value-0')[0];
        expect(valueCell).withContext(`${field.field}: the row's value cell`).toBeTruthy();
        typeInto(fixture, valueCell, field.typedValue!);
      }

      expect(field.read(config))
        .withContext(`${field.field}: the store holds the trimmed value of "${field.typed}"`)
        .toEqual(field.stored);
    });
  }

  for (const field of READ_ONLY_FIELDS) {
    it(`${field.field}: is discovery-written, so the form renders it read-only`, () => {
      const fixture = mount(applyValidConfig);
      const section = awsSection(fixture);
      const prefix = scopePrefix(section);
      const control = controlsFor(section, prefix, field.idSuffix)[0];
      const before = field.read(config);

      expect(control.readOnly).withContext(`${field.field}: renders read-only`).toBeTrue();
      expect(control.value)
        .withContext(`${field.field}: shows the discovered value`)
        .toBe(String(before));

      // No setter exists on the store either, so the read-only chrome is not the
      // only thing standing between an operator and a claimed endpoint.
      const setter = `set${field.field.charAt(0).toUpperCase()}${field.field.slice(1)}`;
      expect((config as unknown as Record<string, unknown>)[setter])
        .withContext(`${field.field}: the store exposes no ${setter}`)
        .toBeUndefined();

      typeInto(fixture, control, 'https://operator.example.test');
      expect(field.read(config))
        .withContext(`${field.field}: typing into it changes nothing`)
        .toBe(before);
    });
  }

  for (const field of AWS_FORM_FIELDS) {
    it(`${field.field}: an invalid value renders a message naming the field and its shape`, () => {
      const fixture = mount((store) => {
        applyValidConfig(store);
        field.makeInvalid(store);
      });
      const section = awsSection(fixture);
      const rendered = hints(section);
      // A message NAMES the field by opening with its visible label. Matching on
      // "contains the label" instead would be ambiguous: an invalid Region also
      // invalidates the App CMK ARN, whose own message mentions "the region
      // above", and the two would be indistinguishable.
      const naming = rendered.filter((hint) => hint.startsWith(field.label));

      expect(naming.length)
        .withContext(
          `${field.field}: messages opening with "${field.label}", of ${rendered.length} ` +
            `rendered: ${rendered.join(' | ') || '(none)'}`,
        )
        .toBe(1);
      expect(naming[0])
        .withContext(`${field.field}: the message states the expected shape`)
        .toContain(field.shape);
    });
  }

  it('a valid configuration renders no field message at all', () => {
    const fixture = mount(applyValidConfig);
    const section = awsSection(fixture);

    expect(config.valid()).withContext('the seeded configuration is valid').toBeTrue();
    expect(hints(section)).toEqual([]);
  });

  it('tagSet renders one labelled key cell, one value cell and one remove control per row', () => {
    const fixture = mount((config) => {
      applyValidConfig(config);
      config.setTagSet({ app: 'phorma', owner: 'ops' });
    });
    const section = awsSection(fixture);
    const prefix = scopePrefix(section);

    // Row 0 carries the field's visible label; later rows are numbered.
    const rowLabels = ['Cost allocation tags', 'Tag 2'];
    for (const [index, expected] of rowLabels.entries()) {
      const keyId = `${prefix}tagSet-key-${index}`;
      const keyCells = controlsFor(section, prefix, `tagSet-key-${index}`);
      expect(keyCells.length).withContext(`tag row ${index}: key cells`).toBe(1);

      const labels = laidOut<HTMLLabelElement>(section, `label[for="${keyId}"]`);
      expect(labels.length).withContext(`tag row ${index}: labels`).toBe(1);
      expect((labels[0].textContent ?? '').trim())
        .withContext(`tag row ${index}: label text`)
        .toBe(expected);

      const valueCells = controlsFor(section, prefix, `tagSet-value-${index}`);
      expect(valueCells.length).withContext(`tag row ${index}: value cells`).toBe(1);
      expect(valueCells[0].getAttribute('aria-label'))
        .withContext(`tag row ${index}: the value cell is named for a screen reader`)
        .toBe(`Cost allocation tag ${index + 1} value`);

      const removes = laidOut<HTMLButtonElement>(
        section,
        `button[aria-label="Remove cost allocation tag ${index + 1}"]`,
      );
      expect(removes.length).withContext(`tag row ${index}: remove controls`).toBe(1);
    }

    // Both rows survive the round trip through the store, which is what makes
    // "one control per row" more than a rendering detail.
    expect(config.tagSet()).toEqual({ app: 'phorma', owner: 'ops' });
  });

  it('every PrimeNG control in the section carries an explicit small size', () => {
    const fixture = mount(applyValidConfig);
    const section = awsSection(fixture);
    const found: string[] = [];

    for (const element of Array.from(section.querySelectorAll<HTMLElement>('*'))) {
      const tag = element.tagName.toLowerCase();
      if (tag.startsWith('p-') && !PRIMENG_COMPOSITE_TAGS.includes(tag)) {
        expect(PRIMENG_BASE_CLASSES)
          .withContext(
            `<${tag}> is a PrimeNG control this spec does not know how to size-check: ` +
              'add it to PRIMENG_SMALL_CLASS.',
          )
          .toContain(tag);
      }
      for (const base of PRIMENG_BASE_CLASSES) {
        if (!element.classList.contains(base)) continue;
        found.push(base);
        expect(element.classList.contains(PRIMENG_SMALL_CLASS[base]))
          .withContext(
            `a .${base} in the AWS section is missing .${PRIMENG_SMALL_CLASS[base]}: ` +
              `"${(element.textContent ?? '').replace(/\s+/g, ' ').trim() || element.outerHTML}"`,
          )
          .toBeTrue();
      }
    }

    // Not vacuous, and it pins 13.8's reading: the PrimeNG controls this section
    // renders are all buttons - the folder picker, Set up runtime files, the tag
    // add and remove controls, and Plan, Deploy and Doctor. Seven with one tag row.
    expect(new Set(found)).toEqual(new Set(['p-button']));
    expect(found.length).withContext('PrimeNG buttons in the AWS section').toBe(7);
  });

  it('no element in the section carries a non-Tabler icon class', () => {
    const fixture = mount(applyValidConfig);
    const section = awsSection(fixture);
    let icons = 0;

    for (const element of Array.from(section.querySelectorAll<HTMLElement>('*'))) {
      const classes = Array.from(element.classList);
      const primeIcons = classes.filter((name) => name === 'pi' || name.startsWith('pi-'));
      expect(primeIcons)
        .withContext(`${element.tagName.toLowerCase()} carries a PrimeIcons class`)
        .toEqual([]);
      if (element.tagName.toLowerCase() !== 'i') continue;
      icons += 1;
      expect(classes)
        .withContext(`an <i> in the AWS section is not a Tabler icon: class="${element.className}"`)
        .toContain('ti');
      expect(classes.some((name) => name.startsWith('ti-')))
        .withContext(`an <i> in the AWS section has no ti-* glyph: class="${element.className}"`)
        .toBeTrue();
    }

    expect(icons).withContext('Tabler icons in the AWS section').toBeGreaterThan(0);
  });

  it('two mounted instances keep every element id unique', () => {
    const first = mount(applyValidConfig);
    // TestBed's DOM renderer removes every previous root element when it inserts
    // the next one, so a second fixture alone does NOT reproduce the hazard this
    // spec exists for. Re-attaching the first root is the point: the app really
    // does host two instances of a panel body at once.
    const firstRoot = first.nativeElement as HTMLElement;
    const second = TestBed.createComponent(SettingsDialog);
    if (!firstRoot.isConnected) document.body.appendChild(firstRoot);
    second.detectChanges();
    first.detectChanges();

    const firstSection = awsSection(first);
    const secondSection = awsSection(second);
    const firstPrefix = scopePrefix(firstSection);
    const secondPrefix = scopePrefix(secondSection);

    expect(firstPrefix).not.toBe(secondPrefix);

    // The steering's check: nothing in the document shares an id, which is what
    // every `<label for>` association above depends on.
    const ids = Array.from(document.querySelectorAll('[id]')).map((element) => element.id);
    expect(ids.length).withContext('total ids vs unique ids').toBe(new Set(ids).size);

    // And why the queries above are scoped to one instance: document-wide, every
    // field now has two controls.
    for (const field of AWS_FORM_FIELDS) {
      expect(controlsFor(firstSection, firstPrefix, field.idSuffix).length)
        .withContext(`${field.field}: controls in the first instance`)
        .toBe(1);
      expect(controlsFor(secondSection, secondPrefix, field.idSuffix).length)
        .withContext(`${field.field}: controls in the second instance`)
        .toBe(1);
      expect(laidOut<HTMLInputElement>(document, `input[id$="-${field.idSuffix}"]`).length)
        .withContext(`${field.field}: controls across both instances`)
        .toBe(2);
    }

    second.destroy();
  });
});

// ── Examples beside the property ─────────────────────────────────────────────

/**
 * Browser parity (Requirements 1.7, 1.8).
 *
 * The whole section renders under `ng serve` with no Tauri present, and the
 * fields stay EDITABLE - an operator can prepare a configuration in the browser
 * and deploy from the desktop app later. Only the three controls that shell out
 * to the AWS CLI are disabled, and a note says why.
 */
describe('The AWS section under browser preview', () => {
  let config: AwsDeployConfigService;
  let fixture: ComponentFixture<SettingsDialog>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideNoopAnimations(),
        { provide: TauriService, useValue: { isDesktop: false } },
      ],
    });
    config = TestBed.inject(AwsDeployConfigService);
    fixture = mount(applyValidConfig);
  });

  afterEach(() => {
    clearConfig(config);
    TestBed.inject(SettingsService).cloudProvider.set(null);
    TestBed.inject(ApplicationRef).tick();
    localStorage.clear();
  });

  it('renders every field editable even with no desktop shell', () => {
    const section = awsSection(fixture);
    const prefix = scopePrefix(section);

    // A fully valid configuration: nothing here is disabled by validity.
    expect(config.valid()).toBeTrue();

    for (const field of EDITABLE_FIELDS) {
      const control = controlsFor(section, prefix, field.idSuffix)[0];
      expect(control).withContext(`${field.field}: renders in browser preview`).toBeTruthy();
      expect(control.disabled).withContext(`${field.field}: stays enabled`).toBeFalse();
      expect(control.readOnly).withContext(`${field.field}: stays editable`).toBeFalse();
    }

    // And a write still lands, so "editable" is behaviour rather than chrome.
    typeInto(fixture, controlsFor(section, prefix, 'namePrefix')[0], '  Browser-Prefix  ');
    expect(config.namePrefix()).toBe('browser-prefix');
  });

  it('disables only Plan, Deploy and Doctor, and says the desktop app is needed', () => {
    const section = awsSection(fixture);
    const buttons = actionButtons(section);

    expect(buttons['Plan'].disabled).withContext('Plan').toBeTrue();
    expect(buttons['Deploy'].disabled).withContext('Deploy').toBeTrue();
    expect(buttons['Doctor'].disabled).withContext('Doctor').toBeTrue();

    expect(notes(section)).toContain(
      'Deploying to AWS runs the AWS CLI and CDK on your machine. Use the desktop app to plan, ' +
        'deploy or run doctor.',
    );

    // The folder picker is a native dialog, so it is absent rather than disabled.
    expect(
      laidOut<HTMLButtonElement>(section, 'button[aria-label="Browse for the runtime folder"]')
        .length,
    ).toBe(0);
  });
});

/**
 * The disabled-control example (Requirements 1.8, 2.5).
 *
 * On the desktop the three controls follow the aggregate validity and the
 * in-flight flag, and the aggregate line counts the fields that need attention.
 */
describe('The AWS action controls on the desktop', () => {
  let config: AwsDeployConfigService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideNoopAnimations(),
        {
          provide: TauriService,
          useValue: { isDesktop: true, selectFolderDialog: () => Promise.resolve(null) },
        },
      ],
    });
    config = TestBed.inject(AwsDeployConfigService);
  });

  afterEach(() => {
    clearConfig(config);
    TestBed.inject(SettingsService).cloudProvider.set(null);
    TestBed.inject(ApplicationRef).tick();
    localStorage.clear();
  });

  it('enables all three once the configuration is valid', () => {
    const fixture = mount(applyValidConfig);
    const section = awsSection(fixture);
    const buttons = actionButtons(section);

    expect(buttons['Plan'].disabled).withContext('Plan').toBeFalse();
    expect(buttons['Deploy'].disabled).withContext('Deploy').toBeFalse();
    expect(buttons['Doctor'].disabled).withContext('Doctor').toBeFalse();
    expect(notes(section).some((note) => note.includes('need attention'))).toBeFalse();
  });

  it('disables all three and counts the fields while the configuration is invalid', () => {
    const fixture = mount((store) => {
      applyValidConfig(store);
      store.setAccountId('12345');
      store.setRegion('');
    });
    const section = awsSection(fixture);
    const buttons = actionButtons(section);

    expect(buttons['Plan'].disabled).withContext('Plan').toBeTrue();
    expect(buttons['Deploy'].disabled).withContext('Deploy').toBeTrue();
    expect(buttons['Doctor'].disabled).withContext('Doctor').toBeTrue();
    // Two malformed fields. The CMK ARN stays valid: its region check is skipped
    // while the Region_Pin is empty, so an empty region costs one field, not two.
    expect(config.invalidFieldCount()).toBe(2);
    expect(notes(section)).toContain('2 fields need attention');

    // The singular case is a different string, so it is worth pinning too.
    config.setRegion('eu-west-1');
    fixture.detectChanges();
    expect(config.invalidFieldCount()).toBe(1);
    expect(notes(awsSection(fixture))).toContain('1 field needs attention');
  });

  it('disables all three while an AWS command is in flight', () => {
    const fixture = mount(applyValidConfig);
    const cli = TestBed.inject(AwsCliService);

    cli.running.set(true);
    fixture.detectChanges();
    const buttons = actionButtons(awsSection(fixture));

    expect(buttons['Plan'].disabled).withContext('Plan').toBeTrue();
    expect(buttons['Deploy'].disabled).withContext('Deploy').toBeTrue();
    expect(buttons['Doctor'].disabled).withContext('Doctor').toBeTrue();
    expect(hints(awsSection(fixture))).toContain('Running. Output is streaming to the console.');

    cli.running.set(false);
  });
});
