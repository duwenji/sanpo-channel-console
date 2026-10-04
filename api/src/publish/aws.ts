import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  BatchGetCommand,
  type BatchGetCommandOutput,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { ChannelEntry, RevokedEntry, Signer, SignedDocument } from '@sanpo-console/protocol';
import {
  SeqConflictError,
  type Cdn,
  type DocumentStorage,
  type PublicationRecord,
  type PublicationStore,
  type SigningKeyRecord,
} from './ports.js';

const GSI2 = 'GSI2';

/** Seq as sorted text in the history's sort key (DM-001: `SEQ#` + 10 digits). */
export const seqKey = (seq: number) => `SEQ#${String(seq).padStart(10, '0')}`;

interface ChannelItem {
  channelId: string;
  publisherId: string;
  latestApproved?: Omit<ChannelEntry, 'id' | 'publisherName' | 'publisherChange'> & { submissionId: string };
  publisherChange?: { from: string; at: string; reason: string; until?: string };
}

/** The publisher's view of the DynamoDB table of DM-001. */
export class DynamoStore implements PublicationStore {
  private readonly db: DynamoDBDocumentClient;

  constructor(
    private readonly table: string,
    client: DynamoDBClient = new DynamoDBClient({}),
  ) {
    this.db = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async headSeq() {
    const out = await this.db.send(new GetCommand({ TableName: this.table, Key: { PK: 'PUBLICATION', SK: 'HEAD' }, ConsistentRead: true }));
    return typeof out.Item?.seq === 'number' ? out.Item.seq : null;
  }

  async listedChannels(now: Date): Promise<ChannelEntry[]> {
    const items = await this.queryAll<ChannelItem>('LISTED');
    const names = await this.publisherNames([...new Set(items.map((i) => i.publisherId))]);
    return items
      .filter((i) => i.latestApproved)
      .map((i) => {
        const { submissionId: _s, ...approved } = i.latestApproved!;
        // Only once a version with the new key is listed, and for 90 days from then (API-002 P-9, V-16).
        const c = i.publisherChange;
        const change = c?.until && Date.parse(c.until) > now.getTime() && c.from !== approved.publisher ? c : undefined;
        return {
          id: i.channelId,
          ...approved,
          publisherName: names.get(i.publisherId) ?? '',
          ...(change ? { publisherChange: { from: change.from, at: change.at, reason: change.reason } } : {}),
        } as ChannelEntry;
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async revocations(since: Date): Promise<RevokedEntry[]> {
    const items = await this.queryAll<{ channelId: string; versions?: number[]; reason: string; revokedAt: string }>('REVOKED');
    return items
      .filter((r) => Date.parse(r.revokedAt) >= since.getTime())
      .map((r) => ({ id: r.channelId, ...(r.versions ? { versions: r.versions } : {}), reason: r.reason, revokedAt: r.revokedAt }));
  }

  async expireRevocations(before: Date) {
    const items = await this.queryAll<{ PK: string; SK: string; revokedAt: string }>('REVOKED');
    for (const r of items.filter((i) => Date.parse(i.revokedAt) < before.getTime())) {
      await this.db.send(new UpdateCommand({ TableName: this.table, Key: { PK: r.PK, SK: r.SK }, UpdateExpression: 'REMOVE GSI2PK, GSI2SK' }));
    }
  }

  async currentKeyset() {
    const out = await this.db.send(new GetCommand({ TableName: this.table, Key: { PK: 'KEYSET', SK: 'HEAD' }, ConsistentRead: true }));
    return (out.Item?.document as SignedDocument | undefined) ?? null;
  }

  async signingKey(keyId: string) {
    const out = await this.db.send(new GetCommand({ TableName: this.table, Key: { PK: 'SIGNKEY', SK: `KEY#${keyId}` } }));
    if (!out.Item) return null;
    return { keyId, kmsKeyArn: String(out.Item.kmsKeyArn), status: out.Item.status } as SigningKeyRecord;
  }

  async recordPublication(previousSeq: number | null, record: PublicationRecord) {
    const head = { PK: 'PUBLICATION', SK: 'HEAD', type: 'publication', ...record };
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: head,
                ...(previousSeq === null
                  ? { ConditionExpression: 'attribute_not_exists(PK)' }
                  : { ConditionExpression: 'seq = :prev', ExpressionAttributeValues: { ':prev': previousSeq } }),
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { ...head, SK: seqKey(record.seq) },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
      );
    } catch (e) {
      if (e instanceof TransactionCanceledException) throw new SeqConflictError(previousSeq);
      throw e;
    }
  }

  private async queryAll<T>(gsi2pk: string): Promise<(T & { PK: string; SK: string })[]> {
    const items: (T & { PK: string; SK: string })[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          IndexName: GSI2,
          KeyConditionExpression: 'GSI2PK = :pk',
          ExpressionAttributeValues: { ':pk': gsi2pk },
          ExclusiveStartKey: start,
        }),
      );
      items.push(...((out.Items ?? []) as (T & { PK: string; SK: string })[]));
      start = out.LastEvaluatedKey;
    } while (start);
    return items;
  }

  private async publisherNames(ids: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 100) {
      let keys: Record<string, unknown>[] | undefined = ids.slice(i, i + 100).map((id) => ({ PK: `PUB#${id}`, SK: 'PUB' }));
      while (keys && keys.length > 0) {
        const out: BatchGetCommandOutput = await this.db.send(
          new BatchGetCommand({ RequestItems: { [this.table]: { Keys: keys, ProjectionExpression: 'publisherId, displayName' } } }),
        );
        for (const item of out.Responses?.[this.table] ?? []) names.set(String(item.publisherId), String(item.displayName ?? ''));
        keys = out.UnprocessedKeys?.[this.table]?.Keys;
      }
    }
    return names;
  }
}

export class S3Storage implements DocumentStorage {
  constructor(
    private readonly publicBucket: string,
    private readonly archiveBucket: string,
    private readonly s3: S3Client = new S3Client({}),
  ) {}

  async putPublic(path: string, body: Uint8Array, contentType: string, cacheControl: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.publicBucket, Key: path, Body: body, ContentType: contentType, CacheControl: cacheControl }));
  }

  async putArchive(path: string, body: Uint8Array, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.archiveBucket, Key: path, Body: body, ContentType: contentType }));
  }
}

export class CloudFrontCdn implements Cdn {
  constructor(
    private readonly distributionId: string,
    private readonly cf: CloudFrontClient = new CloudFrontClient({}),
  ) {}

  async invalidate(paths: string[]) {
    await this.cf.send(
      new CreateInvalidationCommand({
        DistributionId: this.distributionId,
        InvalidationBatch: { CallerReference: `${Date.now()}-${Math.random()}`, Paths: { Quantity: paths.length, Items: paths } },
      }),
    );
  }
}

/** Signs with an Ed25519 key in KMS: pure Ed25519 over the message itself (ADR-001 A-8, at most 4,096 bytes). */
export function kmsSigner(key: SigningKeyRecord, kms: KMSClient = new KMSClient({})): Signer {
  return {
    keyId: key.keyId,
    sign: async (message) => {
      if (message.length > 4096) throw new Error(`KMS signs at most 4096 bytes, not ${message.length}`);
      const out = await kms.send(
        new SignCommand({ KeyId: key.kmsKeyArn, Message: message, MessageType: 'RAW', SigningAlgorithm: 'ED25519_SHA_512' }),
      );
      if (!out.Signature) throw new Error('KMS returned no signature');
      return out.Signature;
    },
  };
}
