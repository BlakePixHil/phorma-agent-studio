/**
 * MonitorApiConstruct - WebSocket API with IAM authorization.
 *
 * Creates the API Gateway WebSocket API (Monitor_API) with IAM auth on
 * $connect. `$connect` and `$default` use AWS service integrations to DynamoDB
 * (Run_Table) for connection management and for the Frame_Inbox.
 *
 * Two rules govern every request template here:
 *
 * - **No authorizer context.** Every route is authorized with `AWS_IAM`, which
 *   means there IS no authorizer, so `$context.authorizer.*` resolves to
 *   nothing. The workflow id comes from the SIGNED QUERY STRING on `$connect`
 *   (`$input.params('workflowId')`, part of the presigned URL `cli/monitor-url.ts`
 *   produces) and from the FRAME BODY on `$default` (`$input.path('$.workflowId')`,
 *   which the Studio's frame sender adds to every ControlFrame it sends over an
 *   AWS socket). `pk` is `wf#{workflowId}` on every write, so the no-Scan rule
 *   holds and the Frame_Inbox drain stays a single prefix query.
 * - **TTL is epoch SECONDS.** `$context.requestTimeEpoch` is epoch
 *   MILLISECONDS, so every `ttl` is computed as `requestTimeEpoch / 1000 + n`.
 *   Writing the millisecond value directly would make every item born expired.
 *
 * Requirements: 9.5, 11.7, 8.7, 13.2
 */
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type { AwsDeployConfig } from '../../core/config.js';

/**
 * How long a monitor connection record survives, in seconds (two hours).
 * A record is only pruned earlier by the `isGoneError` path in
 * `MonitorAdapter.push`, because $disconnect cannot address the partition.
 */
const CONNECTION_TTL_SECONDS = 7200;

/** How long an undrained inbound frame survives, in seconds (one hour). */
const FRAME_TTL_SECONDS = 3600;

export interface MonitorApiConstructProps {
  config: AwsDeployConfig;
  runTable: dynamodb.Table;
}

export class MonitorApiConstruct extends Construct {
  public readonly api: apigwv2.CfnApi;
  public readonly stageArn: string;

  constructor(scope: Construct, id: string, props: MonitorApiConstructProps) {
    super(scope, id);

    const { config, runTable } = props;
    const prefix = config.namePrefix;

    // WebSocket API (Monitor_API)
    this.api = new apigwv2.CfnApi(this, 'MonitorApi', {
      name: `${prefix}-monitor-api`,
      protocolType: 'WEBSOCKET',
      routeSelectionExpression: '$request.body.action',
    });

    // Stage
    const stage = new apigwv2.CfnStage(this, 'MonitorApiStage', {
      apiId: this.api.ref,
      stageName: 'live',
      autoDeploy: true,
    });

    // IAM role for API Gateway to write to DynamoDB. Carries the permissions
    // boundary like every other role in the estate - an organisation that
    // mandates the boundary rejects role creation without it.
    const integrationRole = new iam.Role(this, 'MonitorIntegrationRole', {
      roleName: `${prefix}-monitor-integration`,
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyArn(
        this, 'Boundary', config.permissionsBoundaryArn,
      ),
    });

    runTable.grantWriteData(integrationRole);

    // $connect integration - writes connection record to Run_Table.
    //
    // Velocity directives have to precede the JSON body, so the template is a
    // raw string rather than a JSON.stringify of an object literal.
    const connectIntegration = new apigwv2.CfnIntegration(this, 'ConnectIntegration', {
      apiId: this.api.ref,
      integrationType: 'AWS',
      integrationMethod: 'POST',
      integrationUri: `arn:aws:apigateway:${cdk.Stack.of(this).region}:dynamodb:action/PutItem`,
      credentialsArn: integrationRole.roleArn,
      requestTemplates: {
        '$default': [
          // The workflow id is a signed query parameter of the presigned URL.
          "#set($workflowId = $input.params('workflowId'))",
          // Epoch seconds, two hours out. requestTimeEpoch is milliseconds.
          `#set($ttl = $context.requestTimeEpoch / 1000 + ${CONNECTION_TTL_SECONDS})`,
          JSON.stringify({
            TableName: runTable.tableName,
            Item: {
              pk: { S: 'wf#$workflowId' },
              sk: { S: 'conn#$context.connectionId' },
              connectionId: { S: '$context.connectionId' },
              connectedAt: { N: '$context.requestTimeEpoch' },
              ttl: { N: '$ttl' },
            },
          }),
        ].join('\n'),
      },
      templateSelectionExpression: '\\$default',
    });

    // $disconnect integration - MOCK, deliberately writes nothing.
    //
    // The signed query string is only available on $connect, so $disconnect
    // cannot know the workflow id and therefore cannot address the partition
    // its connection record lives in. Inventing a reverse-index partition would
    // break the invariant that `pk` is always `wf#{workflowId}`, which the
    // no-Scan rule depends on. Stale records are pruned two other ways: the
    // connection record TTL above, and sooner, `isGoneError` in
    // `MonitorAdapter.push` deleting the connection when a push to it fails
    // (Req 8.7).
    const disconnectIntegration = new apigwv2.CfnIntegration(this, 'DisconnectIntegration', {
      apiId: this.api.ref,
      integrationType: 'MOCK',
      requestTemplates: {
        '$default': JSON.stringify({ statusCode: 200 }),
      },
      templateSelectionExpression: '\\$default',
    });

    // $default integration - writes inbound frame to Run_Table.
    //
    // The sort key must match `core/keys.ts frameSk` exactly:
    // `frame#{arrivedAtMs:013d}#{connectionId}#{n:04d}`. The 13-digit padding is
    // what makes lexicographic order equal arrival order, which is the whole
    // basis of the Frame_Inbox drain's ascending prefix Query (Req 7.7). The
    // counter is always `0000` here - one item per frame, uniqueness comes from
    // the timestamp and connection id.
    const defaultIntegration = new apigwv2.CfnIntegration(this, 'DefaultIntegration', {
      apiId: this.api.ref,
      integrationType: 'AWS',
      integrationMethod: 'POST',
      integrationUri: `arn:aws:apigateway:${cdk.Stack.of(this).region}:dynamodb:action/PutItem`,
      credentialsArn: integrationRole.roleArn,
      requestTemplates: {
        '$default': [
          // Outside $connect the query string is gone, so the workflow id
          // travels in the frame body - every ControlFrame the Studio sends
          // over an AWS socket carries a `workflowId` member.
          "#set($workflowId = $input.path('$.workflowId'))",
          // Left-pad the arrival time to 13 digits without a loop: prepend 13
          // zeros and keep the last 13 characters.
          '#set($padSource = "0000000000000$context.requestTimeEpoch")',
          '#set($cut = $padSource.length() - 13)',
          '#set($arrivedAt = $padSource.substring($cut))',
          // Epoch seconds, one hour out. requestTimeEpoch is milliseconds.
          `#set($ttl = $context.requestTimeEpoch / 1000 + ${FRAME_TTL_SECONDS})`,
          // The raw frame text is embedded in a JSON string, so it has to be
          // escaped. escapeJavaScript also escapes an apostrophe, which is not
          // valid JSON, hence the replaceAll - frame bodies carry user prose.
          `#set($body = $util.escapeJavaScript($input.body).replaceAll("\\\\'","'"))`,
          JSON.stringify({
            TableName: runTable.tableName,
            Item: {
              pk: { S: 'wf#$workflowId' },
              sk: { S: 'frame#$arrivedAt#$context.connectionId#0000' },
              connectionId: { S: '$context.connectionId' },
              body: { S: '$body' },
              ttl: { N: '$ttl' },
            },
          }),
        ].join('\n'),
      },
      templateSelectionExpression: '\\$default',
    });

    // Routes with IAM auth on $connect
    new apigwv2.CfnRoute(this, 'ConnectRoute', {
      apiId: this.api.ref,
      routeKey: '$connect',
      authorizationType: 'AWS_IAM',
      target: `integrations/${connectIntegration.ref}`,
    });

    new apigwv2.CfnRoute(this, 'DisconnectRoute', {
      apiId: this.api.ref,
      routeKey: '$disconnect',
      target: `integrations/${disconnectIntegration.ref}`,
    });

    new apigwv2.CfnRoute(this, 'DefaultRoute', {
      apiId: this.api.ref,
      routeKey: '$default',
      target: `integrations/${defaultIntegration.ref}`,
    });

    // Stage ARN for ManageConnections permission
    this.stageArn = cdk.Fn.join('', [
      'arn:aws:execute-api:',
      cdk.Stack.of(this).region,
      ':',
      cdk.Stack.of(this).account,
      ':',
      this.api.ref,
      '/',
      stage.ref,
      '/POST/@connections/*',
    ]);

    cdk.Tags.of(this).add('Name', `${prefix}-monitor-api`);
  }
}
