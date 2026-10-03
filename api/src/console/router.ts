import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { Deps } from './deps.js';
import { ApiError, fail, json, problem, type Caller, type Request, type Response } from './http.js';
import * as op from './operator.js';
import * as pub from './publisher.js';

type Handler = (deps: Deps, req: Request) => Promise<Response>;

/** The logged-in user, their roles, and their publisher if they have one (API-001 `/api/me`). */
async function me(deps: Deps, req: Request): Promise<Response> {
  const user = (await deps.db.send(new GetCommand({ TableName: deps.table, Key: { PK: `USER#${req.caller.sub}`, SK: 'USER' } }))).Item;
  let publisher = null;
  if (user?.publisherId) {
    const pub = (await deps.db.send(new GetCommand({ TableName: deps.table, Key: { PK: `PUB#${String(user.publisherId)}`, SK: 'PUB' } }))).Item;
    if (pub) publisher = { publisherId: pub.publisherId, displayName: pub.displayName, status: pub.status, rev: pub.rev };
  }
  return json(200, { sub: req.caller.sub, roles: req.caller.roles, publisher });
}

/** Routes implemented so far; review, test tickets and key transfers come with stages 3b–3d. */
const ROUTES: [string, string, Handler][] = [
  ['GET', '/api/me', me],
  // The publisher (implementation stage 3a).
  ['POST', '/api/publisher', pub.registerPublisher],
  ['GET', '/api/publisher', pub.getMyPublisher],
  ['PATCH', '/api/publisher', pub.updateMyPublisher],
  ['DELETE', '/api/publisher', pub.deleteMyPublisher],
  ['POST', '/api/publisher/keys/challenge', pub.createKeyChallenge],
  ['POST', '/api/publisher/keys', pub.bindFirstKey],
  ['GET', '/api/publisher/keys', pub.listMyKeys],
  ['POST', '/api/channels', pub.registerChannel],
  ['GET', '/api/channels', pub.listMyChannels],
  ['GET', '/api/channels/{channelId}', pub.getChannel],
  ['POST', '/api/channels/{channelId}/submissions', pub.createSubmission],
  ['GET', '/api/channels/{channelId}/submissions', pub.listSubmissions],
  ['GET', '/api/channels/{channelId}/submissions/{submissionId}', pub.getSubmission],
  ['POST', '/api/channels/{channelId}/submissions/{submissionId}/withdraw', pub.withdrawSubmission],
  // The operator.
  ['POST', '/api/admin/channels/{channelId}/revoke', op.revokeChannel],
  ['GET', '/api/admin/publishers', op.listPublishers],
  ['GET', '/api/admin/publishers/{publisherId}', op.getPublisher],
  ['GET', '/api/admin/publishers/{publisherId}/channels', op.listPublisherChannels],
  ['POST', '/api/admin/publishers/{publisherId}/suspend', op.setPublisherSuspended(true)],
  ['POST', '/api/admin/publishers/{publisherId}/resume', op.setPublisherSuspended(false)],
  ['PUT', '/api/admin/publishers/{publisherId}/limits', op.setPublisherLimits],
  ['GET', '/api/admin/signing-keys', op.listSigningKeys],
  ['POST', '/api/admin/signing-keys', op.registerSigningKey],
  ['GET', '/api/admin/keysets', op.listKeysets],
  ['POST', '/api/admin/keysets', op.registerKeyset],
  ['GET', '/api/admin/publications', op.listPublications],
  ['POST', '/api/admin/publications', op.republish],
  ['GET', '/api/admin/audit', op.listAudit],
];

const PARAM: Record<string, RegExp> = {
  channelId: /^[a-z0-9-]{3,40}$/,
  publisherId: /^[0-9A-HJKMNP-TV-Z]{26}$/,
  submissionId: /^[0-9A-HJKMNP-TV-Z]{26}$/,
};

function match(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    const g = decodeURIComponent(got[i]!);
    if (w.startsWith('{')) {
      const name = w.slice(1, -1);
      // A malformed id can't name anything: 404 rather than a lookup with it.
      if (PARAM[name] && !PARAM[name].test(g)) return null;
      params[name] = g;
    } else if (w !== g) {
      return null;
    }
  }
  return params;
}

export async function route(deps: Deps, input: Omit<Request, 'params'>): Promise<Response> {
  try {
    for (const [method, pattern, handler] of ROUTES) {
      const params = match(pattern, input.path);
      if (params && method === input.method) return await handler(deps, { ...input, params });
    }
    return fail('not_found', `${input.method} ${input.path}`);
  } catch (e) {
    if (e instanceof ApiError) return problem(e, input.requestId);
    console.error(JSON.stringify({ requestId: input.requestId, error: e instanceof Error ? e.stack : String(e) }));
    return problem(new ApiError('internal', 'internal error'), input.requestId);
  }
}

/** Roles from the `cognito:groups` claim, which an HTTP API passes as `[a b]` text or an array. */
export function callerFrom(claims: Record<string, unknown>): Caller {
  const raw = claims['cognito:groups'];
  const groups = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean) : [];
  return {
    sub: String(claims.sub ?? fail('unauthorized', 'no subject')),
    roles: groups.filter((g): g is 'operator' | 'publisher' => g === 'operator' || g === 'publisher'),
  };
}
