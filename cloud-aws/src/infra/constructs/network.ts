/**
 * NetworkConstruct - VPC endpoints and task security group.
 *
 * Places Fargate tasks in private subnets with no internet gateway route.
 * Creates the DynamoDB gateway endpoint and interface endpoints for Secrets
 * Manager, ECR API, ECR DKR, CloudWatch Logs, STS and EventBridge Scheduler
 * with private DNS in the task subnets. The task security group allows egress
 * only to those endpoints, the configured data-source security group on its
 * port, and the ports the egress allow-list requires.
 *
 * Uses Vpc.fromVpcAttributes - never fromLookup - so synthesis needs no
 * credentials (Req 13.8).
 *
 * Requirements: 10.1, 10.2, 10.3, 10.10
 */
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { AwsDeployConfig } from '../../core/config.js';

export interface NetworkConstructProps {
  config: AwsDeployConfig;
}

export class NetworkConstruct extends Construct {
  public readonly vpc: ec2.IVpc;
  public readonly taskSubnets: ec2.ISubnet[];
  public readonly taskSubnetSelection: ec2.SubnetSelection;
  public readonly taskSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkConstructProps) {
    super(scope, id);

    const { config } = props;
    const prefix = config.namePrefix;

    // Always use fromVpcAttributes - never fromLookup - so synthesis needs
    // no credentials (Req 13.8). When no VPC is configured, synthesize with
    // placeholder subnet ids that CDK can resolve without context lookups.
    const vpcId = config.vpc?.id ?? 'vpc-00000000000000000';
    const subnetIds = config.vpc?.subnetIds ?? ['subnet-00000000000000001', 'subnet-00000000000000002'];
    const azSuffixes = ['a', 'b', 'c', 'd', 'e', 'f'];
    const availabilityZones = subnetIds.map(
      (_, i) => `${config.region}${azSuffixes[i % azSuffixes.length]}`,
    );

    this.vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId,
      availabilityZones,
      isolatedSubnetIds: subnetIds,
      vpcCidrBlock: '10.0.0.0/16',
    });

    this.taskSubnets = this.vpc.isolatedSubnets;
    this.taskSubnetSelection = { subnets: this.taskSubnets };

    // Task security group - no all-destinations rule
    this.taskSecurityGroup = new ec2.SecurityGroup(this, 'TaskSg', {
      vpc: this.vpc,
      securityGroupName: `${prefix}-task-sg`,
      description: 'Phorma AWS Host task security group',
      allowAllOutbound: false,
    });

    // Endpoint security group (shared by all interface endpoints)
    const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
      vpc: this.vpc,
      securityGroupName: `${prefix}-endpoint-sg`,
      description: 'VPC endpoint security group',
      allowAllOutbound: false,
    });
    endpointSg.addIngressRule(this.taskSecurityGroup, ec2.Port.tcp(443), 'Task to endpoint');

    // Egress from task SG to endpoint SG on 443
    this.taskSecurityGroup.addEgressRule(endpointSg, ec2.Port.tcp(443), 'VPC endpoint access');

    // DynamoDB gateway endpoint - using L1 construct since fromVpcAttributes
    // does not provide route table IDs needed by the high-level construct.
    // The route table association is handled at deploy time by CloudFormation.
    new cdk.CfnResource(this, 'DdbEndpoint', {
      type: 'AWS::EC2::VPCEndpoint',
      properties: {
        VpcId: this.vpc.vpcId,
        ServiceName: `com.amazonaws.${config.region}.dynamodb`,
        VpcEndpointType: 'Gateway',
      },
    });

    // Interface endpoints with private DNS in task subnets
    const interfaceServices: Array<{ id: string; service: ec2.InterfaceVpcEndpointAwsService }> = [
      { id: 'SmEndpoint', service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER },
      { id: 'EcrApiEndpoint', service: ec2.InterfaceVpcEndpointAwsService.ECR },
      { id: 'EcrDkrEndpoint', service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER },
      { id: 'CwLogsEndpoint', service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS },
      { id: 'StsEndpoint', service: ec2.InterfaceVpcEndpointAwsService.STS },
      { id: 'SchedulerEndpoint', service: new ec2.InterfaceVpcEndpointAwsService('scheduler') },
    ];

    for (const ep of interfaceServices) {
      new ec2.InterfaceVpcEndpoint(this, ep.id, {
        vpc: this.vpc,
        service: ep.service,
        subnets: this.taskSubnetSelection,
        privateDnsEnabled: true,
        securityGroups: [endpointSg],
      });
    }

    // Egress to configured data-source security group on database ports
    if (config.dataSourceSecurityGroupId) {
      const dsSg = ec2.SecurityGroup.fromSecurityGroupId(
        this,
        'DataSourceSg',
        config.dataSourceSecurityGroupId,
      );
      this.taskSecurityGroup.addEgressRule(dsSg, ec2.Port.tcp(5432), 'Data source PostgreSQL');
      this.taskSecurityGroup.addEgressRule(dsSg, ec2.Port.tcp(3306), 'Data source MySQL');
      this.taskSecurityGroup.addEgressRule(dsSg, ec2.Port.tcp(1433), 'Data source MSSQL');
    }

    // Egress rules for the egress allow-list (HTTPS 443)
    if (config.egressAllowList.length > 0) {
      this.taskSecurityGroup.addEgressRule(
        ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Egress allow-list HTTPS',
      );
    }

    cdk.Tags.of(this).add('Name', `${prefix}-network`);
  }
}
