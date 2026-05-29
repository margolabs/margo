import type { IncomingMessage } from 'node:http';
import type { Role, UserRecord, UserStore } from './user-store.js';
export interface AuthIdentity {
    email: string;
    name: string;
}
export interface AuthConfig {
    /** Look up a presented token and return its owning user. The store
     *  hashes the token and matches it against persisted tokens; revoked
     *  tokens never resolve. */
    users: UserStore;
}
export declare class AuthError extends Error {
    readonly status: number;
    constructor(status: number, message: string);
}
/**
 * Extract the bearer token and resolve it to the full user record. Throws
 * AuthError on missing/malformed/wrong tokens. Returns the UserRecord
 * (not just identity) so callers can inspect isSuperuser without a
 * second lookup.
 */
export declare function authenticate(req: IncomingMessage, cfg: AuthConfig): Promise<UserRecord>;
/**
 * Project-level authorization. The user must either be a superuser, or
 * have a membership on the project with role >= required. Projects with
 * no record in the store are legacy-open — any authenticated user passes.
 *
 * Throws AuthError(403) on insufficient role, AuthError(404) on a
 * project that doesn't exist on disk (so we don't leak which projects
 * the operator has on file via 403 vs 404 differentiation).
 */
export declare function authorize(cfg: AuthConfig, user: UserRecord, projectSlug: string, required: Role): Promise<void>;
