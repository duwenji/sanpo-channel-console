import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Notice } from '../src/console/deps.js';
import { deliver, render, type Mail, type NotifyPorts } from '../src/notify/notify.js';
import { freshTable, startDynamoLocal } from './dynamo-local.js';

const PUB = '01JZ0000000000000000000000';
const CONSOLE = 'https://console.example';

let local: Awaited<ReturnType<typeof startDynamoLocal>>;
let ports: NotifyPorts;
let sent: Mail[];
let failSend: boolean;

beforeAll(async () => {
  local = await startDynamoLocal();
}, 120_000);
afterAll(() => local?.stop());

beforeEach(async () => {
  const fresh = await freshTable(local.endpoint);
  sent = [];
  failSend = false;
  ports = {
    db: fresh.db,
    table: fresh.table,
    now: () => new Date('2026-10-04T03:00:00.000Z'),
    consoleUrl: CONSOLE,
    emailOf: async (sub) => (sub === 'sub-alice' ? 'alice@example.com' : undefined),
    send: async (mail) => {
      if (failSend) throw Object.assign(new Error('throttled'), { name: 'TooManyRequestsException' });
      sent.push(mail);
      return `msg-${sent.length}`;
    },
  };
  await fresh.db.send(new PutCommand({ TableName: fresh.table, Item: { PK: `PUB#${PUB}`, SK: 'PUB', publisherId: PUB, ownerSub: 'sub-alice', status: 'active' } }));
});

const notice = (over: Partial<Notice> = {}): Notice => ({
  noticeId: '01JZ0000000000000000000001', event: 'submission.returned', publisherId: PUB, channelId: 'kamakura-history', version: 2,
  findings: [{ item: '2.2', detail: '立入禁止の場所に誘っている' }], message: '直してください', ...over,
});

async function audit() {
  const out = await ports.db.send(new QueryCommand({ TableName: ports.table, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :t', ExpressionAttributeValues: { ':t': `TARGET#PUB#${PUB}` } }));
  return (out.Items ?? []).map((i) => ({ action: i.action, actorRole: i.actorRole, detail: i.detail }));
}

describe('the publisher’s emails', () => {
  it('says what happened, why, and where to look, for every event', () => {
    const mail = render(notice(), CONSOLE);
    expect(mail.subject).toBe('【SanpoGuide】チャンネル kamakura-history の版 2 を差し戻しました');
    expect(mail.body).toContain('・2.2: 立入禁止の場所に誘っている');
    expect(mail.body).toContain('直してください');
    expect(mail.body).toContain(`${CONSOLE}/channels/kamakura-history`);
    for (const event of ['submission.approved', 'submission.rejected', 'channel.revoked', 'transfer.approved', 'transfer.rejected'] as const) {
      expect(render(notice({ event }), CONSOLE).subject).toMatch(/^【SanpoGuide】.+/);
    }
    expect(render(notice({ event: 'transfer.approved', channelId: undefined, returned: 2 }), CONSOLE).body).toContain('2 件を差し戻しました');
  });

  it('sends once to the verified address and records it without the address', async () => {
    expect(await deliver(ports, notice(), 1, 3)).toBe('sent');
    expect(await deliver(ports, notice(), 1, 3)).toBe('duplicate');
    expect(sent.map((m) => m.to)).toEqual(['alice@example.com']);
    const log = await audit();
    expect(log).toEqual([{ action: 'notification.sent', actorRole: 'system', detail: { event: 'submission.returned', noticeId: notice().noticeId, messageId: 'msg-1' } }]);
    expect(JSON.stringify(log)).not.toContain('alice@example.com');
  });

  it('retries a failed send and records the failure on the last attempt', async () => {
    failSend = true;
    await expect(deliver(ports, notice(), 1, 3)).rejects.toThrow('throttled');
    expect(await audit()).toEqual([]);
    await expect(deliver(ports, notice(), 3, 3)).rejects.toThrow('throttled');
    expect(await audit()).toEqual([
      { action: 'notification.failed', actorRole: 'system', detail: { event: 'submission.returned', noticeId: notice().noticeId, error: 'TooManyRequestsException', attempts: 3 } },
    ]);
  });

  it('skips a publisher with no verified address, or one that has left', async () => {
    await ports.db.send(new PutCommand({ TableName: ports.table, Item: { PK: `PUB#${PUB}`, SK: 'PUB', publisherId: PUB, ownerSub: 'sub-alice', status: 'deleted' } }));
    expect(await deliver(ports, notice(), 1, 3)).toBe('skipped');
    expect(sent).toEqual([]);
    expect((await audit())[0]).toMatchObject({ action: 'notification.failed', detail: { error: 'no_verified_email' } });
  });
});
