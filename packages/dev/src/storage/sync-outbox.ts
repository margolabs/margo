// Disk-backed outbox of operations queued for the margo host while it's
// unreachable. Enables offline-first server mode: the plugin always
// writes to the local cache first, then either pushes immediately (host
// up) or appends to the outbox (host down). A background drainer
// retries outbox entries until they succeed.
//
// Why files, not in-memory:
//   - Dev server restarts (vite HMR can crash, plugin can be re-imported,
//     a teammate may close the laptop). In-memory queue would lose the
//     user's pin between sessions.
//   - A single JSON file would risk corruption mid-write. One file per
//     op is simpler, atomic via rename, and naturally preserves order
//     via filename timestamps.
//
// On-disk shape:
//   <cache>/.outbox/<ISO-timestamp>-<random>-<op>-<id>.json
//   {
//     "op": "write" | "remove" | "decision",
//     "id": "c-abc123",
//     "payload": "<raw markdown OR decision-log entry>",
//     "commitMessage": "comment c-abc123 by alice@…",
//     "ifMatchEtag": null | "<etag>",
//     "enqueuedAt": "2026-06-02T..."
//   }
//
// Order is preserved by reading filenames sorted lexicographically —
// timestamp prefix puts older entries first.

import * as fs from 'node:fs/promises'
import * as crypto from 'node:crypto'
import * as path from 'node:path'

export interface OutboxEntry {
  op: 'write' | 'remove' | 'decision'
  /** Comment id for write/remove. Literal "decisions" for decision-log entries. */
  id: string
  /** Raw markdown for write; entry line for decision; empty for remove. */
  payload: string
  commitMessage: string
  /** Last-known ETag (if any) for an UPDATE-via-write. CREATE writes
   *  have no etag. */
  ifMatchEtag: string | null
  enqueuedAt: string
}

export interface OutboxEntryFile extends OutboxEntry {
  /** Absolute path of the outbox file backing this entry. Used by the
   *  drainer to delete it after a successful retry. */
  _file: string
}

export class SyncOutbox {
  private readonly dir: string

  constructor(cacheRoot: string) {
    this.dir = path.join(cacheRoot, '.outbox')
  }

  /** Persist an op for later retry. File mode 0600 — same as the
   *  credentials file. */
  async enqueue(entry: OutboxEntry): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    const stamp = entry.enqueuedAt.replace(/[:.]/g, '-')
    const rand = crypto.randomBytes(3).toString('hex')
    const filename = `${stamp}-${rand}-${entry.op}-${sanitizeId(entry.id)}.json`
    const file = path.join(this.dir, filename)
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 })
    await fs.rename(tmp, file)
  }

  /** Read all pending entries, oldest first. The filename's leading
   *  timestamp drives the sort. */
  async list(): Promise<OutboxEntryFile[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.dir)
    } catch {
      return []
    }
    names = names.filter((n) => n.endsWith('.json')).sort()
    const out: OutboxEntryFile[] = []
    for (const name of names) {
      const file = path.join(this.dir, name)
      try {
        const raw = await fs.readFile(file, 'utf8')
        const parsed = JSON.parse(raw) as OutboxEntry
        out.push({ ...parsed, _file: file })
      } catch {
        // Malformed file — leave it on disk; surface to ops via the
        // pending count being "stuck."
      }
    }
    return out
  }

  /** Remove an entry after a successful retry. */
  async remove(entry: OutboxEntryFile): Promise<void> {
    await fs.unlink(entry._file).catch(() => undefined)
  }

  /** Total pending count. Surfaced to the overlay via /__margo/sync-status
   *  so the user sees an unsynced banner without polling list(). */
  async count(): Promise<number> {
    try {
      const names = await fs.readdir(this.dir)
      return names.filter((n) => n.endsWith('.json')).length
    } catch {
      return 0
    }
  }

  /** Wipe everything. Used by the overlay's "discard pending" affordance
   *  for the user who'd rather start fresh than keep retrying. */
  async clear(): Promise<number> {
    let removed = 0
    try {
      const names = await fs.readdir(this.dir)
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        await fs.unlink(path.join(this.dir, name)).catch(() => undefined)
        removed++
      }
    } catch {
      // Directory doesn't exist yet — nothing to do.
    }
    return removed
  }
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64)
}
