// Disk → host watcher: detect local edits to a server-mode cache
// directory and push them to the host through the transport. Lives in
// the dev plugin so AI agents can edit a comment file at
// `~/.margo/cache/<host>/<project>/comments/<id>.md` and have the change
// propagate to teammates without manually running `margo push`.
//
// Same shape as the `margo watch` CLI's watcher, but extracted as a
// reusable class so the plugin (vite + next) and the CLI can share the
// echo-loop guard logic — when an SSE-driven write lands in the cache,
// chokidar fires a 'change' event with the same content; without a
// guard the plugin would push that content back to the host and start
// an infinite loop.
//
// Echo-loop guard pattern: callers register the expected content hash
// just before they write the file (via registerExpectedWrite); the
// watcher's onLocalChange handler checks the file's hash against the
// expected set and skips the push when they match. Same idea for
// deletes via registerExpectedDelete.

import chokidar from 'chokidar'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { RemoteTransport } from './remote-transport.js'
import { ConflictError } from './transport.js'

export interface CacheWatcherOptions {
  /** Directory whose .md files should sync to the host. Typically
   *  `<cache>/comments/` under `~/.margo/cache/<host>/<project>/`. */
  commentsDir: string
  /** Active transport — only RemoteTransport is meaningful since this
   *  watcher only runs in server mode. Standalone mode has no host to
   *  push to. */
  transport: RemoteTransport
  /** Optional logger override; defaults to `console`. */
  log?: (level: 'log' | 'warn', message: string) => void
}

export class CacheWatcher {
  private watcher: chokidar.FSWatcher | null = null
  /** content-hash of writes the plugin made itself (or expects to make
   *  imminently via the SSE subscriber). When chokidar fires 'change'
   *  with a matching hash, we skip the push — it's our own echo. */
  private readonly expectedHashes = new Map<string, string>()
  /** Same logic for deletes — when the plugin unlinks a cache file in
   *  response to a host 'deleted' SSE event, chokidar fires 'unlink';
   *  the watcher must NOT round-trip the delete back to the host. */
  private readonly expectedDeletes = new Set<string>()
  private readonly transport: RemoteTransport
  private readonly commentsDir: string
  private readonly log: (level: 'log' | 'warn', message: string) => void

  constructor(opts: CacheWatcherOptions) {
    this.commentsDir = opts.commentsDir
    this.transport = opts.transport
    this.log = opts.log ?? ((level, message) => console[level](`[margo] ${message}`))
  }

  /** Call BEFORE writing `id`'s file in response to a host SSE event.
   *  Registers the content hash so the chokidar 'change' event we're
   *  about to receive doesn't push the same content back to the host. */
  registerExpectedWrite(id: string, content: string): void {
    this.expectedHashes.set(this.fileFor(id), sha256(content))
  }

  /** Call BEFORE unlinking `id`'s file in response to a host 'deleted'
   *  SSE event. */
  registerExpectedDelete(id: string): void {
    this.expectedDeletes.add(this.fileFor(id))
  }

  start(): void {
    if (this.watcher) return
    this.watcher = chokidar.watch(path.join(this.commentsDir, '*.md'), {
      ignoreInitial: true,
      // Coalesce editor multi-write saves so we don't push intermediate
      // states. 75ms matches the `margo watch` CLI and is fast enough
      // that human editors don't notice.
      awaitWriteFinish: { stabilityThreshold: 75, pollInterval: 25 },
    })
    this.watcher.on('change', (f) => void this.onLocalChange(f))
    this.watcher.on('add', (f) => void this.onLocalChange(f))
    this.watcher.on('unlink', (f) => void this.onLocalDelete(f))
  }

  async stop(): Promise<void> {
    await this.watcher?.close()
    this.watcher = null
    this.expectedHashes.clear()
    this.expectedDeletes.clear()
  }

  private fileFor(id: string): string {
    return path.join(this.commentsDir, `${id}.md`)
  }

  private async onLocalChange(file: string): Promise<void> {
    try {
      const raw = await fs.readFile(file, 'utf8')
      const hash = sha256(raw)
      const expected = this.expectedHashes.get(file)
      if (expected === hash) {
        // Echo of our own write — skip the push. Evict the entry so a
        // real subsequent edit (same id, different content) isn't
        // mistaken for another echo.
        this.expectedHashes.delete(file)
        return
      }
      const id = path.basename(file, '.md')
      // Pre-register our outgoing content as expected. The host will
      // echo it back via SSE; the SSE subscriber will overwrite this
      // entry with the same hash; chokidar will fire 'change'; we
      // dedupe via the expected match above.
      this.expectedHashes.set(file, hash)
      const etag = this.transport.getKnownEtag(id)
      try {
        await this.transport.write(
          id,
          raw,
          'edited locally',
          etag ? { ifMatch: etag } : undefined,
        )
        this.log('log', `→ host updated ${id}`)
      } catch (err) {
        if (err instanceof ConflictError) {
          // Someone updated the host between our last read and this
          // write. Refetch their version so the local file converges
          // on the host's truth. The locally-typed edit is annoying
          // but the alternative (force-overwrite) defeats the ETag
          // mechanism entirely.
          const fresh = await this.transport.read(id)
          if (fresh) {
            this.expectedHashes.set(file, sha256(fresh.raw))
            await fs.writeFile(file, fresh.raw, 'utf8')
            this.log('warn', `CONFLICT on ${id}: host had a newer version; local edit lost`)
          } else {
            this.expectedHashes.delete(file)
            this.expectedDeletes.add(file)
            await fs.unlink(file).catch(() => undefined)
            this.log('warn', `CONFLICT on ${id}: comment was deleted on host; removed local file`)
          }
        } else {
          throw err
        }
      }
    } catch (err) {
      this.log('warn', `push failed for ${file}: ${(err as Error).message}`)
    }
  }

  private async onLocalDelete(file: string): Promise<void> {
    this.expectedHashes.delete(file)
    if (this.expectedDeletes.has(file)) {
      // The unlink we just observed came from our own SSE handler
      // mirroring a host-side delete. Don't round-trip it.
      this.expectedDeletes.delete(file)
      return
    }
    const id = path.basename(file, '.md')
    try {
      await this.transport.remove(id, 'deleted locally')
      this.log('log', `→ host deleted ${id}`)
    } catch (err) {
      this.log('warn', `delete failed for ${id}: ${(err as Error).message}`)
    }
  }
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}
