import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configs } from '../lib/config.js';
import { ConsoleStack } from '../lib/console-stack.js';

// A stand-in for web/dist, so the tests don't need the SPA built.
const webDist = mkdtempSync(join(tmpdir(), 'web-dist-'));
writeFileSync(join(webDist, 'index.html'), '<!doctype html>');

function template(name: 'dev' | 'prod') {
  // Skip bundling the Lambda code; tests look at the resources, not the bundle.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new ConsoleStack(app, `Test-${name}`, {
    config: { ...configs[name], rootPublicKey: 'A'.repeat(43) },
    webDist,
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
    prod.resourceCountIs('AWS::S3::Bucket', 3);
    prod.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    prod.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'https-only' }) }),
    });
    prod.resourceCountIs('AWS::CloudFront::OriginAccessControl', 2);
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

  it('requires TOTP MFA from everyone and lets only sign-ups become publishers (ADR-001 A-4 1.2)', () => {
    prod.hasResourceProperties('AWS::Cognito::UserPool', {
      MfaConfiguration: 'ON',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
      Policies: { PasswordPolicy: Match.objectLike({ MinimumLength: 12 }) },
      LambdaConfig: { PostConfirmation: Match.anyValue() },
    });
    prod.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'operator' });
    prod.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'publisher' });
    prod.hasResourceProperties('AWS::Cognito::UserPoolDomain', { ManagedLoginVersion: 2 });
    prod.resourceCountIs('AWS::Cognito::ManagedLoginBranding', 1);
    prod.hasResourceProperties('AWS::WAFv2::WebACLAssociation', { ResourceArn: Match.anyValue() });
  });

  it('gives the SPA a public client: code flow, no secret, no localhost in production', () => {
    prod.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      EnableTokenRevocation: true,
      CallbackURLs: Match.arrayWith([Match.objectLike({ 'Fn::Join': Match.anyValue() })]),
    });
    expect(JSON.stringify(prod.findResources('AWS::Cognito::UserPoolClient'))).not.toContain('localhost');
    expect(JSON.stringify(template('dev').findResources('AWS::Cognito::UserPoolClient'))).toContain('http://localhost:5173/callback');
  });

  it('puts the API behind the JWT authorizer, throttled, and the SPA behind a strict CSP', () => {
    prod.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', { AuthorizerType: 'JWT', IdentitySource: ['$request.header.Authorization'] });
    prod.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'ANY /api/{proxy+}', AuthorizationType: 'JWT' });
    prod.hasResourceProperties('AWS::ApiGatewayV2::Stage', { DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 } });
    const csp = JSON.stringify(prod.findResources('AWS::CloudFront::ResponseHeadersPolicy'));
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('keeps development cheap and production protected (docs/operations/cost.md)', () => {
    const dev = template('dev');
    dev.resourceCountIs('AWS::WAFv2::WebACL', 0);
    dev.resourceCountIs('AWS::SecretsManager::Secret', 0);
    dev.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ CURSOR_KEY: Match.anyValue() }) } });
    dev.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 14 });
    dev.hasResourceProperties('AWS::DynamoDB::GlobalTable', { Replicas: [Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false } })] });
    dev.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 5, Unit: 'USD' }, CostFilters: { TagKeyValue: ['user:project$sanpo-channel-console'] } }),
    });

    prod.resourceCountIs('AWS::WAFv2::WebACL', 1);
    prod.resourceCountIs('AWS::SecretsManager::Secret', 1);
    prod.resourceCountIs('AWS::Logs::LogGroup', 0);
    prod.resourceCountIs('AWS::Budgets::Budget', 0);
  });
});
