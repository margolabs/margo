// Margo host — standalone server that stores comments for many projects.
// One process serves many teams; each project gets its own subdirectory
// + its own git history under `<dataRoot>/<project>/`. Authentication is
// per-user: a JSON file `<dataRoot>/users.json` holds the user roster
// and hashed bearer tokens.
//
// Admin bootstrap is "first-signup-wins" — the host starts cleanly with
// zero users; whoever creates the first account at `/signup` becomes a
// superuser. Matches the on-prem UX customers expect from self-hosted
// tools (GitLab CE, Sentry, Mattermost). The previous
// MARGO_HOST_TOKEN env-var bootstrap is no longer supported; a warning
// fires on boot when the var is still set so upgrading operators see
// why their old workflow is now a no-op.

import * as http from 'node:http'
import { dispatch, type RoutesContext, type SseSubscriber } from './routes.js'
import { ProjectStore } from './store.js'
import { UserStore } from './user-store.js'
import { handleWebRoute, type WebContext } from './web-routes.js'

export interface StartHostOptions {
  port: number
  dataRoot: string
  /** UserStore backing token resolution. Caller is responsible for
   *  having loaded it; startHost runs the auto-bootstrap path before
   *  binding the socket if the store is empty and MARGO_HOST_TOKEN is
   *  set. */
  users: UserStore
}

export interface HostHandle {
  port: number
  close(): Promise<void>
}

export async function startHost(opts: StartHostOptions): Promise<HostHandle> {
  const store = new ProjectStore({ dataRoot: opts.dataRoot })
  const sseClients = new Map<string, Set<SseSubscriber>>()

  await opts.users.load()
  if (process.env.MARGO_HOST_TOKEN) {
    // The env-bootstrap path was removed in favor of first-signup-wins.
    // Warn rather than fail so existing docker-compose files don't break
    // an upgrade — the env var is just ignored from here on.
    console.warn('[margo-host] MARGO_HOST_TOKEN is set but no longer used; admin is established by the first /signup. Safe to remove from your env/compose.')
  }
  const userCount = await opts.users.userCount()

  const ctx: RoutesContext = {
    store,
    auth: { users: opts.users },
    sseClients,
    broadcast(project, payload) {
      const data = `data: ${JSON.stringify(payload)}\n\n`
      const bucket = sseClients.get(project)
      if (!bucket) return
      for (const client of bucket) client.write(data)
    },
  }

  // Cached so we don't hit users.json on every request; the secret
  // doesn't change for the life of the process.
  let cachedSecret: string | null = null
  const webCtx: WebContext = {
    users: opts.users,
    sessionSecret: async () => {
      if (cachedSecret) return cachedSecret
      cachedSecret = await opts.users.getOrCreateSessionSecret()
      return cachedSecret
    },
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', req.headers.origin ?? '*')
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('access-control-allow-headers', 'content-type, authorization')
    res.setHeader('access-control-allow-credentials', 'true')
    res.setHeader('vary', 'origin')
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }
    if (req.url === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      return
    }
    // Web UI routes (cookie-authenticated) take priority for their
    // specific paths. dispatch() handles the bearer-authenticated API
    // under /api/projects/:project/*. The two surfaces never overlap.
    if (await handleWebRoute(webCtx, req, res)) return
    await dispatch(ctx, req, res)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, () => {
      server.off('error', reject)
      resolve()
    })
  })

  console.log(`[margo-host] listening on http://localhost:${opts.port}`)
  console.log(`[margo-host] data root: ${opts.dataRoot}`)
  if (userCount === 0) {
    console.log(`[margo-host] no admin yet — first signup at http://localhost:${opts.port}/signup becomes superuser.`)
    console.log(`[margo-host] DON'T share this URL until you've claimed admin.`)
  } else {
    const supers = (await opts.users.listUsers()).filter((u) => u.isSuperuser).length
    console.log(`[margo-host] ${userCount} user(s) registered (${supers} superuser${supers === 1 ? '' : 's'})`)
  }

  return {
    port: opts.port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

