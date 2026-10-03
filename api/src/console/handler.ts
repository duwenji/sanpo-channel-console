import { AdminDeleteUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetPublicKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { CopyObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { createHash } from 'node:crypto';
import type { Deps } from './deps.js';
import { ApiError, problem } from './http.js';
import { callerFrom, route } from './router.js';
import { CursorCodec } from './util.js';

function env(name: string): string {
  return process.env[name] || (() => { throw new Error(`${name} is not set`); })();
}

const kms = new KMSClient({});
const lambda = new LambdaClient({});
const s3 = new S3Client({});
const cognito = new CognitoIdentityProviderClient({});
let deps: Deps | undefined;

/** The cursor key: from $CURSOR_KEY (development) or a Secrets Manager secret (production). */
async function cursorKey(): Promise<Buffer> {
  if (process.env.CURSOR_KEY) return Buffer.from(process.env.CURSOR_KEY, 'base64url');
  const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: env('CURSOR_SECRET_ARN') }));
  // The secret is random text; its SHA-256 is the 32-byte AES key.
  return createHash('sha256').update(secret.SecretString ?? '').digest();
}

async function load(): Promise<Deps> {
  return {
    db: DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
    table: env('TABLE_NAME'),
    now: () => new Date(),
    cursors: new CursorCodec(await cursorKey()),
    rootPublicKey: env('ROOT_PUBLIC_KEY'),
    kmsPublicKey: async (keyArn) => {
      const out = await kms.send(new GetPublicKeyCommand({ KeyId: keyArn }));
      return { keySpec: out.KeySpec, publicKey: out.PublicKey ?? new Uint8Array() };
    },
    requestPublish: async (trigger) => {
      await lambda.send(new InvokeCommand({ FunctionName: env('PUBLISH_FUNCTION'), InvocationType: 'Event', Payload: JSON.stringify({ trigger }) }));
    },
    presignUpload: async (key, contentType, maxBytes) => {
      // S3 itself refuses a larger file or another type (API-001 C-10).
      const post = await createPresignedPost(s3, {
        Bucket: env('INTAKE_BUCKET'),
        Key: key,
        Conditions: [['content-length-range', 1, maxBytes], ['eq', '$Content-Type', contentType]],
        Fields: { 'Content-Type': contentType },
        Expires: 15 * 60,
      });
      return { url: post.url, fields: post.fields };
    },
    archiveUpload: async (key) => {
      const bucket = env('INTAKE_BUCKET');
      const target = key.replace(/^intake\//, 'archive/');
      try {
        await s3.send(new CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/${key}`, Key: target }));
      } catch (e) {
        // Nothing was uploaded: nothing to keep.
        if ((e as { name?: string }).name === 'NoSuchKey') return;
        throw e;
      }
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    deleteUser: async (sub) => {
      // Sign-in is by email, so the user name is the sub.
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: env('USER_POOL_ID'), Username: sub }));
    },
  };
}

const MAX_BODY = 1024 * 1024;

/** The console API behind API Gateway's JWT authorizer (ADR-001 A-3, API-001). */
export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  const requestId = event.requestContext.requestId;
  try {
    deps ??= await load();
    const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : undefined;
    if (raw && raw.length > MAX_BODY) return problem(new ApiError('payload_too_large', 'the body is over 1MB'), requestId);
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      return problem(new ApiError('invalid_request', 'the body is not JSON'), requestId);
    }
    const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return await route(deps, {
      method: event.requestContext.http.method,
      path: event.rawPath,
      query: event.queryStringParameters ?? {},
      headers,
      body,
      caller: callerFrom(event.requestContext.authorizer.jwt.claims as Record<string, unknown>),
      requestId,
    });
  } catch (e) {
    if (e instanceof ApiError) return problem(e, requestId);
    console.error(JSON.stringify({ requestId, error: e instanceof Error ? e.stack : String(e) }));
    return problem(new ApiError('internal', 'internal error'), requestId);
  }
}
