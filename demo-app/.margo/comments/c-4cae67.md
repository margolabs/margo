---
id: c-4cae67
type: task
author: demo@margo.local
role: designer
branch: main
created: '2026-05-09T07:55:17.362Z'
status: resolved
target:
  url: /
  selector: section#contact > p:nth-of-type(1) > a:nth-of-type(1)
  text: hello@acme.com
  role: a
  viewport:
    w: 1512
    h: 827
  coords:
    x: 559
    'y': 618
  textAnchor:
    phrase: hello@acme.com
    before: ''
    after: ''
---


change email to hello@acme.com

---
**ai-reply** — claude-opus-4-7 — 2026-05-09T08:16:29.361Z

Updated the contact section in `demo-app/index.html`: both the visible text and the `mailto:` href now use `hello@acme.com`. Also updated `target.text` and `target.textAnchor.phrase` to the new email so the pin still resolves to the same `<a>` after the change.
