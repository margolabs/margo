# @margo/dev

Live-app feedback layer for AI-coding teams. Designers, PMs, and devs leave comments on the running app; AI works through them. Comments live as files in your repo, synced over git — no SaaS, no separate user system, no extension to install.

## Install

```sh
npm install -D @margo/dev
npx @margo/dev init
```

The `init` command:
- Scaffolds `.margo/` (config, CLAUDE.md, comments folder)
- Drops a `/margo` Claude Code skill at `.claude/skills/margo.md`
- Adds a margo block to your project's root `CLAUDE.md`
- Wires the Vite plugin into `vite.config.*`

The whole flow is what `claude "add margo to this project"` runs for you.

## How to comment

```sh
npm run dev
```

Open the app, click `+ pin` in the corner, click any element, type your comment.

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

## Design

See the project README and the IMPLEMENTATION plan in the parent repo for the full architectural rationale.

## Status

v0 scaffold. Vite-only. Read [IMPLEMENTATION.md](../IMPLEMENTATION.md) for the build plan.
