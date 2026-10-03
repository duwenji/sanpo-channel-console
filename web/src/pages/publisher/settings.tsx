import { useState, type FormEvent } from 'react';
import { describe, ifMatch } from '../../api';
import { useSession } from '../../main';
import { Status, useLoad } from '../common';

/** The publisher's name and contact, and leaving (API-001 C-4). */
export function PublisherSettings() {
  const { api, auth } = useSession();
  const pub = useLoad(async () => (await api.GET('/api/publisher')).data, [api]);
  const [displayName, setDisplayName] = useState('');
  const [contact, setContact] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const p = pub.data;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!p) return;
    setError(undefined);
    try {
      await api.PATCH('/api/publisher', {
        params: { header: ifMatch(p.rev) },
        body: { ...(displayName ? { displayName } : {}), ...(contact ? { contact } : {}) },
      });
      setDisplayName('');
      setContact('');
      setMessage('保存しました');
      pub.reload();
    } catch (err) {
      setError(describe(err));
    }
  };

  const leave = async (e: FormEvent) => {
    e.preventDefault();
    if (!p || !window.confirm('退会すると、公開中のチャンネルはすべて取り下げられ、元に戻せません。退会しますか？')) return;
    try {
      await api.DELETE('/api/publisher', { params: { header: ifMatch(p.rev) }, body: { confirm } });
      await auth.signOut();
    } catch (err) {
      setError(describe(err));
    }
  };

  return (
    <section>
      <h1>設定</h1>
      <Status error={pub.error} loading={pub.loading} />
      {p && (
        <>
          <form className="action" onSubmit={(e) => void save(e)}>
            <h3>表示名と連絡先</h3>
            <label>
              表示名（今: {p.displayName}）
              <input maxLength={40} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>
            <label>
              連絡先（今: {p.contact}）
              <input maxLength={200} value={contact} onChange={(e) => setContact(e.target.value)} />
            </label>
            <button disabled={!displayName && !contact}>保存する</button>
            {message && <p role="status">{message}</p>}
          </form>

          <form className="action" onSubmit={(e) => void leave(e)}>
            <h3>退会する</h3>
            <p className="muted">
              公開中のチャンネルはすべて取り下げられ、表示名と連絡先は消えます。チャンネル ID とアカウントIDは、ほかの人も含めて二度と使えません。
            </p>
            <label>
              確認のため、配信元 ID <code>{p.publisherId}</code> を入れてください
              <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            <button className="danger" disabled={confirm !== p.publisherId}>退会する</button>
          </form>
          {error && <p className="error" role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}
