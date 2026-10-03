import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { fail } from './http.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID: sorts by creation time (DM-001 M-12). */
export function ulid(now = Date.now()): string {
  let time = '';
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time;
  const random = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[random[i]! % 32];
  return time + rand;
}

/** Today's date in Japan, for the per-day quotas (DM-001 M-12). */
export function jstDate(now: Date): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

/**
 * Opaque list cursors (API-001 C-9): DynamoDB's LastEvaluatedKey, encrypted with AES-256-GCM so a
 * client can't read or forge one.
 */
export class CursorCodec {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('the cursor key must be 32 bytes');
  }

  encode(lastKey: Record<string, unknown> | undefined): string | null {
    if (!lastKey) return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(lastKey), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }

  decode(cursor: string | undefined): Record<string, unknown> | undefined {
    if (!cursor) return undefined;
    try {
      const raw = Buffer.from(cursor, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return fail('invalid_request', 'bad cursor');
    }
  }
}
