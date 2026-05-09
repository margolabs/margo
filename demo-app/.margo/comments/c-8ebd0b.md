---
id: c-8ebd0b
type: task
author: demo@margo.local
role: designer
branch: main
created: '2026-05-09T08:41:02.673Z'
status: resolved
target:
  url: /
  selector: header:nth-of-type(1)
  text: Acme Pricing Features Contact
  role: header
  viewport:
    w: 1512
    h: 827
  coords:
    x: 756
    'y': 118
  gapAnchor:
    first:
      selector: header:nth-of-type(1)
      text: Acme Pricing Features Contact
      role: header
    second:
      selector: section#features
      text: >-
        Why teams pick Acme Acme cuts the boring parts of running a small team — billing, contracts, payroll — into one
        quiet...
      role: section
    axis: vertical
---


reduce spacing

---
**ai-reply** — claude-opus-4-7 — 2026-05-09T08:41:58.110Z

Reduced the gap by halving the `<main>` element's top padding from 48px to 24px (kept 48px bottom). The gap-anchor's two boundary elements (`<header>` and `<section#features>`) are unchanged, so the highlight will track the new tighter spacing automatically on next render.
