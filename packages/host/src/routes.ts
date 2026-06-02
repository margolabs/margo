// HTTP route table for the margo host. Shape matches what the future
// RemoteTransport will call from the client plugin:
//
//   GET    /api/projects/:project/comments              → list
//   PUT    /api/projects/:project/comments/:id          → create or update
//   DELETE /api/projects/:project/comments/:id          → remove
//   POST   /api/projects/:project/decisions             → append
//   GET    /api/projects/:project/events                → SSE
//   POST   /api/projects/:project/sync                  → noop (server is authoritative)
//   GET    /api/projects/:project/me                    → authenticated identity
//
// Identity is global (one auth config per server in phase 2); the per-
// project nesting in the URL is forward-compatible for roster-based
// ACLs later. Git state (commit/branch/dirty for the *user's* working
// repo) is NOT a host concern — the client's local plugin keeps serving
// /__margo/git-state even in server mode, because it describes the
// user's code, not the comment store.

import * as crypto from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { authenticate, authorize, AuthError, type AuthConfig, type AuthIdentity } from './auth.js'
import { ProjectStore } from './store.js'

export interface SseSubscriber {
  write(payload: string): void
}

export interface RoutesContext {
  store: ProjectStore
  auth: AuthConfig
  /** SSE subscribers keyed by project — events stay scoped so subscribers
   *  in project A don't get notified about project B. */
  sseClients: Map<string, Set<SseSubscriber>>
  /** Broadcast a payload to every subscriber of the given project. */
  broadcast(project: string, payload: unknown): void
}

export async function dispatch(
  ctx: RoutesContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = req.url ?? ''
  const path = url.split('?', 1)[0]

  // CLI device-login endpoints. These sit outside the per-project tree
  // because the whole point is that the CLI doesn't have a bearer token
  // yet — the deviceCode IS the credential for /poll, and /start is
  // public so `npx margo login` can kick off the flow against any host.
  if (path === '/api/auth/cli-login/start' && req.method === 'POST') {
    return await handleCliLoginStart(ctx, req, res)
  }
  if (path === '/api/auth/cli-login/poll' && req.method === 'POST') {
    return await handleCliLoginPoll(ctx, req, res)
  }

  // Token-only identity endpoint. Used by `margo login --token <key>` to
  // validate a hand-pasted token (so a typo fails loudly before we write
  // it to ~/.margo/credentials.json) and to fetch the email/name that
  // populate the credentials entry. Project-scoped /me requires a slug;
  // /api/me is taken by the session-cookie dashboard endpoint; this one
  // is bearer-only and project-agnostic, which matches what a pre-
  // credential validate call actually needs.
  if (path === '/api/auth/whoami' && req.method === 'GET') {
    try {
      const user = await authenticate(req, ctx.auth)
      return sendJson(res, 200, {
        id: user.id,
        email: user.email,
        name: user.name,
        isSuperuser: !!user.isSuperuser,
      })
    } catch (err) {
      if (err instanceof AuthError) {
        res
          .writeHead(err.status, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: err.message }))
        return
      }
      sendJson(res, 500, { error: (err as Error).message })
      return
    }
  }

  const m = /^\/api\/projects\/([a-zA-Z0-9._-]+)\/(.+)$/.exec(path)
  if (!m) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}')
    return
  }
  const [, project, rest] = m

  try {
    const user = await authenticate(req, ctx.auth)
    const identity: AuthIdentity = { email: user.email, name: user.name }

    // /me is intentionally pre-authorize: any authenticated user can ask
    // "who am I?" against any project slug, even ones they don't have
    // access to — so the overlay can render a clear "you're not a member
    // of this project" state instead of silently failing on every other
    // request. Returns the identity plus the role on the requested
    // project (or `null` when the user has no membership and isn't a
    // superuser). Superusers always report 'admin' since they bypass
    // ACL anyway.
    if (rest === 'me' && req.method === 'GET') {
      // Distinguish "project doesn't exist" (typo / forgot to create) from
      // "exists but no membership" — both surfaced via 200 so the overlay
      // can render an informative state instead of generic 404. Clients
      // (CLI init + plugin) decide what to display.
      const projectRecord = await ctx.auth.users.getProject(project)
      const projectExists = projectRecord !== null
      let role: 'read' | 'write' | 'admin' | null = null
      if (user.isSuperuser) {
        role = 'admin'
      } else if (projectExists) {
        const m = await ctx.auth.users.getMembership(user.id, project)
        if (m) role = m.role
      }
      return sendJson(res, 200, { ...identity, role, projectExists })
    }

    // Everything else is project-scoped. Required role mirrors HTTP
    // semantics: safe methods need read; mutating methods need write.
    const required = req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write'
    await authorize(ctx.auth, user, project, required)

    if (rest === 'comments' && req.method === 'GET') {
      return await handleList(ctx, project, res)
    }
    const commentMatch = /^comments\/([a-zA-Z0-9._-]+)$/.exec(rest)
    if (commentMatch) {
      const [, id] = commentMatch
      if (req.method === 'GET') return await handleRead(ctx, project, id, res)
      if (req.method === 'PUT') return await handleWrite(ctx, project, id, identity, req, res)
      if (req.method === 'DELETE') return await handleDelete(ctx, project, id, identity, req, res)
    }
    if (rest === 'decisions' && req.method === 'POST') {
      return await handleAppendDecision(ctx, project, identity, req, res)
    }
    if (rest === 'sync' && req.method === 'POST') {
      // Server is authoritative — sync is a noop. Kept as an endpoint so
      // the client's `transport.sync()` call always has somewhere to go.
      return sendJson(res, 200, { ok: true })
    }
    if (rest === 'events' && req.method === 'GET') {
      return handleEvents(ctx, project, req, res)
    }
    if (rest === 'binding' && req.method === 'POST') {
      return await handleClaimBinding(ctx, project, user, req, res)
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}')
  } catch (err) {
    if (err instanceof AuthError) {
      res
        .writeHead(err.status, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: err.message }))
      return
    }
    sendJson(res, 500, { error: (err as Error).message })
  }
}

async function handleList(ctx: RoutesContext, project: string, res: ServerResponse): Promise<void> {
  const comments = await ctx.store.list(project)
  sendJson(res, 200, { comments })
}

async function handleRead(
  ctx: RoutesContext,
  project: string,
  id: string,
  res: ServerResponse,
): Promise<void> {
  const found = await ctx.store.read(project, id)
  if (!found) {
    sendJson(res, 404, { error: 'not found' })
    return
  }
  res.writeHead(200, {
    'content-type': 'text/markdown; charset=utf-8',
    etag: `"${etagOf(found.raw)}"`,
  }).end(found.raw)
}

async function handleWrite(
  ctx: RoutesContext,
  project: string,
  id: string,
  identity: AuthIdentity,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readText(req)
  if (!raw) {
    sendJson(res, 400, { error: 'empty body' })
    return
  }
  // Optimistic concurrency: if the caller passed If-Match, the stored
  // content's current ETag must match. Returning the current ETag in
  // the 412 body lets the caller refetch without a second round-trip.
  const ifMatch = readIfMatch(req)
  const existing = await ctx.store.read(project, id)
  if (ifMatch !== null && existing) {
    const currentEtag = etagOf(existing.raw)
    if (ifMatch !== currentEtag) {
      res.writeHead(412, {
        'content-type': 'application/json',
        etag: `"${currentEtag}"`,
      }).end(JSON.stringify({ error: 'etag mismatch', current: currentEtag }))
      return
    }
  }
  const existed = !!existing
  await ctx.store.write(project, id, raw, {
    commitMessage: existed ? `update on ${id}` : `comment ${id} by ${identity.email}`,
    authorEmail: identity.email,
    authorName: identity.name,
  })
  ctx.broadcast(project, { type: existed ? 'updated' : 'created', id })
  res.writeHead(existed ? 200 : 201, {
    'content-type': 'application/json',
    etag: `"${etagOf(raw)}"`,
  }).end(JSON.stringify({ ok: true }))
}

function etagOf(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

function readIfMatch(req: IncomingMessage): string | null {
  const h = req.headers['if-match']
  if (!h) return null
  const raw = Array.isArray(h) ? h[0] : h
  const trimmed = raw.trim()
  if (trimmed === '*') return '*'
  // RFC 7232 says values are quoted; tolerate unquoted from sloppy clients.
  return trimmed.replace(/^"|"$/g, '')
}

async function handleDelete(
  ctx: RoutesContext,
  project: string,
  id: string,
  identity: AuthIdentity,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const existing = await ctx.store.read(project, id)
  if (!existing) {
    sendJson(res, 404, { error: 'not found' })
    return
  }
  await ctx.store.remove(project, id, {
    commitMessage: `delete ${id} by ${identity.email}`,
    authorEmail: identity.email,
    authorName: identity.name,
  })
  ctx.broadcast(project, { type: 'deleted', id })
  sendJson(res, 200, { ok: true })
}

async function handleAppendDecision(
  ctx: RoutesContext,
  project: string,
  identity: AuthIdentity,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJson<{ entry?: string; commitMessage?: string }>(req)
  if (!body.entry || typeof body.entry !== 'string') {
    sendJson(res, 400, { error: 'entry is required' })
    return
  }
  await ctx.store.appendDecision(project, body.entry, {
    commitMessage: body.commitMessage ?? 'decision',
    authorEmail: identity.email,
    authorName: identity.name,
  })
  sendJson(res, 200, { ok: true })
}

async function handleClaimBinding(
  ctx: RoutesContext,
  project: string,
  user: { id: string; isSuperuser?: boolean },
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJson<{ kind?: string; value?: string; force?: boolean }>(req)
  if (body.kind !== 'git-origin' && body.kind !== 'uuid') {
    sendJson(res, 400, { error: 'kind must be git-origin or uuid' })
    return
  }
  if (!body.value || typeof body.value !== 'string') {
    sendJson(res, 400, { error: 'value is required' })
    return
  }
  // Force-rebind is a destructive admin action — wipes the recorded
  // history of "this project belongs to repo X". Any project admin /
  // superuser can do it; regular members can only claim/check.
  let force = !!body.force
  if (force) {
    if (!user.isSuperuser) {
      const membership = await ctx.auth.users.getMembership(user.id, project)
      if (membership?.role !== 'admin') {
        sendJson(res, 403, { error: 'force-rebind requires project admin or superuser' })
        return
      }
    }
  }
  try {
    const result = await ctx.auth.users.claimOrCheckProjectBinding(
      project,
      { kind: body.kind, value: body.value },
      { force },
    )
    sendJson(res, 200, result)
  } catch (err) {
    const msg = (err as Error).message
    if (msg === 'no_project') {
      sendJson(res, 404, { error: 'no such project' })
      return
    }
    sendJson(res, 500, { error: msg })
  }
}

function handleEvents(
  ctx: RoutesContext,
  project: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  res.write(`: connected ${new Date().toISOString()}\n\n`)
  const client: SseSubscriber = { write: (payload) => { res.write(payload) } }
  let bucket = ctx.sseClients.get(project)
  if (!bucket) {
    bucket = new Set()
    ctx.sseClients.set(project, bucket)
  }
  bucket.add(client)
  req.on('close', () => {
    bucket?.delete(client)
    if (bucket && bucket.size === 0) ctx.sseClients.delete(project)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const text = await readText(req)
  if (!text) return {} as T
  return JSON.parse(text) as T
}

// ─── CLI device-login ─────────────────────────────────────────────────

async function handleCliLoginStart(
  ctx: RoutesContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJson<{ label?: string }>(req).catch(() => ({} as { label?: string }))
  // Cap the label length to keep token-label rendering predictable on
  // the dashboard. Default "cli-device" mirrors GitHub's "personal
  // access token" naming when the CLI didn't bother to set one.
  const rawLabel = (body.label ?? '').trim()
  const label = (rawLabel || 'cli-device').slice(0, 64)
  const session = await ctx.auth.users.createCliLoginSession(label)
  const origin = inferOrigin(req)
  const verifyUrl = `${origin}/cli-login?code=${encodeURIComponent(session.userCode)}`
  sendJson(res, 200, {
    deviceCode: session.deviceCode,
    userCode: session.userCode,
    verifyUrl,
    pollInterval: 2,
    expiresAt: session.expiresAt,
  })
}

async function handleCliLoginPoll(
  ctx: RoutesContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJson<{ deviceCode?: string }>(req).catch(() => ({} as { deviceCode?: string }))
  const deviceCode = (body.deviceCode ?? '').trim()
  if (!deviceCode) {
    sendJson(res, 400, { error: 'deviceCode is required' })
    return
  }
  const session = await ctx.auth.users.findCliLoginSessionByDeviceCode(deviceCode)
  if (!session || session.consumedAt) {
    // Unknown OR already minted — same response so a replayed deviceCode
    // can't be distinguished from a typo'd one.
    sendJson(res, 404, { error: 'unknown deviceCode' })
    return
  }
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    sendJson(res, 410, { error: 'expired' })
    return
  }
  if (session.status === 'pending') {
    // 202 Accepted communicates "we heard you, keep polling" without
    // looking like a success to dumb clients that only check `res.ok`.
    sendJson(res, 202, { status: 'pending' })
    return
  }
  if (session.status === 'denied') {
    sendJson(res, 410, { error: 'denied' })
    return
  }
  // status === 'authorized' — atomically consume the session and mint
  // the token. consumeCliLoginSession returns null if anyone else won
  // the race (or the session expired between our check and the mutate),
  // in which case we report 404 just like a replay attempt.
  const consumed = await ctx.auth.users.consumeCliLoginSession(deviceCode)
  if (!consumed) {
    sendJson(res, 404, { error: 'unknown deviceCode' })
    return
  }
  const { user } = consumed
  const { plainToken } = await ctx.auth.users.createToken(user.id, session.label)
  sendJson(res, 200, {
    status: 'authorized',
    token: plainToken,
    user: { email: user.email, name: user.name },
  })
}

/** Best-effort origin string for the verifyUrl returned to the CLI.
 *  Honors x-forwarded-* headers because the host is typically run
 *  behind a reverse proxy / TLS terminator. Falls back to the Host
 *  header + http when no forwarded info is present. */
function inferOrigin(req: IncomingMessage): string {
  const proto = headerVal(req, 'x-forwarded-proto') ?? 'http'
  const host = headerVal(req, 'x-forwarded-host') ?? headerVal(req, 'host') ?? 'localhost'
  return `${proto}://${host}`
}

function headerVal(req: IncomingMessage, name: string): string | undefined {
  const h = req.headers[name]
  if (!h) return undefined
  return Array.isArray(h) ? h[0] : h
}
