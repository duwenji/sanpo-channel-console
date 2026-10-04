import { CloudFormationClient, DescribeStackResourcesCommand, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { b64url, sha256Hex, utf8, verifyDiscovery, verifyEd25519 } from '@sanpo-console/protocol';
import { ulid } from '../../api/src/console/util.js';

// Issues a test ticket through the deployed console Lambda (as API Gateway would call it after
// the JWT check), then checks its signature against the published keyset and fetches the package.
const region = 'ap-northeast-1';
const cfn = new CloudFormationClient({ region });
const stack = 'SanpoChannelConsole-dev';
const outputs = new Map(((await cfn.send(new DescribeStacksCommand({ StackName: stack }))).Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));
const resources = (await cfn.send(new DescribeStackResourcesCommand({ StackName: stack }))).StackResources ?? [];
const consoleFn = resources.find((r) => r.ResourceType === 'AWS::Lambda::Function' && r.LogicalResourceId?.startsWith('ConsoleConsoleApi'))!.PhysicalResourceId!;
const table = outputs.get('TableName')!;
const bucket = outputs.get('IntakeBucketName')!;
const providerUrl = outputs.get('ProviderUrl')!;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

const sub = `e2e-${Date.now()}`;
const publisherId = ulid();
const channelId = `e2e-ticket-${Date.now().toString(36)}`;
const sid = ulid();
const account = 'sg1' + 'e'.repeat(32);
const pkg = utf8.encode(`PK e2e package ${Date.now()}`);
const sha = sha256Hex(pkg);
const now = new Date().toISOString();
const items = [
  { PK: `USER#${sub}`, SK: 'USER', type: 'user', publisherId },
  { PK: `PUB#${publisherId}`, SK: 'PUB', type: 'publisher', publisherId, displayName: 'e2e', status: 'active', activeAccountId: account, channelCount: 1, rev: 2, createdAt: now, updatedAt: now },
  { PK: `CH#${channelId}`, SK: 'CH', type: 'channel', channelId, publisherId, status: 'active', rev: 1, pendingSubmissionId: sid },
  { PK: `CH#${channelId}`, SK: `SUB#${sid}`, type: 'submission', submissionId: sid, channelId, publisherId, accountId: account, state: 'awaiting_review', intakeKey: `intake/${channelId}/${sid}.zip`, sha256: sha, size: pkg.length, version: 1, validation: { ok: true, errors: [] }, rev: 2, createdAt: now, updatedAt: now },
];
try {
  for (const Item of items) await db.send(new PutCommand({ TableName: table, Item }));
  // Not under intake/'s event prefix? It is; the machine review skips it (the submission isn't uploading).
  await new S3Client({ region }).send(new PutObjectCommand({ Bucket: bucket, Key: `intake/${channelId}/${sid}.zip`, Body: pkg }));

  const event = {
    rawPath: `/api/channels/${channelId}/submissions/${sid}/test-tickets`,
    headers: {},
    requestContext: { requestId: 'e2e', http: { method: 'POST' }, authorizer: { jwt: { claims: { sub, 'cognito:groups': '[publisher]' } } } },
  };
  const res = await new LambdaClient({ region }).send(new InvokeCommand({ FunctionName: consoleFn, Payload: utf8.encode(JSON.stringify(event)) }));
  const out = JSON.parse(utf8.decode(res.Payload!));
  console.log('status', out.statusCode);
  const ticket = JSON.parse(out.body);
  if (out.statusCode !== 201) throw new Error(out.body);

  const discovery = await (await fetch(`${providerUrl}/.well-known/sanpo-channels`)).json();
  const { keyset } = verifyDiscovery(discovery);
  const key = keyset.keys.find((k) => k.keyId === ticket.document.keyId)!;
  const ok = verifyEd25519(b64url.decode(key.publicKey), b64url.decode(ticket.document.payload), b64url.decode(ticket.document.sig));
  const payload = JSON.parse(utf8.decode(b64url.decode(ticket.document.payload)));
  console.log('signed by', ticket.document.keyId, 'verifies:', ok, '| type', payload.type, '| expires', payload.expiresAt);
  const fetched = new Uint8Array(await (await fetch(payload.package.url)).arrayBuffer());
  console.log('trial package', payload.package.url.replace(providerUrl, ''), 'sha256 matches:', sha256Hex(fetched) === sha, '| QR length', ticket.qr.length);
} finally {
  for (const { PK, SK } of items) await db.send(new DeleteCommand({ TableName: table, Key: { PK, SK } }));
}
