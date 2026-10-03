import { UserManager, type User } from 'oidc-client-ts';
/** Written next to the SPA at deployment (infra/lib/console-app.ts). */
export interface ConsoleConfig {
    authority: string;
    clientId: string;
    authDomain: string;
    environment: 'dev' | 'prod';
}
export declare function loadConfig(): Promise<ConsoleConfig>;
/**
 * Sign-in with Cognito's managed login: authorization code with PKCE, no client secret.
 * Tokens stay in sessionStorage (gone when the tab closes), not localStorage (aws-auth).
 */
export declare function createAuth(config: ConsoleConfig): {
    manager: UserManager;
    signIn: () => Promise<void>;
    /** Finishes the redirect back from Cognito and returns where the user was going. */
    finishSignIn: () => Promise<string>;
    /** Cognito has no OIDC end-session endpoint; its own /logout ends the managed login session. */
    signOut: () => Promise<void>;
    user: () => Promise<User | null>;
};
export type Auth = ReturnType<typeof createAuth>;
