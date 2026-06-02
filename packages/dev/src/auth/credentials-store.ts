// Local store for CLI-login credentials. Populated by `margo login` and
// consulted by the dev plugin + sync CLIs as a fallback when the bearer
// token isn't already in process.env.
//
// On-disk shape (`~/.margo/credentials.json`):
//   {
//     "version": 1,
//     "credentials": [
//       { host, userId, userEmail, userName, token, label, savedAt }, ...
//     ]
//   }
//
// File mode 0600, parent dir 0700 — matches the convention used by gh,
// aws, npm, etc. for tokens persisted at user scope. We use `~/.margo/`
// (not `~/.config/margo/`) for consistency with Claude Code's `~/.claude/`
// — keeps the per-user state visible and discoverable rather than buried
// under XDG.
//
// TODO(windows): use %APPDATA%/margo/credentials.json on win32; for v1
// we use ~/.margo/ everywhere because that's what 99% of dev environments
// hit. The lookup is best-effort anyway — when the file doesn't exist on
// a Windows box, callers fall back to the error message that recommends
// `margo login`.

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

export interface CredentialsEntry {
  /** Host base URL, normalized — no trailing slash. */
  host: string
  /** Stable user id when the host returns one; '' otherwise. Match keys
   *  are (host, userEmail), so this field is informational only. */
  userId: string
  userEmail: string
  userName: string
  /** Bearer token, e.g. `mgo_…`. Sensitive — never log. */
  token: string
  /** Human-readable device label, e.g. `stanleys-mbp-2026-06-02`. */
  label: string
  /** ISO timestamp of when this entry was written. */
  savedAt: string
}

interface CredentialsFile {
  version: 1
  credentials: CredentialsEntry[]
}

const FILE_MODE = 0o600
const DIR_MODE = 0o700

/** Strip a trailing slash so two URLs that only differ in trailing `/`
 *  match. The credentials file stores hosts in normalized form; callers
 *  also normalize their lookup arg before comparing. */
function normalizeHost(host: string): string {
  return host.replace(/\/+$/, '')
}

/** Resolve the credentials file path. Exported so the login CLI can show
 *  the user where their token landed. */
export async function credentialsFilePath(): Promise<string> {
  const home = process.env.HOME || os.homedir()
  return path.join(home, '.margo', 'credentials.json')
}

/** Read the credentials file. Returns [] on any failure (missing file,
 *  malformed JSON, wrong shape) — the caller treats absence as "no saved
 *  credentials" and falls back to whatever it would do without us. */
export async function loadCredentials(): Promise<CredentialsEntry[]> {
  const file = await credentialsFilePath()
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const list = (parsed as Partial<CredentialsFile>).credentials
  if (!Array.isArray(list)) return []
  const out: CredentialsEntry[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const e = item as Partial<CredentialsEntry>
    if (
      typeof e.host !== 'string' ||
      typeof e.userEmail !== 'string' ||
      typeof e.token !== 'string'
    ) continue
    out.push({
      host: normalizeHost(e.host),
      userId: typeof e.userId === 'string' ? e.userId : '',
      userEmail: e.userEmail,
      userName: typeof e.userName === 'string' ? e.userName : '',
      token: e.token,
      label: typeof e.label === 'string' ? e.label : '',
      savedAt: typeof e.savedAt === 'string' ? e.savedAt : '',
    })
  }
  return out
}

/** Look up a saved credential by host. Match is by normalized host
 *  string. If multiple entries match (e.g. two teammates logged in from
 *  the same machine), returns the most recently saved one — assumed to
 *  be the "current" user for this device. */
export async function findCredential(host: string): Promise<CredentialsEntry | null> {
  const target = normalizeHost(host)
  const all = await loadCredentials()
  const matches = all.filter((c) => c.host === target)
  if (matches.length === 0) return null
  // Most recent savedAt wins. Sort defensively in case the file was
  // edited by hand.
  matches.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''))
  return matches[0]
}

/** Remove credentials. With `host` supplied, drops every entry that
 *  matches the normalized host. With no `host`, clears the entire file.
 *  Returns the number of entries removed so the CLI can report it.
 *  No-op if the file doesn't exist. */
export async function removeCredentials(host?: string): Promise<number> {
  const all = await loadCredentials()
  if (all.length === 0) return 0
  let kept: CredentialsEntry[]
  let removed: number
  if (host) {
    const target = normalizeHost(host)
    kept = all.filter((c) => c.host !== target)
    removed = all.length - kept.length
  } else {
    kept = []
    removed = all.length
  }
  if (removed === 0) return 0
  const file = await credentialsFilePath()
  if (kept.length === 0) {
    // Empty list — delete the file outright. Cleaner than leaving an
    // empty-credentials JSON on disk, and matches what a fresh box
    // would look like.
    try { await fs.unlink(file) } catch { /* already gone */ }
    return removed
  }
  const body: CredentialsFile = { version: 1, credentials: kept }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(body, null, 2) + '\n', { mode: FILE_MODE })
  try { await fs.chmod(tmp, FILE_MODE) } catch { /* best-effort */ }
  await fs.rename(tmp, file)
  try { await fs.chmod(file, FILE_MODE) } catch { /* best-effort */ }
  return removed
}

/** Persist an entry. Atomic write (tmp file + rename) so a crash mid-
 *  write doesn't leave a half-written credentials.json that future runs
 *  fail to parse. Replaces any existing entry that matches the same
 *  (host, userEmail) so a re-login doesn't accumulate stale tokens. */
export async function saveCredential(entry: CredentialsEntry): Promise<void> {
  const file = await credentialsFilePath()
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE })
  // mkdir's `mode` only applies when the dir is newly created. Re-chmod
  // explicitly so an existing dir with looser permissions gets tightened.
  try { await fs.chmod(dir, DIR_MODE) } catch { /* best-effort */ }

  const normalized: CredentialsEntry = { ...entry, host: normalizeHost(entry.host) }
  const existing = await loadCredentials()
  const next = existing.filter(
    (c) => !(c.host === normalized.host && c.userEmail === normalized.userEmail),
  )
  next.push(normalized)

  const body: CredentialsFile = { version: 1, credentials: next }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(body, null, 2) + '\n', { mode: FILE_MODE })
  // writeFile's `mode` only applies when the file is newly created. The
  // tmp path is new, so the mode sticks; chmod is belt-and-suspenders
  // in case a future change moves to overwrite-in-place.
  try { await fs.chmod(tmp, FILE_MODE) } catch { /* best-effort */ }
  await fs.rename(tmp, file)
  try { await fs.chmod(file, FILE_MODE) } catch { /* best-effort */ }
}
