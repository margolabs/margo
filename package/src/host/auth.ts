// Bearer-token authentication for the host. Phase-2 simplification:
// one shared token per server instance (read from env at boot), one
// identity baked into the same env vars. Future work replaces this with
// per-user tokens backed by SQLite and GitHub OAuth.

import type { IncomingMessage } from 'node:http'

export interface AuthIdentity {
  email: string
  name: string
}

export interface AuthConfig {
  /** Static bearer token clients must present. Compare with constant-time
   *  string equality to avoid leaking length via timing — but Node lacks
   *  a built-in crypto.timingSafeEqual for strings of different lengths,
   *  so we pad/truncate ourselves. */
  token: string
  /** Identity attached to authenticated requests. The whole server speaks
   *  for this one user in phase 2; per-token identities come later. */
  identity: AuthIdentity
}

export class AuthError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
  }
}

/**
 * Extract and verify the bearer token from an incoming request's
 * Authorization header. Returns the authenticated identity on success;
 * throws AuthError on missing/malformed/wrong tokens.
 */
export function authenticate(req: IncomingMessage, cfg: AuthConfig): AuthIdentity {
  const header = req.headers['authorization']
  if (!header) throw new AuthError(401, 'missing authorization header')
  const raw = Array.isArray(header) ? header[0] : header
  const m = /^Bearer\s+(.+)$/i.exec(raw)
  if (!m) throw new AuthError(401, 'expected `Authorization: Bearer <token>`')
  const presented = m[1].trim()
  if (!constantTimeEqual(presented, cfg.token)) {
    throw new AuthError(401, 'invalid token')
  }
  return cfg.identity
}

/** Constant-time string equality. Pads both sides to a common length so
 *  the comparison cost doesn't leak the length of the secret. */
function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0
    const cb = i < b.length ? b.charCodeAt(i) : 0
    diff |= ca ^ cb
  }
  return diff === 0
}
