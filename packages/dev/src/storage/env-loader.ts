// Tiny dotenv-style loader for the dev plugin + sync CLIs. Matches the
// convention every modern tool follows: `.env.local` and `.env` files in
// the workspace root get loaded into process.env at boot, so a teammate
// can drop `MARGO_TOKEN=mgo_…` into a gitignored `.env.local` instead of
// fighting shell rc files.
//
// Load order mirrors Vite's loadEnv(): most-specific wins, but we never
// override values already in process.env — shell-set vars always beat
// .env files, which beats no value at all. Idempotent at the process
// level so calling it from multiple plugin/CLI entry points is safe.

import * as fs from 'node:fs'
import * as path from 'node:path'

const FILES = ['.env.local', '.env.development.local', '.env.development', '.env']

let loadedForCwd: string | null = null

/** Load any `.env` files present in `cwd` into `process.env`. Idempotent:
 *  the first call sticks for the lifetime of the process (the file
 *  contents are only read once), matching Vite/Next behavior. Restart
 *  the dev server to pick up edits. */
export function loadDotenvFiles(cwd: string): void {
  if (loadedForCwd === cwd) return
  loadedForCwd = cwd
  for (const name of FILES) {
    const file = path.join(cwd, name)
    if (!fs.existsSync(file)) continue
    let raw: string
    try { raw = fs.readFileSync(file, 'utf8') } catch { continue }
    for (const [key, value] of parseEnv(raw)) {
      // Shell-set values win — never override.
      if (process.env[key] === undefined) process.env[key] = value
    }
  }
}

function* parseEnv(raw: string): Iterable<[string, string]> {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    // POSIX env-var name: letters, digits, underscore, not starting with a digit.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = trimmed.slice(eq + 1).trim()
    // Strip matched surrounding quotes (single or double); shell-style.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    yield [key, value]
  }
}
