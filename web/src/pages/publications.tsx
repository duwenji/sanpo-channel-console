import { useState } from 'react';
import type { Schemas } from '@sanpo-console/api-types';
import { useSession } from '../main';
import { Empty, ReasonForm, Status, Time, useLoad } from './common';

const TRIGGERS: Record<string, string> = {
  approve: '承認', revoke: '取り下げ', transfer: '鍵の移し替え', keyset: '鍵セット', daily: '毎日', manual: '手動',
};

export function PublicationsPage() {
  const { api } = useSession();
  const [pages, setPages] = useState<Schemas['Publication'][][]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const first = useLoad(async () => {
    const data = (await api.GET('/api/admin/publications', { params: { query: { limit: 20 } } })).data;
    setPages(data ? [data.items] : []);
    setCursor(data?.nextCursor ?? null);
    return data;
  }, [api]);
  const more = async () => {
    const data = (await api.GET('/api/admin/publications', { params: { query: { limit: 20, cursor: cursor ?? undefined } } })).data;
    if (data) {
      setPages((p) => [...p, data.items]);
      setCursor(data.nextCursor ?? null);
    }
  };
  const rows = pages.flat();

  return (
    <section>
      <h1>公開</h1>
      <p>リストは承認・取り下げ・鍵セットの登録のたびと、毎日 03:00 に作り直されます。</p>
      <ReasonForm
        label="今すぐ作り直す"
        submit={async (reason) => {
          await api.POST('/api/admin/publications', { body: { reason } });
          window.setTimeout(first.reload, 3000);
        }}
      />
      <h2>履歴</h2>
      <Status error={first.error} loading={first.loading} />
      {rows.length === 0 && !first.loading && <Empty>まだ公開していません。</Empty>}
      {rows.length > 0 && (
        <table>
          <thead>
            <tr><th>seq</th><th>公開</th><th>期限</th><th>きっかけ</th><th>チャンネル</th><th>取り下げ</th><th>署名鍵</th><th>SHA-256</th></tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.seq}>
                <td>{p.seq}</td>
                <td><Time value={p.issuedAt} /></td>
                <td><Time value={p.expiresAt} /></td>
                <td>{TRIGGERS[p.trigger] ?? p.trigger}</td>
                <td>{p.channelCount}</td>
                <td>{p.revokedCount}</td>
                <td><code>{p.keyId}</code></td>
                <td><code title={p.sha256}>{p.sha256.slice(0, 12)}…</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cursor && <button onClick={() => void more()}>さらに読み込む</button>}
    </section>
  );
}
