import { StrictMode, createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Route, Routes, useNavigate } from 'react-router';
import type { Schemas } from '@sanpo-console/api-types';
import { createApi, describe, type Api } from './api';
import { createAuth, loadConfig, type Auth, type ConsoleConfig } from './auth';
import { AuditPage } from './pages/audit';
import { ChannelPage } from './pages/channel';
import { HomePage } from './pages/home';
import { KeysPage } from './pages/keys';
import { PublicationsPage } from './pages/publications';
import { PublisherPage, PublishersPage } from './pages/publishers';
import './style.css';

interface Session {
  config: ConsoleConfig;
  auth: Auth;
  api: Api;
  me: Schemas['Me'];
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('no session');
  return session;
}

// The code in the callback URL can be redeemed once; StrictMode runs effects twice in development.
let finishing: Promise<string> | undefined;

function Callback({ auth }: { auth: Auth }) {
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  useEffect(() => {
    finishing ??= auth.finishSignIn();
    finishing.then((to) => navigate(to, { replace: true }), (e: unknown) => setError(String(e)));
  }, [auth, navigate]);
  return error ? <p className="error">ログインできませんでした: {error}</p> : <p>ログインしています…</p>;
}

/** Signs in if needed, then loads who the user is. */
function Gate({ config, auth, children }: { config: ConsoleConfig; auth: Auth; children: (s: Session) => ReactNode }) {
  const [session, setSession] = useState<Session>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    (async () => {
      if (!(await auth.user())) return auth.signIn();
      const api = createApi(auth);
      const { data } = await api.GET('/api/me');
      if (data) setSession({ config, auth, api, me: data });
    })().catch((e: unknown) => setError(describe(e)));
  }, [auth, config]);
  if (error) return <p className="error">{error}</p>;
  if (!session) return <p>読み込んでいます…</p>;
  return <SessionContext.Provider value={session}>{children(session)}</SessionContext.Provider>;
}

const NAV: [string, string][] = [
  ['/', '概要'],
  ['/publications', '公開'],
  ['/keys', '署名鍵・鍵セット'],
  ['/publishers', '配信元'],
  ['/channels', 'チャンネル'],
  ['/audit', '操作の記録'],
];

function Shell({ session }: { session: Session }) {
  const operator = session.me.roles.includes('operator');
  return (
    <div className="shell">
      <header>
        <strong>チャンネル管理</strong>
        {session.config.environment !== 'prod' && <span className="badge">開発用</span>}
        <nav>{operator && NAV.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>)}</nav>
        <button className="link" onClick={() => void session.auth.signOut()}>ログアウト</button>
      </header>
      <main>
        {operator ? (
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/publications" element={<PublicationsPage />} />
            <Route path="/keys" element={<KeysPage />} />
            <Route path="/publishers" element={<PublishersPage />} />
            <Route path="/publishers/:publisherId" element={<PublisherPage />} />
            <Route path="/channels" element={<ChannelPage />} />
            <Route path="/channels/:channelId" element={<ChannelPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="*" element={<p>このページはありません。</p>} />
          </Routes>
        ) : (
          <section>
            <h1>配信元の画面は準備中です</h1>
            <p>このアカウントは運用者ではありません。配信元の申請の画面は、次の段階で用意します。</p>
          </section>
        )}
      </main>
    </div>
  );
}

function App() {
  const [ready, setReady] = useState<{ config: ConsoleConfig; auth: Auth }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    loadConfig().then((config) => setReady({ config, auth: createAuth(config) }), (e: unknown) => setError(String(e)));
  }, []);
  if (error) return <p className="error">{error}</p>;
  if (!ready) return null;
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/callback" element={<Callback auth={ready.auth} />} />
        <Route path="*" element={<Gate config={ready.config} auth={ready.auth}>{(s) => <Shell session={s} />}</Gate>} />
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
