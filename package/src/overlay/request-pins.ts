// "+ request" sub-FAB and its picker panel.
//
// Companion to inject.ts's enablePinComposer, but for the network-pin path: a
// user clicks "+ request", sees a list of recently captured fetch/XHR calls,
// picks one, writes a comment, and we POST a target.kind === 'request' file.
//
// Kept in its own module so inject.ts doesn't grow another 200 lines. The host
// passes in everything we'd otherwise import from inject (uiPrompt,
// createComment, currentRoute, onCreated) — that inversion keeps this file
// free of cycles and trivially testable in isolation later.
//
// Pending requests are deliberately hidden from the picker rather than shown
// disabled. The user pinning a network call is almost always reacting to a
// settled response (a 500, a slow 200); a still-in-flight row would just
// invite mis-clicks during the race between "click row" and "fetch settles".
// If they want one, they wait a beat and re-open the panel.

import type { CapturedRequest } from './network.js'
import { getCapturedRequests, subscribeCapture } from './network.js'

export interface RequestLauncherOpts {
  root: HTMLElement
  currentRoute: () => string
  uiPrompt: (opts: {
    title?: string
    message?: string
    placeholder?: string
    multiline?: boolean
    confirmLabel?: string
  }) => Promise<string | null>
  createComment: (req: { type: string; body: string; target: unknown }) => Promise<{ id: string }>
  onCreated: () => void
}

// Module-scope mount flag. Second call is a no-op — same pattern network.ts
// uses for the tap install, same reason: HMR and double-imports happen.
let mounted = false

export function installRequestLauncher(opts: RequestLauncherOpts): void {
  if (mounted) return
  mounted = true

  const button = document.createElement('button')
  button.className = 'margo-launcher margo-launcher-request'
  button.type = 'button'
  button.textContent = '+ request'
  opts.root.appendChild(button)

  // Panel + subscription state lives in this closure. The panel element is
  // created lazily on first open so we don't pay DOM cost on pages where the
  // user never touches this FAB.
  let panel: HTMLElement | null = null
  let unsubscribeCapture: (() => void) | null = null
  const isOpen = (): boolean => panel !== null && panel.isConnected

  const closePanel = (): void => {
    if (unsubscribeCapture) {
      unsubscribeCapture()
      unsubscribeCapture = null
    }
    if (panel && panel.isConnected) panel.remove()
    panel = null
  }

  const openPanel = (): void => {
    panel = buildPanel({
      onClose: closePanel,
      onPick: async (req) => {
        closePanel()
        await composeFor(req, opts)
      },
    })
    opts.root.appendChild(panel)
    renderRows(panel)

    // Re-render on every capture event while open. Cheap: at most 50 rows.
    unsubscribeCapture = subscribeCapture(() => {
      if (panel) renderRows(panel)
    })

    // Panel persistence: matches the inbox panel's behavior. The panel
    // stays open until the user explicitly dismisses it (× button or
    // toggling the "+ request" sub-FAB again). Outside-click is NOT a
    // close signal — you can pin elements / interact with the page
    // while the panel is up. Escape is also a no-op here: the inbox
    // panel ignores Escape too, so the request panel matches.
  }

  button.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (isOpen()) closePanel()
    else openPanel()
  })
}

interface PanelHandlers {
  onClose: () => void
  onPick: (req: CapturedRequest) => void
}

function buildPanel(handlers: PanelHandlers): HTMLElement {
  const aside = document.createElement('aside')
  aside.className = 'margo-request-panel'
  aside.setAttribute('role', 'dialog')
  aside.setAttribute('aria-label', 'Pick a request to pin')

  const head = document.createElement('header')
  head.className = 'margo-request-panel-head'
  const title = document.createElement('strong')
  title.textContent = 'Recent requests'
  head.appendChild(title)
  const close = document.createElement('button')
  close.className = 'margo-request-panel-close'
  close.type = 'button'
  close.setAttribute('aria-label', 'close')
  close.textContent = '×'
  close.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    handlers.onClose()
  })
  head.appendChild(close)
  aside.appendChild(head)

  const list = document.createElement('div')
  list.className = 'margo-request-panel-list'
  // Delegated click on the list so we don't rebind on every re-render.
  list.addEventListener('click', (e) => {
    const row = (e.target as Element | null)?.closest<HTMLElement>('.margo-request-row')
    if (!row) return
    const id = row.dataset.id
    if (!id) return
    const req = getCapturedRequests().find((r) => r.id === id)
    if (req) handlers.onPick(req)
  })
  aside.appendChild(list)

  const empty = document.createElement('p')
  empty.className = 'margo-request-empty'
  empty.hidden = true
  empty.textContent = 'No requests captured yet. Trigger a network call on the page first.'
  aside.appendChild(empty)

  return aside
}

function renderRows(panel: HTMLElement): void {
  const list = panel.querySelector<HTMLElement>('.margo-request-panel-list')
  const empty = panel.querySelector<HTMLElement>('.margo-request-empty')
  if (!list || !empty) return

  // Settled-only, newest-first. getCapturedRequests already returns newest-
  // first; pending entries get filtered out per the module header rationale.
  const rows = getCapturedRequests().filter((r) => r.phase === 'settled')

  list.replaceChildren()
  if (rows.length === 0) {
    empty.hidden = false
    return
  }
  empty.hidden = true
  for (const req of rows) {
    list.appendChild(renderRow(req))
  }
}

function renderRow(req: CapturedRequest): HTMLElement {
  const row = document.createElement('button')
  row.className = 'margo-request-row'
  row.type = 'button'
  row.dataset.id = req.id
  row.title = req.endpoint

  const method = document.createElement('span')
  const methodUpper = req.method.toUpperCase()
  method.className = 'margo-request-method margo-request-method-' + methodClass(methodUpper)
  method.textContent = methodUpper
  row.appendChild(method)

  const endpoint = document.createElement('span')
  endpoint.className = 'margo-request-endpoint'
  endpoint.textContent = pathnameOf(req.endpoint)
  row.appendChild(endpoint)

  const status = document.createElement('span')
  status.className = 'margo-request-status margo-request-status-' + statusClass(req.status)
  status.textContent = req.status === 0 ? 'ERR' : String(req.status)
  row.appendChild(status)

  if (typeof req.duration === 'number') {
    const duration = document.createElement('span')
    duration.className = 'margo-request-duration'
    duration.textContent = req.duration + ' ms'
    row.appendChild(duration)
  }

  // Trigger context: shows the user which UI element fired this request.
  // Auto-captured at fetch dispatch via the network tap; renders as a
  // small subtitle below the main row so the picker reads like "POST
  // /api/subscribe — fired by clicking Subscribe".
  if (req.trigger && (req.trigger.text || req.trigger.selector)) {
    const trig = document.createElement('span')
    trig.className = 'margo-request-trigger'
    const label = req.trigger.text || req.trigger.selector
    trig.textContent = '← ' + label
    trig.title = `Triggered by ${req.trigger.selector}`
    row.appendChild(trig)
  }

  return row
}

async function composeFor(req: CapturedRequest, opts: RequestLauncherOpts): Promise<void> {
  const pathname = pathnameOf(req.endpoint)
  const methodUpper = req.method.toUpperCase()
  const statusLabel = req.status === 0 ? 'network error' : String(req.status)
  const body = await opts.uiPrompt({
    title: 'Comment on this request',
    message: `${methodUpper} ${pathname} → ${statusLabel}`,
    placeholder: "What's wrong here? Prefix with ? for question, // for discussion.",
    multiline: true,
    confirmLabel: 'Post',
  })
  if (!body || !body.trim()) return

  const trimmed = body.trim()
  // Mirrors inject.ts's mouseup-handler parsing exactly: leading ? is a
  // question, leading // is a discussion, otherwise it's a task. Keep both
  // sites in sync if either ever grows new prefixes.
  const type = trimmed.startsWith('?')
    ? 'question'
    : trimmed.startsWith('//')
      ? 'discussion'
      : 'task'
  const cleanedBody = trimmed.replace(/^(\?|\/\/)\s*/, '')

  // Required-by-schema element fields stay empty for request pins. The
  // resolver and pin renderer skip kind:request, so nothing reads them.
  const target = {
    url: opts.currentRoute(),
    kind: 'request' as const,
    selector: '',
    text: '',
    viewport: { w: window.innerWidth, h: window.innerHeight },
    coords: { x: 0, y: 0 },
    request: {
      method: req.method,
      endpoint: req.endpoint,
      status: req.status,
      statusText: req.statusText,
      duration: req.duration,
      timestamp: req.timestamp,
      traceId: req.traceId,
      trigger: req.trigger,
    },
  }

  await opts.createComment({ type, body: cleanedBody, target })
  opts.onCreated()
}

function pathnameOf(url: string): string {
  // Defensive: the network tap always stores fully-qualified URLs, but a
  // malformed entry shouldn't crash the picker. Fall back to the raw string.
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

function methodClass(method: string): string {
  // Normalize to the small set of CSS class suffixes we ship colors for.
  // Unknown verbs fall through to GET's muted styling rather than going
  // unstyled — keeps the chip readable against the panel bg either way.
  switch (method) {
    case 'GET':
    case 'POST':
    case 'PATCH':
    case 'PUT':
    case 'DELETE':
      return method
    default:
      return 'GET'
  }
}

function statusClass(status: number): string {
  if (status === 0) return '5xx'      // network errors share the 5xx red
  if (status >= 500) return '5xx'
  if (status >= 400) return '4xx'
  if (status >= 300) return '3xx'
  if (status >= 200) return '2xx'
  return '5xx'
}

// CSS is exported as a single string the host concatenates into the overlay's
// existing <style>. inject.ts already wraps overlay rules under
// #margo-overlay-root for scoping, so we author bare selectors here.
export const REQUEST_PINS_CSS = `
.margo-launcher-request {
  position: fixed;
  bottom: 256px;
  right: 16px;
  height: 32px;
  padding: 0 12px;
  font-size: 12px;
  line-height: 1;
  border-radius: 9999px;
  background: hsl(0 0% 100%);
  color: var(--margo-fg);
  border: 1px solid var(--margo-border);
  cursor: pointer;
}
.margo-launcher-request:hover {
  background: var(--margo-muted);
}

.margo-request-panel {
  /* Mirrors the inbox panel's dimensions so the user can monitor recent
     network traffic side-by-side with the inbox. Defaults to the same
     right-edge position as the inbox; the :has() rule below shifts it
     leftward when the inbox is ALSO open so they don't collide. */
  position: fixed;
  top: 16px;
  right: 16px;
  bottom: 16px;
  width: min(380px, calc(100vw - 32px));
  display: flex;
  flex-direction: column;
  background: hsl(0 0% 100%);
  color: var(--margo-fg);
  border: 1px solid var(--margo-border);
  border-radius: 12px;
  box-shadow: 0 12px 40px hsl(0 0% 0% / 0.18);
  overflow: hidden;
  z-index: 1000001;
  transition: right 220ms cubic-bezier(0.4, 0, 0.2, 1);
  animation: margo-request-panel-in 0.16s ease-out;
}
@keyframes margo-request-panel-in {
  from { opacity: 0; transform: translateX(8px); }
  to { opacity: 1; transform: none; }
}
/* When the inbox panel is also mounted, push the request panel to its
   left so both are visible. 380px (inbox width) + 16px (inbox right
   offset) + 12px (gap between the two) = 408px total offset. */
body:has(.margo-inbox) .margo-request-panel {
  right: 408px;
}
/* On narrow viewports, gracefully fall back to stacking: drop the
   request panel back to right: 16 (it'll cover the inbox temporarily
   but the user just closes one to see the other). */
@media (max-width: 880px) {
  body:has(.margo-inbox) .margo-request-panel {
    right: 16px;
  }
}
.margo-request-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--margo-border);
  font-size: 12px;
}
.margo-request-panel-head strong {
  font-weight: 600;
}
.margo-request-panel-close {
  background: transparent;
  border: 0;
  padding: 0 4px;
  font-size: 16px;
  line-height: 1;
  color: var(--margo-muted-fg);
  cursor: pointer;
}
.margo-request-panel-close:hover {
  color: var(--margo-fg);
}
.margo-request-panel-list {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 4px 0;
}
.margo-request-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 16px;
  background: transparent;
  border: 0;
  text-align: left;
  cursor: pointer;
  color: var(--margo-fg);
}
.margo-request-row:hover {
  background: var(--margo-muted);
}
.margo-request-method {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  background: hsl(240 5% 90%);
  color: hsl(240 5% 25%);
  flex: 0 0 auto;
}
.margo-request-method-GET {
  background: hsl(240 5% 90%);
  color: hsl(240 5% 25%);
}
.margo-request-method-POST {
  background: hsl(217 91% 60% / 0.15);
  color: hsl(217 91% 35%);
}
.margo-request-method-PATCH,
.margo-request-method-PUT {
  background: hsl(38 92% 50% / 0.18);
  color: hsl(38 92% 28%);
}
.margo-request-method-DELETE {
  background: hsl(0 84% 60% / 0.15);
  color: hsl(0 84% 40%);
}
.margo-request-endpoint {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--margo-fg);
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.margo-request-status {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  flex: 0 0 auto;
}
.margo-request-status-2xx {
  background: hsl(160 84% 39% / 0.15);
  color: hsl(160 84% 25%);
}
.margo-request-status-3xx {
  background: hsl(217 91% 60% / 0.15);
  color: hsl(217 91% 35%);
}
.margo-request-status-4xx {
  background: hsl(38 92% 50% / 0.18);
  color: hsl(38 92% 28%);
}
.margo-request-status-5xx {
  background: hsl(0 84% 60% / 0.15);
  color: hsl(0 84% 40%);
}
.margo-request-duration {
  font-size: 10px;
  color: var(--margo-muted-fg);
  flex: 0 0 auto;
}
.margo-request-trigger {
  flex: 1 0 100%;
  font-size: 11px;
  color: var(--margo-muted-fg);
  padding-left: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.margo-request-empty {
  margin: 0;
  padding: 16px;
  font-size: 12px;
  font-style: italic;
  color: var(--margo-muted-fg);
  text-align: center;
}
`
