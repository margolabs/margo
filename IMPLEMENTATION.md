# margo — implementation status

Margo is published on npm as `margo-dev` and on Docker Hub as `margolabs/margo-host`. Two storage modes: **standalone** (solo, comments under `~/.margo/standalone/<id>/`, no host needed) and **server** (team, comments on a self-hostable host, plugin caches under `~/.margo/cache/<host>/<project>/`). Neither mode touches the project repo's git history — comments never leave `~/.margo/` on the user's machine.

## Build status

| Area | Status | Notes |
| --- | --- | --- |
| Shared types + frontmatter parser | ✅ shipped | YAML round-trip; reply append helper |
| Comment ID generation | ✅ shipped | 6-hex-char IDs via `crypto.randomBytes` |
| Transport abstraction | ✅ shipped | StandaloneTransport (files in `~/.margo/standalone/<id>/`) and RemoteTransport (HTTP against margo-host). Handlers don't care which backend. |
| Standalone mode | ✅ shipped | UUID-keyed workspace data dir under `~/.margo/standalone/<id>/comments/`. No git operations, no host required. |
| Server mode + auth | ✅ shipped | RemoteTransport against margo-host. Bearer-token auth via `~/.margo/credentials.json` (populated by `margo login`). Browser device-flow + paste-a-token paths both supported. |
| Offline-first sync (server mode) | ✅ shipped | RemoteTransport.write/remove fall through to a local outbox under `<cache>/.outbox/` when the host is unreachable. A 30s drainer retries; overlay shows a "syncing" banner via `/__margo/sync-status`. |
| Live mirror (server mode) | ✅ shipped | Plugin subscribes to host SSE and mirrors writes/deletes into the local cache so AI sees fresh state without a dev-server restart. |
| FS watcher (standalone mode) | ✅ shipped | chokidar over `~/.margo/standalone/<id>/comments/*.md` → SSE broadcast |
| Vite plugin | ✅ shipped | mounts middleware via `configureServer`, injects bootstrap; live mirror + outbox drainer both run from here |
| Next.js plugin (App Router) | ✅ shipped | catch-all Route Handler + `<MargoScript />` + `withMargo` config wrapper. Public URL stays `/__margo/*` via a rewrite to `/margo-runtime/*` because Next.js treats `_`-prefixed folders as private. |
| Sidecar (`margo serve`) | ✅ shipped | Standalone http server reusing the same handlers. Unlocks Angular, raw webpack, CRA, Vue CLI, SvelteKit-non-Vite, anything that proxies. Wires via `proxyConfig` + a one-line `<script src="/__margo/bootstrap.js">`. |
| Identity setup prompt | ✅ shipped | Standalone mode only — overlay prompts when `git config user.name`/`user.email` is missing, persists via `git config --global`. Server mode pulls identity from the bearer token, never needs the prompt. |
| Init / install-skill / update / uninstall CLI | ✅ shipped | `margo init` defaults to standalone mode, `--server URL --project SLUG` opts into server mode. Writes only `margo.config.json` at the repo root — no `.margo/` directory in the project tree. |
| margo login / logout | ✅ shipped | Device-flow browser auth + `--token` paste-path. Credentials at `~/.margo/credentials.json` (mode 0600). |
| margo host start | ✅ shipped | Solo-onboarding shortcut: prints the one-line Docker command to run a personal margo-host at localhost:7331. |
| Overlay: pin capture | ✅ shipped | selector + text + role + coords + viewContext (tab/dialog/region + active-state markers) |
| Overlay: gap + box anchors | ✅ shipped | paired-element gap (the space between two elements) and box selection in addition to point pins |
| Overlay: pin resolver | ✅ shipped | priority: text+role → selector → coords → viewContext-aware → orphan |
| Overlay: SPA route tracker | ✅ shipped | patches `pushState`/`replaceState`, listens to `popstate` |
| Overlay: SSE sync client | ✅ shipped | snapshot + delta refetch |
| Overlay UI | ✅ shipped | grid-based inbox panel, letter-avatar list, reply UX, status changes, filter chips, search, bulk-resolve, FAB with account popover, sign-in pill (server mode without credentials), syncing banner (offline outbox) |
| Overlay bundle for browser | ✅ shipped | esbuild → `dist/overlay.bundle.js`, served by all three adapters |
| Conflict-resolution UI (outbox drain) | ⬜ TODO | When drain hits 412/409 on retry, entry stays in outbox and gets logged; overlay shows the stuck count but no recovery affordance yet. |
| margo-host (server-mode backend) | ✅ shipped | Docker image at `margolabs/margo-host`. Self-hostable; first signup at `/setup` claims superuser. Per-project member roster + ACLs. CLI device-login endpoints. |
| Tests | ✅ vitest | 65 specs across handlers/storage/overlay/install paths; offline-first smoke covered via manual probe (host stop/start cycle). |

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
