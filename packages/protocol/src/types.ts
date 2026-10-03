/** API-002: the signed document form (P-3). */
export interface SignedDocument {
  payload: string;
  keyId: string;
  sig: string;
}

/** API-002 P-8: the channel list is a body plus a signed digest of it. */
export interface ChannelListDocument {
  payload: string;
  digest: SignedDocument;
}

export interface Keyset {
  type: 'keyset';
  provider: string;
  seq: number;
  issuedAt: string;
  keys: SigningKeyEntry[];
  revokedKeys: string[];
}

export interface SigningKeyEntry {
  keyId: string;
  publicKey: string;
  notBefore: string;
  notAfter: string;
}

export interface Discovery {
  provider: string;
  name: string;
  versions: string[];
  list: string;
  rootKey: string;
  keyset: SignedDocument;
  reviewPolicyUrl?: string;
  termsUrl?: string;
  contact?: string;
}

export interface ChannelEntry {
  id: string;
  version: number;
  publisher: string;
  publisherName: string;
  publisherChange?: { from: string; at: string; reason: string };
  name: string;
  summary: string;
  description?: string;
  lang: string[];
  tags?: string[];
  regions?: string[];
  icon: { url: string; sha256: string };
  package: { url: string; sha256: string; size: number; format: number };
  minAppVersion: number;
  approvedAt: string;
}

export interface RevokedEntry {
  id: string;
  versions?: number[];
  reason: string;
  revokedAt: string;
}

export interface ChannelList {
  type: 'channel-list';
  format: 1;
  provider: string;
  seq: number;
  issuedAt: string;
  expiresAt: string;
  channels: ChannelEntry[];
  revoked: RevokedEntry[];
}

export interface ChannelListDigest {
  type: 'channel-list-digest';
  provider: string;
  seq: number;
  issuedAt: string;
  expiresAt: string;
  sha256: string;
  size: number;
}
