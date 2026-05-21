---
name: margo
description: Triage and resolve open comments left by the team on the live app. Use whenever the user wants to "work the margo inbox", "process margo comments", or asks `/margo` directly. Also surface the current inbox count proactively at the start of a session if there are unresolved tasks.
---

# margo — comment inbox

margo is a feedback layer where designers, PMs, and devs leave comments on the live app. Each comment is a file at `.margo/comments/<id>.md` with YAML frontmatter and a markdown body. Your job: process the open `type: task` comments, replying and updating status as you go.

## How to read the inbox

1. Read `.margo/comments/*.md` (one file per comment). Comments are anchored to a DOM element by default, but some are anchored to a captured network request instead — see **Request pins** below.
2. Filter: `status` ∈ {`open`, `in-progress`} AND `type: task`. Skip `resolved`, `wontfix`, `ready-for-review`, and `blocked` — those are terminal or already-acted-on states. `wontfix` is the "Dismiss" verdict and is reversible only by humans clicking Reopen; do not re-process it.
3. Sort by `created` ascending (oldest first), but bump anything with `@ai` in the body to the top.
4. Skip `type: discussion` (humans only — never modify code in response to these). For `type: question`, answer in-thread but do not modify code.

## How to process a single comment

For each `type: task` comment:

1. **Read the body and the target.** If `target.kind` is `'request'`, follow the **Request pins** flow below; otherwise the existing element-pin instructions apply. The `target` block tells you which page (`url`) and which element (`selector`, `text`, `role`, `coords`). If the selector doesn't resolve in the current code, fall back to text + role to locate the element. The `branch` field tells you which branch the comment was authored on — usually the same one you're on. (An element pin MAY also carry `target.relatedRequests` — recent network calls margo captured around the click. See **Related requests on element pins** below.)
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

## Request pins

When `target.kind` is `'request'`, the comment is anchored to a captured network call — not a DOM element. The `target.request` block has the shape:

```yaml
target:
  url: https://app.example.com/signup   # the page the user was on
  kind: request
  request:
    method: POST                        # GET, POST, PATCH, DELETE, …
    endpoint: https://api.example.com/api/subscribe
    status: 500                         # 0 for network errors
    statusText: Internal Server Error   # may be empty under HTTP/2
    duration: 142                       # ms; optional
    timestamp: '2026-05-21T03:14:00Z'   # ISO, when the request settled
```

(When `target.kind` is `'element'` or absent, treat it as the default element-pin variant — every existing element-pin instruction above still applies.)

How this changes the workflow:

1. **Detect at the top.** Branch on `target.kind === 'request'` before you start looking for an element. The element-pin steps assume a DOM target exists; for request pins it doesn't, and `target.selector` / `target.text` / `target.coords` are not meaningful even if present.
2. **The brief is the request.** Method + endpoint + status + the comment body are all you get. **Bodies are not captured** (privacy + comment-file size). If you need the request or response body to reason about the bug, reproduce the call yourself (curl / a test) or scan recent dev-server logs — don't ask the human for it as a first move.
3. **Server-side bug** (the handler is wrong): grep the server for the path segment of `target.request.endpoint` (e.g. `/api/subscribe`) — look for `app.<verb>('/api/subscribe')`, `router.<verb>(...)`, Next.js Route Handlers under the matching `app/api/.../route.ts`, NestJS controllers, etc. Find the handler, reason about why it produced that status, fix it. Status discipline is identical to element pins: `ready-for-review` after a confident code change, `blocked` if you can't reason about it.
4. **Client-side mistake** (the caller is wrong — e.g. "we shouldn't be hitting this endpoint from the SSO flow at all"): grep the *client* for the endpoint URL or its path segment, find the call site, and either fix the call or remove it. Same status discipline.
5. **Don't update the anchor.** Unlike element pins, request anchors don't get rewritten by code changes — the endpoint URL is stable across refactors of the handler or the caller. Skip step 4 of the element-pin flow for request pins; `target.request` stays as-is.
6. **Reply etiquette is unchanged**: append an `ai-reply` block with what you did or what's blocking you, and set `status` to `ready-for-review` or `blocked`. Never set `resolved` or `wontfix`.

## Related requests on element pins

When the user pins a DOM element (not a request), margo also attaches up to 5 recent fetch/XHR calls that fired in the ~3 seconds after their last click/submit. Stored as `target.relatedRequests: RequestAnchor[]` — same shape as the request-pin `target.request` block.

Treat this as causal evidence. If the comment says "this button is broken" and `relatedRequests` includes a `POST /api/subscribe → 500`, the failed call is almost certainly what "broken" means. Open the handler.

It's time-window correlation, not trace correlation — sometimes captures unrelated parallel calls (analytics, prefetch, autosave). If a related request looks unrelated to the comment ("/track/page-view" on a "make this button bigger" comment), ignore it.

Decision tree:

- Comment text gives clear UI intent + `relatedRequests` empty → treat as a pure UI fix.
- Comment text vague + `relatedRequests` has a failed call → start from the failing endpoint, not the DOM.
- Comment text vague + `relatedRequests` has only 2xx calls → ask in-thread what's wrong.

**Don't touch `target.relatedRequests` when you fix the code.** It's a historical record of what happened at pin time, not something to refresh. The element-pin anchor-update rule still applies: when your fix moves the element, update `target.selector` / `text` / `viewport` — but leave `target.relatedRequests` alone.

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
