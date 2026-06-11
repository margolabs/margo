// Vite plugin entry. Mounts the margo server endpoints in dev mode and
// injects the overlay script into the HTML response.
//
// On preview deploys (production build with MARGO_ENABLED=1), we ship a
// read-only overlay so previewers can see existing pins but cannot create
// or modify comments.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';
import type { ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { handleEndpoint, isMargoEndpoint, broadcastSse, type EndpointContext } from '../server/endpoints.js';
import { BOOTSTRAP_JS } from '../server/bootstrap-js.js';
import type { SseClient } from '../server/handlers.js';
import { handleAuthLogout, handleAuthPoll, handleAuthStart, isAuthEndpoint } from '../server/auth-endpoints.js';
import { mirrorTransportToDir } from '../storage/cache-mirror.js';
import { CacheWatcher } from '../storage/cache-watcher.js';
import { createTransport } from '../storage/factory.js';
import type { RemoteTransport } from '../storage/remote-transport.js';
import { AuthError, type Transport } from '../storage/transport.js';
import type { MargoConfig } from '../shared/types.js';

const PLUGIN_DIR = path.dirname(url.fileURLToPath(import.meta.url));
const OVERLAY_BUNDLE_PATH = path.join(PLUGIN_DIR, '..', 'overlay.bundle.js');
const OVERLAY_MAP_PATH = path.join(PLUGIN_DIR, '..', 'overlay.bundle.js.map');

export interface MargoPluginOptions {
  /** Disable the overlay even when in dev mode (useful for tests). */
  disabled?: boolean;
}

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

export default function margo(opts: MargoPluginOptions = {}): Plugin {
  let viteRoot = process.cwd();
  // commentsDir is now provided by createTransport — standalone resolves
  // to `~/.margo/standalone/<id>/comments/`, server resolves to the
  // per-(host, project) cache mirror under `~/.margo/cache/`. We hold
  // it so the SSE-driven mirror writer knows where to land.
  let commentsDir = '';
  let config: MargoConfig = DEFAULTS;
  const sseClients = new Set<SseClient>();
  // Mutable: starts null in server mode when no credentials are saved.
  // After the overlay drives the device-login flow, recreateTransport()
  // swaps in a real RemoteTransport without restarting the dev server.
  let transport: Transport | null = null;
  let storageMode: 'standalone' | 'server' = 'standalone';
  let serverInfo: { host: string; project: string } | undefined;
  let needsAuth = false;
  // Server-mode only: watches the cache directory and pushes any local
  // edit (overlay, AI, manual) up to the host through the same offline-
  // tolerant transport.write path. Lives outside recreateTransport so
  // the close handler can tear it down on dev-server shutdown.
  let cacheWatcher: CacheWatcher | null = null;

  const ctx = (): EndpointContext => {
    if (!transport) throw new Error('[margo] transport not initialized');
    return {
      rootDir: viteRoot,
      transport,
      storageMode,
      serverInfo,
      config,
      sseClients,
      // Replay the most recent remote-changes payload so a tab that loaded
      // after the poller's initial tick still sees the banner.
      onSseClientConnect: (client) => {
        const last = transport?.getLastRemoteChanges();
        if (last) {
          client.write(`data: ${JSON.stringify({ type: 'remote-changes', ...last })}\n\n`);
        }
      },
      onAfterSync: () => transport?.resetRemoteChanges(),
    };
  };

  return {
    name: 'margo',
    enforce: 'pre',

    async configResolved(resolved) {
      viteRoot = resolved.root;
      // No more `.margo/config.json` to load — all workspace config now
      // lives at the repo root in `margo.config.json` (storage mode +
      // standalone id OR server host/project). `config` keeps its
      // defaults (overlay-side behavior flags) until we strip the type
      // entirely.
    },

    async configureServer(server) {
      if (opts.disabled) return;

      // Re-runnable boot for the storage backend. Called once at startup
      // and again whenever the overlay drives a login/logout, so the
      // transport reflects the current credentials state without a dev-
      // server restart.
      const recreateTransport = async (logTransition: boolean): Promise<void> => {
        // Tear down the old transport (if any) — drops its SSE
        // subscription and any in-flight remote polls. New one takes
        // over below.
        if (transport) {
          try { await transport.close(); } catch { /* best-effort */ }
          transport = null;
        }
        // Drop the existing cache watcher so it doesn't keep talking to
        // a dead transport. A new one is constructed below when the
        // fresh transport boots into server mode.
        if (cacheWatcher) {
          try { await cacheWatcher.stop(); } catch { /* best-effort */ }
          cacheWatcher = null;
        }
        const created = await createTransport({
          rootDir: viteRoot,
          // Plugins recover from missing credentials via the in-overlay
          // device flow; we don't want createTransport to throw and crash
          // the dev server when a teammate hasn't run `margo login` yet.
          allowMissingAuth: true,
        });
        transport = created.transport;
        storageMode = created.mode;
        serverInfo = created.serverInfo;
        commentsDir = created.commentsDir;
        needsAuth = created.needsAuth === true;
        if (logTransition) {
          if (needsAuth) {
            console.log(`[margo] storage mode: server (needs sign-in — open the dev server in a browser to authorize)`);
          } else {
            console.log(`[margo] storage mode: ${created.mode}${created.configPath ? ` (from ${created.configPath})` : ''}`);
          }
        }
        // Server mode: pull all comments into the local cache once after
        // (re)-boot so AI agents (which read the cached files off disk)
        // see fresh state without anyone running `npx margo pull`. Fire
        // and forget — boot succeeds even if the host is briefly
        // unreachable; a partial cache is better than a crashed plugin.
        // Bridge transport events into the SSE stream so connected
        // overlays re-render on file changes / upstream divergence.
        if (transport) {
          transport.subscribe((e) => broadcastSse(ctx(), e));
          transport.subscribeRemoteChanges((payload) => {
            if (payload) broadcastSse(ctx(), { type: 'remote-changes', ...payload });
          });
          // Server mode only: bidirectional sync between the cache
          // directory and the host. Three halves:
          //   - Boot pull seeds the cache with the host's current state
          //   - SSE subscriber mirrors host → disk for subsequent updates
          //   - CacheWatcher (chokidar) mirrors disk → host for local
          //     edits (overlay POSTs, AI direct edits, manual edits)
          // The echo-loop guard is the shared expected-hash set on
          // CacheWatcher: every time something writes to the cache
          // (boot pull or SSE subscriber), it registers the content
          // hash so the chokidar 'change' event we're about to receive
          // doesn't push the same content back to the host. Same
          // pattern as the `margo watch` CLI.
          if (created.mode === 'server') {
            const captured = transport;
            const watcher = new CacheWatcher({
              commentsDir,
              transport: captured as RemoteTransport,
            });
            cacheWatcher = watcher;
            // Start the watcher BEFORE the boot pull so its
            // expected-hash registrations are in place before chokidar
            // sees the pull's writes.
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
                // 'created' / 'updated' — read the canonical content
                // back from the host so what lands on disk is byte-
                // identical to what other teammates see.
                const fresh = await captured.read(ev.id);
                if (!fresh) return; // raced with a delete
                watcher.registerExpectedWrite(ev.id, fresh.raw);
                await fsp.mkdir(commentsDir, { recursive: true });
                await fsp.writeFile(file, fresh.raw, 'utf8');
              } catch (err) {
                // Don't crash the plugin on a transient mirror failure
                // — the next event (or a dev-server restart) will
                // recover. Warn so the operator sees it.
                console.warn(`[margo] failed to mirror ${ev.id} to cache:`, (err as Error).message);
              }
            });
          }
        }
      };

      await recreateTransport(true);

      // Offline-first drainer for server mode. Periodically attempts to
      // push any queued ops to the host. Light-weight no-op when the
      // transport is non-Remote or the outbox is empty.
      let drainTimer: NodeJS.Timeout | null = null;
      const startDrainer = (): void => {
        if (drainTimer) return;
        const tick = async (): Promise<void> => {
          if (!transport) return;
          const remote = transport as unknown as { drain?: () => Promise<{ pushed: number; pending: number; error?: string }> };
          if (typeof remote.drain !== 'function') return;
          try {
            const { pushed, pending } = await remote.drain();
            if (pushed > 0) console.log(`[margo] drained ${pushed} offline op(s); ${pending} still pending`);
          } catch (err) {
            // Drain errors are non-fatal; log once at warning level.
            console.warn('[margo] outbox drain failed:', (err as Error).message);
          }
        };
        // First tick after 5s so a host that boots a couple seconds late
        // gets caught quickly; then every 30s while running.
        setTimeout(() => void tick(), 5_000);
        drainTimer = setInterval(() => void tick(), 30_000);
      };
      startDrainer();

      const authCtx = () => ({
        hostUrl: serverInfo?.host,
        project: serverInfo?.project,
        // After login/logout, swap the transport without restarting the
        // dev server. The overlay will reload itself; this just makes
        // sure the new fetch lands in a working state.
        onAuthChange: () => recreateTransport(false),
      });

      server.middlewares.use(async (req, res, next) => {
        const u = req.url ?? '';
        if (u === '/__margo/overlay.js' || u === '/__margo/overlay.js.map') {
          return serveOverlay(u, res);
        }
        // Same `<script src="/__margo/bootstrap.js">` the sidecar
        // exposes. Sounds like a sidecar-only thing, but users copy
        // that snippet from the README into HTML files served from
        // Vite-managed apps too; without this route the bootstrap
        // 404s and the overlay silently fails to load.
        if (u === '/__margo/bootstrap.js') {
          res.writeHead(200, {
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'no-cache',
          });
          res.end(BOOTSTRAP_JS);
          return;
        }
        // Plugin-side device-login proxy. Always available regardless of
        // transport state — that's the whole point: the user hits these
        // PRECISELY when they don't have a transport yet.
        if (isAuthEndpoint(u)) {
          if (u === '/__margo/auth/start' && req.method === 'POST') return handleAuthStart(authCtx(), req, res);
          if (u === '/__margo/auth/poll' && req.method === 'POST') return handleAuthPoll(authCtx(), req, res);
          if (u === '/__margo/auth/logout' && req.method === 'POST') return handleAuthLogout(authCtx(), req, res);
          res.writeHead(405).end('method not allowed');
          return;
        }
        if (!isMargoEndpoint(u)) return next();

        // Centralized "no transport → needsAuth payload" response so the
        // boot path and the post-revoke recovery path produce identical
        // shapes. The overlay then has one rule: needsAuth → sign-in
        // pill, never the git-identity dialog.
        const respondNeedsAuth = (): void => {
          if (u === '/__margo/me' && req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              mode: storageMode,
              needsAuth: true,
              server: serverInfo,
            }));
            return;
          }
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'authentication required', needsAuth: true }));
        };

        if (!transport) return respondNeedsAuth();

        try {
          await handleEndpoint(ctx(), req, res);
        } catch (err) {
          if (err instanceof AuthError) {
            // The bearer token went dead mid-session — typically the user
            // revoked it from the host dashboard. Drop the in-memory
            // transport so subsequent requests render the sign-in pill
            // instead of looping on the same dead token.
            console.warn(`[margo] host rejected bearer token (${err.message}); dropping transport, sign-in required.`);
            try { await transport.close(); } catch { /* best-effort */ }
            transport = null;
            // Headers may already be partially written by handleEndpoint —
            // only write the recovery response if nothing's been sent yet.
            if (!res.headersSent) respondNeedsAuth();
            return;
          }
          throw err;
        }
      });

      server.httpServer?.once('close', () => {
        if (drainTimer) {
          clearInterval(drainTimer);
          drainTimer = null;
        }
        void cacheWatcher?.stop();
        cacheWatcher = null;
        void transport?.close();
        transport = null;
      });
    },

    transformIndexHtml: {
      order: 'post',
      handler() {
        if (opts.disabled) return;
        const isPreview = process.env.MARGO_ENABLED === '1' && !!process.env.VERCEL_ENV;
        const isDev = process.env.NODE_ENV !== 'production';
        if (!isDev && !isPreview) return;
        return [
          {
            tag: 'script',
            attrs: {
              type: 'module',
              'data-margo': '',
              'data-margo-mode': isDev ? 'dev' : 'preview',
              // Surfaces the resolved storage backend to the overlay
              // BEFORE any fetch happens. The overlay uses this to pick
              // the right boot screen (sign-in pill vs git-identity
              // dialog) even when /__margo/me fails entirely — a
              // network blip or plugin hiccup must not degrade a
              // server-mode workspace into local-mode UX. Always
              // emitted; never sensitive (it's just 'local' or
              // 'server').
              'data-margo-storage': storageMode,
            },
            // The overlay bundle is built separately and copied to the package.
            // Path is relative because in dev it is served by the plugin
            // itself; in preview it is fetched from the deploy.
            children: bootstrapInline(),
            injectTo: 'body',
          },
        ];
      },
    },
  };
}

function bootstrapInline(): string {
  // Inline bootstrap: load the overlay bundle, pass the runtime mode through.
  return `
    (async () => {
      const mode = document.currentScript?.getAttribute('data-margo-mode') ?? 'dev';
      const mod = await import('/__margo/overlay.js');
      mod.start({ mode });
    })().catch((err) => console.warn('[margo] failed to start overlay', err));
  `;
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

export { margo };
