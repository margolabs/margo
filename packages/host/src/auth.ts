// Bearer-token authentication + per-project authorization against the
// host's user store. authenticate() resolves a token to its owning user;
// authorize() additionally checks that the user has the required role
// on the requested project.
//
// Backward-compat policy (carried over from phase 4): if a project has
// no record in the user store, it's "legacy-open" — any authenticated
// user can access it. The operator opts into ACL enforcement by
// explicitly creating the project record via `margo host:create-project`.
// Superusers (the bootstrap user) bypass ACL checks entirely.

import type { IncomingMessage } from 'node:http'
import type { Role, UserRecord, UserStore } from './user-store.js'

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

const ROLE_RANK: Record<Role, number> = { read: 0, write: 1, admin: 2 }

/**
 * Extract the bearer token and resolve it to the full user record. Throws
 * AuthError on missing/malformed/wrong tokens. Returns the UserRecord
 * (not just identity) so callers can inspect isSuperuser without a
 * second lookup.
 */
export async function authenticate(req: IncomingMessage, cfg: AuthConfig): Promise<UserRecord> {
  const header = req.headers['authorization']
  if (!header) throw new AuthError(401, 'missing authorization header')
  const raw = Array.isArray(header) ? header[0] : header
  const m = /^Bearer\s+(.+)$/i.exec(raw)
  if (!m) throw new AuthError(401, 'expected `Authorization: Bearer <token>`')
  const presented = m[1].trim()
  const resolved = await cfg.users.resolveToken(presented)
  if (!resolved) throw new AuthError(401, 'invalid token')
  return resolved.user
}

/**
 * Project-level authorization. The user must either be a superuser, or
 * have a membership on the project with role >= required. Projects with
 * no record in the store are legacy-open — any authenticated user passes.
 *
 * Throws AuthError(403) on insufficient role, AuthError(404) on a
 * project that doesn't exist on disk (so we don't leak which projects
 * the operator has on file via 403 vs 404 differentiation).
 */
export async function authorize(
  cfg: AuthConfig,
  user: UserRecord,
  projectSlug: string,
  required: Role,
): Promise<void> {
  if (user.isSuperuser) return

  const project = await cfg.users.getProject(projectSlug)
  if (!project) {
    // No project record → legacy-open. Phase-4 deployments that had
    // any-authenticated-user-can-access-any-project continue working
    // until the operator runs `margo host:create-project` to flip on
    // ACL enforcement for that slug.
    return
  }

  const membership = await cfg.users.getMembership(user.id, projectSlug)
  if (!membership) {
    throw new AuthError(403, `not a member of project ${projectSlug}`)
  }
  if (ROLE_RANK[membership.role] < ROLE_RANK[required]) {
    throw new AuthError(403, `requires ${required} access on ${projectSlug} (you have ${membership.role})`)
  }
}
