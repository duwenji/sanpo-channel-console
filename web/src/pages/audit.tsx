import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type { Schemas } from '@sanpo-console/api-types';
import { useSession } from '../main';
import { Empty, Status, Time, useLoad } from './common';

const thisMonth = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7);

/** The audit log, by month or for one target (DM-001 AP-18, AP-19). */
export function AuditPage() {
  const { api } = useSession();
  const [params, setParams] = useSearchParams();
  const target = params.get('target') ?? '';
  const month = params.get('month') ?? (target ? '' : thisMonth());
  const [rows, setRows] = useState<Schemas['AuditEvent'][]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const query = target ? { target } : { month };
  const first = useLoad(async () => {
    const data = (await api.GET('/api/admin/audit', { params: { query: { ...query, limit: 50 } } })).data;
    setRows(data?.items ?? []);
    setCursor(data?.nextCursor ?? null);
    return data;
  }, [api, target, month]);
  const more = async () => {
    const data = (await api.GET('/api/admin/audit', { params: { query: { ...query, limit: 50, cursor: cursor ?? undefined } } })).data;
    if (data) {
      setRows((r) => [...r, ...data.items]);
      setCursor(data.nextCursor ?? null);
    }
  };

  return (
    <section>
      <h1>操作の記録</h1>
      <form className="inline" onSubmit={(e) => e.preventDefault()}>
        <label>
          月 <input type="month" value={month} onChange={(e) => setParams({ month: e.target.value })} />
        </label>
        <label>
          対象 <input placeholder="例: CH#kamakura-history" value={target} onChange={(e) => setParams(e.target.value ? { target: e.target.value } : {})} />
        </label>
      </form>
      <Status error={first.error} loading={first.loading} />
      {rows.length === 0 && !first.loading && <Empty>記録はありません。</Empty>}
      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>日時</th>
              <th>だれが</th>
              <th>操作</th>
              <th>対象</th>
              <th>理由</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.eventId}>
                <td>
                  <Time value={a.at} />
                </td>
                <td>
                  {a.actorRole}
                  {a.actorSub && <span className="muted small"> {a.actorSub.slice(0, 8)}</span>}
                </td>
                <td>
                  <code>{a.action}</code>
                </td>
                <td>
                  <code>{a.target}</code>
                </td>
                <td>{a.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cursor && <button onClick={() => void more()}>さらに読み込む</button>}
    </section>
  );
}
