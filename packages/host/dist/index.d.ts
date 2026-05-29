import { UserStore } from './user-store.js';
export interface StartHostOptions {
    port: number;
    dataRoot: string;
    /** UserStore backing token resolution. Caller is responsible for
     *  having loaded it; startHost runs the auto-bootstrap path before
     *  binding the socket if the store is empty and MARGO_HOST_TOKEN is
     *  set. */
    users: UserStore;
}
export interface HostHandle {
    port: number;
    close(): Promise<void>;
}
export declare function startHost(opts: StartHostOptions): Promise<HostHandle>;
