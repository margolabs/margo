# margo

*Feedback in the margins. AI does the work.*

> v0 spec is complete. A working scaffold of `margo-dev` lives in [package/](./package/). Build status is tracked in [IMPLEMENTATION.md](./IMPLEMENTATION.md).

## The pitch

A shared annotation layer that sits on top of the **live running app**, where humans (designers, devs, PMs, anyone) only leave comments — and AI agents read those comments as live context and execute the work. Every pinned comment is a brief. AI either resolves it, asks clarification, or pushes back with a blocker.

## The inversion

Today, the ticket-to-code path is a human bottleneck: a PM writes a Linear ticket, an engineer interprets it, the engineer codes. margo collapses that — humans become pure directors, AI is the sole implementer. Non-engineers stop being stakeholders waiting on a queue and become real contributors.

## How it works (sketch)

1. A developer asks Claude Code: `add margo to this project`. Claude installs `margo-dev` as a dev dependency, wires it into the build config (Vite / Next.js plugin), and creates `.margo/` in the repo with a config file.
2. Every team member who wants to comment clones the repo and runs `npm run dev` themselves. The dev server boots with the margo overlay automatically active.
3. A commenter clicks an element in the running UI, types a comment, hits enter. The overlay POSTs to a tiny local endpoint (`/__margo/comment`) exposed by the dev plugin.
4. The plugin writes the comment as a file under `.margo/comments/<id>.md`, then runs local `git` to auto-commit (`margo: comment by jane on /pricing`) and auto-push to the repo's existing remote.
5. Teammates `git pull` → their local plugin sees the new file → renders the pin back into their overlay.
6. Claude Code reads `.margo/comments/*.md` as part of normal repo context. AI works through the inbox: resolves, replies, or flags blockers — by editing the same comment files.
7. Humans review, reply, or mark resolved — also by editing the comment files (typically through the same overlay UI).

## Comment file format

Each comment is one file at `.margo/comments/<id>.md`. YAML frontmatter captures the pin and status; markdown body is the comment text and reply thread.

```yaml
---
id: c-7f3a91
type: task                    # task | discussion | question
author: jane@team.com
role: pm
branch: main
created: 2026-05-08T14:22:01Z
status: open                  # open | in-progress | ready-for-review | blocked | resolved | wontfix
target:
  url: /pricing
  selector: 'button[data-testid="cta-primary"]'
  text: "Start free trial"
  role: button
  viewport: { w: 1440, h: 900 }
  coords: { x: 712, y: 384 }
---

CTA should be green, not blue. Add a hover animation.

---
**reply** — alex@team.com (designer) — 2026-05-08T14:31:00Z

Agreed on green. For the hover, can we use the standard token rather than a new one?
```

## Core principles

- **Humans never code.** They only annotate.
- **AI is a first-class participant** in the shared layer — reads *and* writes.
- **Anchored to the live app, not to code or static artifacts.** Comments pin to the running UI — what users actually see — not to `file.ts:42`, not to a Figma frame, not to a PNG.
- **Git-native storage.** Comments live as files in the repo (`.margo/comments/*.md`), synced by `git pull/push`. No SaaS backend, no separate user system, no realtime infra. The premise: every role on the team — PM, designer, dev — already runs an AI coding tool against the repo, so the repo *is* the shared workspace.
- **Single-user value on day one.** A solo founder with one local app and a Claude Code session should get value before any second user joins.

## Decided

- **First user: small product team.** Implies role hints (PM / designer / dev) for AI inbox triage. Real-time multiplayer is *not* required for v0 — git sync is the propagation mechanism.
- **Attach mechanism: dev-time package** (Vite / Next.js plugin). Installed as a dev dependency by Claude Code itself (`npm install -D margo-dev` + plugin wired into the build config). Overlay activates automatically when the dev server launches. Production builds do not include it.
  - Distribution piggybacks on Claude Code: `claude "add margo to this project"` is the entire onboarding. The AI tool the team already uses *is* the install flow.
  - SDK rejected as too heavy on dev setup. Browser extension rejected because per-commenter install is unnecessary friction when the same package can serve everyone via the dev server.
- **Reach for non-dev teammates: same package activates on staging / preview deploys** (Vercel previews, Netlify deploys, etc.) when a margo env var is set. Covers the "designer reviewing a preview URL" case without building a tunnel for v0.
- **Storage model: comments are files in the repo** under `.margo/comments/*.md` — markdown body + YAML frontmatter for target / author / status. Synced by `git pull/push`. No backend database. Premise: every role on the team is already AI-coding, so the repo is already the shared workspace.
- **Git-host-agnostic by design.** GitHub, GitLab.com, self-hosted GitLab, Bitbucket, Forgejo, Gitea — must all work without per-host integration code. This rules out OAuth-against-a-specific-vendor as a default write path.
- **Write path: local-only, auto-commit-and-push.** Every commenter runs `npm run dev` against their local clone. The plugin POST-receives the comment, writes the file under `.margo/comments/`, then runs local `git` CLI to add / commit (with a `margo:` prefix on the message) / push to whatever remote the repo points at. Naturally host-agnostic. Preview deploys are read-only viewers in v0.
- **Author identity: local `git config user.name / user.email`.** No separate login or auth system. Role hint (PM / designer / dev) comes from the workspace config in `.margo/config.json`.
- **Trigger model: implicit-by-default.** Every new comment has `type: task` in its frontmatter, meaning AI treats it as an instruction. Two opt-outs: `type: discussion` (humans only — AI ignores) and `type: question` (AI answers in-thread but doesn't modify code). `@ai` mentions are allowed but cosmetic — they bump priority, not semantics.
- **AI discoverability: project-level Claude Code skill.** The `margo-dev` package drops a skill at `.claude/skills/margo.md` on install, giving the dev a `/margo` command that lists and works through the open inbox. AI consumes comments via normal repo-file reads — no MCP server, no magic context injection.
- **AI reply protocol.** When AI processes a `type: task` comment, it appends a reply (`**ai-reply** — claude-opus-4-7 — <ts>`) to the same file and updates `status` to one of: `ready-for-review` (confident fix landed), `blocked` (with reason), or leaves `open` (clarification asked). Humans mark `resolved` after review.
- **Pin anchoring: hybrid, captured-at-comment-time.** The plugin captures the following when a comment is pinned: CSS selector (best-effort), full text content of the element, ARIA role + label, and viewport-relative coords. At view time, the overlay resolves the pin in priority order: text + role match → selector → coords (with a "may have moved" indicator) → orphaned (still listed in `/margo` inbox, not rendered as a pin). When AI modifies code that affects a pinned element, AI is responsible for updating the comment's anchor fields in the same edit. (Screenshot-based recovery deferred to v0.1.)
- **Conflict handling.** One file per comment (UUID filename) eliminates 99% of conflict cases. Plugin auto-pulls before pushing and retries on remote-update rejection. Status changes use last-writer-wins, with the more-advanced status winning ties (`resolved` > `ready-for-review` > `in-progress` > `open`). Replies are append-only with timestamps, so concurrent replies merge cleanly. Real conflicts (rare) surface in the overlay UI with a "review and choose" prompt.
- **Refresh cadence.** Local fs watch via SSE pushes overlay updates instantly when a file in `.margo/comments/` changes. A background `git pull --rebase` runs every 30s (configurable) so remote comments arrive without manual pull. No realtime infrastructure — polling at the git layer is enough.
- **Resolved comments stay in place** at `.margo/comments/<id>.md` with `status: resolved`. They are *not* moved to a subfolder. Reasons: preserves git blame, AI keeps them as context for related future comments, avoids rename-detection noise. Overlay filters `resolved` out by default; users toggle "show resolved" to see them.

## Sanity-check addenda

After the v0 spec was assembled, a critical pass surfaced these refinements (all locked in):

- **Branch model: comments live on whichever branch the commenter is on.** Natural git semantics — when branches merge, comments merge. The default expectation: PMs and designers run `npm run dev` from `main` (or the team's default branch), giving feedback on the latest stable code. To comment on in-progress work, a non-dev explicitly checks out the dev's feature branch (`git checkout feature/x`). The overlay surfaces the current branch and warns when commenting on a non-default branch.
- **Screenshots are skipped in v0.** Anchor recovery uses text + role + selector + viewport coords only. Inline base64 bloats files and external storage adds infrastructure. Add screenshot-based recovery in v0.1 if anchor failures turn out to matter in practice.
- **Onboarding uses an explicit CLI command, not a postinstall hook.** Postinstall hooks are increasingly disabled by package managers (npm `--ignore-scripts`, pnpm allow-list). Claude runs `npx margo-dev init` explicitly during the "add margo" flow. Idempotent: safe to re-run.
- **Root `CLAUDE.md` reference is added on install.** A subdirectory `.margo/CLAUDE.md` is not always auto-loaded by Claude Code in every session. The init command appends a delimited block to the project's root `CLAUDE.md` (creating it if missing):

  ```
  <!-- margo:start -->
  This project uses margo for live-app feedback. See .margo/CLAUDE.md
  for how AI should engage with the comment inbox.
  <!-- margo:end -->
  ```

  The block is rewritten in place on `margo update`; removed cleanly on `margo uninstall`.
- **Preview-mode overlay is read-only.** When the package activates on a preview deploy, the composer UI is disabled — the running browser cannot reach the dev's local git. Pins still render; the inbox is visible; status changes and replies are blocked. Live previewers are explicitly told "you're viewing — to comment, run `npm run dev` locally."
- **Single-page-app routing**: the overlay observes `popstate` and patches `pushState/replaceState` to track the current URL across client-side route changes, so `target.url` always reflects what the user is actually looking at.

## Items intentionally deferred

- Next.js plugin (Vite first; Next.js in v0.1).
- Webpack / Rspack / generic middleware adapters.
- Mobile / React Native commenting surface.
- OAuth-based write path for preview deploys (v1).
- Self-hostable mediator service (v1).
- Real-time multiplayer cursors / presence.
- Search across resolved inboxes; cross-repo workspaces.

## Non-goals

- **Not a code-review tool.** Comments anchored to `file:line` are out of scope — that direction was rejected as having no future for this product.
- **Not a static-artifact feedback tool.** No commenting on PNGs, Figma frames, or PDFs. margo only overlays on the live running app.
- **Not an IDE plugin.** The commenting surface is the running app, not VS Code. Non-engineers don't live in IDEs, and that's the whole point of letting them participate.
- **Not a browser extension.** Per-commenter installs are friction we don't need; the dev-time package covers everyone via the dev server / preview deploy.
- **Not a production analytics or feedback widget.** margo runs in dev and on previews, not in production. Production user feedback is a different product.
- **Not a Figma replacement.** margo sits *on top of* the app; it does not author designs.
- **Not a SaaS for v0.** No central database, no margo-hosted user system. The git repo *is* the storage layer. A hosted offering can come later if it earns its keep.
