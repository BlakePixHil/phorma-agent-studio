/**
 * AWS deployment configuration.
 *
 * Mirrors the Cloudflare `DeployConfigService`: every field lives in a
 * signal persisted to localStorage, validated with a `computed`, and
 * serialised to a gitignored config file beside `cdk.json`.
 *
 * Three invariants this file exists to hold:
 *
 * 1. `buildConfigFile()` emits PURE JSON - the provenance notice travels as the
 *    `$generatedBy` member, never as leading `//` lines. `cloud-aws`'s
 *    `cli/config-file.ts` does one bare `JSON.parse` with no comment-stripping
 *    step, and `parseAwsDeployConfig` ignores `$generatedBy` (Req 3.1, 3.2).
 * 2. Aggregate validity is true only when every REQUIRED field holds a value and
 *    every POPULATED field passes its validator (Req 2.4). That is expressed by
 *    the per-field validity signals themselves - a required field's validator is
 *    false when empty, an optional field's is valid-when-empty - so `valid` and
 *    `invalidFieldCount` both read the ONE enumeration in `fieldValidity` and
 *    there is no second source of truth.
 * 3. No field carries AWS credential material (Req 2.10). This file is written
 *    to disk in the operator's repository in plain text, so an access key here
 *    would be a leak by design. Credentials stay in the operator's AWS CLI
 *    profile, which only the Deploy_Runner ever sees.
 *
 * Does NOT inject `CloudService` (DI cycle hazard). Injects `TauriService`
 * for file writes.
 */

import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import { loadLayout, saveLayout } from '../layout-storage';
import { TauriService } from '../tauri.service';

/** Filename of the generated config, written beside `cdk.json`. */
export const AWS_CONFIG_FILENAME = 'cdk.context.phorma.json';

// ── Validation patterns ──────────────────────────────────────────────────────

/** Exactly 12 digits. */
const ACCOUNT_ID_RE = /^\d{12}$/;

/**
 * AWS region: 2-3 letter geo, a dash, a direction or qualifier, a dash and a
 * digit. e.g. us-east-1, eu-west-2, ap-southeast-1.
 */
const REGION_RE = /^[a-z]{2,3}-[a-z]+-\d{1,2}$/;

/** 1-32 characters of lower-case letters, digits and hyphens. */
const NAME_PREFIX_RE = /^[a-z0-9-]{1,32}$/;

/** IAM policy ARN: arn:aws:iam::<12-digit-account>:policy/<path> */
const IAM_POLICY_ARN_RE = /^arn:aws:iam::\d{12}:policy\/.+$/;

/** Generic ARN shape (SNS, SQS, etc.): region + account + resource. */
const ARN_RE = /^arn:aws:[a-z0-9-]+:[a-z]{2,3}-[a-z]+-\d{1,2}:\d{12}:.+$/;

/** KMS key ARN: arn:aws:kms:<region>:<account>:key/<id> */
const KMS_KEY_ARN_RE = /^arn:aws:kms:([a-z]{2,3}-[a-z]+-\d{1,2}):\d{12}:key\/.+$/;

/** VPC id: vpc-<hex> */
const VPC_ID_RE = /^vpc-[0-9a-f]+$/;

/** Subnet id: subnet-<hex> */
const SUBNET_ID_RE = /^subnet-[0-9a-f]+$/;

/**
 * OCI image reference:
 * `{registry}[:{port}]/{repository}:{tag}` or
 * `{registry}[:{port}]/{repository}@sha256:{digest}`
 *
 * Copied verbatim from `IMAGE_URI_RE` in `cloud-aws/src/core/config.ts` (Req
 * 2.6, 2.8): the Config_Parser rejects the deploy on the same pattern, so a
 * looser one here would accept a value the CLI then refuses, and a stricter one
 * would refuse a value the platform team legitimately published. Registry host
 * and repository path are lowercase-only, which is what OCI requires; the tag
 * half allows mixed case, and the digest half is 64 lowercase hex characters.
 */
const IMAGE_URI_RE =
  /^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._/-]+)+(:[A-Za-z0-9._-]{1,128}|@sha256:[a-f0-9]{64})$/;

/**
 * Endpoint URL shape check, mirroring `isEndpointUrl` in
 * `cloud-aws/src/core/config.ts` (Req 2.8, 2.9): parses as a URL, scheme exactly
 * `scheme`, no query, no fragment, no surrounding whitespace, and - unless
 * `allowTrailingSlash` - no trailing slash.
 *
 * `?`, `#` and whitespace are checked against the string rather than the parsed
 * URL because the parser normalizes all three away. The trailing-slash rule
 * matters for the Trigger_API base: route paths are joined onto it, so a
 * trailing slash would produce a double slash.
 */
function isEndpointUrl(
  value: string,
  scheme: 'https:' | 'wss:',
  allowTrailingSlash: boolean,
): boolean {
  if (value !== value.trim()) return false;
  if (value.includes('?') || value.includes('#')) return false;
  if (!allowTrailingSlash && value.endsWith('/')) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === scheme;
}

@Injectable({ providedIn: 'root' })
export class AwsDeployConfigService {
  private readonly tauri = inject(TauriService);

  // ── Signals (persisted to localStorage) ────────────────────────────────────

  readonly accountId = signal(loadLayout('awsAccountId', ''));
  readonly region = signal(loadLayout('awsRegion', ''));
  readonly namePrefix = signal(loadLayout('awsNamePrefix', ''));
  readonly permissionsBoundaryArn = signal(loadLayout('awsPermissionsBoundaryArn', ''));
  readonly bootstrapQualifier = signal(loadLayout('awsBootstrapQualifier', ''));
  readonly vpcId = signal(loadLayout('awsVpcId', ''));
  readonly subnetIds = signal<string[]>(loadLayout<string[]>('awsSubnetIds', []));
  readonly appCmkArn = signal(loadLayout('awsAppCmkArn', ''));
  readonly tagSet = signal<Record<string, string>>(
    loadLayout<Record<string, string>>('awsTagSet', {}),
  );
  readonly retentionDays = signal(loadLayout('awsRetentionDays', 30));
  readonly notificationTargetArn = signal(loadLayout('awsNotificationTargetArn', ''));
  readonly cloudAwsDirectory = signal(loadLayout('awsCloudAwsDirectory', ''));

  /**
   * Optional platform-published Container_Image reference (Req 2.6).
   *
   * Empty means the deploy builds the image from `cloud-aws/Dockerfile` and needs
   * a running Docker daemon; populated means the deploy references this image and
   * runs no local build. It is a registry coordinate, not a credential.
   */
  readonly imageUri = signal(loadLayout('awsImageUri', ''));

  /**
   * Trigger_API base URL, written by endpoint discovery after a deploy.
   *
   * Not operator-entered: an empty value means "no deploy has completed yet",
   * which is why `CloudService.configured()` requires it before it reports the
   * `aws` target as reachable. Push, run history and usage all hang off it.
   */
  readonly triggerApiUrl = signal(loadLayout('awsTriggerApiUrl', ''));

  /**
   * Monitor_API WebSocket URL, written by endpoint discovery after a deploy
   * (Req 2.7, 9.2).
   *
   * Same contract as {@link triggerApiUrl}: no operator types it, an empty value
   * means no deploy has completed yet, and live monitoring stays unavailable
   * while it is empty. The stage path (`/live`) is part of the value, so a
   * trailing path is expected here where it is a defect on the trigger base.
   */
  readonly monitorApiUrl = signal(loadLayout('awsMonitorApiUrl', ''));

  // ── Computed validators ────────────────────────────────────────────────────
  //
  // A REQUIRED field's validator tests the value directly, so an empty value
  // fails it. An OPTIONAL field's validator is `!value || shape`, so an empty
  // value passes. Requirement 2.4's two halves - every required field populated,
  // every populated field well formed - therefore both fall out of the same
  // per-field signals, and `valid` stays their conjunction.
  //
  // Required is read off the consumer that would reject the deploy:
  // `parseAwsDeployConfig` in `cloud-aws/src/core/config.ts` demands accountId,
  // region, namePrefix, permissionsBoundaryArn, bootstrapQualifier,
  // alarmNotificationArn, at least one cost-allocation tag and an in-range
  // retention window. `cloudAwsDirectory` is required by the Studio rather than
  // by the parser: with no directory there is nowhere to write the
  // Deploy_Config_File and no working directory to run the CLI in.

  readonly accountIdValid = computed(() => ACCOUNT_ID_RE.test(this.accountId()));

  readonly regionValid = computed(() => REGION_RE.test(this.region()));

  readonly namePrefixValid = computed(() => NAME_PREFIX_RE.test(this.namePrefix()));

  readonly permissionsBoundaryArnValid = computed(() =>
    IAM_POLICY_ARN_RE.test(this.permissionsBoundaryArn()),
  );

  readonly bootstrapQualifierValid = computed(() =>
    // CDK qualifiers are short alphanumeric strings (1-10 chars).
    /^[a-z0-9]{1,10}$/i.test(this.bootstrapQualifier()),
  );

  readonly vpcIdValid = computed(() => {
    const v = this.vpcId();
    return !v || VPC_ID_RE.test(v);
  });

  readonly subnetIdsValid = computed(() => {
    const ids = this.subnetIds();
    return ids.length === 0 || ids.every(id => SUBNET_ID_RE.test(id));
  });

  readonly appCmkArnValid = computed(() => {
    const v = this.appCmkArn();
    if (!v) return true;
    const match = KMS_KEY_ARN_RE.exec(v);
    if (!match) return false;
    // Region must match the configured Region_Pin when both are set.
    const region = this.region();
    return !region || match[1] === region;
  });

  /** Required: the deploy fails synthesis with no cost-allocation tag. */
  readonly tagSetValid = computed(() => {
    const entries = Object.entries(this.tagSet());
    if (entries.length === 0) return false;
    return entries.every(([key, value]) => key.trim().length > 0 && value.trim().length > 0);
  });

  readonly retentionDaysValid = computed(() => {
    const v = this.retentionDays();
    return Number.isInteger(v) && v >= 1 && v <= 366;
  });

  readonly notificationTargetArnValid = computed(() => ARN_RE.test(this.notificationTargetArn()));

  readonly cloudAwsDirectoryValid = computed(() => this.cloudAwsDirectory().trim().length > 0);

  /** Optional. Same OCI reference shapes the Config_Parser enforces (Req 2.6). */
  readonly imageUriValid = computed(() => {
    const v = this.imageUri();
    return !v || IMAGE_URI_RE.test(v);
  });

  /** Optional, discovery-written. `https`, no query, fragment or trailing slash. */
  readonly triggerApiUrlValid = computed(() => {
    const v = this.triggerApiUrl();
    return !v || isEndpointUrl(v, 'https:', false);
  });

  /** Optional, discovery-written. `wss`, no query or fragment; a path is fine. */
  readonly monitorApiUrlValid = computed(() => {
    const v = this.monitorApiUrl();
    return !v || isEndpointUrl(v, 'wss:', true);
  });

  /**
   * Every AWS_Config_Field's validity, in form order.
   *
   * The ONE enumeration: both {@link valid} and {@link invalidFieldCount} read
   * it, so the aggregate and the count the form displays can never disagree, and
   * a field added above reaches both by being listed here once.
   */
  private readonly fieldValidity = computed<readonly boolean[]>(() => [
    this.accountIdValid(),
    this.regionValid(),
    this.namePrefixValid(),
    this.permissionsBoundaryArnValid(),
    this.bootstrapQualifierValid(),
    this.vpcIdValid(),
    this.subnetIdsValid(),
    this.appCmkArnValid(),
    this.notificationTargetArnValid(),
    this.tagSetValid(),
    this.retentionDaysValid(),
    this.imageUriValid(),
    this.cloudAwsDirectoryValid(),
    this.triggerApiUrlValid(),
    this.monitorApiUrlValid(),
  ]);

  /**
   * How many fields are missing or malformed - what the form renders as
   * "N fields need attention" (Req 2.5).
   */
  readonly invalidFieldCount = computed(() => this.fieldValidity().filter(ok => !ok).length);

  /**
   * True only when every required field holds a value and every populated field
   * is well formed (Req 2.4).
   *
   * Deliberately NOT vacuously true on an untouched store: Plan and Deploy hang
   * off this, and an empty configuration cannot deploy anything.
   */
  readonly valid = computed(() => this.invalidFieldCount() === 0);

  constructor() {
    effect(() => saveLayout('awsAccountId', this.accountId()));
    effect(() => saveLayout('awsRegion', this.region()));
    effect(() => saveLayout('awsNamePrefix', this.namePrefix()));
    effect(() => saveLayout('awsPermissionsBoundaryArn', this.permissionsBoundaryArn()));
    effect(() => saveLayout('awsBootstrapQualifier', this.bootstrapQualifier()));
    effect(() => saveLayout('awsVpcId', this.vpcId()));
    effect(() => saveLayout('awsSubnetIds', this.subnetIds()));
    effect(() => saveLayout('awsAppCmkArn', this.appCmkArn()));
    effect(() => saveLayout('awsTagSet', this.tagSet()));
    effect(() => saveLayout('awsRetentionDays', this.retentionDays()));
    effect(() => saveLayout('awsNotificationTargetArn', this.notificationTargetArn()));
    effect(() => saveLayout('awsCloudAwsDirectory', this.cloudAwsDirectory()));
    effect(() => saveLayout('awsImageUri', this.imageUri()));
    effect(() => saveLayout('awsTriggerApiUrl', this.triggerApiUrl()));
    effect(() => saveLayout('awsMonitorApiUrl', this.monitorApiUrl()));
  }

  // ── Setters ────────────────────────────────────────────────────────────────

  setAccountId(value: string): void {
    this.accountId.set(value.trim());
  }

  setRegion(value: string): void {
    this.region.set(value.trim().toLowerCase());
  }

  setNamePrefix(value: string): void {
    this.namePrefix.set(value.trim().toLowerCase());
  }

  setPermissionsBoundaryArn(value: string): void {
    this.permissionsBoundaryArn.set(value.trim());
  }

  setBootstrapQualifier(value: string): void {
    this.bootstrapQualifier.set(value.trim());
  }

  setVpcId(value: string): void {
    this.vpcId.set(value.trim());
  }

  setSubnetIds(value: string[]): void {
    this.subnetIds.set(value.map(id => id.trim()).filter(id => id.length > 0));
  }

  setAppCmkArn(value: string): void {
    this.appCmkArn.set(value.trim());
  }

  setTagSet(value: Record<string, string>): void {
    this.tagSet.set(value);
  }

  setRetentionDays(value: number): void {
    this.retentionDays.set(value);
  }

  setNotificationTargetArn(value: string): void {
    this.notificationTargetArn.set(value.trim());
  }

  setCloudAwsDirectory(value: string): void {
    this.cloudAwsDirectory.set(value.trim());
  }

  setImageUri(value: string): void {
    this.imageUri.set(value.trim());
  }

  // The two endpoint fields have no setter on purpose: they are written by
  // endpoint discovery through `applyDiscoveredEndpoints` and rendered read-only
  // (Req 2.7). An operator typing a URL there would be claiming a deploy that
  // never happened.

  // ── Config generation ──────────────────────────────────────────────────────

  /**
   * Builds the `cdk.context.phorma.json` content as pretty JSON that a single
   * `JSON.parse` accepts with no preprocessing (Req 3.1).
   *
   * The provenance notice is the `$generatedBy` member rather than leading `//`
   * lines (Req 3.2). `cloud-aws/src/cli/config-file.ts` reads this file with one
   * bare `JSON.parse` - deliberately, so no second parser can grow there - and
   * `parseAwsDeployConfig` ignores unknown members, `$generatedBy` included. The
   * comment header this replaced made the Studio's own output unreadable to the
   * CLI that consumes it.
   *
   * Required fields are emitted even when empty, so the Config_Parser can name
   * the missing one; optional fields are omitted when empty, because a blank
   * `imageUri` is the asset-build path rather than a value.
   */
  buildConfigFile(): string {
    const config: Record<string, unknown> = {
      $generatedBy:
        'GENERATED BY PHORMA AGENT STUDIO - do not edit by hand. Written by Settings > Cloud, ' +
        'gitignored, and rewritten on every Plan and Deploy. Delete it to reset the configuration.',
      accountId: this.accountId(),
      region: this.region(),
      namePrefix: this.namePrefix(),
      permissionsBoundaryArn: this.permissionsBoundaryArn(),
      bootstrapQualifier: this.bootstrapQualifier() || undefined,
    };

    const cmkArn = this.appCmkArn();
    if (cmkArn) {
      config['appCmkArn'] = cmkArn;
    }

    const vpcId = this.vpcId();
    const subnetIds = this.subnetIds();
    if (vpcId && subnetIds.length > 0) {
      config['vpc'] = { id: vpcId, subnetIds };
    }

    config['egressAllowList'] = [];
    config['costAllocationTags'] = this.tagSet();
    config['retentionDays'] = this.retentionDays();
    config['alarmNotificationArn'] = this.notificationTargetArn();

    const imageUri = this.imageUri();
    if (imageUri) {
      config['imageUri'] = imageUri;
    }

    const triggerApiUrl = this.triggerApiUrl();
    if (triggerApiUrl) {
      config['triggerApiUrl'] = triggerApiUrl;
    }

    const monitorApiUrl = this.monitorApiUrl();
    if (monitorApiUrl) {
      config['monitorApiUrl'] = monitorApiUrl;
    }

    return `${JSON.stringify(config, null, 2)}\n`;
  }

  /**
   * Persists the endpoints a completed deploy reported (Req 9.2, 9.3).
   *
   * Called by `AwsCliService` after a deploy exits 0. The signal writes happen
   * inside `untracked()` because the caller can be reached from a reactive
   * context, and a consumer effect that re-entered this method would write the
   * same signals it reads - the loop that has already OOM'd the renderer once in
   * the settings dialog.
   *
   * Ordering is deliberate: both signals first, then the file write, because
   * `writeConfigFile()` serialises whatever the signals hold. Persistence to
   * localStorage rides the constructor effects rather than these writes, so the
   * awaited write is what guarantees the CLI reads the same two values on its
   * next invocation. Returns whether the file was written.
   */
  async applyDiscoveredEndpoints(endpoints: {
    triggerApiUrl: string;
    monitorApiUrl: string;
  }): Promise<boolean> {
    untracked(() => {
      this.triggerApiUrl.set(endpoints.triggerApiUrl.trim());
      this.monitorApiUrl.set(endpoints.monitorApiUrl.trim());
    });
    return await this.writeConfigFile();
  }

  /**
   * Writes the config file beside `cdk.json` in the configured cloud-aws
   * directory. Returns false (having thrown) when the write fails.
   */
  async writeConfigFile(): Promise<boolean> {
    const cwd = this.cloudAwsDirectory();
    if (!cwd) return false;
    const separator = cwd.includes('\\') ? '\\' : '/';
    const path = `${cwd.replace(/[\\/]$/, '')}${separator}${AWS_CONFIG_FILENAME}`;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('write_workflow_file', { path, content: this.buildConfigFile() });
      return true;
    } catch {
      return false;
    }
  }
}
