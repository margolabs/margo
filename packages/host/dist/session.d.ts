import type { IncomingMessage, ServerResponse } from 'node:http';
export interface SessionPayload {
    userId: string;
    expiresAt: number;
}
/** Build the `Set-Cookie` value for a freshly authenticated user. */
export declare function issueSessionCookie(userId: string, secret: string): string;
/** Build the `Set-Cookie` value that expires the session immediately. */
export declare function clearSessionCookie(): string;
/** Parse and verify the session cookie from an incoming request.
 *  Returns the payload on success; null on missing/expired/forged. */
export declare function readSession(req: IncomingMessage, secret: string): SessionPayload | null;
/** Write a Set-Cookie header without trampling any existing one. */
export declare function setCookieHeader(res: ServerResponse, value: string): void;
