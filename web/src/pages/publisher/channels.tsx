import { Fragment, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { describe, ifMatch } from '../../api';
import { useSession } from '../../main';
import { openKeyFile, signPackage } from '../../publisher-crypto';
import { Empty, Status, Time, useLoad } from '../common';

const STATE: Record<string, string> = {
  uploading: 'アップロード待ち', validating: '機械の確認中', validation_failed: '機械の確認で不合格', awaiting_review: '審査待ち',
  in_review: '審査中', approved: '承認', returned: '差し戻し', rejected: '却下', withdrawn: '取り消し', expired: '期限切れ',
  superseded: '置き換え済み', revoked: '取り下げ',
};

export function PublisherChannels() {
  const { api } = useSession();
  const list = useLoad(async () => (await api.GET('/api/channels')).data, [api]);
  const [channelId, setChannelId] = useState('');
  const [error, setError] = useState<string>();
  const register = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api.POST('/api/channels', { body: { channelId } });
      setChannelId('');
      list.reload();
    } catch (err) {
      setError(describe(err));
    }
  };
  return (
    <section>
      <h1>チャンネル</h1>
      <Status error={list.error} loading={list.loading} />
      {list.data?.items.length === 0 && <Empty>まだチャンネルがありません。下でチャンネル ID を登録してください。</Empty>}
      <ul className="plain">
        {list.data?.items.map((c) => (
          <li key={c.channelId}>
            <Link to={`/channels/${c.channelId}`}><code>{c.channelId}</code></Link> {c.latestApproved?.name}{' '}
            {c.listed ? <span className="tag active">公開中</span> : c.status === 'revoked' ? <span className="tag revoked">取り下げ</span> : <span className="tag">未公開</span>}
          </li>
        ))}
      </ul>
      <form className="action" onSubmit={(e) => void register(e)}>
        <h3>チャンネル ID を登録する</h3>
        <label>
          英小文字・数字・ハイフンの 3〜40 文字（あとから変えられず、取り下げても再利用できません）
          <input required pattern="[a-z0-9\-]{3,40}" placeholder="kamakura-history" value={channelId} onChange={(e) => setChannelId(e.target.value)} />
        </label>
        <button>登録する</button>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </section>
  );
}

async function upload(target: { url: string; fields: Record<string, string> }, file: Blob) {
  const form = new FormData();
  for (const [k, v] of Object.entries(target.fields)) form.append(k, v);
  form.append('file', file);
  const res = await fetch(target.url, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`アップロードできませんでした（${res.status}）`);
}

export function PublisherChannel() {
  const { api } = useSession();
  const { channelId = '' } = useParams();
  const ch = useLoad(async () => (await api.GET('/api/channels/{channelId}', { params: { path: { channelId } } })).data, [api, channelId]);
  const subs = useLoad(
    async () => (await api.GET('/api/channels/{channelId}/submissions', { params: { path: { channelId }, query: { limit: 20 } } })).data,
    [api, channelId],
  );

  const [zip, setZip] = useState<File>();
  const [icon, setIcon] = useState<File>();
  const [keyText, setKeyText] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [regions, setRegions] = useState('');
  const [note, setNote] = useState('');
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!zip || !icon) return;
    setError(undefined);
    try {
      if (icon.type !== 'image/png' || icon.size > 100 * 1024) throw new Error('アイコンは PNG で 100KB 以下にしてください（256×256 以下）');
      setProgress('鍵を開いています…');
      const key = await openKeyFile(keyText, passphrase);
      setProgress('パッケージに署名しています…');
      const signed = await signPackage(new Uint8Array(await zip.arrayBuffer()), key, { channel: channelId });
      if (signed.zip.length > 2 * 1024 * 1024) throw new Error('署名したパッケージが 2MB を超えています');
      setProgress('申請を作っています…');
      const split = (s: string) => s.split(/[,\s、]+/).filter(Boolean);
      const { data } = await api.POST('/api/channels/{channelId}/submissions', {
        params: { path: { channelId } },
        body: {
          ...(description ? { description } : {}),
          ...(tags ? { tags: split(tags) } : {}),
          ...(regions ? { regions: split(regions) } : {}),
          ...(note ? { note } : {}),
        },
      });
      if (!data) throw new Error('申請を作れませんでした');
      setProgress('パッケージを送っています…');
      await upload(data.uploads.package, new Blob([new Uint8Array(signed.zip)], { type: 'application/zip' }));
      setProgress('アイコンを送っています…');
      await upload(data.uploads.icon, new Blob([icon], { type: 'image/png' }));
      setProgress(`版 ${signed.version} を申請しました。機械の確認のあと、審査待ちになります。`);
      setPassphrase('');
      subs.reload();
      ch.reload();
    } catch (err) {
      setProgress(undefined);
      setError(describe(err));
    }
  };

  const c = ch.data;
  return (
    <section>
      <p><Link to="/channels">← チャンネルの一覧</Link></p>
      <h1><code>{channelId}</code> {c?.latestApproved?.name}</h1>
      <Status error={ch.error} loading={ch.loading} />
      {c && (
        <dl className="facts">
          <dt>状態</dt>
          <dd>{c.listed ? '公開中' : c.status === 'revoked' ? '取り下げ' : '未公開'}</dd>
          <dt>公開中の版</dt>
          <dd>{c.latestApproved ? <>版 {c.latestApproved.version}（<Time value={c.latestApproved.approvedAt} />）</> : '—'}</dd>
          {c.revocations?.map((r) => (
            <Fragment key={r.revokedAt}>
              <dt>取り下げ</dt>
              <dd><Time value={r.revokedAt} />: {r.reason}</dd>
            </Fragment>
          ))}
        </dl>
      )}

      <h2>申請</h2>
      <Status error={subs.error} loading={subs.loading} />
      {subs.data?.items.length === 0 && <Empty>まだ申請していません。</Empty>}
      {subs.data && subs.data.items.length > 0 && (
        <table>
          <thead>
            <tr><th>申請</th><th>版</th><th>状態</th><th>機械の確認</th><th></th></tr>
          </thead>
          <tbody>
            {subs.data.items.map((s) => (
              <tr key={s.submissionId}>
                <td><Time value={s.createdAt} /></td>
                <td>{s.version ?? '—'}</td>
                <td><span className={`tag ${s.state}`}>{STATE[s.state] ?? s.state}</span></td>
                <td>
                  {s.validation
                    ? s.validation.ok
                      ? '合格'
                      : s.validation.errors.map((x) => <div key={x.code + x.detail}><code>{x.code}</code> {x.detail}</div>)
                    : '—'}
                </td>
                <td>
                  {(s.state === 'awaiting_review' || s.state === 'in_review') && (
                    <button
                      className="link"
                      onClick={() =>
                        void api
                          .POST('/api/channels/{channelId}/submissions/{submissionId}/withdraw', { params: { path: { channelId, submissionId: s.submissionId }, header: ifMatch(s.rev) } })
                          .then(() => { subs.reload(); ch.reload(); }, (err: unknown) => setError(describe(err)))
                      }
                    >
                      取り消す
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form className="action" onSubmit={(e) => void submit(e)}>
        <h3>新しい版を申請する</h3>
        <p className="muted">
          署名する前の ZIP（<code>channel.json</code> と <code>prompts/</code>）を選びます。この画面があなたの鍵で署名し、<code>signature.json</code> を足して送ります。形式は配信元ガイドを見てください。
        </p>
        <label>
          パッケージ（ZIP）
          <input type="file" accept=".zip,application/zip" required onChange={(e) => setZip(e.target.files?.[0])} />
        </label>
        <label>
          アイコン（PNG、256×256 以下、100KB 以下）
          <input type="file" accept="image/png" required onChange={(e) => setIcon(e.target.files?.[0])} />
        </label>
        <label>
          鍵のファイル
          <input type="file" accept="application/json,.json" required onChange={(e) => void e.target.files?.[0]?.text().then(setKeyText)} />
        </label>
        <label>
          合言葉
          <input type="password" required value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </label>
        <label>
          説明（アプリの一覧に出ます。1,000 文字まで）
          <textarea rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          タグ（英小文字・数字・ハイフン、8 個まで、空白か読点で区切る）
          <input value={tags} placeholder="history, temple" onChange={(e) => setTags(e.target.value)} />
        </label>
        <label>
          地域（geohash の接頭辞、8 個まで。空欄はどこでも）
          <input value={regions} placeholder="xn7" onChange={(e) => setRegions(e.target.value)} />
        </label>
        <label>
          運用者への説明（審査のときに読まれます）
          <textarea rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button disabled={!zip || !icon || !keyText || !passphrase || (progress !== undefined && !progress.startsWith('版'))}>署名して申請する</button>
        {progress && <p role="status">{progress}</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </section>
  );
}
