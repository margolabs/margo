// Web UI routes for the host. Handles signup, login, logout, the
// dashboard HTML, and the session-authenticated /api/me/* endpoints
// that the dashboard uses to mint and revoke bearer tokens.
//
// Auth model on this surface: cookie session, not bearer. The CLI/
// plugin/RemoteTransport path under /api/projects/:project/* is the
// other auth lane and stays unchanged.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { issueSessionCookie, clearSessionCookie, readSession, setCookieHeader } from './session.js'
import { renderDashboard, renderLogin, renderSignup, type DashboardData } from './web-ui.js'
import type { UserRecord, UserStore } from './user-store.js'

export interface WebContext {
  users: UserStore
  /** Resolved per request — null on first call, lazily populated when
   *  any web route needs to sign or verify a cookie. */
  sessionSecret: () => Promise<string>
}

export async function handleWebRoute(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? ''
  const path = url.split('?', 1)[0]

  if (path === '/' && req.method === 'GET') {
    return redirectBasedOnSession(ctx, req, res)
  }
  if (path === '/login' && req.method === 'GET') {
    return sendHtml(res, 200, renderLogin())
  }
  if (path === '/signup' && req.method === 'GET') {
    return sendHtml(res, 200, renderSignup())
  }
  if (path === '/dashboard' && req.method === 'GET') {
    return handleDashboard(ctx, req, res)
  }
  if (path === '/api/auth/signup' && req.method === 'POST') {
    return handleSignup(ctx, req, res)
  }
  if (path === '/api/auth/login' && req.method === 'POST') {
    return handleLogin(ctx, req, res)
  }
  if (path === '/api/auth/logout' && req.method === 'POST') {
    return handleLogout(res)
  }
  if (path === '/api/me' && req.method === 'GET') {
    return handleMe(ctx, req, res)
  }
  if (path === '/api/me/tokens' && req.method === 'GET') {
    return handleListTokens(ctx, req, res)
  }
  if (path === '/api/me/tokens' && req.method === 'POST') {
    return handleCreateToken(ctx, req, res)
  }
  const revokeMatch = /^\/api\/me\/tokens\/([a-zA-Z0-9._-]+)$/.exec(path)
  if (revokeMatch && req.method === 'DELETE') {
    return handleRevokeToken(ctx, req, res, revokeMatch[1])
  }
  return false
}

// ─── HTML pages ───────────────────────────────────────────────────────

async function redirectBasedOnSession(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const user = await currentUser(ctx, req)
  res.writeHead(302, { location: user ? '/dashboard' : '/login' }).end()
  return true
}

async function handleDashboard(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const user = await currentUser(ctx, req)
  if (!user) {
    res.writeHead(302, { location: '/login' }).end()
    return true
  }
  // Build the dashboard view: user's memberships + their active tokens.
  const projects: { slug: string; name: string; role: string }[] = []
  for (const p of await ctx.users.listProjects()) {
    const m = await ctx.users.getMembership(user.id, p.slug)
    if (m) projects.push({ slug: p.slug, name: p.name, role: m.role })
  }
  const tokens = (await ctx.users.listTokens())
    .filter((t) => t.userId === user.id)
    .map((t) => ({
      id: t.id,
      label: t.label,
      createdAt: t.createdAt,
      lastUsedAt: t.lastUsedAt,
      plainPrefix: t.plainPrefix,
    }))

  const data: DashboardData = {
    user: { id: user.id, email: user.email, name: user.name, isSuperuser: user.isSuperuser },
    projects,
    tokens,
  }
  return sendHtml(res, 200, renderDashboard(data))
}

// ─── Auth JSON endpoints ──────────────────────────────────────────────

async function handleSignup(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const body = await readJson<{ email?: string; name?: string; password?: string }>(req)
  const email = (body.email ?? '').trim()
  const name = (body.name ?? '').trim()
  const password = body.password ?? ''
  const err = validateSignup(email, name, password)
  if (err) return sendJson(res, 400, { error: err })
  const user = await ctx.users.signup(email, name, password)
  if (!user) return sendJson(res, 409, { error: 'email already registered' })
  const secret = await ctx.sessionSecret()
  setCookieHeader(res, issueSessionCookie(user.id, secret))
  return sendJson(res, 201, { id: user.id, email: user.email, name: user.name })
}

async function handleLogin(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const body = await readJson<{ email?: string; password?: string }>(req)
  const email = (body.email ?? '').trim()
  const password = body.password ?? ''
  if (!email || !password) {
    return sendJson(res, 400, { error: 'email and password are required' })
  }
  const user = await ctx.users.verifyLogin(email, password)
  if (!user) return sendJson(res, 401, { error: 'invalid email or password' })
  const secret = await ctx.sessionSecret()
  setCookieHeader(res, issueSessionCookie(user.id, secret))
  return sendJson(res, 200, { id: user.id, email: user.email, name: user.name })
}

function handleLogout(res: ServerResponse): boolean {
  setCookieHeader(res, clearSessionCookie())
  return sendJson(res, 200, { ok: true })
}

async function handleMe(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const user = await currentUser(ctx, req)
  if (!user) return sendJson(res, 401, { error: 'not logged in' })
  return sendJson(res, 200, {
    id: user.id,
    email: user.email,
    name: user.name,
    isSuperuser: !!user.isSuperuser,
  })
}

// ─── Token management (session-authenticated) ─────────────────────────

async function handleListTokens(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const user = await currentUser(ctx, req)
  if (!user) return sendJson(res, 401, { error: 'not logged in' })
  const tokens = (await ctx.users.listTokens())
    .filter((t) => t.userId === user.id)
    .map((t) => ({
      id: t.id,
      label: t.label,
      createdAt: t.createdAt,
      lastUsedAt: t.lastUsedAt,
      plainPrefix: t.plainPrefix,
    }))
  return sendJson(res, 200, { tokens })
}

async function handleCreateToken(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const user = await currentUser(ctx, req)
  if (!user) return sendJson(res, 401, { error: 'not logged in' })
  const body = await readJson<{ label?: string }>(req)
  const label = (body.label ?? 'token').trim() || 'token'
  const { record, plainToken } = await ctx.users.createToken(user.id, label)
  return sendJson(res, 201, {
    id: record.id,
    label: record.label,
    plainToken,
    createdAt: record.createdAt,
  })
}

async function handleRevokeToken(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
  tokenId: string,
): Promise<boolean> {
  const user = await currentUser(ctx, req)
  if (!user) return sendJson(res, 401, { error: 'not logged in' })
  // Only let users revoke their own tokens — anything else would let a
  // signed-in teammate yank an admin's token.
  const tokens = await ctx.users.listTokens()
  const target = tokens.find((t) => t.id === tokenId)
  if (!target || target.userId !== user.id) {
    return sendJson(res, 404, { error: 'not found' })
  }
  await ctx.users.revokeToken(tokenId)
  return sendJson(res, 200, { ok: true })
}

// ─── Helpers ──────────────────────────────────────────────────────────

async function currentUser(ctx: WebContext, req: IncomingMessage): Promise<UserRecord | null> {
  const secret = await ctx.sessionSecret()
  const session = readSession(req, secret)
  if (!session) return null
  return ctx.users.getUser(session.userId)
}

function validateSignup(email: string, name: string, password: string): string | null {
  if (!email) return 'email is required'
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'enter a valid email'
  if (!name) return 'name is required'
  if (name.length > 80) return 'name is too long'
  if (password.length < 8) return 'password must be at least 8 characters'
  if (password.length > 200) return 'password is too long'
  return null
}

function sendHtml(res: ServerResponse, status: number, html: string): boolean {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  }).end(html)
  return true
}

function sendJson(res: ServerResponse, status: number, body: unknown): boolean {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  return true
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {} as T
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
  } catch {
    return {} as T
  }
}
