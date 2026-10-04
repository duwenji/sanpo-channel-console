import { unzipSync } from 'fflate';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { Schemas } from '@sanpo-console/api-types';
import { describe, ifMatch } from '../api';
import { useSession } from '../main';
import { AI_SERVICES, listModels, reply, type AiService } from '../ai';
import { Empty, Status, Time, useLoad } from './common';

/** The review policy's items (SanpoGuide docs/channel-review-policy.md), for findings. */
const ITEMS: [string, string][] = [
  ['1', '1 機械で確かめる項目'],
  ['2.1', '2.1 語り口と内容'],
  ['2.2', '2.2 安全'],
  ['2.3', '2.3 プライバシー'],
  ['2.4', '2.4 宣伝'],
  ['2.5', '2.5 AI への指示の書き方'],
  ['2.6', '2.6 素材ときっかけ'],
  ['2.7', '2.7 話させた見本'],
];

const STATE: Record<string, string> = { awaiting_review: '審査待ち', in_review: '審査中', approved: '承認', returned: '差し戻し', rejected: '却下', withdrawn: '取り消し' };

export function ReviewQueuePage() {
  const { api } = useSession();
  const queue = useLoad(async () => (await api.GET('/api/admin/review-queue', { params: { query: { limit: 50 } } })).data, [api]);
  return (
    <section>
      <h1>審査</h1>
      <p className="muted">機械の確認に合格した申請が、古い順に並びます。審査基準: SanpoGuide の channel-review-policy.md。</p>
      <Status error={queue.error} loading={queue.loading} />
      {queue.data?.items.length === 0 && <Empty>審査待ちの申請はありません。</Empty>}
      {queue.data && queue.data.items.length > 0 && (
        <table>
          <thead>
            <tr><th>チャンネル</th><th>版</th><th>状態</th><th>審査待ちになった日時</th></tr>
          </thead>
          <tbody>
            {queue.data.items.map((s) => (
              <tr key={s.submissionId}>
                <td><Link to={`/review/${s.channelId}/${s.submissionId}`}><code>{s.channelId}</code></Link></td>
                <td>{s.version}</td>
                <td><span className={`tag ${s.state}`}>{STATE[s.state] ?? s.state}</span></td>
                <td><Time value={s.submittedAt} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

interface Sample {
  scenarioId: string;
  label: string;
  output: string;
}

export function ReviewPage() {
  const { api } = useSession();
  const { channelId = '', submissionId = '' } = useParams();
  const path = { channelId, submissionId };
  const sub = useLoad(async () => (await api.GET('/api/channels/{channelId}/submissions/{submissionId}', { params: { path } })).data, [api, channelId, submissionId]);
  const reviews = useLoad(async () => (await api.GET('/api/admin/channels/{channelId}/submissions/{submissionId}/reviews', { params: { path } })).data, [api, channelId, submissionId]);
  const [error, setError] = useState<string>();
  // Samples saved on this page, attached to the decision.
  const [samplesIds, setSamplesIds] = useState<string[]>([]);
  const s = sub.data;
  const act = (work: () => Promise<unknown>) => () => {
    setError(undefined);
    work().then(() => { sub.reload(); reviews.reload(); }, (e: unknown) => setError(describe(e)));
  };

  return (
    <section>
      <p><Link to="/review">← 審査の一覧</Link></p>
      <h1>
        <code>{channelId}</code> {s?.version !== undefined && s?.version !== null && `版 ${s.version}`}
      </h1>
      <Status error={sub.error} loading={sub.loading} />
      {error && <p className="error" role="alert">{error}</p>}
      {s && (
        <>
          <dl className="facts">
            <dt>状態</dt>
            <dd><span className={`tag ${s.state}`}>{STATE[s.state] ?? s.state}</span></dd>
            <dt>配信元のアカウントID</dt>
            <dd><code>{s.accountId}</code></dd>
            <dt>説明・タグ・地域</dt>
            <dd>{s.description ?? '—'} ／ {(s.tags ?? []).join('、') || '—'} ／ {(s.regions ?? []).join('、') || '—'}</dd>
            <dt>運用者への説明</dt>
            <dd>{s.note ?? '—'}</dd>
            <dt>機械の確認</dt>
            <dd>{s.validation?.ok ? `合格（${s.validation.validatorVersion}）` : '—'}</dd>
            <dt>パッケージ</dt>
            <dd><code title={s.sha256 ?? ''}>{s.sha256?.slice(0, 12)}…</code> {s.size} バイト</dd>
          </dl>
          {s.state === 'awaiting_review' && (
            <button onClick={act(() => api.POST('/api/admin/channels/{channelId}/submissions/{submissionId}/start', { params: { path, header: ifMatch(s.rev) } }))}>審査を始める</button>
          )}
          {s.state === 'in_review' && (
            <button className="link" onClick={act(() => api.POST('/api/admin/channels/{channelId}/submissions/{submissionId}/release', { params: { path, header: ifMatch(s.rev) } }))}>
              審査を戻す（ほかの運用者に任せる）
            </button>
          )}
          <PackageView channelId={channelId} submissionId={submissionId} />
          {s.state === 'in_review' && <Samples channelId={channelId} submissionId={submissionId} onSaved={(id) => { setSamplesIds((ids) => [...ids, id]); reviews.reload(); }} />}
          {s.state === 'in_review' && <Decision sub={s} samplesIds={samplesIds} onDone={() => { setSamplesIds([]); sub.reload(); reviews.reload(); }} />}
          {s.decision && (
            <div className="action">
              <h3>判定</h3>
              <p>{s.decision.action === 'approve' ? '承認' : s.decision.action === 'return' ? '差し戻し' : '却下'}（<Time value={s.decision.at} />）{s.decision.message && `: ${s.decision.message}`}</p>
              <ul>{(s.decision.findings ?? []).map((f) => <li key={f.item + f.detail}>{f.item}: {f.detail}</li>)}</ul>
            </div>
          )}
        </>
      )}
      <h2>審査の記録</h2>
      <Status error={reviews.error} loading={reviews.loading} />
      {reviews.data?.items.length === 0 && <Empty>まだ記録はありません。</Empty>}
      <ul className="plain">
        {reviews.data?.items.map((r) => (
          <li key={r.at}>
            <Time value={r.at} /> <code>{r.action}</code> {r.message}
            {(r.findings ?? []).map((f) => <div key={f.item + f.detail} className="small">{f.item}: {f.detail}</div>)}
            {(r.samples ?? []).map((x) => (
              <details key={x.samplesId}>
                <summary>見本（{x.service} {x.model}）</summary>
                {(x.items ?? []).map((i) => <p key={String(i.scenarioId)} className="small"><code>{i.scenarioId}</code> {i.output}</p>)}
              </details>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The package's files and icon, unpacked in the browser from short-lived URLs. */
function PackageView({ channelId, submissionId }: { channelId: string; submissionId: string }) {
  const { api } = useSession();
  const [files, setFiles] = useState<[string, string][]>();
  const [icon, setIcon] = useState<string>();
  const [error, setError] = useState<string>();
  const open = async () => {
    setError(undefined);
    try {
      const { data } = await api.GET('/api/admin/channels/{channelId}/submissions/{submissionId}/package', { params: { path: { channelId, submissionId } } });
      if (!data) return;
      setIcon(data.iconUrl);
      const zip = new Uint8Array(await (await fetch(data.packageUrl)).arrayBuffer());
      const decoder = new TextDecoder();
      setFiles(
        Object.entries(unzipSync(zip))
          .filter(([name]) => !name.endsWith('/'))
          .map(([name, bytes]) => [name, name === 'channel.json' ? JSON.stringify(JSON.parse(decoder.decode(bytes)), null, 2) : decoder.decode(bytes)]),
      );
    } catch (e) {
      setError(describe(e));
    }
  };
  return (
    <div className="action">
      <h3>パッケージの中身</h3>
      {!files && <button onClick={() => void open()}>開く</button>}
      {error && <p className="error">{error}</p>}
      {icon && <img src={icon} alt="チャンネルのアイコン" width={64} height={64} />}
      {files?.map(([name, text]) => (
        <details key={name} open={name === 'channel.json'}>
          <summary><code>{name}</code></summary>
          <pre className="copy">{name === 'signature.json' ? '（配信元の署名。機械の確認で検証済み）' : text}</pre>
        </details>
      ))}
    </div>
  );
}

/** Has the AI speak the review policy's scenes with the operator's key (審査基準 2.7). */
function Samples({ channelId, submissionId, onSaved }: { channelId: string; submissionId: string; onSaved: (samplesId: string) => void }) {
  const { api } = useSession();
  const [service, setService] = useState<AiService>(AI_SERVICES[0]!);
  // One key per service, in this page's memory only.
  const [keys, setKeys] = useState<Record<string, string>>({});
  const key = keys[service.id] ?? '';
  const [models, setModels] = useState<string[]>();
  const [model, setModel] = useState('');
  const [samples, setSamples] = useState<Sample[]>([]);
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  const run = async () => {
    setError(undefined);
    setSamples([]);
    try {
      const { data } = await api.GET('/api/admin/channels/{channelId}/submissions/{submissionId}/sample-prompts', { params: { path: { channelId, submissionId } } });
      if (!data) return;
      const out: Sample[] = [];
      for (const [i, scene] of data.scenarios.entries()) {
        setProgress(`${i + 1} / ${data.scenarios.length}: ${scene.label}`);
        out.push({ scenarioId: scene.id, label: scene.label, output: await reply(service, key, model, scene.system, scene.user) });
        setSamples([...out]);
      }
      setProgress(undefined);
    } catch (e) {
      setProgress(undefined);
      setError(describe(e));
    }
  };
  const save = async () => {
    try {
      const { data } = await api.POST('/api/admin/channels/{channelId}/submissions/{submissionId}/samples', {
        params: { path: { channelId, submissionId } },
        body: { service: service.id, model, items: samples.map(({ scenarioId, output }) => ({ scenarioId, output })) },
      });
      setSamples([]);
      if (data) onSaved(data.samplesId);
    } catch (e) {
      setError(describe(e));
    }
  };
  return (
    <div className="action">
      <h3>話させた見本（審査基準 2.7）</h3>
      <p className="muted">
        あなたの API キーで、ブラウザから直接 AI を呼びます。キーはこのページの中だけに置き、管理システムには送りません。ページを開き直すと消えます。審査基準 2.7 のとおり、2 つのサービスで試してください。
      </p>
      <div className="inline">
        {AI_SERVICES.map((sv) => (
          <label key={sv.id}>
            <input type="radio" checked={service.id === sv.id} onChange={() => { setService(sv); setModels(undefined); setModel(''); setSamples([]); }} /> {sv.label}
          </label>
        ))}
      </div>
      <label>
        {service.label} の API キー
        <input type="password" autoComplete="off" value={key} onChange={(e) => setKeys((k) => ({ ...k, [service.id]: e.target.value }))} />
      </label>
      <button disabled={!key} onClick={() => void listModels(service, key).then((m) => { setModels(m); setModel(m[0] ?? ''); }, (e: unknown) => setError(describe(e)))}>
        モデルを読み込む
      </button>
      {models && (
        <label>
          モデル{' '}
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      )}
      <button disabled={!key || !model || progress !== undefined} onClick={() => void run()}>見本を作る</button>
      {progress && <p role="status">{progress}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {samples.length > 0 && (
        <>
          <table>
            <thead><tr><th>場面</th><th>AI の返答</th></tr></thead>
            <tbody>{samples.map((x) => <tr key={x.scenarioId}><td>{x.label}</td><td>{x.output}</td></tr>)}</tbody>
          </table>
          <button disabled={progress !== undefined} onClick={() => void save()}>この見本を審査の記録に残す</button>
        </>
      )}
    </div>
  );
}

function Decision({ sub, samplesIds, onDone }: { sub: Schemas['Submission']; samplesIds: string[]; onDone: () => void }) {
  const { api } = useSession();
  const [findings, setFindings] = useState<{ item: string; detail: string }[]>([{ item: '2.1', detail: '' }]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string>();
  const path = { channelId: sub.channelId, submissionId: sub.submissionId };
  const decide = async (action: 'approve' | 'return' | 'reject') => {
    const label = { approve: '承認', return: '差し戻し', reject: '却下' }[action];
    if (!window.confirm(`${label}してよろしいですか？${action === 'approve' ? '\nリストに載り、アプリに届きます。' : ''}`)) return;
    setError(undefined);
    try {
      const filled = findings.filter((f) => f.detail.trim());
      const common = { ...(message ? { message } : {}), ...(samplesIds.length ? { samplesIds } : {}) };
      const params = { path, header: ifMatch(sub.rev) };
      if (action === 'approve') await api.POST('/api/admin/channels/{channelId}/submissions/{submissionId}/approve', { params, body: common });
      else if (action === 'return') await api.POST('/api/admin/channels/{channelId}/submissions/{submissionId}/return', { params, body: { ...common, findings: filled } });
      else await api.POST('/api/admin/channels/{channelId}/submissions/{submissionId}/reject', { params, body: { ...common, findings: filled } });
      onDone();
    } catch (e) {
      setError(describe(e));
    }
  };
  return (
    <div className="action">
      <h3>判定</h3>
      <p className="muted">差し戻し・却下には、審査基準の項目番号つきの理由を 1 つ以上入れます。理由と説明は配信元に見せます。{samplesIds.length > 0 && ` 残した見本 ${samplesIds.length} 件を判定に付けます。`}</p>
      {findings.map((f, i) => (
        <div key={i} className="inline">
          <select value={f.item} onChange={(e) => setFindings((all) => all.map((x, j) => (j === i ? { ...x, item: e.target.value } : x)))}>
            {ITEMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <input placeholder="理由" value={f.detail} onChange={(e) => setFindings((all) => all.map((x, j) => (j === i ? { ...x, detail: e.target.value } : x)))} />
        </div>
      ))}
      <button className="link" onClick={() => setFindings((all) => [...all, { item: '2.1', detail: '' }])}>理由を足す</button>
      <label>
        配信元への説明
        <textarea rows={2} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} />
      </label>
      <div className="inline">
        <button onClick={() => void decide('approve')}>承認する</button>
        <button onClick={() => void decide('return')} disabled={!findings.some((f) => f.detail.trim())}>差し戻す</button>
        <button className="danger" onClick={() => void decide('reject')} disabled={!findings.some((f) => f.detail.trim())}>却下する</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
