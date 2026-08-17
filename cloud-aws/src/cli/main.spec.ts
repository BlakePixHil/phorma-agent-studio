/**
 * Property and unit tests for the Phorma_AWS_CLI dispatch.
 *
 * Everything here runs IN PROCESS. `runVerb` returns a code instead of calling
 * `process.exit`, and every effect a verb can perform arrives through a
 * `CliContext` port, so the under-supply rule is checked for every verb without
 * spawning a child, without credentials and without a Docker daemon.
 *
 * The AWS-facing ports (`signer`, `identity`, `stackOutputs`, `describeBackend`)
 * record every call they receive, which is what makes "no AWS call is made" an
 * assertion about an unused port rather than a network expectation.
 *
 * Feature: aws-byo-deploy
 * Requirements: 5.1, 5.5, 5.6, 6.4
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  DOCKER_UNAVAILABLE_MESSAGE,
  type DescribeKeyResult,
  type DescribeSecurityGroupResult,
  type DescribeSubnetResult,
  type DescribeVpcResult,
} from '../infra/preflight.js';
import { cdkEntryPointPath, configFilePath } from './config-file.js';
import {
  EXIT_CONFIG_ABSENT,
  EXIT_ENTRY_POINT_ABSENT,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_SESSION_INVALID,
} from './exit-codes.js';
import { CLI_USAGE, VERB_SPECS, runVerb, type VerbSpec } from './main.js';
import type { CliContext } from './ports.js';

/** Iterations per property. The repo floor is 100; every case here is in-process. */
const RUNS = 100;

/** A `cloud-aws` package root that exists nowhere, so nothing can read a real file. */
const ROOT = '/phorma-test/cloud-aws';

// ---------------------------------------------------------------------------
// A valid Deploy_Config_File, for the examples that need one
// ---------------------------------------------------------------------------

const CONFIG_REGION = 'eu-west-1';
const CONFIG_VPC_ID = 'vpc-0abc123';

/** Accepted by `parseAwsDeployConfig`, `$generatedBy` member included (Req 3.2). */
const VALID_CONFIG = {
  accountId: '123456789012',
  region: CONFIG_REGION,
  namePrefix: 'phorma',
  permissionsBoundaryArn: 'arn:aws:iam::123456789012:policy/phorma-boundary',
  bootstrapQualifier: 'hnb659fds',
  appCmkArn: `arn:aws:kms:${CONFIG_REGION}:123456789012:key/1a2b3c4d-5e6f`,
  vpc: { id: CONFIG_VPC_ID, subnetIds: ['subnet-0aaa111', 'subnet-0bbb222'] },
  dataSourceSecurityGroupId: 'sg-0ccc333',
  egressAllowList: ['api.anthropic.com'],
  costAllocationTags: { app: 'phorma' },
  retentionDays: 30,
  alarmNotificationArn: `arn:aws:sns:${CONFIG_REGION}:123456789012:phorma-alarms`,
  $generatedBy: 'Phorma Agent Studio',
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  /** File text by absolute path. An absent key reads as an absent file. */
  files?: Record<string, string>;
  /** Extra paths that `exists` reports for without carrying text. */
  existing?: readonly string[];
  /** `sts:GetCallerIdentity`. Rejecting drives the `doctor` exit-4 example. */
  identity?: () => Promise<{ account?: string; arn?: string }>;
  dockerAvailable?: boolean;
  vpc?: DescribeVpcResult;
  subnet?: DescribeSubnetResult;
  securityGroup?: DescribeSecurityGroupResult;
  key?: DescribeKeyResult;
  /** Exit code the `cdk` step resolves with. */
  commandExit?: number;
}

interface CommandCall {
  program: string;
  args: readonly string[];
  cwd: string;
}

interface Harness {
  ctx: CliContext;
  out: string[];
  err: string[];
  /** Every call to `signer`, `identity`, `stackOutputs` or `describeBackend`. */
  awsCalls: string[];
  commandCalls: CommandCall[];
  /** Ordered labels for every non-io port call, so ordering is assertable. */
  events: string[];
}

function createHarness(options: HarnessOptions = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const awsCalls: string[] = [];
  const commandCalls: CommandCall[] = [];
  const events: string[] = [];
  const files = options.files ?? {};
  const existing = new Set([...Object.keys(files), ...(options.existing ?? [])]);

  /** Record an AWS-facing port call in both logs. */
  const aws = (label: string): void => {
    awsCalls.push(label);
    events.push(label);
  };

  const ctx: CliContext = {
    root: ROOT,
    io: {
      out: (text) => void out.push(text),
      err: (text) => void err.push(text),
      readStdin: async () => {
        events.push('io.readStdin');
        return '';
      },
    },
    files: {
      readText: (path) => {
        events.push(`files.readText ${path}`);
        return files[path];
      },
      exists: (path) => {
        events.push(`files.exists ${path}`);
        return existing.has(path);
      },
      makeTempDir: () => {
        events.push('files.makeTempDir');
        return `${ROOT}/tmp`;
      },
    },
    commands: {
      run: async (program, args, cwd) => {
        events.push(`commands.run ${program} ${args.join(' ')}`);
        commandCalls.push({ program, args, cwd });
        return options.commandExit ?? 0;
      },
    },
    dockerProbe: {
      available: async () => {
        events.push('dockerProbe.available');
        return options.dockerAvailable ?? true;
      },
    },
    describeBackend: {
      describeVpc: async (vpcId) => {
        aws(`describeBackend.describeVpc ${vpcId}`);
        return options.vpc ?? { exists: true };
      },
      describeSubnet: async (subnetId) => {
        aws(`describeBackend.describeSubnet ${subnetId}`);
        return options.subnet ?? { exists: true, vpcId: CONFIG_VPC_ID };
      },
      describeSecurityGroup: async (sgId) => {
        aws(`describeBackend.describeSecurityGroup ${sgId}`);
        return options.securityGroup ?? { exists: true };
      },
      describeKey: async (keyArn) => {
        aws(`describeBackend.describeKey ${keyArn}`);
        return options.key ?? { exists: true, enabled: true };
      },
    },
    signer: {
      send: async (request) => {
        aws(`signer.send ${request.method} ${request.url}`);
        return { status: 200, headers: {}, body: '{}' };
      },
      presign: async (request) => {
        aws(`signer.presign ${request.url}`);
        return `${request.url}?X-Amz-Signature=stub`;
      },
    },
    identity: {
      callerIdentity: async (region) => {
        aws(`identity.callerIdentity ${region}`);
        if (options.identity) return options.identity();
        return { account: '123456789012', arn: 'arn:aws:sts::123456789012:assumed-role/dev/op' };
      },
    },
    stackOutputs: {
      describe: async (region, stackName) => {
        aws(`stackOutputs.describe ${region} ${stackName}`);
        return undefined;
      },
    },
  };

  return { ctx, out, err, awsCalls, commandCalls, events };
}

/** A context whose config file is present and valid, and whose entry point exists. */
function healthyHarness(options: HarnessOptions = {}): Harness {
  const root = { root: ROOT } as CliContext;
  return createHarness({
    files: { [configFilePath(root)]: JSON.stringify(VALID_CONFIG) },
    existing: [cdkEntryPointPath(root)],
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Every (verb, supplied-count) pair where the count is BELOW the verb's arity. */
const UNDER_SUPPLY_CASES: readonly { verb: VerbSpec; supplied: number }[] = VERB_SPECS.flatMap(
  (verb) => Array.from({ length: verb.arity }, (_, supplied) => ({ verb, supplied })),
);

/**
 * Argument values a caller might actually supply, plus values that only LOOK
 * like arguments. Content must not change the outcome: the arity check reads the
 * count and nothing else.
 */
const argValueArb = fc.oneof(
  fc.string(),
  fc.constantFrom(
    'https://abc123.execute-api.eu-west-1.amazonaws.com/runs',
    'POST',
    'GET',
    'wf-42',
    '--help',
    '-h',
    '',
    '   ',
    'plan',
  ),
);

/** One under-supplied invocation: a verb and strictly fewer arguments than it needs. */
const underSuppliedInvocationArb = fc
  .constantFrom(...UNDER_SUPPLY_CASES)
  .chain(({ verb, supplied }) =>
    fc
      .array(argValueArb, { minLength: supplied, maxLength: supplied })
      .map((args) => ({ verb, args })),
  );

/** The `<...>` placeholders a usage line declares, one per required argument. */
function usagePlaceholders(usage: string): string[] {
  return usage.match(/<[^>]+>/g) ?? [];
}

// ---------------------------------------------------------------------------
// Property 24
// ---------------------------------------------------------------------------

describe('runVerb - under-supplied verbs', () => {
  // Feature: aws-byo-deploy, Property 24: Under-supplied verbs print usage and fail
  it('prints a usage line naming the verb and its arguments, fails, and calls no AWS', async () => {
    // A verb table where nothing takes an argument would make the property
    // vacuous, so the case list is asserted non-empty before it is drawn from.
    expect(UNDER_SUPPLY_CASES.length).toBeGreaterThan(0);

    await fc.assert(
      fc.asyncProperty(underSuppliedInvocationArb, async ({ verb, args }) => {
        const h = healthyHarness();
        const code = await runVerb([verb.name, ...args], h.ctx);

        // Non-zero, always.
        expect(code).not.toBe(EXIT_OK);
        expect(code).toBe(EXIT_FAILURE);

        // One usage line on stderr, naming the verb AND every argument it needs.
        const stderr = h.err.join('');
        expect(h.err.length).toBe(1);
        expect(stderr.endsWith('\n')).toBe(true);
        expect(stderr).toContain(verb.name);
        const placeholders = usagePlaceholders(verb.usage);
        expect(placeholders.length).toBe(verb.arity);
        for (const placeholder of placeholders) {
          expect(stderr).toContain(placeholder);
        }

        // Nothing on stdout: an under-supplied verb produces no Sentinel_Envelope.
        expect(h.out).toEqual([]);

        // No AWS call, no `cdk` step, no Docker probe, no file read - the verb
        // body never ran at all.
        expect(h.awsCalls).toEqual([]);
        expect(h.commandCalls).toEqual([]);
        expect(h.events).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });

  it('declares one usage placeholder per required argument for every verb', () => {
    for (const verb of VERB_SPECS) {
      expect(verb.usage).toContain(verb.name);
      expect(usagePlaceholders(verb.usage).length).toBe(verb.arity);
      expect(verb.arity).toBeGreaterThanOrEqual(0);
    }
  });

  it('prints the top-level usage line and fails for a missing verb', async () => {
    const h = healthyHarness();
    const code = await runVerb([], h.ctx);
    expect(code).toBe(EXIT_FAILURE);
    expect(h.err.join('')).toContain(CLI_USAGE);
    expect(h.awsCalls).toEqual([]);
  });

  it('names the unknown verb and fails', async () => {
    const h = healthyHarness();
    const code = await runVerb(['depoly'], h.ctx);
    expect(code).toBe(EXIT_FAILURE);
    expect(h.err.join('')).toContain('depoly');
    expect(h.err.join('')).toContain(CLI_USAGE);
    expect(h.awsCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// `doctor` exit codes (Req 5.6)
// ---------------------------------------------------------------------------

describe('doctor - exit codes', () => {
  it('exits 0 when every check passes', async () => {
    const h = healthyHarness();
    const code = await runVerb(['doctor'], h.ctx);
    expect(code).toBe(EXIT_OK);
    expect(h.out.join('')).toContain(CONFIG_REGION);
    expect(h.awsCalls).toEqual([`identity.callerIdentity ${CONFIG_REGION}`]);
  });

  it('exits 2 when the Deploy_Config_File is absent', async () => {
    const h = createHarness();
    const code = await runVerb(['doctor'], h.ctx);
    expect(code).toBe(EXIT_CONFIG_ABSENT);
    expect(h.err.join('')).toContain('cdk.context.phorma.json');
    expect(h.awsCalls).toEqual([]);
  });

  it('exits 1 when the Deploy_Config_File is present but rejected', async () => {
    const h = createHarness({
      files: {
        [configFilePath({ root: ROOT } as CliContext)]: JSON.stringify({
          ...VALID_CONFIG,
          accountId: '42',
        }),
      },
      existing: [cdkEntryPointPath({ root: ROOT } as CliContext)],
    });
    const code = await runVerb(['doctor'], h.ctx);
    expect(code).toBe(EXIT_FAILURE);
    expect(h.err.join('')).toContain('accountId');
    expect(h.awsCalls).toEqual([]);
  });

  it('exits 3 when the CDK entry point is absent', async () => {
    const h = createHarness({
      files: { [configFilePath({ root: ROOT } as CliContext)]: JSON.stringify(VALID_CONFIG) },
    });
    const code = await runVerb(['doctor'], h.ctx);
    expect(code).toBe(EXIT_ENTRY_POINT_ABSENT);
    // The path is compared through the helper, so the assertion holds on a
    // platform whose separator is not `/`.
    expect(h.err.join('')).toContain(cdkEntryPointPath({ root: ROOT } as CliContext));
    expect(h.awsCalls).toEqual([]);
  });

  it('exits 4 when the AWS session is expired', async () => {
    const expired = Object.assign(new Error('The security token included in the request is expired'), {
      name: 'ExpiredToken',
    });
    const h = healthyHarness({ identity: () => Promise.reject(expired) });
    const code = await runVerb(['doctor'], h.ctx);
    expect(code).toBe(EXIT_SESSION_INVALID);
    expect(h.err.join('')).toContain('sso login');
  });
});

// ---------------------------------------------------------------------------
// `plan` runs Preflight before `cdk diff` (Req 5.1, 5.5)
// ---------------------------------------------------------------------------

describe('plan - Preflight before cdk diff', () => {
  it('completes every preflight check before the cdk diff step', async () => {
    const h = healthyHarness();
    const code = await runVerb(['plan'], h.ctx);
    expect(code).toBe(EXIT_OK);

    // Exactly one `cdk` step, and it is `cdk diff` carrying the config context.
    expect(h.commandCalls).toHaveLength(1);
    const [call] = h.commandCalls;
    expect(call.program).toBe('npx');
    expect(call.args.slice(0, 2)).toEqual(['cdk', 'diff']);
    expect(call.args).toContain('--context');
    expect(call.cwd).toBe(ROOT);

    // Every preflight port call precedes it - the Docker probe, the VPC, both
    // subnets, the security group and the App_CMK.
    const preflightEvents = [
      'dockerProbe.available',
      `describeBackend.describeVpc ${CONFIG_VPC_ID}`,
      'describeBackend.describeSubnet subnet-0aaa111',
      'describeBackend.describeSubnet subnet-0bbb222',
      'describeBackend.describeSecurityGroup sg-0ccc333',
      `describeBackend.describeKey ${VALID_CONFIG.appCmkArn}`,
    ];
    const diffIndex = h.events.findIndex((e) => e.startsWith('commands.run'));
    expect(diffIndex).toBeGreaterThan(-1);
    for (const event of preflightEvents) {
      const index = h.events.indexOf(event);
      expect(index, `${event} was never called`).toBeGreaterThan(-1);
      expect(index, `${event} ran after cdk diff`).toBeLessThan(diffIndex);
    }
    expect(h.events.filter((e) => e.startsWith('commands.run'))).toHaveLength(1);
  });

  it('runs no cdk step when a preflight check fails', async () => {
    const h = healthyHarness({ dockerAvailable: false });
    const code = await runVerb(['plan'], h.ctx);
    expect(code).toBe(EXIT_FAILURE);
    expect(h.commandCalls).toEqual([]);
    const stderr = h.err.join('');
    expect(stderr).toContain(DOCKER_UNAVAILABLE_MESSAGE);
    expect(stderr).toContain('no cdk diff step ran');
  });
});
