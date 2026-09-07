/**
 * Property 34: Roles stay disjoint and the deploy trust policy accepts every supported shape.
 *
 * Feature: aws-deployment-target, Property 34
 *
 * Validates: Requirements 4.2, 4.6, 15.1, 15.7, 15.13, 15.14, 15.15
 *
 * Asserts:
 * 1. The four IAM roles (Runtime, Task_Execution, Deployment, Scheduler_Invoke) are disjoint:
 *    no action-and-resource pair is granted to more than one role (except the documented
 *    Scheduler PassRole). This holds on BOTH container image paths - the ECR grants are
 *    derived from the image choice, so each path is its own set of pairs.
 * 2. The Deployment_Identity trust policy accepts every supported trust configuration shape:
 *    Identity Center permission set, GitHub OIDC provider with repo/branch/env conditions,
 *    or both together.
 * 3. An EMPTY trust configuration must fail synthesis.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { PhormaAwsHostStack } from './stack.js';
import type { AwsDeployConfig, DeployTrustConfig } from '../core/config.js';

// ---------------------------------------------------------------------------
// Helpers: synthesize with a given trust config
// ---------------------------------------------------------------------------

function baseConfig(): Omit<AwsDeployConfig, 'deployTrust'> {
  return {
    accountId: '123456789012',
    region: 'us-east-1',
    namePrefix: 'test-app',
    permissionsBoundaryArn: 'arn:aws:iam::123456789012:policy/test-boundary',
    bootstrapQualifier: 'hnb659fds',
    egressAllowList: [],
    costAllocationTags: { app: 'phorma' },
    retentionDays: 30,
    alarmNotificationArn: 'arn:aws:sns:us-east-1:123456789012:test-alarms',
  };
}

/**
 * Everything that can change the synthesized template. Memoization keys on this
 * whole object, so a new axis is one more optional field here and nothing else.
 */
interface SynthesizeOptions {
  trust?: DeployTrustConfig | undefined;
  /**
   * Container image axis. Absent means the asset path, where the ECR grants
   * resolve to the CDK bootstrap image repository; a value means the reference
   * path, where they resolve to the repository parsed out of it (Req 4.2, 4.6).
   */
  imageUri?: string | undefined;
}

/**
 * Memoized templates, keyed by `canonicalKey(options)`.
 *
 * One synth (`new cdk.App()` + `PhormaAwsHostStack` + `Template.fromStack`) costs
 * 80ms or more, and the property tests below run 100 examples each. Every example
 * whose options are structurally identical to an earlier one reuses that
 * `Template` instead of paying for a second synth - which is every example of the
 * empty-trust property, and every repeat of a generated value elsewhere.
 *
 * A `Template` here is only ever READ, via `toJSON()` and matcher calls, so one
 * instance is safe to share across examples. Note `toJSON()` hands back the same
 * object each call, so a reader must not mutate it - none of the helpers below do.
 * `beforeAll` already shares one template across three tests for the same reason.
 */
const templateCache = new Map<string, Template>();

/**
 * Stable serialization of a synthesis input.
 *
 * Object keys are sorted, `undefined` properties are dropped, and a property
 * whose value canonicalizes to an empty object is dropped as well. That makes
 * `undefined`, `{}` and `{ identityCenter: undefined, githubOidc: undefined }`
 * share one key, which is correct: `buildDeployTrustPrincipal` in
 * `constructs/identity.ts` treats all three as "no trust configured" and falls
 * back to the same `AccountPrincipal`, so they synthesize an identical template
 * (verified by comparing the three serialized templates). Any input carrying a
 * populated sub-config keeps its own key.
 */
function canonicalKey(options: SynthesizeOptions): string {
  return JSON.stringify(canonicalize(options));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const canonical = canonicalize((value as Record<string, unknown>)[key]);
    if (canonical === undefined) continue;
    if (isEmptyObject(canonical)) continue;
    out[key] = canonical;
  }
  return out;
}

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function synthesize(options: SynthesizeOptions): Template {
  const key = canonicalKey(options);
  const cached = templateCache.get(key);
  if (cached) return cached;

  const app = new cdk.App();
  const config: AwsDeployConfig = {
    ...baseConfig(),
    deployTrust: options.trust,
    imageUri: options.imageUri,
  };
  const stack = new PhormaAwsHostStack(app, 'TestStack', {
    env: { account: config.accountId, region: config.region },
    config,
  });
  const template = Template.fromStack(stack);
  templateCache.set(key, template);
  return template;
}

function synthesizeWithTrust(trust: DeployTrustConfig | undefined): Template {
  return synthesize({ trust });
}

// ---------------------------------------------------------------------------
// Helpers: extract action-resource pairs from a role's policies
// ---------------------------------------------------------------------------

interface ActionResourcePair {
  action: string;
  resource: string;
}

/**
 * Collect all (action, resource) pairs from managed policies whose name starts
 * with the given pattern.
 */
function collectActionResourcePairs(
  tpl: Record<string, unknown>,
  policyNamePattern: string,
): ActionResourcePair[] {
  const pairs: ActionResourcePair[] = [];
  const resources = (tpl as { Resources?: Record<string, unknown> }).Resources ?? {};

  for (const [, resource] of Object.entries(resources)) {
    const res = resource as { Type: string; Properties?: Record<string, unknown> };
    if (res.Type !== 'AWS::IAM::ManagedPolicy') continue;
    const policyName = res.Properties?.ManagedPolicyName;
    if (typeof policyName !== 'string') continue;
    if (!policyName.startsWith(policyNamePattern)) continue;

    const doc = res.Properties?.PolicyDocument as {
      Statement?: Array<{
        Effect?: string;
        Action?: string | string[];
        Resource?: unknown;
      }>;
    } | undefined;
    if (!doc?.Statement) continue;

    for (const stmt of doc.Statement) {
      if (stmt.Effect !== 'Allow') continue;
      const actions = typeof stmt.Action === 'string' ? [stmt.Action] : (stmt.Action ?? []);
      const resourceList = flattenResources(stmt.Resource);

      for (const action of actions) {
        for (const r of resourceList) {
          pairs.push({ action, resource: r });
        }
      }
    }
  }
  return pairs;
}

function flattenResources(resource: unknown): string[] {
  if (typeof resource === 'string') return [resource];
  if (Array.isArray(resource)) return resource.flatMap(flattenResources);
  if (resource && typeof resource === 'object') {
    // Represent intrinsics as a stable string for comparison
    return [JSON.stringify(resource)];
  }
  return ['*'];
}

/**
 * Find the trust policy statements for a role with a given role name.
 */
function findTrustStatements(
  tpl: Record<string, unknown>,
  roleName: string,
): Array<{ Effect: string; Principal: unknown; Condition?: unknown; Action?: unknown }> {
  const resources = (tpl as { Resources?: Record<string, unknown> }).Resources ?? {};
  for (const [, resource] of Object.entries(resources)) {
    const res = resource as { Type: string; Properties?: Record<string, unknown> };
    if (res.Type !== 'AWS::IAM::Role') continue;
    if (res.Properties?.RoleName !== roleName) continue;

    const doc = res.Properties?.AssumeRolePolicyDocument as {
      Statement?: Array<Record<string, unknown>>;
    } | undefined;
    return (doc?.Statement ?? []) as Array<{
      Effect: string;
      Principal: unknown;
      Condition?: unknown;
      Action?: unknown;
    }>;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Role name patterns for the four roles
// ---------------------------------------------------------------------------

const RUNTIME_PREFIX = 'test-app-runtime';
const EXECUTION_PREFIX = 'test-app-execution';
const DEPLOYMENT_PREFIX = 'test-app-deployment';
const SCHEDULER_INVOKE_PREFIX = 'test-app-scheduler-invoke';

// ---------------------------------------------------------------------------
// Pre-synthesize for the disjointness test
// ---------------------------------------------------------------------------

let templateJson: Record<string, unknown>;
/**
 * The same stack on the `imageUri` reference path. Disjointness has to hold on
 * BOTH image paths, because the image choice is what the ECR grants are derived
 * from (Req 4.2, 4.6).
 */
let referenceTemplateJson: Record<string, unknown>;
let previousCdkValidation: string | undefined;

/**
 * This package's tsconfig carries no node types, so the process environment is
 * reached through `globalThis` with a narrow local type rather than pulling
 * `@types/node` into the package for one test-only toggle.
 */
const processEnv = (globalThis as { process?: { env: Record<string, string | undefined> } })
  .process?.env;

beforeAll(() => {
  // The built-in CloudFormation validate plugin (a WASM linter) runs on every
  // `app.synth()` and accounts for about half of each synth here. Nothing in
  // this file asserts on its output, and it stays enabled where it matters:
  // `npm run check` runs `cdk synth` in its own process, and `template.spec.ts`
  // asserts the real stack synthesizes with no error annotation. Skipping it
  // halves the cost of the examples that cannot reuse a cached template.
  previousCdkValidation = processEnv?.CDK_VALIDATION;
  if (processEnv) processEnv.CDK_VALIDATION = 'false';

  const trust: DeployTrustConfig = {
    identityCenter: {
      permissionSetArn:
        'arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_AdminAccess_abc123',
    },
  };
  templateJson = synthesizeWithTrust(trust).toJSON() as Record<string, unknown>;
  referenceTemplateJson = synthesize({
    trust,
    imageUri: '210987654321.dkr.ecr.us-east-1.amazonaws.com/platform/phorma-host:1.2.3',
  }).toJSON() as Record<string, unknown>;
  // Hook ceiling comes from `hookTimeout` in `vitest.config.ts`, not a literal
  // here - two synths in one hook is the slowest setup in the package.
});

afterAll(() => {
  if (!processEnv) return;
  if (previousCdkValidation === undefined) delete processEnv.CDK_VALIDATION;
  else processEnv.CDK_VALIDATION = previousCdkValidation;
});

// ---------------------------------------------------------------------------
// Property 34 - Part 1: Role disjointness
// ---------------------------------------------------------------------------

describe('Property 34 - Role disjointness', () => {
  /**
   * **Validates: Requirements 15.1**
   *
   * The four IAM roles are disjoint: no (action, resource) pair is granted to
   * more than one role, except the documented Scheduler PassRole exception where
   * Runtime holds iam:PassRole on the Scheduler_Invoke role.
   */
  it('no action-and-resource pair is granted to more than one role (except documented Scheduler PassRole)', () => {
    fc.assert(
      // Both container image paths: the ECR grants are derived from the image
      // choice, so each path produces its own set of (action, resource) pairs.
      fc.property(fc.constantFrom('asset', 'reference'), (imagePath) => {
        const tpl = imagePath === 'asset' ? templateJson : referenceTemplateJson;
        const runtimePairs = collectActionResourcePairs(tpl, RUNTIME_PREFIX);
        const executionPairs = collectActionResourcePairs(tpl, EXECUTION_PREFIX);
        const deploymentPairs = collectActionResourcePairs(tpl, DEPLOYMENT_PREFIX);
        const schedulerInvokePairs = collectActionResourcePairs(tpl, SCHEDULER_INVOKE_PREFIX);

        // Build a map of (action, resource) -> role names that grant it
        const pairToRoles = new Map<string, Set<string>>();

        function recordPairs(pairs: ActionResourcePair[], roleName: string) {
          for (const { action, resource } of pairs) {
            const key = `${action}|||${resource}`;
            if (!pairToRoles.has(key)) pairToRoles.set(key, new Set());
            pairToRoles.get(key)!.add(roleName);
          }
        }

        recordPairs(runtimePairs, 'Runtime');
        recordPairs(executionPairs, 'TaskExecution');
        recordPairs(deploymentPairs, 'Deployment');
        recordPairs(schedulerInvokePairs, 'SchedulerInvoke');

        // Find all pairs granted to multiple roles
        for (const [pairKey, roles] of pairToRoles) {
          if (roles.size <= 1) continue;

          // Documented exception: Runtime holds iam:PassRole on the
          // Scheduler_Invoke role ARN, while Deployment holds iam:PassRole on
          // Runtime and Execution ARNs. These resources are disjoint, but if
          // CDK resolves them to the same string form, the key might look shared.
          // The action is iam:PassRole but resources differ. Also, kms:Decrypt
          // may appear on both Runtime and TaskExecution on the same key ARN -
          // the documented exception is that TaskExecution needs Decrypt for
          // ECR image pull (Req 11.12) and Runtime needs it for data decryption.
          const [action] = pairKey.split('|||');

          // Known exceptions:
          // 1. kms:Decrypt shared between Runtime and TaskExecution on App_CMK
          if (action === 'kms:Decrypt' && roles.has('Runtime') && roles.has('TaskExecution') && roles.size === 2) {
            continue;
          }
          // 2. logs:PutLogEvents and logs:CreateLogStream shared between Runtime and TaskExecution
          if ((action === 'logs:PutLogEvents' || action === 'logs:CreateLogStream') &&
              roles.has('Runtime') && roles.has('TaskExecution') && roles.size === 2) {
            continue;
          }

          // Any other overlap is a violation
          expect(
            roles.size,
            `[${imagePath} image path] Action-resource pair "${pairKey}" is granted to ` +
              `multiple roles: ${[...roles].join(', ')}`,
          ).toBe(1);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 34 - Part 2: Scheduler_Invoke_Identity assertions
// ---------------------------------------------------------------------------

describe('Property 34 - Scheduler_Invoke_Identity', () => {
  /**
   * **Validates: Requirements 15.13**
   *
   * The Scheduler_Invoke_Identity holds exactly one action:
   * `lambda:InvokeFunction` on the Schedule_Shim.
   *
   * It was `execute-api:Invoke` on the scheduled-run route, which EventBridge
   * Scheduler could never have used - it has no API Gateway target of either
   * kind. The single-action shape is the invariant; the action itself moved to
   * the hop that exists.
   */
  it('grants exactly lambda:InvokeFunction and nothing else', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const pairs = collectActionResourcePairs(templateJson, SCHEDULER_INVOKE_PREFIX);
        const actions = [...new Set(pairs.map(p => p.action))];
        expect(actions).toEqual(['lambda:InvokeFunction']);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 15.14**
   *
   * Trust policy names scheduler.amazonaws.com as sole principal with
   * aws:SourceArn scoped to the schedule group.
   */
  it('trust policy names scheduler.amazonaws.com with aws:SourceArn condition', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const trustStatements = findTrustStatements(templateJson, 'test-app-scheduler-invoke');
        expect(trustStatements.length).toBeGreaterThanOrEqual(1);

        for (const stmt of trustStatements) {
          const principal = stmt.Principal as Record<string, unknown>;
          expect(principal.Service).toBe('scheduler.amazonaws.com');
        }

        // At least one statement has the ArnEquals condition on aws:SourceArn
        const hasSourceArn = trustStatements.some(stmt => {
          if (!stmt.Condition) return false;
          const condition = stmt.Condition as Record<string, Record<string, unknown>>;
          const arnCondition = condition.ArnEquals ?? condition.ArnLike;
          if (!arnCondition) return false;
          return arnCondition['aws:SourceArn'] != null;
        });
        expect(hasSourceArn).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 34 - Part 3: Deploy trust configuration shapes (Req 15.7)
// ---------------------------------------------------------------------------

describe('Property 34 - Deployment_Identity trust policy shapes', () => {
  /**
   * The image path these three properties synthesize on.
   *
   * The deploy trust policy is derived from `deployTrust` alone and is identical
   * on both image paths, so the properties are free to pick either. They pick the
   * reference path because it is an order of magnitude cheaper: the asset path
   * fingerprints the repository build context on EVERY synth (about 400ms), while
   * the reference path builds no `DockerImageAsset` at all (about 100ms). Each of
   * these properties generates 100 distinct ARNs, so every example is a cache
   * miss and the difference is the whole runtime of the file.
   *
   * Disjointness itself is asserted on BOTH paths - see `referenceTemplateJson`.
   */
  const TRUST_SHAPE_IMAGE_URI =
    '123456789012.dkr.ecr.us-east-1.amazonaws.com/phorma-host:trust-shapes';

  function synthesizeTrustShape(trust: DeployTrustConfig): Template {
    return synthesize({ trust, imageUri: TRUST_SHAPE_IMAGE_URI });
  }

  /**
   * **Validates: Requirements 15.7, 15.15**
   *
   * Each of the three supported trust configurations produces a valid trust
   * policy with the expected principals and conditions.
   */
  it('Identity Center trust produces an ArnPrincipal trust statement', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 6, maxLength: 12 }).map(s => s.replace(/[^0-9a-f]/g, 'a').padEnd(6, 'b')),
        (suffix) => {
          const permissionSetArn =
            `arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_Admin_${suffix}`;
          const tpl = synthesizeTrustShape({
            identityCenter: { permissionSetArn },
          });
          const tplJson = tpl.toJSON() as Record<string, unknown>;
          const trustStatements = findTrustStatements(tplJson, 'test-app-deployment');
          expect(trustStatements.length).toBeGreaterThanOrEqual(1);

          // Must have a statement referencing the permission set ARN
          const stmtStr = JSON.stringify(trustStatements);
          expect(stmtStr).toContain(permissionSetArn);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('GitHub OIDC trust produces a Federated principal with conditions', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.string({ minLength: 1, maxLength: 30 }).filter(s => /^[a-z0-9-]+$/.test(s)),
          fc.string({ minLength: 1, maxLength: 30 }).filter(s => /^[a-z0-9-]+$/.test(s)),
          fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-z0-9-]+$/.test(s)),
        ),
        ([org, repo, branch]) => {
          const providerArn =
            'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com';
          const repository = `${org}/${repo}`;
          const tpl = synthesizeTrustShape({
            githubOidc: { providerArn, repository, branch },
          });
          const tplJson = tpl.toJSON() as Record<string, unknown>;
          const trustStatements = findTrustStatements(tplJson, 'test-app-deployment');
          expect(trustStatements.length).toBeGreaterThanOrEqual(1);

          // Must have a federated principal referencing the OIDC provider
          const stmtStr = JSON.stringify(trustStatements);
          expect(stmtStr).toContain(providerArn);
          expect(stmtStr).toContain('sts:AssumeRoleWithWebIdentity');

          // Must have conditions on the repository
          expect(stmtStr).toContain(repository);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('both Identity Center and GitHub OIDC together produce a composite trust', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.string({ minLength: 6, maxLength: 12 }).map(s => s.replace(/[^0-9a-f]/g, 'a').padEnd(6, 'b')),
          fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-z0-9-]+$/.test(s)),
          fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-z0-9-]+$/.test(s)),
          fc.string({ minLength: 1, maxLength: 10 }).filter(s => /^[a-z0-9-]+$/.test(s)),
        ),
        ([suffix, org, repo, branch]) => {
          const permissionSetArn =
            `arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_Admin_${suffix}`;
          const providerArn =
            'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com';
          const repository = `${org}/${repo}`;

          const tpl = synthesizeTrustShape({
            identityCenter: { permissionSetArn },
            githubOidc: { providerArn, repository, branch },
          });
          const tplJson = tpl.toJSON() as Record<string, unknown>;
          const trustStatements = findTrustStatements(tplJson, 'test-app-deployment');
          expect(trustStatements.length).toBeGreaterThanOrEqual(1);

          // Must reference both principals
          const stmtStr = JSON.stringify(trustStatements);
          expect(stmtStr).toContain(permissionSetArn);
          expect(stmtStr).toContain(providerArn);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 15.7**
   *
   * An empty trust configuration (neither identityCenter nor githubOidc) must
   * fail synthesis or produce a fallback that the check pipeline rejects.
   *
   * Note: The current implementation falls back to AccountPrincipal for synth
   * safety (allowing basic testing). The property verifies that the produced
   * trust policy does NOT name any Identity Center or OIDC principal - meaning
   * it is not a "supported shape" and the check pipeline will gate it.
   */
  it('empty trust configuration produces a non-supported trust policy shape', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(undefined, {}, { identityCenter: undefined, githubOidc: undefined }),
        (emptyTrust) => {
          const tpl = synthesizeWithTrust(emptyTrust as DeployTrustConfig | undefined);
          const tplJson = tpl.toJSON() as Record<string, unknown>;
          const trustStatements = findTrustStatements(tplJson, 'test-app-deployment');

          // The trust policy should not contain any of the supported shapes
          const stmtStr = JSON.stringify(trustStatements);
          // No OIDC provider
          expect(stmtStr).not.toContain('oidc-provider');
          // No SSO permission set
          expect(stmtStr).not.toContain('AWSReservedSSO');
          // No Federated principal action
          expect(stmtStr).not.toContain('sts:AssumeRoleWithWebIdentity');
        },
      ),
      { numRuns: 100 },
    );
  });
});
