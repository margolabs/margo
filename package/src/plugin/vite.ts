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
import { CommentWatcher } from '../server/watcher.js';
import { backgroundPull } from '../server/git.js';
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
  let watcher: CommentWatcher | undefined;
  let pullTimer: NodeJS.Timeout | undefined;

  const ctx = (): EndpointContext => ({
    rootDir: viteRoot,
    commentsDir,
    config,
    sseClients,
  });

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

    configureServer(server) {
      if (opts.disabled) return;
      server.middlewares.use(async (req, res, next) => {
        const u = req.url ?? '';
        if (u === '/__margo/overlay.js' || u === '/__margo/overlay.js.map') {
          return serveOverlay(u, res);
        }
        if (!isMargoEndpoint(u)) return next();
        await handleEndpoint(ctx(), req, res);
      });

      // SSE broadcast on local file changes, without waiting for git.
      watcher = new CommentWatcher(commentsDir);
      watcher.on('event', (e) => broadcastSse(ctx(), e));
      watcher.start();

      // Periodic background pull so others' comments arrive automatically.
      const intervalMs = 30_000;
      pullTimer = setInterval(() => {
        backgroundPull(viteRoot).catch(() => {
          // Silent failure: the overlay can show "sync paused" if it cares.
        });
      }, intervalMs);

      server.httpServer?.once('close', () => {
        watcher?.stop();
        if (pullTimer) clearInterval(pullTimer);
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
    res.writeHead(404).end('overlay bundle missing — run `npm run build` in @margo/dev');
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
