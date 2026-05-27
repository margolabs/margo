// `margo pull` / `margo push` — bridge between server-mode storage and
// AI's existing "read .md files from .margo/comments/" workflow.
//
// In local mode, AI just reads/edits .margo/comments/*.md directly from
// the working tree. In server mode those files live on the host. These
// commands mirror them into a gitignored local cache so the AI flow
// doesn't change shape — only the storage backend does.
//
// Typical AI session in server mode:
//   margo pull              # download fresh state from host
//   # (AI reads .margo/comments/*.md, edits as needed, commits code)
//   margo push              # upload AI's comment edits back to host

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { loadMargoConfig } from '../config/load.js'
import { RemoteTransport } from '../storage/remote-transport.js'

interface SyncContext {
  cwd: string
  transport: RemoteTransport
  commentsDir: string
}

async function buildContext(cwd: string, label: string): Promise<SyncContext> {
  const loaded = await loadMargoConfig(cwd)
  if (!loaded || loaded.config.storage !== 'server') {
    console.error(`[margo ${label}] no server-mode margo.config in ${cwd} — nothing to sync.`)
    console.error(`        Run \`margo init --server <url> --project <slug>\` first.`)
    process.exit(1)
  }
  const server = loaded.config.server
  if (!server) {
    console.error(`[margo ${label}] margo.config has storage: 'server' but no server block.`)
    process.exit(1)
  }
  const token = process.env[server.auth.tokenEnv]
  if (!token) {
    console.error(`[margo ${label}] env var ${server.auth.tokenEnv} is not set.`)
    process.exit(1)
  }
  return {
    cwd,
    transport: new RemoteTransport({
      serverUrl: server.url,
      project: server.project,
      token,
    }),
    commentsDir: path.join(cwd, '.margo', 'comments'),
  }
}

/**
 * Download every comment from the host into `.margo/comments/`. Writes
 * each file verbatim from the host's stored form so a follow-up push
 * (without AI edits) is a no-change round-trip. Does NOT delete local-
 * only files — those are presumed to be in-progress AI edits that
 * haven't been pushed yet; the operator must explicitly use --force to
 * remove them.
 */
export async function pull(opts: { cwd: string; force?: boolean }): Promise<void> {
  const ctx = await buildContext(opts.cwd, 'pull')
  await fs.mkdir(ctx.commentsDir, { recursive: true })
  const comments = await ctx.transport.list()
  const expected = new Set<string>()
  for (const c of comments) {
    const file = path.join(ctx.commentsDir, `${c.frontmatter.id}.md`)
    expected.add(`${c.frontmatter.id}.md`)
    // c.raw is the original frontmatter+body verbatim as stored on the
    // host — writing it back preserves any operator-introduced
    // formatting (extra blank lines, key order) instead of canonicalizing.
    await fs.writeFile(file, c.raw, 'utf8')
  }
  // Local-only files: warn unless --force, in which case we delete them.
  let localFiles: string[] = []
  try {
    localFiles = (await fs.readdir(ctx.commentsDir)).filter((f) => f.endsWith('.md'))
  } catch { /* dir might not exist yet, fine */ }
  const orphans = localFiles.filter((f) => !expected.has(f))
  if (orphans.length > 0) {
    if (opts.force) {
      for (const f of orphans) {
        await fs.unlink(path.join(ctx.commentsDir, f))
      }
      console.log(`[margo pull] removed ${orphans.length} local-only file(s).`)
    } else {
      console.warn(`[margo pull] ${orphans.length} local file(s) not on host (use --force to delete):`)
      for (const f of orphans) console.warn(`        ${f}`)
    }
  }
  console.log(`[margo pull] ${comments.length} comment(s) from ${(await ctx.transport.getIdentity())?.email ?? 'host'}.`)
  await ctx.transport.close()
}

/**
 * Upload comment files to the host. With `--id <id>`, pushes a single
 * file; otherwise pushes every `.md` in `.margo/comments/`. The host
 * accepts both create and update via the same PUT endpoint so callers
 * don't need to know which is which.
 */
export async function push(opts: { cwd: string; id?: string }): Promise<void> {
  const ctx = await buildContext(opts.cwd, 'push')
  let files: string[]
  if (opts.id) {
    if (!/^[a-zA-Z0-9._-]+$/.test(opts.id)) {
      console.error('[margo push] invalid --id (must match [a-zA-Z0-9._-]+)')
      process.exit(1)
    }
    files = [`${opts.id}.md`]
  } else {
    try {
      files = (await fs.readdir(ctx.commentsDir)).filter((f) => f.endsWith('.md'))
    } catch {
      console.warn('[margo push] no .margo/comments/ directory — nothing to push.')
      return
    }
  }
  let pushed = 0
  let failed = 0
  for (const f of files) {
    const id = f.replace(/\.md$/, '')
    const file = path.join(ctx.commentsDir, f)
    try {
      const raw = await fs.readFile(file, 'utf8')
      await ctx.transport.write(id, raw, `pushed via margo push`)
      pushed++
    } catch (err) {
      failed++
      console.warn(`[margo push] ${id}: ${(err as Error).message}`)
    }
  }
  console.log(`[margo push] uploaded ${pushed} comment(s)${failed > 0 ? `, ${failed} failed` : ''}.`)
  await ctx.transport.close()
}
