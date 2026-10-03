import { b64url, generateEd25519, signDocument } from '@sanpo-console/protocol';
import { describe, expect, it } from 'vitest';
import { buildKeyset, generateRootKey, openRootKey, signKeyset, verifyKeyset } from '../src/root-key.js';

const passphrase = 'correct horse battery staple';
const now = new Date('2026-10-03T00:00:00.000Z');

function signingKey(keyId = 'k-2026-10', months = 6) {
  return {
    keyId,
    publicKey: b64url.encode(generateEd25519().publicKey),
    notBefore: '2026-10-01T00:00:00.000Z',
    notAfter: new Date(Date.parse('2026-10-01T00:00:00.000Z') + months * 30 * 24 * 3600_000).toISOString(),
  };
}

describe('root key', () => {
  it('is stored encrypted and opens only with its passphrase', () => {
    const key = generateRootKey(passphrase);
    expect(key.privatePem).toContain('ENCRYPTED PRIVATE KEY');
    expect(key.provider).toMatch(/^sc1[a-z2-7]{32}$/);
    expect(openRootKey(key.privatePem, passphrase).provider).toBe(key.provider);
    expect(() => openRootKey(key.privatePem, 'wrong passphrase, long enough')).toThrow();
  });

  it('refuses a short passphrase', () => {
    expect(() => generateRootKey('short')).toThrow('at least');
  });

  it('signs a keyset that verifies against the root public key', async () => {
    const key = generateRootKey(passphrase);
    const signed = await signKeyset({ seq: 3, keys: [signingKey()], revokedKeys: ['k-2026-04'] }, key.privatePem, passphrase, now);
    const keyset = verifyKeyset(signed, key.publicKey, key.provider);
    expect(keyset).toMatchObject({ provider: key.provider, seq: 3, revokedKeys: ['k-2026-04'] });
    expect(signed.keyId).toBe(key.provider);
  });

  it('does not accept a keyset signed by another key', async () => {
    const key = generateRootKey(passphrase);
    const other = openRootKey(generateRootKey(passphrase).privatePem, passphrase);
    const forged = await signDocument(buildKeyset({ seq: 1, keys: [signingKey()] }, key.provider, now), { ...other.signer, keyId: key.provider });
    expect(() => verifyKeyset(forged, key.publicKey)).toThrow('bad_signature');
  });

  it('checks the keyset before signing it', () => {
    const provider = generateRootKey(passphrase).provider;
    expect(() => buildKeyset({ seq: 0, keys: [signingKey()] }, provider, now)).toThrow('seq');
    expect(() => buildKeyset({ seq: 1, keys: [] }, provider, now)).toThrow('at least one key');
    expect(() => buildKeyset({ seq: 1, keys: [signingKey(), signingKey()] }, provider, now)).toThrow('twice');
    expect(() => buildKeyset({ seq: 1, keys: [signingKey('k-2026-10', 13)] }, provider, now)).toThrow('more than a year');
    expect(() => buildKeyset({ seq: 1, keys: [signingKey()], revokedKeys: ['k-2026-10'] }, provider, now)).toThrow('revoked');
    expect(() => buildKeyset({ seq: 1, keys: [{ ...signingKey(), publicKey: 'AAAA' }] }, provider, now)).toThrow('32-byte');
  });
});
