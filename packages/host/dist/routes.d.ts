import type { IncomingMessage, ServerResponse } from 'node:http';
import { type AuthConfig } from './auth.js';
import { ProjectStore } from './store.js';
export interface SseSubscriber {
    write(payload: string): void;
}
export interface RoutesContext {
    store: ProjectStore;
    auth: AuthConfig;
    /** SSE subscribers keyed by project — events stay scoped so subscribers
     *  in project A don't get notified about project B. */
    sseClients: Map<string, Set<SseSubscriber>>;
    /** Broadcast a payload to every subscriber of the given project. */
    broadcast(project: string, payload: unknown): void;
}
export declare function dispatch(ctx: RoutesContext, req: IncomingMessage, res: ServerResponse): Promise<void>;
