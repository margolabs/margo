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
import type { SseClient } from '../server/handlers.js';
import { handleAuthLogout, handleAuthPoll, handleAuthStart, isAuthEndpoint } from '../server/auth-endpoints.js';
import { mirrorTransportToDir } from '../storage/cache-mirror.js';
import { createTransport } from '../storage/factory.js';
import { AuthError, type Transport } from '../storage/transport.js';
import type { MargoConfig } from '../shared/types.js';

const PLUGIN_DIR = path.dirname(url.fileURLToPath(import.meta.url));
const OVERLAY_BUNDLE_PATH = path.join(PLUGIN_DIR, '..', 'overlay.bundle.js');
const OVERLAY_MAP_PATH = path.join(PLUGIN_DIR, '..', 'overlay.bundle.js.map');

export interface MargoPluginOptions {
  /** Override `.margo` directory location. Defaults to `<viteRoot>/.margo`. */
  margoDir?: string;
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
  let margoDir = '';
  let commentsDir = '';
  let config: MargoConfig = DEFAULTS;
  const sseClients = new Set<SseClient>();
  // Mutable: starts null in server mode when no credentials are saved.
  // After the overlay drives the device-login flow, recreateTransport()
  // swaps in a real RemoteTransport without restarting the dev server.
  let transport: Transport | null = null;
  let storageMode: 'local' | 'server' = 'local';
  let serverInfo: { url: string; project: string } | undefined;
  let needsAuth = false;

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
      margoDir = opts.margoDir ?? path.join(viteRoot, '.margo');
      commentsDir = path.join(margoDir, 'comments');
      const cfgPath = path.join(margoDir, 'config.json');
      try {
        const raw = await fsp.readFile(cfgPath, 'utf8');
        config = { ...DEFAULTS, ...JSON.parse(raw) };
      } catch {
        // `.margo/config.json` doesn't exist yet — user hasn't run init.
        // Plugin still loads but in a "not initialized" state; first request
        // returns a 412 with instructions.
      }
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
        const created = await createTransport({
          rootDir: viteRoot,
          commentsDir,
          config,
          // Plugins recover from missing credentials via the in-overlay
          // device flow; we don't want createTransport to throw and crash
          // the dev server when a teammate hasn't run `margo login` yet.
          allowMissingAuth: true,
        });
        transport = created.transport;
        storageMode = created.mode;
        serverInfo = created.serverInfo;
        needsAuth = created.needsAuth === true;
        if (logTransition) {
          if (needsAuth) {
            console.log(`[margo] storage mode: server (needs sign-in — open the dev server in a browser to authorize)`);
          } else {
            console.log(`[margo] storage mode: ${created.mode}${created.configPath ? ` (from ${created.configPath})` : ''}`);
          }
        }
        // Server mode: pull all comments into the local cache once after
        // (re)-boot so AI agents (which read .margo/comments/*.md off
        // disk) see fresh state without anyone running `npx margo pull`.
        // Fire and forget — boot succeeds even if the host is briefly
        // unreachable; a partial cache is better than a crashed plugin.
        if (transport && created.mode === 'server') {
          const captured = transport;
          void mirrorTransportToDir(captured, commentsDir)
            .then(({ pulled }) => console.log(`[margo] cached ${pulled} comment(s) from host for AI`))
            .catch((err) => console.warn('[margo] initial pull failed (AI cache may be stale):', (err as Error).message));
        }
        // Bridge transport events into the SSE stream so connected
        // overlays re-render on file changes / upstream divergence.
        if (transport) {
          transport.subscribe((e) => broadcastSse(ctx(), e));
          transport.subscribeRemoteChanges((payload) => {
            if (payload) broadcastSse(ctx(), { type: 'remote-changes', ...payload });
          });
        }
      };

      await recreateTransport(true);

      const authCtx = () => ({
        hostUrl: serverInfo?.url,
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
