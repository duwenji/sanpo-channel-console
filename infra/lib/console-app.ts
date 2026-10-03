import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { EnvConfig } from './config.js';
import { logGroupFor } from './common.js';

export interface ConsoleAppProps {
  config: EnvConfig;
  repoRoot: string;
  /** The built SPA (`web/dist`); build it before synthesizing. */
  webDist: string;
  table: dynamodb.ITableV2;
  publisher: lambda.IFunction;
  signingKeys: kms.IKey[];
}

const lambdaDefaults = (repoRoot: string): Partial<nodejs.NodejsFunctionProps> => ({
  projectRoot: repoRoot,
  depsLockFilePath: `${repoRoot}package-lock.json`,
  runtime: lambda.Runtime.NODEJS_22_X,
  architecture: lambda.Architecture.ARM_64,
  bundling: { format: nodejs.OutputFormat.ESM, target: 'node22', minify: true, sourceMap: true },
});

/**
 * The console the operators (and later the publishers) use: Cognito with managed login,
 * the console API behind API Gateway's JWT authorizer, and the SPA on CloudFront with `/api/*`
 * sent to the API (ADR-001 A-3, A-4 as revised in 1.2, A-18; API-001 C-5, C-7).
 */
export class ConsoleApp extends Construct {
  constructor(scope: Construct, id: string, props: ConsoleAppProps) {
    super(scope, id);
    const { config, repoRoot } = props;
    const prod = config.name === 'prod';
    const stack = Stack.of(this);
    if (!existsSync(`${props.webDist}/index.html`)) throw new Error(`build the SPA first (npm run build -w web): ${props.webDist}`);

    // ---- Cognito (ADR-001 A-4, 1.2: one pool, TOTP MFA for everyone) ----
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `sanpo-channel-console-${config.name}`,
      // Publishers register themselves (D-7); operators are created by an administrator.
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { sms: false, otp: true },
      passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      deletionProtection: prod,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      userVerification: {
        emailSubject: 'SanpoGuide チャンネル管理システムの確認コード',
        emailBody: 'SanpoGuide チャンネル管理システムの確認コードは {####} です。',
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
    });
    new cognito.UserPoolGroup(this, 'OperatorGroup', { userPool, groupName: 'operator', precedence: 0, description: 'Operators (added by an administrator only)' });
    new cognito.UserPoolGroup(this, 'PublisherGroup', { userPool, groupName: 'publisher', precedence: 10, description: 'Publishers (added on sign-up)' });

    // Everyone who signs up is a publisher; operators are never made this way.
    const postConfirmation = new nodejs.NodejsFunction(this, 'PostConfirmation', {
      ...lambdaDefaults(repoRoot),
      ...logGroupFor(this, 'PostConfirmationLogs', config),
      entry: `${repoRoot}api/src/console/post-confirmation.ts`,
      memorySize: 256,
      timeout: Duration.seconds(10),
    });
    // A wildcard avoids a cycle between the pool (which names the trigger) and the trigger's policy.
    postConfirmation.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminAddUserToGroup'],
        resources: [`arn:${stack.partition}:cognito-idp:${stack.region}:${stack.account}:userpool/*`],
      }),
    );
    userPool.addTrigger(cognito.UserPoolOperation.POST_CONFIRMATION, postConfirmation);

    const domain = userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `sanpo-channel-console-${config.name}` },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // A-18: limit sign-up and sign-in attempts per source address (production; about 7 USD a month).
    if (config.cost.waf) {
    const waf = new wafv2.CfnWebACL(this, 'UserPoolWaf', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `sanpo-console-${config.name}-cognito`, sampledRequestsEnabled: true },
      rules: [
        {
          name: 'RateLimitPerIp',
          priority: 0,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 300, evaluationWindowSec: 300, aggregateKeyType: 'IP' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'RateLimitPerIp', sampledRequestsEnabled: true },
        },
        {
          name: 'AmazonIpReputation',
          priority: 1,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesAmazonIpReputationList' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'AmazonIpReputation', sampledRequestsEnabled: true },
        },
      ],
    });
    new wafv2.CfnWebACLAssociation(this, 'UserPoolWafAssociation', { resourceArn: userPool.userPoolArn, webAclArn: waf.attrArn });
    }

    // ---- uploads (API-001 C-10, DM-001 M-4) ----
    // Packages and icons go straight from the browser with presigned POSTs. Nothing here is public.
    // CORS allows any origin: a POST still needs the presigned policy, and naming the console's own
    // origin here would make a cycle (bucket → distribution → headers policy → bucket).
    const intakeBucket = new s3.Bucket(this, 'IntakeBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !prod,
      cors: [{ allowedMethods: [s3.HttpMethods.POST], allowedOrigins: ['*'], allowedHeaders: ['*'], maxAge: 3600 }],
      lifecycleRules: [
        // Settled submissions are kept 90 days (DM-001 M-4); uploads that never got a result go after 30.
        { prefix: 'archive/', expiration: Duration.days(90) },
        { prefix: 'intake/', expiration: Duration.days(30) },
        { abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
    });

    // ---- the SPA's distribution, also fronting the API (API-001 C-5) ----
    const webBucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const consoleFn = new nodejs.NodejsFunction(this, 'ConsoleApi', {
      ...lambdaDefaults(repoRoot),
      ...logGroupFor(this, 'ConsoleApiLogs', config),
      entry: `${repoRoot}api/src/console/handler.ts`,
      memorySize: 512,
      timeout: Duration.seconds(15),
    });
    // API-001 C-9. Development passes a key made at synthesis instead of paying for a secret.
    const cursorSecret =
      config.cost.cursorKey === 'secret'
        ? new secrets.Secret(this, 'CursorSecret', {
            description: 'Key material for opaque list cursors (API-001 C-9)',
            generateSecretString: { passwordLength: 64, excludePunctuation: true },
            removalPolicy: RemovalPolicy.DESTROY,
          })
        : undefined;

    const httpApi = new apigw.HttpApi(this, 'HttpApi', { apiName: `sanpo-channel-console-${config.name}`, createDefaultStage: true });
    const stage = httpApi.defaultStage?.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 20, throttlingBurstLimit: 40 };

    const authDomain = `${domain.domainName}.auth.${stack.region}.amazoncognito.com`;
    const issuer = `https://cognito-idp.${stack.region}.${stack.urlSuffix}/${userPool.userPoolId}`;

    // Security headers for the SPA; the CSP allows only this origin and Cognito (aws-auth).
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'ConsoleHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self'",
            "img-src 'self' data:",
            `connect-src 'self' https://${authDomain} https://cognito-idp.${stack.region}.${stack.urlSuffix} https://${intakeBucket.bucketRegionalDomainName}`,
            `form-action 'self' https://${authDomain}`,
            "frame-ancestors 'none'",
            "base-uri 'none'",
            "object-src 'none'",
          ].join('; '),
        },
        strictTransportSecurity: { override: true, accessControlMaxAge: Duration.days(365), includeSubdomains: true },
        contentTypeOptions: { override: true },
        frameOptions: { override: true, frameOption: cloudfront.HeadersFrameOption.DENY },
        referrerPolicy: { override: true, referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER },
      },
    });
    const consoleDistribution = new cloudfront.Distribution(this, 'ConsoleDistribution', {
      comment: `SanpoGuide channel console (${config.name})`,
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            // Paths without a file extension are routes of the SPA.
            function: new cloudfront.Function(this, 'SpaRoutes', {
              code: cloudfront.FunctionCode.fromInline(
                "function handler(event) { var r = event.request; if (r.uri.indexOf('.') === -1) { r.uri = '/index.html'; } return r; }",
              ),
              runtime: cloudfront.FunctionRuntime.JS_2_0,
            }),
          },
        ],
      },
      additionalBehaviors: {
        'api/*': {
          origin: new origins.HttpOrigin(`${httpApi.apiId}.execute-api.${stack.region}.${stack.urlSuffix}`),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });
    const consoleUrl = `https://${consoleDistribution.distributionDomainName}`;

    // A public client: no secret, authorization code with PKCE (aws-auth: never a secret on an SPA).
    const client = userPool.addClient('WebClient', {
      generateSecret: false,
      authFlows: {},
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`${consoleUrl}/callback`, ...(prod ? [] : ['http://localhost:5173/callback'])],
        logoutUrls: [`${consoleUrl}/`, ...(prod ? [] : ['http://localhost:5173/'])],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.hours(12),
      refreshTokenRotationGracePeriod: Duration.seconds(10),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
    });
    // Managed login v2 needs a branding style per client, or the login page is broken (aws-auth).
    const branding = new cognito.CfnManagedLoginBranding(this, 'LoginBranding', {
      userPoolId: userPool.userPoolId,
      clientId: client.userPoolClientId,
      useCognitoProvidedValues: true,
    });
    branding.node.addDependency(domain);

    httpApi.addRoutes({
      path: '/api/{proxy+}',
      methods: [apigw.HttpMethod.ANY],
      integration: new integrations.HttpLambdaIntegration('ConsoleIntegration', consoleFn),
      authorizer: new authorizers.HttpJwtAuthorizer('Jwt', issuer, { jwtAudience: [client.userPoolClientId] }),
    });

    consoleFn.addEnvironment('TABLE_NAME', props.table.tableName);
    consoleFn.addEnvironment('PUBLISH_FUNCTION', props.publisher.functionName);
    consoleFn.addEnvironment('ROOT_PUBLIC_KEY', config.rootPublicKey);
    if (cursorSecret) {
      consoleFn.addEnvironment('CURSOR_SECRET_ARN', cursorSecret.secretArn);
      cursorSecret.grantRead(consoleFn);
    } else {
      consoleFn.addEnvironment('CURSOR_KEY', randomBytes(32).toString('base64url'));
    }
    consoleFn.addEnvironment('INTAKE_BUCKET', intakeBucket.bucketName);
    consoleFn.addEnvironment('USER_POOL_ID', userPool.userPoolId);
    consoleFn.addEnvironment('NODE_OPTIONS', '--enable-source-maps');
    // Presigning needs the right to put; moving to archive/ needs read, put and delete.
    intakeBucket.grantPut(consoleFn, 'intake/*');
    intakeBucket.grantRead(consoleFn, 'intake/*');
    intakeBucket.grantDelete(consoleFn, 'intake/*');
    intakeBucket.grantPut(consoleFn, 'archive/*');
    // Leaving deletes the user (API-001 C-4).
    consoleFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['cognito-idp:AdminDeleteUser'], resources: [userPool.userPoolArn] }));
    props.table.grantReadWriteData(consoleFn);
    props.publisher.grantInvoke(consoleFn);
    for (const key of props.signingKeys) key.grant(consoleFn, 'kms:GetPublicKey', 'kms:DescribeKey');
    // Registering a signing key reads any KMS key the operator names, in this account only.
    consoleFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['kms:GetPublicKey'], resources: [`arn:${stack.partition}:kms:${stack.region}:${stack.account}:key/*`] }),
    );

    new s3deploy.BucketDeployment(this, 'DeployWeb', {
      destinationBucket: webBucket,
      sources: [
        s3deploy.Source.asset(props.webDist),
        // Read by the SPA at start-up, so one build serves every environment.
        s3deploy.Source.jsonData('config.json', {
          authority: issuer,
          clientId: client.userPoolClientId,
          authDomain: `https://${authDomain}`,
          environment: config.name,
        }),
      ],
      distribution: consoleDistribution,
      distributionPaths: ['/index.html', '/config.json'],
      prune: true,
    });

    new CfnOutput(stack, 'ConsoleUrl', { value: consoleUrl });
    new CfnOutput(stack, 'IntakeBucketName', { value: intakeBucket.bucketName });
    new CfnOutput(stack, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(stack, 'UserPoolClientId', { value: client.userPoolClientId });
    new CfnOutput(stack, 'LoginDomain', { value: `https://${authDomain}` });
  }
}
