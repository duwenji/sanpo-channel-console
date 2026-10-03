import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

// DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows it.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function publicKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new Error('an Ed25519 public key is 32 bytes');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function rawPublicKey(key: KeyObject): Uint8Array {
  const der = (key.type === 'public' ? key : createPublicKey(key)).export({ format: 'der', type: 'spki' });
  if (der.length !== 44 || !der.subarray(0, 12).equals(SPKI_PREFIX)) throw new Error('not an Ed25519 key');
  return new Uint8Array(der.subarray(12));
}

/** Pure Ed25519 (RFC 8032), as Tink and KMS ED25519_SHA_512 with MessageType RAW produce. */
export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return verify(null, message, publicKeyFromRaw(publicKey), signature);
  } catch {
    return false;
  }
}

export function signEd25519(privateKey: KeyObject, message: Uint8Array): Uint8Array {
  return new Uint8Array(sign(null, message, privateKey));
}

export function generateEd25519(): { privateKey: KeyObject; publicKey: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: rawPublicKey(publicKey) };
}

export function privateKeyFromPem(pem: string, passphrase?: string): KeyObject {
  const key = createPrivateKey(passphrase === undefined ? pem : { key: pem, passphrase });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 private key');
  return key;
}
