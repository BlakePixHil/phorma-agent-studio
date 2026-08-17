/**
 * Deployment configuration parse and validate.
 *
 * PURE - no AWS SDK import, no I/O. Every check runs with no AWS credentials
 * present, and runs before any construct is created so "SHALL create no
 * resource" holds by construction.
 *
 * Unknown members are ignored rather than rejected. `$generatedBy`, the
 * provenance notice the AWS_Config_Store writes into the Deploy_Config_File so
 * a bare `JSON.parse` accepts it (Req 3.2), reaches this parser on every load
 * and must not fail it.
 *
 * Requirements: 2.8, 2.9, 3.2, 10.3, 10.11, 11.2, 11.3, 11.9, 12.7, 13.5, 13.8
 */

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Deployment_Identity trust configuration (Req 15.7).
 * Exactly one of `identityCenter`, `githubOidc` or both must be present.
 * An empty object (neither field) fails synthesis.
 */
export interface DeployTrustConfig {
  /** IAM Identity Center permission set ARN. */
  identityCenter?: { permissionSetArn: string };
  /** GitHub OIDC provider with repository, branch and environment conditions. */
  githubOidc?: {
    providerArn: string;
    repository: string;
    branch: string;
    environment?: string;
  };
}

export interface AwsDeployConfig {
  /** Exactly 12 digits. */
  accountId: string;
  /** Region_Pin - syntactically valid AWS region identifier. */
  region: string;
  /** 1-32 chars of [a-z0-9-]. Used to name stacks and resources distinctly. */
  namePrefix: string;
  /** Required IAM permissions boundary ARN. Absent fails synthesis. */
  permissionsBoundaryArn: string;
  /** CDK bootstrap qualifier. Non-empty string. */
  bootstrapQualifier: string;
  /** Optional existing KMS key ARN. When absent the IaC_App creates one. */
  appCmkArn?: string;
  /** Optional existing VPC with subnets. When absent the IaC_App creates one. */
  vpc?: { id: string; subnetIds: string[] };
  /** Optional data-source security group id. */
  dataSourceSecurityGroupId?: string;
  /** Derived egress allow-list - array of hostnames. */
  egressAllowList: string[];
  /** Cost-allocation tags. Non-empty keys and values required. */
  costAllocationTags: Record<string, string>;
  /** 1-366 whole days, default 30. */
  retentionDays: number;
  /** Required SNS topic ARN for alarm notifications. */
  alarmNotificationArn: string;
  /**
   * Optional platform-published Container_Image reference (Req 4.1, 4.2).
   * Absent, blank or whitespace-only means build the image from
   * `cloud-aws/Dockerfile` - see `resolveContainerImage` in
   * `core/container-image.ts`. A blank value parses to `undefined`.
   */
  imageUri?: string;
  /**
   * Discovered Trigger_API base URL, written by endpoint discovery after a
   * deploy (Req 9.2). `https` only, no query, fragment or trailing slash - the
   * Studio joins route paths onto it. A blank value parses to `undefined`.
   */
  triggerApiUrl?: string;
  /**
   * Discovered Monitor_API WebSocket URL, written by endpoint discovery after a
   * deploy (Req 9.2). `wss` only, no query or fragment. The stage path (`/live`)
   * is part of the value. A blank value parses to `undefined`.
   */
  monitorApiUrl?: string;
  /**
   * Deployment_Identity trust policy configuration (Req 15.7).
   * At least one of `identityCenter` or `githubOidc` must be present.
   * An empty object fails synthesis.
   */
  deployTrust?: DeployTrustConfig;
}

// ---------------------------------------------------------------------------
// Validation patterns
// ---------------------------------------------------------------------------

const ACCOUNT_ID_RE = /^\d{12}$/;

/**
 * AWS region pattern: 2-3 letter geo, a dash, a direction or qualifier, a dash
 * and a digit. Examples: us-east-1, eu-west-2, ap-southeast-1, me-south-1,
 * af-south-1, il-central-1, ca-west-1.
 */
const REGION_RE = /^[a-z]{2,3}-[a-z]+-\d{1,2}$/;

const NAME_PREFIX_RE = /^[a-z0-9-]{1,32}$/;

/**
 * IAM policy ARN shape:
 * arn:aws:iam::<account-or-aws>:policy/<path>
 */
const IAM_POLICY_ARN_RE = /^arn:aws:iam::[0-9]{12}:policy\/.+$/;

/**
 * KMS key ARN shape:
 * arn:aws:kms:<region>:<account>:key/<key-id>
 */
const KMS_KEY_ARN_RE = /^arn:aws:kms:([a-z]{2,3}-[a-z]+-\d{1,2}):\d{12}:key\/.+$/;

const VPC_ID_RE = /^vpc-[0-9a-f]+$/;
const SUBNET_ID_RE = /^subnet-[0-9a-f]+$/;
const SG_ID_RE = /^sg-[0-9a-f]+$/;

/**
 * SNS topic ARN shape:
 * arn:aws:sns:<region>:<account>:<topic-name>
 */
const SNS_TOPIC_ARN_RE = /^arn:aws:sns:[a-z]{2,3}-[a-z]+-\d{1,2}:\d{12}:.+$/;

/**
 * OCI image reference:
 * `{registry}[:{port}]/{repository}:{tag}` or
 * `{registry}[:{port}]/{repository}@sha256:{digest}`
 *
 * Registry host and repository path are lowercase-only, which is what OCI
 * requires - a mixed-case repository is rejected by the registry, not accepted
 * and folded. The tag half allows mixed case; the digest half is 64 lowercase
 * hex characters. The Studio's AWS_Config_Store enforces this same pattern
 * (Req 2.6, 2.8), so a value the form accepted always parses here.
 */
const IMAGE_URI_RE =
  /^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._/-]+)+(:[A-Za-z0-9._-]{1,128}|@sha256:[a-f0-9]{64})$/;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Parse and validate a raw deployment configuration object. Throws a
 * descriptive error on the first invalid field encountered. All checks are
 * reachable with no AWS credentials present.
 */
export function parseAwsDeployConfig(raw: unknown): AwsDeployConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('Configuration must be a non-null object.');
  }

  const obj = raw as Record<string, unknown>;

  // --- accountId ---
  const accountId = requireString(obj, 'accountId');
  if (!ACCOUNT_ID_RE.test(accountId)) {
    throw new ConfigError(
      `accountId must be exactly 12 digits, got "${accountId}".`,
    );
  }

  // --- region ---
  const region = requireString(obj, 'region');
  if (!REGION_RE.test(region)) {
    throw new ConfigError(
      `region must be a syntactically valid AWS region (e.g. us-east-1), got "${region}".`,
    );
  }

  // --- namePrefix ---
  const namePrefix = requireString(obj, 'namePrefix');
  if (!NAME_PREFIX_RE.test(namePrefix)) {
    throw new ConfigError(
      `namePrefix must be 1-32 characters of [a-z0-9-], got "${namePrefix}".`,
    );
  }

  // --- permissionsBoundaryArn (Req 13.5) ---
  const permissionsBoundaryArn = requireString(obj, 'permissionsBoundaryArn');
  if (!IAM_POLICY_ARN_RE.test(permissionsBoundaryArn)) {
    throw new ConfigError(
      `permissionsBoundaryArn must be a valid IAM policy ARN (arn:aws:iam::<account>:policy/<name>), got "${permissionsBoundaryArn}".`,
    );
  }

  // --- bootstrapQualifier ---
  const bootstrapQualifier = requireString(obj, 'bootstrapQualifier');
  if (bootstrapQualifier.length === 0) {
    throw new ConfigError('bootstrapQualifier must be a non-empty string.');
  }

  // --- appCmkArn (optional, Req 11.2, 11.9) ---
  let appCmkArn: string | undefined;
  if (obj.appCmkArn !== undefined && obj.appCmkArn !== null) {
    if (typeof obj.appCmkArn !== 'string') {
      throw new ConfigError('appCmkArn must be a string when provided.');
    }
    const cmkArn = obj.appCmkArn;
    const cmkMatch = KMS_KEY_ARN_RE.exec(cmkArn);
    if (!cmkMatch) {
      throw new ConfigError(
        `appCmkArn must be a valid KMS key ARN (arn:aws:kms:<region>:<account>:key/<id>), got "${cmkArn}".`,
      );
    }
    const cmkRegion = cmkMatch[1];
    if (cmkRegion !== region) {
      throw new ConfigError(
        `appCmkArn region "${cmkRegion}" does not match the configured region "${region}".`,
      );
    }
    appCmkArn = cmkArn;
  }

  // --- vpc (optional, Req 10.3, 10.11) ---
  let vpc: { id: string; subnetIds: string[] } | undefined;
  if (obj.vpc !== undefined && obj.vpc !== null) {
    if (typeof obj.vpc !== 'object' || Array.isArray(obj.vpc)) {
      throw new ConfigError('vpc must be an object with id and subnetIds.');
    }
    const vpcObj = obj.vpc as Record<string, unknown>;

    const vpcId = requireString(vpcObj, 'id', 'vpc.id');
    if (!VPC_ID_RE.test(vpcId)) {
      throw new ConfigError(
        `vpc.id must match vpc-[0-9a-f]+, got "${vpcId}".`,
      );
    }

    if (!Array.isArray(vpcObj.subnetIds)) {
      throw new ConfigError('vpc.subnetIds must be an array of subnet id strings.');
    }
    const subnetIds = vpcObj.subnetIds as unknown[];
    if (subnetIds.length === 0) {
      throw new ConfigError('vpc.subnetIds must contain at least one subnet id.');
    }
    const validatedSubnets: string[] = [];
    for (let i = 0; i < subnetIds.length; i++) {
      const sid = subnetIds[i];
      if (typeof sid !== 'string') {
        throw new ConfigError(`vpc.subnetIds[${i}] must be a string.`);
      }
      if (!SUBNET_ID_RE.test(sid)) {
        throw new ConfigError(
          `vpc.subnetIds[${i}] must match subnet-[0-9a-f]+, got "${sid}".`,
        );
      }
      validatedSubnets.push(sid);
    }

    vpc = { id: vpcId, subnetIds: validatedSubnets };
  }

  // --- dataSourceSecurityGroupId (optional) ---
  let dataSourceSecurityGroupId: string | undefined;
  if (
    obj.dataSourceSecurityGroupId !== undefined &&
    obj.dataSourceSecurityGroupId !== null
  ) {
    if (typeof obj.dataSourceSecurityGroupId !== 'string') {
      throw new ConfigError('dataSourceSecurityGroupId must be a string when provided.');
    }
    if (!SG_ID_RE.test(obj.dataSourceSecurityGroupId)) {
      throw new ConfigError(
        `dataSourceSecurityGroupId must match sg-[0-9a-f]+, got "${obj.dataSourceSecurityGroupId}".`,
      );
    }
    dataSourceSecurityGroupId = obj.dataSourceSecurityGroupId;
  }

  // --- egressAllowList ---
  if (!Array.isArray(obj.egressAllowList)) {
    throw new ConfigError('egressAllowList must be an array of hostname strings.');
  }
  const egressAllowList: string[] = [];
  for (let i = 0; i < (obj.egressAllowList as unknown[]).length; i++) {
    const host = (obj.egressAllowList as unknown[])[i];
    if (typeof host !== 'string' || host.length === 0) {
      throw new ConfigError(
        `egressAllowList[${i}] must be a non-empty hostname string.`,
      );
    }
    egressAllowList.push(host);
  }

  // --- costAllocationTags (Req 12.7) ---
  if (
    obj.costAllocationTags === null ||
    typeof obj.costAllocationTags !== 'object' ||
    Array.isArray(obj.costAllocationTags)
  ) {
    throw new ConfigError(
      'costAllocationTags must be a non-null object with non-empty string keys and values.',
    );
  }
  const rawTags = obj.costAllocationTags as Record<string, unknown>;
  const tagKeys = Object.keys(rawTags);
  if (tagKeys.length === 0) {
    throw new ConfigError(
      'costAllocationTags must contain at least one tag. A deployment with no cost-allocation tags fails synthesis.',
    );
  }
  const costAllocationTags: Record<string, string> = {};
  for (const key of tagKeys) {
    if (key.length === 0) {
      throw new ConfigError(
        'costAllocationTags keys must be non-empty strings.',
      );
    }
    const val = rawTags[key];
    if (typeof val !== 'string' || val.length === 0) {
      throw new ConfigError(
        `costAllocationTags["${key}"] must be a non-empty string value.`,
      );
    }
    costAllocationTags[key] = val;
  }

  // --- retentionDays (Req 11.5) ---
  let retentionDays = 30; // default
  if (obj.retentionDays !== undefined && obj.retentionDays !== null) {
    if (typeof obj.retentionDays !== 'number') {
      throw new ConfigError('retentionDays must be a number.');
    }
    if (
      !Number.isInteger(obj.retentionDays) ||
      obj.retentionDays < 1 ||
      obj.retentionDays > 366
    ) {
      throw new ConfigError(
        `retentionDays must be a whole integer between 1 and 366, got ${obj.retentionDays}.`,
      );
    }
    retentionDays = obj.retentionDays;
  }

  // --- alarmNotificationArn (Req 12.5) ---
  const alarmNotificationArn = requireString(obj, 'alarmNotificationArn');
  if (!SNS_TOPIC_ARN_RE.test(alarmNotificationArn)) {
    throw new ConfigError(
      `alarmNotificationArn must be a valid SNS topic ARN (arn:aws:sns:<region>:<account>:<name>), got "${alarmNotificationArn}".`,
    );
  }

  // --- imageUri (optional, Req 2.8) ---
  const imageUri = readOptionalString(obj, 'imageUri');
  if (imageUri !== undefined && !IMAGE_URI_RE.test(imageUri)) {
    throw new ConfigError(
      `imageUri must be an OCI image reference of the form {registry}/{repository}:{tag} or {registry}/{repository}@sha256:{digest}, with a lowercase registry and repository, got "${imageUri}".`,
    );
  }

  // --- triggerApiUrl (optional, Req 2.8, 2.9) ---
  const triggerApiUrl = readOptionalString(obj, 'triggerApiUrl');
  if (triggerApiUrl !== undefined && !isEndpointUrl(triggerApiUrl, 'https:', false)) {
    throw new ConfigError(
      `triggerApiUrl must be an https URL with no query, fragment or trailing slash (e.g. https://abc123.execute-api.eu-west-1.amazonaws.com), got "${triggerApiUrl}".`,
    );
  }

  // --- monitorApiUrl (optional, Req 2.8, 2.9) ---
  const monitorApiUrl = readOptionalString(obj, 'monitorApiUrl');
  if (monitorApiUrl !== undefined && !isEndpointUrl(monitorApiUrl, 'wss:', true)) {
    throw new ConfigError(
      `monitorApiUrl must be a wss URL with no query or fragment (e.g. wss://def456.execute-api.eu-west-1.amazonaws.com/live), got "${monitorApiUrl}".`,
    );
  }

  return {
    accountId,
    region,
    namePrefix,
    permissionsBoundaryArn,
    bootstrapQualifier,
    appCmkArn,
    vpc,
    dataSourceSecurityGroupId,
    egressAllowList,
    costAllocationTags,
    retentionDays,
    alarmNotificationArn,
    imageUri,
    triggerApiUrl,
    monitorApiUrl,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireString(
  obj: Record<string, unknown>,
  field: string,
  displayName?: string,
): string {
  const label = displayName ?? field;
  const value = obj[field];
  if (typeof value !== 'string') {
    throw new ConfigError(`${label} is required and must be a string.`);
  }
  if (value.length === 0) {
    throw new ConfigError(`${label} must be a non-empty string.`);
  }
  return value;
}

/**
 * Read an optional string field, treating absent, null, empty and
 * whitespace-only alike as ABSENT.
 *
 * A cleared form field serializes as `""`, so an empty string is an operator
 * slip rather than a value - the same reading `resolveContainerImage` applies to
 * `imageUri`. Nothing is trimmed beyond that blank check: a non-blank value must
 * match its documented shape exactly, so `" https://x "` is reported rather than
 * silently repaired. The AWS_Config_Store persists trimmed values (Req 2.2), so
 * only a hand-edited Deploy_Config_File can hit that case.
 */
function readOptionalString(
  obj: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = obj[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ConfigError(`${field} must be a string when provided.`);
  }
  if (value.trim().length === 0) {
    return undefined;
  }
  return value;
}

/**
 * Endpoint URL shape check: parses as a URL, scheme exactly `scheme`, no query,
 * no fragment, no surrounding whitespace, and - unless `allowTrailingSlash` - no
 * trailing slash.
 *
 * `?`, `#` and surrounding whitespace are checked against the supplied string
 * rather than the parsed URL, because the URL parser normalizes all three away
 * (`new URL(' https://a.com? ')` reports an empty `search`). The trailing-slash
 * rule matters for the Trigger_API base: the Studio joins route paths onto it,
 * and a trailing slash would produce a double slash.
 */
function isEndpointUrl(
  value: string,
  scheme: 'https:' | 'wss:',
  allowTrailingSlash: boolean,
): boolean {
  if (value !== value.trim()) {
    return false;
  }
  if (value.includes('?') || value.includes('#')) {
    return false;
  }
  if (!allowTrailingSlash && value.endsWith('/')) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === scheme;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
