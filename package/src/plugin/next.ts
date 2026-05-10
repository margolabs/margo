// Next.js (App Router) entry for margo. Provides a Route Handler that
// serves the same /__margo/* surface as the Vite plugin, and a MargoScript
// React component the user drops into their root layout.
//
// Usage in a Next.js app:
//
//   // app/margo-runtime/[[...path]]/route.ts (init CLI creates this)
//   import { handlers } from 'margo-dev/next';
//   export const { GET, POST, PATCH, DELETE } = handlers;
//   export const runtime = 'nodejs';
//   export const dynamic = 'force-dynamic';
//
//   // app/layout.tsx
//   import { MargoScript } from 'margo-dev/next';
//   ...
//   <body>{children}<MargoScript /></body>
//
//   // next.config.ts
//   import { withMargo } from 'margo-dev/next';
//   export default withMargo(nextConfig);
//
// Production safety: behavior is gated by NODE_ENV. When NODE_ENV=production
// and MARGO_ENABLED is unset, dispatch() returns 404 immediately and
// <MargoScript /> renders null, so chokidar/git/file watcher never run and
// no overlay code reaches the browser. We import the runtime modules
// statically (not via dynamic import) — Turbopack misbehaves with dynamic
// imports inside route-evaluated modules, triggering restart loops on
// every request.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';
import { createElement, type ReactElement } from 'react';
import {
  HandlerError,
  broadcastSse,
  createComment,
  deleteComment,
  getGitState,
  getMe,
  listComments,
  syncFromRemote,
  updateComment,
  type HandlerContext,
  type SseClient,
} from '../server/handlers.js';
import { CommentWatcher } from '../server/watcher.js';
import { RemotePoller } from '../server/remote-poller.js';
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
// and reuses the same chokidar watcher + sseClients set across requests.
let cachedCtx: HandlerContext | null = null;
let watcherStarted = false;
let poller: RemotePoller | null = null;

async function ensureCtx(): Promise<HandlerContext> {
  if (cachedCtx) return cachedCtx;
  const rootDir = process.cwd();
  const margoDir = path.join(rootDir, '.margo');
  const commentsDir = path.join(margoDir, 'comments');
  let config: MargoConfig = DEFAULTS;
  try {
    const raw = await fsp.readFile(path.join(margoDir, 'config.json'), 'utf8');
    config = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // .margo/config.json doesn't exist — handlers still work, just with defaults.
  }
  const sseClients = new Set<SseClient>();
  cachedCtx = {
    rootDir,
    commentsDir,
    config,
    sseClients,
    // Replay the most recent remote-changes payload so a tab that loaded
    // after the poller's initial tick still sees the banner.
    onSseClientConnect: (client) => {
      const last = poller?.getLastPayload();
      if (last) client.write(`data: ${JSON.stringify(last)}\n\n`);
    },
    onAfterSync: () => poller?.reset(),
  };

  if (!watcherStarted) {
    watcherStarted = true;
    const w = new CommentWatcher(commentsDir);
    w.on('event', (e) => broadcastSse(cachedCtx!, e));
    w.start();
    poller = new RemotePoller(rootDir, config.git.remotePollIntervalMs);
    poller.on('event', (e) => broadcastSse(cachedCtx!, e));
    poller.start();
    // Process exit cleans these up; Next.js dev server doesn't tell us
    // when it shuts down per-route, so we lean on process lifecycle.
    process.once('exit', () => {
      void w.stop();
      poller?.stop();
    });
  }

  return cachedCtx;
}

function isDev(): boolean {
  return process.env.NODE_ENV !== 'production';
}

interface RouteContext {
  // App Router catch-all params arrive as a Promise in Next.js 15+.
  params: Promise<{ path?: string[] }>;
}

async function dispatch(request: Request, ctx?: RouteContext): Promise<Response> {
  if (!isDev() && process.env.MARGO_ENABLED !== '1') {
    return new Response('not found', { status: 404 });
  }
  // Resolve which subpath is being addressed. Prefer the route's catch-all
  // params (works regardless of whether Next.js exposes the rewritten or the
  // original URL on `request.url`); fall back to URL parsing for callers
  // that invoke the dispatcher directly without a route context.
  const params = ctx?.params ? await ctx.params : null;
  const segments = params?.path && params.path.length > 0
    ? params.path
    : new URL(request.url).pathname.replace(/^\/(?:__margo|margo-runtime)\/?/, '').split('/').filter(Boolean);
  const route = segments.join('/');
  const u = new URL(request.url);

  // Static-asset short-circuit: serve the overlay bundle from the package.
  if (request.method === 'GET' && (route === 'overlay.js' || route === 'overlay.js.map')) {
    return serveOverlay(route);
  }

  const handlerCtx = await ensureCtx();
  try {
    if (route === 'list' && request.method === 'GET') {
      return jsonResponse(200, await listComments(handlerCtx));
    }
    if (route === 'me' && request.method === 'GET') {
      return jsonResponse(200, await getMe(handlerCtx));
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

// Re-export the next-config wrapper so users have a single import path.
// Sub-sub-paths like 'margo-dev/next/config' tripped Next.js's config
// loader (ERR_PACKAGE_PATH_NOT_EXPORTED) even though Node resolved them
// fine — flatter is safer.
export { withMargo } from './next-config.js';

// React component — drop into `app/layout.tsx`. Renders nothing in
// production unless MARGO_ENABLED=1 (preview deploys).
export function MargoScript(): ReactElement | null {
  if (!isDev() && process.env.MARGO_ENABLED !== '1') return null;
  const mode = isDev() ? 'dev' : 'preview';
  const bootstrap = `(async () => {
    const mod = await import('/__margo/overlay.js');
    mod.start({ mode: ${JSON.stringify(mode)} });
  })().catch((err) => console.warn('[margo] failed to start overlay', err));`;
  return createElement('script', {
    type: 'module',
    'data-margo': '',
    'data-margo-mode': mode,
    dangerouslySetInnerHTML: { __html: bootstrap },
  });
}
