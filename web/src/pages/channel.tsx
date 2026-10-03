import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ifMatch } from '../api';
import { useSession } from '../main';
import { ReasonForm, Status, Time, useLoad } from './common';

/** Looks up a channel by id, and takes it off the list (DM-001 M-9). */
export function ChannelPage() {
  const { api } = useSession();
  const { channelId = '' } = useParams();
  const navigate = useNavigate();
  const [lookup, setLookup] = useState(channelId);
  const ch = useLoad(
    async () => (channelId ? (await api.GET('/api/channels/{channelId}', { params: { path: { channelId } } })).data : undefined),
    [api, channelId],
  );
  const [severity, setSeverity] = useState<'high' | 'low'>('high');
  const [versions, setVersions] = useState('');
  const c = ch.data;

  const find = (e: FormEvent) => {
    e.preventDefault();
    navigate(`/channels/${lookup.trim()}`);
  };

  return (
    <section>
      <h1>チャンネル</h1>
      <form className="inline" onSubmit={find}>
        <label>
          チャンネル ID <input required pattern="[a-z0-9\-]{3,40}" value={lookup} onChange={(e) => setLookup(e.target.value)} />
        </label>
        <button>表示</button>
      </form>
      {channelId && <Status error={ch.error} loading={ch.loading} />}
      {c && (
        <>
          <h2>
            <code>{c.channelId}</code> {c.latestApproved?.name}
          </h2>
          <dl className="facts">
            <dt>状態</dt>
            <dd>
              <span className={`tag ${c.status}`}>{c.status}</span> {c.listed ? 'リストに載っている' : 'リストに載っていない'}
            </dd>
            <dt>配信元</dt>
            <dd>
              <Link to={`/publishers/${c.publisherId}`}>{c.publisherId}</Link>
            </dd>
            <dt>承認済みの版</dt>
            <dd>
              {c.latestApproved ? (
                <>
                  版 {c.latestApproved.version}（<Time value={c.latestApproved.approvedAt} />）
                </>
              ) : (
                '—'
              )}
            </dd>
            <dt>取り下げ</dt>
            <dd>
              {c.revocations?.length
                ? c.revocations.map((r) => (
                    <div key={r.revokedAt}>
                      <Time value={r.revokedAt} /> {r.severity === 'high' ? '重い' : '軽い'}: {r.reason}
                      {r.versions && `（版 ${r.versions.join('、')}）`}
                    </div>
                  ))
                : '—'}
            </dd>
          </dl>
          {c.status === 'active' && (
            <ReasonForm
              label="取り下げる"
              danger
              submit={async (reason) => {
                const list = versions.split(/[,\s、]+/).filter(Boolean).map(Number);
                await api.POST('/api/admin/channels/{channelId}/revoke', {
                  params: { path: { channelId }, header: ifMatch(c.rev) },
                  body: { reason, severity, ...(list.length ? { versions: list } : {}) },
                });
                ch.reload();
              }}
            >
              <p className="muted">
                リストから消え、利用者の端末にも理由とともに知らされます（リストの revoked に 7 日）。戻すには新しい版の承認が要ります。理由は利用者に見せます。
              </p>
              <label>
                重さ{' '}
                <select value={severity} onChange={(e) => setSeverity(e.target.value as 'high' | 'low')}>
                  <option value="high">重い（安全・違法・個人情報・権利侵害）</option>
                  <option value="low">軽い</option>
                </select>
              </label>
              <label>
                取り下げる版（空欄はすべての版）
                <input value={versions} placeholder="例: 2, 3" onChange={(e) => setVersions(e.target.value)} />
              </label>
            </ReasonForm>
          )}
          <p>
            <Link to={`/audit?target=CH%23${c.channelId}`}>このチャンネルの操作の記録</Link>
          </p>
        </>
      )}
    </section>
  );
}
