import { b64url } from '@sanpo-console/protocol';
import { CloudFrontCdn, DynamoStore, S3Storage, kmsSigner } from './aws.js';
import { SeqConflictError, type Trigger } from './ports.js';
import { publish, type ProviderConfig } from './publisher.js';

const TRIGGERS: readonly Trigger[] = ['approve', 'revoke', 'transfer', 'keyset', 'daily', 'manual'];

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

const config: ProviderConfig = {
  rootPublicKey: b64url.decode(env('ROOT_PUBLIC_KEY')),
  name: env('PROVIDER_NAME'),
  ...(optional('REVIEW_POLICY_URL') ? { reviewPolicyUrl: optional('REVIEW_POLICY_URL')! } : {}),
  ...(optional('TERMS_URL') ? { termsUrl: optional('TERMS_URL')! } : {}),
  ...(optional('CONTACT') ? { contact: optional('CONTACT')! } : {}),
};

const deps = {
  store: new DynamoStore(env('TABLE_NAME')),
  storage: new S3Storage(env('PUBLIC_BUCKET'), env('ARCHIVE_BUCKET')),
  cdn: new CloudFrontCdn(env('DISTRIBUTION_ID')),
  signerFor: kmsSigner,
  config,
};

/**
 * The publishing Lambda (ADR-001 A-10). Invoked asynchronously by the API after an approval,
 * revocation, key transfer or keyset registration, and daily by EventBridge Scheduler.
 * Reserved concurrency 1 keeps runs apart; the conditional write on `seq` guards the rest.
 */
export async function handler(event: { trigger?: string } = {}) {
  const trigger = TRIGGERS.includes(event.trigger as Trigger) ? (event.trigger as Trigger) : 'manual';
  try {
    return await publish(deps, trigger);
  } catch (e) {
    // Another run took the next seq in between: build again on top of it, once.
    if (e instanceof SeqConflictError) return publish(deps, trigger);
    throw e;
  }
}
