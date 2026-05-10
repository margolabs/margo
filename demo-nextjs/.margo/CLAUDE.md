# margo notes for Claude Code

This repo uses **margo** — a live-app feedback layer where teammates pin comments on the running UI. Comments live as markdown files in this directory.

## Where to look

- `.margo/comments/*.md` — one file per comment. YAML frontmatter holds the pin target, author, type, status. Markdown body is the comment + reply thread.
- `.margo/config.json` — workspace config (app URL mappings, role roster, behavior flags).

## When to engage

- **Proactively at session start**: count the open `type: task` comments under `.margo/comments/` and surface the count to the user (e.g., "3 open margo tasks in this repo — run `/margo` to triage"). Don't auto-process unless asked.
- **When the user asks `/margo`**: invoke the margo skill at `.claude/skills/margo.md` — it has the full workflow.
- **When the user asks about UI/UX work**: check the inbox first. There may already be a comment that constrains the change.

## Rules

- `type: task` → AI may modify code in response.
- `type: discussion` → humans only. Never modify code in response. You may read for context.
- `type: question` → answer in-thread. Do not modify code.
- Never set `status: resolved`. Only humans do that. Your terminal states are `ready-for-review` and `blocked`.
- When you change code that affects a pinned element, update the comment's `target` fields in the same edit so the pin still resolves.
- Commit message convention: `margo: <description>` for any commit that touches `.margo/`.

For the full processing protocol see `.claude/skills/margo.md`.
