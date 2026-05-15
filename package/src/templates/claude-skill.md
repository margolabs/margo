---
name: margo
description: Triage and resolve open comments left by the team on the live app. Use whenever the user wants to "work the margo inbox", "process margo comments", or asks `/margo` directly. Also surface the current inbox count proactively at the start of a session if there are unresolved tasks.
---

# margo — comment inbox

margo is a feedback layer where designers, PMs, and devs leave comments on the live app. Each comment is a file at `.margo/comments/<id>.md` with YAML frontmatter and a markdown body. Your job: process the open `type: task` comments, replying and updating status as you go.

## How to read the inbox

1. Read `.margo/comments/*.md` (one file per comment).
2. Filter: `status` ∈ {`open`, `in-progress`} AND `type: task`. Skip `resolved`, `wontfix`, `ready-for-review`, and `blocked` — those are terminal or already-acted-on states. `wontfix` is the "Dismiss" verdict and is reversible only by humans clicking Reopen; do not re-process it.
3. Sort by `created` ascending (oldest first), but bump anything with `@ai` in the body to the top.
4. Skip `type: discussion` (humans only — never modify code in response to these). For `type: question`, answer in-thread but do not modify code.

## How to process a single comment

For each `type: task` comment:

1. **Read the body and the target.** The `target` block tells you which page (`url`) and which element (`selector`, `text`, `role`, `coords`). If the selector doesn't resolve in the current code, fall back to text + role to locate the element. The `branch` field tells you which branch the comment was authored on — usually the same one you're on.
2. **Decide if you can act.**
   - If the request is concrete and you have enough context: make the code change.
   - If the request is ambiguous or contradicts another comment / spec: ask in-thread, do not change code yet.
   - If the request is technically infeasible or you genuinely disagree: explain in-thread, do not change code.
3. **Update the comment file** in the same edit pass:
   - Append a reply block at the end of the file:
     ```
     ---
     **ai-reply** — claude-opus-4-7 — 2026-05-08T15:02:11Z

     <what you did, or what you need clarified, or why you can't do it>
     ```
   - Update `status` in the frontmatter:
     - `ready-for-review` — you made a confident code change
     - `blocked` — you can't proceed (include the reason in the reply)
     - leave `open` — you asked for clarification
4. **Update the anchor if you moved the element.** If your code change modified the element a comment is pinned to (renamed a class, changed text, restructured the DOM), update the `target` fields (`selector`, `text`, `viewport`) so the pin still resolves on next view. Do this in the same edit.
5. **Never mark `resolved` or `wontfix` yourself.** Both are human-only verdicts (`resolved` = "done, approved"; `wontfix` = "Dismiss — we considered this and decided against it"). Your terminal states are `ready-for-review` or `blocked`.

## How to commit

The margo dev plugin auto-commits and pushes comment files when humans pin them. When *you* edit a comment file (reply, status change, anchor update), commit with the same `margo:` prefix so the history reads consistently:

```
margo: ai-reply on c-7f3a91 (ready-for-review)
margo: ai-reply on c-7f3a91 (blocked: missing design token)
```

Group code changes and the corresponding comment update in the same commit when possible, so reviewers can trace "this code change resolved this comment."

## Edge cases

- **Multiple comments touch the same code.** Process them together if the fixes are related; reply to each individually.
- **A comment references something outside the codebase** (a Figma file, a Linear ticket, an asset that doesn't exist yet): mark `blocked`, explain what's missing.
- **A comment is clearly a bug report** but the requester doesn't have the technical context to know the fix is non-trivial: act on it if reasonable, but flag the scope in your reply ("this required changes in 4 files; let me know if you want me to revert").
- **You can't find the target element.** Reply explaining what you searched for; do not guess. Mark `blocked`.

## Don't

- Don't process `type: discussion` comments — humans only.
- Don't process `status: resolved` or `status: wontfix` comments. You may *read* them for historical context (e.g. to avoid re-proposing something the team declined), but never act on them.
- Don't mark `resolved` or `wontfix` yourself. Both are human-only verdicts.
- Don't bulk-process more than ~5 comments without surfacing a summary; the human running you should see what you're doing.
- Don't push to a branch other than what the dev is currently on, unless the dev tells you otherwise.
