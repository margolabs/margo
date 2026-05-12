---
id: c-deadab
type: task
author: bob@team.com
authorName: Bob
branch: feat/checkout-rewrite
created: '2026-05-10T09:42:00.000Z'
status: resolved
target:
  url: /
  selector: form#checkout-mini > button[data-testid="quick-buy"]
  text: One-click checkout
  role: button
  viewport:
    w: 1440
    h: 900
  coords:
    x: 980
    'y': 540
  commit: abc1234
  dirty: false
---


The one-click checkout button is too close to the cancel link — easy
to misclick on mobile. Move it down 12px and add a gap.
