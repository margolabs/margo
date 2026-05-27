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
}

const EMPTY: FileShape = { version: 1, users: [], tokens: [] }

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

  async createUser(email: string, name: string): Promise<UserRecord> {
    await this.load()
    const existing = await this.findUserByEmail(email)
    if (existing) throw new Error(`user with email ${email} already exists (id ${existing.id})`)
    const record: UserRecord = {
      id: `u-${nextSuffix()}`,
      email,
      name,
      createdAt: new Date().toISOString(),
    }
    return this.mutate((d) => {
      d.users.push(record)
      return record
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
