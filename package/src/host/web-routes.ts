// Web UI routes for the host. Handles signup, login, logout, the
// dashboard HTML, and the session-authenticated /api/me/* endpoints
// that the dashboard uses to mint and revoke bearer tokens.
//
// Auth model on this surface: cookie session, not bearer. The CLI/
// plugin/RemoteTransport path under /api/projects/:project/* is the
// other auth lane and stays unchanged.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { issueSessionCookie, clearSessionCookie, readSession, setCookieHeader } from './session.js'
import { renderDashboard, renderLogin, renderProject, renderSignup, type DashboardData } from './web-ui.js'
import type { Role, UserRecord, UserStore } from './user-store.js'

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
  if (path === '/api/me/projects' && req.method === 'GET') {
    return handleListMyProjects(ctx, req, res)
  }
  if (path === '/api/me/projects' && req.method === 'POST') {
    return handleCreateProject(ctx, req, res)
  }
  // Project detail page (HTML).
  const projectViewMatch = /^\/projects\/([a-zA-Z0-9._-]+)$/.exec(path)
  if (projectViewMatch && req.method === 'GET') {
    return handleProjectPage(ctx, req, res, projectViewMatch[1])
  }
  // Project-scoped member management (session-authed). The bearer-auth
  // surface /api/projects/:project/comments lives in routes.ts; these
  // /api/projects/:project/members paths are session-authed and managed
  // here so the dashboard's member UI doesn't need to juggle two auth
  // models. Auth gate: project admin OR superuser.
  const membersListMatch = /^\/api\/projects\/([a-zA-Z0-9._-]+)\/members$/.exec(path)
  if (membersListMatch) {
    const slug = membersListMatch[1]
    if (req.method === 'GET') return handleListMembers(ctx, req, res, slug)
    if (req.method === 'POST') return handleInviteMember(ctx, req, res, slug)
  }
  const memberMatch = /^\/api\/projects\/([a-zA-Z0-9._-]+)\/members\/([a-zA-Z0-9._-]+)$/.exec(path)
  if (memberMatch) {
    const [, slug, memberUserId] = memberMatch
    if (req.method === 'DELETE') return handleRemoveMember(ctx, req, res, slug, memberUserId)
    if (req.method === 'PATCH') return handleChangeMemberRole(ctx, req, res, slug, memberUserId)
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

// ─── Projects (self-service, GitLab-style) ────────────────────────────

async function handleListMyProjects(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const user = await currentUser(ctx, req)
  if (!user) return sendJson(res, 401, { error: 'not logged in' })
  const memberships = await ctx.users.listMembershipsForUser(user.id)
  return sendJson(res, 200, {
    projects: memberships.map(({ project, role }) => ({
      slug: project.slug,
      name: project.name,
      createdAt: project.createdAt,
      role,
    })),
  })
}

async function handleCreateProject(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const user = await currentUser(ctx, req)
  if (!user) return sendJson(res, 401, { error: 'not logged in' })
  const body = await readJson<{ slug?: string; name?: string }>(req)
  const slug = (body.slug ?? '').trim()
  const name = (body.name ?? '').trim()
  if (!slug || !name) return sendJson(res, 400, { error: 'slug and name are required' })
  if (slug.length > 64 || name.length > 80) return sendJson(res, 400, { error: 'slug or name too long' })
  try {
    const project = await ctx.users.createProjectAsAdmin(user.id, slug, name)
    return sendJson(res, 201, { slug: project.slug, name: project.name, role: 'admin' })
  } catch (err) {
    const m = (err as Error).message
    if (m === 'duplicate_slug') return sendJson(res, 409, { error: 'a project with that slug already exists' })
    if (m === 'invalid_slug') return sendJson(res, 400, { error: 'slug must contain only letters, digits, ., _, -' })
    return sendJson(res, 500, { error: m || 'create failed' })
  }
}

// ─── Project members (project-admin only) ─────────────────────────────

async function handleListMembers(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
  slug: string,
): Promise<boolean> {
  const user = await currentUser(ctx, req)
  if (!user) return sendJson(res, 401, { error: 'not logged in' })
  if (!(await canManageProject(ctx, user, slug))) {
    return sendJson(res, 403, { error: 'project admin only' })
  }
  const members = await ctx.users.listMembers(slug)
  // Hydrate with user records so the UI can render names/emails.
  const out: Array<{ userId: string; email: string; name: string; role: string }> = []
  for (const m of members) {
    const u = await ctx.users.getUser(m.userId)
    if (u) out.push({ userId: u.id, email: u.email, name: u.name, role: m.role })
  }
  return sendJson(res, 200, { members: out })
}

async function handleInviteMember(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
  slug: string,
): Promise<boolean> {
  const user = await currentUser(ctx, req)
  if (!user) return sendJson(res, 401, { error: 'not logged in' })
  if (!(await canManageProject(ctx, user, slug))) {
    return sendJson(res, 403, { error: 'project admin only' })
  }
  const body = await readJson<{ email?: string; role?: string }>(req)
  const email = (body.email ?? '').trim()
  const role = (body.role ?? '') as Role
  if (!email) return sendJson(res, 400, { error: 'email is required' })
  if (role !== 'read' && role !== 'write' && role !== 'admin') {
    return sendJson(res, 400, { error: 'role must be read, write, or admin' })
  }
  const target = await ctx.users.findUserByEmail(email)
  if (!target) {
    return sendJson(res, 404, {
      error: `no account with email ${email}. They need to sign up first; share the host URL with them.`,
    })
  }
  await ctx.users.addMember(target.id, slug, role)
  return sendJson(res, 200, {
    userId: target.id,
    email: target.email,
    name: target.name,
    role,
  })
}

async function handleRemoveMember(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
  slug: string,
  memberUserId: string,
): Promise<boolean> {
  const user = await currentUser(ctx, req)
  if (!user) return sendJson(res, 401, { error: 'not logged in' })
  if (!(await canManageProject(ctx, user, slug))) {
    return sendJson(res, 403, { error: 'project admin only' })
  }
  // Prevent removing the last admin — would orphan the project.
  const members = await ctx.users.listMembers(slug)
  const admins = members.filter((m) => m.role === 'admin')
  const targetIsAdmin = admins.some((m) => m.userId === memberUserId)
  if (targetIsAdmin && admins.length === 1) {
    return sendJson(res, 409, { error: 'cannot remove the last admin — promote someone else first' })
  }
  await ctx.users.removeMember(memberUserId, slug)
  return sendJson(res, 200, { ok: true })
}

async function handleChangeMemberRole(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
  slug: string,
  memberUserId: string,
): Promise<boolean> {
  const user = await currentUser(ctx, req)
  if (!user) return sendJson(res, 401, { error: 'not logged in' })
  if (!(await canManageProject(ctx, user, slug))) {
    return sendJson(res, 403, { error: 'project admin only' })
  }
  const body = await readJson<{ role?: string }>(req)
  const role = (body.role ?? '') as Role
  if (role !== 'read' && role !== 'write' && role !== 'admin') {
    return sendJson(res, 400, { error: 'role must be read, write, or admin' })
  }
  // Demoting the only admin would orphan the project.
  if (role !== 'admin') {
    const members = await ctx.users.listMembers(slug)
    const admins = members.filter((m) => m.role === 'admin')
    const targetIsAdmin = admins.some((m) => m.userId === memberUserId)
    if (targetIsAdmin && admins.length === 1) {
      return sendJson(res, 409, { error: 'cannot demote the last admin — promote someone else first' })
    }
  }
  await ctx.users.addMember(memberUserId, slug, role) // idempotent role update
  return sendJson(res, 200, { ok: true, role })
}

// ─── Project HTML page ────────────────────────────────────────────────

async function handleProjectPage(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
  slug: string,
): Promise<boolean> {
  const user = await currentUser(ctx, req)
  if (!user) {
    res.writeHead(302, { location: '/login' }).end()
    return true
  }
  const project = await ctx.users.getProject(slug)
  if (!project) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      .end('<p style="font-family:sans-serif; padding:40px">No such project. <a href="/dashboard">Back to dashboard</a>.</p>')
    return true
  }
  const myMembership = await ctx.users.getMembership(user.id, slug)
  if (!myMembership && !user.isSuperuser) {
    res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
      .end('<p style="font-family:sans-serif; padding:40px">You are not a member of this project. Ask a project admin to add you.</p>')
    return true
  }
  const canManage = !!user.isSuperuser || (myMembership?.role === 'admin')
  const members = await ctx.users.listMembers(slug)
  const hydrated: Array<{ userId: string; email: string; name: string; role: string }> = []
  for (const m of members) {
    const u = await ctx.users.getUser(m.userId)
    if (u) hydrated.push({ userId: u.id, email: u.email, name: u.name, role: m.role })
  }
  return sendHtml(res, 200, renderProject({
    user: { id: user.id, email: user.email, name: user.name, isSuperuser: !!user.isSuperuser },
    project: { slug: project.slug, name: project.name, createdAt: project.createdAt },
    myRole: myMembership?.role ?? 'read',
    canManage,
    members: hydrated,
  }))
}

async function canManageProject(ctx: WebContext, user: UserRecord, slug: string): Promise<boolean> {
  if (user.isSuperuser) return true
  const m = await ctx.users.getMembership(user.id, slug)
  return m?.role === 'admin'
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
