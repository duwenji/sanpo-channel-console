import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SignedDocument } from '@sanpo-console/protocol';
import type { Trigger } from '../publish/ports.js';
import { fail, type Caller } from './http.js';
import { ulid, type CursorCodec } from './util.js';

/** Everything the console API needs from outside; tests give DynamoDB Local and fakes. */
export interface Deps {
  db: DynamoDBDocumentClient;
  table: string;
  now: () => Date;
  cursors: CursorCodec;
  /** The provider's root public key (base64url), pinned in the configuration (ADR-001 A-9). */
  rootPublicKey: string;
  /** Reads a KMS key's public key (DER SubjectPublicKeyInfo) and key spec. */
  kmsPublicKey: (keyArn: string) => Promise<{ keySpec: string | undefined; publicKey: Uint8Array }>;
  /** Starts the publisher without waiting for it (ADR-001 A-10). */
  requestPublish: (trigger: Trigger) => Promise<void>;
  /** A presigned S3 POST into the intake bucket; S3 enforces the size (API-001 C-10). */
  presignUpload: (key: string, contentType: string, maxBytes: number) => Promise<{ url: string; fields: Record<string, string> }>;
  /** Moves an intake object under `archive/`, where it expires after 90 days (DM-001 M-4). */
  archiveUpload: (key: string) => Promise<void>;
  /** Deletes the Cognito user (API-001 C-4, leaving). */
  deleteUser: (sub: string) => Promise<void>;
  /** Copies a package from the intake bucket to the public `trial/{sha256}.zip` (7 days) and returns its URL (ADR-001 A-13). */
  publishTrial: (intakeKey: string, sha256: string) => Promise<string>;
  /** The public URL of an approved package. */
  packageUrl: (sha256: string) => string;
  /** Signs a document with the active signing key in KMS (ADR-001 A-8). */
  signDocument: (content: object) => Promise<SignedDocument>;
}

/** One entry of the audit log, written in the same transaction as the change (DM-001 AUDIT, DV-10). */
export function auditItem(
  deps: Deps,
  caller: Caller,
  entry: { action: string; target: string; reason?: string; detail?: Record<string, unknown> },
) {
  const at = deps.now().toISOString();
  const eventId = ulid(deps.now().getTime());
  const actorRole = caller.roles.includes('operator') ? 'operator' : caller.roles.includes('publisher') ? 'publisher' : 'system';
  return {
    Put: {
      TableName: deps.table,
      Item: {
        PK: `AUDIT#${at.slice(0, 7)}`,
        SK: `${at}#${eventId}`,
        GSI1PK: `TARGET#${entry.target}`,
        GSI1SK: at,
        type: 'audit',
        eventId,
        at,
        actorSub: caller.sub,
        actorRole,
        action: entry.action,
        target: entry.target,
        ...(entry.reason ? { reason: entry.reason } : {}),
        ...(entry.detail ? { detail: entry.detail } : {}),
      },
    },
  };
}

/** A conditional write lost to a concurrent one: the client should re-read (412). */
export async function guarded<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException || e instanceof TransactionCanceledException) {
      return fail('precondition_failed', 'changed by someone else; read it again');
    }
    throw e;
  }
}
