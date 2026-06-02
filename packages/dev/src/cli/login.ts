// `npx margo login <host>` — device-login flow that writes a bearer
// token to `~/.margo/credentials.json`. Pairs with the host-side
// /api/auth/cli-login endpoints.
//
// UX:
//   1. CLI POSTs to <host>/api/auth/cli-login/start, gets back a
//      verifyUrl + deviceCode + pollInterval.
//   2. We print + auto-open the verifyUrl. User clicks "Authorize" in
//      their browser; the host marks the device session authorized.
//   3. We poll <host>/api/auth/cli-login/poll on a fixed interval until
//      the host returns the token (or expires the session).
//   4. On success the token lands in the credentials file. The dev
//      plugin + sync CLIs read from that file when MARGO_TOKEN isn't
//      already in process.env.

import { spawn } from 'node:child_process'
import * as os from 'node:os'
import {
  credentialsFilePath,
  saveCredential,
} from '../auth/credentials-store.js'

export interface LoginOptions {
  /** Host base URL, e.g. http://localhost:7331. Required. */
  host: string
  /** Device label, surfaced in the host's session listing. Defaults to
   *  short-hostname + today's date. */
  label?: string
  /** Whether to auto-open the verifyUrl in a browser. Default true.
   *  Pass false for headless / SSH sessions. */
  openBrowser?: boolean
  /** Pre-minted bearer token (e.g. `mgo_…`) to store directly without
   *  running the device flow. Lets users paste a token from the
   *  dashboard / CI secret store into ~/.margo/credentials.json with the
   *  same end shape as a browser login. The token is validated against
   *  the host before being written so typos fail loudly. */
  token?: string
}

interface StartResponse {
  deviceCode: string
  userCode: string
  verifyUrl: string
  pollInterval: number
  expiresAt: string
}

interface PollResponse {
  status: 'pending' | 'authorized'
  token?: string
  user?: { id?: string; email: string; name: string }
}

/** Drive the full device-login flow. Exits the process on terminal
 *  failure (expired session, unrecoverable network error) — this is a
 *  CLI command, not a library function, so process.exit is the right
 *  signal back to the shell. */
export async function login(opts: LoginOptions): Promise<void> {
  const host = normalizeHost(opts.host)
  if (!host || !/^https?:\/\//i.test(host)) {
    console.error('[margo login] usage: margo login <host-url> [--token <key>]')
    console.error('              e.g.  margo login http://localhost:7331')
    process.exit(1)
  }
  const label = opts.label && opts.label.length > 0 ? opts.label : defaultLabel()

  // --token short-circuits the device flow. The user already has a token
  // (minted on the dashboard / pulled from a CI secret store) and just
  // wants it dropped into ~/.margo/credentials.json so the plugin picks
  // it up without env-var gymnastics. We still hit /api/me to confirm
  // the token works — a typo here would otherwise surface as a confusing
  // 401 on the first dev-server boot.
  if (opts.token && opts.token.length > 0) {
    await loginWithPastedToken(host, opts.token, label)
    return
  }

  let start: StartResponse
  try {
    start = await postJson<StartResponse>(`${host}/api/auth/cli-login/start`, { label })
  } catch (err) {
    console.error(`[margo login] could not start session on ${host}: ${(err as Error).message}`)
    process.exit(1)
  }

  console.log('')
  console.log(`Open this URL in your browser to authorize:`)
  console.log(`  ${start.verifyUrl}`)
  console.log('')

  if (opts.openBrowser !== false) {
    const ok = tryOpenBrowser(start.verifyUrl)
    if (!ok) console.log('(could not auto-open, please open the URL manually)')
  }

  const expiresMs = Date.parse(start.expiresAt)
  const ttlMins = Number.isFinite(expiresMs)
    ? Math.max(1, Math.round((expiresMs - Date.now()) / 60_000))
    : 10
  console.log(`Waiting for authorization... (will time out in ${ttlMins} minute${ttlMins === 1 ? '' : 's'})`)

  const pollIntervalMs = Math.max(1, start.pollInterval || 2) * 1000
  const deadlineMs = Number.isFinite(expiresMs) ? expiresMs : Date.now() + 10 * 60_000
  let networkRetries = 0

  while (true) {
    if (Date.now() >= deadlineMs) {
      console.error('')
      console.error('[margo login] timed out waiting for authorization. Run `margo login` again.')
      process.exit(1)
    }
    await sleep(pollIntervalMs)
    let res: { status: number; body: PollResponse | { error?: string } }
    try {
      res = await postJsonRaw<PollResponse | { error?: string }>(
        `${host}/api/auth/cli-login/poll`,
        { deviceCode: start.deviceCode },
      )
      networkRetries = 0
    } catch (err) {
      networkRetries++
      if (networkRetries >= 3) {
        console.error('')
        console.error(`[margo login] network error after 3 retries: ${(err as Error).message}`)
        process.exit(1)
      }
      continue
    }

    if (res.status === 200) {
      const body = res.body as PollResponse
      if (body.status === 'authorized' && body.token && body.user) {
        await saveCredential({
          host,
          // The host's poll response doesn't promise an `id` field, only
          // email + name. Fall through to '' when missing — the
          // (host, userEmail) pair is the de-facto match key anyway.
          userId: body.user.id ?? '',
          userEmail: body.user.email,
          userName: body.user.name,
          token: body.token,
          label,
          savedAt: new Date().toISOString(),
        })
        const file = await credentialsFilePath()
        console.log('')
        console.log(`Logged in as ${body.user.email}. Token saved to ${file}.`)
        return
      }
      // 200 but not authorized — shouldn't happen per protocol, but
      // treat as pending to be defensive.
      continue
    }
    if (res.status === 202) {
      // still pending
      continue
    }
    if (res.status === 410) {
      console.error('')
      console.error('[margo login] session expired. Run `margo login` again.')
      process.exit(1)
    }
    if (res.status === 404) {
      console.error('')
      console.error('[margo login] session was consumed or never existed (you may have authorized twice).')
      process.exit(1)
    }
    // Any other status — surface and keep trying. The host might be
    // briefly unhealthy; we'll bail when the session deadline passes.
    const errMsg = (res.body as { error?: string })?.error ?? `HTTP ${res.status}`
    console.warn(`[margo login] poll returned ${res.status} (${errMsg}); will retry.`)
  }
}

/** Pre-minted token path. Validates the token against /api/me to catch
 *  typos before we persist anything, then saves the same shape of
 *  credentials entry the device flow writes. End state is byte-identical
 *  to a successful browser login. */
async function loginWithPastedToken(host: string, token: string, label: string): Promise<void> {
  let res: Response
  try {
    res = await fetch(`${host}/api/auth/whoami`, {
      headers: { authorization: `Bearer ${token}` },
    })
  } catch (err) {
    console.error(`[margo login] could not reach ${host}: ${(err as Error).message}`)
    process.exit(1)
  }
  if (res.status === 401 || res.status === 403) {
    console.error(`[margo login] token rejected by ${host} (HTTP ${res.status}). Check that you copied the full token from the dashboard.`)
    process.exit(1)
  }
  if (!res.ok) {
    console.error(`[margo login] /api/auth/whoami returned HTTP ${res.status} on ${host}. Cannot verify token.`)
    process.exit(1)
  }
  const me = (await res.json()) as { id?: string; email?: string; name?: string }
  if (!me.email) {
    console.error(`[margo login] /api/auth/whoami returned an unexpected shape (no email). Cannot proceed.`)
    process.exit(1)
  }
  await saveCredential({
    host,
    userId: me.id ?? '',
    userEmail: me.email,
    userName: me.name ?? me.email,
    token,
    label,
    savedAt: new Date().toISOString(),
  })
  const file = await credentialsFilePath()
  console.log('')
  console.log(`Logged in as ${me.email}. Token saved to ${file}.`)
}

function normalizeHost(host: string): string {
  return host.trim().replace(/\/+$/, '')
}

function defaultLabel(): string {
  const short = (os.hostname() || 'device').split('.')[0]
  const date = new Date().toISOString().slice(0, 10)
  return `${short}-${date}`
}

/** Open `url` in the OS default browser via a detached subprocess. The
 *  command and flags differ per platform; we silently fall through to
 *  `false` if the spawn fails, so the user can still hit the URL by
 *  hand. */
function tryOpenBrowser(url: string): boolean {
  const platform = process.platform
  let cmd: string
  let args: string[]
  if (platform === 'darwin') {
    cmd = 'open'
    args = [url]
  } else if (platform === 'win32') {
    cmd = 'cmd'
    args = ['/c', 'start', '""', url]
  } else {
    cmd = 'xdg-open'
    args = [url]
  }
  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
    })
    child.on('error', () => { /* swallow — caller's caught the falsy return path */ })
    child.unref()
    return true
  } catch {
    return false
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await postJsonRaw<T>(url, body)
  if (res.status < 200 || res.status >= 300) {
    const msg = (res.body as { error?: string })?.error ?? `HTTP ${res.status}`
    throw new Error(msg)
  }
  return res.body
}

async function postJsonRaw<T>(
  url: string,
  body: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let parsed: T
  try {
    parsed = (await res.json()) as T
  } catch {
    parsed = {} as T
  }
  return { status: res.status, body: parsed }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
