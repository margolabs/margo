// Margo host — standalone server that stores comments for many projects.
// One process serves many teams; each project gets its own subdirectory
// + its own git history under `<dataRoot>/<project>/`. Clients reach the
// host via HTTP from inside their dev plugin (RemoteTransport, planned)
// or directly with curl for ops.
//
// Phase 2 scope: single-user, one shared bearer token, no SQLite. The URL
// shape (`/api/projects/:project/...`) is forward-compatible — adding
// per-user identities + project rosters later means swapping the auth
// layer, not the routes.

import * as http from 'node:http'
import { dispatch, type RoutesContext, type SseSubscriber } from './routes.js'
import { ProjectStore } from './store.js'
import type { AuthConfig } from './auth.js'

export interface StartHostOptions {
  port: number
  dataRoot: string
  auth: AuthConfig
}

export interface HostHandle {
  port: number
  close(): Promise<void>
}

export async function startHost(opts: StartHostOptions): Promise<HostHandle> {
  const store = new ProjectStore({ dataRoot: opts.dataRoot })
  const sseClients = new Map<string, Set<SseSubscriber>>()

  const ctx: RoutesContext = {
    store,
    auth: opts.auth,
    sseClients,
    broadcast(project, payload) {
      const data = `data: ${JSON.stringify(payload)}\n\n`
      const bucket = sseClients.get(project)
      if (!bucket) return
      for (const client of bucket) client.write(data)
    },
  }

  const server = http.createServer(async (req, res) => {
    // CORS — clients (overlay, RemoteTransport) may sit on a different
    // origin than the host (different port, different domain). Reflect
    // the request's origin rather than wildcarding so credentials work
    // for cookie-based auth schemes we might add later.
    res.setHeader('access-control-allow-origin', req.headers.origin ?? '*')
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('access-control-allow-headers', 'content-type, authorization')
    res.setHeader('access-control-allow-credentials', 'true')
    res.setHeader('vary', 'origin')
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }
    // Health probe — unauthenticated so monitoring can hit it without a
    // token. Returns 200 even when no projects exist.
    if (req.url === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      return
    }
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
  console.log(`[margo-host] identity:  ${opts.auth.identity.name} <${opts.auth.identity.email}>`)

  return {
    port: opts.port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
