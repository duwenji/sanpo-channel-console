import { GetCommand, QueryCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import type { Schemas } from '@sanpo-console/api-types';
import type { Deps } from './deps.js';
import { fail, limit, type Request } from './http.js';
import { jstDate } from './util.js';

// Reading and showing the table's items, shared by the operator and publisher routes.

export type Item = Record<string, unknown>;

/** DM-001 M-2; an operator can change them per publisher. */
export const DEFAULT_LIMITS = { channels: 5, uploadsPerDay: 20, ticketsPerDay: 10 };

export async function get(deps: Deps, PK: string, SK: string): Promise<Item | undefined> {
  return (await deps.db.send(new GetCommand({ TableName: deps.table, Key: { PK, SK }, ConsistentRead: true }))).Item;
}

export async function page(deps: Deps, req: Request, input: Omit<QueryCommandInput, 'TableName' | 'Limit' | 'ExclusiveStartKey'>) {
  const out = await deps.db.send(
    new QueryCommand({ ...input, TableName: deps.table, Limit: limit(req), ExclusiveStartKey: deps.cursors.decode(req.query.cursor) }),
  );
  return { items: out.Items ?? [], nextCursor: deps.cursors.encode(out.LastEvaluatedKey) };
}

export async function publisherView(deps: Deps, item: Item): Promise<Schemas['Publisher']> {
  const quota = await get(deps, `PUB#${String(item.publisherId)}`, `QUOTA#${jstDate(deps.now())}`);
  return {
    publisherId: String(item.publisherId),
    displayName: String(item.displayName ?? ''),
    ...(item.contact !== undefined ? { contact: String(item.contact) } : {}),
    status: item.status as Schemas['PublisherStatus'],
    ...(item.statusReason ? { statusReason: String(item.statusReason) } : {}),
    activeAccountId: (item.activeAccountId as string | undefined) ?? null,
    limits: { ...DEFAULT_LIMITS, ...((item.limits as object | undefined) ?? {}) },
    usage: {
      channels: Number(item.channelCount ?? 0),
      uploadsToday: Number(quota?.uploads ?? 0),
      ticketsToday: Number(quota?.tickets ?? 0),
    },
    rev: Number(item.rev),
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt),
  };
}

export async function loadPublisher(deps: Deps, publisherId: string): Promise<Item> {
  return (await get(deps, `PUB#${publisherId}`, 'PUB')) ?? fail('not_found', `no publisher ${publisherId}`);
}

export async function channelView(deps: Deps, item: Item): Promise<Schemas['Channel']> {
  const revocations = await deps.db.send(
    new QueryCommand({
      TableName: deps.table,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :r)',
      ExpressionAttributeValues: { ':pk': `CH#${String(item.channelId)}`, ':r': 'REVOKE#' },
    }),
  );
  return {
    channelId: String(item.channelId),
    publisherId: String(item.publisherId),
    status: item.status as 'active' | 'revoked',
    pendingSubmissionId: (item.pendingSubmissionId as string | undefined) ?? null,
    latestApproved: (item.latestApproved as Schemas['LatestApproved'] | undefined) ?? null,
    listed: item.GSI2PK === 'LISTED',
    publisherChange: (item.publisherChange as Schemas['Channel']['publisherChange']) ?? null,
    revocations: (revocations.Items ?? []).map((r) => ({
      ...(r.versions ? { versions: r.versions as number[] } : {}),
      reason: String(r.reason),
      severity: r.severity as 'high' | 'low',
      revokedAt: String(r.revokedAt),
    })),
    rev: Number(item.rev),
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt),
  };
}

export async function loadChannel(deps: Deps, channelId: string): Promise<Item> {
  return (await get(deps, `CH#${channelId}`, 'CH')) ?? fail('not_found', `no channel ${channelId}`);
}
