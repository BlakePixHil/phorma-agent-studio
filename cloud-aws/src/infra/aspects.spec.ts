/**
 * Property 29 (Aspect half): Synthesis fails on any policy violation it can see.
 *
 * Feature: aws-deployment-target, Property 29: Synthesis fails on any policy
 * violation it can see, and the Plan_Command catches every non-existence
 *
 * Validates: Requirements 9.5, 9.7, 9.11, 11.1, 12.5, 12.6, 12.7, 13.4, 13.5, 15.8
 *
 * The preflight half lives in `preflight.spec.ts`. This half drives the six
 * Aspects directly against generated construct trees, which is what the design's
 * purity rule buys: each Aspect is a pure function over the tree, so it can be
 * visited without a full `cdk synth`.
 *
 * Every case asserts three things:
 *  1. an error annotation is raised exactly when the resource violates the rule,
 *  2. the message names the offending element, and
 *  3. the Aspect creates no resource.
 *
 * No AWS credentials or network access are involved.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { IConstruct } from 'constructs';
import {
  AlarmTargetAspect,
  AuthorizerAspect,
  CustomerKeyAspect,
  NoIamUserAspect,
  PermissionsBoundaryAspect,
  TagAspect,
} from './aspects.js';

const RUNS = 100;

/** The metadata type `Annotations.addError` writes. */
const ERROR_TYPE = 'aws:cdk:error';

/** Every error annotation anywhere in the tree rooted at `root`. */
function errorsIn(root: IConstruct): string[] {
  const found: string[] = [];
  const stack: IConstruct[] = [root];
  while (stack.length) {
    const next = stack.pop()!;
    for (const entry of next.node.metadata) {
      if (entry.type === ERROR_TYPE) found.push(String(entry.data));
    }
    stack.push(...next.node.children);
  }
  return found;
}

/** Count every construct in the tree, to prove an Aspect creates nothing. */
function constructCount(root: IConstruct): number {
  let n = 1;
  for (const child of root.node.children) n += constructCount(child);
  return n;
}

/** A fresh, unsynthesized stack per generated case. */
function freshStack(): cdk.Stack {
  return new cdk.Stack(new cdk.App(), 'S');
}

/**
 * Visit `resource` with `aspect` and report what happened, asserting the
 * Aspect created no construct in the process.
 */
function visitAndCollect(
  stack: cdk.Stack,
  aspect: { visit(node: IConstruct): void },
  resource: IConstruct,
): string[] {
  const before = constructCount(stack);
  aspect.visit(resource);
  expect(constructCount(stack)).toBe(before);
  return errorsIn(stack);
}

const identifierArb = fc
  .string({ minLength: 1, maxLength: 24 })
  .filter(s => /^[A-Za-z0-9-]+$/.test(s));

const boundaryArnArb = fc
  .string({ minLength: 1, maxLength: 16 })
  .filter(s => /^[a-z0-9-]+$/.test(s))
  .map(s => `arn:aws:iam::123456789012:policy/${s}`);

// ---------------------------------------------------------------------------
// 1. PermissionsBoundaryAspect (Req 13.4, 13.5)
// ---------------------------------------------------------------------------

describe('Property 29 - PermissionsBoundaryAspect', () => {
  it('errors for exactly the roles missing the configured boundary', () => {
    fc.assert(
      fc.property(
        identifierArb,
        fc.option(boundaryArnArb, { nil: undefined }),
        fc.boolean(),
        (roleName, configuredBoundary, roleCarriesBoundary) => {
          const stack = freshStack();
          const role = new iam.CfnRole(stack, 'Role', {
            roleName,
            assumeRolePolicyDocument: {},
            permissionsBoundary: roleCarriesBoundary
              ? (configuredBoundary ?? 'arn:aws:iam::123456789012:policy/other')
              : undefined,
          });

          const errors = visitAndCollect(
            stack,
            new PermissionsBoundaryAspect(configuredBoundary),
            role,
          );

          // Violating iff no boundary is configured, or the role carries none.
          const shouldFail = !configuredBoundary || !roleCarriesBoundary;
          expect(errors.length).toBe(shouldFail ? 1 : 0);
          if (shouldFail) {
            expect(errors[0]).toContain('PermissionsBoundaryAspect');
            expect(errors[0]).toContain(roleName);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('ignores every construct that is not a role', () => {
    fc.assert(
      fc.property(identifierArb, boundaryArnArb, (name, boundaryArn) => {
        const stack = freshStack();
        const alarm = new cloudwatch.CfnAlarm(stack, 'Alarm', {
          alarmName: name,
          comparisonOperator: 'GreaterThanThreshold',
          evaluationPeriods: 1,
          alarmActions: ['arn:aws:sns:us-east-1:123456789012:t'],
        });
        expect(
          visitAndCollect(stack, new PermissionsBoundaryAspect(boundaryArn), alarm),
        ).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// 2. CustomerKeyAspect (Req 11.1)
// ---------------------------------------------------------------------------

describe('Property 29 - CustomerKeyAspect', () => {
  it('errors for a table unless SSE is enabled with a KMS key', () => {
    fc.assert(
      fc.property(
        identifierArb,
        fc.boolean(),
        fc.boolean(),
        (tableName, sseEnabled, withKey) => {
          const stack = freshStack();
          const table = new dynamodb.CfnTable(stack, 'Table', {
            tableName,
            keySchema: [{ attributeName: 'pk', keyType: 'HASH' }],
            sseSpecification: {
              sseEnabled,
              ...(withKey ? { kmsMasterKeyId: 'arn:aws:kms:us-east-1:123456789012:key/k' } : {}),
            },
          });

          const errors = visitAndCollect(stack, new CustomerKeyAspect(), table);
          const shouldFail = !sseEnabled || !withKey;
          expect(errors.length).toBe(shouldFail ? 1 : 0);
          if (shouldFail) {
            expect(errors[0]).toContain('CustomerKeyAspect');
            expect(errors[0]).toContain(tableName);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('errors for a secret, log group or ECR repo without the App_CMK', () => {
    fc.assert(
      fc.property(
        identifierArb,
        fc.constantFrom('secret', 'logGroup', 'ecr'),
        fc.boolean(),
        (name, kind, encrypted) => {
          const stack = freshStack();
          const keyArn = 'arn:aws:kms:us-east-1:123456789012:key/k';

          let resource: IConstruct;
          if (kind === 'secret') {
            resource = new secretsmanager.CfnSecret(stack, 'R', {
              name,
              kmsKeyId: encrypted ? keyArn : undefined,
            });
          } else if (kind === 'logGroup') {
            resource = new logs.CfnLogGroup(stack, 'R', {
              logGroupName: name,
              kmsKeyId: encrypted ? keyArn : undefined,
            });
          } else {
            resource = new ecr.CfnRepository(stack, 'R', {
              repositoryName: name,
              encryptionConfiguration: encrypted
                ? { encryptionType: 'KMS', kmsKey: keyArn }
                : { encryptionType: 'AES256' },
            });
          }

          const errors = visitAndCollect(stack, new CustomerKeyAspect(), resource);
          expect(errors.length).toBe(encrypted ? 0 : 1);
          if (!encrypted) {
            expect(errors[0]).toContain('CustomerKeyAspect');
            expect(errors[0]).toContain(name);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// 3. AuthorizerAspect (Req 9.5, 9.11)
// ---------------------------------------------------------------------------

describe('Property 29 - AuthorizerAspect', () => {
  it('errors for every unauthorized route except $disconnect and $default', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          '$connect',
          '$disconnect',
          '$default',
          'POST /spec',
          'POST /trigger',
          'GET /runs',
        ),
        fc.constantFrom<Array<string | undefined>>('AWS_IAM', 'CUSTOM', 'JWT', 'NONE', undefined),
        (routeKey, authorizationType) => {
          const stack = freshStack();
          const route = new apigwv2.CfnRoute(stack, 'Route', {
            apiId: 'api123',
            routeKey,
            authorizationType,
          });

          const errors = visitAndCollect(stack, new AuthorizerAspect(), route);

          const exempt = routeKey === '$disconnect' || routeKey === '$default';
          const unauthorized = !authorizationType || authorizationType === 'NONE';
          const shouldFail = !exempt && unauthorized;

          expect(errors.length).toBe(shouldFail ? 1 : 0);
          if (shouldFail) {
            expect(errors[0]).toContain('AuthorizerAspect');
            expect(errors[0]).toContain(routeKey);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// 4. NoIamUserAspect (Req 15.8)
// ---------------------------------------------------------------------------

describe('Property 29 - NoIamUserAspect', () => {
  it('errors for every IAM user and access key, and for nothing else', () => {
    fc.assert(
      fc.property(
        identifierArb,
        fc.constantFrom('user', 'accessKey', 'role'),
        (name, kind) => {
          const stack = freshStack();

          let resource: IConstruct;
          if (kind === 'user') {
            resource = new iam.CfnUser(stack, 'R', { userName: name });
          } else if (kind === 'accessKey') {
            resource = new iam.CfnAccessKey(stack, 'R', { userName: name });
          } else {
            resource = new iam.CfnRole(stack, 'R', {
              roleName: name,
              assumeRolePolicyDocument: {},
            });
          }

          const errors = visitAndCollect(stack, new NoIamUserAspect(), resource);
          const shouldFail = kind !== 'role';
          expect(errors.length).toBe(shouldFail ? 1 : 0);
          if (shouldFail) expect(errors[0]).toContain('NoIamUserAspect');
          if (kind === 'user') expect(errors[0]).toContain(name);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// 5. AlarmTargetAspect (Req 12.5)
// ---------------------------------------------------------------------------

describe('Property 29 - AlarmTargetAspect', () => {
  it('errors for exactly the alarms with no notification target', () => {
    fc.assert(
      fc.property(
        identifierArb,
        fc.array(
          fc
            .string({ minLength: 1, maxLength: 8 })
            .filter(s => /^[a-z0-9]+$/.test(s))
            .map(s => `arn:aws:sns:us-east-1:123456789012:${s}`),
          { maxLength: 3 },
        ),
        (alarmName, alarmActions) => {
          const stack = freshStack();
          const alarm = new cloudwatch.CfnAlarm(stack, 'Alarm', {
            alarmName,
            comparisonOperator: 'GreaterThanThreshold',
            evaluationPeriods: 1,
            alarmActions,
          });

          const errors = visitAndCollect(stack, new AlarmTargetAspect(), alarm);
          const shouldFail = alarmActions.length === 0;
          expect(errors.length).toBe(shouldFail ? 1 : 0);
          if (shouldFail) {
            expect(errors[0]).toContain('AlarmTargetAspect');
            expect(errors[0]).toContain(alarmName);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// 6. TagAspect (Req 12.6, 12.7)
// ---------------------------------------------------------------------------

describe('Property 29 - TagAspect', () => {
  const tagKeyArb = fc.constantFrom('app', 'env', 'owner', 'costCentre');

  it('errors once per missing or blank required tag', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(tagKeyArb, { minLength: 1, maxLength: 4 }),
        fc.uniqueArray(tagKeyArb, { maxLength: 4 }),
        fc.constantFrom('value', '', '   '),
        (requiredKeys, appliedKeys, appliedValue) => {
          const stack = freshStack();
          // A taggable L1 with a TagManager.
          const table = new dynamodb.CfnTable(stack, 'Table', {
            tableName: 'tagged',
            keySchema: [{ attributeName: 'pk', keyType: 'HASH' }],
            tags: appliedKeys.map(key => ({ key, value: appliedValue })),
          });

          const required: Record<string, string> = {};
          for (const key of requiredKeys) required[key] = 'expected';

          const errors = visitAndCollect(stack, new TagAspect(required), table);

          const blank = appliedValue.trim() === '';
          const expected = requiredKeys.filter(
            key => !appliedKeys.includes(key) || blank,
          ).length;

          expect(errors.length).toBe(expected);
          for (const message of errors) {
            expect(message).toContain('TagAspect');
            expect(message).toContain(table.node.path);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('raises nothing when every required tag carries a non-blank value', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(tagKeyArb, { minLength: 1, maxLength: 4 }),
        (requiredKeys) => {
          const stack = freshStack();
          const table = new dynamodb.CfnTable(stack, 'Table', {
            tableName: 'tagged',
            keySchema: [{ attributeName: 'pk', keyType: 'HASH' }],
            tags: requiredKeys.map(key => ({ key, value: 'set' })),
          });

          const required: Record<string, string> = {};
          for (const key of requiredKeys) required[key] = 'expected';

          expect(visitAndCollect(stack, new TagAspect(required), table)).toEqual([]);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('ignores a resource that is not taggable', () => {
    fc.assert(
      fc.property(identifierArb, (routeKey) => {
        const stack = freshStack();
        const route = new apigwv2.CfnRoute(stack, 'Route', {
          apiId: 'api123',
          routeKey,
          authorizationType: 'AWS_IAM',
        });
        expect(visitAndCollect(stack, new TagAspect({ app: 'phorma' }), route)).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });
});
