// HMAC-signed session cookies for the host's web UI. Stateless: the
// cookie carries `<user-id>.<expiry-epoch-seconds>.<base64-hmac>` and
// we verify by recomputing the HMAC. No server-side session storage —
// avoids the get/set bookkeeping and the "what happens when the
// process restarts" question.
//
// Key rotation: the signing key lives in users.json (sessionSecret).
// Deleting that field invalidates every issued cookie at once — useful
// if a token compromise is suspected.

import * as crypto from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

const COOKIE_NAME = 'margo_session'
const SESSION_LIFETIME_SEC = 30 * 24 * 3600 // 30 days

export interface SessionPayload {
  userId: string
  expiresAt: number // epoch seconds
}

/** Build the `Set-Cookie` value for a freshly authenticated user. */
export function issueSessionCookie(userId: string, secret: string): string {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_LIFETIME_SEC
  const payload = `${userId}.${expiresAt}`
  const sig = sign(payload, secret)
  const value = `${payload}.${sig}`
  // HttpOnly: blocks JS access from injected scripts.
  // SameSite=Lax: protects most CSRF without breaking top-level navigations.
  // Path=/: cookie valid for the whole host.
  return `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_LIFETIME_SEC}`
}

/** Build the `Set-Cookie` value that expires the session immediately. */
export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
}

/** Parse and verify the session cookie from an incoming request.
 *  Returns the payload on success; null on missing/expired/forged. */
export function readSession(req: IncomingMessage, secret: string): SessionPayload | null {
  const raw = parseCookie(req.headers['cookie'], COOKIE_NAME)
  if (!raw) return null
  const parts = raw.split('.')
  if (parts.length !== 3) return null
  const [userId, expiresStr, sig] = parts
  const expiresAt = Number(expiresStr)
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) return null
  const expected = sign(`${userId}.${expiresAt}`, secret)
  if (!constantTimeEqualStr(sig, expected)) return null
  return { userId, expiresAt }
}

/** Write a Set-Cookie header without trampling any existing one. */
export function setCookieHeader(res: ServerResponse, value: string): void {
  const existing = res.getHeader('set-cookie')
  if (Array.isArray(existing)) {
    res.setHeader('set-cookie', [...existing, value])
  } else if (typeof existing === 'string') {
    res.setHeader('set-cookie', [existing, value])
  } else {
    res.setHeader('set-cookie', value)
  }
}

// ─── Internals ────────────────────────────────────────────────────────

function sign(payload: string, secret: string): string {
  // Base64url so the cookie value stays cookie-safe without percent-encoding.
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url')
}

function parseCookie(header: string | string[] | undefined, name: string): string | null {
  if (!header) return null
  const raw = Array.isArray(header) ? header.join('; ') : header
  for (const pair of raw.split(';')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    const k = pair.slice(0, eq).trim()
    if (k !== name) continue
    return pair.slice(eq + 1).trim()
  }
  return null
}

function constantTimeEqualStr(a: string, b: string): boolean {
  // crypto.timingSafeEqual requires equal-length Buffers; we pad/truncate
  // so the comparison cost doesn't leak the length of either side.
  const max = Math.max(a.length, b.length)
  const ba = Buffer.alloc(max)
  const bb = Buffer.alloc(max)
  ba.write(a)
  bb.write(b)
  return crypto.timingSafeEqual(ba, bb) && a.length === b.length
}
