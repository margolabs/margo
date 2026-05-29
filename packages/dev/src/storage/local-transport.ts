// Local storage backend — comments persist as `.md` files in the user's
// repo, history via the existing git queue + remote-poller machinery.
// Wraps the previously-inlined fs/git calls in handlers.ts behind the
// Transport interface so a future RemoteTransport can swap in without
// touching handler code.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { parseComment } from '../shared/frontmatter.js'
import {
  backgroundPull,
  commitAndPush,
  getAheadBehind as _gitAheadBehind,
  getAuthor,
  getCurrentBranch as _gitCurrentBranch,
  getCurrentCommit as _gitCurrentCommit,
  getDeclaredRole,
  getDirtyState as _gitDirtyState,
  removeAndCommit,
  setAuthor,
  type GitOptions,
} from '../server/git.js'
import { CommentWatcher, type WatcherEvent } from '../server/watcher.js'
import { RemotePoller, type RemoteChangesPayload } from '../server/remote-poller.js'
import type { Comment, MargoConfig } from '../shared/types.js'
import type {
  ChangeEvent,
  Identity,
  RemoteChanges,
  RemoteChangesListener,
  Transport,
} from './transport.js'

export interface LocalTransportOptions {
  /** Repo root — used for git operations and as the base for `.margo/`. */
  rootDir: string
  /** Path to the comments directory. Usually `<rootDir>/.margo/comments`. */
  commentsDir: string
  /** Workspace config — drives autoCommit/autoPush/etc. behavior. */
  config: MargoConfig
}

// Background git queue. Mirrors the prior module-scoped queue in handlers.ts:
// writes flush to disk first, then the commit/push runs serialized via this
// promise chain. Keep it module-scoped (not per-instance) — one queue per
// process is correct since git ops on the same repo can't run in parallel
// without lock contention.
let gitQueue: Promise<unknown> = Promise.resolve()

function enqueueGitOp(label: string, op: () => Promise<unknown>): void {
  gitQueue = gitQueue
    .catch(() => undefined)
    .then(() => op().catch((err) => {
      console.error(`[margo] background git op failed (${label}):`, (err as Error).message)
    }))
}

export class LocalTransport implements Transport {
  private readonly commentsDir: string
  private readonly rootDir: string
  private readonly config: MargoConfig
  private watcher?: CommentWatcher
  private poller?: RemotePoller
  private readonly changeListeners = new Set<(ev: ChangeEvent) => void>()
  private readonly remoteListeners = new Set<RemoteChangesListener>()

  constructor(opts: LocalTransportOptions) {
    this.rootDir = opts.rootDir
    this.commentsDir = opts.commentsDir
    this.config = opts.config
  }

  // ─── Comment CRUD ───────────────────────────────────────────────────────

  async list(): Promise<Comment[]> {
    let files: string[]
    try {
      files = (await fs.readdir(this.commentsDir)).filter((f) => f.endsWith('.md'))
    } catch {
      return []
    }
    const comments: Comment[] = []
    for (const f of files) {
      const full = path.join(this.commentsDir, f)
      const raw = await fs.readFile(full, 'utf8')
      try {
        comments.push(parseComment(raw, full))
      } catch {
        // Malformed file — skip rather than crash. The overlay surfaces a banner.
      }
    }
    return comments
  }

  async read(id: string): Promise<Comment | null> {
    const file = path.join(this.commentsDir, `${id}.md`)
    try {
      const raw = await fs.readFile(file, 'utf8')
      return parseComment(raw, file)
    } catch {
      return null
    }
  }

  async write(id: string, raw: string, commitMessage: string): Promise<void> {
    const file = path.join(this.commentsDir, `${id}.md`)
    await fs.mkdir(this.commentsDir, { recursive: true })
    await fs.writeFile(file, raw, 'utf8')
    enqueueGitOp(`write ${id}`, () =>
      commitAndPush([file], commitMessage, this.gitOpts()),
    )
  }

  async remove(id: string, commitMessage: string): Promise<void> {
    const file = path.join(this.commentsDir, `${id}.md`)
    await fs.unlink(file).catch(() => { /* already gone is fine */ })
    enqueueGitOp(`remove ${id}`, () =>
      removeAndCommit([file], commitMessage, this.gitOpts()),
    )
  }

  // ─── Decisions log ──────────────────────────────────────────────────────

  async appendDecision(entry: string, commitMessage: string): Promise<void> {
    // .margo/decisions.md lives next to the comments dir.
    const file = path.join(path.dirname(this.commentsDir), 'decisions.md')
    let content: string
    try {
      content = await fs.readFile(file, 'utf8')
    } catch {
      content = [
        '# Decisions log',
        '',
        'Resolved comments distilled to one-line decisions. Newest first.',
        'Each entry references the source comment in `.margo/comments/<id>.md`.',
        '',
      ].join('\n')
    }
    // Insert before the first existing list item (newest-first ordering).
    const lines = content.split('\n')
    let insertAt = lines.length
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('- ')) { insertAt = i; break }
    }
    lines.splice(insertAt, 0, entry)
    let next = lines.join('\n')
    if (!next.endsWith('\n')) next += '\n'

    await fs.writeFile(file, next, 'utf8')
    enqueueGitOp('decisions log', () =>
      commitAndPush([file], commitMessage, this.gitOpts()),
    )
  }

  // ─── Identity ───────────────────────────────────────────────────────────

  async getIdentity(): Promise<Identity | null> {
    try {
      const author = await getAuthor(this.rootDir)
      return { email: author.email, name: author.name }
    } catch {
      return null
    }
  }

  async setIdentity(info: Identity): Promise<void> {
    await setAuthor(info.name, info.email, this.rootDir)
  }

  async getDeclaredRole(_email: string): Promise<string | null> {
    // Local mode reads from git config — the email parameter is unused
    // here (git config is per-checkout, not per-email). Kept in the
    // signature for parity with the remote transport's roster lookup.
    const role = await getDeclaredRole(this.rootDir)
    return role ?? null
  }

  // ─── Sync ───────────────────────────────────────────────────────────────

  async sync(): Promise<void> {
    await backgroundPull(this.rootDir)
  }

  // ─── Subscriptions ──────────────────────────────────────────────────────

  subscribe(handler: (ev: ChangeEvent) => void): () => void {
    this.changeListeners.add(handler)
    this.ensureWatcher()
    return () => {
      this.changeListeners.delete(handler)
    }
  }

  subscribeRemoteChanges(listener: RemoteChangesListener): () => void {
    this.remoteListeners.add(listener)
    this.ensurePoller()
    // Replay the most recent payload so late joiners see the banner.
    const last = this.poller?.getLastPayload() ?? null
    listener(last ? toRemoteChanges(last) : null)
    return () => {
      this.remoteListeners.delete(listener)
    }
  }

  getLastRemoteChanges(): RemoteChanges | null {
    const last = this.poller?.getLastPayload() ?? null
    return last ? toRemoteChanges(last) : null
  }

  resetRemoteChanges(): void {
    this.poller?.reset()
  }

  async close(): Promise<void> {
    await this.watcher?.stop()
    this.poller?.stop()
    this.watcher = undefined
    this.poller = undefined
    this.changeListeners.clear()
    this.remoteListeners.clear()
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private ensureWatcher(): void {
    if (this.watcher) return
    const w = new CommentWatcher(this.commentsDir)
    w.on('event', (e: WatcherEvent) => {
      for (const fn of this.changeListeners) fn(e)
    })
    w.start()
    this.watcher = w
  }

  private ensurePoller(): void {
    if (this.poller) return
    const p = new RemotePoller(this.rootDir, this.config.git.remotePollIntervalMs)
    p.on('event', (payload: RemoteChangesPayload) => {
      const snapshot = toRemoteChanges(payload)
      for (const fn of this.remoteListeners) fn(snapshot)
    })
    p.start()
    this.poller = p
  }

  private gitOpts(): GitOptions {
    return {
      cwd: this.rootDir,
      commitPrefix: this.config.git.commitPrefix,
      autoCommit: this.config.git.autoCommit,
      autoPush: this.config.git.autoPush,
      pullBeforePush: this.config.git.pullBeforePush,
    }
  }
}

function toRemoteChanges(payload: RemoteChangesPayload): RemoteChanges {
  return {
    added: payload.added,
    modified: payload.modified,
    deleted: payload.deleted,
    total: payload.total,
  }
}
