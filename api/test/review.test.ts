import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { b64url, generateEd25519, sha256Hex, signDocument, signEd25519, utf8, verifyChannelList, verifyDiscovery } from '@sanpo-console/protocol';
import { makeTestProvider, type TestProvider } from '@sanpo-console/protocol/testing';
import { zipSync } from 'fflate';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Deps } from '../src/console/deps.js';
import type { Caller } from '../src/console/http.js';
import { route } from '../src/console/router.js';
import { CursorCodec } from '../src/console/util.js';
import { DynamoStore } from '../src/publish/aws.js';
import { DISCOVERY_PATH, LIST_PATH, MemoryStorage, noCdn, publish } from '../src/publish/index.js';
import type { Trigger } from '../src/publish/ports.js';
import { freshTable, startDynamoLocal } from './dynamo-local.js';

const alice: Caller = { sub: 'sub-alice', roles: ['publisher'] };
const operator: Caller = { sub: 'op-1', roles: ['operator'] };
const start = new Date('2026-10-04T03:00:00.000Z');

let local: Awaited<ReturnType<typeof startDynamoLocal>>;
let deps: Deps;
let raw: DynamoDBClient;
let clock: number;
let provider: TestProvider;
let published: Trigger[];
let uploads: Map<string, Uint8Array>;
let records: Map<string, string>;
let archived: string[];

beforeAll(async () => {
  local = await startDynamoLocal();
}, 120_000);
afterAll(() => local?.stop());

beforeEach(async () => {
  const fresh = await freshTable(local.endpoint);
  raw = fresh.raw;
  clock = start.getTime();
  provider = await makeTestProvider({ now: start });
  published = [];
  uploads = new Map();
  records = new Map();
  archived = [];
  deps = {
    db: fresh.db,
    table: fresh.table,
    now: () => new Date(clock++),
    cursors: new CursorCodec(randomBytes(32)),
    rootPublicKey: b64url.encode(provider.rootKey),
    kmsPublicKey: async () => ({ keySpec: undefined, publicKey: new Uint8Array() }),
    requestPublish: async (t) => void published.push(t),
    presignUpload: async (key) => ({ url: 'https://intake.example/', fields: { key } }),
    archiveUpload: async (key) => void archived.push(key),
    deleteUser: async () => {},
    publishTrial: async (_k, sha) => `https://provider.example/trial/${sha}.zip`,
    packageUrl: (sha) => `https://provider.example/pkg/${sha}.zip`,
    signDocument: (c) => signDocument(c, provider.signing),
    readUpload: async (key) => uploads.get(key) ?? new Uint8Array(),
    presignDownload: async (key) => `https://intake.example/${key}?signed`,
    readRecord: async (key) => records.get(key),
    writeRecord: async (key, body) => void records.set(key, body),
    publishApproved: async ({ packageSha256, iconSha256 }) => ({
      packageUrl: `https://provider.example/pkg/${packageSha256}.zip`,
      iconUrl: `https://provider.example/icons/${iconSha256}.png`,
    }),
  };
});

async function call(caller: Caller, method: string, path: string, options: { body?: unknown; ifMatch?: number } = {}) {
  const res = await route(deps, {
    method, path, query: {}, body: options.body, caller, requestId: 'req',
    headers: options.ifMatch !== undefined ? { 'if-match': `"${options.ifMatch}"` } : {},
  });
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

/** A publisher with a channel and a submission the machine review passed, as stages 3a and 3b leave it. */
async function awaitingReview(version = 1) {
  const reg = await call(alice, 'POST', '/api/publisher', { body: { displayName: '鎌倉歴史散歩の会', contact: 'k@example.com' } }).catch(() => undefined);
  if (reg?.status === 201) {
    const key = generateEd25519();
    const challenge = await call(alice, 'POST', '/api/publisher/keys/challenge');
    await call(alice, 'POST', '/api/publisher/keys', {
      body: { nonce: challenge.body.nonce, publicKey: b64url.encode(key.publicKey), signature: b64url.encode(signEd25519(key.privateKey, utf8.encode(challenge.body.message))) },
    });
    await call(alice, 'POST', '/api/channels', { body: { channelId: 'kamakura-history' } });
  }
  const created = await call(alice, 'POST', '/api/channels/kamakura-history/submissions', { body: { description: '鎌倉の寺社', tags: ['history'] } });
  const sid = created.body.submission.submissionId as string;
  const zip = zipSync({ 'channel.json': utf8.encode(JSON.stringify({ id: 'kamakura-history', version, name: '鎌倉歴史散歩', summary: '寺社と武士の歴史', lang: 'ja' })) });
  uploads.set(`intake/kamakura-history/${sid}.zip`, zip);
  records.set(`samples/${sid}/prompts.json`, JSON.stringify({ generatedBy: 'station-format 1.1.0', scenarios: [{ id: 'start-morning-sunny', label: '開始', system: 's', user: 'u' }] }));
  await deps.db.send(
    new UpdateCommand({
      TableName: deps.table, Key: { PK: 'CH#kamakura-history', SK: `SUB#${sid}` },
      UpdateExpression: 'SET #s = :s, version = :v, sha256 = :h, #size = :z, iconSha256 = :i, validation = :val, samplesKey = :k, submittedAt = :t, GSI2PK = :q, GSI2SK = :o, rev = :r REMOVE #ttl',
      ExpressionAttributeNames: { '#s': 'state', '#size': 'size', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':s': 'awaiting_review', ':v': version, ':h': sha256Hex(zip), ':z': zip.length, ':i': 'cd'.repeat(32), ':val': { ok: true, errors: [] },
        ':k': `samples/${sid}/prompts.json`, ':t': new Date(clock).toISOString(), ':q': 'QUEUE#REVIEW', ':o': `${new Date(clock).toISOString()}#kamakura-history`, ':r': 2,
      },
    }),
  );
  return sid;
}

const base = (sid: string) => `/api/admin/channels/kamakura-history/submissions/${sid}`;

describe('the review queue', () => {
  it('lists submissions waiting for or in review to operators only', async () => {
    const sid = await awaitingReview();
    expect((await call(alice, 'GET', '/api/admin/review-queue')).body.code).toBe('forbidden');
    const queue = await call(operator, 'GET', '/api/admin/review-queue');
    expect(queue.body.items.map((s: { submissionId: string; state: string }) => [s.submissionId, s.state])).toEqual([[sid, 'awaiting_review']]);
    const pkg = await call(operator, 'GET', `${base(sid)}/package`);
    expect(pkg.body.packageUrl).toBe(`https://intake.example/intake/kamakura-history/${sid}.zip?signed`);
    expect((await call(operator, 'GET', `${base(sid)}/sample-prompts`)).body.scenarios[0].id).toBe('start-morning-sunny');
  });

  it('takes and puts back a review with If-Match', async () => {
    const sid = await awaitingReview();
    expect((await call(operator, 'POST', `${base(sid)}/start`)).status).toBe(428);
    const started = await call(operator, 'POST', `${base(sid)}/start`, { ifMatch: 2 });
    expect(started.body).toMatchObject({ state: 'in_review', rev: 3 });
    expect((await call(operator, 'POST', `${base(sid)}/start`, { ifMatch: 3 })).body.code).toBe('invalid_state');
    expect((await call(operator, 'POST', `${base(sid)}/release`, { ifMatch: 3 })).body.state).toBe('awaiting_review');
    // Still in the queue throughout.
    expect((await call(operator, 'GET', '/api/admin/review-queue')).body.items).toHaveLength(1);
  });
});

describe('samples', () => {
  it('keeps the AI’s replies, not the key, and shows them with the decision', async () => {
    const sid = await awaitingReview();
    const saved = await call(operator, 'POST', `${base(sid)}/samples`, { body: { service: 'openai', model: 'gpt-x', items: [{ scenarioId: 'start-morning-sunny', output: 'おはようございます。' }] } });
    expect(saved.status).toBe(201);
    expect(JSON.parse(records.get(`reviews/${sid}/${saved.body.samplesId}.json`)!)).toMatchObject({ service: 'openai', items: [{ output: 'おはようございます。' }] });
    expect((await call(operator, 'POST', `${base(sid)}/samples`, { body: { service: 'openai', model: 'm', items: [] } })).body.code).toBe('invalid_request');

    await call(operator, 'POST', `${base(sid)}/start`, { ifMatch: 2 });
    await call(operator, 'POST', `${base(sid)}/approve`, { body: { samplesIds: [saved.body.samplesId] }, ifMatch: 3 });
    const reviews = await call(operator, 'GET', `${base(sid)}/reviews`);
    expect(reviews.body.items.map((r: { action: string }) => r.action)).toEqual(['start', 'approve']);
    expect(reviews.body.items[1].samples[0].items[0].output).toBe('おはようございます。');
  });
});

describe('deciding', () => {
  it('approves: lists the channel, supersedes the previous version and publishes', async () => {
    const first = await awaitingReview(1);
    await call(operator, 'POST', `${base(first)}/start`, { ifMatch: 2 });
    const approved = await call(operator, 'POST', `${base(first)}/approve`, { body: { message: '問題ありません' }, ifMatch: 3 });
    expect(approved.body).toMatchObject({ publication: 'pending', submission: { state: 'approved', decision: { action: 'approve', message: '問題ありません' } } });
    expect(published).toEqual(['approve']);
    expect(archived).toContain(`intake/kamakura-history/${first}.zip`);
    const channel = await call(alice, 'GET', '/api/channels/kamakura-history');
    expect(channel.body).toMatchObject({
      listed: true, pendingSubmissionId: null,
      latestApproved: { version: 1, name: '鎌倉歴史散歩', summary: '寺社と武士の歴史', lang: ['ja'], description: '鎌倉の寺社', tags: ['history'], minAppVersion: 1 },
    });
    expect((await call(operator, 'GET', '/api/admin/review-queue')).body.items).toEqual([]);

    const second = await awaitingReview(2);
    await call(operator, 'POST', `${base(second)}/start`, { ifMatch: 2 });
    await call(operator, 'POST', `${base(second)}/approve`, { body: {}, ifMatch: 3 });
    const subs = await call(alice, 'GET', '/api/channels/kamakura-history/submissions');
    expect(subs.body.items.map((s: { state: string }) => s.state)).toEqual(['approved', 'superseded']);
  });

  it('refuses to approve an older version, or a package that changed after the machine review', async () => {
    const first = await awaitingReview(2);
    await call(operator, 'POST', `${base(first)}/start`, { ifMatch: 2 });
    await call(operator, 'POST', `${base(first)}/approve`, { body: {}, ifMatch: 3 });
    const older = await awaitingReview(1);
    await call(operator, 'POST', `${base(older)}/start`, { ifMatch: 2 });
    expect((await call(operator, 'POST', `${base(older)}/approve`, { body: {}, ifMatch: 3 })).body.code).toBe('version_not_newer');

    // The refused one still holds the channel; return it before the next submission.
    await call(operator, 'POST', `${base(older)}/return`, { body: { findings: [{ item: '1', detail: '版を上げてください' }] }, ifMatch: 3 });

    const changed = await awaitingReview(3);
    uploads.set(`intake/kamakura-history/${changed}.zip`, utf8.encode('swapped'));
    await call(operator, 'POST', `${base(changed)}/start`, { ifMatch: 2 });
    expect((await call(operator, 'POST', `${base(changed)}/approve`, { body: {}, ifMatch: 3 })).body.code).toBe('invalid_state');
  });

  it('returns and rejects with the review policy’s item numbers, freeing the channel', async () => {
    const sid = await awaitingReview();
    await call(operator, 'POST', `${base(sid)}/start`, { ifMatch: 2 });
    expect((await call(operator, 'POST', `${base(sid)}/return`, { body: { findings: [] }, ifMatch: 3 })).body.code).toBe('invalid_request');
    expect((await call(operator, 'POST', `${base(sid)}/return`, { body: { findings: [{ item: 'two', detail: 'x' }] }, ifMatch: 3 })).body.code).toBe('invalid_request');
    const returned = await call(operator, 'POST', `${base(sid)}/return`, { body: { findings: [{ item: '2.2', detail: '立入禁止の場所に誘っている' }], message: '直して出し直してください' }, ifMatch: 3 });
    expect(returned.body.submission).toMatchObject({ state: 'returned', decision: { action: 'return', findings: [{ item: '2.2' }] } });
    // The publisher sees why, and can submit again.
    const mine = await call(alice, 'GET', `/api/channels/kamakura-history/submissions/${sid}`);
    expect(mine.body.decision.findings[0].detail).toBe('立入禁止の場所に誘っている');
    expect((await call(alice, 'GET', '/api/channels/kamakura-history')).body.pendingSubmissionId).toBeNull();

    const next = await awaitingReview();
    await call(operator, 'POST', `${base(next)}/start`, { ifMatch: 2 });
    expect((await call(operator, 'POST', `${base(next)}/reject`, { body: { findings: [{ item: '2.4', detail: '宣伝が目的' }] }, ifMatch: 3 })).body.submission.state).toBe('rejected');
    expect(published).toEqual([]);
  });

  it('puts an approved channel into the list the publisher signs', async () => {
    const sid = await awaitingReview();
    await call(operator, 'POST', `${base(sid)}/start`, { ifMatch: 2 });
    await call(operator, 'POST', `${base(sid)}/approve`, { body: {}, ifMatch: 3 });
    const keyset = await signDocument(provider.keyset, provider.root);
    await deps.db.send(new UpdateCommand({ TableName: deps.table, Key: { PK: 'KEYSET', SK: 'HEAD' }, UpdateExpression: 'SET #d = :d, seq = :s', ExpressionAttributeNames: { '#d': 'document' }, ExpressionAttributeValues: { ':d': keyset, ':s': 1 } }));
    await deps.db.send(new UpdateCommand({ TableName: deps.table, Key: { PK: 'SIGNKEY', SK: 'KEY#k-test' }, UpdateExpression: 'SET #s = :a, keyId = :k, kmsKeyArn = :arn', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':a': 'active', ':k': 'k-test', ':arn': 'local' } }));

    const storage = new MemoryStorage();
    await publish({ store: new DynamoStore(deps.table, raw), storage, cdn: noCdn, signerFor: () => provider.signing, config: { rootPublicKey: provider.rootKey, name: 'Test' }, now: () => new Date(clock) }, 'approve');
    const discovery = verifyDiscovery(JSON.parse(utf8.decode(storage.public.get(DISCOVERY_PATH)!)));
    const list = verifyChannelList(JSON.parse(utf8.decode(storage.public.get(LIST_PATH)!)), discovery.keyset, { now: new Date(clock) }).body;
    expect(list.channels).toHaveLength(1);
    expect(list.channels[0]).toMatchObject({ id: 'kamakura-history', version: 1, publisherName: '鎌倉歴史散歩の会', name: '鎌倉歴史散歩' });
  });
});
