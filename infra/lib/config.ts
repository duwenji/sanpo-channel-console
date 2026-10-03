/** Settings of one deployment: the development or the production account (ADR-001 A-2). */
export interface EnvConfig {
  name: 'dev' | 'prod';
  /** Optional: when set, the stack is pinned to this account. */
  account?: string;
  region: 'ap-northeast-1';
  providerName: string;
  /**
   * The root public key (base64url, 32 bytes), pinned so the publisher only puts out what chains to it
   * (ADR-001 A-9). The development provider has its own root key and is never built into the app.
   */
  rootPublicKey: string;
  /** Signing keys in KMS, one per period (ADR-001 A-8: a new key every six months). */
  signingKeyIds: string[];
  reviewPolicyUrl?: string;
  termsUrl?: string;
  contact?: string;
  /** Where alarms go; set it before the first deployment. */
  alarmEmail?: string;
}

export const configs: Record<EnvConfig['name'], Omit<EnvConfig, 'rootPublicKey'>> = {
  dev: {
    name: 'dev',
    region: 'ap-northeast-1',
    providerName: 'SanpoGuide チャンネル（開発）',
    signingKeyIds: ['k-2026-10'],
  },
  prod: {
    name: 'prod',
    region: 'ap-northeast-1',
    providerName: 'SanpoGuide 公式チャンネル',
    signingKeyIds: ['k-2026-10'],
  },
};
