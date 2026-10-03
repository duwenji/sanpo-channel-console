import { App } from 'aws-cdk-lib';
import { configs, type EnvConfig } from '../lib/config.js';
import { ConsoleStack } from '../lib/console-stack.js';

// npx cdk synth -c env=dev -c rootPublicKey=<base64url of the dev root key>
const app = new App();
const name = (app.node.tryGetContext('env') ?? 'dev') as EnvConfig['name'];
const base = configs[name];
if (!base) throw new Error(`unknown env ${name}; use dev or prod`);
const rootPublicKey = app.node.tryGetContext('rootPublicKey') as string | undefined;
if (!rootPublicKey) {
  throw new Error('pass -c rootPublicKey=<base64url>: the root public key of this provider (tools/root-key generate; ADR-001 T-5)');
}
const config: EnvConfig = { ...base, rootPublicKey, ...(app.node.tryGetContext('alarmEmail') ? { alarmEmail: app.node.tryGetContext('alarmEmail') } : {}) };

new ConsoleStack(app, `SanpoChannelConsole-${name}`, {
  config,
  env: { region: config.region, ...(config.account ? { account: config.account } : {}) },
  description: `SanpoGuide channel management system (${name})`,
});
