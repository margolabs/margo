// Standalone storage backend — comments as `.md` files in the user's
// home directory, NOT in the project repo. Persists under
// `~/.margo/standalone/<workspace-id>/comments/` so a workspace's
// comment state isn't entangled with its git history.
//
// Two reasons this lives in $HOME instead of the project:
//   1. Users disliked the original local-mode behavior of auto-
//      committing margo edits into the project repo's git history.
//      Moving to $HOME makes the repo trivially clean.
//   2. Two repos opened from different paths but sharing the same
//      workspace id resolve to the same data dir — moving or cloning
//      the repo doesn't lose history.
//
// Standalone mode is for "me + AI, no collaboration." For team
// collaboration, use the server mode (RemoteTransport against a
// self-hostable margo-host).

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseComment } from '../shared/frontmatter.js'
import {
  getAuthor,
  getDeclaredRole,
  setAuthor,
} from '../server/git.js'
import { CommentWatcher, type WatcherEvent } from '../server/watcher.js'
import type { Comment } from '../shared/types.js'
import type {
  ChangeEvent,
  Identity,
  RemoteChanges,
  RemoteChangesListener,
  Transport,
} from './transport.js'

export interface StandaloneTransportOptions {
  /** Repo root — used for git-config author lookup only (no git writes). */
  rootDir: string
  /** Workspace id from margo.config.json. Resolves to
   *  `~/.margo/standalone/<id>/`. Required and stable across machine
   *  moves so two repos can share workspace data deliberately by sharing
   *  the same id. */
  workspaceId: string
  /** Overrides the resolved data dir. Tests use this to point at a
   *  tmpdir; production code never sets it. */
  dataDirOverride?: string
}

/** Resolve a workspace id to its on-disk data dir. Exported so callers
 *  (init, the AI skill template generator) can show the user where
 *  their comments actually live. */
export function standaloneDataDir(workspaceId: string): string {
  const home = process.env.HOME || os.homedir()
  return path.join(home, '.margo', 'standalone', workspaceId)
}

export class StandaloneTransport implements Transport {
  private readonly commentsDir: string
  private readonly decisionsFile: string
  private readonly dataDir: string
  private readonly rootDir: string
  private watcher?: CommentWatcher
  private readonly changeListeners = new Set<(ev: ChangeEvent) => void>()

  constructor(opts: StandaloneTransportOptions) {
    this.rootDir = opts.rootDir
    this.dataDir = opts.dataDirOverride ?? standaloneDataDir(opts.workspaceId)
    this.commentsDir = path.join(this.dataDir, 'comments')
    this.decisionsFile = path.join(this.dataDir, 'decisions.md')
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

  async write(id: string, raw: string, _commitMessage: string): Promise<void> {
    const file = path.join(this.commentsDir, `${id}.md`)
    await fs.mkdir(this.commentsDir, { recursive: true })
    await fs.writeFile(file, raw, 'utf8')
    // commitMessage is part of the Transport contract (RemoteTransport
    // ignores it, the host generates its own) — standalone mode also
    // ignores it because nothing here commits to git.
  }

  async remove(id: string, _commitMessage: string): Promise<void> {
    const file = path.join(this.commentsDir, `${id}.md`)
    await fs.unlink(file).catch(() => { /* already gone is fine */ })
  }

  // ─── Decisions log ──────────────────────────────────────────────────────

  async appendDecision(entry: string, _commitMessage: string): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
    let content: string
    try {
      content = await fs.readFile(this.decisionsFile, 'utf8')
    } catch {
      content = [
        '# Decisions log',
        '',
        'Resolved comments distilled to one-line decisions. Newest first.',
        '',
      ].join('\n')
    }
    const lines = content.split('\n')
    let insertAt = lines.length
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('- ')) { insertAt = i; break }
    }
    lines.splice(insertAt, 0, entry)
    let next = lines.join('\n')
    if (!next.endsWith('\n')) next += '\n'
    await fs.writeFile(this.decisionsFile, next, 'utf8')
  }

  // ─── Identity ───────────────────────────────────────────────────────────

  async getIdentity(): Promise<Identity | null> {
    // Standalone mode reads author from the user's git config (same as
    // before). The dialog in the overlay prompts when name/email aren't
    // set; setIdentity persists via `git config --global`.
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
    const role = await getDeclaredRole(this.rootDir)
    return role ?? null
  }

  // ─── Sync ───────────────────────────────────────────────────────────────

  async sync(): Promise<void> {
    // No-op in standalone mode — there's no remote to sync against.
    // Kept for Transport-contract parity with RemoteTransport.
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
    // No remote in standalone mode — fire null once so the overlay's
    // banner state clears, then never call again.
    listener(null)
    return () => { /* noop */ }
  }

  getLastRemoteChanges(): RemoteChanges | null {
    return null
  }

  resetRemoteChanges(): void {
    // noop — see subscribeRemoteChanges.
  }

  async close(): Promise<void> {
    await this.watcher?.stop()
    this.watcher = undefined
    this.changeListeners.clear()
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
}
