// Storage transport — the abstraction that lets margo run in either local
// mode (comments as files in the user's repo, history via git) or server
// mode (comments live on a margo server, repo stays clean). Handlers in
// `../server/handlers.ts` are written against this interface so they don't
// care which backend persists the comment files.
//
// Two implementations:
//   - LocalTransport (./local-transport.ts) — current behavior: read/write
//     `.margo/comments/*.md` on disk, commit via background git queue.
//   - RemoteTransport (planned) — HTTP client against a margo server's
//     `/api/projects/:project/...` endpoints.
//
// Git state (the user's working-repo commit/branch/dirty status, used for
// pin diagnostics) is intentionally NOT part of this interface — it's a
// property of the user's code repo, not the comment store, and reads from
// `ctx.rootDir` directly even in server mode.

import type { Comment } from '../shared/types.js'

/** Thrown by `write` when the caller passed `opts.ifMatch` and the stored
 *  content's current ETag doesn't match. Carries the server's current
 *  ETag so callers can refetch and decide whether to merge or surface
 *  the conflict to the user. */
export class ConflictError extends Error {
  constructor(public readonly currentEtag: string | null, public readonly id: string) {
    super(`conflict on ${id}: stored content has a different ETag than expected`)
  }
}

/** Identity of the current user — the author recorded on new comments and
 *  replies. Source depends on transport (git config locally, auth token
 *  remotely). `role` is only populated in server mode and reflects the
 *  user's membership on the workspace's configured project — `null` when
 *  they're authenticated but not a member. `projectExists` lets the UI
 *  separate "I typo'd the slug" (false) from "project's real, I just
 *  need access" (true + role:null). */
export interface Identity {
  email: string
  name: string
  role?: 'read' | 'write' | 'admin' | null
  projectExists?: boolean
}

/** Event the transport pushes back when comments change underneath us.
 *  Locally fired by the filesystem watcher; remotely by the server's SSE
 *  stream. Wire-compatible with the overlay's existing SyncEvent vocab. */
export type ChangeEvent =
  | { type: 'created'; id: string }
  | { type: 'updated'; id: string }
  | { type: 'deleted'; id: string }

/** Snapshot of upstream changes a local-mode poller has detected but not
 *  pulled. Server mode never produces this — the server is authoritative
 *  so there's no "behind upstream" notion. Optional on the transport;
 *  consumers check capability before subscribing. */
export interface RemoteChanges {
  added: string[]
  modified: string[]
  deleted: string[]
  total: number
}

/** Listener for "we detected new teammate comments on upstream but haven't
 *  pulled" events. Only meaningful in local mode. */
export type RemoteChangesListener = (payload: RemoteChanges | null) => void

export interface Transport {
  // ─── Comment CRUD ─────────────────────────────────────────────────────

  /** Return every comment currently in the store. Order is implementation-
   *  defined; handlers sort for display. */
  list(): Promise<Comment[]>

  /** Read one comment by id, or null if it doesn't exist. */
  read(id: string): Promise<Comment | null>

  /** Persist a comment's raw .md content (frontmatter + body). Implementations
   *  trigger history-recording side effects asynchronously (local: enqueue
   *  git commit; remote: server commits internally on receive).
   *
   *  When `opts.ifMatch` is supplied, the implementation MUST refuse the
   *  write if the stored content has a different ETag than the one the
   *  caller is holding. Throws ConflictError on mismatch — callers
   *  handle by refetching and merging. Implementations without real
   *  optimistic-concurrency support (LocalTransport) MAY ignore the hint
   *  silently. */
  write(id: string, raw: string, commitMessage: string, opts?: { ifMatch?: string }): Promise<void>

  /** Remove a comment. Same async-history semantics as `write`. */
  remove(id: string, commitMessage: string): Promise<void>

  // ─── Decisions log ────────────────────────────────────────────────────

  /** Append a one-line decision entry. The transport knows where the file
   *  lives (next to comments) and handles its history. */
  appendDecision(entry: string, commitMessage: string): Promise<void>

  // ─── Identity ─────────────────────────────────────────────────────────

  /** Identity of the current user, or null if not configured. */
  getIdentity(): Promise<Identity | null>

  /** Set identity. In local mode writes to git config; in server mode
   *  bound to the auth token's identity and may throw. */
  setIdentity(info: Identity): Promise<void>

  /** Optional declared-role lookup for the current user. Local: reads
   *  `git config margo.role`. Remote: reads the server's project roster.
   *  Returns the role string ('pm' | 'designer' | 'dev' | etc.) or null. */
  getDeclaredRole(email: string): Promise<string | null>

  // ─── Sync ─────────────────────────────────────────────────────────────

  /** Pull changes from upstream. Local: `git pull --rebase`. Remote:
   *  re-fetches all comments from the server. Idempotent. */
  sync(): Promise<void>

  // ─── Subscriptions ────────────────────────────────────────────────────

  /** Subscribe to comment-change events. Returns an unsubscribe function.
   *  Implementations may start their own watcher/SSE connection lazily on
   *  first subscribe and tear it down on last unsubscribe. */
  subscribe(handler: (ev: ChangeEvent) => void): () => void

  /** Subscribe to upstream-divergence events. Only meaningful in local
   *  mode; remote transports may noop. The most recent payload (or null)
   *  is passed to the listener immediately on subscribe for late joiners. */
  subscribeRemoteChanges(listener: RemoteChangesListener): () => void

  /** Last known remote-changes snapshot, for handlers that need to replay
   *  it to newly-connected SSE clients without going through a fresh tick.
   *  Returns null when nothing is incoming or when the transport doesn't
   *  track upstream state. */
  getLastRemoteChanges(): RemoteChanges | null

  /** Reset the cached remote-changes snapshot after a successful sync —
   *  the "N new comments" banner shouldn't replay to tabs that connect
   *  after the pull. Noop on transports that don't track upstream state. */
  resetRemoteChanges(): void

  /** Free resources (file watchers, polling timers, network connections).
   *  Called on dev-server shutdown. */
  close(): Promise<void>
}
