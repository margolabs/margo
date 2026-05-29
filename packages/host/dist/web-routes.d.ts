import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UserStore } from './user-store.js';
export interface WebContext {
    users: UserStore;
    /** Resolved per request — null on first call, lazily populated when
     *  any web route needs to sign or verify a cookie. */
    sessionSecret: () => Promise<string>;
}
export declare function handleWebRoute(ctx: WebContext, req: IncomingMessage, res: ServerResponse): Promise<boolean>;
