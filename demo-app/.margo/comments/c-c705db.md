---
id: c-c705db
type: task
author: sxhuan@gmail.com
authorName: Stanley Song
branch: main
created: '2026-05-09T10:08:29.166Z'
status: open
target:
  url: /
  selector: main:nth-of-type(1)
  text: >-
    Why teams pick Acme Acme cuts the boring parts of running a small team — billing, contracts, payroll — into one
    quiet...
  role: main
  viewport:
    w: 1512
    h: 827
  coords:
    x: 1132
    'y': 282
---



make the max width to lg

---
**ai-reply** — claude-opus-4-7 — 2026-05-09T10:10:00.041Z

Set `<main>` `max-width` to **1024px** (Tailwind's `lg` breakpoint width). Was 720px. Interpreted "lg" as the screen-breakpoint size since your earlier note was "make this wider" — Tailwind's `max-w-lg` (512px) would actually be narrower, opposite of intent. The selector still resolves to `<main>`, no anchor update needed.
