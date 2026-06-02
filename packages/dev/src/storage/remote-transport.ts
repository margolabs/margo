// Remote storage backend — talks HTTP to a margo host (see ../host/). Used
// when the workspace's margo.config selects `storage: 'server'`. Same
// Transport contract as LocalTransport so handlers don't care which backend
// they're running against.
//
// Data flow for a teammate-visible change:
//   Browser POST → user's dev server (Vite/Next plugin) →
//   handlers.createComment → transport.write → HTTP PUT → host commits +
//   broadcasts SSE → every connected RemoteTransport (including the one
//   that authored the write) receives the echo → fires the subscribe
//   listener → handlers' broadcastSse fans out to all locally-connected
//   browsers. Net result: every browser on every machine sees the change
//   in milliseconds without any git round-trip.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { parseComment } from '../shared/frontmatter.js'
import type { Comment } from '../shared/types.js'
import { SyncOutbox } from './sync-outbox.js'
import {
  AuthError,
  ConflictError,
  type ChangeEvent,
  type Identity,
  type RemoteChanges,
  type RemoteChangesListener,
  type Transport,
} from './transport.js'

export interface RemoteTransportOptions {
  /** Base URL of the margo host, e.g. https://margo.acme.com. */
  serverUrl: string
  /** Project id on the host. Picked at `margo init` time. */
  project: string
  /** Bearer token. Read from env in plugin wiring; never persisted in the
   *  committed config. */
  token: string
  /** Local cache directory for offline-first behavior. When set, write/
   *  remove calls hit the cache first and queue to an outbox if the host
   *  is unreachable, so pins land instantly and survive a brief host
   *  outage. drain() retries the queue. Optional only because some test
   *  paths construct a transport without cache; production always sets
   *  it via the factory. */
  cacheDir?: string
}

/** Returned by RemoteTransport.getSyncStatus(). The overlay surfaces
 *  `pending > 0` as a "syncing" banner so the user knows their offline
 *  pins haven't reached the host yet. */
export interface SyncStatus {
  /** Outbox depth — operations queued but not yet acknowledged. */
  pending: number
  /** Last time drain() succeeded against the host. null if never. */
  lastSyncAt: string | null
  /** Last error from a drain attempt. null when last drain was clean. */
  lastError: string | null
}

/** Result of a /binding round-trip — surfaced by getBindingStatus() so
 *  the plugin can pipe it through to the overlay's no-access/mismatch UX. */
export type BindingStatus =
  | { status: 'claimed'; recorded: { kind: string; value: string; recordedAt: string } }
  | { status: 'matched'; recorded: { kind: string; value: string; recordedAt: string } }
  | { status: 'mismatch'; recorded: { kind: string; value: string; recordedAt: string }; presented: { kind: string; value: string } }
  | { status: 'rebound'; recorded: { kind: string; value: string; recordedAt: string }; previous: { kind: string; value: string; recordedAt: string } }
  | { status: 'error'; message: string }

export class RemoteTransport implements Transport {
  private readonly base: string
  private readonly token: string
  private readonly changeListeners = new Set<(ev: ChangeEvent) => void>()
  private sseAbort: AbortController | null = null
  /** Latest ETag we've seen per comment id (from GET or PUT responses).
   *  Used to populate If-Match on subsequent writes for optimistic
   *  concurrency control. Cleared on SSE 'deleted'; refreshed on each
   *  read/write round-trip. */
  private readonly etags = new Map<string, string>()
  /** Cached binding status from the last /binding round-trip. Surfaced
   *  via getBindingStatus() so the plugin's /__margo/me proxy can include
   *  it in the response without re-fetching. */
  private cachedBindingStatus: BindingStatus | null = null

  private readonly cacheDir: string | null
  private readonly outbox: SyncOutbox | null
  private lastSyncAt: string | null = null
  private lastError: string | null = null

  constructor(opts: RemoteTransportOptions) {
    // Strip trailing slash so URL composition stays clean (`${base}/api/...`).
    this.base = opts.serverUrl.replace(/\/+$/, '') + `/api/projects/${encodeURIComponent(opts.project)}`
    this.token = opts.token
    if (opts.cacheDir) {
      // Cache lives at <cacheDir>/comments/<id>.md — the same path the
      // plugin's SSE-driven mirror writes to. By writing here directly
      // on host-failure paths, the user's pin shows up locally even
      // when the host can't acknowledge it. The .outbox/ sibling holds
      // the retry queue.
      this.cacheDir = opts.cacheDir
      this.outbox = new SyncOutbox(opts.cacheDir)
    } else {
      this.cacheDir = null
      this.outbox = null
    }
  }

  /** Most recent ETag for a comment id, if any has been observed. Callers
   *  pass this back as `opts.ifMatch` on the next write for that id. */
  getKnownEtag(id: string): string | undefined {
    return this.etags.get(id)
  }

  // ─── Comment CRUD ───────────────────────────────────────────────────────

  async list(): Promise<Comment[]> {
    const res = await this.fetch(`${this.base}/comments`)
    if (!res.ok) throw await asError(res, 'list')
    const data = (await res.json()) as { comments: Comment[] }
    return data.comments
  }

  async read(id: string): Promise<Comment | null> {
    const res = await this.fetch(`${this.base}/comments/${encodeURIComponent(id)}`)
    if (res.status === 404) return null
    if (!res.ok) throw await asError(res, 'read')
    const raw = await res.text()
    this.captureEtag(id, res)
    try {
      return parseComment(raw, '')
    } catch {
      return null
    }
  }

  async write(id: string, raw: string, commitMessage: string, opts?: { ifMatch?: string }): Promise<void> {
    try {
      await this.pushWrite(id, raw, opts)
      return
    } catch (err) {
      // ConflictError / AuthError are real failures the caller must
      // handle — never queue them. Network errors only.
      if (err instanceof ConflictError) throw err
      if (err instanceof AuthError) throw err
      if (!isNetworkError(err)) throw err
      if (!this.outbox || !this.cacheDir) throw err
      // Offline fast path: write the cache copy so the overlay sees
      // the user's pin instantly, then queue the op for retry.
      await this.writeCacheFile(id, raw)
      await this.outbox.enqueue({
        op: 'write',
        id,
        payload: raw,
        commitMessage,
        ifMatchEtag: opts?.ifMatch ?? null,
        enqueuedAt: new Date().toISOString(),
      })
      this.lastError = `host unreachable — queued ${id} (${this.outbox ? await this.outbox.count() : 0} pending)`
    }
  }

  /** Single host PUT — separated so `drain()` can reuse the same code
   *  path for retries without re-queuing on failure. */
  private async pushWrite(id: string, raw: string, opts?: { ifMatch?: string }): Promise<void> {
    const headers: Record<string, string> = { 'content-type': 'text/markdown; charset=utf-8' }
    if (opts?.ifMatch) headers['if-match'] = quoteEtag(opts.ifMatch)
    const res = await this.fetch(`${this.base}/comments/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers,
      body: raw,
    })
    if (res.status === 412) {
      let currentEtag: string | null = null
      try {
        const body = (await res.json()) as { current?: string }
        if (typeof body.current === 'string') currentEtag = body.current
      } catch { /* response may be plain text */ }
      this.etags.delete(id)
      throw new ConflictError(currentEtag, id)
    }
    if (!res.ok) throw await asError(res, 'write')
    this.captureEtag(id, res)
  }

  /** Direct cache-file write. Bypasses the plugin's SSE-driven mirror
   *  for the offline path — needed because the host never broadcast the
   *  event (it never saw the write). */
  private async writeCacheFile(id: string, raw: string): Promise<void> {
    if (!this.cacheDir) return
    const dir = path.join(this.cacheDir, 'comments')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, `${id}.md`), raw, 'utf8')
  }

  private captureEtag(id: string, res: Response): void {
    const raw = res.headers.get('etag')
    if (!raw) return
    this.etags.set(id, unquoteEtag(raw))
  }

  async remove(id: string, commitMessage: string): Promise<void> {
    try {
      await this.pushRemove(id)
      return
    } catch (err) {
      if (err instanceof AuthError) throw err
      if (!isNetworkError(err)) throw err
      if (!this.outbox || !this.cacheDir) throw err
      // Offline path: unlink the cache file + queue the delete.
      await this.unlinkCacheFile(id)
      await this.outbox.enqueue({
        op: 'remove',
        id,
        payload: '',
        commitMessage,
        ifMatchEtag: null,
        enqueuedAt: new Date().toISOString(),
      })
      this.lastError = `host unreachable — queued delete ${id} (${this.outbox ? await this.outbox.count() : 0} pending)`
    }
  }

  private async pushRemove(id: string): Promise<void> {
    const res = await this.fetch(`${this.base}/comments/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
    if (!res.ok && res.status !== 404) throw await asError(res, 'remove')
  }

  private async unlinkCacheFile(id: string): Promise<void> {
    if (!this.cacheDir) return
    const file = path.join(this.cacheDir, 'comments', `${id}.md`)
    await fs.unlink(file).catch(() => undefined)
  }

  // ─── Decisions log ──────────────────────────────────────────────────────

  async appendDecision(entry: string, commitMessage: string): Promise<void> {
    try {
      await this.pushDecision(entry, commitMessage)
      return
    } catch (err) {
      if (err instanceof AuthError) throw err
      if (!isNetworkError(err)) throw err
      if (!this.outbox) throw err
      await this.outbox.enqueue({
        op: 'decision',
        id: 'decisions',
        payload: entry,
        commitMessage,
        ifMatchEtag: null,
        enqueuedAt: new Date().toISOString(),
      })
      this.lastError = `host unreachable — queued decision-log entry`
    }
  }

  private async pushDecision(entry: string, commitMessage: string): Promise<void> {
    const res = await this.fetch(`${this.base}/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry, commitMessage }),
    })
    if (!res.ok) throw await asError(res, 'appendDecision')
  }

  // ─── Outbox drain + status ──────────────────────────────────────────────

  /** Attempt to push every pending op to the host. Stops at the first
   *  network failure (no point hammering an unreachable host) but
   *  continues past per-op AuthError/ConflictError (logs and leaves the
   *  entry — those need human/auth resolution). Returns a summary the
   *  plugin can surface to the operator log. */
  async drain(): Promise<{ pushed: number; pending: number; error?: string }> {
    if (!this.outbox) return { pushed: 0, pending: 0 }
    const entries = await this.outbox.list()
    let pushed = 0
    for (const entry of entries) {
      try {
        if (entry.op === 'write') {
          await this.pushWrite(entry.id, entry.payload, entry.ifMatchEtag ? { ifMatch: entry.ifMatchEtag } : undefined)
        } else if (entry.op === 'remove') {
          await this.pushRemove(entry.id)
        } else if (entry.op === 'decision') {
          await this.pushDecision(entry.payload, entry.commitMessage)
        }
        await this.outbox.remove(entry)
        pushed++
      } catch (err) {
        if (isNetworkError(err)) {
          // Stop the loop — host is still down. Leave this and the
          // remaining entries in the outbox for the next drain.
          const pending = await this.outbox.count()
          this.lastError = `host unreachable — ${pending} op(s) pending`
          return { pushed, pending, error: 'network' }
        }
        // ConflictError / AuthError / 5xx — leave this entry but keep
        // trying others (they may target different comments).
        console.warn(`[margo] outbox drain: ${entry.op} ${entry.id} failed:`, (err as Error).message)
        // Don't remove — let the user resolve. Skip past it.
      }
    }
    const pending = await this.outbox.count()
    this.lastSyncAt = new Date().toISOString()
    this.lastError = pending > 0 ? `${pending} op(s) still pending (likely conflict — see logs)` : null
    return { pushed, pending }
  }

  /** Surface outbox depth + last-sync timestamp to the overlay via the
   *  plugin's /__margo/sync-status endpoint. */
  async getSyncStatus(): Promise<SyncStatus> {
    return {
      pending: this.outbox ? await this.outbox.count() : 0,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
    }
  }

  // ─── Identity ───────────────────────────────────────────────────────────

  /** Cached identity from the last successful /me round-trip. In server
   *  mode the identity is bound to the bearer token, so once we know it,
   *  it doesn't change for the lifetime of this transport. Caching it
   *  lets offline writes still know who the author is — without this,
   *  createComment would fail at the getIdentity() step the moment the
   *  host went unreachable, before the offline-tolerant write() path
   *  even gets a chance to fire. */
  private cachedIdentity: Identity | null = null

  async getIdentity(): Promise<Identity | null> {
    try {
      const res = await this.fetch(`${this.base}/me`)
      if (!res.ok) return this.cachedIdentity
      const fresh = (await res.json()) as Identity
      this.cachedIdentity = fresh
      return fresh
    } catch (err) {
      // AuthError surfaces upstream so the plugin can flip to needsAuth.
      // Network errors fall back to the cached identity — better to let
      // a fresh pin go through with a slightly stale name than to fail
      // every offline write.
      if (err instanceof AuthError) throw err
      if (isNetworkError(err) && this.cachedIdentity) return this.cachedIdentity
      throw err
    }
  }

  async setIdentity(_info: Identity): Promise<void> {
    // Identity in server mode is bound to the auth token. The user's local
    // git config is irrelevant here, and overwriting it would surprise the
    // operator. Quietly noop — the overlay never reaches this path in
    // server mode because /me always resolves on first load.
  }

  async getDeclaredRole(_email: string): Promise<string | null> {
    // Phase-2 host has no project roster, so there's no role to declare.
    // Future: hit `/api/projects/:project/roster/:email`.
    return null
  }

  // ─── Sync ───────────────────────────────────────────────────────────────

  async sync(): Promise<void> {
    // Server is authoritative; sync is a noop on the wire (the host returns
    // 200 unconditionally). We still call it so the local handler chain's
    // onAfterSync hook fires symmetrically with local mode.
    await this.fetch(`${this.base}/sync`, { method: 'POST' }).catch(() => undefined)
  }

  // ─── Subscriptions ──────────────────────────────────────────────────────

  subscribe(handler: (ev: ChangeEvent) => void): () => void {
    this.changeListeners.add(handler)
    if (this.changeListeners.size === 1) this.startSse()
    return () => {
      this.changeListeners.delete(handler)
      if (this.changeListeners.size === 0) this.stopSse()
    }
  }

  subscribeRemoteChanges(listener: RemoteChangesListener): () => void {
    // Server mode has no "upstream divergence" concept — the host IS the
    // source of truth, and changes from teammates arrive via the same SSE
    // stream as local edits. Immediately notify the listener with null so
    // any banner state in the overlay clears, then never call it again.
    listener(null)
    return () => { /* nothing to unsubscribe */ }
  }

  getLastRemoteChanges(): RemoteChanges | null {
    return null
  }

  resetRemoteChanges(): void {
    // noop — see subscribeRemoteChanges.
  }

  async close(): Promise<void> {
    this.stopSse()
    this.changeListeners.clear()
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private async fetch(input: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers ?? undefined)
    headers.set('authorization', `Bearer ${this.token}`)
    const res = await fetch(input, { ...init, headers })
    // 401/403 means the bearer token is dead — most commonly because the
    // user revoked it from the host dashboard, or an admin booted them
    // from the project. Surface it as a typed error so the plugin can
    // null the transport and flip the overlay to the sign-in pill,
    // instead of every caller silently returning empty data and the UI
    // misreading it as "missing git config / no comments yet."
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(res.status, `${init.method ?? 'GET'} ${stripBase(input, this.base)}`)
    }
    return res
  }

  /** Open a long-lived SSE stream against the host's events endpoint and
   *  fan its parsed events out to subscribers. Auto-reconnects with a small
   *  backoff so a transient host blip doesn't permanently silence updates. */
  private startSse(): void {
    if (this.sseAbort) return
    const ctrl = new AbortController()
    this.sseAbort = ctrl
    void this.streamSse(ctrl.signal)
  }

  private stopSse(): void {
    this.sseAbort?.abort()
    this.sseAbort = null
  }

  private async streamSse(signal: AbortSignal): Promise<void> {
    // Reconnect loop. Bail when explicitly aborted (close()/last-unsubscribe).
    let backoffMs = 500
    while (!signal.aborted) {
      try {
        const res = await fetch(`${this.base}/events`, {
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: 'text/event-stream',
          },
          signal,
        })
        if (!res.ok || !res.body) {
          // Permanent failures (auth/access/missing project) shouldn't
          // be retried — that would just hammer the host. 401 = bad
          // token, 403 = not a member of this project, 404 = project
          // doesn't exist. Log once and stop the loop; the plugin will
          // try again on next dev-server restart.
          if (res.status === 401 || res.status === 403 || res.status === 404) {
            console.warn(`[margo] SSE stream not available (HTTP ${res.status}) — not retrying. Run \`docker logs\` on the host for details.`)
            return
          }
          throw new Error(`SSE returned ${res.status}`)
        }
        backoffMs = 500 // reset on a clean connect
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        while (!signal.aborted) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          // SSE frames are separated by a blank line. Comment lines start
          // with `:` (the host's `: connected ...` keepalive) and we ignore
          // them — only `data:` lines carry payloads we care about.
          let idx: number
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const dataLine = frame
              .split('\n')
              .map((l) => l.trimEnd())
              .find((l) => l.startsWith('data:'))
            if (!dataLine) continue
            const payload = dataLine.slice(5).trimStart()
            try {
              const ev = JSON.parse(payload) as unknown
              if (isChangeEvent(ev)) {
                // Invalidate stale ETags before fanning out — a deleted
                // comment can't be written-with-If-Match, and an updated
                // one has a new ETag we'll only learn from the next read.
                if (ev.type === 'deleted') this.etags.delete(ev.id)
                else if (ev.type === 'updated') this.etags.delete(ev.id)
                for (const fn of this.changeListeners) fn(ev)
              }
            } catch {
              // Malformed frame — keep streaming.
            }
          }
        }
      } catch (err) {
        if (signal.aborted) return
        console.warn('[margo] SSE stream interrupted, reconnecting:', (err as Error).message)
      }
      if (signal.aborted) return
      await sleep(backoffMs, signal)
      backoffMs = Math.min(backoffMs * 2, 10_000)
    }
  }
}

/** ETag values are quoted per RFC 7232. We store the bare hash internally
 *  for simpler comparisons, and re-quote on the wire. */
function quoteEtag(v: string): string {
  return v.startsWith('"') ? v : `"${v}"`
}

function unquoteEtag(v: string): string {
  const trimmed = v.trim()
  if (trimmed.startsWith('W/')) return trimmed.slice(2).replace(/^"|"$/g, '')
  return trimmed.replace(/^"|"$/g, '')
}

function isChangeEvent(v: unknown): v is ChangeEvent {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    (o.type === 'created' || o.type === 'updated' || o.type === 'deleted') &&
    typeof o.id === 'string'
  )
}

function stripBase(input: string, base: string): string {
  return input.startsWith(base) ? input.slice(base.length) || '/' : input
}

/** Detect "host not reachable" failures vs. real protocol errors. Node's
 *  fetch throws TypeError with a `.cause` carrying ECONNREFUSED /
 *  ENOTFOUND / ETIMEDOUT when the host can't be reached. Anything else
 *  (4xx/5xx from the server, AuthError, ConflictError) is a real
 *  protocol-level failure and must NOT be queued — the user'd see their
 *  pin appear locally but never realize the host actively rejected it. */
function isNetworkError(err: unknown): boolean {
  if (!err) return false
  if (err instanceof TypeError && /fetch failed|network/i.test(err.message)) return true
  const cause = (err as { cause?: { code?: string } }).cause
  if (cause?.code) {
    return /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)$/.test(cause.code)
  }
  return false
}

async function asError(res: Response, op: string): Promise<Error> {
  let detail = ''
  try {
    detail = await res.text()
  } catch { /* ignore */ }
  return new Error(`margo remote ${op} failed: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
