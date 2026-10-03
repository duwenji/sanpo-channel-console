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
  /** What this environment pays for (see docs/operations/cost.md). Production keeps every protection. */
  cost: {
    /** AWS WAF on the user pool (ADR-001 A-18): about 7 USD a month. */
    waf: boolean;
    /** DynamoDB point-in-time recovery. */
    pointInTimeRecovery: boolean;
    /** Days to keep Lambda logs; undefined keeps them forever. */
    logRetentionDays?: 14;
    /**
     * Where the key of list cursors comes from: a Secrets Manager secret (0.4 USD a month), or a
     * random value made at synthesis and passed in the environment (cursors expire on each deploy).
     */
    cursorKey: 'secret' | 'environment';
    /** A monthly AWS Budgets alert on the costs tagged with this project. */
    budget?: { monthlyUsd: number; email: string };
  };
}

export const configs: Record<EnvConfig['name'], Omit<EnvConfig, 'rootPublicKey'>> = {
  dev: {
    name: 'dev',
    region: 'ap-northeast-1',
    providerName: 'SanpoGuide チャンネル（開発）',
    signingKeyIds: ['k-2026-10'],
    // Development keeps cost to the minimum (2026-10-04, the developer's decision).
    cost: {
      waf: false,
      pointInTimeRecovery: false,
      logRetentionDays: 14,
      cursorKey: 'environment',
      budget: { monthlyUsd: 5, email: 'tofumiyoshi@gmail.com' },
    },
  },
  prod: {
    name: 'prod',
    region: 'ap-northeast-1',
    providerName: 'SanpoGuide 公式チャンネル',
    signingKeyIds: ['k-2026-10'],
    cost: { waf: true, pointInTimeRecovery: true, cursorKey: 'secret' },
  },
};
