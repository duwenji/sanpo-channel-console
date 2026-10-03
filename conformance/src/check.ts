import {
  ACCOUNT_ID,
  CHANNEL_ID,
  LIMITS,
  ProtocolError,
  sha256Hex,
  utf8,
  verifyChannelList,
  verifyDiscovery,
  type ChannelList,
  type Keyset,
} from '@sanpo-console/protocol';

/** The checks of API-002 「確認観点」 that a provider is responsible for. */
export type CheckId = 'V-01' | 'V-02' | 'V-03' | 'V-04' | 'V-05' | 'V-06' | 'V-07' | 'V-08' | 'V-09' | 'V-15' | 'V-16';

export interface CheckResult {
  id: CheckId;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
}

export interface CheckOptions {
  /** The provider id obtained by another route (API-002: never taken from the URL). */
  expectedProvider?: string;
  /** The seq seen last time, to catch a rollback (V-05). */
  minSeq?: number;
  /** Allow `http://localhost` and `http://127.0.0.1`, as the app's debug build does. */
  allowLocalHttp?: boolean;
  now?: Date;
  fetch?: typeof fetch;
}

const TITLES: Record<CheckId, string> = {
  'V-01': 'rootKey gives the provider id',
  'V-02': 'keyset is signed by the root key',
  'V-03': 'list digest is signed by a valid signing key and matches the body',
  'V-04': 'list expires within 14 days and has not expired',
  'V-05': 'seq has not gone back',
  'V-06': 'channel ids are unique and well-formed',
  'V-07': 'packages and icons match their SHA-256 and size',
  'V-08': 'size limits are kept',
  'V-09': 'every URL is HTTPS',
  'V-15': 'digest is small enough for KMS to sign',
  'V-16': 'publisher changes are well-formed',
};

export const title = (id: CheckId) => TITLES[id];

class TooLarge extends Error {}

/** Fetches at most [limit] bytes; a larger response is cut off, as the app does (API-002 `too_large`). */
async function fetchLimited(fetchImpl: typeof fetch, url: string, limit: number): Promise<Uint8Array> {
  const res = await fetchImpl(url, { redirect: 'error' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new TooLarge(`${url}: more than ${limit} bytes`);
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function urlProblem(url: string, allowLocalHttp: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${url} is not a URL`;
  }
  if (parsed.protocol === 'https:') return null;
  if (allowLocalHttp && parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)) return null;
  return `${url} is not HTTPS`;
}

/** Runs every check against the provider at [baseUrl]; never throws for a failing provider. */
export async function checkProvider(baseUrl: string, options: CheckOptions = {}): Promise<CheckResult[]> {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? new Date();
  const results = new Map<CheckId, CheckResult>();
  const set = (id: CheckId, status: CheckResult['status'], detail = '') => {
    if (results.get(id)?.status !== 'fail') results.set(id, { id, status, detail });
  };
  const failWith = (id: CheckId, e: unknown) => set(id, 'fail', e instanceof Error ? e.message : String(e));
  const base = baseUrl.replace(/\/+$/, '');
  const urls: string[] = [];

  // V-01, V-02: discovery and keyset.
  let keyset: Keyset | undefined;
  let listPath = '/v1/channels.json';
  try {
    const discoveryUrl = `${base}/.well-known/sanpo-channels`;
    urls.push(discoveryUrl);
    const discovery: unknown = JSON.parse(utf8.decode(await fetchLimited(fetchImpl, discoveryUrl, LIMITS.listBytes)));
    try {
      const verified = verifyDiscovery(discovery, options.expectedProvider ? { expectedProvider: options.expectedProvider } : {});
      keyset = verified.keyset;
      listPath = verified.discovery.list;
      set('V-01', 'pass', verified.keyset.provider);
      set('V-02', 'pass', `keyset seq ${verified.keyset.seq}, keys ${verified.keyset.keys.map((k) => k.keyId).join(', ')}`);
    } catch (e) {
      const code = e instanceof ProtocolError ? e.code : '';
      failWith(code === 'provider_mismatch' ? 'V-01' : 'V-02', e);
    }
  } catch (e) {
    failWith(e instanceof TooLarge ? 'V-08' : 'V-01', e);
  }

  // V-03 to V-06, V-15, V-16: the list.
  let list: ChannelList | undefined;
  if (keyset) {
    const listUrl = new URL(listPath, `${base}/`).toString();
    urls.push(listUrl);
    try {
      const doc: unknown = JSON.parse(utf8.decode(await fetchLimited(fetchImpl, listUrl, LIMITS.listBytes)));
      try {
        const verified = verifyChannelList(doc, keyset, { now, ...(options.minSeq !== undefined ? { minSeq: options.minSeq } : {}) });
        list = verified.body;
        set('V-03', 'pass', `seq ${list.seq}, signed by ${verified.signingKey.keyId}`);
        set('V-04', 'pass', `expires ${list.expiresAt}`);
        set('V-05', options.minSeq === undefined ? 'skip' : 'pass', options.minSeq === undefined ? 'no previous seq given' : `seq ${list.seq}`);
        set('V-15', verified.digestPayloadBytes < LIMITS.digestPayloadBytes ? 'pass' : 'fail', `${verified.digestPayloadBytes} bytes`);
      } catch (e) {
        const code = e instanceof ProtocolError ? e.code : '';
        failWith(code === 'expired' ? 'V-04' : code === 'rollback' ? 'V-05' : 'V-03', e);
      }
    } catch (e) {
      failWith(e instanceof TooLarge ? 'V-08' : 'V-03', e);
    }
  }

  if (list) {
    const ids = list.channels.map((c) => c.id);
    const badId = ids.find((id) => !CHANNEL_ID.test(id));
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (badId || duplicate) set('V-06', 'fail', badId ? `bad id ${badId}` : `duplicate id ${duplicate}`);
    else set('V-06', 'pass', `${ids.length} channels`);

    const changes = list.channels.filter((c) => c.publisherChange);
    const badChange = changes.find((c) => !ACCOUNT_ID.test(c.publisherChange!.from) || c.publisherChange!.from === c.publisher);
    if (badChange) set('V-16', 'fail', `${badChange.id}: publisherChange.from is malformed or equals publisher`);
    else set('V-16', 'pass', `${changes.length} changes`);

    // V-07, V-08: every package and icon.
    for (const channel of list.channels) {
      for (const [what, file, limit] of [
        ['package', channel.package, LIMITS.packageBytes],
        ['icon', channel.icon, LIMITS.iconBytes],
      ] as const) {
        urls.push(file.url);
        if (urlProblem(file.url, options.allowLocalHttp ?? false)) continue;
        try {
          const bytes = await fetchLimited(fetchImpl, file.url, limit);
          const sizeOk = what === 'icon' || bytes.length === (file as { size: number }).size;
          if (sha256Hex(bytes) !== file.sha256 || !sizeOk) set('V-07', 'fail', `${channel.id} ${what}: SHA-256 or size differs`);
          else set('V-07', 'pass', 'all files match');
        } catch (e) {
          failWith(e instanceof TooLarge ? 'V-08' : 'V-07', new Error(`${channel.id} ${what}: ${e instanceof Error ? e.message : e}`));
        }
      }
    }
    if (list.channels.length === 0) set('V-07', 'skip', 'no channels');
    set('V-08', 'pass', 'list ≤ 1MB, packages ≤ 2MB, icons ≤ 100KB');
  }

  // V-09: every URL, including those of documents that failed.
  const insecure = urls.map((u) => urlProblem(u, options.allowLocalHttp ?? false)).find((p) => p !== null);
  set('V-09', insecure ? 'fail' : 'pass', insecure ?? `${urls.length} URLs`);

  const order = Object.keys(TITLES) as CheckId[];
  return order.map((id) => results.get(id) ?? { id, status: 'skip', detail: 'not reached' });
}
