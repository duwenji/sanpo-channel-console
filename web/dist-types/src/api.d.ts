import type { Problem, paths } from '@sanpo-console/api-types';
import type { Auth } from './auth';
/** A failed call, with the API's Problem Details (API-001 C-2). */
export declare class ApiProblem extends Error {
    readonly problem: Problem;
    constructor(problem: Problem);
}
/** What to show the operator for a failed call: our wording plus the server's detail. */
export declare function describe(e: unknown): string;
export declare function createApi(auth: Auth): import("openapi-fetch").Client<paths, `${string}/${string}`>;
export type Api = ReturnType<typeof createApi>;
/** The `If-Match` value for a resource read earlier (API-001 C-8). */
export declare const ifMatch: (rev: number) => {
    'If-Match': string;
};
