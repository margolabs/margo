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
import { mirrorTransportToDir } from '../storage/cache-mirror.js'
import { resolveToken, serverCacheCommentsDir } from '../storage/factory.js'
import { RemoteTransport } from '../storage/remote-transport.js'
import { ConflictError } from '../storage/transport.js'

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
  const cfg = loaded.config
  if (!cfg.host || !cfg.project) {
    console.error(`[margo ${label}] server-mode margo.config is missing host or project.`)
    process.exit(1)
  }
  // Same defaults as the dev-plugin factory — `auth` is optional with
  // `{ type: 'bearer', tokenEnv: 'MARGO_TOKEN' }` baked in. resolveToken
  // consults process.env first (for CI / Docker dev containers) and
  // ~/.margo/credentials.json second (populated by `margo login`).
  const tokenEnv = cfg.auth?.tokenEnv ?? 'MARGO_TOKEN'
  const token = await resolveToken(tokenEnv, cfg.host)
  if (!token) {
    console.error(`[margo ${label}] no saved credentials for ${cfg.host} and ${tokenEnv} is unset.`)
    console.error(`        Run \`npx margo login ${cfg.host}\` to authorize this device.`)
    process.exit(1)
  }
  // Mirror lives under ~/.margo/cache/<host>/<project>/comments/ — same
  // place the dev plugin reads from. Importing serverCacheCommentsDir
  // from factory keeps the resolution rule in one spot.
  return {
    cwd,
    transport: new RemoteTransport({
      serverUrl: cfg.host,
      project: cfg.project,
      token,
    }),
    commentsDir: serverCacheCommentsDir(cfg.host, cfg.project),
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
  const { pulled, orphans } = await mirrorTransportToDir(ctx.transport, ctx.commentsDir)
  if (orphans.length > 0) {
    if (opts.force) {
      for (const f of orphans) await fs.unlink(path.join(ctx.commentsDir, f))
      console.log(`[margo pull] removed ${orphans.length} local-only file(s).`)
    } else {
      console.warn(`[margo pull] ${orphans.length} local file(s) not on host (use --force to delete):`)
      for (const f of orphans) console.warn(`        ${f}`)
    }
  }
  console.log(`[margo pull] ${pulled} comment(s) from ${(await ctx.transport.getIdentity())?.email ?? 'host'}.`)
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
  let conflicted = 0
  let failed = 0
  for (const f of files) {
    const id = f.replace(/\.md$/, '')
    const file = path.join(ctx.commentsDir, f)
    try {
      const raw = await fs.readFile(file, 'utf8')
      // Read first to capture the host's current ETag. The next write
      // uses it as If-Match so a parallel update between this read and
      // our write surfaces as 412 instead of silently clobbering.
      await ctx.transport.read(id).catch(() => null)
      const etag = ctx.transport.getKnownEtag(id)
      await ctx.transport.write(id, raw, `pushed via margo push`, etag ? { ifMatch: etag } : undefined)
      pushed++
    } catch (err) {
      if (err instanceof ConflictError) {
        conflicted++
        console.warn(`[margo push] CONFLICT on ${err.id}: host has a newer version, leaving local file untouched.`)
        console.warn(`             run \`margo pull\` (or merge by hand) and \`margo push --id ${err.id}\` again.`)
      } else {
        failed++
        console.warn(`[margo push] ${id}: ${(err as Error).message}`)
      }
    }
  }
  const summary = [`uploaded ${pushed}`]
  if (conflicted) summary.push(`${conflicted} conflict(s)`)
  if (failed) summary.push(`${failed} failed`)
  console.log(`[margo push] ${summary.join(', ')}.`)
  await ctx.transport.close()
}
