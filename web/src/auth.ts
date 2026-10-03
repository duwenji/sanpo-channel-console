import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';

/** Written next to the SPA at deployment (infra/lib/console-app.ts). */
export interface ConsoleConfig {
  authority: string;
  clientId: string;
  authDomain: string;
  environment: 'dev' | 'prod';
}

export async function loadConfig(): Promise<ConsoleConfig> {
  const res = await fetch('/config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('config.json を読めませんでした');
  return (await res.json()) as ConsoleConfig;
}

/**
 * Sign-in with Cognito's managed login: authorization code with PKCE, no client secret.
 * Tokens stay in sessionStorage (gone when the tab closes), not localStorage (aws-auth).
 */
export function createAuth(config: ConsoleConfig) {
  const origin = window.location.origin;
  const manager = new UserManager({
    authority: config.authority,
    client_id: config.clientId,
    redirect_uri: `${origin}/callback`,
    post_logout_redirect_uri: `${origin}/`,
    response_type: 'code',
    scope: 'openid email profile',
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    automaticSilentRenew: true,
  });

  return {
    manager,
    signIn: () => manager.signinRedirect({ state: window.location.pathname }),
    /** Finishes the redirect back from Cognito and returns where the user was going. */
    finishSignIn: async (): Promise<string> => {
      const user = await manager.signinRedirectCallback();
      return typeof user.state === 'string' && user.state.startsWith('/') ? user.state : '/';
    },
    /** Cognito has no OIDC end-session endpoint; its own /logout ends the managed login session. */
    signOut: async () => {
      await manager.removeUser();
      const url = new URL('/logout', config.authDomain);
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('logout_uri', `${origin}/`);
      window.location.assign(url.toString());
    },
    user: (): Promise<User | null> => manager.getUser(),
  };
}

export type Auth = ReturnType<typeof createAuth>;
