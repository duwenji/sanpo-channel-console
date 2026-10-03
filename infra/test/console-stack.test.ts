import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { configs } from '../lib/config.js';
import { ConsoleStack } from '../lib/console-stack.js';

function template(name: 'dev' | 'prod') {
  // Skip bundling the Lambda code; tests look at the resources, not the bundle.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new ConsoleStack(app, `Test-${name}`, {
    config: { ...configs[name], rootPublicKey: 'A'.repeat(43) },
    env: { region: 'ap-northeast-1', account: '123456789012' },
  });
  return Template.fromStack(stack);
}

describe('ConsoleStack', () => {
  const prod = template('prod');

  it('has the DM-001 table with both GSIs, TTL and PITR', () => {
    prod.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: Match.arrayWith([Match.objectLike({ IndexName: 'GSI1' }), Match.objectLike({ IndexName: 'GSI2' })]),
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      Replicas: [Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true }, DeletionProtectionEnabled: true })],
    });
  });

  it('signs with Ed25519 keys in KMS, only from the publisher and only as pure Ed25519', () => {
    prod.hasResourceProperties('AWS::KMS::Key', { KeySpec: 'ECC_NIST_EDWARDS25519', KeyUsage: 'SIGN_VERIFY' });
    prod.hasResourceProperties('AWS::KMS::Key', {
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'kms:Sign',
            Condition: { StringEquals: { 'kms:SigningAlgorithm': 'ED25519_SHA_512', 'kms:MessageType': 'RAW' } },
          }),
        ]),
      },
    });
    // No identity policy grants kms:Sign without the conditions.
    const policies = JSON.stringify(prod.findResources('AWS::IAM::Policy'));
    expect(policies).not.toContain('kms:Sign');
  });

  it('keeps the public bucket private behind CloudFront with HTTPS only', () => {
    prod.resourceCountIs('AWS::S3::Bucket', 2);
    prod.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    prod.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'https-only' }) }),
    });
    prod.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  });

  it('runs one publisher at a time, daily, with alarms', () => {
    prod.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      ReservedConcurrentExecutions: 1,
      Environment: { Variables: Match.objectLike({ ROOT_PUBLIC_KEY: 'A'.repeat(43), PROVIDER_NAME: 'SanpoGuide 公式チャンネル' }) },
    });
    prod.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(0 18 * * ? *)',
      Target: Match.objectLike({ Input: '{"trigger":"daily"}' }),
    });
    prod.resourceCountIs('AWS::CloudWatch::Alarm', 2);
  });

  it('keeps production data on stack deletion, but not development data', () => {
    prod.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
    const dev = template('dev');
    dev.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
    dev.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Retain' });
  });
});
