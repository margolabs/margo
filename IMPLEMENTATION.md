# margo v0 — implementation plan

## Build status

The `package/` directory contains a working scaffold of `margo-dev`. The skeleton compiles, the architecture is wired, and the API surface matches the spec. Remaining work to reach a runnable demo is real but bounded:

| Area | Status | Notes |
| --- | --- | --- |
| Shared types + frontmatter parser | ✅ written | YAML round-trip; reply append helper |
| Comment ID generation | ✅ written | 6-hex-char IDs via `crypto.randomBytes` |
| Local server endpoints | ✅ written | POST/PATCH/GET/SSE/sync, no auth (localhost) |
| Git CLI wrapper | ✅ written | shell-out, host-agnostic |
| FS watcher | ✅ written | chokidar over `.margo/comments/*.md` |
| Vite plugin entry | ✅ written | mounts middleware, injects bootstrap, dev-only |
| Init / update / uninstall CLI | ✅ written | idempotent; auto-patches `vite.config.*` |
| Overlay: pin capture | ✅ written | hybrid anchor — selector + text + role + coords |
| Overlay: pin resolver | ✅ written | priority order: text+role → selector → coords → orphan |
| Overlay: SPA route tracker | ✅ written | patches `pushState`/`replaceState` |
| Overlay: sync client (SSE) | ✅ written | snapshot + delta refetch |
| Overlay: minimal UI | ✅ written | launcher button, pin dots, comment panel; vanilla DOM |
| Overlay: bundle for browser | ⬜ stub | currently copies sources; needs esbuild step |
| Reply / status-change UX (in panel) | ⬜ stub | actions row exists; click handlers TODO |
| Conflict-resolution UI | ⬜ TODO | overlay banner when `git pull --rebase` fails |
| Tests | ⬜ TODO | vitest configured; no specs yet |
| Next.js plugin | ✅ written | App Router Route Handler + `<MargoScript />`; init CLI patches `next.config.*` and `app/layout.tsx`. Public URL stays `/__margo/*` via a rewrite to `/margo-runtime/*` because Next.js treats `_`-prefixed folders as private. |

The big remaining lift is bundling the overlay (~1 day with esbuild) and wiring the panel actions to the PATCH endpoint (~1 day). Everything else is scaffolded.

## Package: `margo-dev`

Single npm package, dev dependency only. Targets Vite first; Next.js plugin in v0.1.

```
margo-dev/
├── package.json
├── README.md
├── src/
│   ├── plugin/
│   │   └── vite.ts            # Vite plugin entry — exports default
│   ├── server/
│   │   ├── endpoints.ts       # /__margo/comment, /__margo/list, /__margo/status
│   │   └── git.ts             # local git CLI wrapper (add/commit/pull/push)
│   ├── overlay/
│   │   ├── inject.ts          # injected into the app via the plugin
│   │   ├── pin.ts             # capture target (selector + text + role + coords + crop)
│   │   ├── ui.tsx             # the comment-pin UI itself
│   │   └── sync.ts            # fs-watch + periodic git pull, hot-update overlay state
│   ├── install/
│   │   ├── postinstall.ts     # drops .margo/ scaffold and .claude/skills/margo.md
│   │   └── templates/         # ships the canonical CLAUDE.md, config.json, skill
│   └── shared/
│       └── frontmatter.ts     # YAML parse/serialize for comment files
```

## v0 build order

1. **Comment file format + frontmatter parser** (`shared/frontmatter.ts`). Trivial. Lock the schema in code; it must match the README example exactly.
2. **Local server endpoints** (`server/endpoints.ts`). POST `/__margo/comment` writes a file; GET `/__margo/list` returns the inbox. Mounted by the Vite plugin in dev. No auth (local-only).
3. **Git wrapper** (`server/git.ts`). `add` + `commit` (with `margo:` prefix) + `pull --rebase` + `push`. Shells out to local `git`. Honor `.margo/config.json` flags.
4. **Vite plugin** (`plugin/vite.ts`). Mounts the server endpoints in dev mode; injects the overlay script tag into served HTML; activates on preview deploys when `MARGO_ENABLED=1`.
5. **Init CLI** (`install/cli.ts`). Exposed as `npx margo-dev init` (NOT a postinstall hook — those are increasingly disabled). Idempotent. Drops `.margo/config.json`, `.margo/CLAUDE.md`, `.margo/comments/.gitkeep`, `.claude/skills/margo.md`, appends a `<!-- margo:start --> ... <!-- margo:end -->` block to root `CLAUDE.md` (creating it if missing), and patches `vite.config.*` to add the plugin import + entry. Other CLI subcommands: `update`, `uninstall`.
6. **Overlay UI** (`overlay/`). Pin-and-comment UI. Captures the hybrid anchor on click. POSTs to `/__margo/comment`. Subscribes to SSE for live updates. **Read-only mode** when running on a preview deploy — composer disabled, pins still render, replies and status changes blocked. **SPA route tracking**: patches `pushState` / `replaceState` and listens for `popstate` so `target.url` reflects client-side route changes.
7. **Sync loop** (`overlay/sync.ts` + `server/sync.ts`). On focus / on visibility / every 30s: server-side triggers `git pull --rebase`, then SSE-pushes any new comment files to all connected overlays.

## Lifecycle decisions

- **Overlay refresh cadence**: SSE from the local server pushes any change to `.margo/comments/` (file watcher). Plus a periodic `git pull --rebase` (default 30s, configurable) so remote comments arrive without manual pull. No fancy realtime infra — just polling at the git layer.
- **Resolved comments stay in place**: file remains at `.margo/comments/<id>.md` with `status: resolved`. Preserves git blame, AI keeps it as context for related future comments, avoids rename-detection noise. Overlay filters resolved out by default.
- **Branch model**: comments live on whichever branch the commenter is on. Overlay surfaces the current branch and warns when commenting on a non-default branch. Default expectation is `main`.
- **Init reliability**: `npx margo-dev init` is idempotent and explicit. No postinstall hook. Patches `vite.config.*` via AST when possible, falls back to a clear "add this line" prompt if patching fails.
- **Root `CLAUDE.md` integration**: init writes a delimited block to root `CLAUDE.md`. Markers (`<!-- margo:start -->` / `<!-- margo:end -->`) make rewrite and uninstall safe.

## Out of scope for v0

- Webpack / generic middleware (v0.2)
- React Native / mobile (later)
- OAuth-based write path for preview deploys (v1)
- Self-hostable mediator service (v1)
- AI auto-running on every comment without `/margo` invocation (intentional — humans must invoke)
- Real-time multiplayer cursors / live presence
- Search across closed/resolved inboxes
- Threading beyond linear replies

## v0 success criteria

The demo script (`templates/demo-script.md`) runs end-to-end on a fresh `npm create vite@latest` project, with three machines (or three browser profiles) acting as the three roles, no manual git steps from anyone, in under 60 seconds of wall-clock time.

## v0 build estimate

- Package scaffold + plugin + server + git wrapper + frontmatter: **~1 week** for a senior dev.
- Overlay UI (pin capture, comment composer, list view): **~1.5 weeks**.
- Postinstall + skill drop + CLAUDE.md: **~2 days**.
- Demo polish + first-run flow: **~3 days**.

Total: **~3 weeks** to a real demo.
