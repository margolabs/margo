// Bearer-token authentication against the host's user store. Each token
// belongs to a single user; the user's identity is what gets stamped on
// new comments + commit signatures.
//
// Phase-4 evolution from phase 2: the static one-token-per-server flag
// is gone. AuthConfig now wraps the UserStore and resolves tokens via
// hash lookup. Auto-bootstrap from MARGO_HOST_TOKEN on first boot keeps
// the old single-user setup working with zero migration steps.

import type { IncomingMessage } from 'node:http'
import type { UserStore } from './user-store.js'

export interface AuthIdentity {
  email: string
  name: string
}

export interface AuthConfig {
  /** Look up a presented token and return its owning user. The store
   *  hashes the token and matches it against persisted tokens; revoked
   *  tokens never resolve. */
  users: UserStore
}

export class AuthError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
  }
}

/**
 * Extract the bearer token and resolve it to an identity via the user
 * store. Returns the authenticated user on success; throws AuthError on
 * missing/malformed/wrong tokens.
 */
export async function authenticate(req: IncomingMessage, cfg: AuthConfig): Promise<AuthIdentity> {
  const header = req.headers['authorization']
  if (!header) throw new AuthError(401, 'missing authorization header')
  const raw = Array.isArray(header) ? header[0] : header
  const m = /^Bearer\s+(.+)$/i.exec(raw)
  if (!m) throw new AuthError(401, 'expected `Authorization: Bearer <token>`')
  const presented = m[1].trim()
  const resolved = await cfg.users.resolveToken(presented)
  if (!resolved) throw new AuthError(401, 'invalid token')
  return { email: resolved.user.email, name: resolved.user.name }
}
