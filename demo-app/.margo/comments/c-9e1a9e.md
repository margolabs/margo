---
id: c-9e1a9e
type: task
author: sxhuan@gmail.com
role: other
branch: main
created: '2026-05-09T08:57:58.087Z'
status: resolved
target:
  url: /
  selector: header:nth-of-type(1) > nav:nth-of-type(1) > a:nth-of-type(1)
  text: Features
  role: a
  viewport:
    w: 1512
    h: 827
  coords:
    x: 95
    'y': 47
  gapAnchor:
    first:
      selector: header:nth-of-type(1) > nav:nth-of-type(1) > a:nth-of-type(1)
      text: Features
      role: a
    second:
      selector: header:nth-of-type(1) > h1:nth-of-type(1)
      text: Acme Pricing
      role: h1
    axis: horizontal
---


spacing too busy

---
**ai-reply** — claude-opus-4-7 — 2026-05-09T08:59:03.045Z

Loosened the header in `demo-app/index.html`: added `margin-bottom: 10px` to the h1 so the title and nav aren't crammed together, and bumped the nav's inter-link gap from 16px to 20px. The gap-anchor's two boundary elements (h1, first nav link) are unchanged so the highlight will track the new looser spacing on next render. Note: the captured axis was `horizontal` because the elements' centers were further apart on x than y, but visually it's a vertical stack — the fix targets the actual visual gap.
