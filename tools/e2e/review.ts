import { CloudFormationClient, DescribeStackResourcesCommand, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { utf8 } from '@sanpo-console/protocol';
import { zipSync } from 'fflate';
import { ulid } from '../../api/src/console/util.js';
import { checkProvider } from '../../conformance/src/check.js';
import { createKey, signPackage } from '../../web/src/publisher-crypto.js';

/**
 * The whole path on the dev environment: a publisher's signed package passes the machine review,
 * an operator starts the review and approves it (calling the console Lambda as API Gateway would
 * after the JWT check), the publisher lists it, and the conformance checks pass with V-07 (the
 * approved package and icon). Then the test data is removed and the list rebuilt.
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
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const lambda = new LambdaClient({ region });
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function invoke(sub: string, groups: string, method: string, path: string, options: { body?: unknown; ifMatch?: number } = {}) {
  const event = {
    rawPath: path,
    headers: options.ifMatch !== undefined ? { 'if-match': `"${options.ifMatch}"` } : {},
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    requestContext: { requestId: 'e2e-review', http: { method }, authorizer: { jwt: { claims: { sub, 'cognito:groups': groups } } } },
  };
  const res = await lambda.send(new InvokeCommand({ FunctionName: consoleFn, Payload: utf8.encode(JSON.stringify(event)) }));
  const out = JSON.parse(utf8.decode(res.Payload!));
  const body = out.body ? JSON.parse(out.body) : undefined;
  if (out.statusCode >= 400) throw new Error(`${method} ${path}: ${out.statusCode} ${out.body}`);
  return body;
}

const { key } = await createKey('e2e-review-passphrase');
const publisherSub = `e2e-publisher-${Date.now()}`;
const operatorSub = `e2e-operator-${Date.now()}`;
const publisherId = ulid();
const channelId = `e2e-review-${Date.now().toString(36)}`;
const sid = ulid();
const now = new Date().toISOString();
const manifest = {
  format: 1, id: channelId, version: 1, publisher: key.accountId,
  name: '通しの確認', summary: '承認までの通しの確認', lang: 'ja', greeting: '確認です。',
  talk: { level: 'quiet', events: { spot: true, revisit: false, milestone: false, rest: false, start: true, finish: true } },
  spots: { prefer: ['temple'], skip: [] }, guide: { length: 'short' }, mood: { tone: false, sound: 'auto' },
};
const zip = (await signPackage(zipSync({ 'channel.json': enc.encode(JSON.stringify(manifest)), 'prompts/guide/focus.md': enc.encode('- 由来を中心に話す\n') }), key, { channel: channelId })).zip;
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

const seeded = [
  { PK: `USER#${publisherSub}`, SK: 'USER', type: 'user', publisherId },
  { PK: `PUB#${publisherId}`, SK: 'PUB', type: 'publisher', publisherId, displayName: '通しの確認の配信元', status: 'active', activeAccountId: key.accountId, channelCount: 1, rev: 2, createdAt: now, updatedAt: now },
  { PK: `CH#${channelId}`, SK: 'CH', type: 'channel', channelId, publisherId, status: 'active', rev: 1, pendingSubmissionId: sid, createdAt: now, updatedAt: now, GSI1PK: `PUB#${publisherId}`, GSI1SK: `CH#${channelId}` },
  {
    PK: `CH#${channelId}`, SK: `SUB#${sid}`, type: 'submission', submissionId: sid, channelId, publisherId, accountId: key.accountId,
    state: 'uploading', intakeKey: `intake/${channelId}/${sid}.zip`, iconIntakeKey: `intake/${channelId}/${sid}.png`, description: '通しの確認', rev: 1, createdAt: now, updatedAt: now,
  },
];

try {
  for (const Item of seeded) await db.send(new PutCommand({ TableName: table, Item }));
  const s3 = new S3Client({ region });
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `intake/${channelId}/${sid}.zip`, Body: zip, ContentType: 'application/zip' }));
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `intake/${channelId}/${sid}.png`, Body: png, ContentType: 'image/png' }));

  // 1. The machine review.
  let sub: Record<string, unknown> = {};
  for (let t = Date.now(); Date.now() - t < 120_000; await sleep(2000)) {
    sub = (await db.send(new GetCommand({ TableName: table, Key: { PK: `CH#${channelId}`, SK: `SUB#${sid}` }, ConsistentRead: true }))).Item!;
    if (sub.state !== 'uploading') break;
  }
  console.log('machine review:', sub.state);
  if (sub.state !== 'awaiting_review') throw new Error(JSON.stringify(sub.validation));

  // 2. The operator reviews and approves.
  const queue = await invoke(operatorSub, '[operator]', 'GET', '/api/admin/review-queue');
  console.log('in the queue:', queue.items.some((s: { submissionId: string }) => s.submissionId === sid));
  const prompts = await invoke(operatorSub, '[operator]', 'GET', `/api/admin/channels/${channelId}/submissions/${sid}/sample-prompts`);
  const saved = await invoke(operatorSub, '[operator]', 'POST', `/api/admin/channels/${channelId}/submissions/${sid}/samples`, {
    body: { service: 'e2e', model: 'none', items: prompts.scenarios.map((x: { id: string }) => ({ scenarioId: x.id, output: '（通しの確認のため AI は呼ばない）' })) },
  });
  const started = await invoke(operatorSub, '[operator]', 'POST', `/api/admin/channels/${channelId}/submissions/${sid}/start`, { ifMatch: Number(sub.rev) });
  const approved = await invoke(operatorSub, '[operator]', 'POST', `/api/admin/channels/${channelId}/submissions/${sid}/approve`, {
    body: { samplesIds: [saved.samplesId], message: '通しの確認' }, ifMatch: started.rev,
  });
  console.log('approved:', approved.submission.state, '| samples scenes:', prompts.scenarios.length);

  // 3. Wait until the list carries it.
  let listed = false;
  for (let t = Date.now(); !listed && Date.now() - t < 120_000; await sleep(3000)) {
    const doc = await (await fetch(`${providerUrl}/v1/channels.json?${Date.now()}`)).json();
    listed = utf8.decode(Uint8Array.from(atob(doc.payload.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))).includes(channelId);
  }
  console.log('listed:', listed);

  // 4. The conformance checks, now with a real package and icon (V-07).
  const discovery = await (await fetch(`${providerUrl}/.well-known/sanpo-channels`)).json();
  const results = await checkProvider(providerUrl, { expectedProvider: discovery.provider });
  for (const r of results) console.log(`  ${r.status.toUpperCase().padEnd(4)} ${r.id} ${r.detail}`);
} finally {
  // Remove what this run made, then rebuild the list without it.
  const rest = await db.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `CH#${channelId}` } }));
  for (const item of [...(rest.Items ?? []), ...seeded]) await db.send(new DeleteCommand({ TableName: table, Key: { PK: item.PK, SK: item.SK } }));
  await invoke(operatorSub, '[operator]', 'POST', '/api/admin/publications', { body: { reason: '通しの確認の後片付け' } }).catch((e) => console.error(e));
  console.log('cleaned up; the list is being rebuilt without', channelId);
}
