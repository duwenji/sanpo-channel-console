import { RemovalPolicy } from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { EnvConfig } from './config.js';

/** The cost allocation tag on every resource (bin/app.ts), and what the budget counts. */
export const PROJECT_TAG = 'sanpo-channel-console';

/** A log group with the environment's retention; none (the default group, kept forever) otherwise. */
export function logGroupFor(scope: Construct, id: string, config: EnvConfig): { logGroup?: logs.ILogGroup } {
  if (!config.cost.logRetentionDays) return {};
  return { logGroup: new logs.LogGroup(scope, id, { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY }) };
}
