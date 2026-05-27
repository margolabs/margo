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

import { parseComment } from '../shared/frontmatter.js'
import type { Comment } from '../shared/types.js'
import type {
  ChangeEvent,
  Identity,
  RemoteChanges,
  RemoteChangesListener,
  Transport,
} from './transport.js'

export interface RemoteTransportOptions {
  /** Base URL of the margo host, e.g. https://margo.acme.com. */
  serverUrl: string
  /** Project id on the host. Picked at `margo init` time. */
  project: string
  /** Bearer token. Read from env in plugin wiring; never persisted in the
   *  committed config. */
  token: string
}

export class RemoteTransport implements Transport {
  private readonly base: string
  private readonly token: string
  private readonly changeListeners = new Set<(ev: ChangeEvent) => void>()
  private sseAbort: AbortController | null = null

  constructor(opts: RemoteTransportOptions) {
    // Strip trailing slash so URL composition stays clean (`${base}/api/...`).
    this.base = opts.serverUrl.replace(/\/+$/, '') + `/api/projects/${encodeURIComponent(opts.project)}`
    this.token = opts.token
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
    try {
      return parseComment(raw, '')
    } catch {
      return null
    }
  }

  async write(id: string, raw: string, _commitMessage: string): Promise<void> {
    const res = await this.fetch(`${this.base}/comments/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
      body: raw,
    })
    // commitMessage is shaped by the host (it knows the actor's identity).
    // The argument is part of the Transport contract so the local transport
    // can use it; the remote transport intentionally ignores it.
    if (!res.ok) throw await asError(res, 'write')
  }

  async remove(id: string, _commitMessage: string): Promise<void> {
    const res = await this.fetch(`${this.base}/comments/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
    if (!res.ok && res.status !== 404) throw await asError(res, 'remove')
  }

  // ─── Decisions log ──────────────────────────────────────────────────────

  async appendDecision(entry: string, commitMessage: string): Promise<void> {
    const res = await this.fetch(`${this.base}/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry, commitMessage }),
    })
    if (!res.ok) throw await asError(res, 'appendDecision')
  }

  // ─── Identity ───────────────────────────────────────────────────────────

  async getIdentity(): Promise<Identity | null> {
    const res = await this.fetch(`${this.base}/me`)
    if (!res.ok) return null
    return (await res.json()) as Identity
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

  private fetch(input: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers ?? undefined)
    headers.set('authorization', `Bearer ${this.token}`)
    return fetch(input, { ...init, headers })
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
        if (!res.ok || !res.body) throw new Error(`SSE returned ${res.status}`)
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

function isChangeEvent(v: unknown): v is ChangeEvent {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    (o.type === 'created' || o.type === 'updated' || o.type === 'deleted') &&
    typeof o.id === 'string'
  )
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
