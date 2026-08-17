/**
 * TriggerApiConstruct - HTTP API with IAM authorization and VPC Link.
 *
 * Creates the API Gateway HTTP API (Trigger_API) with AWS_IAM auth on every
 * route and a private integration through a VPC Link to an internal NLB in the
 * same private subnets as the tasks.
 *
 * Requirements: 9.5, 9.6, 9.7, 13.2
 */
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type { AwsDeployConfig } from '../../core/config.js';

export interface TriggerApiConstructProps {
  config: AwsDeployConfig;
  vpc: ec2.IVpc;
  taskSubnets: ec2.ISubnet[];
  taskSecurityGroup: ec2.ISecurityGroup;
}

export class TriggerApiConstruct extends Construct {
  public readonly api: apigwv2.CfnApi;
  public readonly nlb: elbv2.NetworkLoadBalancer;
  public readonly targetGroup: elbv2.NetworkTargetGroup;
  public readonly scheduledRunRouteArn: string;

  constructor(scope: Construct, id: string, props: TriggerApiConstructProps) {
    super(scope, id);

    const { config, vpc, taskSubnets, taskSecurityGroup } = props;
    const prefix = config.namePrefix;

    // Internal NLB in private subnets
    this.nlb = new elbv2.NetworkLoadBalancer(this, 'Nlb', {
      loadBalancerName: `${prefix}-nlb`,
      vpc,
      internetFacing: false,
      vpcSubnets: { subnets: taskSubnets },
    });

    // Target group for ECS tasks (IP type for awsvpc networking)
    this.targetGroup = new elbv2.NetworkTargetGroup(this, 'TG', {
      targetGroupName: `${prefix}-host-tg`,
      vpc,
      port: 8080,
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health',
        protocol: elbv2.Protocol.HTTP,
        interval: cdk.Duration.seconds(30),
      },
    });

    this.nlb.addListener('Listener', {
      port: 80,
      defaultTargetGroups: [this.targetGroup],
    });

    // VPC Link for private integration
    const vpcLink = new apigwv2.CfnVpcLink(this, 'VpcLink', {
      name: `${prefix}-vpc-link`,
      subnetIds: taskSubnets.map(s => s.subnetId),
      securityGroupIds: [taskSecurityGroup.securityGroupId],
    });

    // HTTP API (Trigger_API) with IAM auth
    this.api = new apigwv2.CfnApi(this, 'TriggerApi', {
      name: `${prefix}-trigger-api`,
      protocolType: 'HTTP',
    });

    // Default stage
    new apigwv2.CfnStage(this, 'TriggerApiStage', {
      apiId: this.api.ref,
      stageName: '$default',
      autoDeploy: true,
    });

    // Integration to NLB through VPC Link
    const integration = new apigwv2.CfnIntegration(this, 'NlbIntegration', {
      apiId: this.api.ref,
      integrationType: 'HTTP_PROXY',
      integrationMethod: 'ANY',
      integrationUri: this.nlb.loadBalancerArn,
      connectionType: 'VPC_LINK',
      connectionId: vpcLink.ref,
      payloadFormatVersion: '1.0',
    });

    // Routes - all with AWS_IAM authorization
    const routes = [
      { path: '/workflows/{id}/spec', method: 'POST' },
      { path: '/workflows/{id}/trigger', method: 'POST' },
      { path: '/workflows/{id}', method: 'DELETE' },
      { path: '/workflows/{id}/runs', method: 'GET' },
      { path: '/workflows/{id}/runs/{runId}', method: 'GET' },
      { path: '/workflows/{id}/usage', method: 'GET' },
      { path: '/workflows/{id}/connections', method: 'GET' },
      { path: '/connections/{connId}/secrets/{key}', method: 'PUT' },
    ];

    for (const route of routes) {
      const routeId = `Route${route.method}${route.path.replace(/[/{}]/g, '')}`;
      new apigwv2.CfnRoute(this, routeId, {
        apiId: this.api.ref,
        routeKey: `${route.method} ${route.path}`,
        authorizationType: 'AWS_IAM',
        target: `integrations/${integration.ref}`,
      });
    }

    // The scheduled-run route ARN, used as an IAM RESOURCE for the Schedule_Shim's
    // execution role - the identity that signs the call when a schedule fires.
    //
    // It is deliberately NOT an EventBridge Scheduler target. Scheduler has no API
    // Gateway target of either kind, so a schedule pointed here fails to create.
    // The `*` stands in for the workflow id path parameter, which is the right
    // shape for an IAM resource covering every workflow.
    this.scheduledRunRouteArn = cdk.Fn.join('', [
      'arn:aws:execute-api:',
      cdk.Stack.of(this).region,
      ':',
      cdk.Stack.of(this).account,
      ':',
      this.api.ref,
      '/$default/POST/workflows/*/trigger',
    ]);

    cdk.Tags.of(this).add('Name', `${prefix}-trigger-api`);
  }
}
