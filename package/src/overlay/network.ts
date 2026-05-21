// Capture fetch + XMLHttpRequest calls so the overlay can pin a network
// request as a comment target.
//
// We wrap the globals (rather than relying on PerformanceObserver) because we
// need to know the request method, the response status, and an in-flight
// signal — none of which Performance entries expose reliably across browsers.
// Wrapping is invasive, so the wrappers do the minimum: synthesize a record,
// hand the call off to the original, and update the record when it settles.
// The caller's promise/response is returned unmodified; thrown errors are
// rethrown so consumer code observes the same behavior as without the tap.
//
// Privacy: bodies and headers are intentionally not captured. The pin schema
// excludes them (see `RequestAnchor`) and the comment file would balloon if we
// stored them. Endpoint + method + status is enough for AI to find the route
// handler in the codebase; anything more is a follow-up that needs explicit
// opt-in.
//
// Buffering: a bounded ring buffer (50 most-recent, newest-first) keeps memory
// flat on long-lived sessions. A noisy app can dispatch thousands of XHRs per
// minute and we never want the overlay to be the reason a page hits an OOM.
//
// Filtering: margo's own polling endpoints (/__margo/*) are skipped. The
// overlay polls /__margo/list and /__margo/events constantly; capturing those
// would flood the buffer and bury the user's real traffic instantly.
//
// Idempotency: install is safe to call repeatedly. HMR, multiple entry points,
// and accidental double-imports all happen; reinstalling would chain wrappers
// and double-count every call. A module-scope flag plus a marker on the
// wrapped fetch lets us detect and skip re-installs.

import type { RequestAnchor } from '../shared/types.js'

export interface CapturedRequest extends RequestAnchor {
  /** Stable per-session id so the UI can list and select. e.g. 'r-0001'. */
  id: string
  /** 'pending' while in flight, 'settled' once response or error arrives. */
  phase: 'pending' | 'settled'
  /** Network/abort error message when status === 0. */
  error?: string
}

type Listener = (r: CapturedRequest) => void

const MAX_BUFFER = 50
const MARGO_PATH_PREFIX = '/__margo/'

// Module-scope state. The counter is deliberately *not* reset on re-install —
// ids should stay monotonic for the lifetime of the page so the UI can dedupe
// even if something tears down and rebuilds the tap.
const buf: CapturedRequest[] = []
const listeners = new Set<Listener>()
let installed = false
let counter = 0

// Marker on the wrapped global. Lets a second installer (different bundle,
// HMR'd module instance) detect that some other copy already wrapped fetch and
// bail without chaining a second wrapper on top.
interface TappedFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  __margoTapped__?: true
}

interface TappedXhrOpen {
  (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void
  __margoTapped__?: true
}

interface TappedXhrSend {
  (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void
  __margoTapped__?: true
}

// Per-instance bookkeeping stashed on the XHR object. Using a WeakMap (rather
// than expando properties) keeps the XHR's own surface clean and lets the GC
// reclaim the bookkeeping when the XHR is dropped.
interface XhrState {
  method: string
  endpoint: string
  startedAt: number
  record?: CapturedRequest
}
const xhrState = new WeakMap<XMLHttpRequest, XhrState>()

export function installNetworkTap(): void {
  if (installed) return
  if ((window.fetch as TappedFetch).__margoTapped__) {
    installed = true
    return
  }
  installed = true
  installFetchTap()
  installXhrTap()
}

export function getCapturedRequests(): CapturedRequest[] {
  // Hand back a copy so callers can't mutate our buffer. Cheap at n=50.
  return buf.slice()
}

export function subscribeCapture(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// ─── Interaction-to-request correlation ─────────────────────────────────
//
// When the user pins a DOM element, margo wants to surface the network
// activity their click likely caused — closing the loop between UI symptom
// and backend behavior. We don't have a true trace ID injected through the
// server, so the correlation is heuristic: requests whose `timestamp` falls
// within a short window after the user's last interaction with the page.
//
// The window is wide enough to catch round-trips that take a couple of
// seconds (slow APIs, retries) but tight enough that idle background calls
// (analytics polls, prefetch) don't get attached to every pin.

/** Milliseconds since epoch of the last non-overlay interaction. Updated
 *  by recordInteraction(); read by getRequestsSinceInteraction(). */
let lastInteractionAt: number | null = null

/** Default causal window: 3 seconds after the click/submit/keypress. */
const INTERACTION_WINDOW_MS = 3000

/** Default cap on attached requests. Five is roughly the noise/signal
 *  threshold — past that, AI gets too much chaff for the same pin. */
const MAX_RELATED_REQUESTS = 5

/**
 * Mark "the user just did something." Call this from any user-input
 * listener (click, submit, Enter keypress) that ISN'T part of the margo
 * overlay itself. Margo's own DOM interactions must not poison the window.
 */
export function recordInteraction(at: number = Date.now()): void {
  lastInteractionAt = at
}

/**
 * Return the settled requests that fired within the causal window of the
 * most recent user interaction. Newest-first, capped at `maxCount`.
 * Returns an empty array when no interaction has been recorded yet (e.g.
 * the user pinned something via keyboard before clicking anything) or
 * when no requests landed in the window.
 *
 * Only the RequestAnchor-shaped subset is returned (no internal id, no
 * pending phase) — the consumer attaches this directly to a Comment's
 * `target.relatedRequests` array.
 */
export function getRequestsSinceInteraction(
  windowMs: number = INTERACTION_WINDOW_MS,
  maxCount: number = MAX_RELATED_REQUESTS,
): RequestAnchor[] {
  if (lastInteractionAt === null) return []
  const cutoff = lastInteractionAt
  const ceiling = cutoff + windowMs + 500 // small grace for response settle
  const out: RequestAnchor[] = []
  for (const r of buf) {
    if (r.phase !== 'settled') continue
    const t = Date.parse(r.timestamp)
    if (Number.isNaN(t)) continue
    if (t < cutoff || t > ceiling) continue
    // CapturedRequest extends RequestAnchor — strip the local-only fields
    // (id, phase, error) before exposing to comment storage.
    out.push({
      method: r.method,
      endpoint: r.endpoint,
      status: r.status,
      statusText: r.statusText,
      duration: r.duration,
      timestamp: r.timestamp,
    })
    if (out.length >= maxCount) break
  }
  return out
}

function installFetchTap(): void {
  const original = window.fetch.bind(window)
  const wrapped: TappedFetch = function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const endpoint = resolveUrl(input)
    if (shouldSkip(endpoint)) {
      return original(input, init)
    }
    const method = resolveMethod(input, init)
    const startedAt = nowMs()
    const record = createPending(method, endpoint)
    push(record)
    notify(record)
    return original(input, init).then(
      (response) => {
        record.phase = 'settled'
        record.status = response.status
        record.statusText = response.statusText || undefined
        record.duration = Math.max(0, Math.round(nowMs() - startedAt))
        record.timestamp = new Date().toISOString()
        notify(record)
        return response
      },
      (err: unknown) => {
        record.phase = 'settled'
        record.status = 0
        record.error = errorMessage(err)
        record.duration = Math.max(0, Math.round(nowMs() - startedAt))
        record.timestamp = new Date().toISOString()
        notify(record)
        throw err
      },
    )
  }
  wrapped.__margoTapped__ = true
  window.fetch = wrapped
}

function installXhrTap(): void {
  const proto = XMLHttpRequest.prototype
  const origOpen = proto.open
  const origSend = proto.send

  // Forward to the native open with whatever arg shape the caller used. open's
  // signature accepts (method, url) or (method, url, async, user?, password?);
  // calling `origOpen.apply(this, arguments)` preserves both forms without us
  // having to forward undefineds for omitted optional args.
  const wrappedOpen: TappedXhrOpen = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
  ): void {
    const endpoint = resolveUrl(url)
    xhrState.set(this, { method: (method || 'GET').toUpperCase(), endpoint, startedAt: 0 })
    // eslint-disable-next-line prefer-rest-params
    return origOpen.apply(this, arguments as unknown as Parameters<typeof origOpen>)
  }
  wrappedOpen.__margoTapped__ = true
  proto.open = wrappedOpen as typeof proto.open

  const wrappedSend: TappedXhrSend = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const state = xhrState.get(this)
    if (state && !shouldSkip(state.endpoint)) {
      state.startedAt = nowMs()
      const record = createPending(state.method, state.endpoint)
      state.record = record
      push(record)
      notify(record)
      // Listeners fire in the order: load → loadend on success, error/abort
      // → loadend on failure. Using `loadend` as the single settle point
      // means we don't need to manage the success/failure branches twice.
      this.addEventListener('loadend', () => onXhrSettle(this))
      this.addEventListener('error', () => markXhrError(this, 'network error'))
      this.addEventListener('abort', () => markXhrError(this, 'aborted'))
      this.addEventListener('timeout', () => markXhrError(this, 'timeout'))
    }
    return origSend.call(this, body ?? null)
  }
  wrappedSend.__margoTapped__ = true
  proto.send = wrappedSend as typeof proto.send
}

function onXhrSettle(xhr: XMLHttpRequest): void {
  const state = xhrState.get(xhr)
  const record = state?.record
  if (!state || !record || record.phase === 'settled') return
  record.phase = 'settled'
  // status is 0 for aborts and network errors — leave any error string the
  // error/abort listeners already wrote, otherwise fall through to whatever
  // the browser reports (frequently empty statusText on HTTP/2).
  record.status = xhr.status
  record.statusText = xhr.statusText || undefined
  record.duration = Math.max(0, Math.round(nowMs() - state.startedAt))
  record.timestamp = new Date().toISOString()
  notify(record)
}

function markXhrError(xhr: XMLHttpRequest, message: string): void {
  const state = xhrState.get(xhr)
  const record = state?.record
  if (!record || record.error) return
  record.error = message
}

function createPending(method: string, endpoint: string): CapturedRequest {
  return {
    id: nextId(),
    phase: 'pending',
    method,
    endpoint,
    status: 0,
    timestamp: new Date().toISOString(),
  }
}

function push(record: CapturedRequest): void {
  buf.unshift(record)
  while (buf.length > MAX_BUFFER) buf.pop()
}

function notify(record: CapturedRequest): void {
  for (const listener of listeners) {
    try {
      listener(record)
    } catch {
      // Swallow listener errors — one buggy subscriber must not break the tap
      // or any other subscriber. Production code path so we don't log.
    }
  }
}

function nextId(): string {
  counter += 1
  return 'r-' + String(counter).padStart(4, '0')
}

function shouldSkip(endpoint: string): boolean {
  try {
    return new URL(endpoint).pathname.startsWith(MARGO_PATH_PREFIX)
  } catch {
    return false
  }
}

function resolveUrl(input: RequestInfo | URL | string): string {
  if (typeof input === 'string') {
    return new URL(input, location.href).href
  }
  if (input instanceof URL) {
    return input.href
  }
  // Request object — has its own resolved url.
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.url
  }
  // Fallback: stringify and resolve. Covers exotic RequestInfo-like inputs
  // without falling into `any`.
  return new URL(String(input), location.href).href
}

function resolveMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase()
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.method.toUpperCase()
  }
  return 'GET'
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return String(err)
  } catch {
    return 'unknown error'
  }
}

function nowMs(): number {
  // performance.now is monotonic; Date.now drifts with system clock changes.
  // Fall back to Date.now in the unlikely environment where performance is
  // missing (very old WebViews) — durations stay sane in practice.
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}
