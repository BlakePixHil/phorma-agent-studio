/**
 * SecretsConstruct - App_CMK (KMS).
 *
 * Creates or imports the customer-managed KMS key used for encryption at rest
 * on Run_Table, Secret_Store entries and log groups.
 *
 * The construct deliberately declares NO ECR repository. On the asset path a CDK
 * Docker image asset publishes into the CDK bootstrap image repository
 * (`cdk-{qualifier}-container-assets-{account}-{region}`), which is a
 * Platform_Prerequisite the operator's platform team already created; on the
 * `imageUri` path the image is pulled from the operator's own registry. A
 * `${prefix}-host` repository existed here and nothing ever pushed to it, so the
 * stack declares zero `AWS::ECR::Repository` on both image paths (Req 4.2, 4.6).
 *
 * Requirements: 4.2, 4.6, 11.1
 */
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import type { AwsDeployConfig } from '../../core/config.js';

export interface SecretsConstructProps {
  config: AwsDeployConfig;
}

export class SecretsConstruct extends Construct {
  public readonly appCmk: kms.IKey;

  constructor(scope: Construct, id: string, props: SecretsConstructProps) {
    super(scope, id);

    const { config } = props;
    const prefix = config.namePrefix;

    // App_CMK: import existing or create new
    if (config.appCmkArn) {
      this.appCmk = kms.Key.fromKeyArn(this, 'AppCmk', config.appCmkArn);
    } else {
      this.appCmk = new kms.Key(this, 'AppCmk', {
        alias: `${prefix}-app-cmk`,
        description: `Phorma AWS Host encryption key (${prefix})`,
        enableKeyRotation: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
    }

    cdk.Tags.of(this).add('Name', `${prefix}-secrets`);
  }
}
