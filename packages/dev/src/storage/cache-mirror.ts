// Mirror the host's comments into a local cache directory. Used both by
// the `margo pull` CLI and by the dev-plugin's boot-time sync so AI
// agents (Claude Code's `/margo` skill) can read `.margo/comments/*.md`
// the same way they would in local mode — only the source of the files
// differs (host HTTP API vs. git working tree).
//
// Pure transport + disk. No CLI concerns (no process.exit, no flag
// parsing), no config loading. Callers feed in a constructed Transport
// and a target directory.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Transport } from './transport.js'

export interface MirrorResult {
  pulled: number
  /** Local files whose ids aren't on the host. Probably in-progress AI
   *  edits that haven't been pushed yet — we leave them alone by default. */
  orphans: string[]
}

/**
 * Pull every comment from the host's transport and write it verbatim to
 * `commentsDir`. Each `<id>.md` is overwritten in place — a no-edit
 * round-trip is byte-for-byte stable because we persist `c.raw`. Local-
 * only files (orphans) are preserved by default so AI work-in-progress
 * doesn't get silently nuked; the caller can act on the returned list.
 */
export async function mirrorTransportToDir(
  transport: Transport,
  commentsDir: string,
): Promise<MirrorResult> {
  const comments = await transport.list()
  await fs.mkdir(commentsDir, { recursive: true })
  const expected = new Set<string>()
  for (const c of comments) {
    const id = c.frontmatter.id
    expected.add(`${id}.md`)
    const file = path.join(commentsDir, `${id}.md`)
    await fs.writeFile(file, c.raw, 'utf8')
  }
  let localFiles: string[] = []
  try {
    localFiles = (await fs.readdir(commentsDir)).filter((f) => f.endsWith('.md'))
  } catch { /* dir might not exist yet, fine */ }
  const orphans = localFiles.filter((f) => !expected.has(f))
  return { pulled: comments.length, orphans }
}
