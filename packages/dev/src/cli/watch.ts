// `margo watch` — long-running auto-sync between the host and the local
// `.margo/comments/` cache. Replaces the manual pull/push cycle for AI
// workflows that want the cache to stay live: edit a comment file,
// changes propagate to the host instantly; teammate edits on the host
// land in the local cache via SSE without any explicit pull.
//
// Echo-loop guard: when an SSE event drives a write into the cache, we
// register the file in a short-lived "expected" set keyed by content
// hash. The chokidar handler ignores changes that match an expected
// hash, which prevents the (push → host echo → write cache → chokidar
// → push) infinite loop.

import chokidar from 'chokidar'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { loadMargoConfig } from '../config/load.js'
import { RemoteTransport } from '../storage/remote-transport.js'
import { ConflictError } from '../storage/transport.js'

export interface WatchOptions {
  cwd: string
}

export async function watch(opts: WatchOptions): Promise<void> {
  const loaded = await loadMargoConfig(opts.cwd)
  if (!loaded || loaded.config.storage !== 'server') {
    console.error('[margo watch] no server-mode margo.config in this workspace.')
    console.error('        Run `margo init --server <url> --project <slug>` first.')
    process.exit(1)
  }
  const server = loaded.config.server
  if (!server) {
    console.error('[margo watch] margo.config has storage: server but no server block.')
    process.exit(1)
  }
  const token = process.env[server.auth.tokenEnv]
  if (!token) {
    console.error(`[margo watch] env var ${server.auth.tokenEnv} is not set.`)
    process.exit(1)
  }
  const commentsDir = path.join(opts.cwd, '.margo', 'comments')
  await fs.mkdir(commentsDir, { recursive: true })

  const transport = new RemoteTransport({
    serverUrl: server.url,
    project: server.project,
    token,
  })

  // Tracks file contents we just wrote ourselves (or just confirmed on
  // disk match the host). Chokidar will fire a 'change' event right
  // after our write; if the new content hashes to an entry in this set,
  // we know it's the same content the host already has and there's
  // nothing to push. Bounded size — we evict on hit so the set doesn't
  // grow unboundedly during long-running sessions.
  const expectedHashes = new Map<string, string>() // file → sha256

  // Same loop-guard idea for deletes. When SSE tells us the host
  // deleted a file, we unlink locally; chokidar fires 'unlink' and the
  // unlink handler must NOT round-trip the delete back to the host.
  const expectedDeletes = new Set<string>()

  const writeCacheFile = async (id: string, raw: string): Promise<void> => {
    const file = path.join(commentsDir, `${id}.md`)
    expectedHashes.set(file, sha256(raw))
    await fs.writeFile(file, raw, 'utf8')
  }

  // Initial pull so the cache reflects the current host state before the
  // chokidar watcher starts firing. Without this, the watcher would see
  // pre-existing local files as "changes" and try to push them.
  console.log('[margo watch] initial pull...')
  const initial = await transport.list()
  for (const c of initial) await writeCacheFile(c.frontmatter.id, c.raw)
  console.log(`[margo watch] cached ${initial.length} comment(s) from host.`)

  // Subscribe to host SSE — incoming changes from teammates / direct
  // host edits land in the cache here. Each event prompts a targeted
  // refetch rather than a full list, so a busy host with many comments
  // doesn't replay everything on every event.
  const unsubscribe = transport.subscribe(async (ev) => {
    try {
      if (ev.type === 'deleted') {
        const file = path.join(commentsDir, `${ev.id}.md`)
        expectedHashes.delete(file)
        expectedDeletes.add(file)
        await fs.unlink(file).catch(() => undefined)
        console.log(`[margo watch] ← host deleted ${ev.id}`)
        return
      }
      const fresh = await transport.read(ev.id)
      if (!fresh) return // raced with a delete
      await writeCacheFile(ev.id, fresh.raw)
      console.log(`[margo watch] ← host ${ev.type} ${ev.id}`)
    } catch (err) {
      console.warn(`[margo watch] failed to sync ${ev.id}: ${(err as Error).message}`)
    }
  })

  // Local watcher — chokidar's awaitWriteFinish coalesces editor saves
  // that touch the file multiple times in quick succession. The
  // ignoreInitial flag is critical: without it, the initial pull above
  // would re-trigger an 'add' event for every cached file we just wrote.
  const watcher = chokidar.watch(path.join(commentsDir, '*.md'), {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 75, pollInterval: 25 },
  })

  const onLocalChange = async (file: string): Promise<void> => {
    try {
      const raw = await fs.readFile(file, 'utf8')
      const hash = sha256(raw)
      const expected = expectedHashes.get(file)
      if (expected === hash) {
        // This change is the SSE echo of our own earlier write — skip
        // the push to break the loop. Evict so a real subsequent edit
        // (same id, different content) is treated normally.
        expectedHashes.delete(file)
        return
      }
      const id = path.basename(file, '.md')
      // Pre-register our outgoing content as expected. The host will
      // echo it back via SSE and we don't want that echo to come back
      // around as another push.
      expectedHashes.set(file, hash)
      const etag = transport.getKnownEtag(id)
      try {
        await transport.write(id, raw, 'pushed via margo watch', etag ? { ifMatch: etag } : undefined)
        console.log(`[margo watch] → host updated ${id}`)
      } catch (err) {
        if (err instanceof ConflictError) {
          // Someone updated the host between our last read and this
          // write. Refetch their version into the cache so the local
          // file converges on the host's truth — preserving consistency
          // over local edit preservation. The lost edit is annoying but
          // the alternative (forcing overwrite) defeats the purpose of
          // having ETags at all.
          const fresh = await transport.read(id)
          if (fresh) {
            await writeCacheFile(id, fresh.raw)
            console.warn(`[margo watch] CONFLICT on ${id}: host had a newer version, replaced local file. Your edit is lost.`)
          } else {
            console.warn(`[margo watch] CONFLICT on ${id}: comment was deleted on host; removing local file.`)
            await fs.unlink(file).catch(() => undefined)
          }
        } else {
          throw err
        }
      }
    } catch (err) {
      console.warn(`[margo watch] push failed for ${file}: ${(err as Error).message}`)
    }
  }

  const onLocalDelete = async (file: string): Promise<void> => {
    expectedHashes.delete(file)
    if (expectedDeletes.has(file)) {
      // The unlink we just observed came from our own SSE handler
      // mirroring a host-side delete. Don't round-trip it.
      expectedDeletes.delete(file)
      return
    }
    const id = path.basename(file, '.md')
    try {
      await transport.remove(id, 'deleted via margo watch')
      console.log(`[margo watch] → host deleted ${id}`)
    } catch (err) {
      console.warn(`[margo watch] delete failed for ${id}: ${(err as Error).message}`)
    }
  }

  watcher.on('add', (f) => void onLocalChange(f))
  watcher.on('change', (f) => void onLocalChange(f))
  watcher.on('unlink', (f) => void onLocalDelete(f))

  console.log(`[margo watch] watching ${commentsDir} ↔ ${server.url}/${server.project}. Ctrl-C to stop.`)

  const shutdown = async (): Promise<void> => {
    unsubscribe()
    await watcher.close()
    await transport.close()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())

  // Keep the event loop alive — chokidar + the fetch streaming above
  // already hold handles, but an explicit no-op is clearer about intent.
  await new Promise<void>(() => { /* run forever */ })
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}
