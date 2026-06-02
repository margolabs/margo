// Plugin-side auth endpoints. These let the overlay drive a device-login
// flow against the margo host without the user dropping to a terminal —
// click "Sign in" → host's /cli-login page opens in a new tab → user
// authorizes → plugin polls the host → token lands in
// ~/.margo/credentials.json → plugin re-instantiates its transport.
//
// The plugin proxies (rather than the overlay calling the host directly)
// for two reasons:
//   1. The credentials file lives next to the dev server, not in the
//      browser. Only the Node side can write it.
//   2. CORS — the host doesn't trust arbitrary origins, but the plugin
//      already has its own dev-server origin and a local fetch path.
//
// Same shape as the CLI's `margo login` flow, just driven by HTTP from
// the overlay instead of the CLI's poll loop.

import * as os from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { removeCredentials, saveCredential } from '../auth/credentials-store.js'

const AUTH_PATHS = [
  '/__margo/auth/start',
  '/__margo/auth/poll',
  '/__margo/auth/logout',
] as const

export function isAuthEndpoint(url: string | undefined): boolean {
  if (!url) return false
  const path = url.split('?', 1)[0]
  return (AUTH_PATHS as readonly string[]).includes(path)
}

export interface AuthEndpointContext {
  /** Host base URL from margo.config (no trailing slash). Falsy in local
   *  mode — auth endpoints reject with 400 in that case. */
  hostUrl?: string
  /** Project slug — passed along to the host's session label so the
   *  dashboard can show "alice's laptop logged in for acme-pricing". */
  project?: string
  /** Called after credentials.json changes (login or logout). The plugin
   *  re-instantiates its transport so the next `/__margo/me` reflects
   *  the new state without a process restart. */
  onAuthChange?: () => Promise<void> | void
}

export async function handleAuthStart(
  ctx: AuthEndpointContext,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!ctx.hostUrl) return sendJson(res, 400, { error: 'not in server mode' })
  const label = defaultLabel()
  let r: Response
  try {
    r = await fetch(`${ctx.hostUrl}/api/auth/cli-login/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label }),
    })
  } catch (err) {
    return sendJson(res, 502, { error: `cannot reach host: ${(err as Error).message}` })
  }
  const body = (await safeJson(r)) ?? {}
  return sendJson(res, r.status, body)
}

export async function handleAuthPoll(
  ctx: AuthEndpointContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!ctx.hostUrl) return sendJson(res, 400, { error: 'not in server mode' })
  const body = await readJson<{ deviceCode?: string }>(req)
  if (!body?.deviceCode) return sendJson(res, 400, { error: 'deviceCode required' })
  let r: Response
  try {
    r = await fetch(`${ctx.hostUrl}/api/auth/cli-login/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCode: body.deviceCode }),
    })
  } catch (err) {
    return sendJson(res, 502, { error: `cannot reach host: ${(err as Error).message}` })
  }
  const hostBody = (await safeJson<{
    status?: string
    token?: string
    user?: { id?: string; email?: string; name?: string }
    error?: string
  }>(r)) ?? {}
  // Authorized — persist the token and trigger transport re-creation
  // before responding so the next /__margo/me already reflects the
  // logged-in state.
  if (r.status === 200 && hostBody.status === 'authorized' && hostBody.token && hostBody.user?.email) {
    await saveCredential({
      host: ctx.hostUrl,
      userId: hostBody.user.id ?? '',
      userEmail: hostBody.user.email,
      userName: hostBody.user.name ?? hostBody.user.email,
      token: hostBody.token,
      label: defaultLabel(),
      savedAt: new Date().toISOString(),
    })
    try {
      await ctx.onAuthChange?.()
    } catch (err) {
      // Don't fail the response — the credential is saved, the overlay
      // can recover by reloading the page.
      console.warn('[margo] onAuthChange failed after login:', (err as Error).message)
    }
    // Strip the token from the response back to the browser — the
    // plugin keeps it server-side only.
    return sendJson(res, 200, {
      status: 'authorized',
      user: { email: hostBody.user.email, name: hostBody.user.name ?? hostBody.user.email },
    })
  }
  return sendJson(res, r.status, hostBody)
}

export async function handleAuthLogout(
  ctx: AuthEndpointContext,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!ctx.hostUrl) return sendJson(res, 400, { error: 'not in server mode' })
  const removed = await removeCredentials(ctx.hostUrl)
  try {
    await ctx.onAuthChange?.()
  } catch (err) {
    console.warn('[margo] onAuthChange failed after logout:', (err as Error).message)
  }
  return sendJson(res, 200, { ok: true, removed })
}

function defaultLabel(): string {
  const short = (os.hostname() || 'device').split('.')[0]
  const date = new Date().toISOString().slice(0, 10)
  return `${short}-${date}`
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJson<T>(req: IncomingMessage): Promise<T | null> {
  try {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    if (chunks.length === 0) return null
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
  } catch {
    return null
  }
}

async function safeJson<T = unknown>(r: Response): Promise<T | null> {
  try {
    return (await r.json()) as T
  } catch {
    return null
  }
}
