/**
 * Plan_Command and Deploy_Command Preflight.
 *
 * PURE decision layer - classifies describe responses from an injected backend
 * and a Docker probe result. `runPreflightChecks` performs no I/O of its own:
 * every outside fact reaches it through a port, so the check pipeline exercises
 * both the pass and the fail path with no AWS credentials and no Docker daemon
 * present.
 *
 * The production describe backend lives at the bottom of this file. It imports
 * `@aws-sdk/client-ec2` and `@aws-sdk/client-kms` DYNAMICALLY, inside the call,
 * so only the verbs that actually run a preflight (`plan`, `deploy`, `doctor`)
 * pay the load cost of those clients, and importing this module costs nothing.
 *
 * Runs AFTER credential-free config validation (core/config.ts) and BEFORE any
 * `cdk` step - `cdk synth` cannot see a missing Docker daemon, because a
 * `DockerImageAsset` only fingerprints its build context at synth time.
 *
 * Requirements: 4.5, 5.2, 5.3, 5.4, 10.13, 10.14, 11.13, 11.14
 */

import type { AwsDeployConfig } from '../core/config.js';
import { resolveContainerImage } from '../core/container-image.js';

// ---------------------------------------------------------------------------
// Describe backend interface - injected so tests can provide fakes
// ---------------------------------------------------------------------------

export interface DescribeVpcResult {
  exists: boolean;
}

export interface DescribeSubnetResult {
  exists: boolean;
  /** The VPC id the subnet belongs to, when the subnet exists. */
  vpcId?: string;
}

export interface DescribeSecurityGroupResult {
  exists: boolean;
}

export interface DescribeKeyResult {
  exists: boolean;
  enabled?: boolean;
}

/**
 * Backend that issues ec2:Describe* and kms:DescribeKey calls.
 * Implementations provide real AWS SDK calls or fake responses for testing.
 */
export interface PreflightDescribeBackend {
  describeVpc(vpcId: string, region: string): Promise<DescribeVpcResult>;
  describeSubnet(subnetId: string, region: string): Promise<DescribeSubnetResult>;
  describeSecurityGroup(sgId: string, region: string): Promise<DescribeSecurityGroupResult>;
  describeKey(keyArn: string, region: string): Promise<DescribeKeyResult>;
}

/**
 * Docker daemon reachability port (Req 4.5).
 *
 * A port rather than a `child_process` call, for two reasons: this module stays
 * pure, and the check pipeline can exercise the unreachable-daemon failure path
 * on a machine that has Docker running. The CLI layer owns the real
 * implementation, because it owns process access.
 */
export interface DockerProbe {
  available(): Promise<boolean>;
}

export interface PreflightOptions {
  /**
   * Docker daemon probe. Consulted on the container image ASSET path only:
   * when `imageUri` is set the deploy references a published image and builds
   * nothing, so a missing daemon is not a prerequisite at all. Omitting the
   * probe skips the check.
   */
  dockerProbe?: DockerProbe;
}

// ---------------------------------------------------------------------------
// Preflight result
// ---------------------------------------------------------------------------

export interface PreflightFailure {
  identifier: string;
  message: string;
}

export interface PreflightResult {
  passed: boolean;
  failures: PreflightFailure[];
}

// ---------------------------------------------------------------------------
// Platform request template items (Req 5.2)
// ---------------------------------------------------------------------------

/**
 * The `docs/deploy-aws.md` platform request template item that supplies each
 * AWS_Config_Field. Every failure line names one, so the operator returns to
 * the platform team with a single labelled request instead of a guess.
 */
export const PREREQUISITE_DOCS_ITEMS = {
  'vpc.id': 'docs/deploy-aws.md section 3.4 (VPC, subnets and endpoints)',
  'vpc.subnetIds': 'docs/deploy-aws.md section 3.4 (VPC, subnets and endpoints)',
  dataSourceSecurityGroupId:
    'docs/deploy-aws.md section 3.6 (Egress_Allow_List, data-source security group)',
  appCmkArn: 'docs/deploy-aws.md section 3.5 (App_CMK and key-policy grants)',
} as const;

/** Identifier carried by the Docker daemon failure (Req 4.5). */
export const DOCKER_FAILURE_IDENTIFIER = 'docker';

/** The Docker daemon failure line, verbatim (Req 4.5). */
export const DOCKER_UNAVAILABLE_MESSAGE =
  'Docker daemon unreachable. The deploy builds the container image from ' +
  'cloud-aws/Dockerfile. Start Docker, or set imageUri to a platform-published ' +
  'image (docs/deploy-aws.md section 3.8).';

/**
 * One failure line: the AWS_Config_Field, the supplied value, the target region
 * and the matching request-template item (Req 5.2).
 */
function prerequisiteFailure(
  field: keyof typeof PREREQUISITE_DOCS_ITEMS,
  value: string,
  region: string,
  problem: string,
): PreflightFailure {
  return {
    identifier: value,
    message:
      `${field} "${value}" ${problem} in region ${region}. ` +
      `Request it as ${PREREQUISITE_DOCS_ITEMS[field]}.`,
  };
}

// ---------------------------------------------------------------------------
// Pure decision function
// ---------------------------------------------------------------------------

/**
 * Evaluate the preflight checks against the provided probe and describe
 * responses.
 *
 * This is a pure function of the config, the Docker probe result and the
 * describe responses - no I/O of its own. Every failure it can detect is
 * reported in ONE run; it never returns early (Req 5.4).
 *
 * Checks performed:
 * 1. Docker daemon reachable, on the container image asset path only
 * 2. VPC exists in the configured region
 * 3. Each configured subnet exists and belongs to the declared VPC
 * 4. Each configured security group exists
 * 5. If an App_CMK ARN is configured, the key exists and is enabled
 */
export async function runPreflightChecks(
  config: AwsDeployConfig,
  backend: PreflightDescribeBackend,
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  const failures: PreflightFailure[] = [];

  // --- Docker daemon reachability, asset path only (Req 4.5) ---
  // Runs first so the operator learns before the long describe round trips,
  // and long before any `cdk` step. It is one more failure line, not an early
  // return: the AWS prerequisites are still all reported in this same run.
  const imageChoice = resolveContainerImage(config);
  if (imageChoice.kind === 'asset' && options.dockerProbe) {
    const dockerAvailable = await options.dockerProbe.available();
    if (!dockerAvailable) {
      failures.push({
        identifier: DOCKER_FAILURE_IDENTIFIER,
        message: DOCKER_UNAVAILABLE_MESSAGE,
      });
    }
  }

  // --- VPC existence ---
  if (config.vpc) {
    const vpcResult = await backend.describeVpc(config.vpc.id, config.region);
    if (!vpcResult.exists) {
      failures.push(
        prerequisiteFailure('vpc.id', config.vpc.id, config.region, 'does not exist'),
      );
    }

    // --- Subnet existence and VPC membership ---
    if (vpcResult.exists) {
      for (const subnetId of config.vpc.subnetIds) {
        const subnetResult = await backend.describeSubnet(subnetId, config.region);
        if (!subnetResult.exists) {
          failures.push(
            prerequisiteFailure('vpc.subnetIds', subnetId, config.region, 'does not exist'),
          );
        } else if (subnetResult.vpcId !== config.vpc.id) {
          failures.push(
            prerequisiteFailure(
              'vpc.subnetIds',
              subnetId,
              config.region,
              `is not a member of VPC "${config.vpc.id}"`,
            ),
          );
        }
      }
    }
  }

  // --- Security group existence ---
  if (config.dataSourceSecurityGroupId) {
    const sgResult = await backend.describeSecurityGroup(
      config.dataSourceSecurityGroupId,
      config.region,
    );
    if (!sgResult.exists) {
      failures.push(
        prerequisiteFailure(
          'dataSourceSecurityGroupId',
          config.dataSourceSecurityGroupId,
          config.region,
          'does not exist',
        ),
      );
    }
  }

  // --- App_CMK existence and enabled state ---
  if (config.appCmkArn) {
    const keyResult = await backend.describeKey(config.appCmkArn, config.region);
    if (!keyResult.exists) {
      failures.push(
        prerequisiteFailure('appCmkArn', config.appCmkArn, config.region, 'does not exist'),
      );
    } else if (!keyResult.enabled) {
      failures.push(
        prerequisiteFailure(
          'appCmkArn',
          config.appCmkArn,
          config.region,
          'exists but is not enabled',
        ),
      );
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Classify helper for the CLI shim
// ---------------------------------------------------------------------------

/**
 * Format preflight failures for console output and process exit.
 * Returns a non-empty string when checks fail, or empty string on success.
 */
export function formatPreflightFailures(result: PreflightResult): string {
  if (result.passed) return '';
  return result.failures
    .map(f => `Preflight check failed: ${f.message}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Production describe backend
// ---------------------------------------------------------------------------

/**
 * The real describe backend, issuing ec2:Describe* and kms:DescribeKey against
 * the configured region.
 *
 * `@aws-sdk/client-ec2` is large. Both clients are imported inside the call, so
 * constructing this backend loads nothing and importing this module loads
 * nothing: only `plan`, `deploy` and `doctor` pay for the clients. Nothing here
 * runs at module load, which is what keeps the credential-free, daemon-free
 * check pipeline able to import this file.
 */
export function createAwsDescribeBackend(): PreflightDescribeBackend {
  type Ec2 = Awaited<ReturnType<typeof ec2Client>>;
  const ec2ByRegion = new Map<string, Promise<Ec2>>();

  async function ec2Client(region: string) {
    const { EC2Client } = await import('@aws-sdk/client-ec2');
    return new EC2Client({ region });
  }

  /** One client per region, built on first use. */
  function ec2(region: string): Promise<Ec2> {
    const existing = ec2ByRegion.get(region);
    if (existing) return existing;
    const created = ec2Client(region);
    ec2ByRegion.set(region, created);
    return created;
  }

  return {
    async describeVpc(vpcId, region) {
      const { DescribeVpcsCommand } = await import('@aws-sdk/client-ec2');
      const client = await ec2(region);
      try {
        const res = await client.send(new DescribeVpcsCommand({ VpcIds: [vpcId] }));
        return { exists: (res.Vpcs?.length ?? 0) > 0 };
      } catch (err) {
        if (isNotFound(err, 'InvalidVpcID.NotFound')) return { exists: false };
        throw err;
      }
    },

    async describeSubnet(subnetId, region) {
      const { DescribeSubnetsCommand } = await import('@aws-sdk/client-ec2');
      const client = await ec2(region);
      try {
        const res = await client.send(new DescribeSubnetsCommand({ SubnetIds: [subnetId] }));
        const subnet = res.Subnets?.[0];
        if (!subnet) return { exists: false };
        return { exists: true, vpcId: subnet.VpcId };
      } catch (err) {
        if (isNotFound(err, 'InvalidSubnetID.NotFound')) return { exists: false };
        throw err;
      }
    },

    async describeSecurityGroup(sgId, region) {
      const { DescribeSecurityGroupsCommand } = await import('@aws-sdk/client-ec2');
      const client = await ec2(region);
      try {
        const res = await client.send(new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }));
        return { exists: (res.SecurityGroups?.length ?? 0) > 0 };
      } catch (err) {
        if (isNotFound(err, 'InvalidGroup.NotFound')) return { exists: false };
        throw err;
      }
    },

    async describeKey(keyArn, region) {
      const { KMSClient, DescribeKeyCommand } = await import('@aws-sdk/client-kms');
      const client = new KMSClient({ region });
      try {
        const res = await client.send(new DescribeKeyCommand({ KeyId: keyArn }));
        if (!res.KeyMetadata) return { exists: false };
        return { exists: true, enabled: res.KeyMetadata.Enabled === true };
      } catch (err) {
        if (isNotFound(err, 'NotFoundException')) return { exists: false };
        throw err;
      }
    },
  };
}

/**
 * A describe error that means "the resource is absent" rather than "the call
 * failed". Anything else propagates: an access denial must not read as a
 * missing prerequisite.
 */
function isNotFound(err: unknown, name: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === name
  );
}
