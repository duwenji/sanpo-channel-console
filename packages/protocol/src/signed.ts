import { b64url, utf8 } from './encoding.js';
import { signEd25519 } from './ed25519.js';
import type { KeyObject } from 'node:crypto';
import type { SignedDocument } from './types.js';

/** Signs bytes with one Ed25519 key: a root key on an offline machine, or a signing key in KMS. */
export interface Signer {
  readonly keyId: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/** A signer holding the private key in memory: the root key CLI, development and tests. */
export function localSigner(keyId: string, privateKey: KeyObject): Signer {
  return { keyId, sign: async (message) => signEd25519(privateKey, message) };
}

/** The JSON bytes a document is signed over; signing the bytes avoids canonicalizing JSON (P-3). */
export function payloadBytes(content: object): Uint8Array {
  return utf8.encode(JSON.stringify(content));
}

export async function signDocument(content: object, signer: Signer): Promise<SignedDocument> {
  const bytes = payloadBytes(content);
  return { payload: b64url.encode(bytes), keyId: signer.keyId, sig: b64url.encode(await signer.sign(bytes)) };
}
