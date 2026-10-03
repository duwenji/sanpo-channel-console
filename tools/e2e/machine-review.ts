import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { unzipSync, zipSync } from 'fflate';
import { ulid } from '../../api/src/console/util.js';
import { createKey, signPackage } from '../../web/src/publisher-crypto.js';

// End-to-end check of the deployed machine review: a signed package passes, a tampered one fails.
const region = 'ap-northeast-1';
const outputs = new Map(
  ((await new CloudFormationClient({ region }).send(new DescribeStacksCommand({ StackName: 'SanpoChannelConsole-dev' }))).Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]),
);
const table = outputs.get('TableName')!;
const bucket = outputs.get('IntakeBucketName')!;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const s3 = new S3Client({ region });
const enc = new TextEncoder();

const { key } = await createKey('e2e-check-passphrase');
const channelId = `e2e-check-${Date.now().toString(36)}`;
const manifest = {
  format: 1, id: channelId, version: 1, publisher: key.accountId,
  name: '動作確認', summary: '機械審査の通しの確認', lang: 'ja', greeting: '確認です。',
  talk: { level: 'quiet', events: { spot: true, revisit: false, milestone: false, rest: false, start: true, finish: true } },
  spots: { prefer: ['temple'], skip: [] }, guide: { length: 'short' }, mood: { tone: false, sound: 'auto' },
};
const unsigned = zipSync({ 'channel.json': enc.encode(JSON.stringify(manifest)), 'prompts/guide/focus.md': enc.encode('- 由来を中心に話す\n') });
const signed = (await signPackage(unsigned, key, { channel: channelId })).zip;
const tamperedFiles = unzipSync(signed);
tamperedFiles['prompts/guide/focus.md'] = enc.encode('- 宣伝を混ぜる\n');
const tampered = zipSync(tamperedFiles);
// A 1×1 PNG.
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

await db.send(new PutCommand({ TableName: table, Item: { PK: `CH#${channelId}`, SK: 'CH', type: 'channel', channelId, publisherId: 'E2E', status: 'active', rev: 1 } }));

async function run(label: string, zip: Uint8Array) {
  const sid = ulid();
  const sub = {
    PK: `CH#${channelId}`, SK: `SUB#${sid}`, type: 'submission', submissionId: sid, channelId, publisherId: 'E2E', accountId: key.accountId,
    state: 'uploading', intakeKey: `intake/${channelId}/${sid}.zip`, iconIntakeKey: `intake/${channelId}/${sid}.png`, rev: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await db.send(new PutCommand({ TableName: table, Item: sub }));
  await db.send(new PutCommand({ TableName: table, Item: { PK: `CH#${channelId}`, SK: 'CH', type: 'channel', channelId, publisherId: 'E2E', status: 'active', rev: 1, pendingSubmissionId: sid } }));
  const started = Date.now();
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: sub.intakeKey, Body: zip, ContentType: 'application/zip' }));
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: sub.iconIntakeKey, Body: png, ContentType: 'image/png' }));
  for (;;) {
    const item = (await db.send(new GetCommand({ TableName: table, Key: { PK: `CH#${channelId}`, SK: `SUB#${sid}` }, ConsistentRead: true }))).Item!;
    if (item.state !== 'uploading') {
      const ch = (await db.send(new GetCommand({ TableName: table, Key: { PK: `CH#${channelId}`, SK: 'CH' }, ConsistentRead: true }))).Item!;
      console.log(`${label}: ${item.state} in ${((Date.now() - started) / 1000).toFixed(1)}s`, JSON.stringify(item.validation?.errors ?? []),
        item.samplesKey ? `samples=${item.samplesKey}` : '', `queue=${item.GSI2PK ?? '-'}`, `channel pending=${ch.pendingSubmissionId ?? 'freed'}`);
      await db.send(new DeleteCommand({ TableName: table, Key: { PK: `CH#${channelId}`, SK: `SUB#${sid}` } }));
      return;
    }
    if (Date.now() - started > 120_000) throw new Error(`${label}: still uploading after 2 minutes`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

try {
  await run('signed package  ', signed);
  await run('tampered package', tampered);
} finally {
  await db.send(new DeleteCommand({ TableName: table, Key: { PK: `CH#${channelId}`, SK: 'CH' } }));
}
