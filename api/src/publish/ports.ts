import type { ChannelEntry, Keyset, RevokedEntry, Signer, SignedDocument } from '@sanpo-console/protocol';

/** What started a publication (DM-001 PUBLICATION.trigger). */
export type Trigger = 'approve' | 'revoke' | 'transfer' | 'keyset' | 'daily' | 'manual';

export interface PublicationRecord {
  seq: number;
  issuedAt: string;
  expiresAt: string;
  sha256: string;
  size: number;
  keyId: string;
  archiveKey: string;
  trigger: Trigger;
  channelCount: number;
  revokedCount: number;
}

export interface SigningKeyRecord {
  keyId: string;
  kmsKeyArn: string;
  status: 'registered' | 'active' | 'retiring' | 'revoked';
}

/** Thrown when another publication took the next `seq` first (DM-001 M-11). */
export class SeqConflictError extends Error {
  constructor(expected: number | null) {
    super(`the publication head moved from seq ${String(expected)}`);
  }
}

/** The data the publisher reads and writes (DynamoDB in AWS, memory in tests and local runs). */
export interface PublicationStore {
  /** The latest publication's seq, or null before the first one. */
  headSeq(): Promise<number | null>;
  /** Every channel to list: the latest approved version of each active channel (DM-001 M-8, AP-10). */
  listedChannels(now: Date): Promise<ChannelEntry[]>;
  /** Revocations still to be listed (within [since, now]) (DM-001 M-9, AP-11). */
  revocations(since: Date): Promise<RevokedEntry[]>;
  /** Stops listing revocations older than [before]. */
  expireRevocations(before: Date): Promise<void>;
  /** The keyset the root key signed last (AP-15). */
  currentKeyset(): Promise<SignedDocument | null>;
  signingKey(keyId: string): Promise<SigningKeyRecord | null>;
  /** Records the publication if the head is still [previousSeq]; throws [SeqConflictError] otherwise. */
  recordPublication(previousSeq: number | null, record: PublicationRecord): Promise<void>;
}

/** Where the documents go: the public bucket behind CloudFront, and the private archive. */
export interface DocumentStorage {
  putPublic(path: string, body: Uint8Array, contentType: string, cacheControl: string): Promise<void>;
  putArchive(path: string, body: Uint8Array, contentType: string): Promise<void>;
}

export interface Cdn {
  invalidate(paths: string[]): Promise<void>;
}

export type SignerFor = (key: SigningKeyRecord) => Signer;

export type { Keyset };
