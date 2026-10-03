import type { Schemas } from '@sanpo-console/api-types';
import { type Api } from './api';
import { type Auth, type ConsoleConfig } from './auth';
import './style.css';
interface Session {
    config: ConsoleConfig;
    auth: Auth;
    api: Api;
    me: Schemas['Me'];
}
export declare function useSession(): Session;
export {};
