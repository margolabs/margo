// Next.js (App Router) server-side entry for margo. Provides the Route
// Handler that serves the /__margo/* surface — chokidar watcher, git poller,
// SSE stream, and overlay-bundle static asset.
//
// This file is intentionally React-free. The <MargoScript /> component lives
// at margo-dev/next-client-script — a separate subpath export — so that any
// future externalization rules on the server module never sweep React along
// with them. The original Next-integration bug was exactly that: an
// externalized server module pulled `react` from its own node_modules while
// Next SSR used next/dist/compiled/react, and the two React instances
// collided on every page render.
//
// Usage:
//
//   // app/margo-runtime/[[...path]]/route.ts (init CLI creates this)
//   import { handlers } from 'margo-dev/next-server';
//   export const { GET, POST, PATCH, DELETE } = handlers;
//   export const runtime = 'nodejs';
//   export const dynamic = 'force-dynamic';
//
// Production safety: behavior is gated by NODE_ENV. When NODE_ENV=production
// and MARGO_ENABLED is unset, dispatch() returns 404 immediately so
// chokidar/git/file watcher never run. We import runtime modules statically
// (not via dynamic import) — Turbopack misbehaves with dynamic imports inside
// route-evaluated modules, triggering restart loops on every request.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';
import {
  HandlerError,
  broadcastSse,
  createComment,
  deleteComment,
  getGitState,
  getMe,
  listComments,
  setMe,
  syncFromRemote,
  updateComment,
  type HandlerContext,
  type SseClient,
} from '../server/handlers.js';
import { mirrorTransportToDir } from '../storage/cache-mirror.js';
import { CacheWatcher } from '../storage/cache-watcher.js';
import { createTransport } from '../storage/factory.js';
import type { RemoteTransport } from '../storage/remote-transport.js';
import type { Transport } from '../storage/transport.js';
import type { CreateCommentRequest, MargoConfig, UpdateCommentRequest } from '../shared/types.js';

const PLUGIN_DIR = path.dirname(url.fileURLToPath(import.meta.url));
const OVERLAY_BUNDLE_PATH = path.join(PLUGIN_DIR, '..', 'overlay.bundle.js');
const OVERLAY_MAP_PATH = path.join(PLUGIN_DIR, '..', 'overlay.bundle.js.map');

const DEFAULTS: MargoConfig = {
  workspace: { name: 'unnamed', appUrl: { dev: 'http://localhost:3000', preview: null } },
  roster: [],
  git: {
    autoCommit: true,
    autoPush: true,
    commitPrefix: 'margo:',
    branchPolicy: 'current',
    pullBeforePush: true,
  },
  ai: { implicitTaskTrigger: true, proactiveInboxSummaryAtSessionStart: true },
};

// Module-level singleton — Next.js Route Handlers stay loaded for the
// lifetime of the dev server, so this initializes once on the first request
// and reuses the same transport + sseClients set across requests.
let cachedCtx: HandlerContext | null = null;
let cachedTransport: Transport | null = null;

async function ensureCtx(): Promise<HandlerContext> {
  if (cachedCtx) return cachedCtx;
  const rootDir = process.cwd();
  const config: MargoConfig = DEFAULTS;
  const sseClients = new Set<SseClient>();
  const created = await createTransport({ rootDir });
  // Next.js plugin doesn't opt into allowMissingAuth yet — createTransport
  // already threw with a clear "run `margo login`" message if no credential
  // is present. Narrow so TS knows transport is non-null below.
  // TODO: extend the same in-overlay device flow as the Vite plugin.
  if (!created.transport) throw new Error('[margo] unreachable: transport unexpectedly null');
  const transport = created.transport;
  const commentsDir = created.commentsDir;
  cachedTransport = transport;
  console.log(`[margo] storage mode: ${created.mode}${created.configPath ? ` (from ${created.configPath})` : ''}`);
  cachedCtx = {
    rootDir,
    transport,
    storageMode: created.mode,
    serverInfo: created.serverInfo,
    config,
    sseClients,
    // Replay the most recent remote-changes payload so a tab that loaded
    // after the poller's initial tick still sees the banner.
    onSseClientConnect: (client) => {
      const last = transport.getLastRemoteChanges();
      if (last) {
        client.write(`data: ${JSON.stringify({ type: 'remote-changes', ...last })}\n\n`);
      }
    },
    onAfterSync: () => transport.resetRemoteChanges(),
  };

  // Bridge transport events into the SSE stream. Subscribing once is fine —
  // the transport coalesces all listeners into a single underlying watcher/
  // poller pair, and we never unsubscribe in this code path (process exit
  // tears down the transport along with everything else).
  transport.subscribe((e) => broadcastSse(cachedCtx!, e));
  transport.subscribeRemoteChanges((payload) => {
    if (payload) broadcastSse(cachedCtx!, { type: 'remote-changes', ...payload });
  });
  // Server mode only: full bidirectional sync between cache + host.
  // See vite.ts for the longer rationale. Order matters here:
  //   1. Construct + start the CacheWatcher (chokidar begins observing)
  //   2. Boot pull with onWillWrite registering each file's hash on
  //      the watcher so chokidar's 'add' events get skipped by the
  //      echo-loop guard
  //   3. SSE subscriber that mirrors subsequent host updates into the
  //      cache, also registering expected hashes
  let cacheWatcher: CacheWatcher | null = null;
  if (created.mode === 'server') {
    const captured = transport;
    const watcher = new CacheWatcher({ commentsDir, transport: captured as RemoteTransport });
    cacheWatcher = watcher;
    watcher.start();
    void mirrorTransportToDir(captured, commentsDir, (id, raw) => watcher.registerExpectedWrite(id, raw))
      .then(({ pulled }) => console.log(`[margo] cached ${pulled} comment(s) from host for AI at ${commentsDir}`))
      .catch((err) => console.warn('[margo] initial pull failed (AI cache may be stale):', (err as Error).message));
    transport.subscribe(async (ev) => {
      try {
        const file = path.join(commentsDir, `${ev.id}.md`);
        if (ev.type === 'deleted') {
          watcher.registerExpectedDelete(ev.id);
          await fsp.unlink(file).catch(() => undefined);
          return;
        }
        const fresh = await captured.read(ev.id);
        if (!fresh) return; // raced with a delete
        watcher.registerExpectedWrite(ev.id, fresh.raw);
        await fsp.mkdir(commentsDir, { recursive: true });
        await fsp.writeFile(file, fresh.raw, 'utf8');
      } catch (err) {
        console.warn(`[margo] failed to mirror ${ev.id} to cache:`, (err as Error).message);
      }
    });
  }
  // Process exit cleans up the transport; Next.js dev server doesn't tell us
  // when it shuts down per-route, so we lean on process lifecycle.
  process.once('exit', () => {
    void cacheWatcher?.stop();
    void cachedTransport?.close();
  });

  return cachedCtx;
}

function isDev(): boolean {
  return process.env.NODE_ENV !== 'production';
}

const ROUTES: ReadonlyArray<{ route: string; methods: ReadonlyArray<string> }> = [
  { route: 'list', methods: ['GET'] },
  { route: 'me', methods: ['GET', 'POST'] },
  { route: 'git-state', methods: ['GET'] },
  { route: 'comment', methods: ['POST', 'PATCH', 'DELETE'] },
  { route: 'events', methods: ['GET'] },
  { route: 'sync', methods: ['POST'] },
  { route: 'sync-status', methods: ['GET'] },
];

function isKnownRoute(route: string, method: string): boolean {
  return ROUTES.some((r) => r.route === route && r.methods.includes(method));
}

// Matches Next.js 15+'s App Router route-handler signature: the second
// parameter is required (not optional), and `params` is a Promise. Next's
// generated route-type validation in `.next/types/...` checks our exported
// handlers against this exact shape — marking ctx optional made the diff
// check fail with "doesn't match the required context signature" on
// Next 15+. The route is mounted at app/margo-runtime/[[...path]]/route.ts
// (an optional catch-all), so `path` is `string[] | undefined`.
interface RouteContext {
  params: Promise<{ path?: string[] }>;
}

async function dispatch(request: Request, ctx: RouteContext): Promise<Response> {
  if (!isDev() && process.env.MARGO_ENABLED !== '1') {
    return new Response('not found', { status: 404 });
  }
  // Use the route's catch-all params rather than parsing request.url — Next
  // may expose either the original (/__margo/*) or the rewritten
  // (/margo-runtime/*) URL there, and the rewrite mapping is set up by
  // withMargo so the public surface stays /__margo/*.
  const { path } = await ctx.params;
  const route = path?.join('/') ?? '';
  const u = new URL(request.url);

  // Static-asset short-circuit: serve the overlay bundle from the package.
  if (request.method === 'GET' && (route === 'overlay.js' || route === 'overlay.js.map')) {
    return serveOverlay(route);
  }

  // Unknown routes return 404 BEFORE we try to instantiate a transport —
  // otherwise a workspace without margo.config.json (e.g. test harness,
  // or a user who hasn't run `margo init` yet) would 500 on every probe.
  if (!isKnownRoute(route, request.method)) {
    return new Response('not found', { status: 404 });
  }

  const handlerCtx = await ensureCtx();
  try {
    if (route === 'list' && request.method === 'GET') {
      return jsonResponse(200, await listComments(handlerCtx));
    }
    if (route === 'me' && request.method === 'GET') {
      return jsonResponse(200, await getMe(handlerCtx));
    }
    if (route === 'me' && request.method === 'POST') {
      const body = (await request.json()) as { name?: string; email?: string };
      return jsonResponse(200, await setMe(handlerCtx, body));
    }
    if (route === 'git-state' && request.method === 'GET') {
      return jsonResponse(200, await getGitState(handlerCtx));
    }
    if (route === 'comment' && request.method === 'POST') {
      const body = (await request.json()) as CreateCommentRequest;
      return jsonResponse(201, await createComment(handlerCtx, body));
    }
    if (route === 'comment' && request.method === 'PATCH') {
      const body = (await request.json()) as UpdateCommentRequest;
      return jsonResponse(200, await updateComment(handlerCtx, body));
    }
    if (route === 'comment' && request.method === 'DELETE') {
      const id = u.searchParams.get('id') ?? '';
      return jsonResponse(200, await deleteComment(handlerCtx, id));
    }
    if (route === 'events' && request.method === 'GET') {
      return handleEvents(handlerCtx, request);
    }
    if (route === 'sync' && request.method === 'POST') {
      return jsonResponse(200, await syncFromRemote(handlerCtx));
    }
    if (route === 'sync-status' && request.method === 'GET') {
      // Mirror of the sidecar/Vite implementation in server/endpoints.ts.
      // Server mode: RemoteTransport carries the offline-first outbox
      // and reports pending / lastSyncAt / lastError. Standalone mode:
      // no host, no outbox; return zeros so the overlay banner logic
      // doesn't have to branch on storage mode.
      const t = handlerCtx.transport as unknown as {
        getSyncStatus?: () => Promise<{ pending: number; lastSyncAt: string | null; lastError: string | null }>;
      };
      if (typeof t.getSyncStatus === 'function') {
        return jsonResponse(200, await t.getSyncStatus());
      }
      return jsonResponse(200, { pending: 0, lastSyncAt: null, lastError: null });
    }
    return new Response('not found', { status: 404 });
  } catch (err) {
    if (err instanceof HandlerError) {
      const payload = typeof err.payload === 'string' ? { error: err.payload } : err.payload ?? { error: err.message };
      return jsonResponse(err.status, payload);
    }
    return jsonResponse(500, { error: (err as Error).message });
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function serveOverlay(routeOrPath: string): Response {
  const isMap = routeOrPath.endsWith('overlay.js.map');
  const file = isMap ? OVERLAY_MAP_PATH : OVERLAY_BUNDLE_PATH;
  if (!fs.existsSync(file)) {
    return new Response('overlay bundle missing — run `npm run build` in margo-dev', { status: 404 });
  }
  // Read into memory: the bundle is small (~90 KB) and dev-only, so
  // streaming through Web Streams is overkill compared to a single buffer.
  const buf = fs.readFileSync(file);
  return new Response(buf, {
    status: 200,
    headers: {
      'content-type': isMap ? 'application/json' : 'application/javascript; charset=utf-8',
      'cache-control': 'no-cache',
    },
  });
}

function handleEvents(ctx: HandlerContext, request: Request): Response {
  const encoder = new TextEncoder();
  let client: SseClient | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`: connected ${new Date().toISOString()}\n\n`));
      client = {
        write: (payload) => {
          try { controller.enqueue(encoder.encode(payload)); }
          catch { /* controller closed */ }
        },
      };
      ctx.sseClients.add(client);
      ctx.onSseClientConnect?.(client);
      // Web Fetch surfaces client disconnect via the request's AbortSignal.
      // Without this we'd leak SseClient entries forever as tabs close.
      request.signal.addEventListener('abort', () => {
        if (client) ctx.sseClients.delete(client);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
    cancel() {
      if (client) ctx.sseClients.delete(client);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

// Public surface: handlers object the user re-exports from their route.ts.
// All four methods point to the same dispatcher — the dispatcher inspects
// method + path internally. Keeps the user's route.ts trivial.
export const handlers = {
  GET: dispatch,
  POST: dispatch,
  PATCH: dispatch,
  DELETE: dispatch,
};
