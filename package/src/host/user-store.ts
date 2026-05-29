// User + token persistence for the host. JSON file at the data root,
// atomic writes via tmp-file + rename. Deliberately *not* SQLite:
//
//   - Self-hosted margo instances see a handful of writes per second at
//     peak (humans pinning comments). A single JSON file handles that
//     trivially with no native deps to compile per platform.
//   - The schema is small (users, tokens, projects, roster) — SQL would
//     be more ceremony than the problem deserves.
//   - Easy to migrate later if scale changes: read JSON, write to a real
//     database.
//
// Tokens are hashed at rest (sha256). The plain token is shown once at
// creation time and never again — if the operator loses it they revoke
// + reissue rather than recover.

import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

/** Stored shape of a user record. The display name is optional so a
 *  GitHub-OAuth-bootstrapped user works before we've collected one. */
export interface UserRecord {
  id: string
  email: string
  name: string
  createdAt: string
  /** Superusers bypass project ACL checks — used for the bootstrap user
   *  so the operator who set the host up can manage everything. Future:
   *  this flag is grantable to any user via CLI. */
  isSuperuser?: boolean
  /** scrypt-hashed password for web UI login. Stored as
   *  `<salt-hex>:<derived-hex>`. Absent for users created via env-
   *  bootstrap or CLI without a password — they can still use the API
   *  with bearer tokens but can't log in to the UI until they `signup`
   *  with the same email (which fills in the hash). */
  passwordHash?: string
}

/** Per-project role a user holds. read/write/admin form a strict hierarchy:
 *  admin > write > read. The auth layer compares against the role required
 *  by the route (GET → read, PUT/POST/DELETE → write, manage-members → admin). */
export type Role = 'read' | 'write' | 'admin'

export interface ProjectRecord {
  /** URL-safe slug — also serves as the directory name under <dataRoot>/.
   *  This is what clients put in margo.config.server.project. */
  slug: string
  name: string
  createdAt: string
}

export interface MembershipRecord {
  userId: string
  projectSlug: string
  role: Role
  addedAt: string
}

/** Stored shape of a token. plainPrefix is the first 8 chars of the
 *  plaintext, retained to help an operator identify tokens in a UI
 *  listing without exposing the secret. */
export interface TokenRecord {
  id: string
  userId: string
  hashedToken: string
  plainPrefix: string
  label: string
  createdAt: string
  lastUsedAt?: string
  revokedAt?: string
}

interface FileShape {
  version: 1
  users: UserRecord[]
  tokens: TokenRecord[]
  projects: ProjectRecord[]
  memberships: MembershipRecord[]
  /** Random per-host HMAC key used to sign session cookies. Auto-
   *  generated on first persist; rotating it (deleting the field +
   *  restarting) invalidates every issued session and forces re-login. */
  sessionSecret?: string
}

const EMPTY: FileShape = { version: 1, users: [], tokens: [], projects: [], memberships: [] }

/** Result of creating a token. plainToken is shown to the operator ONCE
 *  at creation; it's not persisted in plain form. */
export interface CreateTokenResult {
  record: TokenRecord
  plainToken: string
}

export class UserStore {
  private readonly file: string
  private data: FileShape = EMPTY
  private loaded = false
  // Write serializer so two concurrent updates can't lose a record by
  // racing the read-modify-write cycle.
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(dataRoot: string) {
    this.file = path.join(path.resolve(dataRoot), 'users.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    await this.reload()
    this.loaded = true
  }

  /** Force a re-read from disk. Used by resolveToken so cross-process
   *  changes (CLI revoke while host is running) take effect immediately. */
  async reload(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as FileShape
      this.data = normalize(parsed)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      this.data = { ...EMPTY }
    }
  }

  /** Total users currently on file (excluding none — there's no soft-delete). */
  async userCount(): Promise<number> {
    await this.load()
    return this.data.users.length
  }

  async listUsers(): Promise<UserRecord[]> {
    await this.load()
    return this.data.users.slice()
  }

  async getUser(id: string): Promise<UserRecord | null> {
    await this.load()
    return this.data.users.find((u) => u.id === id) ?? null
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    await this.load()
    const lower = email.toLowerCase()
    return this.data.users.find((u) => u.email.toLowerCase() === lower) ?? null
  }

  async createUser(email: string, name: string, opts?: { isSuperuser?: boolean }): Promise<UserRecord> {
    await this.load()
    const existing = await this.findUserByEmail(email)
    if (existing) throw new Error(`user with email ${email} already exists (id ${existing.id})`)
    const record: UserRecord = {
      id: `u-${nextSuffix()}`,
      email,
      name,
      createdAt: new Date().toISOString(),
      ...(opts?.isSuperuser ? { isSuperuser: true } : {}),
    }
    return this.mutate((d) => {
      d.users.push(record)
      return record
    })
  }

  /** Sign up a new user with a password — the flow the web /signup form
   *  calls. Differs from createUser in that a password hash is required
   *  AND a duplicate email returns null instead of throwing (so the UI
   *  can surface a friendly "email already registered" without parsing
   *  exception messages).
   *
   *  First-signup-wins admin policy: if the user store is empty when this
   *  call lands, the new user gets isSuperuser:true. The check happens
   *  inside the mutate() critical section so two concurrent first-signups
   *  can't both claim superuser. */
  async signup(email: string, name: string, plainPassword: string): Promise<UserRecord | null> {
    await this.load()
    // Fast-path 409: another user with this email already exists. Re-
    // checked inside mutate() below to be race-safe against a parallel
    // signup of the same email between this read and the write.
    if (await this.findUserByEmail(email)) return null
    const passwordHash = await hashPassword(plainPassword)
    const id = `u-${nextSuffix()}`
    const lowerEmail = email.toLowerCase()
    try {
      return await this.mutate((d) => {
        if (d.users.some((u) => u.email.toLowerCase() === lowerEmail)) {
          throw new Error('duplicate_email')
        }
        const isFirstUser = d.users.length === 0
        const record: UserRecord = {
          id,
          email,
          name,
          createdAt: new Date().toISOString(),
          passwordHash,
          ...(isFirstUser ? { isSuperuser: true } : {}),
        }
        d.users.push(record)
        return record
      })
    } catch (err) {
      if ((err as Error).message === 'duplicate_email') return null
      throw err
    }
  }

  /** Set or replace a user's password hash. Used by signup-after-bootstrap
   *  (a CLI-created user wants UI access) and by future password-reset
   *  flows. Email-on-record stays the lookup key. */
  async setPassword(userId: string, plainPassword: string): Promise<void> {
    await this.load()
    if (!(await this.getUser(userId))) throw new Error(`no user with id ${userId}`)
    const passwordHash = await hashPassword(plainPassword)
    await this.mutate((d) => {
      const u = d.users.find((x) => x.id === userId)
      if (u) u.passwordHash = passwordHash
    })
  }

  /** Verify a plaintext password against the stored hash. Returns the
   *  user record on success, null on bad credentials OR unknown email.
   *  Same return shape for both cases keeps the timing leak small (the
   *  caller can't distinguish "wrong password" from "no such user"). */
  async verifyLogin(email: string, plainPassword: string): Promise<UserRecord | null> {
    await this.reload() // cross-process freshness, same reason as resolveToken
    const user = this.data.users.find((u) => u.email.toLowerCase() === email.toLowerCase())
    if (!user || !user.passwordHash) {
      // Run a dummy verify against a known-bad hash to keep timing
      // roughly equivalent between "no user" and "wrong password".
      await verifyPassword(plainPassword, '00:00').catch(() => undefined)
      return null
    }
    const ok = await verifyPassword(plainPassword, user.passwordHash)
    return ok ? user : null
  }

  /** Lazily mint and persist the session-signing HMAC key, then return
   *  it. Called by the session module on first use; the key sticks
   *  around for the lifetime of the host until explicitly rotated. */
  async getOrCreateSessionSecret(): Promise<string> {
    await this.load()
    if (this.data.sessionSecret) return this.data.sessionSecret
    const secret = crypto.randomBytes(48).toString('hex')
    await this.mutate((d) => {
      if (!d.sessionSecret) d.sessionSecret = secret
    })
    return this.data.sessionSecret ?? secret
  }

  /** Toggle a user's superuser bit. Useful when promoting an additional
   *  operator after the host has been running for a while. */
  async setSuperuser(userId: string, value: boolean): Promise<void> {
    await this.load()
    const user = this.data.users.find((u) => u.id === userId)
    if (!user) throw new Error(`no user with id ${userId}`)
    await this.mutate((d) => {
      const u = d.users.find((x) => x.id === userId)
      if (!u) return
      if (value) u.isSuperuser = true
      else delete u.isSuperuser
    })
  }

  // ─── Projects ─────────────────────────────────────────────────────────

  async listProjects(): Promise<ProjectRecord[]> {
    await this.load()
    return this.data.projects.slice()
  }

  async getProject(slug: string): Promise<ProjectRecord | null> {
    await this.load()
    return this.data.projects.find((p) => p.slug === slug) ?? null
  }

  async createProject(slug: string, name: string): Promise<ProjectRecord> {
    if (!/^[a-zA-Z0-9._-]+$/.test(slug)) {
      throw new Error(`invalid project slug: ${slug} (must match [a-zA-Z0-9._-]+)`)
    }
    await this.load()
    if (await this.getProject(slug)) {
      throw new Error(`project ${slug} already exists`)
    }
    const record: ProjectRecord = {
      slug,
      name,
      createdAt: new Date().toISOString(),
    }
    return this.mutate((d) => {
      d.projects.push(record)
      return record
    })
  }

  // ─── Memberships ──────────────────────────────────────────────────────

  async listMembers(projectSlug: string): Promise<MembershipRecord[]> {
    await this.load()
    return this.data.memberships.filter((m) => m.projectSlug === projectSlug)
  }

  async getMembership(userId: string, projectSlug: string): Promise<MembershipRecord | null> {
    await this.load()
    return this.data.memberships.find((m) => m.userId === userId && m.projectSlug === projectSlug) ?? null
  }

  async addMember(userId: string, projectSlug: string, role: Role): Promise<MembershipRecord> {
    await this.load()
    if (!(await this.getUser(userId))) throw new Error(`no user with id ${userId}`)
    if (!(await this.getProject(projectSlug))) throw new Error(`no project with slug ${projectSlug}`)
    const existing = await this.getMembership(userId, projectSlug)
    if (existing) {
      // Idempotent role update — operator typing `add-member` twice with
      // a different role is the natural way to promote/demote without a
      // separate `set-member-role` command.
      await this.mutate((d) => {
        const m = d.memberships.find(
          (x) => x.userId === userId && x.projectSlug === projectSlug,
        )
        if (m) m.role = role
      })
      return { ...existing, role }
    }
    const record: MembershipRecord = {
      userId,
      projectSlug,
      role,
      addedAt: new Date().toISOString(),
    }
    return this.mutate((d) => {
      d.memberships.push(record)
      return record
    })
  }

  async removeMember(userId: string, projectSlug: string): Promise<void> {
    await this.load()
    await this.mutate((d) => {
      d.memberships = d.memberships.filter(
        (m) => !(m.userId === userId && m.projectSlug === projectSlug),
      )
    })
  }

  async listTokens(): Promise<TokenRecord[]> {
    await this.load()
    return this.data.tokens.filter((t) => !t.revokedAt)
  }

  async createToken(userId: string, label: string): Promise<CreateTokenResult> {
    await this.load()
    const user = await this.getUser(userId)
    if (!user) throw new Error(`no user with id ${userId}`)
    // 32 bytes of randomness → 64 hex chars. Plain token is `mgo_<hex>`
    // so operators can recognize them on sight (similar to npm_/ghp_).
    const plainToken = `mgo_${crypto.randomBytes(32).toString('hex')}`
    const hashed = sha256(plainToken)
    const record: TokenRecord = {
      id: `t-${nextSuffix()}`,
      userId,
      hashedToken: hashed,
      plainPrefix: plainToken.slice(0, 12),
      label,
      createdAt: new Date().toISOString(),
    }
    await this.mutate((d) => {
      d.tokens.push(record)
    })
    return { record, plainToken }
  }

  /** Store a pre-existing plaintext token under a user. Only used by the
   *  env-bootstrap path — the operator already chose the secret (via
   *  MARGO_HOST_TOKEN) before we ever ran, and we adopt it as-is so the
   *  upgrade is seamless. Normal token issuance goes through createToken,
   *  which generates entropy itself. */
  async adoptToken(userId: string, plainToken: string, label: string): Promise<TokenRecord> {
    await this.load()
    const user = await this.getUser(userId)
    if (!user) throw new Error(`no user with id ${userId}`)
    const record: TokenRecord = {
      id: `t-${nextSuffix()}`,
      userId,
      hashedToken: sha256(plainToken),
      plainPrefix: plainToken.slice(0, 12),
      label,
      createdAt: new Date().toISOString(),
    }
    return this.mutate((d) => {
      d.tokens.push(record)
      return record
    })
  }

  async revokeToken(tokenId: string): Promise<void> {
    await this.load()
    const found = this.data.tokens.find((t) => t.id === tokenId)
    if (!found) throw new Error(`no token with id ${tokenId}`)
    if (found.revokedAt) return
    await this.mutate((d) => {
      const t = d.tokens.find((x) => x.id === tokenId)
      if (t) t.revokedAt = new Date().toISOString()
    })
  }

  /** Look up the user a plaintext token authenticates as. Returns null
   *  for unknown / revoked tokens. Touches lastUsedAt as a side effect
   *  so operators can see which tokens are live.
   *
   *  Always reads fresh from disk before checking. The host and the CLI
   *  are separate processes that both touch users.json — the CLI revokes
   *  a token, the host must pick that up on the next auth lookup without
   *  needing a restart. The file is tiny (sub-KB for typical
   *  installations), so re-reading per request is microseconds. */
  async resolveToken(plainToken: string): Promise<{ user: UserRecord; token: TokenRecord } | null> {
    await this.reload()
    const hashed = sha256(plainToken)
    const token = this.data.tokens.find((t) => t.hashedToken === hashed && !t.revokedAt)
    if (!token) return null
    const user = this.data.users.find((u) => u.id === token.userId)
    if (!user) return null
    // Fire-and-forget lastUsedAt update so auth latency stays in the
    // microseconds — the file write is enqueued, not awaited. If two
    // requests update the same token within a tick we lose one of the
    // timestamps, which is fine (we only need approximate recency).
    this.touchLastUsedAt(token.id)
    return { user, token }
  }

  private touchLastUsedAt(tokenId: string): void {
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        const t = this.data.tokens.find((x) => x.id === tokenId)
        if (t) {
          t.lastUsedAt = new Date().toISOString()
          await this.persist()
        }
      })
  }

  private async mutate<T>(fn: (d: FileShape) => T): Promise<T> {
    // Serialize through writeChain so a flurry of CLI ops or concurrent
    // mutations never read-then-overwrite with stale data.
    let resolveOp!: (value: T) => void
    let rejectOp!: (err: unknown) => void
    const result = new Promise<T>((resolve, reject) => {
      resolveOp = resolve
      rejectOp = reject
    })
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        try {
          const out = fn(this.data)
          await this.persist()
          resolveOp(out)
        } catch (err) {
          rejectOp(err)
        }
      })
    return result
  }

  /** Atomic write: serialize to a tmp file, then rename over the target.
   *  Rename is atomic on POSIX, so a crash mid-write never leaves a
   *  corrupt half-file on disk. */
  private async persist(): Promise<void> {
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 })
    await fs.rename(tmp, this.file)
  }
}

function normalize(parsed: FileShape): FileShape {
  return {
    version: 1,
    users: Array.isArray(parsed.users) ? parsed.users : [],
    tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [],
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    memberships: Array.isArray(parsed.memberships) ? parsed.memberships : [],
  }
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

// 8 random hex chars — plenty unique for the lifetime of a single host
// while staying human-readable in CLI output ("u-3f8a91c2").
function nextSuffix(): string {
  return crypto.randomBytes(4).toString('hex')
}

// scrypt parameters: N=16384 (2^14), r=8, p=1 — the conservative
// defaults from RFC 7914 + the libsodium docs. Slow enough on modern
// CPUs (~50ms) to resist offline brute-force on a leaked users.json.
const SCRYPT_KEYLEN = 64
const SCRYPT_OPTS = { N: 1 << 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

function deriveScrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS, (err, key) => {
      if (err) reject(err)
      else resolve(key)
    })
  })
}

/** Hash a password for storage. Returns `<salt-hex>:<derived-hex>`. */
async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16)
  const derived = await deriveScrypt(password, salt)
  return `${salt.toString('hex')}:${derived.toString('hex')}`
}

/** Verify a plaintext password against a stored `<salt-hex>:<derived-hex>`.
 *  Uses timingSafeEqual to avoid leaking the prefix on which the
 *  comparison diverged. */
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, derivedHex] = stored.split(':')
  if (!saltHex || !derivedHex) return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(saltHex, 'hex')
    expected = Buffer.from(derivedHex, 'hex')
  } catch {
    return false
  }
  if (expected.length !== SCRYPT_KEYLEN) return false
  try {
    const derived = await deriveScrypt(password, salt)
    return crypto.timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}
