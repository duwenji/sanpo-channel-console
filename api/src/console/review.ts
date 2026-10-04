import { QueryCommand, type TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Schemas } from '@sanpo-console/api-types';
import { sha256Hex, utf8 } from '@sanpo-console/protocol';
import { unzipSync } from 'fflate';
import { auditItem, type Deps } from './deps.js';
import { fail, ifMatch, json, object, requireOperator, text, withEtag, type Request, type Response } from './http.js';
import { loadSubmission, submissionView, transact } from './publisher.js';
import { loadChannel, page, type Item } from './shared.js';
import { ulid } from './util.js';

type TransactItems = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>;

/** The app version a package needs; one stage for now (DES-005; resources and cues aren't accepted yet). */
const MIN_APP_VERSION = 1;
const MAX_SAMPLES = 1024 * 1024;
const FINDING_ITEM = /^[0-9]+(\.[0-9]+)*$/;

/** Where an upload is now: under intake/ while pending, archive/ once settled (DM-001 M-4). */
function uploadKey(sub: Item, key: 'intakeKey' | 'iconIntakeKey'): string {
  const intake = String(sub[key]);
  return ['awaiting_review', 'in_review', 'uploading', 'validating'].includes(String(sub.state)) ? intake : intake.replace(/^intake\//, 'archive/');
}

// ---- reading ----

/** Submissions waiting for or in review, oldest first (DM-001 AP-09). */
export async function listReviewQueue(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const { items, nextCursor } = await page(deps, req, {
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :q',
    ExpressionAttributeValues: { ':q': 'QUEUE#REVIEW' },
    ScanIndexForward: true,
  });
  return json(200, { items: items.map(submissionView), nextCursor });
}

export async function getSubmissionPackage(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const sub = await loadSubmission(deps, req.params.channelId!, req.params.submissionId!);
  const [packageUrl, iconUrl] = await Promise.all([deps.presignDownload(uploadKey(sub, 'intakeKey')), deps.presignDownload(uploadKey(sub, 'iconIntakeKey'))]);
  return json(200, { packageUrl, iconUrl, expiresAt: new Date(deps.now().getTime() + 5 * 60_000).toISOString() });
}

/** The prompts the machine review rendered for the review samples (API-001 C-1). */
export async function getSamplePrompts(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const sub = await loadSubmission(deps, req.params.channelId!, req.params.submissionId!);
  const body = sub.samplesKey ? await deps.readRecord(String(sub.samplesKey)) : undefined;
  if (!body) return fail('not_found', 'no sample prompts: the submission did not pass the machine review');
  return json(200, JSON.parse(body));
}

/** Keeps the AI's replies (never the operator's API key, API-001 C-13) for the review record. */
export async function saveSamples(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const sub = await loadSubmission(deps, req.params.channelId!, req.params.submissionId!);
  const body = object(req.body);
  const service = text(body, 'service', { max: 40 })!;
  const model = text(body, 'model', { max: 100 })!;
  const items = body.items;
  if (!Array.isArray(items) || items.length === 0 || !items.every((i) => typeof i === 'object' && i && typeof i.scenarioId === 'string' && typeof i.output === 'string' && i.output.length <= 20000)) {
    return fail('invalid_request', 'items must be { scenarioId, output } with outputs up to 20,000 characters');
  }
  const samplesId = ulid(deps.now().getTime());
  const record = JSON.stringify({ samplesId, service, model, items, savedBy: req.caller.sub, savedAt: deps.now().toISOString() });
  if (record.length > MAX_SAMPLES) fail('payload_too_large', 'samples over 1MB');
  await deps.writeRecord(`reviews/${String(sub.submissionId)}/${samplesId}.json`, record);
  return json(201, { samplesId });
}

export async function listReviews(deps: Deps, req: Request): Promise<Response> {
  requireOperator(req);
  const { channelId, submissionId } = req.params as { channelId: string; submissionId: string };
  await loadSubmission(deps, channelId, submissionId);
  const out = await deps.db.send(
    new QueryCommand({
      TableName: deps.table,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :r)',
      ExpressionAttributeValues: { ':pk': `CH#${channelId}`, ':r': `SUB#${submissionId}#REVIEW#` },
    }),
  );
  const items = await Promise.all(
    (out.Items ?? []).map(async (r) => ({
      reviewerSub: String(r.reviewerSub),
      action: r.action as Schemas['Review']['action'],
      ...(r.findings ? { findings: r.findings as Schemas['Finding'][] } : {}),
      ...(r.message ? { message: String(r.message) } : {}),
      samples: await Promise.all(
        ((r.samplesIds as string[] | undefined) ?? []).map(async (id) => {
          const saved = await deps.readRecord(`reviews/${submissionId}/${id}.json`);
          return saved ? (JSON.parse(saved) as { samplesId: string; service: string; model: string; items: unknown[] }) : { samplesId: id, service: '?', model: '?', items: [] };
        }),
      ),
      at: String(r.at),
    })),
  );
  return json(200, { items });
}

// ---- deciding ----

function reviewItem(deps: Deps, req: Request, sub: Item, at: string, entry: { action: string; findings?: unknown[]; message?: string; samplesIds?: string[] }) {
  return {
    Put: {
      TableName: deps.table,
      Item: {
        PK: `CH#${String(sub.channelId)}`, SK: `SUB#${String(sub.submissionId)}#REVIEW#${at}`, type: 'review', submissionId: sub.submissionId,
        reviewerSub: req.caller.sub, at, action: entry.action,
        ...(entry.findings?.length ? { findings: entry.findings } : {}), ...(entry.message ? { message: entry.message } : {}),
        ...(entry.samplesIds?.length ? { samplesIds: entry.samplesIds } : {}),
      },
    },
  };
}

async function loadForDecision(deps: Deps, req: Request, from: string) {
  requireOperator(req);
  const rev = ifMatch(req);
  const sub = await loadSubmission(deps, req.params.channelId!, req.params.submissionId!);
  if (sub.rev !== rev) fail('precondition_failed', `the submission is at rev ${String(sub.rev)}`);
  if (sub.state !== from) fail('invalid_state', `the submission is ${String(sub.state)}`);
  return { sub, rev };
}

/** Moves a submission between `awaiting_review` and `in_review` (an operator takes or puts back a review). */
function move(from: 'awaiting_review' | 'in_review', to: 'awaiting_review' | 'in_review', action: 'start' | 'release') {
  return async (deps: Deps, req: Request): Promise<Response> => {
    const { sub, rev } = await loadForDecision(deps, req, from);
    const at = deps.now().toISOString();
    await transact(
      deps,
      [
        {
          Update: {
            TableName: deps.table, Key: { PK: `CH#${String(sub.channelId)}`, SK: `SUB#${String(sub.submissionId)}` },
            UpdateExpression: 'SET #s = :to, updatedAt = :now, rev = rev + :one', ConditionExpression: 'rev = :rev AND #s = :from',
            ExpressionAttributeNames: { '#s': 'state' }, ExpressionAttributeValues: { ':to': to, ':from': from, ':now': at, ':one': 1, ':rev': rev },
          },
        },
        reviewItem(deps, req, sub, at, { action }),
        auditItem(deps, req.caller, { action: `submission.${action}`, target: `CH#${String(sub.channelId)}`, detail: { submissionId: sub.submissionId } }),
      ],
      { 0: ['precondition_failed', 'changed by someone else; read it again'] },
    );
    return withEtag(200, submissionView(await loadSubmission(deps, String(sub.channelId), String(sub.submissionId))));
  };
}

export const startReview = move('awaiting_review', 'in_review', 'start');
export const releaseReview = move('in_review', 'awaiting_review', 'release');

function samplesIdsOf(body: Record<string, unknown>): string[] | undefined {
  const ids = body.samplesIds;
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids) || !ids.every((i) => typeof i === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(i))) return fail('invalid_request', 'samplesIds must be the ids of saved samples');
  return ids as string[];
}

function findingsOf(body: Record<string, unknown>): Schemas['Finding'][] {
  const findings = body.findings;
  if (!Array.isArray(findings) || findings.length === 0) return fail('invalid_request', 'give at least one finding with the review policy item', [{ path: '/findings', message: 'at least one' }]);
  return findings.map((f, i) => {
    if (typeof f !== 'object' || !f || typeof f.item !== 'string' || !FINDING_ITEM.test(f.item) || typeof f.detail !== 'string' || f.detail.length === 0 || f.detail.length > 2000) {
      return fail('invalid_request', `findings[${i}] needs an item like 2.2 and a detail`, [{ path: `/findings/${i}`, message: 'item and detail' }]);
    }
    return { item: f.item as string, detail: f.detail as string };
  });
}

/**
 * Approves a submission (API-001): the package and icon go public, the channel is listed with this
 * version, the previous approved version is superseded, and the list is published again. The
 * package is read back and checked against the SHA-256 the machine review recorded.
 */
export async function approveSubmission(deps: Deps, req: Request): Promise<Response> {
  const { sub, rev } = await loadForDecision(deps, req, 'in_review');
  const body = object(req.body ?? {});
  const message = text(body, 'message', { max: 2000, optional: true, min: 0 });
  const samplesIds = samplesIdsOf(body);
  const channelId = String(sub.channelId);
  const channel = await loadChannel(deps, channelId);
  const previous = channel.latestApproved as { submissionId?: string; version?: number } | undefined;
  if (previous?.version !== undefined && Number(sub.version) <= previous.version) fail('version_not_newer', `version ${String(sub.version)} is not after the approved ${previous.version}`);

  const zip = await deps.readUpload(String(sub.intakeKey));
  if (sha256Hex(zip) !== sub.sha256) fail('invalid_state', 'the uploaded package differs from what the machine review checked');
  const manifest = JSON.parse(utf8.decode(unzipSync(zip, { filter: (f) => f.name === 'channel.json' })['channel.json']!)) as { name: string; summary: string; lang: string };
  const { packageUrl, iconUrl } = await deps.publishApproved({
    packageKey: String(sub.intakeKey), packageSha256: String(sub.sha256), iconKey: String(sub.iconIntakeKey), iconSha256: String(sub.iconSha256),
  });

  const at = deps.now().toISOString();
  const latestApproved = {
    submissionId: String(sub.submissionId), version: Number(sub.version), publisher: String(sub.accountId),
    name: manifest.name, summary: manifest.summary, lang: [manifest.lang],
    ...(sub.description ? { description: String(sub.description) } : {}),
    ...(sub.tags ? { tags: sub.tags } : {}), ...(sub.regions ? { regions: sub.regions } : {}),
    icon: { url: iconUrl, sha256: String(sub.iconSha256) },
    package: { url: packageUrl, sha256: String(sub.sha256), size: Number(sub.size), format: 1 },
    minAppVersion: MIN_APP_VERSION, approvedAt: at,
  };
  const decision = { action: 'approve', at, ...(message ? { message } : {}) };
  const items: TransactItems = [
    {
      Update: {
        TableName: deps.table, Key: { PK: `CH#${channelId}`, SK: `SUB#${String(sub.submissionId)}` },
        UpdateExpression: 'SET #s = :approved, decision = :d, decidedAt = :now, updatedAt = :now, rev = rev + :one REMOVE GSI2PK, GSI2SK',
        ConditionExpression: 'rev = :rev AND #s = :review', ExpressionAttributeNames: { '#s': 'state' },
        ExpressionAttributeValues: { ':approved': 'approved', ':review': 'in_review', ':d': decision, ':now': at, ':one': 1, ':rev': rev },
      },
    },
    {
      Update: {
        TableName: deps.table, Key: { PK: `CH#${channelId}`, SK: 'CH' },
        UpdateExpression: 'SET latestApproved = :la, #s = :active, GSI2PK = :listed, GSI2SK = :order, updatedAt = :now, rev = rev + :one REMOVE pendingSubmissionId',
        ConditionExpression: 'pendingSubmissionId = :sid', ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':la': latestApproved, ':active': 'active', ':listed': 'LISTED', ':order': `CH#${channelId}`, ':now': at, ':one': 1, ':sid': sub.submissionId },
      },
    },
    reviewItem(deps, req, sub, at, { action: 'approve', ...(message ? { message } : {}), ...(samplesIds ? { samplesIds } : {}) }),
    auditItem(deps, req.caller, { action: 'submission.approve', target: `CH#${channelId}`, detail: { submissionId: sub.submissionId, version: sub.version } }),
  ];
  if (previous?.submissionId && previous.submissionId !== sub.submissionId) {
    items.push({
      Update: {
        TableName: deps.table, Key: { PK: `CH#${channelId}`, SK: `SUB#${previous.submissionId}` },
        UpdateExpression: 'SET #s = :superseded, updatedAt = :now, rev = rev + :one', ConditionExpression: '#s = :approved',
        ExpressionAttributeNames: { '#s': 'state' }, ExpressionAttributeValues: { ':superseded': 'superseded', ':approved': 'approved', ':now': at, ':one': 1 },
      },
    });
  }
  await transact(deps, items, { 0: ['precondition_failed', 'changed by someone else; read it again'] });
  await deps.requestPublish('approve');
  await Promise.all([deps.archiveUpload(String(sub.intakeKey)), deps.archiveUpload(String(sub.iconIntakeKey))]).catch(() => undefined);
  const updated = submissionView(await loadSubmission(deps, channelId, String(sub.submissionId)));
  return json(200, { submission: updated, publication: 'pending' }, { etag: `"${updated.rev}"` });
}

/** Returns (can be fixed) or rejects (can't) a submission, with the review policy's item numbers (審査基準 3). */
function decline(action: 'return' | 'reject') {
  return async (deps: Deps, req: Request): Promise<Response> => {
    const { sub, rev } = await loadForDecision(deps, req, 'in_review');
    const body = object(req.body);
    const findings = findingsOf(body);
    const message = text(body, 'message', { max: 2000, optional: true, min: 0 });
    const samplesIds = samplesIdsOf(body);
    const channelId = String(sub.channelId);
    const at = deps.now().toISOString();
    const state = action === 'return' ? 'returned' : 'rejected';
    await transact(
      deps,
      [
        {
          Update: {
            TableName: deps.table, Key: { PK: `CH#${channelId}`, SK: `SUB#${String(sub.submissionId)}` },
            UpdateExpression: 'SET #s = :to, decision = :d, decidedAt = :now, updatedAt = :now, rev = rev + :one REMOVE GSI2PK, GSI2SK',
            ConditionExpression: 'rev = :rev AND #s = :review', ExpressionAttributeNames: { '#s': 'state' },
            ExpressionAttributeValues: { ':to': state, ':review': 'in_review', ':d': { action, findings, at, ...(message ? { message } : {}) }, ':now': at, ':one': 1, ':rev': rev },
          },
        },
        {
          Update: {
            TableName: deps.table, Key: { PK: `CH#${channelId}`, SK: 'CH' },
            UpdateExpression: 'SET updatedAt = :now, rev = rev + :one REMOVE pendingSubmissionId', ConditionExpression: 'pendingSubmissionId = :sid',
            ExpressionAttributeValues: { ':now': at, ':one': 1, ':sid': sub.submissionId },
          },
        },
        reviewItem(deps, req, sub, at, { action, findings, ...(message ? { message } : {}), ...(samplesIds ? { samplesIds } : {}) }),
        auditItem(deps, req.caller, { action: `submission.${action}`, target: `CH#${channelId}`, detail: { submissionId: sub.submissionId, items: findings.map((f) => f.item) } }),
      ],
      { 0: ['precondition_failed', 'changed by someone else; read it again'] },
    );
    await Promise.all([deps.archiveUpload(String(sub.intakeKey)), deps.archiveUpload(String(sub.iconIntakeKey))]).catch(() => undefined);
    const updated = submissionView(await loadSubmission(deps, channelId, String(sub.submissionId)));
    return json(200, { submission: updated, publication: 'none' }, { etag: `"${updated.rev}"` });
  };
}

export const returnSubmission = decline('return');
export const rejectSubmission = decline('reject');
