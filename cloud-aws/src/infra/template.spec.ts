/**
 * Template assertion suite for PhormaAwsHostStack.
 *
 * Uses aws-cdk-lib/assertions over the synthesized CDK output to verify the
 * resource inventory, encryption, authorization, networking, alarms and the
 * bootstrap qualifier.
 *
 * Requirements: 4.4, 4.6, 7.9, 7.12, 9.1, 9.5, 9.6, 9.12, 10.1, 10.2, 11.1,
 *   11.7, 11.12, 12.3, 12.4, 13.2, 13.3, 13.5, 18.1
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import * as cxapi from 'aws-cdk-lib/cx-api';
import { Template, Match, Annotations as AssertAnnotations } from 'aws-cdk-lib/assertions';
import { PhormaAwsHostStack } from './stack.js';
import type { AwsDeployConfig } from '../core/config.js';
import { AGENT_PROVIDED_ENV_NAMES, TASK_DEFINITION_ENV_NAMES } from '../server/env.js';
import { MONITOR_API_OUTPUT, REQUIRED_OUTPUTS, TRIGGER_API_OUTPUT } from '../core/outputs.js';
import {
  AlarmTargetAspect,
  AuthorizerAspect,
  CustomerKeyAspect,
  NoIamUserAspect,
  PermissionsBoundaryAspect,
  TagAspect,
} from './aspects.js';

// ---------------------------------------------------------------------------
// Test helper: synthesize the stack with a deterministic config
// ---------------------------------------------------------------------------

const ACCOUNT_ID = '123456789012';
const REGION = 'us-east-1';
const STACK_NAME = 'test-host';
/** The configured bootstrap qualifier, never the CDK default `hnb659fds`. */
const QUALIFIER = 'phorma42';

/**
 * The Container_Image reference the `imageUri` path is exercised with.
 *
 * A platform-published image in an account that is NOT the deploy account, so an
 * assertion cannot pass by accidentally matching the bootstrap repository.
 */
const REFERENCE_IMAGE_URI =
  '210987654321.dkr.ecr.us-east-1.amazonaws.com/platform/phorma-host:1.2.3';

/**
 * Synthesize the stack.
 *
 * `imageUri` is the one axis: absent means the Container_Image is a CDK Docker
 * image asset built from `cloud-aws/Dockerfile`, present means it is that
 * reference verbatim (Req 4.1, 4.2). In a real deploy the value arrives as CDK
 * context out of `cdk.context.phorma.json`; here it is supplied on the parsed
 * config the app hands the stack, which is the same input the context override
 * produces.
 */
function synthesizeStack(imageUri?: string): { app: cdk.App; stack: PhormaAwsHostStack } {
  const app = new cdk.App();
  const config: AwsDeployConfig = {
    accountId: ACCOUNT_ID,
    region: REGION,
    namePrefix: 'test',
    permissionsBoundaryArn: 'arn:aws:iam::123456789012:policy/test-boundary',
    bootstrapQualifier: QUALIFIER,
    egressAllowList: [],
    costAllocationTags: { app: 'phorma' },
    retentionDays: 30,
    alarmNotificationArn: 'arn:aws:sns:us-east-1:123456789012:test-alarms',
    imageUri,
  };

  const stack = new PhormaAwsHostStack(app, 'TestStack', {
    env: { account: config.accountId, region: config.region },
    stackName: STACK_NAME,
    synthesizer: new cdk.DefaultStackSynthesizer({ qualifier: QUALIFIER }),
    config,
  });

  return { app, stack };
}

/** One synthesized image path: the template plus the assembly it was written to. */
interface ImagePathSynthesis {
  readonly template: Template;
  readonly assembly: cxapi.CloudAssembly;
}

/**
 * Memoized synthesis, keyed by the image path.
 *
 * The asset path fingerprints the whole repository-root build context, so it
 * costs seconds rather than the ~100ms the reference path costs. Synthesize each
 * path ONCE and share the result: `Template.fromStack` already synthesized the
 * app, so the following `app.synth()` hands back that same assembly instead of
 * paying again. A `Template` here is only ever read, so sharing one instance is
 * safe.
 */
const synthesisCache = new Map<string, ImagePathSynthesis>();

function synthesizeImagePath(imageUri?: string): ImagePathSynthesis {
  const key = imageUri ?? '';
  const cached = synthesisCache.get(key);
  if (cached) return cached;

  const { app, stack } = synthesizeStack(imageUri);
  const synthesis: ImagePathSynthesis = {
    template: Template.fromStack(stack),
    assembly: app.synth(),
  };
  synthesisCache.set(key, synthesis);
  return synthesis;
}

/** The asset path - `imageUri` absent - which is also the default stack shape. */
function assetPath(): ImagePathSynthesis {
  return synthesizeImagePath();
}

/** The `imageUri` path, referencing a platform-published image. */
function referencePath(): ImagePathSynthesis {
  return synthesizeImagePath(REFERENCE_IMAGE_URI);
}

// Synthesize once, use across all assertions
function getTemplate(): Template {
  return assetPath().template;
}

// ---------------------------------------------------------------------------
// Resource inventory (Req 11.1, 18.1)
// ---------------------------------------------------------------------------

describe('Template - resource inventory', () => {
  it('creates exactly one DynamoDB table', () => {
    const t = getTemplate();
    t.resourceCountIs('AWS::DynamoDB::Table', 1);
  });

  it('creates exactly one HTTP API (Trigger_API)', () => {
    const t = getTemplate();
    // HTTP APIs use AWS::ApiGatewayV2::Api with ProtocolType HTTP
    t.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'HTTP',
    });
  });

  it('creates exactly one WebSocket API (Monitor_API)', () => {
    const t = getTemplate();
    t.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'WEBSOCKET',
    });
  });

  it('creates exactly two ApiGatewayV2 APIs total (HTTP + WebSocket)', () => {
    const t = getTemplate();
    t.resourceCountIs('AWS::ApiGatewayV2::Api', 2);
  });
});

// ---------------------------------------------------------------------------
// VPC endpoints with private DNS (Req 10.1, 10.2)
// ---------------------------------------------------------------------------

describe('Template - VPC endpoints with private DNS', () => {
  it('creates interface endpoints with PrivateDnsEnabled: true', () => {
    const t = getTemplate();
    const endpoints = t.findResources('AWS::EC2::VPCEndpoint', {
      Properties: {
        VpcEndpointType: 'Interface',
        PrivateDnsEnabled: true,
      },
    });
    // Secrets Manager, ECR API, ECR Docker, CloudWatch Logs, STS, Scheduler = 6
    expect(Object.keys(endpoints).length).toBe(6);
  });

  it('creates a DynamoDB gateway endpoint', () => {
    const t = getTemplate();
    t.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
      ServiceName: Match.stringLikeRegexp('dynamodb'),
    });
  });
});

// ---------------------------------------------------------------------------
// AssignPublicIp: DISABLED (Req 10.1)
// ---------------------------------------------------------------------------

describe('Template - Fargate AssignPublicIp', () => {
  it('sets AssignPublicIp to DISABLED on the Fargate service', () => {
    const t = getTemplate();
    t.hasResourceProperties('AWS::ECS::Service', {
      NetworkConfiguration: {
        AwsvpcConfiguration: {
          AssignPublicIp: 'DISABLED',
        },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// App_CMK encryption on the four encrypted resources (Req 11.1, 11.7, 11.12)
// ---------------------------------------------------------------------------

describe('Template - App_CMK encryption', () => {
  it('Run_Table uses CUSTOMER_MANAGED encryption with App_CMK', () => {
    const t = getTemplate();
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      SSESpecification: {
        SSEEnabled: true,
        SSEType: 'KMS',
      },
    });
  });

  it('CloudWatch log group has an encryption key', () => {
    const t = getTemplate();
    t.hasResourceProperties('AWS::Logs::LogGroup', {
      KmsKeyId: Match.anyValue(),
    });
  });
});

// ---------------------------------------------------------------------------
// Log retention (Req 11.7)
// ---------------------------------------------------------------------------

describe('Template - log retention', () => {
  it('log group has a retention policy set', () => {
    const t = getTemplate();
    t.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: Match.anyValue(),
    });
  });
});

// ---------------------------------------------------------------------------
// kms:Decrypt with ViaService condition (Req 11.12)
// ---------------------------------------------------------------------------

describe('Template - kms:Decrypt with ViaService condition', () => {
  it('Runtime_Identity has kms:Decrypt with StringEquals kms:ViaService', () => {
    const t = getTemplate();
    // Find the managed policy with kms:Decrypt
    t.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['kms:Decrypt']),
            Condition: {
              StringEquals: {
                'kms:ViaService': Match.anyValue(),
              },
            },
          }),
        ]),
      },
    });
  });

  it('ViaService condition includes dynamodb, secretsmanager and logs services', () => {
    const t = getTemplate();
    t.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['kms:Decrypt']),
            Condition: {
              StringEquals: {
                'kms:ViaService': Match.arrayWith([
                  'dynamodb.us-east-1.amazonaws.com',
                  'secretsmanager.us-east-1.amazonaws.com',
                  'logs.us-east-1.amazonaws.com',
                ]),
              },
            },
          }),
        ]),
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Route authorizers (Req 9.5, 9.6)
// ---------------------------------------------------------------------------

describe('Template - route authorizers', () => {
  it('every Trigger_API route has AWS_IAM authorization', () => {
    const t = getTemplate();
    const routes = t.findResources('AWS::ApiGatewayV2::Route');
    const triggerRoutes = Object.entries(routes).filter(([, resource]) => {
      const props = (resource as { Properties?: { AuthorizationType?: string; RouteKey?: string } }).Properties;
      // Trigger_API routes are non-WebSocket routes (not $connect, $disconnect, $default)
      const routeKey = props?.RouteKey ?? '';
      return !routeKey.startsWith('$');
    });

    expect(triggerRoutes.length).toBeGreaterThan(0);
    for (const [logicalId, resource] of triggerRoutes) {
      const props = (resource as { Properties?: { AuthorizationType?: string } }).Properties;
      expect(props?.AuthorizationType, `Route ${logicalId} must have AWS_IAM auth`).toBe('AWS_IAM');
    }
  });

  it('Monitor_API $connect route has AWS_IAM authorization', () => {
    const t = getTemplate();
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: '$connect',
      AuthorizationType: 'AWS_IAM',
    });
  });
});

// ---------------------------------------------------------------------------
// Monitor_API request templates (Req 11.7, 8.7, 7.7)
// ---------------------------------------------------------------------------

/**
 * The `$default` request template of every integration that has one, flattened
 * to text.
 *
 * The table name is a CloudFormation token, so a template synthesizes to an
 * `Fn::Join` rather than a plain string. Stringifying the node keeps the VTL
 * readable for substring assertions without hand-resolving the join.
 */
function requestTemplateTexts(t: Template): string[] {
  const integrations = t.findResources('AWS::ApiGatewayV2::Integration');
  const texts: string[] = [];
  for (const resource of Object.values(integrations)) {
    const props = (resource as { Properties?: { RequestTemplates?: Record<string, unknown> } })
      .Properties;
    const template = props?.RequestTemplates?.['$default'];
    if (template !== undefined) texts.push(JSON.stringify(template));
  }
  return texts;
}

/** The one flattened template containing `marker`, asserted to be unique. */
function templateContaining(t: Template, marker: string): string {
  const matches = requestTemplateTexts(t).filter((text) => text.includes(marker));
  expect(matches.length, `expected exactly one request template with ${marker}`).toBe(1);
  return matches[0]!;
}

describe('Template - Monitor_API request templates', () => {
  it('no request template reads the non-existent authorizer context', () => {
    const t = getTemplate();
    // Every route is AWS_IAM authorized, so there is no authorizer and
    // $context.authorizer.* resolves to nothing - an item written from it would
    // land under partition key `wf#` with an empty workflow id.
    for (const text of requestTemplateTexts(t)) {
      expect(text).not.toContain('$context.authorizer');
    }
  });

  it('$connect writes wf#{workflowId} from the signed query string', () => {
    const t = getTemplate();
    const connect = templateContaining(t, 'conn#$context.connectionId');
    expect(connect).toContain("#set($workflowId = $input.params('workflowId'))");
    expect(connect).toContain('wf#$workflowId');
  });

  it('$connect ttl is epoch seconds two hours out', () => {
    const t = getTemplate();
    const connect = templateContaining(t, 'conn#$context.connectionId');
    expect(connect).toContain('#set($ttl = $context.requestTimeEpoch / 1000 + 7200)');
    expect(connect).toContain('ttl\\":{\\"N\\":\\"$ttl');
  });

  it('$default writes wf#{workflowId} read from the frame body', () => {
    const t = getTemplate();
    const frame = templateContaining(t, 'frame#');
    expect(frame).toContain("#set($workflowId = $input.path('$.workflowId'))");
    expect(frame).toContain('wf#$workflowId');
  });

  it('$default sort key matches keys.ts frameSk - 13-digit padded arrival time', () => {
    const t = getTemplate();
    const frame = templateContaining(t, 'frame#');
    // 13 zeros prepended, last 13 characters kept: lexicographic order equals
    // arrival order, which the Frame_Inbox drain depends on.
    expect(frame).toContain('0000000000000$context.requestTimeEpoch');
    expect(frame).toContain('#set($cut = $padSource.length() - 13)');
    expect(frame).toContain('#set($arrivedAt = $padSource.substring($cut))');
    expect(frame).toContain('frame#$arrivedAt#$context.connectionId#0000');
  });

  it('$default ttl is epoch seconds one hour out', () => {
    const t = getTemplate();
    const frame = templateContaining(t, 'frame#');
    expect(frame).toContain('#set($ttl = $context.requestTimeEpoch / 1000 + 3600)');
  });

  it('no template writes epoch milliseconds into ttl', () => {
    const t = getTemplate();
    for (const text of requestTemplateTexts(t)) {
      expect(text).not.toContain('ttl\\":{\\"N\\":\\"$context.requestTimeEpoch');
    }
  });

  it('$disconnect is a MOCK integration that writes nothing', () => {
    const t = getTemplate();
    const integrations = t.findResources('AWS::ApiGatewayV2::Integration');
    const mocks = Object.values(integrations).filter(
      (resource) =>
        (resource as { Properties?: { IntegrationType?: string } }).Properties?.IntegrationType ===
        'MOCK',
    );
    expect(mocks.length).toBe(1);

    // The query string is unavailable outside $connect, so no DeleteItem
    // integration can address the right partition - pruning is the TTL plus the
    // GoneException path in MonitorAdapter.push (Req 8.7).
    for (const resource of Object.values(integrations)) {
      const uri = (resource as { Properties?: { IntegrationUri?: unknown } }).Properties
        ?.IntegrationUri;
      expect(JSON.stringify(uri ?? '')).not.toContain('DeleteItem');
    }
  });
});

// ---------------------------------------------------------------------------
// execute-api:ManageConnections scoped to Monitor_API stage (Req 7.12)
// ---------------------------------------------------------------------------

describe('Template - execute-api:ManageConnections', () => {
  it('has a policy with exactly ManageConnections scoped to the Monitor_API stage', () => {
    const t = getTemplate();
    t.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'execute-api:ManageConnections',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  it('ManageConnections resource references the monitor API stage ARN with /POST/@connections/*', () => {
    const t = getTemplate();
    // The stageArn is constructed with Fn::Join containing the stage ref and
    // /POST/@connections/*
    t.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'execute-api:ManageConnections',
            Resource: Match.anyValue(),
          }),
        ]),
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Both alarms (Req 12.3, 12.4)
// ---------------------------------------------------------------------------

describe('Template - CloudWatch alarms', () => {
  it('creates exactly two CloudWatch alarms', () => {
    const t = getTemplate();
    t.resourceCountIs('AWS::CloudWatch::Alarm', 2);
  });

  it('creates the FailedScheduledRun alarm', () => {
    const t = getTemplate();
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'test-failed-scheduled-run',
      MetricName: 'FailedScheduledRun',
    });
  });

  it('creates the LeaseTakeover alarm', () => {
    const t = getTemplate();
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'test-lease-takeover',
      MetricName: 'LeaseTakeover',
    });
  });

  it('both alarms have alarm actions configured', () => {
    const t = getTemplate();
    const alarms = t.findResources('AWS::CloudWatch::Alarm');
    for (const [logicalId, resource] of Object.entries(alarms)) {
      const props = (resource as { Properties?: { AlarmActions?: unknown[] } }).Properties;
      expect(props?.AlarmActions, `Alarm ${logicalId} must have actions`).toBeDefined();
      expect(
        Array.isArray(props?.AlarmActions) && props.AlarmActions.length > 0,
        `Alarm ${logicalId} must have at least one action`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Bootstrap qualifier (Req 13.3)
// ---------------------------------------------------------------------------

describe('Template - bootstrap qualifier', () => {
  it('synthesizer uses the configured bootstrap qualifier', () => {
    // The stack uses DefaultStackSynthesizer with qualifier 'phorma42'.
    // This manifests in the asset parameters and roles referencing
    // 'cdk-phorma42-assets-*' instead of the default 'cdk-hnb659fds-assets-*'.
    const app = new cdk.App();
    const config: AwsDeployConfig = {
      accountId: '123456789012',
      region: 'us-east-1',
      namePrefix: 'test',
      permissionsBoundaryArn: 'arn:aws:iam::123456789012:policy/test-boundary',
      bootstrapQualifier: 'custom99',
      egressAllowList: [],
      costAllocationTags: { app: 'phorma' },
      retentionDays: 30,
      alarmNotificationArn: 'arn:aws:sns:us-east-1:123456789012:test-alarms',
    };

    const stack = new PhormaAwsHostStack(app, 'QualifierTest', {
      env: { account: config.accountId, region: config.region },
      stackName: 'qualifier-test',
      synthesizer: new cdk.DefaultStackSynthesizer({ qualifier: 'custom99' }),
      config,
    });

    // Verify the synthesizer has the correct qualifier by checking it was
    // applied - the stack's synthesizer should reference our qualifier
    const synthesizer = stack.synthesizer as cdk.DefaultStackSynthesizer;
    expect(synthesizer).toBeDefined();

    // Synthesize to verify it doesn't throw
    const assembly = app.synth();
    const stackArtifact = assembly.getStackByName('qualifier-test');
    expect(stackArtifact).toBeDefined();

    // The asset manifest should reference the qualifier in bucket names
    const templateStr = JSON.stringify(stackArtifact.template);
    // DefaultStackSynthesizer with qualifier 'custom99' references it in
    // the bootstrap roles/buckets
    expect(templateStr).not.toContain('hnb659fds');
  });
});


// ---------------------------------------------------------------------------
// Six Aspects wired into the stack (Req 9.5, 9.11, 11.1, 12.5, 12.6, 12.7,
// 13.4, 13.5, 15.8)
//
// The Aspects are only guardrails if they are actually registered. Asserting
// the classes exist would pass while they sat as dead code, so these assert
// registration on the synthesized stack and that synthesis is clean.
// ---------------------------------------------------------------------------

describe('Template - Aspects', () => {
  const aspectCases: ReadonlyArray<readonly [string, Function]> = [
    ['PermissionsBoundaryAspect', PermissionsBoundaryAspect],
    ['CustomerKeyAspect', CustomerKeyAspect],
    ['AuthorizerAspect', AuthorizerAspect],
    ['NoIamUserAspect', NoIamUserAspect],
    ['AlarmTargetAspect', AlarmTargetAspect],
    ['TagAspect', TagAspect],
  ];

  for (const [name, ctor] of aspectCases) {
    it(`${name} is wired into the stack`, () => {
      const { stack } = synthesizeStack();
      const applied = cdk.Aspects.of(stack).all;
      expect(
        applied.some(aspect => aspect instanceof (ctor as new (...args: never[]) => object)),
      ).toBe(true);
    });
  }

  it('registers exactly the six guardrail Aspects', () => {
    const { stack } = synthesizeStack();
    const guardrails = cdk.Aspects.of(stack).all.filter(aspect =>
      aspectCases.some(
        ([, ctor]) => aspect instanceof (ctor as new (...args: never[]) => object),
      ),
    );
    expect(guardrails).toHaveLength(6);
  });

  it('synthesizes the real stack with no Aspect error annotation', () => {
    const { stack } = synthesizeStack();
    // Force the Aspects to run over the complete tree.
    Template.fromStack(stack);
    const errors = AssertAnnotations.fromStack(stack).findError(
      '*',
      Match.stringLikeRegexp('.*'),
    );
    expect(errors.map(e => e.entry.data)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Additional structural assertions
// ---------------------------------------------------------------------------

describe('Template - structural', () => {
  it('creates an ECS cluster', () => {
    const t = getTemplate();
    t.resourceCountIs('AWS::ECS::Cluster', 1);
  });

  it('creates a Fargate service', () => {
    const t = getTemplate();
    t.resourceCountIs('AWS::ECS::Service', 1);
  });

  it('creates exactly four IAM roles', () => {
    const t = getTemplate();
    // Runtime, Execution, Deployment, SchedulerInvoke + MonitorIntegration = 5
    // MonitorIntegration is the API Gateway integration role
    const roles = t.findResources('AWS::IAM::Role');
    expect(Object.keys(roles).length).toBeGreaterThanOrEqual(4);
  });

  it('creates a Network Load Balancer', () => {
    const t = getTemplate();
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internal',
    });
  });

  it('creates a schedule group', () => {
    const t = getTemplate();
    t.resourceCountIs('AWS::Scheduler::ScheduleGroup', 1);
  });

  // -------------------------------------------------------------------------
  // Schedule_Shim
  //
  // EventBridge Scheduler cannot target an API Gateway route: its templated
  // targets are CodeBuild, CodePipeline, ECS RunTask, EventBridge PutEvents,
  // Inspector, Kinesis, Firehose, Lambda, SageMaker, SNS, SQS and Step Functions,
  // and its universal target reaches AWS SDK operations rather than REST
  // endpoints. Lambda Invoke IS supported, so this function is the hop.
  // -------------------------------------------------------------------------

  it('creates exactly one Lambda function, the Schedule_Shim', () => {
    const t = getTemplate();
    t.resourceCountIs('AWS::Lambda::Function', 1);
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'test-schedule-shim',
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
    });
  });

  it('runs the Schedule_Shim outside the VPC', () => {
    // The Trigger_API endpoint is public regional and IAM-guarded, so VPC
    // placement would buy an ENI cold start and an extra interface endpoint for
    // reachability the function already has.
    const functions = getTemplate().findResources('AWS::Lambda::Function');
    for (const fn of Object.values(functions)) {
      expect((fn as { Properties?: Record<string, unknown> }).Properties?.['VpcConfig'])
        .toBeUndefined();
    }
  });

  it('gives the Schedule_Shim the Trigger_API URL and signing region', () => {
    const functions = getTemplate().findResources('AWS::Lambda::Function');
    const [fn] = Object.values(functions);
    const env = (fn as { Properties: { Environment: { Variables: Record<string, unknown> } } })
      .Properties.Environment.Variables;

    expect(env['PHORMA_TRIGGER_API_URL']).toBeDefined();
    expect(env['PHORMA_REGION']).toBeDefined();
  });

  it('caps Schedule_Shim concurrency', () => {
    const t = getTemplate();
    t.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: 10,
    });
  });

  it('encrypts the Schedule_Shim log group with the App_CMK', () => {
    const groups = Object.values(
      getTemplate().findResources('AWS::Logs::LogGroup'),
    ) as { Properties: Record<string, unknown> }[];
    const shimGroup = groups.find(
      g => g.Properties['LogGroupName'] === '/phorma/test/schedule-shim',
    );

    expect(shimGroup, 'the Schedule_Shim must own a log group').toBeDefined();
    // Unencrypted by default, which would leave shim logs outside the estate's
    // one key. `CustomerKeyAspect` covers the resources it knows about; this
    // pins the new one explicitly.
    expect(shimGroup!.Properties['KmsKeyId']).toBeDefined();
  });

  it('DynamoDB table has TTL enabled', () => {
    const t = getTemplate();
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: {
        AttributeName: 'ttl',
        Enabled: true,
      },
    });
  });

  it('DynamoDB table has point-in-time recovery enabled', () => {
    const t = getTemplate();
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// The two Container_Image paths (Req 4.4, 4.6, 13.5)
//
// Criterion 4.6 as originally written expected an ECR repository on the asset
// path and none on the `imageUri` path. That is not achievable: a CDK Docker
// image asset publishes into the CDK BOOTSTRAP image repository, which is a
// Platform_Prerequisite created by `cdk bootstrap`, not by this stack. The
// corrected criterion asserts zero `AWS::ECR::Repository` on BOTH paths, and per
// path: the asset path resolves the container image through the bootstrap image
// repository and writes exactly one Docker image entry into the asset manifest,
// the `imageUri` path carries the configured reference verbatim and writes zero.
// ---------------------------------------------------------------------------

/** The CDK bootstrap image repository for the CONFIGURED qualifier. */
const BOOTSTRAP_IMAGE_REPOSITORY = `cdk-${QUALIFIER}-container-assets-${ACCOUNT_ID}-${REGION}`;

/** The `AWS::URLSuffix` pseudo parameter, kept out of a template literal. */
const URL_SUFFIX = '${AWS::URLSuffix}';

/**
 * The `Image` of the one container definition in the stack, asserted unique.
 *
 * A `Fn::Sub` object on the asset path, a plain string on the reference path, so
 * the caller gets it unresolved and asserts the shape it expects.
 */
function theContainerImage(t: Template): unknown {
  const taskDefs = t.findResources('AWS::ECS::TaskDefinition');
  const images: unknown[] = [];
  for (const resource of Object.values(taskDefs)) {
    const containers =
      (resource as { Properties?: { ContainerDefinitions?: ReadonlyArray<{ Image?: unknown }> } })
        .Properties?.ContainerDefinitions ?? [];
    for (const container of containers) images.push(container.Image);
  }
  expect(images.length, 'expected exactly one container definition').toBe(1);
  return images[0];
}

/** The part of one `dockerImages` manifest entry these assertions read. */
interface DockerImageManifestEntry {
  readonly source?: { readonly directory?: string; readonly dockerFile?: string };
  readonly destinations?: Record<
    string,
    { readonly repositoryName?: string; readonly imageTag?: string }
  >;
}

/**
 * The `dockerImages` entries of the stack's asset manifest.
 *
 * Read off the synthesized cloud assembly rather than by guessing the shape of
 * `<stackname>.assets.json`: `AssetManifestArtifact.contents` is the parsed
 * manifest, so the entry count and each destination come from the same file
 * `cdk-assets` publishes from.
 */
function dockerImageEntries(
  synthesis: ImagePathSynthesis,
): ReadonlyArray<readonly [string, DockerImageManifestEntry]> {
  const manifests = synthesis.assembly.artifacts.filter(
    cxapi.AssetManifestArtifact.isAssetManifestArtifact,
  );
  expect(manifests.length, 'expected exactly one asset manifest artifact').toBe(1);
  return Object.entries(manifests[0]!.contents.dockerImages ?? {});
}

describe('Template - Container_Image paths', () => {
  // Both paths are synthesized here, once, and shared by every assertion below:
  // the asset path fingerprints the repository-root build context, so a synth per
  // test would multiply seconds. The explicit 30s is the HOOK timeout, which
  // `testTimeout` in `vitest.config.ts` does not cover - it defaults to 10s,
  // under what a cold asset fingerprint can cost.
  beforeAll(() => {
    assetPath();
    referencePath();
  }, 30_000);

  // -- asset path ----------------------------------------------------------

  it('asset path: the container image resolves through the bootstrap image repository', () => {
    const [, entry] = dockerImageEntries(assetPath())[0]!;
    const destinations = Object.values(entry.destinations ?? {});
    expect(destinations.length).toBe(1);
    const imageTag = destinations[0]!.imageTag;

    // The account and region are concrete, the URL suffix is left to
    // CloudFormation, and the repository is the bootstrap one for the configured
    // qualifier - the tag being the manifest's own imageTag is what ties the task
    // definition to the entry `cdk-assets` publishes.
    const registry = `${ACCOUNT_ID}.dkr.ecr.${REGION}.${URL_SUFFIX}`;
    expect(theContainerImage(assetPath().template)).toEqual({
      'Fn::Sub': `${registry}/${BOOTSTRAP_IMAGE_REPOSITORY}:${imageTag}`,
    });
  });

  it('asset path: the bootstrap repository comes from the configured qualifier', () => {
    const image = JSON.stringify(theContainerImage(assetPath().template));
    expect(image).toContain(`cdk-${QUALIFIER}-container-assets-`);
    expect(image).not.toContain('hnb659fds');
  });

  it('asset path: the asset manifest carries exactly one Docker image entry', () => {
    const entries = dockerImageEntries(assetPath());
    expect(entries.length).toBe(1);
    const [, entry] = entries[0]!;
    for (const destination of Object.values(entry.destinations ?? {})) {
      expect(destination.repositoryName).toBe(BOOTSTRAP_IMAGE_REPOSITORY);
    }
  });

  it('asset path: declares zero ECR repositories', () => {
    // The image lands in the bootstrap repository, a Platform_Prerequisite, so
    // the stack owns no repository of its own.
    assetPath().template.resourceCountIs('AWS::ECR::Repository', 0);
  });

  // -- imageUri path -------------------------------------------------------

  it('imageUri path: the container image equals the configured reference verbatim', () => {
    // Verbatim: no re-tagging, no rewrite into the deploy account's registry.
    expect(theContainerImage(referencePath().template)).toBe(REFERENCE_IMAGE_URI);
  });

  it('imageUri path: the asset manifest carries zero Docker image entries', () => {
    expect(dockerImageEntries(referencePath()).length).toBe(0);
  });

  it('imageUri path: declares zero ECR repositories', () => {
    referencePath().template.resourceCountIs('AWS::ECR::Repository', 0);
  });

  // -- Req 4.4: both paths synthesize unauthenticated, with no Docker daemon --

  it('both paths synthesize with no credentials and no Docker daemon', () => {
    // This suite runs inside `npm run check`, which runs with no AWS credentials
    // and does not require Docker, so both synths having completed IS the
    // assertion - stated here rather than left incidental to the tests above.
    for (const [name, synthesis] of [
      ['asset', assetPath()],
      ['imageUri', referencePath()],
    ] as const) {
      expect(synthesis.assembly.getStackByName(STACK_NAME).template, `${name} path`).toBeDefined();
      // Anything in `missing` is a context provider the CLI would have to call
      // AWS to answer, which is what would demand credentials at synth time.
      // Empty is the reason `fromVpcAttributes` is used and `fromLookup` is not.
      expect(synthesis.assembly.manifest.missing ?? [], `${name} path context lookups`).toEqual([]);
    }

    // No Docker daemon: the asset entry describes a build to run at PUBLISH
    // time - a staged context directory plus the Dockerfile within it - so synth
    // only fingerprints files.
    const [, entry] = dockerImageEntries(assetPath())[0]!;
    expect(entry.source?.dockerFile).toBe('cloud-aws/Dockerfile');
    expect(entry.source?.directory).toMatch(/^asset\.[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// The Server_Entry environment contract (Req 7.9)
//
// The names `readServerEnv` requires and the names the task definition sets are
// declared in two files, so nothing but an assertion stops them drifting apart.
// The lists are IMPORTED from `src/server/env.ts` rather than restated here, so
// this suite cannot agree with a stale copy of the contract.
//
// The correspondence is asserted in BOTH directions: every
// `TASK_DEFINITION_ENV_NAMES` entry is set, and nothing else is. One direction
// alone leaves a hole - a name added to the container definition without being
// added to `env.ts` would be a value the server never reads, and a name removed
// from `env.ts` without being removed here would look fine forever.
//
// `AGENT_PROVIDED_ENV_NAMES` is asserted ABSENT. `AWS_REGION` reaching the task
// from the Fargate agent is what makes a region misconfiguration visible; a
// hard-coded value in the template would mask it.
// ---------------------------------------------------------------------------

/** One `Environment` entry of a synthesized container definition. */
interface ContainerEnvEntry {
  readonly Name?: string;
  readonly Value?: unknown;
}

/**
 * The `Environment` array of the one container definition in the stack.
 *
 * Asserted unique for the same reason `theContainerImage` does: an assertion
 * that silently read the first of several containers would pass while the task
 * ran a second, unconfigured one.
 */
function theContainerEnvironment(t: Template): readonly ContainerEnvEntry[] {
  const taskDefs = t.findResources('AWS::ECS::TaskDefinition');
  const environments: Array<readonly ContainerEnvEntry[]> = [];
  for (const resource of Object.values(taskDefs)) {
    const containers =
      (
        resource as {
          Properties?: {
            ContainerDefinitions?: ReadonlyArray<{ Environment?: readonly ContainerEnvEntry[] }>;
          };
        }
      ).Properties?.ContainerDefinitions ?? [];
    for (const container of containers) environments.push(container.Environment ?? []);
  }
  expect(environments.length, 'expected exactly one container definition').toBe(1);
  return environments[0]!;
}

/** The environment as a name-to-value map, with duplicate names rejected. */
function containerEnvMap(t: Template): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const entry of theContainerEnvironment(t)) {
    const name = entry.Name;
    expect(name, 'every environment entry must carry a Name').toBeTypeOf('string');
    expect(map.has(name as string), `duplicate environment name ${name}`).toBe(false);
    map.set(name as string, entry.Value);
  }
  return map;
}

describe('Template - Server_Entry environment contract', () => {
  it('sets every name readServerEnv requires of the task definition', () => {
    const names = [...containerEnvMap(getTemplate()).keys()];
    for (const required of TASK_DEFINITION_ENV_NAMES) {
      expect(names, `task definition must set ${required}`).toContain(required);
    }
  });

  it('sets no environment name outside TASK_DEFINITION_ENV_NAMES', () => {
    // The reverse direction. A name here that `env.ts` does not declare is a
    // value nothing reads, and it means the two ends have already diverged.
    const declared = new Set<string>(TASK_DEFINITION_ENV_NAMES);
    for (const name of containerEnvMap(getTemplate()).keys()) {
      expect(declared.has(name), `${name} is set on the container but absent from env.ts`).toBe(
        true,
      );
    }
  });

  it('does not set the names the ECS agent provides', () => {
    const names = new Set<string>(containerEnvMap(getTemplate()).keys());
    for (const provided of AGENT_PROVIDED_ENV_NAMES) {
      expect(names.has(provided), `${provided} is agent-provided and must not be set here`).toBe(
        false,
      );
    }
  });

  it('gives every name a non-empty value', () => {
    // A name present with a blank value passes a name-only check and still fails
    // startup: `readServerEnv` treats blank as absent. Several values are
    // CloudFormation tokens, so the check is over the unresolved node - a `Ref`
    // or `Fn::Join` is accepted, an empty string or empty structure is not.
    for (const [name, value] of containerEnvMap(getTemplate())) {
      expect(value, `${name} must have a value`).toBeDefined();
      if (typeof value === 'string') {
        expect(value.trim(), `${name} must not be blank`).not.toBe('');
      } else {
        expect(Object.keys(value as object).length, `${name} must resolve to something`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('sets exactly as many names as the contract declares', () => {
    // Follows from the two directions above, stated separately so a failure
    // reads as a count rather than as a missing name.
    expect(theContainerEnvironment(getTemplate()).length).toBe(TASK_DEFINITION_ENV_NAMES.length);
  });

  it('points PHORMA_SCHEDULE_TARGET_ARN at the Schedule_Shim, never at a route', () => {
    // This is the defect that made every cron-carrying spec push fail: the value
    // here used to be the `execute-api` scheduled-run route ARN, which
    // `CreateSchedule` rejects because EventBridge Scheduler has no API Gateway
    // target. It must reference the Lambda function instead.
    const target = containerEnvMap(getTemplate()).get('PHORMA_SCHEDULE_TARGET_ARN');
    expect(target).toBeDefined();

    const rendered = JSON.stringify(target);
    expect(rendered).not.toContain('execute-api');
    // A `Fn::GetAtt` on the shim function resolves to its ARN.
    expect(rendered).toContain('ScheduleShim');
  });
});

// ---------------------------------------------------------------------------
// The two endpoint outputs (Req 9.1)
//
// These outputs are the whole of endpoint discovery: the `deploy` and `outputs`
// verbs look the values up BY NAME and the Studio persists them into
// `triggerApiUrl` / `monitorApiUrl`. The names are IMPORTED from
// `core/outputs.ts` rather than restated, so a rename there fails these
// assertions instead of quietly passing them.
//
// The values are asserted through `new URL(...)`, against the rules the
// Config_Parser enforces on the fields they land in: `https:` with no trailing
// slash for the trigger, `wss:` for the monitor. Emitting a value the parser
// rejects would produce a deploy whose own config the CLI then refuses - a round
// trip that nothing else in this spec covers, because the Studio-side tasks stub
// the transport.
// ---------------------------------------------------------------------------

/** What a token stands in as when an output value is flattened to text. */
const TOKEN_STANDIN = 'token';

/**
 * One output value as concrete text.
 *
 * The API id and the Monitor_API stage name are CloudFormation tokens, so the
 * value synthesizes to an `Fn::Join` rather than a plain string. Substituting a
 * literal for each token yields a URL that can actually be parsed, which is what
 * makes the scheme and path assertions below real rather than substring guesses.
 */
function flattenOutputValue(value: unknown): string {
  if (typeof value === 'string') return value;
  const join = (value as { 'Fn::Join'?: [string, unknown[]] })['Fn::Join'];
  expect(join, `output value is neither a string nor an Fn::Join: ${JSON.stringify(value)}`)
    .toBeDefined();
  const [separator, parts] = join!;
  return parts.map(part => (typeof part === 'string' ? part : TOKEN_STANDIN)).join(separator);
}

/** The one output under `logicalId`, asserted present. */
function theOutput(t: Template, logicalId: string): { Value?: unknown; Export?: unknown } {
  const outputs = t.findOutputs(logicalId);
  expect(Object.keys(outputs), `expected exactly one output named ${logicalId}`).toEqual([
    logicalId,
  ]);
  return outputs[logicalId] as { Value?: unknown; Export?: unknown };
}

describe('Template - endpoint outputs', () => {
  it('emits every output endpoint discovery requires, under its exact logical id', () => {
    const t = getTemplate();
    for (const name of REQUIRED_OUTPUTS) {
      expect(Object.keys(t.findOutputs(name)), `missing output ${name}`).toEqual([name]);
    }
  });

  it('emits nothing but those two outputs', () => {
    // An extra output is not harmless: discovery reports by name, and an operator
    // reading the stack outputs should see the two endpoints and nothing to sift.
    const all = Object.keys(getTemplate().findOutputs('*')).sort();
    expect(all).toEqual([...REQUIRED_OUTPUTS].sort());
  });

  it('exports each output under a name derived from the configured namePrefix', () => {
    const t = getTemplate();
    // 'test' is the namePrefix `synthesizeStack` configures, so an output that
    // hardcoded a prefix would fail here.
    expect(theOutput(t, TRIGGER_API_OUTPUT).Export).toEqual({ Name: 'test-trigger-api-url' });
    expect(theOutput(t, MONITOR_API_OUTPUT).Export).toEqual({ Name: 'test-monitor-api-url' });
  });

  it('the Trigger_API URL is https, region-correct and free of a stage path', () => {
    const url = new URL(flattenOutputValue(theOutput(getTemplate(), TRIGGER_API_OUTPUT).Value));
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe(`${TOKEN_STANDIN}.execute-api.${REGION}.amazonaws.com`);
    // The `$default` stage is served at the API root, so a Trigger_Route path can
    // be appended straight onto this value.
    expect(url.pathname).toBe('/');
  });

  it('the Monitor_API URL is wss and carries the stage segment', () => {
    const url = new URL(flattenOutputValue(theOutput(getTemplate(), MONITOR_API_OUTPUT).Value));
    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe(`${TOKEN_STANDIN}.execute-api.${REGION}.amazonaws.com`);
    // A WebSocket API is only reachable through its stage, so unlike the trigger
    // base URL this one must have a path segment.
    expect(url.pathname).toBe(`/${TOKEN_STANDIN}`);
  });

  it('derives the Monitor_API stage segment from the stage resource', () => {
    // The stage name is NOT restated here: the segment is a Ref to the stage, so
    // renaming the stage in `monitor-api.ts` moves the output with it instead of
    // leaving the Studio dialling a stage that no longer exists.
    const value = theOutput(getTemplate(), MONITOR_API_OUTPUT).Value as {
      'Fn::Join'?: [string, unknown[]];
    };
    const parts = value['Fn::Join']?.[1] ?? [];
    const refs = parts.filter(part => typeof part === 'object' && part !== null);
    // One for the API id, one for the stage.
    expect(refs.length).toBe(2);
    expect(JSON.stringify(parts)).not.toContain('live');
  });

  it('both values satisfy the Config_Parser rules for the fields they land in', () => {
    const t = getTemplate();
    const trigger = flattenOutputValue(theOutput(t, TRIGGER_API_OUTPUT).Value);
    const monitor = flattenOutputValue(theOutput(t, MONITOR_API_OUTPUT).Value);

    // `triggerApiUrl`: https, no query, no fragment, no trailing slash.
    const triggerUrl = new URL(trigger);
    expect(triggerUrl.protocol).toBe('https:');
    expect(triggerUrl.search).toBe('');
    expect(triggerUrl.hash).toBe('');
    expect(trigger.endsWith('/')).toBe(false);

    // `monitorApiUrl`: wss, no query, no fragment.
    const monitorUrl = new URL(monitor);
    expect(monitorUrl.protocol).toBe('wss:');
    expect(monitorUrl.search).toBe('');
    expect(monitorUrl.hash).toBe('');
  });

  it('emits the same two outputs on the imageUri path', () => {
    // The Container_Image choice must not touch endpoint discovery.
    const t = referencePath().template;
    for (const name of REQUIRED_OUTPUTS) {
      expect(Object.keys(t.findOutputs(name)), `missing output ${name}`).toEqual([name]);
    }
  });
});
