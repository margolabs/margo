# margo-dev

Live-app feedback layer for AI-coding teams. Designers, PMs, and devs leave comments on the running app; AI works through them. Two storage modes — both self-hosted, no SaaS, no project-tree footprint:

- **Standalone (default)** — solo workspace, "me + AI on my machine." Comments at `~/.margo/standalone/<id>/`. No host, no sign-in, zero infra.
- **Server (collaboration)** — comments on a self-hostable [margo-host](https://hub.docker.com/r/margolabs/margo-host) Docker container; plugin caches to `~/.margo/cache/<host>/<project>/`. Per-project member roster, browser sign-in from the overlay, offline-first writes that queue when the host is unreachable.

Neither mode touches your project repo's git history. The whole footprint in the repo is one file: `margo.config.json` at the root.

## Install

`cd` into your app directory (wherever `package.json` lives) and run:

```sh
npm install -D margo-dev
npx margo init
```

`init` writes `margo.config.json` at the repo root (defaulting to standalone mode) and patches your `vite.config.*` / `next.config.*` to register the margo plugin. In a monorepo, run `init` once per app — each gets its own workspace id (or server project).

### Server mode (collaboration)

Point at a self-hostable host instead:

```sh
# 1. Start a host (one container, anywhere your team can reach it)
docker run -d -p 7331:7331 -v margo-data:/data margolabs/margo-host:latest
#    open http://<host>:7331/setup to claim first-signup-wins admin,
#    then create your project on the dashboard.

# 2. In your app's repo
npx margo init --server http://<host>:7331 --project <slug>

# 3. Run your dev server, then click "Sign in to margo" in the overlay
npm run dev
```

The overlay's blue **Sign in to margo** pill drives a browser-based device flow; the token saves to `~/.margo/credentials.json` (mode 0600, per-user, never in the repo). Prefer a terminal? `npx margo login <host>` does the same dance. CI / Docker dev containers can set `MARGO_TOKEN=mgo_…` directly. Sign out from the avatar popover in the overlay or `npx margo logout <host>` from a shell.

For solo onboarding without learning Docker: `npx margo host start` prints the Docker one-liner pinned to `~/.margo/hosts/default/data/`.

### Offline-first (server mode)

Server-mode writes go to a local outbox first, then to the host. When the host is unreachable (laptop closed, network blip, host restart), your pins still land instantly — the overlay shows an amber "syncing…" pill while the queue's non-empty. A background drainer retries every 30 seconds. Nothing to configure; the outbox lives under `~/.margo/cache/<host>/<project>/.outbox/`.

### Claude Code integration (optional)

If you use Claude Code, install the `/margo` skill from the same directory:

```sh
npx margo-dev install-skill             # default: commits .claude/skills/margo/ to this repo
npx margo-dev install-skill --project   # same as above, explicit
npx margo-dev install-skill --user      # installs at ~/.claude/skills/ instead (not committed)
```

The skill lives at the git repo root (Claude Code only discovers project skills at workspace root), but the `CLAUDE.md` reference block goes next to your `.margo/` — so a monorepo with multiple apps gets per-app references, not one global one.

The whole flow is what `claude "add margo to this project"` runs for you.

## Vite

After `init`, your `vite.config.ts` will look like:

```ts
import { defineConfig } from 'vite';
import margo from 'margo-dev';

export default defineConfig({
  plugins: [margo()],
});
```

## Next.js (App Router)

After `init`, three things land in your project:

```ts
// next.config.ts — config wrapped with margo's HOC
import { withMargo } from 'margo-dev/next';
const nextConfig = { /* your stuff */ };
export default withMargo(nextConfig);

// app/layout.tsx — script tag for the overlay
import { MargoScript } from 'margo-dev/next';
<body>{children}<MargoScript /></body>

// app/margo-runtime/[[...path]]/route.ts — the catch-all handler
import { handlers } from 'margo-dev/next';
export const { GET, POST, PATCH, DELETE } = handlers;
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
```

The route lives at `app/margo-runtime/` (not `app/__margo/`) because Next.js treats `_`-prefixed folders as private. The `withMargo` wrapper adds a rewrite so the public URL stays `/__margo/*`.

## Other frameworks (sidecar)

Angular, raw webpack-dev-server, Vue CLI, Create React App, SvelteKit-non-Vite, Remix-classic — any framework whose dev server can proxy a URL prefix — work via a sidecar. Run `margo serve` next to the framework's dev server and forward `/__margo/*` to it:

```sh
# terminal 1
ng serve                                # or vue-cli-service serve, etc.

# terminal 2
npx margo serve --port 3001
```

In your framework's proxy config (Angular's `proxy.conf.json`, webpack's `devServer.proxy`, etc.):

```json
{
  "/__margo": { "target": "http://localhost:3001", "changeOrigin": true }
}
```

In your app's `index.html` (one line):

```html
<script type="module" src="/__margo/bootstrap.js"></script>
```

In production builds the tag is still there; the prod server returns 404 (one harmless console warning, no UI impact). To suppress, gate the tag with your framework's prod/dev conditional — Angular's `fileReplacements` in `angular.json`, webpack/Vue-CLI's template `<% if %>` syntax, etc.

Then run both servers with one command using [concurrently](https://www.npmjs.com/package/concurrently):

```json
{ "scripts": { "dev": "concurrently \"ng serve\" \"margo serve --port 3001\"" } }
```

See [`demo-angular/`](https://github.com/margolabs/margo/tree/main/demo-angular) for a working setup.

## How to comment

```sh
npm run dev
```

Open the app, click the `📌 Pin` button at bottom-right, click any element, type your comment.

Prefix shortcuts:

- `?` at the start = `type: question` (AI answers in-thread, doesn't change code)
- `//` at the start = `type: discussion` (humans only)
- anything else = `type: task` (AI works on it)

## How AI engages

Inside the repo, run:

```sh
claude
```

`.margo/CLAUDE.md` primes the session with the inbox count. Run `/margo` to triage and process open tasks. AI replies in the same comment file and bumps `status` to `ready-for-review` or `blocked` — never `resolved` (only humans set that).

## Production safety

- `<MargoScript />` returns `null` in production, so no overlay code reaches the browser.
- The route handler returns `404` early in production, so chokidar/git/file watchers never run.
- Keep `margo-dev` in `devDependencies` so `npm install --omit=dev` skips it entirely.
- Activate margo on preview deploys (read-only mode) by setting `MARGO_ENABLED=1`.

## License

MIT
