// `npx margo serve` — standalone HTTP server that hosts the /__margo/* API
// and overlay bundle for any framework whose dev server can proxy.
//
// Why a sidecar exists:
//   The native plugins (vite.ts, next-server.ts) require build-tool plugin
//   APIs that not every framework exposes. Angular CLI, raw webpack-dev-
//   server, Vue CLI, Create React App — none of them accept Vite plugins or
//   Next.js route handlers. They all do accept a proxy config. So the
//   sidecar runs `/__margo/*` on its own port and the framework's dev
//   server proxies that path range to it. Net result: any framework with a
//   proxy mechanism becomes margo-compatible without a new adapter.
//
// Wire model:
//   1. user runs `margo serve --port 3001` next to their framework dev
//      server (concurrently or two terminals).
//   2. user adds a 5-line proxy rule that forwards /__margo/* → :3001.
//   3. user adds <script type="module" src="/__margo/bootstrap.js"></script>
//      to their index.html. Bootstrap dynamically imports overlay.js (also
//      proxied) and calls start({mode:'dev'}).
//
// Same business logic as the Vite plugin — we reuse handleEndpoint and the
// same EndpointContext, watcher, and poller. Only the transport differs
// (no Vite middleware chain).

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import * as url from 'node:url';
import type { ServerResponse } from 'node:http';
import { handleEndpoint, isMargoEndpoint, broadcastSse, type EndpointContext } from '../server/endpoints.js';
import type { SseClient } from '../server/handlers.js';
import { mirrorTransportToDir } from '../storage/cache-mirror.js';
import { createTransport } from '../storage/factory.js';
import type { MargoConfig } from '../shared/types.js';

const CLI_DIR = path.dirname(url.fileURLToPath(import.meta.url));
const OVERLAY_BUNDLE_PATH = path.join(CLI_DIR, '..', 'overlay.bundle.js');
const OVERLAY_MAP_PATH = path.join(CLI_DIR, '..', 'overlay.bundle.js.map');

// Tiny bootstrap served at /__margo/bootstrap.js. External <script src=...>
// so the user only adds one line to their index.html. We hardcode mode=dev
// because the sidecar only ever runs during local development — preview
// builds use the native plugins, which inline the bootstrap with the mode
// already known at build time.
const BOOTSTRAP_JS = `(async () => {
  try {
    const mod = await import('/__margo/overlay.js');
    mod.start({ mode: 'dev' });
  } catch (err) {
    console.warn('[margo] failed to start overlay', err);
  }
})();
`;

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

export interface ServeOptions {
  port: number;
  cwd: string;
}

export async function serve(opts: ServeOptions): Promise<void> {
  const rootDir = path.resolve(opts.cwd);
  const config: MargoConfig = DEFAULTS;
  const sseClients = new Set<SseClient>();
  const created = await createTransport({ rootDir });
  // Sidecar `margo serve` doesn't opt into allowMissingAuth — createTransport
  // already threw with a clear "run `margo login`" message if there's no
  // credential. Narrow here so TS knows transport is non-null below.
  if (!created.transport) throw new Error('[margo] unreachable: transport unexpectedly null');
  const transport = created.transport;
  const commentsDir = created.commentsDir;
  console.log(`[margo] storage mode: ${created.mode}${created.configPath ? ` (from ${created.configPath})` : ''}`);

  const ctx = (): EndpointContext => ({
    rootDir,
    transport,
    storageMode: created.mode,
    serverInfo: created.serverInfo,
    config,
    sseClients,
    onSseClientConnect: (client) => {
      const last = transport.getLastRemoteChanges();
      if (last) {
        client.write(`data: ${JSON.stringify({ type: 'remote-changes', ...last })}\n\n`);
      }
    },
    onAfterSync: () => transport.resetRemoteChanges(),
  });

  if (created.mode === 'server') {
    void mirrorTransportToDir(transport, commentsDir)
      .then(({ pulled }) => console.log(`[margo] cached ${pulled} comment(s) from host for AI`))
      .catch((err) => console.warn('[margo] initial pull failed (AI cache may be stale):', (err as Error).message));
  }
  transport.subscribe((e) => broadcastSse(ctx(), e));
  transport.subscribeRemoteChanges((payload) => {
    if (payload) broadcastSse(ctx(), { type: 'remote-changes', ...payload });
  });

  const server = http.createServer(async (req, res) => {
    // CORS: the sidecar is typically reached via the framework's proxyConfig
    // (same-origin from the browser's POV), but we allow direct cross-origin
    // access too. Useful for ad-hoc curl tests and for frameworks where the
    // user prefers a manual cross-origin script tag over a proxy rule.
    res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('vary', 'origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const u = req.url ?? '';
    // Some bundlers (e.g. Vite's import-analysis) rewrite dynamic imports
    // to append a `?import` query string. Match on pathname so the sidecar
    // serves the overlay regardless of any bundler-injected query.
    const pathname = u.split('?', 1)[0];
    if (pathname === '/__margo/overlay.js' || pathname === '/__margo/overlay.js.map') {
      return serveOverlay(pathname, res);
    }
    if (pathname === '/__margo/bootstrap.js') {
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-cache',
      });
      res.end(BOOTSTRAP_JS);
      return;
    }
    if (!isMargoEndpoint(u)) {
      res.writeHead(404).end('not a margo endpoint');
      return;
    }
    await handleEndpoint(ctx(), req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const origin = `http://localhost:${opts.port}`;
  console.log(`[margo] serve listening on ${origin}`);
  console.log(`[margo] cwd: ${rootDir}`);
  console.log(`[margo] add to your dev server's proxy config:`);
  console.log(`         /__margo/* → ${origin}`);
  console.log(`[margo] add to your index.html (in <head> or <body>):`);
  console.log(`         <script type="module" src="/__margo/bootstrap.js"></script>`);

  const shutdown = (): void => {
    void transport.close();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function serveOverlay(reqUrl: string, res: ServerResponse): void {
  const isMap = reqUrl === '/__margo/overlay.js.map';
  const file = isMap ? OVERLAY_MAP_PATH : OVERLAY_BUNDLE_PATH;
  if (!fs.existsSync(file)) {
    res.writeHead(404).end('overlay bundle missing — run `npm run build` in margo-dev');
    return;
  }
  const stream = fs.createReadStream(file);
  res.writeHead(200, {
    'content-type': isMap ? 'application/json' : 'application/javascript; charset=utf-8',
    'cache-control': 'no-cache',
  });
  stream.pipe(res);
}
