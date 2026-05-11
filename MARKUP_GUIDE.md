# Writing margo-friendly UI

margo pins comments to specific DOM elements and re-resolves them on every render. The pin survives most everyday changes — paraphrased copy, renamed buttons, restructured sections — through a multi-signal resolver (selector → text → role → coords + an optional view-state signature).

You don't need to do anything special for margo to work. This guide lists patterns that make pins **more robust** in tricky cases — tabs, wizards, modals, accordions — where the URL stays the same while the visible content changes. They're standard accessibility practice; the change-tracking improvement is a side benefit.

## When this matters

If your app has any of these patterns and you've seen comment pins appear on the wrong element after a tab switch / step change, the guidance below addresses it directly:

- **Tabs** that swap content without changing the URL
- **Multi-step wizards / checkouts** where each step is mounted in turn
- **Accordions** with one panel expanded at a time
- **Modals / dialogs** opened over a page that's still considered "the same URL"
- **Toggle views** like card-vs-list, light-vs-dark previews
- Anything else where the user sees clearly different content but the address bar stays put

## What margo captures at pin time

When you (or a teammate) drop a pin, margo records:

| Signal | Source |
|---|---|
| `selector` | Short CSS path from the element, anchored at the first ancestor with an `id` or `data-testid` |
| `text` | Visible text content of the container (capped at 120 chars) |
| `role` | ARIA role or tag name |
| `coords` + `viewport` | Click position scaled by viewport size, for layout-shift recovery |
| `textAnchor` | The exact phrase if you drag-selected text |
| `viewContext` | Closest `role="tabpanel"` / `role="dialog"` / `role="region"`, plus any active-state markers (`aria-current`, `aria-selected`, `aria-expanded`, `aria-pressed`, `data-state`, `data-step`), plus the nearest preceding heading |

At resolve time, the resolver walks this cascade until it finds a match. If `viewContext` is captured, candidates must reproduce it — otherwise the comment is treated as "hidden behind the wrong view" and the pin is suppressed (without orphaning) until the user navigates back to the matching state.

## Patterns that make pins robust

### Tabs

Use proper ARIA. Headless UI's Tab and Radix Tabs already emit this; if you're hand-rolling, match the structure.

```html
<div role="tablist">
  <button id="tab-plans" role="tab" aria-selected="true">Plans</button>
  <button id="tab-features" role="tab" aria-selected="false">Features</button>
</div>
<div role="tabpanel" id="panel-plans" aria-labelledby="tab-plans">
  ...
</div>
<div role="tabpanel" id="panel-features" aria-labelledby="tab-features" hidden>
  ...
</div>
```

Why it helps: margo captures `panel.label = "Plans"` on pins made in the Plans panel, and won't dot a similar-looking container in the Features panel when the user switches.

### Wizards / steppers

```html
<ol class="steps">
  <li><h2>Step 1: Account</h2>...</li>
  <li aria-current="step">
    <h2>Step 2: Payment</h2>
    <fieldset>...</fieldset>
  </li>
  <li><h2>Step 3: Review</h2>...</li>
</ol>
```

Why it helps: `aria-current="step"` plus the step heading gives margo a stable "this comment was on step 2" signal even if the wizard re-mounts each step in the same DOM slot.

### Accordions

```html
<details open>
  <summary>Billing</summary>
  <div role="region" aria-labelledby="billing-summary">...</div>
</details>
```

Or with custom components, use `aria-expanded="true"` on the trigger and `role="region"` on the panel.

### Modals / dialogs

Prefer the native `<dialog>` element:

```html
<dialog open aria-labelledby="confirm-title">
  <h2 id="confirm-title">Delete project</h2>
  ...
</dialog>
```

Or `role="dialog"` with `aria-labelledby` pointing at the title.

### Selectors that survive refactors

The pin's `selector` is built back from the clicked element. It prefers, in order: `#id`, `[data-testid="…"]`, `[role="…"]`, then `:nth-of-type(n)` as a last resort.

- **Add `data-testid` to interactive containers when you create them.** Stable across copy edits, class-name churn, and tag swaps.
- **Don't reuse the same short label without context.** A page with five `<button>Save</button>` and no surrounding headings makes anchoring hard — and not just for margo. A nearby `<h2>` plus a `data-testid` fixes it.
- **Prefer semantic headings (`h1`–`h6`)** over styled `<div>`s above each major region. Margo's last-resort view signature uses the nearest preceding heading text, and that text tends to be the most stable identifier on the page.

## What NOT to change for margo's sake

The resolver is designed to tolerate messy markup. Don't over-engineer:

- Don't add `role="tabpanel"` to elements that aren't actually tab panels.
- Don't sprinkle `id` attributes on every container "just in case".
- Don't refactor stable, working markup to be more semantic with no other motivation.

Reach for these patterns when you're already touching the code, or when you've seen a pin land on the wrong element. If a teammate flags a misanchored pin and you can't reproduce the bug after a tab switch / step change, that's the most common signal that view-state ARIA would help.

## For AI-coding teams

If you're using Claude Code (or a similar agent) to generate UI in a margo-equipped repo, the init CLI drops a `CLAUDE.md` into `.margo/` with this guidance condensed. The agent will pick it up automatically — no skill invocation needed. Pull requests generated against the guidance produce markup that anchors well by default.
