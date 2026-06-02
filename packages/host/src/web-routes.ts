// Web UI routes for the host. Handles signup, login, logout, the
// dashboard HTML, and the session-authenticated /api/me/* endpoints
// that the dashboard uses to mint and revoke bearer tokens.
//
// Auth model on this surface: cookie session, not bearer. The CLI/
// plugin/RemoteTransport path under /api/projects/:project/* is the
// other auth lane and stays unchanged.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { appendReply, serializeComment } from './shared/frontmatter.js'
import type { CommentStatus } from './shared/types.js'
import { issueSessionCookie, clearSessionCookie, readSession, setCookieHeader } from './session.js'
import {
  renderCliLogin,
  renderDashboard,
  renderLogin,
  renderProject,
  renderProjectComments,
  renderProjectCommentDetail,
  renderSetup,
  renderSignup,
  type CliLoginPageData,
  type DashboardData,
} from './web-ui.js'
import type { ProjectStore } from './store.js'
import type { Role, UserRecord, UserStore } from './user-store.js'

export interface WebContext {
  users: UserStore
  /** Comment storage — used by the portal's comments-management routes
   *  to read, mutate status, append replies, and delete. The bearer-auth
   *  /api/projects/:project/comments path (used by the dev plugin) also
   *  hits this store, just through the routes.ts dispatcher. */
  store: ProjectStore
  /** SSE broadcast helper — shared with the bearer-auth lane so portal-
   *  side mutations fan out to every connected overlay just like API
   *  writes do. Without this, a portal user changing a comment's status
   *  would only be visible after the next dev-server boot. */
  broadcast: (project: string, payload: unknown) => void
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
  if (path === '/setup' && req.method === 'GET') {
    // First-run welcome page. Disappears once any user exists — visitors
    // landing here after the admin is claimed get redirected to /login.
    if ((await ctx.users.userCount()) > 0) {
      res.writeHead(302, { location: '/login' }).end()
      return true
    }
    return sendHtml(res, 200, renderSetup())
  }
  if (path === '/login' && req.method === 'GET') {
    // No admin yet → bounce to /setup. Avoids a confusing "log in with
    // what?" dead-end on a fresh host.
    if ((await ctx.users.userCount()) === 0) {
      res.writeHead(302, { location: '/setup' }).end()
      return true
    }
    return sendHtml(res, 200, renderLogin())
  }
  if (path === '/signup' && req.method === 'GET') {
    if ((await ctx.users.userCount()) === 0) {
      res.writeHead(302, { location: '/setup' }).end()
      return true
    }
    return sendHtml(res, 200, renderSignup())
  }
  if (path === '/api/auth/setup-admin' && req.method === 'POST') {
    return handleSetupAdmin(ctx, req, res)
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
  if (path === '/cli-login' && req.method === 'GET') {
    return handleCliLoginPage(ctx, req, res)
  }
  if (path === '/api/auth/cli-login/authorize' && req.method === 'POST') {
    return handleCliLoginAuthorize(ctx, req, res)
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

  // ─── Comments portal ──────────────────────────────────────────────
  // Session-authed surface for browsing + managing comments. Bearer-auth
  // dev-plugin path under /api/projects/:slug/comments lives in routes.ts
  // and is unchanged.
  const commentsListPageMatch = /^\/projects\/([a-zA-Z0-9._-]+)\/comments$/.exec(path)
  if (commentsListPageMatch && req.method === 'GET') {
    return handleProjectCommentsPage(ctx, req, res, commentsListPageMatch[1], url)
  }
  const commentDetailPageMatch = /^\/projects\/([a-zA-Z0-9._-]+)\/comments\/([a-zA-Z0-9._-]+)$/.exec(path)
  if (commentDetailPageMatch && req.method === 'GET') {
    return handleProjectCommentDetailPage(ctx, req, res, commentDetailPageMatch[1], commentDetailPageMatch[2])
  }
  const statusActionMatch = /^\/api\/projects\/([a-zA-Z0-9._-]+)\/comments\/([a-zA-Z0-9._-]+)\/status$/.exec(path)
  if (statusActionMatch && req.method === 'POST') {
    return handleCommentStatusUpdate(ctx, req, res, statusActionMatch[1], statusActionMatch[2])
  }
  const replyActionMatch = /^\/api\/projects\/([a-zA-Z0-9._-]+)\/comments\/([a-zA-Z0-9._-]+)\/reply$/.exec(path)
  if (replyActionMatch && req.method === 'POST') {
    return handleCommentReply(ctx, req, res, replyActionMatch[1], replyActionMatch[2])
  }
  const deleteActionMatch = /^\/api\/portal\/projects\/([a-zA-Z0-9._-]+)\/comments\/([a-zA-Z0-9._-]+)$/.exec(path)
  if (deleteActionMatch && req.method === 'DELETE') {
    return handleCommentDelete(ctx, req, res, deleteActionMatch[1], deleteActionMatch[2])
  }
  // Also accept DELETE on the public path when a session cookie is
  // present — easier on the JS in the detail page (no path branching).
  // The bearer-auth lane in routes.ts only triggers when there's no
  // session cookie, so this doesn't collide.
  const directDeleteMatch = /^\/api\/projects\/([a-zA-Z0-9._-]+)\/comments\/([a-zA-Z0-9._-]+)$/.exec(path)
  if (directDeleteMatch && req.method === 'DELETE') {
    // Probe for a session cookie before claiming this route — if there
    // isn't one, fall through to the bearer-auth lane in routes.ts.
    const session = await readSession(req, await ctx.sessionSecret())
    if (session) {
      return handleCommentDelete(ctx, req, res, directDeleteMatch[1], directDeleteMatch[2])
    }
  }

  return false
}

// ─── HTML pages ───────────────────────────────────────────────────────

async function redirectBasedOnSession(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  // Fresh-host case first: no admin → /setup. Beats sending the operator
  // through a login page they have no credentials for.
  if ((await ctx.users.userCount()) === 0) {
    res.writeHead(302, { location: '/setup' }).end()
    return true
  }
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
  // Block regular signup on a fresh host — the operator must claim
  // admin via /setup first. Returns 412 so the front-end could redirect
  // to /setup if a stale page somehow bypasses the GET-time redirect.
  if ((await ctx.users.userCount()) === 0) {
    return sendJson(res, 412, { error: 'no admin yet — visit /setup to claim the host first' })
  }
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

async function handleSetupAdmin(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  // Belt-and-suspenders: even though /setup GET refuses to render after
  // any user exists, a client could POST directly. Refuse here too.
  if ((await ctx.users.userCount()) > 0) {
    return sendJson(res, 409, { error: 'this host is already initialized; use /login' })
  }
  const body = await readJson<{ email?: string; name?: string; password?: string }>(req)
  const email = (body.email ?? '').trim()
  const name = (body.name ?? '').trim()
  const password = body.password ?? ''
  const err = validateSignup(email, name, password)
  if (err) return sendJson(res, 400, { error: err })
  const result = await ctx.users.setupAdmin(email, name, password)
  if (result === 'already_initialized') {
    // Race: someone else claimed admin between our pre-check and the
    // mutate. Tell the client to log in instead.
    return sendJson(res, 409, { error: 'this host was just initialized; use /login' })
  }
  const secret = await ctx.sessionSecret()
  setCookieHeader(res, issueSessionCookie(result.id, secret))
  return sendJson(res, 201, { id: result.id, email: result.email, name: result.name, isSuperuser: true })
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

// ─── Comments portal ──────────────────────────────────────────────────

const VALID_STATUSES: readonly CommentStatus[] = [
  'open', 'in-progress', 'ready-for-review', 'blocked', 'resolved', 'wontfix',
] as const

async function ensurePortalAccess(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
  slug: string,
  required: 'read' | 'write' | 'admin',
): Promise<{ user: UserRecord; myRole: string; canWrite: boolean; canDelete: boolean } | null> {
  const user = await currentUser(ctx, req)
  if (!user) {
    sendJson(res, 401, { error: 'not logged in' })
    return null
  }
  const project = await ctx.users.getProject(slug)
  if (!project) {
    sendJson(res, 404, { error: 'project not found' })
    return null
  }
  const membership = await ctx.users.getMembership(user.id, slug)
  const role = membership?.role ?? (user.isSuperuser ? 'admin' : null)
  if (!role) {
    sendJson(res, 403, { error: 'not a member of this project' })
    return null
  }
  // Role hierarchy: admin > write > read. Superuser bypasses.
  const rank: Record<string, number> = { read: 1, write: 2, admin: 3 }
  if (rank[role] < rank[required]) {
    sendJson(res, 403, { error: `requires ${required} role on this project` })
    return null
  }
  return {
    user,
    myRole: role,
    canWrite: rank[role] >= rank.write,
    canDelete: rank[role] >= rank.admin,
  }
}

async function handleProjectCommentsPage(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
  slug: string,
  url: string,
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
  const myRole = myMembership?.role ?? (user.isSuperuser ? 'admin' : 'read')
  const canWrite = myRole === 'write' || myRole === 'admin'
  const canDelete = myRole === 'admin'

  // Parse query for filters. Defaults: status=open, type=all, q=empty.
  // The list page re-renders on every filter change as a GET — no JS,
  // matches the rest of the portal's progressive-enhancement pattern.
  const statusFilter = parseQueryParam(url, 'status') ?? 'open'
  const typeFilter = parseQueryParam(url, 'type') ?? 'all'
  const q = (parseQueryParam(url, 'q') ?? '').toLowerCase()

  // Load every comment up front — projects in the wild have at most a
  // few hundred. Pagination is a problem we'll solve when it shows up.
  const all = await ctx.store.list(slug)
  const counts: Record<string, number> = {}
  for (const c of all) {
    const s = c.frontmatter.status
    counts[s] = (counts[s] ?? 0) + 1
  }

  const filtered = all.filter((c) => {
    const fm = c.frontmatter
    if (statusFilter !== 'all' && fm.status !== statusFilter) return false
    if (typeFilter !== 'all' && fm.type !== typeFilter) return false
    if (q) {
      const hay = `${c.body} ${fm.id} ${fm.author} ${fm.authorName ?? ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  // Newest first by creation timestamp — matches what the overlay's
  // inbox does by default.
  filtered.sort((a, b) => (b.frontmatter.created ?? '').localeCompare(a.frontmatter.created ?? ''))

  return sendHtml(res, 200, renderProjectComments({
    user: { id: user.id, email: user.email, name: user.name, isSuperuser: !!user.isSuperuser },
    project: { slug: project.slug, name: project.name },
    myRole,
    canWrite,
    canDelete,
    counts,
    filter: { status: statusFilter, type: typeFilter, q: parseQueryParam(url, 'q') ?? '' },
    comments: filtered.map((c) => {
      const fm = c.frontmatter
      // Strip reply blocks (lines after the first `---` divider) so the
      // excerpt shows the original comment, not the last reply.
      const original = stripReplyTail(c.body)
      const excerpt = original.replace(/\s+/g, ' ').trim().slice(0, 240)
      const targetUrl = (fm.target as { url?: string; pageUrl?: string })?.url
        ?? (fm.target as { pageUrl?: string })?.pageUrl
      return {
        id: fm.id,
        type: fm.type,
        status: fm.status,
        author: fm.author,
        authorName: fm.authorName,
        created: fm.created,
        bodyExcerpt: excerpt || '(empty)',
        targetUrl,
      }
    }),
  }))
}

async function handleProjectCommentDetailPage(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
  slug: string,
  id: string,
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
      .end('<p style="font-family:sans-serif; padding:40px">You are not a member of this project.</p>')
    return true
  }
  const myRole = myMembership?.role ?? (user.isSuperuser ? 'admin' : 'read')
  const canWrite = myRole === 'write' || myRole === 'admin'
  const canDelete = myRole === 'admin'

  const found = await ctx.store.read(slug, id)
  if (!found) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      .end(`<p style="font-family:sans-serif; padding:40px">No comment with id <code>${id}</code>. <a href="/projects/${slug}/comments">Back to comments</a>.</p>`)
    return true
  }
  const { comment } = found
  const fm = comment.frontmatter
  const { original, replies } = splitBodyAndReplies(comment.body)

  return sendHtml(res, 200, renderProjectCommentDetail({
    user: { id: user.id, email: user.email, name: user.name, isSuperuser: !!user.isSuperuser },
    project: { slug: project.slug, name: project.name },
    myRole,
    canWrite,
    canDelete,
    comment: {
      id: fm.id,
      type: fm.type,
      status: fm.status,
      author: fm.author,
      authorName: fm.authorName,
      branch: fm.branch,
      created: fm.created,
      body: original,
      target: {
        url: (fm.target as { url?: string; pageUrl?: string })?.url ?? (fm.target as { pageUrl?: string })?.pageUrl,
        selector: (fm.target as { selector?: string })?.selector,
        kind: (fm.target as { kind?: string })?.kind,
      },
      replies,
      raw: comment.raw,
    },
  }))
}

async function handleCommentStatusUpdate(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
  slug: string,
  id: string,
): Promise<boolean> {
  const access = await ensurePortalAccess(ctx, req, res, slug, 'write')
  if (!access) return true
  const body = await readJson<{ status?: string }>(req)
  const status = body.status as CommentStatus
  if (!VALID_STATUSES.includes(status)) {
    return sendJson(res, 400, { error: 'status must be one of: ' + VALID_STATUSES.join(', ') })
  }
  const found = await ctx.store.read(slug, id)
  if (!found) return sendJson(res, 404, { error: 'comment not found' })
  const next = serializeComment({ ...found.comment.frontmatter, status }, found.comment.body)
  await ctx.store.write(slug, id, next, {
    commitMessage: `status ${status} on ${id}`,
    authorEmail: access.user.email,
    authorName: access.user.name,
  })
  ctx.broadcast(slug, { type: 'updated', id })
  return sendJson(res, 200, { ok: true, status })
}

async function handleCommentReply(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
  slug: string,
  id: string,
): Promise<boolean> {
  const access = await ensurePortalAccess(ctx, req, res, slug, 'write')
  if (!access) return true
  const body = await readJson<{ body?: string }>(req)
  const text = (body.body ?? '').trim()
  if (!text) return sendJson(res, 400, { error: 'reply body is required' })
  const found = await ctx.store.read(slug, id)
  if (!found) return sendJson(res, 404, { error: 'comment not found' })
  const appended = appendReply(found.comment.body, {
    author: access.user.email,
    timestamp: new Date().toISOString(),
    body: text,
  })
  const next = serializeComment(found.comment.frontmatter, appended)
  await ctx.store.write(slug, id, next, {
    commitMessage: `reply on ${id} by ${access.user.email}`,
    authorEmail: access.user.email,
    authorName: access.user.name,
  })
  ctx.broadcast(slug, { type: 'updated', id })
  return sendJson(res, 200, { ok: true })
}

async function handleCommentDelete(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
  slug: string,
  id: string,
): Promise<boolean> {
  const access = await ensurePortalAccess(ctx, req, res, slug, 'admin')
  if (!access) return true
  const found = await ctx.store.read(slug, id)
  if (!found) return sendJson(res, 404, { error: 'comment not found' })
  await ctx.store.remove(slug, id, {
    commitMessage: `delete ${id} via portal by ${access.user.email}`,
    authorEmail: access.user.email,
    authorName: access.user.name,
  })
  ctx.broadcast(slug, { type: 'deleted', id })
  return sendJson(res, 200, { ok: true })
}

/** Drop everything from the first `---` divider on. Replies are
 *  appended with `\n---\n**reply**…` blocks; the original body sits
 *  above. Returns the whole body unchanged if no divider exists. */
function stripReplyTail(body: string): string {
  const m = /\n---\n/.exec(body)
  return m ? body.slice(0, m.index) : body
}

/** Parse a comment body into the original content + structured reply
 *  array. Reply format authored by `appendReply` (shared/frontmatter):
 *
 *    \n---\n**reply** — <author>[ (<role>)] — <ts>\n\n<body>\n
 *    \n---\n**ai-reply** — <model> — <ts>\n\n<body>\n
 *
 *  Anything not matching one of those header lines is treated as part
 *  of the previous reply's body. */
function splitBodyAndReplies(body: string): {
  original: string
  replies: Array<{
    author: string
    role?: string
    timestamp: string
    body: string
    isAi?: boolean
    aiModel?: string
  }>
} {
  const parts = body.split(/\n---\n/)
  const original = parts.shift()?.trimEnd() ?? ''
  const replies: ReturnType<typeof splitBodyAndReplies>['replies'] = []
  for (const part of parts) {
    const aiMatch = /^\*\*ai-reply\*\* — ([^—\n]+) — ([^\n]+)\n+([\s\S]*?)$/.exec(part)
    if (aiMatch) {
      replies.push({
        author: 'ai',
        timestamp: aiMatch[2].trim(),
        body: aiMatch[3].trim(),
        isAi: true,
        aiModel: aiMatch[1].trim(),
      })
      continue
    }
    const humanMatch = /^\*\*reply\*\* — ([^(\n—]+?)(?:\s*\(([^)]+)\))?\s* — ([^\n]+)\n+([\s\S]*?)$/.exec(part)
    if (humanMatch) {
      replies.push({
        author: humanMatch[1].trim(),
        role: humanMatch[2]?.trim() ?? undefined,
        timestamp: humanMatch[3].trim(),
        body: humanMatch[4].trim(),
      })
      continue
    }
    // Unrecognized divider block — treat as a raw extension of the
    // previous reply if any, else attach to the original.
    if (replies.length > 0) {
      replies[replies.length - 1].body += `\n---\n${part}`
    }
  }
  return { original, replies }
}

// ─── CLI device-login (session-authed confirmation page) ─────────────

async function handleCliLoginPage(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const user = await currentUser(ctx, req)
  if (!user) {
    // The CLI flow asks the user to open this URL; if they're not
    // logged in yet, route to /login. We deliberately don't carry a
    // `next` param — after login they land on the dashboard and just
    // re-open the URL the CLI printed. Simpler than threading state
    // through every web route.
    res.writeHead(302, { location: '/login' }).end()
    return true
  }
  const rawCode = parseQueryParam(req.url ?? '', 'code')
  if (!rawCode) {
    return sendHtml(res, 400, renderCliLogin({
      user: { email: user.email, name: user.name },
      errorMessage: 'No code in the URL. Re-open the link from your terminal.',
    }))
  }
  const session = await ctx.users.findCliLoginSessionByUserCode(rawCode)
  const errorMessage = describeCliSessionUnavailability(session)
  if (errorMessage || !session) {
    return sendHtml(res, 200, renderCliLogin({
      user: { email: user.email, name: user.name },
      errorMessage: errorMessage ?? 'Unknown verification code.',
    }))
  }
  const data: CliLoginPageData = {
    user: { email: user.email, name: user.name },
    session: { userCode: session.userCode, label: session.label, expiresAt: session.expiresAt },
  }
  return sendHtml(res, 200, renderCliLogin(data))
}

async function handleCliLoginAuthorize(
  ctx: WebContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const user = await currentUser(ctx, req)
  if (!user) return sendJson(res, 401, { error: 'not logged in' })
  const body = await readJson<{ userCode?: string }>(req)
  const userCode = (body.userCode ?? '').trim()
  if (!userCode) return sendJson(res, 400, { error: 'invalid userCode' })
  const result = await ctx.users.authorizeCliLoginSession(userCode, user.id)
  if (!result) return sendJson(res, 404, { error: 'session not found or expired' })
  return sendJson(res, 200, { ok: true })
}

/** Return a user-facing message if the session can't be confirmed in
 *  its current state, or null if it's good to go. Centralized so the
 *  page and the API give consistent wording. */
function describeCliSessionUnavailability(
  session: { status: string; expiresAt: string; consumedAt?: string } | null,
): string | null {
  if (!session) return 'Unknown verification code. Re-check the code shown in your terminal.'
  if (session.consumedAt) return 'This device was already authorized. If your CLI still needs a token, start a new login.'
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    return 'This login request expired. Run the CLI command again to get a fresh code.'
  }
  if (session.status === 'authorized') {
    return 'This device is already authorized. Your CLI should complete in a moment.'
  }
  if (session.status === 'denied') return 'This login request was denied.'
  return null
}

function parseQueryParam(url: string, name: string): string | null {
  const qIdx = url.indexOf('?')
  if (qIdx === -1) return null
  const qs = url.slice(qIdx + 1)
  for (const pair of qs.split('&')) {
    const eq = pair.indexOf('=')
    const key = eq === -1 ? pair : pair.slice(0, eq)
    if (decodeURIComponent(key) !== name) continue
    const raw = eq === -1 ? '' : pair.slice(eq + 1)
    try {
      return decodeURIComponent(raw.replace(/\+/g, ' '))
    } catch {
      return raw
    }
  }
  return null
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
