import { unzipSync, zipSync } from 'fflate';

/**
 * The publisher's key and package signing, all in the browser (DES-003): the private key never
 * leaves this page. Ed25519 comes from WebCrypto; the key file is the private key encrypted with
 * the publisher's passphrase (PBKDF2 + AES-GCM).
 */

const subtle = globalThis.crypto.subtle;
const ED25519 = { name: 'Ed25519' } as const;
const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSPHRASE = 12;

const b64url = {
  encode: (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  decode: (text: string): Uint8Array => {
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
  },
};
export { b64url };

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(bytes: Uint8Array): string {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

const bytes = (data: Uint8Array | ArrayBuffer) => (data instanceof Uint8Array ? data : new Uint8Array(data));
// WebCrypto wants a plain ArrayBuffer-backed view.
const buf = (data: Uint8Array) => new Uint8Array(data).buffer as ArrayBuffer;

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return bytes(await subtle.digest('SHA-256', buf(data)));
}

const hex = (data: Uint8Array) => Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');

/** `sg1` + base32(SHA-256(public key)), first 32 characters: the same as the server and station-format. */
export async function accountIdOf(publicKey: Uint8Array): Promise<string> {
  return 'sg1' + base32(await sha256(publicKey)).slice(0, 32);
}

/** Whether this browser can make and use Ed25519 keys (recent Chrome, Edge, Firefox and Safari can). */
export async function ed25519Supported(): Promise<boolean> {
  try {
    await subtle.generateKey(ED25519, false, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
}

export interface PublisherKey {
  accountId: string;
  publicKey: Uint8Array;
  privateKey: CryptoKey;
}

/** What the publisher saves: the private key, encrypted with their passphrase. */
export interface KeyFile {
  type: 'sanpo-publisher-key';
  version: 1;
  accountId: string;
  publicKey: string;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string };
  encryptedPrivateKey: string;
}

async function wrappingKey(passphrase: string, salt: Uint8Array, iterations: number) {
  const material = await subtle.importKey('raw', buf(new TextEncoder().encode(passphrase)), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Makes a new key and its key file. */
export async function createKey(passphrase: string): Promise<{ key: PublisherKey; file: KeyFile }> {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`合言葉は ${MIN_PASSPHRASE} 文字以上にしてください`);
  const pair = (await subtle.generateKey(ED25519, true, ['sign', 'verify'])) as CryptoKeyPair;
  const publicKey = bytes(await subtle.exportKey('raw', pair.publicKey));
  const pkcs8 = bytes(await subtle.exportKey('pkcs8', pair.privateKey));
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const encrypted = bytes(await subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, await wrappingKey(passphrase, salt, PBKDF2_ITERATIONS), buf(pkcs8)));
  const accountId = await accountIdOf(publicKey);
  // The usable key is not extractable: from here on, only the encrypted file holds it.
  const privateKey = await subtle.importKey('pkcs8', buf(pkcs8), ED25519, false, ['sign']);
  return {
    key: { accountId, publicKey, privateKey },
    file: {
      type: 'sanpo-publisher-key',
      version: 1,
      accountId,
      publicKey: b64url.encode(publicKey),
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: b64url.encode(salt) },
      cipher: { name: 'AES-GCM', iv: b64url.encode(iv) },
      encryptedPrivateKey: b64url.encode(encrypted),
    },
  };
}

/** Opens a key file with its passphrase; a wrong passphrase or a damaged file is an error. */
export async function openKeyFile(text: string, passphrase: string): Promise<PublisherKey> {
  let file: KeyFile;
  try {
    file = JSON.parse(text) as KeyFile;
  } catch {
    throw new Error('鍵のファイルとして読めません');
  }
  if (file.type !== 'sanpo-publisher-key' || file.version !== 1) throw new Error('鍵のファイルではありません');
  let pkcs8: Uint8Array;
  try {
    const wrapping = await wrappingKey(passphrase, b64url.decode(file.kdf.salt), file.kdf.iterations);
    pkcs8 = bytes(await subtle.decrypt({ name: 'AES-GCM', iv: buf(b64url.decode(file.cipher.iv)) }, wrapping, buf(b64url.decode(file.encryptedPrivateKey))));
  } catch {
    throw new Error('合言葉が違うか、鍵のファイルが壊れています');
  }
  const privateKey = await subtle.importKey('pkcs8', buf(pkcs8), ED25519, false, ['sign']);
  const publicKey = b64url.decode(file.publicKey);
  // The file must hold the key it says it does.
  const probe = new TextEncoder().encode('sanpo-key-check');
  const publicCrypto = await subtle.importKey('raw', buf(publicKey), ED25519, false, ['verify']);
  const signature = await subtle.sign(ED25519, privateKey, buf(probe));
  if (!(await subtle.verify(ED25519, publicCrypto, signature, buf(probe)))) throw new Error('鍵のファイルの中身が合っていません');
  return { accountId: await accountIdOf(publicKey), publicKey, privateKey };
}

export async function sign(key: PublisherKey, message: Uint8Array): Promise<Uint8Array> {
  return bytes(await subtle.sign(ED25519, key.privateKey, buf(message)));
}

export interface SignedPackage {
  zip: Uint8Array;
  channel: string;
  version: number;
  files: string[];
}

/**
 * Signs a package the way API-003 F-6 says: SHA-256 of every file but `signature.json`, signed as
 * a `channel-package` payload, written to `signature.json` in a new ZIP. Checks first that the
 * package is for this channel and names this key as its publisher.
 */
export async function signPackage(zip: Uint8Array, key: PublisherKey, expect: { channel: string }): Promise<SignedPackage> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip);
  } catch {
    throw new Error('ZIP として読めません');
  }
  const files: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/') || name === 'signature.json') continue; // folders, and a signature from before
    files[name] = data;
  }
  const manifestBytes = files['channel.json'];
  if (!manifestBytes) throw new Error('channel.json がありません（ZIP の一番上に置いてください）');
  let manifest: { id?: unknown; version?: unknown; publisher?: unknown };
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch {
    throw new Error('channel.json が UTF-8 の JSON として読めません');
  }
  if (manifest.id !== expect.channel) throw new Error(`channel.json の id が ${String(manifest.id)} です（このチャンネルは ${expect.channel}）`);
  if (typeof manifest.version !== 'number' || !Number.isInteger(manifest.version)) throw new Error('channel.json の version が整数ではありません');
  if (manifest.publisher !== key.accountId) throw new Error(`channel.json の publisher を、あなたのアカウントID ${key.accountId} にしてください`);

  const hashes: Record<string, string> = {};
  for (const name of Object.keys(files).sort()) hashes[name] = hex(await sha256(files[name]!));
  const payload = new TextEncoder().encode(
    JSON.stringify({ type: 'channel-package', channel: expect.channel, version: manifest.version, publisher: key.accountId, files: hashes }),
  );
  const signature = new TextEncoder().encode(
    JSON.stringify({ payload: b64url.encode(payload), publisherKey: b64url.encode(key.publicKey), sig: b64url.encode(await sign(key, payload)) }),
  );
  return {
    zip: zipSync({ ...files, 'signature.json': signature }, { level: 6 }),
    channel: expect.channel,
    version: manifest.version,
    files: Object.keys(hashes),
  };
}
