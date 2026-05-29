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

import type { RequestAnchor, TriggerInfo } from '../shared/types.js'

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

// ─── Trace-id + trigger correlation ─────────────────────────────────────
//
// Each non-margo, non-pin-mode user interaction (click/submit/Enter)
// rotates a per-page trace id AND snapshots the triggering element's
// identifying info. Every same-origin fetch/XHR fired *after* that
// interaction carries the active id as `x-margo-trace` and is tagged
// (client-side) with both the trace id and the trigger info. When the
// user pins a captured request, the persisted comment carries the
// triggering UI element automatically — no manual pin-the-button step.
//
// Cross-origin requests skip the header to avoid triggering a CORS
// preflight (a custom header makes the request non-simple). We still
// tag them client-side. Same-origin calls additionally land the header
// in the app's own access logs, so AI can grep by trace id even in
// sidecar mode with no server-side margo plugin.

const TRACE_HEADER = 'x-margo-trace'

/** Active trace id. Rotates on every non-margo, non-pin-mode interaction
 *  via `rotateTraceId()`. Initialized once at module load so requests
 *  fired before any interaction (page-load fetches) all share the same
 *  id and can still be attributed. */
let currentTraceId: string = newTraceId()

/** Snapshot of the element from the most recent user interaction. Null
 *  until the user has actually interacted — page-load requests get
 *  `undefined` trigger info, which reads naturally as "fired without
 *  a user click." */
let currentTrigger: TriggerInfo | null = null

function newTraceId(): string {
  // randomUUID is available in modern browsers and Node 19+. Fall back to
  // a timestamp + Math.random pair if we're in an older runtime — collisions
  // within a single tab are vanishingly unlikely either way.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `mt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Mint a fresh trace id. Call this on every user interaction that should
 * "start a new causal slice" — clicks/submits/Enter outside the margo
 * overlay and outside pin-arming mode (which is itself a click).
 */
export function rotateTraceId(): string {
  currentTraceId = newTraceId()
  return currentTraceId
}

/** Read the active trace id without rotating. */
export function getCurrentTraceId(): string {
  return currentTraceId
}

/**
 * Record the element that just caused an interaction (a click, a form
 * submit, an Enter keypress). Any fetch/XHR that fires before the next
 * interaction inherits this trigger info on its captured record. Pass
 * `null` to clear (e.g. on a non-meaningful interaction we still want
 * the trace rotation for, but no trigger attribution).
 */
export function recordTrigger(info: TriggerInfo | null): void {
  currentTrigger = info
}

/** Read the active trigger info (used in tests / debug). */
export function getCurrentTrigger(): TriggerInfo | null {
  return currentTrigger
}

function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, location.href).origin === location.origin
  } catch {
    return false
  }
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
    // Snapshot the active trace id AND trigger element at dispatch (not at
    // settle). If another interaction rotates them while this call is in
    // flight, the call still belongs to the interaction that caused it.
    const traceId = currentTraceId
    const trigger = currentTrigger ?? undefined
    const record = createPending(method, endpoint, traceId, trigger)
    push(record)
    notify(record)
    // Inject the header only for same-origin requests — a custom header
    // makes the call non-simple, which triggers a CORS preflight, which
    // most third-party APIs reject. The client-side tag is still useful
    // for cross-origin (we attribute it to this interaction) but the
    // server never sees it. Worth the trade.
    let dispatchInput: RequestInfo | URL = input
    let dispatchInit: RequestInit | undefined = init
    if (isSameOrigin(endpoint)) {
      const injected = injectFetchTraceHeader(input, init, traceId)
      dispatchInput = injected.input
      dispatchInit = injected.init
    }
    return original(dispatchInput, dispatchInit).then(
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
      const traceId = currentTraceId
      const trigger = currentTrigger ?? undefined
      const record = createPending(state.method, state.endpoint, traceId, trigger)
      state.record = record
      push(record)
      notify(record)
      // Same same-origin guard as fetch. setRequestHeader after open() is
      // valid; calling it from inside the wrapped send (before origSend)
      // attaches the header before the request is actually dispatched.
      // Wrap in try/catch — pathological caller could have already aborted.
      if (isSameOrigin(state.endpoint)) {
        try {
          this.setRequestHeader(TRACE_HEADER, traceId)
        } catch {
          // ignore — non-fatal if the header can't be set for some reason
        }
      }
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

function createPending(
  method: string,
  endpoint: string,
  traceId?: string,
  trigger?: TriggerInfo,
): CapturedRequest {
  return {
    id: nextId(),
    phase: 'pending',
    method,
    endpoint,
    status: 0,
    timestamp: new Date().toISOString(),
    traceId,
    trigger,
  }
}

/**
 * Return a new (input, init) pair with the `x-margo-trace` header merged
 * in. Three branches for the three fetch-input shapes; we never mutate
 * the caller's Request or init in place.
 */
function injectFetchTraceHeader(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  traceId: string,
): { input: RequestInfo | URL; init: RequestInit | undefined } {
  // string / URL input: stash the header in init.
  if (typeof input === 'string' || input instanceof URL) {
    const headers = new Headers(init?.headers ?? undefined)
    if (!headers.has(TRACE_HEADER)) headers.set(TRACE_HEADER, traceId)
    return { input, init: { ...(init ?? {}), headers } }
  }
  // Request input. If the caller also passed init.headers, those override
  // the Request's headers per spec — preserve that intent by merging into
  // init.headers. Otherwise clone the Request with merged headers.
  if (typeof Request !== 'undefined' && input instanceof Request) {
    if (init && init.headers !== undefined) {
      const headers = new Headers(init.headers)
      if (!headers.has(TRACE_HEADER)) headers.set(TRACE_HEADER, traceId)
      return { input, init: { ...init, headers } }
    }
    const headers = new Headers(input.headers)
    if (!headers.has(TRACE_HEADER)) headers.set(TRACE_HEADER, traceId)
    return { input: new Request(input, { headers }), init }
  }
  return { input, init }
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
