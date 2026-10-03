import { Link } from 'react-router';
import { useSession } from '../main';
import { Empty, Status, Time, useLoad } from './common';

const DAY = 24 * 3600_000;

/** What needs attention: the list's expiry and the signing keys. */
export function HomePage() {
  const { api } = useSession();
  const pubs = useLoad(async () => (await api.GET('/api/admin/publications', { params: { query: { limit: 1 } } })).data, [api]);
  const keys = useLoad(async () => (await api.GET('/api/admin/signing-keys')).data, [api]);
  const latest = pubs.data?.items[0];
  const left = latest ? Date.parse(latest.expiresAt) - Date.now() : 0;

  return (
    <section>
      <h1>概要</h1>
      <h2>承認済みチャンネル・リスト</h2>
      <Status error={pubs.error} loading={pubs.loading} />
      {latest ? (
        <dl className="facts">
          <dt>最新の公開</dt>
          <dd>
            seq {latest.seq}（<Time value={latest.issuedAt} />、{latest.trigger}）
          </dd>
          <dt>期限</dt>
          <dd className={left < 3 * DAY ? 'warn' : ''}>
            <Time value={latest.expiresAt} />（あと {Math.max(0, Math.floor(left / DAY))} 日）
            {left < 3 * DAY && ' — 毎日の作り直しが止まっていないか確かめてください'}
          </dd>
          <dt>チャンネル</dt>
          <dd>
            {latest.channelCount} 件（取り下げ {latest.revokedCount} 件）
          </dd>
        </dl>
      ) : (
        !pubs.loading && <Empty>まだ公開していません。署名鍵と鍵セットを登録すると公開されます。</Empty>
      )}
      <p>
        <Link to="/publications">公開の履歴へ</Link>
      </p>

      <h2>署名鍵</h2>
      <Status error={keys.error} loading={keys.loading} />
      {keys.data && keys.data.items.length === 0 && <Empty>署名鍵がありません。</Empty>}
      <ul className="plain">
        {keys.data?.items.map((k) => (
          <li key={k.keyId}>
            <code>{k.keyId}</code> <span className={`tag ${k.status}`}>{k.status}</span> 期限 <Time value={k.notAfter} />
          </li>
        ))}
      </ul>
      <p>
        <Link to="/keys">署名鍵・鍵セットへ</Link>
      </p>
    </section>
  );
}
