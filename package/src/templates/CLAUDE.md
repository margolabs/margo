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
- `status: resolved`, `status: wontfix` → **do not process or modify code in response**. You may read these for historical context (e.g., to avoid re-proposing something the team already declined), but never re-open them or treat them as actionable. The `wontfix` status is what the UI calls "Dismiss" — an explicit "we considered this and aren't going to act on it." Reversible via Reopen if the team changes its mind.
- Never set `status: resolved`. Only humans do that. Your terminal states are `ready-for-review` and `blocked`.
- When you change code that affects a pinned element, update the comment's `target` fields in the same edit so the pin still resolves.
- Commit message convention: `margo: <description>` for any commit that touches `.margo/`.

For the full processing protocol see `.claude/skills/margo.md`.

## Writing margo-friendly UI

The margo overlay pins comments to specific DOM elements and re-resolves them on every render. Stable, semantic markup makes pins survive refactors and routes them to the right view state when the URL doesn't change between views (tabs, wizards, modals, accordions). When you generate or modify UI in this repo, prefer the patterns below — they're standard accessibility practice and they make change-tracking more robust as a side benefit.

### Tabs, wizards, accordions, modals — anything that swaps content under a stable URL

Tag the active view so margo can tell tab/step/state apart from the others:

- **Tabs:** use `role="tabpanel"` on each panel and `aria-labelledby="<tab-button-id>"` pointing at the tab label. Headless UI's Tab and Radix Tabs already do this; if you're hand-rolling, mirror their structure.
- **Wizards / steppers:** set `aria-current="step"` on the active step element. Give each step a heading (`<h2>Step 2: Payment</h2>`).
- **Accordions:** use `aria-expanded="true"` on the open panel's trigger; pair with `role="region"` and an `aria-labelledby` reference for the panel.
- **Modals / dialogs:** prefer the native `<dialog>` element, or `role="dialog"` with `aria-labelledby` pointing at the title. Either works.
- **Component libraries that emit `data-state="open"` / `data-state="active"`** (Radix, shadcn): keep them. Margo treats them as view-state signals automatically.

Without one of these, two tabs that share a structural shape (`main > section > article:nth-of-type(3)`) and a short label (`Custom`, `Submit`) are indistinguishable from margo's perspective, and a pin made on one will appear on the other.

### Selectors that survive change

The pin capture builds a short CSS path back from the clicked element. It anchors at the first ancestor `id`, falls back to `data-testid`, then `[role="…"]`, and only uses `:nth-of-type(n)` as a last resort.

- **Add `data-testid` to interactive containers** when you create them. Stable across copy edits and class-name churn.
- **Don't reuse the same short label without context.** A page with five `<button>Save</button>` and no surrounding heading is hard to anchor to. A nearby `<h2>` and/or a `data-testid` fixes it.
- **Prefer semantic headings (`h1`–`h6`)** over styled `<div>`s above each major region. Margo's last-resort view signature uses the nearest preceding heading text.

### What NOT to change for margo's sake

These would be over-engineering:

- Adding `role="tabpanel"` to elements that aren't actually tab panels.
- Adding `id` attributes to every container "just in case".
- Refactoring stable, working markup to be more semantic with no other motivation.

Margo's resolver tolerates messy markup; it only needs better signals when the URL stays the same across multiple views. Reach for these patterns when you're already touching that code, or when you notice a pin landing on the wrong element.

