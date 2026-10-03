import { MemoryStorage, MemoryStore, noCdn, publish, LIST_PATH } from '@sanpo-console/api/publish';
import { b64url, sha256Hex, utf8 } from '@sanpo-console/protocol';
import { makeTestProvider, sampleChannel, type TestProvider } from '@sanpo-console/protocol/testing';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkProvider, type CheckId, type CheckOptions } from '../src/check.js';
import { serveFiles } from '../src/serve.js';

const now = new Date('2026-10-03T03:00:00.000Z');

let p: TestProvider;
let storage: MemoryStorage;
let files: Map<string, Uint8Array>;
let server: Server;
let base: string;

/** Publishes one channel with the publisher of the app, and serves the public site plus the files. */
beforeEach(async () => {
  p = await makeTestProvider({ now });
  storage = new MemoryStorage();
  files = new Map();
  ({ server, url: base } = await serveFiles(async (path) => storage.public.get(path) ?? files.get(path)));

  const pkg = utf8.encode('PK… a channel package');
  const icon = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  files.set(`pkg/${sha256Hex(pkg)}.zip`, pkg);
  files.set(`icons/${sha256Hex(icon)}.png`, icon);
  const store = new MemoryStore();
  store.keyset = p.discovery.keyset;
  store.keys.set('k-test', { keyId: 'k-test', kmsKeyArn: 'local', status: 'active' });
  store.channels = [
    {
      entry: sampleChannel({
        package: { url: `${base}/pkg/${sha256Hex(pkg)}.zip`, sha256: sha256Hex(pkg), size: pkg.length, format: 1 },
        icon: { url: `${base}/icons/${sha256Hex(icon)}.png`, sha256: sha256Hex(icon) },
      }),
    },
  ];
  await publish({ store, storage, cdn: noCdn, signerFor: () => p.signing, config: { rootPublicKey: p.rootKey, name: 'Local' }, now: () => now }, 'manual');
});

afterEach(() => new Promise<void>((done) => server.close(() => done())));

async function statuses(options: Partial<CheckOptions> = {}) {
  const results = await checkProvider(base, { expectedProvider: p.provider, allowLocalHttp: true, now, ...options });
  return Object.fromEntries(results.map((r) => [r.id, r.status])) as Record<CheckId, string>;
}

const failed = (s: Record<CheckId, string>) => Object.entries(s).filter(([, v]) => v === 'fail').map(([k]) => k);

describe('a provider published by this system', () => {
  it('passes every check', async () => {
    const s = await statuses({ minSeq: 1 });
    expect(failed(s)).toEqual([]);
    expect(Object.values(s).every((v) => v === 'pass')).toBe(true);
  });
});

describe('the checks catch a broken provider', () => {
  it('V-01: a provider id given by another route that does not match', async () => {
    const other = await makeTestProvider({ now });
    expect(failed(await statuses({ expectedProvider: other.provider }))).toContain('V-01');
  });

  it('V-03: a list body swapped after signing', async () => {
    const doc = JSON.parse(utf8.decode(storage.public.get(LIST_PATH)!));
    doc.payload = b64url.encode(utf8.encode(JSON.stringify({ ...JSON.parse(utf8.decode(b64url.decode(doc.payload))), channels: [] })));
    storage.public.set(LIST_PATH, utf8.encode(JSON.stringify(doc)));
    expect(failed(await statuses())).toEqual(['V-03']);
  });

  it('V-04: an expired list', async () => {
    expect(failed(await statuses({ now: new Date(now.getTime() + 15 * 24 * 3600_000) }))).toEqual(['V-04']);
  });

  it('V-05: a seq older than one seen before', async () => {
    expect(failed(await statuses({ minSeq: 2 }))).toEqual(['V-05']);
  });

  it('V-07: a package changed after approval', async () => {
    const [path] = [...files.keys()].filter((k) => k.startsWith('pkg/'));
    files.set(path!, utf8.encode('PK… something else'));
    expect(failed(await statuses())).toEqual(['V-07']);
  });

  it('V-08: a package over 2MB', async () => {
    const [path] = [...files.keys()].filter((k) => k.startsWith('pkg/'));
    files.set(path!, new Uint8Array(2 * 1024 * 1024 + 1));
    expect(failed(await statuses())).toEqual(['V-08']);
  });

  it('V-09: plain HTTP outside a local test', async () => {
    expect(failed(await statuses({ allowLocalHttp: false }))).toContain('V-09');
  });
});
