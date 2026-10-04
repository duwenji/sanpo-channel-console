import { CloudFormationClient, DescribeStackResourcesCommand, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { AdminCreateUserCommand, AdminDeleteUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { utf8 } from '@sanpo-console/protocol';
import { zipSync } from 'fflate';
import { ulid } from '../../api/src/console/util.js';
import { checkProvider } from '../../conformance/src/check.js';
import { b64url, createKey, sign, signPackage, type PublisherKey } from '../../web/src/publisher-crypto.js';

/**
 * Key transfer and notices on the dev environment (DES-006): version 1 signed with key A is
 * approved; the publisher asks to move to key B and an operator approves; version 2 signed with
 * key B is approved and the list shows `publisherChange` from A (V-16). Every decision queues a
 * notice, which the notifier records (development only logs, no mail). Then everything is removed.
 */
const region = 'ap-northeast-1';
const stack = 'SanpoChannelConsole-dev';
const cfn = new CloudFormationClient({ region });
const outputs = new Map(((await cfn.send(new DescribeStacksCommand({ StackName: stack }))).Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));
const resources = (await cfn.send(new DescribeStackResourcesCommand({ StackName: stack }))).StackResources ?? [];
const consoleFn = resources.find((r) => r.ResourceType === 'AWS::Lambda::Function' && r.LogicalResourceId?.startsWith('ConsoleConsoleApi'))!.PhysicalResourceId!;
const table = outputs.get('TableName')!;
const bucket = outputs.get('IntakeBucketName')!;
const providerUrl = outputs.get('ProviderUrl')!;
const userPoolId = outputs.get('UserPoolId')!;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const lambda = new LambdaClient({ region });
const s3 = new S3Client({ region });
const cognito = new CognitoIdentityProviderClient({ region });
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function invoke(sub: string, groups: string, method: string, path: string, options: { body?: unknown; ifMatch?: number; query?: Record<string, string> } = {}) {
  const event = {
    rawPath: path,
    queryStringParameters: options.query,
    headers: options.ifMatch !== undefined ? { 'if-match': `"${options.ifMatch}"` } : {},
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    requestContext: { requestId: 'e2e-transfer', http: { method }, authorizer: { jwt: { claims: { sub, 'cognito:groups': groups } } } },
  };
  const res = await lambda.send(new InvokeCommand({ FunctionName: consoleFn, Payload: utf8.encode(JSON.stringify(event)) }));
  const out = JSON.parse(utf8.decode(res.Payload!));
  if (out.statusCode >= 400) throw new Error(`${method} ${path}: ${out.statusCode} ${out.body}`);
  return out.body ? JSON.parse(out.body) : undefined;
}

// A real (suppressed-invitation) user with a verified address, so the notifier finds a recipient.
const email = `e2e-transfer-${Date.now()}@example.com`;
const created = await cognito.send(
  new AdminCreateUserCommand({
    UserPoolId: userPoolId, Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
  }),
);
const publisherSub = created.User!.Attributes!.find((a) => a.Name === 'sub')!.Value!;
const operatorSub = `e2e-operator-${Date.now()}`;
const publisherId = ulid();
const channelId = `e2e-transfer-${Date.now().toString(36)}`;
const now = new Date().toISOString();
const { key: keyA } = await createKey('e2e-transfer-passphrase-a');
const { key: keyB } = await createKey('e2e-transfer-passphrase-b');
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const publisher = () => invoke(publisherSub, '[publisher]', 'GET', '/api/publisher');
const asOperator = (method: string, path: string, options?: Parameters<typeof invoke>[4]) => invoke(operatorSub, '[operator]', method, path, options);

/** A submission signed with `key`, through the machine review and the operator's approval. */
async function approveVersion(version: number, key: PublisherKey) {
  const sid = ulid();
  const manifest = {
    format: 1, id: channelId, version, publisher: key.accountId,
    name: '移し替えの確認', summary: '鍵の移し替えの通しの確認', lang: 'ja', greeting: '確認です。',
    talk: { level: 'quiet', events: { spot: true, revisit: false, milestone: false, rest: false, start: true, finish: true } },
    spots: { prefer: ['temple'], skip: [] }, guide: { length: 'short' }, mood: { tone: false, sound: 'auto' },
  };
  const zip = (await signPackage(zipSync({ 'channel.json': enc.encode(JSON.stringify(manifest)), 'prompts/guide/focus.md': enc.encode('- 由来を中心に話す\n') }), key, { channel: channelId })).zip;
  const at = new Date().toISOString();
  await db.send(new PutCommand({
    TableName: table,
    Item: {
      PK: `CH#${channelId}`, SK: `SUB#${sid}`, type: 'submission', submissionId: sid, channelId, publisherId, accountId: key.accountId,
      state: 'uploading', intakeKey: `intake/${channelId}/${sid}.zip`, iconIntakeKey: `intake/${channelId}/${sid}.png`, rev: 1, createdAt: at, updatedAt: at,
    },
  }));
  await db.send(new PutCommand({ TableName: table, Item: { ...(await db.send(new GetCommand({ TableName: table, Key: { PK: `CH#${channelId}`, SK: 'CH' } }))).Item, pendingSubmissionId: sid } }));
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `intake/${channelId}/${sid}.zip`, Body: zip, ContentType: 'application/zip' }));
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `intake/${channelId}/${sid}.png`, Body: png, ContentType: 'image/png' }));
  let sub: Record<string, unknown> = {};
  for (let t = Date.now(); Date.now() - t < 120_000; await sleep(2000)) {
    sub = (await db.send(new GetCommand({ TableName: table, Key: { PK: `CH#${channelId}`, SK: `SUB#${sid}` }, ConsistentRead: true }))).Item!;
    if (sub.state !== 'uploading') break;
  }
  if (sub.state !== 'awaiting_review') throw new Error(`version ${version}: ${String(sub.state)} ${JSON.stringify(sub.validation)}`);
  const base = `/api/admin/channels/${channelId}/submissions/${sid}`;
  const started = await asOperator('POST', `${base}/start`, { ifMatch: Number(sub.rev) });
  await asOperator('POST', `${base}/approve`, { body: {}, ifMatch: started.rev });
  console.log(`version ${version} (key ${key.accountId}) approved`);
}

async function listedEntry() {
  const doc = await (await fetch(`${providerUrl}/v1/channels.json?${Date.now()}`)).json();
  const body = JSON.parse(utf8.decode(Uint8Array.from(atob(doc.payload.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
  return (body.channels as { id: string; version: number; publisher: string; publisherChange?: { from: string } }[]).find((c) => c.id === channelId);
}

try {
  await db.send(new PutCommand({ TableName: table, Item: { PK: `USER#${publisherSub}`, SK: 'USER', type: 'user', publisherId } }));
  await db.send(new PutCommand({
    TableName: table,
    Item: { PK: `PUB#${publisherId}`, SK: 'PUB', type: 'publisher', publisherId, ownerSub: publisherSub, displayName: '移し替えの確認の配信元', contact: email, status: 'active', activeAccountId: keyA.accountId, channelCount: 1, rev: 2, createdAt: now, updatedAt: now },
  }));
  await db.send(new PutCommand({ TableName: table, Item: { PK: `PUB#${publisherId}`, SK: `KEY#${keyA.accountId}`, type: 'publisher-key', accountId: keyA.accountId, publicKey: b64url.encode(keyA.publicKey), status: 'active', boundAt: now } }));
  await db.send(new PutCommand({ TableName: table, Item: { PK: `ACCOUNT#${keyA.accountId}`, SK: 'ACCOUNT', type: 'account', publisherId } }));
  await db.send(new PutCommand({
    TableName: table,
    Item: { PK: `CH#${channelId}`, SK: 'CH', type: 'channel', channelId, publisherId, status: 'active', rev: 1, createdAt: now, updatedAt: now, GSI1PK: `PUB#${publisherId}`, GSI1SK: `CH#${channelId}` },
  }));

  // 1. Version 1 with key A.
  await approveVersion(1, keyA);

  // 2. The publisher asks to move to key B; an operator approves.
  const challenge = await invoke(publisherSub, '[publisher]', 'POST', '/api/publisher/keys/challenge');
  const signature = await sign(keyB, enc.encode(challenge.message));
  const asked = await invoke(publisherSub, '[publisher]', 'POST', '/api/publisher/key-transfers', {
    body: { nonce: challenge.nonce, publicKey: b64url.encode(keyB.publicKey), signature: b64url.encode(signature), reason: 'lost', publicReason: '配信元の鍵の紛失（確認）' },
  });
  console.log('transfer requested:', asked.state);
  const queue = await asOperator('GET', '/api/admin/key-transfers');
  console.log('in the queue:', queue.items.some((t: { transferId: string }) => t.transferId === asked.transferId));
  const approved = await asOperator('POST', `/api/admin/publishers/${publisherId}/key-transfers/${asked.transferId}/approve`, {
    body: { verification: { method: '通しの確認', detail: 'e2e のため確認を省略' } }, ifMatch: asked.rev,
  });
  console.log('transfer approved:', approved.state, '| active key is B:', (await publisher()).activeAccountId === keyB.accountId);

  // 3. Version 2 with key B; the list shows the change from A.
  await approveVersion(2, keyB);
  let entry: Awaited<ReturnType<typeof listedEntry>>;
  for (let t = Date.now(); Date.now() - t < 120_000; await sleep(3000)) {
    entry = await listedEntry();
    if (entry?.version === 2) break;
  }
  console.log('listed:', JSON.stringify({ version: entry?.version, publisherIsB: entry?.publisher === keyB.accountId, changeFromA: entry?.publisherChange?.from === keyA.accountId }));
  const discovery = await (await fetch(`${providerUrl}/.well-known/sanpo-channels`)).json();
  for (const r of await checkProvider(providerUrl, { expectedProvider: discovery.provider })) console.log(`  ${r.status.toUpperCase().padEnd(4)} ${r.id} ${r.detail}`);

  // 4. The notices: approve v1, the transfer, approve v2.
  let sent: string[] = [];
  for (let t = Date.now(); Date.now() - t < 60_000; await sleep(3000)) {
    const log = await db.send(new QueryCommand({ TableName: table, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :t', ExpressionAttributeValues: { ':t': `TARGET#PUB#${publisherId}` } }));
    sent = (log.Items ?? []).filter((i) => String(i.action).startsWith('notification.')).map((i) => `${String(i.action)}:${String((i.detail as { event: string }).event)}`);
    if (sent.length >= 3) break;
  }
  console.log('notices:', sent.sort().join(', '));
} finally {
  const items = [
    ...((await db.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `CH#${channelId}` } }))).Items ?? []),
    ...((await db.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `PUB#${publisherId}` } }))).Items ?? []),
    { PK: `USER#${publisherSub}`, SK: 'USER' }, { PK: `ACCOUNT#${keyA.accountId}`, SK: 'ACCOUNT' }, { PK: `ACCOUNT#${keyB.accountId}`, SK: 'ACCOUNT' },
  ];
  for (const item of items) await db.send(new DeleteCommand({ TableName: table, Key: { PK: item.PK, SK: item.SK } }));
  await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email })).catch((e) => console.error(e));
  await asOperator('POST', '/api/admin/publications', { body: { reason: '移し替えの通しの確認の後片付け' } }).catch((e) => console.error(e));
  console.log('cleaned up; the list is being rebuilt without', channelId);
}
