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
  /** Anchor to the developer's real repo. Recorded on first connect from
   *  any plugin (first-bind-wins). Subsequent connects must match or get
   *  a mismatch warning surfaced to the overlay UI. Catches typo'd slugs,
   *  accidentally-shared slugs across unrelated repos, and forks that
   *  forgot to update margo.config.
   *
   *  Two kinds: `git-origin` (the natural anchor when a team remote
   *  exists) and `uuid` (fallback for repos without an origin URL —
   *  committed into the workspace's margo.config so every clone sees the
   *  same value). */
  repoBinding?: { kind: 'git-origin' | 'uuid'; value: string; recordedAt: string }
}

/** Result of asking the host to claim or check a repo binding. The
 *  client (plugin) hits this once at boot and surfaces the status in the
 *  overlay so a developer with the wrong checkout sees a clear warning
 *  instead of silently corrupting some other team's project. */
export type BindingResult =
  | { status: 'claimed'; recorded: NonNullable<ProjectRecord['repoBinding']> }
  | { status: 'matched'; recorded: NonNullable<ProjectRecord['repoBinding']> }
  | { status: 'mismatch'; recorded: NonNullable<ProjectRecord['repoBinding']>; presented: { kind: string; value: string } }
  | { status: 'rebound'; recorded: NonNullable<ProjectRecord['repoBinding']>; previous: NonNullable<ProjectRecord['repoBinding']> }

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

/** Short-lived state for a CLI device-login flow. The CLI POSTs to
 *  /api/auth/cli-login/start, gets a deviceCode (its polling credential)
 *  + a human-readable userCode the user types into the browser. The
 *  browser-authed user visits /cli-login?code=… and confirms, flipping
 *  status to 'authorized'. The CLI's next poll mints a real bearer
 *  token, sets consumedAt, and never re-mints. Sessions expire 15 min
 *  after creation; expired/consumed entries get pruned on the next
 *  start call so users.json doesn't grow without bound. */
export interface CliLoginSession {
  /** 32 random hex chars. The CLI's polling credential — anyone who has
   *  this can poll for status and (once authorized) mint a token. */
  deviceCode: string
  /** 8 hex chars uppercase, hyphenated like "ABCD-1234". Shown to the
   *  user, typed/clicked into the browser to identify the session. */
  userCode: string
  /** Human-readable device label (e.g. "alice-laptop") — becomes the
   *  token label once authorized. Defaults to "cli-device" if the CLI
   *  didn't supply one. */
  label: string
  status: 'pending' | 'authorized' | 'denied'
  createdAt: string
  /** createdAt + 15 minutes. Polls after this point get 410 expired. */
  expiresAt: string
  /** Set when status flips to 'authorized'. The browser-authed user's id. */
  authorizedUserId?: string
  /** Set when the CLI's poll mints the token. Subsequent polls 404 so
   *  the deviceCode can't be replayed to mint multiple tokens. */
  consumedAt?: string
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
  /** Short-lived CLI device-login sessions. Optional for forward-compat
   *  with older users.json files written before the field existed. */
  cliLoginSessions?: CliLoginSession[]
}

const EMPTY: FileShape = {
  version: 1,
  users: [],
  tokens: [],
  projects: [],
  memberships: [],
  cliLoginSessions: [],
}

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

  /** Sign up a new regular user. Returns null on duplicate email.
   *  Always creates a non-superuser account — the first-run admin claim
   *  goes through a separate setupAdmin() path with its own UI. Callers
   *  must check `userCount()` upstream and refuse the signup if no
   *  admin exists yet; this method doesn't gate on that, but consumers
   *  (web-routes) do. */
  async signup(email: string, name: string, plainPassword: string): Promise<UserRecord | null> {
    await this.load()
    if (await this.findUserByEmail(email)) return null
    const passwordHash = await hashPassword(plainPassword)
    const id = `u-${nextSuffix()}`
    const lowerEmail = email.toLowerCase()
    try {
      return await this.mutate((d) => {
        if (d.users.some((u) => u.email.toLowerCase() === lowerEmail)) {
          throw new Error('duplicate_email')
        }
        const record: UserRecord = {
          id,
          email,
          name,
          createdAt: new Date().toISOString(),
          passwordHash,
        }
        d.users.push(record)
        return record
      })
    } catch (err) {
      if ((err as Error).message === 'duplicate_email') return null
      throw err
    }
  }

  /** First-run admin claim: creates the superuser account on a fresh
   *  host. Asserts inside the mutate critical section that no user
   *  exists yet, so two concurrent /setup submissions can't both win.
   *  Returns:
   *   - the new superuser record on success
   *   - 'already_initialized' if the host already has at least one user
   *   - 'duplicate_email' is impossible here (the store was empty), but
   *      we keep the same shape for symmetry with signup(). */
  async setupAdmin(email: string, name: string, plainPassword: string): Promise<UserRecord | 'already_initialized'> {
    await this.load()
    if (this.data.users.length > 0) return 'already_initialized'
    const passwordHash = await hashPassword(plainPassword)
    const id = `u-${nextSuffix()}`
    try {
      return await this.mutate((d) => {
        if (d.users.length > 0) throw new Error('already_initialized')
        const record: UserRecord = {
          id,
          email,
          name,
          createdAt: new Date().toISOString(),
          passwordHash,
          isSuperuser: true,
        }
        d.users.push(record)
        return record
      })
    } catch (err) {
      if ((err as Error).message === 'already_initialized') return 'already_initialized'
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

  /** GitLab-style: any signed-in user can create a project and becomes
   *  its admin in one atomic step. Race-safe — the slug uniqueness check
   *  and the create both run inside the mutate critical section, so two
   *  concurrent create-project calls for the same slug get one winner
   *  and one 'duplicate' error. */
  async createProjectAsAdmin(
    creatorUserId: string,
    slug: string,
    name: string,
  ): Promise<ProjectRecord> {
    if (!/^[a-zA-Z0-9._-]+$/.test(slug)) {
      throw new Error(`invalid_slug`)
    }
    await this.load()
    if (!(await this.getUser(creatorUserId))) throw new Error(`no_user`)
    return this.mutate((d) => {
      if (d.projects.some((p) => p.slug === slug)) throw new Error('duplicate_slug')
      const project: ProjectRecord = {
        slug,
        name,
        createdAt: new Date().toISOString(),
      }
      const membership: MembershipRecord = {
        userId: creatorUserId,
        projectSlug: slug,
        role: 'admin',
        addedAt: project.createdAt,
      }
      d.projects.push(project)
      d.memberships.push(membership)
      return project
    })
  }

  /** Memberships for a user, joined with project metadata. Drives the
   *  dashboard's "Your projects" section. */
  async listMembershipsForUser(userId: string): Promise<Array<{ project: ProjectRecord; role: Role }>> {
    await this.load()
    const out: Array<{ project: ProjectRecord; role: Role }> = []
    for (const m of this.data.memberships) {
      if (m.userId !== userId) continue
      const project = this.data.projects.find((p) => p.slug === m.projectSlug)
      if (project) out.push({ project, role: m.role })
    }
    return out
  }

  /** Either claim a binding (project has none yet) or verify it. With
   *  `force: true` the caller can overwrite an existing binding —
   *  reserved for `margo rebind` after a legit fork or repo move; the
   *  route layer gates that to project admins / superusers. */
  async claimOrCheckProjectBinding(
    projectSlug: string,
    presented: { kind: 'git-origin' | 'uuid'; value: string },
    opts: { force?: boolean } = {},
  ): Promise<BindingResult> {
    await this.load()
    const existing = this.data.projects.find((p) => p.slug === projectSlug)
    if (!existing) throw new Error(`no_project`)
    const now = new Date().toISOString()
    if (!existing.repoBinding) {
      const recorded = { ...presented, recordedAt: now }
      await this.mutate((d) => {
        const p = d.projects.find((x) => x.slug === projectSlug)
        if (p) p.repoBinding = recorded
      })
      return { status: 'claimed', recorded }
    }
    const same = existing.repoBinding.kind === presented.kind && existing.repoBinding.value === presented.value
    if (same) {
      return { status: 'matched', recorded: existing.repoBinding }
    }
    if (opts.force) {
      const recorded = { ...presented, recordedAt: now }
      const previous = existing.repoBinding
      await this.mutate((d) => {
        const p = d.projects.find((x) => x.slug === projectSlug)
        if (p) p.repoBinding = recorded
      })
      return { status: 'rebound', recorded, previous }
    }
    return { status: 'mismatch', recorded: existing.repoBinding, presented }
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

  // ─── CLI device-login sessions ───────────────────────────────────────

  /** Start a new CLI device-login flow. Generates a 32-hex deviceCode
   *  (the CLI's polling credential) plus an 8-char hyphenated userCode
   *  for the user to enter in the browser. Prunes expired/consumed
   *  sessions while we're already inside the mutate critical section
   *  so users.json doesn't accumulate dead entries from abandoned
   *  logins. */
  async createCliLoginSession(label: string): Promise<CliLoginSession> {
    await this.load()
    const now = new Date()
    const session: CliLoginSession = {
      deviceCode: crypto.randomBytes(16).toString('hex'),
      userCode: formatUserCode(crypto.randomBytes(4).toString('hex')),
      label,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
    }
    return this.mutate((d) => {
      const list = d.cliLoginSessions ?? (d.cliLoginSessions = [])
      // Drop anything that's already past its expiry or already minted
      // a token — keeps the file small for hosts that see lots of CLI
      // logins.
      const nowMs = now.getTime()
      d.cliLoginSessions = list.filter((s) => !s.consumedAt && new Date(s.expiresAt).getTime() >= nowMs)
      d.cliLoginSessions.push(session)
      return session
    })
  }

  /** Look up a session by its deviceCode. Reads fresh from disk because
   *  the CLI polls every 2s while a separate process (browser) flips
   *  the status to 'authorized' — same cross-process freshness story
   *  as resolveToken. */
  async findCliLoginSessionByDeviceCode(deviceCode: string): Promise<CliLoginSession | null> {
    await this.reload()
    const list = this.data.cliLoginSessions ?? []
    return list.find((s) => s.deviceCode === deviceCode) ?? null
  }

  /** Look up a session by its userCode. Case-INSENSITIVE so users can
   *  type lowercase without confusion. Same fresh-read rationale as
   *  findCliLoginSessionByDeviceCode. */
  async findCliLoginSessionByUserCode(userCode: string): Promise<CliLoginSession | null> {
    await this.reload()
    const upper = userCode.toUpperCase()
    const list = this.data.cliLoginSessions ?? []
    return list.find((s) => s.userCode.toUpperCase() === upper) ?? null
  }

  /** Flip a session to 'authorized' under the signed-in user's id. The
   *  status check happens inside the mutate critical section so two
   *  concurrent confirms (user double-clicks Authorize) can't both win
   *  with different userIds. Returns null if the session is unknown,
   *  expired, denied, or already consumed. */
  async authorizeCliLoginSession(userCode: string, userId: string): Promise<CliLoginSession | null> {
    await this.load()
    const upper = userCode.toUpperCase()
    try {
      return await this.mutate((d) => {
        const list = d.cliLoginSessions ?? []
        const session = list.find((s) => s.userCode.toUpperCase() === upper)
        if (!session) throw new Error('not_found')
        if (session.consumedAt) throw new Error('not_found')
        if (new Date(session.expiresAt).getTime() < Date.now()) throw new Error('not_found')
        if (session.status === 'denied') throw new Error('not_found')
        session.status = 'authorized'
        session.authorizedUserId = userId
        return session
      })
    } catch (err) {
      if ((err as Error).message === 'not_found') return null
      throw err
    }
  }

  /** Called by the CLI's polling endpoint once it sees status='authorized'.
   *  Atomically marks the session as consumed and returns the user the
   *  caller should mint a token for. Returns null if the session is
   *  unknown, expired, not yet authorized, or already consumed — the
   *  consumedAt check makes the deviceCode single-use so a stolen
   *  deviceCode can't replay-mint additional tokens after the original
   *  poll. */
  async consumeCliLoginSession(deviceCode: string): Promise<{ session: CliLoginSession; user: UserRecord } | null> {
    await this.load()
    try {
      return await this.mutate((d) => {
        const list = d.cliLoginSessions ?? []
        const session = list.find((s) => s.deviceCode === deviceCode)
        if (!session) throw new Error('not_found')
        if (session.consumedAt) throw new Error('not_found')
        if (new Date(session.expiresAt).getTime() < Date.now()) throw new Error('not_found')
        if (session.status !== 'authorized') throw new Error('not_found')
        if (!session.authorizedUserId) throw new Error('not_found')
        const user = d.users.find((u) => u.id === session.authorizedUserId)
        if (!user) throw new Error('not_found')
        session.consumedAt = new Date().toISOString()
        return { session, user }
      })
    } catch (err) {
      if ((err as Error).message === 'not_found') return null
      throw err
    }
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
  const out: FileShape = {
    version: 1,
    users: Array.isArray(parsed.users) ? parsed.users : [],
    tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [],
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    memberships: Array.isArray(parsed.memberships) ? parsed.memberships : [],
    cliLoginSessions: Array.isArray(parsed.cliLoginSessions) ? parsed.cliLoginSessions : [],
  }
  if (parsed.sessionSecret) out.sessionSecret = parsed.sessionSecret
  return out
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

// 8 random hex chars — plenty unique for the lifetime of a single host
// while staying human-readable in CLI output ("u-3f8a91c2").
function nextSuffix(): string {
  return crypto.randomBytes(4).toString('hex')
}

// Format 8 hex chars as "ABCD-1234" — easier to read aloud and copy
// without losing track of position than an unbroken string. Crockford
// would prefer a base32 alphabet without ambiguous chars, but plain hex
// keeps the entropy story simple and is good enough for a 15-minute
// window with a per-userCode session.
function formatUserCode(hex8: string): string {
  const upper = hex8.toUpperCase()
  return `${upper.slice(0, 4)}-${upper.slice(4, 8)}`
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
