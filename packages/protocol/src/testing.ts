import { generateEd25519 } from './ed25519.js';
import { b64url, providerId } from './encoding.js';
import { localSigner, signDocument, type Signer } from './signed.js';
import type { ChannelEntry, Discovery, Keyset } from './types.js';

/** A provider with fresh keys, for tests and local runs. Never use these keys for a real provider. */
export interface TestProvider {
  provider: string;
  rootKey: Uint8Array;
  root: Signer;
  signing: Signer & { publicKey: Uint8Array };
  keyset: Keyset;
  discovery: Discovery;
}

export async function makeTestProvider(options: { now?: Date; keyId?: string; name?: string } = {}): Promise<TestProvider> {
  const now = options.now ?? new Date();
  const root = generateEd25519();
  const signingKey = generateEd25519();
  const provider = providerId(root.publicKey);
  const keyId = options.keyId ?? 'k-test';
  const keyset: Keyset = {
    type: 'keyset',
    provider,
    seq: 1,
    issuedAt: now.toISOString(),
    keys: [
      {
        keyId,
        publicKey: b64url.encode(signingKey.publicKey),
        notBefore: new Date(now.getTime() - 24 * 3600_000).toISOString(),
        notAfter: new Date(now.getTime() + 180 * 24 * 3600_000).toISOString(),
      },
    ],
    revokedKeys: [],
  };
  const rootSigner = localSigner(provider, root.privateKey);
  const discovery: Discovery = {
    provider,
    name: options.name ?? 'Test provider',
    versions: ['v1'],
    list: '/v1/channels.json',
    rootKey: b64url.encode(root.publicKey),
    keyset: await signDocument(keyset, rootSigner),
  };
  return {
    provider,
    rootKey: root.publicKey,
    root: rootSigner,
    signing: { ...localSigner(keyId, signingKey.privateKey), publicKey: signingKey.publicKey },
    keyset,
    discovery,
  };
}

export function sampleChannel(overrides: Partial<ChannelEntry> = {}): ChannelEntry {
  return {
    id: 'kamakura-history',
    version: 3,
    publisher: 'sg1' + 'a'.repeat(32),
    publisherName: '鎌倉歴史散歩の会',
    name: '鎌倉歴史散歩',
    summary: '鎌倉の寺社と武士の歴史を、語り部の口調で',
    lang: ['ja'],
    icon: { url: 'https://cdn.example.com/icons/x.png', sha256: '0'.repeat(64) },
    package: { url: 'https://cdn.example.com/pkg/x.zip', sha256: '0'.repeat(64), size: 1, format: 1 },
    minAppVersion: 1,
    approvedAt: '2026-10-02T09:00:00.000Z',
    ...overrides,
  };
}
