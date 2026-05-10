# margo v0 demo script

The 60-second pitch flow. Three actors: **Sam** (dev), **Alex** (designer), **Jane** (PM). All three have the repo cloned and Claude Code installed.

## Setup (10 seconds, off-camera)

Sam runs once, in a fresh project:

```
$ claude "add margo to this project"
```

Under the hood, Claude runs `npm install -D margo-dev` then `npx margo-dev init`. The init step wires the Vite plugin, drops `.margo/config.json` and `.margo/CLAUDE.md` and `.claude/skills/margo.md`, appends a margo block to root `CLAUDE.md`, scaffolds an empty `.margo/comments/`, then commits and pushes.

Alex and Jane `git pull`. Done. (All on `main`.)

## Scene 1 — Alex pins a comment (15 seconds)

Alex runs `npm run dev`. The app opens at `localhost:3000`. The margo overlay is live in the corner.

Alex navigates to `/pricing`, clicks the "Start free trial" CTA, types:

> "This button should be green, not blue. Add a hover animation using the standard motion token."

Alex hits enter. Behind the scenes, the plugin writes `.margo/comments/c-7f3a91.md` and runs:

```
git add .margo
git commit -m "margo: comment by alex on /pricing"
git push
```

A pin appears on the button.

## Scene 2 — Sam processes the inbox (20 seconds)

Sam, on a different machine, opens Claude Code in the same repo:

```
$ claude
```

Claude loads `.margo/CLAUDE.md` automatically and surfaces:

> 1 open margo task in this repo — run `/margo` to triage.

Sam types:

```
/margo
```

Claude (via the margo skill) reads the comment, locates the CTA element, finds the design token reference for `motion.standard`, makes the change to the styled component, updates `status: ready-for-review`, appends an `**ai-reply**` block, commits with:

```
margo: ai-reply on c-7f3a91 (ready-for-review)
```

and pushes.

## Scene 3 — Alex confirms (15 seconds)

Alex's overlay (still running) detects the new comment file via fs watch + git pull. The pin glows: "ready for review."

Alex clicks the pin, sees the AI's reply, refreshes the page. The button is green. Hover works.

Alex clicks **resolved**. Plugin updates the file, commits:

```
margo: alex marked c-7f3a91 resolved
```

and pushes. Pin disappears from the overlay; comment file moves to `.margo/comments/resolved/` (or stays in place with `status: resolved`, TBD).

## What sold the demo

- **No tickets, no Slack handoff**. Alex went straight from "I see a problem" to "the AI is on it."
- **No SaaS to sign up for**. Three people with the repo and Claude Code → working multi-stakeholder feedback loop.
- **No code from non-devs**. Jane and Alex didn't touch a line of git or a line of source.
- **AI cited the comment in the commit history**. The audit trail is git, not a vendor.

## What v0 must demonstrate live

1. The Vite plugin overlay (clicking, pinning, typing).
2. The auto-commit-and-push from a comment.
3. Claude Code reading the comment file and acting on it.
4. The reply syncing back to the original commenter's overlay.
5. Status transitions (`open` → `ready-for-review` → `resolved`) showing in the overlay UI.

Anything more (Next.js plugin, conflict UI, polished theming, the orphaned-pin handler) can wait for v0.1.
