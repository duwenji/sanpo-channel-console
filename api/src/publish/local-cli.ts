import { sha256Hex, utf8 } from '@sanpo-console/protocol';
import { makeTestProvider, sampleChannel } from '@sanpo-console/protocol/testing';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FolderStorage, MemoryStore, noCdn } from './local.js';
import { publish } from './publisher.js';

/**
 * Publishes a sample provider into ../.local/site with throwaway keys, to try the publisher and
 * the conformance checks without AWS:
 *   npm run publish:local -w api && npm run serve -w conformance   (then, in another shell)
 *   npm run check -w conformance -- http://127.0.0.1:8787 --allow-local-http --provider <printed id>
 */
const out = process.argv[2] ?? '../.local/site';
const base = process.argv[3] ?? 'http://127.0.0.1:8787';

const p = await makeTestProvider({ name: 'Local sample provider' });
const pkg = utf8.encode('PK sample channel package');
const icon = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const pkgPath = `pkg/${sha256Hex(pkg)}.zip`;
const iconPath = `icons/${sha256Hex(icon)}.png`;
for (const [path, body] of [[pkgPath, pkg], [iconPath, icon]] as const) {
  await mkdir(join(out, 'public', path, '..'), { recursive: true });
  await writeFile(join(out, 'public', path), body);
}

const store = new MemoryStore();
store.keyset = p.discovery.keyset;
store.keys.set('k-test', { keyId: 'k-test', kmsKeyArn: 'local', status: 'active' });
store.channels = [
  {
    entry: sampleChannel({
      package: { url: `${base}/${pkgPath}`, sha256: sha256Hex(pkg), size: pkg.length, format: 1 },
      icon: { url: `${base}/${iconPath}`, sha256: sha256Hex(icon) },
    }),
  },
];
const record = await publish(
  { store, storage: new FolderStorage(out), cdn: noCdn, signerFor: () => p.signing, config: { rootPublicKey: p.rootKey, name: 'Local sample provider' } },
  'manual',
);
console.log(`published seq ${record.seq} to ${out}\nprovider: ${p.provider}`);
