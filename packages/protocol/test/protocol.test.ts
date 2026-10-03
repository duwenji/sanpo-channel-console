import { describe, expect, it } from 'vitest';
import {
  ProtocolError,
  accountId,
  b64url,
  base32,
  payloadBytes,
  providerId,
  signChannelList,
  signDocument,
  utf8,
  verifyChannelList,
  verifyDiscovery,
  type ChannelListDocument,
} from '../src/index.js';
import { makeTestProvider, sampleChannel } from '../src/testing.js';

const now = new Date('2026-10-03T03:00:00.000Z');
const days = (n: number) => new Date(now.getTime() + n * 24 * 3600_000);

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ProtocolError) return e.code;
    throw e;
  }
  return 'ok';
}

async function signedList(p: Awaited<ReturnType<typeof makeTestProvider>>, overrides: { seq?: number; expiresAt?: Date } = {}) {
  return signChannelList(
    {
      provider: p.provider,
      seq: overrides.seq ?? 128,
      issuedAt: now,
      expiresAt: overrides.expiresAt ?? days(7),
      channels: [sampleChannel()],
      revoked: [],
    },
    p.signing,
  );
}

describe('encoding and ids', () => {
  it('uses lowercase base32 without padding (RFC 4648 test vectors)', () => {
    expect(base32(utf8.encode('foobar'))).toBe('mzxw6ytboi');
    expect(base32(utf8.encode('f'))).toBe('my');
  });

  it('derives provider and account ids as key fingerprints', () => {
    const key = new Uint8Array(32).fill(7);
    expect(providerId(key)).toMatch(/^sc1[a-z2-7]{32}$/);
    expect(accountId(key)).toMatch(/^sg1[a-z2-7]{32}$/);
    expect(providerId(key).slice(3)).toBe(accountId(key).slice(3));
  });

  it('rejects loose base64url', () => {
    expect(() => b64url.decode('ab+c')).toThrow();
  });
});

describe('discovery and keyset (V-01, V-02)', () => {
  it('accepts a correctly signed provider', async () => {
    const p = await makeTestProvider({ now });
    const v = verifyDiscovery(p.discovery, { expectedProvider: p.provider });
    expect(v.keyset.keys[0]?.keyId).toBe('k-test');
  });

  it('rejects a root key that is not the registered provider', async () => {
    const p = await makeTestProvider({ now });
    const other = await makeTestProvider({ now });
    expect(code(() => verifyDiscovery(p.discovery, { expectedProvider: other.provider }))).toBe('provider_mismatch');
    expect(code(() => verifyDiscovery({ ...p.discovery, rootKey: other.discovery.rootKey }))).toBe('provider_mismatch');
  });

  it('rejects a keyset not signed by the root key', async () => {
    const p = await makeTestProvider({ now });
    const forged = await signDocument(p.keyset, { keyId: p.provider, sign: p.signing.sign });
    expect(code(() => verifyDiscovery({ ...p.discovery, keyset: forged }))).toBe('bad_signature');
  });

  it('rejects signing keys valid for more than a year', async () => {
    const p = await makeTestProvider({ now });
    const keyset = { ...p.keyset, keys: [{ ...p.keyset.keys[0]!, notAfter: days(400).toISOString() }] };
    const signed = await signDocument(keyset, p.root);
    expect(code(() => verifyDiscovery({ ...p.discovery, keyset: signed }))).toBe('bad_document');
  });

  it('rejects an unknown version', async () => {
    const p = await makeTestProvider({ now });
    expect(code(() => verifyDiscovery({ ...p.discovery, versions: ['v2'] }))).toBe('unsupported_version');
  });
});

describe('channel list (V-03, V-04, P-6, P-8)', () => {
  it('accepts a list whose body matches its signed digest', async () => {
    const p = await makeTestProvider({ now });
    const { document } = await signedList(p);
    const v = verifyChannelList(document, p.keyset, { now });
    expect(v.body.channels[0]?.id).toBe('kamakura-history');
    expect(v.digestPayloadBytes).toBeLessThan(4096);
  });

  it('rejects a body swapped after signing', async () => {
    const p = await makeTestProvider({ now });
    const { document } = await signedList(p);
    const other = await signChannelList(
      { provider: p.provider, seq: 128, issuedAt: now, expiresAt: days(7), channels: [], revoked: [] },
      p.signing,
    );
    const swapped: ChannelListDocument = { payload: other.document.payload, digest: document.digest };
    expect(code(() => verifyChannelList(swapped, p.keyset, { now }))).toBe('bad_signature');
  });

  it('rejects a digest whose fields differ from the body', async () => {
    const p = await makeTestProvider({ now });
    const { document, digest } = await signedList(p);
    const lying = await signDocument({ ...digest, seq: 999 }, p.signing);
    expect(code(() => verifyChannelList({ ...document, digest: lying }, p.keyset, { now }))).toBe('bad_signature');
  });

  it('rejects another kind of document passed off as a digest', async () => {
    const p = await makeTestProvider({ now });
    const { document } = await signedList(p);
    const ticket = await signDocument({ type: 'test-ticket' }, p.signing);
    expect(code(() => verifyChannelList({ ...document, digest: ticket }, p.keyset, { now }))).toBe('bad_signature');
  });

  it('rejects unknown, revoked and expired signing keys', async () => {
    const p = await makeTestProvider({ now });
    const { document } = await signedList(p);
    expect(code(() => verifyChannelList(document, { ...p.keyset, keys: [] }, { now }))).toBe('unknown_key');
    expect(code(() => verifyChannelList(document, { ...p.keyset, revokedKeys: ['k-test'] }, { now }))).toBe('key_not_valid');
    const past = { ...p.keyset, keys: [{ ...p.keyset.keys[0]!, notAfter: days(-1).toISOString() }] };
    expect(code(() => verifyChannelList(document, past, { now }))).toBe('key_not_valid');
  });

  it('rejects expired lists and rollbacks', async () => {
    const p = await makeTestProvider({ now });
    const { document } = await signedList(p);
    expect(code(() => verifyChannelList(document, p.keyset, { now: days(8) }))).toBe('expired');
    expect(code(() => verifyChannelList(document, p.keyset, { now, minSeq: 129 }))).toBe('rollback');
    expect(code(() => verifyChannelList(document, p.keyset, { now, minSeq: 128 }))).toBe('ok');
  });

  it('refuses to sign a list that would live more than 14 days', async () => {
    const p = await makeTestProvider({ now });
    await expect(signedList(p, { expiresAt: days(15) })).rejects.toThrow('14 days');
  });

  it('signs the exact JSON bytes it publishes', async () => {
    const p = await makeTestProvider({ now });
    const { document, body } = await signedList(p);
    expect(b64url.decode(document.payload)).toEqual(payloadBytes(body));
  });
});
