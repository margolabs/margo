# margo-dev

Live-app feedback layer for AI-coding teams. Designers, PMs, and devs leave comments on the running app; AI works through them. Comments live as files in your repo, synced over git — no SaaS, no separate user system, no extension to install.

## Install

```sh
npm install -D margo-dev
npx margo-dev init
```

The `init` command:

- Scaffolds `.margo/` (config, CLAUDE.md, comments folder)
- Drops a `/margo` Claude Code skill at `.claude/skills/margo.md`
- Adds a margo block to your project's root `CLAUDE.md`
- Wires the plugin into your build config (Vite or Next.js, auto-detected)

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
