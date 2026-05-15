# margo — implementation status

The v0 spec from [README.md](./README.md) is shipped. Margo is published on npm as `margo-dev` and exercised end-to-end by five demos in this repo. Verify any demo with `node scripts/verify-demo.mjs <dir> <url>` — boots the dev server, opens it in headless Chromium, asserts the overlay mounts + `/__margo/me` round-trips.

## Build status

| Area | Status | Notes |
| --- | --- | --- |
| Shared types + frontmatter parser | ✅ shipped | YAML round-trip; reply append helper |
| Comment ID generation | ✅ shipped | 6-hex-char IDs via `crypto.randomBytes` |
| Local server endpoints | ✅ shipped | GET/POST/PATCH/DELETE/SSE/sync; transport-agnostic handlers |
| Git CLI wrapper | ✅ shipped | shell-out, host-agnostic; background-queued commit/push |
| FS watcher | ✅ shipped | chokidar over `.margo/comments/*.md` → SSE broadcast |
| Remote poller | ✅ shipped | periodic `git fetch` + diff-listing, surfaces incoming-comments banner |
| Vite plugin | ✅ shipped | mounts middleware via `configureServer`, injects bootstrap |
| Next.js plugin (App Router) | ✅ shipped | catch-all Route Handler + `<MargoScript />` + `withMargo` config wrapper. Public URL stays `/__margo/*` via a rewrite to `/margo-runtime/*` because Next.js treats `_`-prefixed folders as private. |
| Sidecar (`margo serve`) | ✅ shipped | Standalone http server reusing the same handlers. Unlocks Angular, raw webpack, CRA, Vue CLI, SvelteKit-non-Vite, anything that proxies. Wires via `proxyConfig` + a one-line `<script src="/__margo/bootstrap.js">`. |
| Identity setup prompt | ✅ shipped | Boot-time modal when `git config user.name` / `user.email` missing; persists via `git config --global` so a one-time setup carries everywhere. |
| Init / install-skill / update / uninstall CLI | ✅ shipped | idempotent; auto-patches `vite.config.*` and `next.config.*`; per-app `.margo/` in monorepos |
| Overlay: pin capture | ✅ shipped | selector + text + role + coords + viewContext (tab/dialog/region + active-state markers) |
| Overlay: gap + box anchors | ✅ shipped | paired-element gap (the space between two elements) and box selection in addition to point pins |
| Overlay: pin resolver | ✅ shipped | priority: text+role → selector → coords → viewContext-aware → orphan |
| Overlay: SPA route tracker | ✅ shipped | patches `pushState`/`replaceState`, listens to `popstate` |
| Overlay: SSE sync client | ✅ shipped | snapshot + delta refetch |
| Overlay UI | ✅ shipped | grid-based inbox panel (scroll fix), letter-avatar list, reply UX, status changes, filter chips (Open/All/Mine/This page), search, bulk-resolve, orphan popup beside inbox, outside-click close, FABs above all panels, pin tracking during scroll |
| Overlay bundle for browser | ✅ shipped | esbuild → `dist/overlay.bundle.js`, served by all three adapters |
| Conflict-resolution UI | ⬜ TODO | overlay banner when `git pull --rebase` fails; endpoints throw but the overlay still lacks a recovery affordance |
| Tests | ⬜ partial | no vitest specs; Playwright probes (`scripts/verify-demo.mjs`, `demo-nextjs/scripts/debug-inbox-scroll.mjs`) exist as smoke/regression checks |

## Package layout

```
margo-dev/
├── package.json                 # bin: { "margo": "./dist/install/cli.js" }
├── src/
│   ├── plugin/
│   │   ├── vite.ts              # Vite plugin (configureServer + transformIndexHtml)
│   │   ├── next.ts              # re-exports handlers + <MargoScript /> + withMargo
│   │   ├── next-server.ts       # Web-Fetch Route Handler (chokidar, poller, overlay-serve)
│   │   ├── next-config.ts       # withMargo() wrapper for next.config.*
│   │   └── next-client-script.ts # <MargoScript /> — separate export so Next bundles it, not externalizes
│   ├── server/
│   │   ├── handlers.ts          # transport-agnostic business logic (getMe/setMe/list/create/update/delete/sync/git-state)
│   │   ├── endpoints.ts         # Node http adapter (used by Vite plugin AND the serve sidecar)
│   │   ├── git.ts               # local git CLI wrapper (getAuthor / setAuthor / commitAndPush / pull / fetch / dirty-state)
│   │   ├── watcher.ts           # chokidar → SSE event emitter
│   │   └── remote-poller.ts     # background `git fetch` + incoming-changes diff
│   ├── overlay/
│   │   ├── inject.ts            # ~3.4k lines, vanilla DOM — the entire overlay UI
│   │   ├── pin.ts               # capture target (selector + text + role + coords + gap/text anchors)
│   │   ├── resolver.ts          # text+role → selector → coords → orphan priority
│   │   ├── route-tracker.ts     # patches pushState/replaceState
│   │   └── sync.ts              # SSE client + REST wrappers (getMe/setMe/syncFromRemote/getGitState)
│   ├── cli/
│   │   └── serve.ts             # `margo serve` sidecar — http server + chokidar + poller
│   ├── install/
│   │   └── cli.ts               # `margo <init|install-skill|update|uninstall|serve>` entry
│   ├── shared/
│   │   ├── types.ts             # Comment / CommentStatus / GitState / MargoConfig
│   │   ├── frontmatter.ts       # YAML parse/serialize, reply append
│   │   └── id.ts                # `c-` + 6 hex chars
│   └── templates/               # files copied into consuming projects on `init`
│       ├── CLAUDE.md
│       ├── claude-skill.md
│       └── config.json
└── scripts/copy-overlay.mjs     # esbuild step → dist/overlay.bundle.js
```

## Lifecycle decisions

- **Overlay refresh cadence**: SSE from the local server pushes any change to `.margo/comments/` (file watcher). A background `git fetch` (default 60s, configurable via `remotePollIntervalMs`) surfaces incoming-comments as a banner the user clicks to pull. No realtime infrastructure — polling at the git layer is enough.
- **Resolved comments stay in place**: file remains at `.margo/comments/<id>.md` with `status: resolved`. Preserves git blame, AI keeps it as context for related future comments, avoids rename-detection noise. Overlay filters resolved out by default.
- **Branch model**: comments live on whichever branch the commenter is on. Overlay surfaces the current branch and warns when commenting on a non-default branch. Default expectation is `main`.
- **Init reliability**: `npx margo init` is idempotent and explicit. No postinstall hook (package managers increasingly disable them). Patches `vite.config.*` / `next.config.*` via AST when possible, falls back to a clear "add this line" prompt if patching fails.
- **Root `CLAUDE.md` integration**: init writes a delimited block to root `CLAUDE.md`. Markers (`<!-- margo:start -->` / `<!-- margo:end -->`) make rewrite and uninstall safe.

## Deferred / out of scope

- **Native webpack / Rspack plugin.** Webpack-based frameworks (Angular, raw webpack-dev-server, Vue CLI, CRA) work today via the sidecar + proxy. A first-class plugin would be a UX nicety, not a correctness requirement.
- **Conflict-resolution UI.** Server already retries push-after-rebase; the overlay lacks a "review and choose" affordance when a real conflict surfaces. Rare in practice (one file per comment, append-only replies).
- **Screenshot-based pin recovery.** Anchor cascade is selector → text → role → coords → viewContext. Adding screenshots would bloat files or require external storage; revisit if anchor failures matter in practice.
- **OAuth-based write path for preview deploys.** Preview mode is read-only.
- **Self-hostable mediator service.**
- **Real-time multiplayer cursors / live presence.**
- **Search across closed/resolved inboxes; cross-repo workspaces.**
- **AI auto-running on every comment without `/margo` invocation.** Intentional — humans must invoke.
- **Mobile / React Native commenting surface.**
