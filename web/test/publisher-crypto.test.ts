import { accountId, sha256Hex, utf8, verifyEd25519 } from '@sanpo-console/protocol';
import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { accountIdOf, b64url, createKey, openKeyFile, signPackage } from '../src/publisher-crypto';

const passphrase = 'kamakura-history-2026';

function unsignedPackage(publisher: string, change: Record<string, unknown> = {}) {
  const manifest = { format: 1, id: 'kamakura-history', version: 3, publisher, name: '鎌倉歴史散歩', ...change };
  return zipSync({
    'channel.json': utf8.encode(JSON.stringify(manifest)),
    'prompts/guide/focus.md': utf8.encode('- 由来と、関わった人物を中心に話す\n'),
    'prompts/': new Uint8Array(),
  });
}

describe('publisher keys in the browser', () => {
  it('derive the same account id as the server and station-format', async () => {
    expect(await accountIdOf(new Uint8Array(32).fill(7))).toBe('sg1joyg7dsohj3rluqb2vz5bkscg5rokxnl');
  });

  it('are saved encrypted and open only with the passphrase', async () => {
    const { key, file } = await createKey(passphrase);
    expect(file.accountId).toBe(accountId(key.publicKey));
    expect(JSON.stringify(file)).not.toContain('PRIVATE');
    const opened = await openKeyFile(JSON.stringify(file), passphrase);
    expect(opened.accountId).toBe(key.accountId);
    await expect(openKeyFile(JSON.stringify(file), 'wrong passphrase!')).rejects.toThrow('合言葉');
    await expect(openKeyFile('{"type":"other"}', passphrase)).rejects.toThrow('鍵のファイル');
    await expect(createKey('short')).rejects.toThrow('12');
  });

  it('refuse a key file whose public key was swapped', async () => {
    const a = await createKey(passphrase);
    const b = await createKey(passphrase);
    const swapped = { ...a.file, publicKey: b.file.publicKey };
    await expect(openKeyFile(JSON.stringify(swapped), passphrase)).rejects.toThrow('合っていません');
  });
});

describe('signing a package (API-003 F-6)', () => {
  it('writes a signature.json that verifies and covers every file', async () => {
    const { key } = await createKey(passphrase);
    const signed = await signPackage(unsignedPackage(key.accountId), key, { channel: 'kamakura-history' });
    const files = unzipSync(signed.zip);
    expect(Object.keys(files).sort()).toEqual(['channel.json', 'prompts/guide/focus.md', 'signature.json']);

    const signature = JSON.parse(utf8.decode(files['signature.json']!));
    const payloadBytes = b64url.decode(signature.payload);
    expect(verifyEd25519(b64url.decode(signature.publisherKey), payloadBytes, b64url.decode(signature.sig))).toBe(true);
    const payload = JSON.parse(utf8.decode(payloadBytes));
    expect(payload).toMatchObject({ type: 'channel-package', channel: 'kamakura-history', version: 3, publisher: key.accountId });
    expect(payload.files).toEqual({
      'channel.json': sha256Hex(files['channel.json']!),
      'prompts/guide/focus.md': sha256Hex(files['prompts/guide/focus.md']!),
    });
  });

  it('replaces an old signature instead of signing it', async () => {
    const { key } = await createKey(passphrase);
    const once = await signPackage(unsignedPackage(key.accountId), key, { channel: 'kamakura-history' });
    const twice = await signPackage(once.zip, key, { channel: 'kamakura-history' });
    expect(twice.files).not.toContain('signature.json');
  });

  it('checks the package is for this channel and this key first', async () => {
    const { key } = await createKey(passphrase);
    await expect(signPackage(unsignedPackage(key.accountId), key, { channel: 'other-channel' })).rejects.toThrow('id');
    await expect(signPackage(unsignedPackage('sg1' + 'a'.repeat(32)), key, { channel: 'kamakura-history' })).rejects.toThrow('publisher');
    await expect(signPackage(unsignedPackage(key.accountId, { version: '3' }), key, { channel: 'kamakura-history' })).rejects.toThrow('version');
    await expect(signPackage(utf8.encode('not a zip'), key, { channel: 'kamakura-history' })).rejects.toThrow('ZIP');
  });
});
