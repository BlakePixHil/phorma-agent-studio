/**
 * DataConstruct - Run_Table with GSI1, GSI2, App_CMK encryption, PITR and TTL.
 *
 * Single DynamoDB table holding workflow specs, journal entries, run records,
 * run events, usage ledger entries, workflow state, leases, frames and connection
 * records. Two GSIs partitioned by workflow id cover the two ordered reads.
 *
 * Requirements: 11.1, 11.7, 18.1
 */
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import type { AwsDeployConfig } from '../../core/config.js';

export interface DataConstructProps {
  config: AwsDeployConfig;
  encryptionKey: kms.IKey;
}

export class DataConstruct extends Construct {
  public readonly runTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DataConstructProps) {
    super(scope, id);

    const { config, encryptionKey } = props;
    const prefix = config.namePrefix;

    this.runTable = new dynamodb.Table(this, 'RunTable', {
      tableName: `${prefix}-run-table`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI1: Run history - descending by start timestamp, 100 per page
    this.runTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI2: Usage ledger - ascending by timestamp, 1000 per page
    this.runTable.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'gsi2pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi2sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    cdk.Tags.of(this).add('Name', `${prefix}-run-table`);
  }
}
