/**
 * Unit tests for Plan_Command existence preflight.
 *
 * Requirements: 10.13, 10.14, 11.13, 11.14
 */

import { describe, it, expect } from 'vitest';
import {
  runPreflightChecks,
  formatPreflightFailures,
  PREREQUISITE_DOCS_ITEMS,
  DOCKER_FAILURE_IDENTIFIER,
  DOCKER_UNAVAILABLE_MESSAGE,
  type PreflightDescribeBackend,
  type DescribeVpcResult,
  type DescribeSubnetResult,
  type DescribeSecurityGroupResult,
  type DescribeKeyResult,
} from './preflight.js';
import type { AwsDeployConfig } from '../core/config.js';

// ---------------------------------------------------------------------------
// Fake backend
// ---------------------------------------------------------------------------

function createFakeBackend(overrides: {
  vpcs?: Record<string, DescribeVpcResult>;
  subnets?: Record<string, DescribeSubnetResult>;
  securityGroups?: Record<string, DescribeSecurityGroupResult>;
  keys?: Record<string, DescribeKeyResult>;
} = {}): PreflightDescribeBackend {
  return {
    async describeVpc(vpcId) {
      return overrides.vpcs?.[vpcId] ?? { exists: false };
    },
    async describeSubnet(subnetId) {
      return overrides.subnets?.[subnetId] ?? { exists: false };
    },
    async describeSecurityGroup(sgId) {
      return overrides.securityGroups?.[sgId] ?? { exists: false };
    },
    async describeKey(keyArn) {
      return overrides.keys?.[keyArn] ?? { exists: false };
    },
  };
}

function baseConfig(overrides: Partial<AwsDeployConfig> = {}): AwsDeployConfig {
  return {
    accountId: '123456789012',
    region: 'us-east-1',
    namePrefix: 'test',
    permissionsBoundaryArn: 'arn:aws:iam::123456789012:policy/boundary',
    bootstrapQualifier: 'hnb659fds',
    egressAllowList: [],
    costAllocationTags: { app: 'phorma' },
    retentionDays: 30,
    alarmNotificationArn: 'arn:aws:sns:us-east-1:123456789012:alarms',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// VPC existence
// ---------------------------------------------------------------------------

describe('preflight - VPC existence', () => {
  it('passes when no VPC is configured', async () => {
    const config = baseConfig();
    const backend = createFakeBackend();
    const result = await runPreflightChecks(config, backend);
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('passes when configured VPC exists', async () => {
    const config = baseConfig({ vpc: { id: 'vpc-abc123', subnetIds: ['subnet-aaa'] } });
    const backend = createFakeBackend({
      vpcs: { 'vpc-abc123': { exists: true } },
      subnets: { 'subnet-aaa': { exists: true, vpcId: 'vpc-abc123' } },
    });
    const result = await runPreflightChecks(config, backend);
    expect(result.passed).toBe(true);
  });

  it('fails when configured VPC does not exist', async () => {
    const config = baseConfig({ vpc: { id: 'vpc-missing', subnetIds: ['subnet-aaa'] } });
    const backend = createFakeBackend({
      vpcs: { 'vpc-missing': { exists: false } },
    });
    const result = await runPreflightChecks(config, backend);
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].identifier).toBe('vpc-missing');
    expect(result.failures[0].message).toContain('vpc-missing');
  });
});

// ---------------------------------------------------------------------------
// Subnet existence and VPC membership
// ---------------------------------------------------------------------------

describe('preflight - subnet existence and membership', () => {
  it('fails when a configured subnet does not exist', async () => {
    const config = baseConfig({ vpc: { id: 'vpc-abc123', subnetIds: ['subnet-missing'] } });
    const backend = createFakeBackend({
      vpcs: { 'vpc-abc123': { exists: true } },
      subnets: { 'subnet-missing': { exists: false } },
    });
    const result = await runPreflightChecks(config, backend);
    expect(result.passed).toBe(false);
    expect(result.failures[0].identifier).toBe('subnet-missing');
  });

  it('fails when a configured subnet belongs to a different VPC', async () => {
    const config = baseConfig({ vpc: { id: 'vpc-abc123', subnetIds: ['subnet-wrong'] } });
    const backend = createFakeBackend({
      vpcs: { 'vpc-abc123': { exists: true } },
      subnets: { 'subnet-wrong': { exists: true, vpcId: 'vpc-other999' } },
    });
    const result = await runPreflightChecks(config, backend);
    expect(result.passed).toBe(false);
    expect(result.failures[0].identifier).toBe('subnet-wrong');
    expect(result.failures[0].message).toContain('not a member');
  });

  it('reports multiple subnet failures', async () => {
    const config = baseConfig({
      vpc: { id: 'vpc-abc123', subnetIds: ['subnet-a', 'subnet-b'] },
    });
    const backend = createFakeBackend({
      vpcs: { 'vpc-abc123': { exists: true } },
      subnets: {
        'subnet-a': { exists: false },
        'subnet-b': { exists: true, vpcId: 'vpc-other' },
      },
    });
    const result = await runPreflightChecks(config, backend);
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Security group existence
// ---------------------------------------------------------------------------

describe('preflight - security group existence', () => {
  it('passes when no security group is configured', async () => {
    const config = baseConfig();
    const backend = createFakeBackend();
    const result = await runPreflightChecks(config, backend);
    expect(result.passed).toBe(true);
  });

  it('passes when configured security group exists', async () => {
    const config = baseConfig({ dataSourceSecurityGroupId: 'sg-abc123' });
    const backend = createFakeBackend({
      securityGroups: { 'sg-abc123': { exists: true } },
    });
    const result = await runPreflightChecks(config, backend);
    expect(result.passed).toBe(true);
  });

  it('fails when configured security group does not exist', async () => {
    const config = baseConfig({ dataSourceSecurityGroupId: 'sg-missing' });
    const backend = createFakeBackend({
      securityGroups: { 'sg-missing': { exists: false } },
    });
    const result = await runPreflightChecks(config, backend);
    expect(result.passed).toBe(false);
    expect(result.failures[0].identifier).toBe('sg-missing');
  });
});

// ---------------------------------------------------------------------------
// App_CMK existence
// ---------------------------------------------------------------------------

describe('preflight - App_CMK existence', () => {
  it('passes when no App_CMK is configured', async () => {
    const config = baseConfig();
    const backend = createFakeBackend();
    const result = await runPreflightChecks(config, backend);
    expect(result.passed).toBe(true);
  });

  it('passes when configured App_CMK exists and is enabled', async () => {
    const arn = 'arn:aws:kms:us-east-1:123456789012:key/test-key-id';
    const config = baseConfig({ appCmkArn: arn });
    const backend = createFakeBackend({
      keys: { [arn]: { exists: true, enabled: true } },
    });
    const result = await runPreflightChecks(config, backend);
    expect(result.passed).toBe(true);
  });

  it('fails when configured App_CMK does not exist', async () => {
    const arn = 'arn:aws:kms:us-east-1:123456789012:key/missing-key';
    const config = baseConfig({ appCmkArn: arn });
    const backend = createFakeBackend({
      keys: { [arn]: { exists: false } },
    });
    const result = await runPreflightChecks(config, backend);
    expect(result.passed).toBe(false);
    expect(result.failures[0].identifier).toBe(arn);
    expect(result.failures[0].message).toContain('appCmkArn');
  });

  it('fails when configured App_CMK exists but is not enabled', async () => {
    const arn = 'arn:aws:kms:us-east-1:123456789012:key/disabled-key';
    const config = baseConfig({ appCmkArn: arn });
    const backend = createFakeBackend({
      keys: { [arn]: { exists: true, enabled: false } },
    });
    const result = await runPreflightChecks(config, backend);
    expect(result.passed).toBe(false);
    expect(result.failures[0].identifier).toBe(arn);
  });
});

// ---------------------------------------------------------------------------
// Combined checks
// ---------------------------------------------------------------------------

describe('preflight - combined', () => {
  it('collects failures from all check categories', async () => {
    const arn = 'arn:aws:kms:us-east-1:123456789012:key/bad-key';
    const config = baseConfig({
      vpc: { id: 'vpc-missing', subnetIds: ['subnet-a'] },
      dataSourceSecurityGroupId: 'sg-missing',
      appCmkArn: arn,
    });
    const backend = createFakeBackend({
      vpcs: { 'vpc-missing': { exists: false } },
      securityGroups: { 'sg-missing': { exists: false } },
      keys: { [arn]: { exists: false } },
    });
    const result = await runPreflightChecks(config, backend);
    expect(result.passed).toBe(false);
    // VPC not found + SG not found + key not found (subnets not checked when VPC absent)
    expect(result.failures.length).toBeGreaterThanOrEqual(3);
  });

  it('passes when everything exists and is valid', async () => {
    const arn = 'arn:aws:kms:us-east-1:123456789012:key/good-key';
    const config = baseConfig({
      vpc: { id: 'vpc-good', subnetIds: ['subnet-a', 'subnet-b'] },
      dataSourceSecurityGroupId: 'sg-good',
      appCmkArn: arn,
    });
    const backend = createFakeBackend({
      vpcs: { 'vpc-good': { exists: true } },
      subnets: {
        'subnet-a': { exists: true, vpcId: 'vpc-good' },
        'subnet-b': { exists: true, vpcId: 'vpc-good' },
      },
      securityGroups: { 'sg-good': { exists: true } },
      keys: { [arn]: { exists: true, enabled: true } },
    });
    const result = await runPreflightChecks(config, backend);
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// formatPreflightFailures
// ---------------------------------------------------------------------------

describe('formatPreflightFailures', () => {
  it('returns empty string on pass', () => {
    expect(formatPreflightFailures({ passed: true, failures: [] })).toBe('');
  });

  it('formats failures as preflight check messages', () => {
    const output = formatPreflightFailures({
      passed: false,
      failures: [
        { identifier: 'vpc-bad', message: 'VPC "vpc-bad" does not exist.' },
        { identifier: 'sg-bad', message: 'SG "sg-bad" does not exist.' },
      ],
    });
    expect(output).toContain('Preflight check failed');
    expect(output).toContain('vpc-bad');
    expect(output).toContain('sg-bad');
    expect(output.split('\n')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Property 29 (preflight half): The Plan_Command catches every non-existence
// ---------------------------------------------------------------------------

import fc from 'fast-check';

/**
 * Property 29: Synthesis fails on any policy violation it can see, and the
 * Plan_Command catches every non-existence (preflight half).
 *
 * **Validates: Requirements 9.5, 9.7, 9.11, 10.3, 10.11, 10.13, 10.14, 11.1,
 * 11.2, 11.3, 11.9, 11.13, 11.14, 12.5, 12.6, 12.7, 13.4, 13.6, 13.7, 15.8**
 *
 * For any configuration whose identifiers are well formed and any set of
 * describe responses:
 * - When a resource does not exist, the preflight catches it (returns
 *   passed=false with a failure naming the identifier)
 * - When all resources exist with valid membership, the preflight passes
 * - The result is deterministic for the same inputs
 */
describe('preflight - Property 29: Plan_Command catches every non-existence', () => {
  // --- Generators ---

  /** Generate a random hex string of the given length. */
  const hexStr = (len: number) =>
    fc.array(fc.constantFrom(...'0123456789abcdef'.split('')), {
      minLength: len,
      maxLength: len,
    }).map(chars => chars.join(''));

  /** Generate a valid VPC id. */
  const vpcIdArb = hexStr(8).map(h => `vpc-${h}`);

  /** Generate a valid subnet id. */
  const subnetIdArb = hexStr(8).map(h => `subnet-${h}`);

  /** Generate a valid security group id. */
  const sgIdArb = hexStr(8).map(h => `sg-${h}`);

  /** Generate a valid KMS key ARN in us-east-1. */
  const kmsKeyArnArb = fc
    .tuple(
      fc.array(fc.constantFrom(...'0123456789'.split('')), { minLength: 12, maxLength: 12 }).map(a => a.join('')),
      hexStr(8),
    )
    .map(([acct, keyId]) => `arn:aws:kms:us-east-1:${acct}:key/${keyId}`);

  /** Generate a config with random optional resources present/absent. */
  const configWithResourcesArb = fc.record({
    hasVpc: fc.boolean(),
    vpcId: vpcIdArb,
    subnetIds: fc.array(subnetIdArb, { minLength: 1, maxLength: 4 }),
    hasSg: fc.boolean(),
    sgId: sgIdArb,
    hasCmk: fc.boolean(),
    cmkArn: kmsKeyArnArb,
  });

  /**
   * For each resource in the config, generate a boolean indicating whether
   * the describe response says it exists.
   */
  const existenceMapArb = fc.record({
    vpcExists: fc.boolean(),
    subnetExists: fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }),
    subnetBelongsToVpc: fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }),
    sgExists: fc.boolean(),
    cmkExists: fc.boolean(),
    cmkEnabled: fc.boolean(),
  });

  function buildScenario(resources: {
    hasVpc: boolean;
    vpcId: string;
    subnetIds: string[];
    hasSg: boolean;
    sgId: string;
    hasCmk: boolean;
    cmkArn: string;
  }, existence: {
    vpcExists: boolean;
    subnetExists: boolean[];
    subnetBelongsToVpc: boolean[];
    sgExists: boolean;
    cmkExists: boolean;
    cmkEnabled: boolean;
  }) {
    const config = baseConfig({
      vpc: resources.hasVpc
        ? { id: resources.vpcId, subnetIds: resources.subnetIds }
        : undefined,
      dataSourceSecurityGroupId: resources.hasSg ? resources.sgId : undefined,
      appCmkArn: resources.hasCmk ? resources.cmkArn : undefined,
    });

    const vpcs: Record<string, DescribeVpcResult> = {};
    const subnets: Record<string, DescribeSubnetResult> = {};
    const securityGroups: Record<string, DescribeSecurityGroupResult> = {};
    const keys: Record<string, DescribeKeyResult> = {};

    // Expected non-existent identifiers
    const expectedMissing = new Set<string>();

    if (resources.hasVpc) {
      vpcs[resources.vpcId] = { exists: existence.vpcExists };
      if (!existence.vpcExists) {
        expectedMissing.add(resources.vpcId);
      }

      // Subnets are only checked when VPC exists
      if (existence.vpcExists) {
        for (let i = 0; i < resources.subnetIds.length; i++) {
          const sid = resources.subnetIds[i];
          const sExists = existence.subnetExists[i % existence.subnetExists.length];
          const belongsToVpc = existence.subnetBelongsToVpc[i % existence.subnetBelongsToVpc.length];
          subnets[sid] = {
            exists: sExists,
            vpcId: sExists ? (belongsToVpc ? resources.vpcId : 'vpc-other999') : undefined,
          };
          if (!sExists || !belongsToVpc) {
            expectedMissing.add(sid);
          }
        }
      }
    }

    if (resources.hasSg) {
      securityGroups[resources.sgId] = { exists: existence.sgExists };
      if (!existence.sgExists) {
        expectedMissing.add(resources.sgId);
      }
    }

    if (resources.hasCmk) {
      keys[resources.cmkArn] = { exists: existence.cmkExists, enabled: existence.cmkEnabled };
      if (!existence.cmkExists || !existence.cmkEnabled) {
        expectedMissing.add(resources.cmkArn);
      }
    }

    const backend = createFakeBackend({ vpcs, subnets, securityGroups, keys });
    return { config, backend, expectedMissing };
  }

  it('every non-existent resource produces a failure naming its identifier', async () => {
    await fc.assert(
      fc.asyncProperty(
        configWithResourcesArb,
        existenceMapArb,
        async (resources, existence) => {
          const { config, backend, expectedMissing } = buildScenario(resources, existence);
          const result = await runPreflightChecks(config, backend);

          // Every expected missing identifier MUST appear in the failures
          const failedIdentifiers = new Set(result.failures.map(f => f.identifier));
          for (const id of expectedMissing) {
            expect(failedIdentifiers.has(id)).toBe(true);
          }

          // If there are expected failures, result must not pass
          if (expectedMissing.size > 0) {
            expect(result.passed).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('passes when all configured resources exist with valid membership', async () => {
    await fc.assert(
      fc.asyncProperty(
        configWithResourcesArb,
        async (resources) => {
          // Build a scenario where everything exists and is valid
          const allExist = {
            vpcExists: true,
            subnetExists: resources.subnetIds.map(() => true),
            subnetBelongsToVpc: resources.subnetIds.map(() => true),
            sgExists: true,
            cmkExists: true,
            cmkEnabled: true,
          };
          const { config, backend, expectedMissing } = buildScenario(resources, allExist);

          // No missing resources expected
          expect(expectedMissing.size).toBe(0);

          const result = await runPreflightChecks(config, backend);
          expect(result.passed).toBe(true);
          expect(result.failures).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('result is deterministic for the same inputs', async () => {
    await fc.assert(
      fc.asyncProperty(
        configWithResourcesArb,
        existenceMapArb,
        async (resources, existence) => {
          const { config, backend } = buildScenario(resources, existence);

          // Run twice with the same inputs
          const result1 = await runPreflightChecks(config, backend);
          const result2 = await runPreflightChecks(config, backend);

          // Both results must be identical
          expect(result1.passed).toBe(result2.passed);
          expect(result1.failures.length).toBe(result2.failures.length);
          for (let i = 0; i < result1.failures.length; i++) {
            expect(result1.failures[i].identifier).toBe(result2.failures[i].identifier);
            expect(result1.failures[i].message).toBe(result2.failures[i].message);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Feature: aws-byo-deploy, Property 7: Preflight reports every failure, each
// naming its prerequisite
// ---------------------------------------------------------------------------

/**
 * Property 7: Preflight reports every failure, each naming its prerequisite.
 *
 * **Validates: Requirements 5.2, 5.3, 5.4**
 *
 * For any subset of the checked prerequisites marked absent or disabled, the
 * failure identifier set equals that subset EXACTLY (nothing dropped, nothing
 * invented), `passed` is true only for the empty subset, and every failure line
 * names the AWS_Config_Field, the supplied value, the target region and the
 * matching `docs/deploy-aws.md` request-template item.
 *
 * The expected set is derived from the implementation's check STRUCTURE, not
 * from independent per-resource flags: subnets are only described when the VPC
 * exists, so a plan that marks both the VPC and a subnet absent must expect one
 * failure, not two. Modelling those as independent would make the property
 * wrong rather than the code.
 */
describe('preflight - Property 7: every failure reported, each naming its prerequisite', () => {
  type PrerequisiteField = keyof typeof PREREQUISITE_DOCS_ITEMS;

  interface SubnetPlan {
    id: string;
    /** `wrong-vpc`: the subnet exists but belongs to another VPC. */
    mode: 'ok' | 'absent' | 'wrong-vpc';
  }

  interface PrerequisitePlan {
    region: string;
    vpc?: { id: string; mode: 'ok' | 'absent'; subnets: SubnetPlan[] };
    sg?: { id: string; mode: 'ok' | 'absent' };
    /** `disabled`: the key exists but its enabled state is false. */
    cmk?: { account: string; keyId: string; mode: 'ok' | 'absent' | 'disabled' };
  }

  /** A VPC id no generated VPC id can equal - generated ids carry 8 hex chars. */
  const FOREIGN_VPC_ID = `vpc-${'0'.repeat(16)}`;

  const hex = (len: number) =>
    fc
      .array(fc.constantFrom(...'0123456789abcdef'.split('')), {
        minLength: len,
        maxLength: len,
      })
      .map(chars => chars.join(''));

  const digits = (len: number) =>
    fc
      .array(fc.constantFrom(...'0123456789'.split('')), { minLength: len, maxLength: len })
      .map(chars => chars.join(''));

  /** Region varies so a hardcoded region in a failure line cannot pass. */
  const regionArb = fc.constantFrom('us-east-1', 'eu-west-2', 'ap-southeast-1', 'ca-west-1');

  const planArb: fc.Arbitrary<PrerequisitePlan> = fc.record({
    region: regionArb,
    vpc: fc.option(
      fc.record({
        id: hex(8).map(h => `vpc-${h}`),
        mode: fc.constantFrom<'ok' | 'absent'>('ok', 'absent'),
        subnets: fc.uniqueArray(
          fc.record({
            id: hex(8).map(h => `subnet-${h}`),
            mode: fc.constantFrom<'ok' | 'absent' | 'wrong-vpc'>('ok', 'absent', 'wrong-vpc'),
          }),
          { selector: s => s.id, minLength: 1, maxLength: 4 },
        ),
      }),
      { nil: undefined },
    ),
    sg: fc.option(
      fc.record({
        id: hex(8).map(h => `sg-${h}`),
        mode: fc.constantFrom<'ok' | 'absent'>('ok', 'absent'),
      }),
      { nil: undefined },
    ),
    cmk: fc.option(
      fc.record({
        account: digits(12),
        keyId: hex(8),
        mode: fc.constantFrom<'ok' | 'absent' | 'disabled'>('ok', 'absent', 'disabled'),
      }),
      { nil: undefined },
    ),
  });

  /**
   * Turn a plan into a config, a describe backend and the expected failure set
   * as `identifier -> AWS_Config_Field`.
   */
  function buildPlan(plan: PrerequisitePlan) {
    const cmkArn = plan.cmk
      ? `arn:aws:kms:${plan.region}:${plan.cmk.account}:key/${plan.cmk.keyId}`
      : undefined;

    const config = baseConfig({
      region: plan.region,
      vpc: plan.vpc ? { id: plan.vpc.id, subnetIds: plan.vpc.subnets.map(s => s.id) } : undefined,
      dataSourceSecurityGroupId: plan.sg?.id,
      appCmkArn: cmkArn,
    });

    const vpcs: Record<string, DescribeVpcResult> = {};
    const subnets: Record<string, DescribeSubnetResult> = {};
    const securityGroups: Record<string, DescribeSecurityGroupResult> = {};
    const keys: Record<string, DescribeKeyResult> = {};
    const expected = new Map<string, PrerequisiteField>();

    if (plan.vpc) {
      const vpcExists = plan.vpc.mode === 'ok';
      vpcs[plan.vpc.id] = { exists: vpcExists };
      if (!vpcExists) expected.set(plan.vpc.id, 'vpc.id');

      for (const subnet of plan.vpc.subnets) {
        subnets[subnet.id] =
          subnet.mode === 'absent'
            ? { exists: false }
            : {
                exists: true,
                vpcId: subnet.mode === 'wrong-vpc' ? FOREIGN_VPC_ID : plan.vpc.id,
              };
        // Membership is only observable when the VPC itself exists - the
        // implementation skips the subnet loop otherwise.
        if (vpcExists && subnet.mode !== 'ok') expected.set(subnet.id, 'vpc.subnetIds');
      }
    }

    if (plan.sg) {
      const sgExists = plan.sg.mode === 'ok';
      securityGroups[plan.sg.id] = { exists: sgExists };
      if (!sgExists) expected.set(plan.sg.id, 'dataSourceSecurityGroupId');
    }

    if (plan.cmk && cmkArn) {
      keys[cmkArn] =
        plan.cmk.mode === 'absent'
          ? { exists: false }
          : { exists: true, enabled: plan.cmk.mode === 'ok' };
      if (plan.cmk.mode !== 'ok') expected.set(cmkArn, 'appCmkArn');
    }

    return {
      config,
      backend: createFakeBackend({ vpcs, subnets, securityGroups, keys }),
      expected,
    };
  }

  it('reports exactly the failing prerequisites, each line naming its request item', async () => {
    await fc.assert(
      fc.asyncProperty(planArb, async plan => {
        const { config, backend, expected } = buildPlan(plan);
        const result = await runPreflightChecks(config, backend);

        const reported = result.failures.map(f => f.identifier);

        // The set matches exactly: nothing dropped by an early return
        // (Req 5.4), nothing invented for a healthy prerequisite.
        expect(new Set(reported)).toEqual(new Set(expected.keys()));
        // One line per failing prerequisite - no duplicate reports.
        expect(reported.length).toBe(expected.size);
        expect(result.passed).toBe(expected.size === 0);

        for (const failure of result.failures) {
          const field = expected.get(failure.identifier) as PrerequisiteField;
          // Req 5.2: field name, supplied value, target region, request item.
          expect(failure.message).toContain(field);
          expect(failure.message).toContain(failure.identifier);
          expect(failure.message).toContain(`in region ${plan.region}`);
          expect(failure.message).toContain('docs/deploy-aws.md section ');
          // The item cited must be the one that supplies THIS field, so a
          // mis-wired field-to-item mapping fails here.
          expect(failure.message).toContain(PREREQUISITE_DOCS_ITEMS[field]);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Docker probe examples (Req 4.5, 5.4)
// ---------------------------------------------------------------------------

describe('preflight - Docker daemon probe', () => {
  const unreachableDocker = { available: async () => false };
  const reachableDocker = { available: async () => true };

  it('adds one Docker failure on the asset path when the daemon is unreachable', async () => {
    const result = await runPreflightChecks(baseConfig(), createFakeBackend(), {
      dockerProbe: unreachableDocker,
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].identifier).toBe(DOCKER_FAILURE_IDENTIFIER);
    expect(result.failures[0].message).toBe(DOCKER_UNAVAILABLE_MESSAGE);
  });

  it('adds no Docker failure on the asset path when the daemon is reachable', async () => {
    const result = await runPreflightChecks(baseConfig(), createFakeBackend(), {
      dockerProbe: reachableDocker,
    });
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('adds no Docker failure on the imageUri reference path', async () => {
    const config = baseConfig({ imageUri: 'registry.example.com/phorma/host:1.2.3' });
    const result = await runPreflightChecks(config, createFakeBackend(), {
      dockerProbe: unreachableDocker,
    });
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('reports the Docker failure alongside every AWS prerequisite failure in one run', async () => {
    const arn = 'arn:aws:kms:us-east-1:123456789012:key/disabled-key';
    const config = baseConfig({
      vpc: { id: 'vpc-missing1', subnetIds: ['subnet-aaaaaaaa'] },
      dataSourceSecurityGroupId: 'sg-missing1',
      appCmkArn: arn,
    });
    const backend = createFakeBackend({
      vpcs: { 'vpc-missing1': { exists: false } },
      securityGroups: { 'sg-missing1': { exists: false } },
      keys: { [arn]: { exists: true, enabled: false } },
    });
    const result = await runPreflightChecks(config, backend, { dockerProbe: unreachableDocker });
    expect(result.passed).toBe(false);
    // Docker + absent VPC + absent SG + disabled CMK. The subnet is not
    // described because the VPC is absent.
    expect(result.failures.map(f => f.identifier)).toEqual([
      DOCKER_FAILURE_IDENTIFIER,
      'vpc-missing1',
      'sg-missing1',
      arn,
    ]);
  });
});
