---
id: c-31b5da
type: task
author: sxhuan@gmail.com
authorName: Stanley Song
branch: feat/network-request-pins
created: '2026-05-21T07:31:15.990Z'
status: open
target:
  url: /#pricing
  selector: section#subscribe > form[data-testid="subscribe-form"] > button[data-testid="subscribe-submit"]
  text: Subscribe
  role: button
  viewport:
    w: 2560
    h: 1318
  coords:
    x: 1667
    'y': 829
  viewContext:
    nearestHeading: Stay in the loop
  relatedRequests:
    - method: POST
      endpoint: http://localhost:5175/api/subscribe
      status: 201
      statusText: Created
      duration: 5
      timestamp: '2026-05-21T07:31:04.697Z'
  commit: '45e1015'
---

TEST
