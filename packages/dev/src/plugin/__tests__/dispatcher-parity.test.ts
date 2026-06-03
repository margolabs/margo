// Regression tests that catch the bug class where ENDPOINTS (sidecar/
// Vite dispatcher in server/endpoints.ts) and ROUTES (Next.js
// dispatcher in plugin/next-server.ts) drift apart.
//
// 0.4.1 shipped /__margo/sync-status in endpoints.ts + the overlay but
// nobody added it to next-server.ts's ROUTES, so every Next.js workspace
// 404'd the poll. The fix landed in 0.4.2. These tests make sure that
// kind of drift fails the build instead of slipping through.
//
// Two layers of coverage:
//   1. Pure parity — ENDPOINTS and ROUTES describe the same surface.
//      Catches "added to one table, not the other" before any handler
//      runs.
//   2. Functional smoke — every route in ROUTES actually responds
//      non-404 from the Next handler. Catches "in ROUTES but the
//      dispatch case is missing", which the pure parity check would
//      miss.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handlers, ROUTES, isKnownRoute } from '../next-server.js';
import { ENDPOINTS } from '../../server/endpoints.js';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe('dispatcher parity — ENDPOINTS (sidecar/Vite) ⟷ ROUTES (Next)', () => {
  it('every sidecar endpoint has a matching Next route entry', () => {
    // ENDPOINTS uses '/__margo/<leaf>'; ROUTES uses '<leaf>' since Next
    // strips the prefix via path params. Normalize before comparing.
    const sidecarLeaves = new Set(
      ENDPOINTS.map((e) => e.replace(/^\/__margo\//, '')),
    );
    const nextLeaves = new Set(ROUTES.map((r) => r.route));

    const missingFromNext = [...sidecarLeaves].filter((l) => !nextLeaves.has(l));
    expect(
      missingFromNext,
      `endpoint${missingFromNext.length === 1 ? '' : 's'} registered in server/endpoints.ts but missing from plugin/next-server.ts ROUTES (would 404 on Next.js workspaces): ${missingFromNext.join(', ')}`,
    ).toEqual([]);
  });

  it('every Next route has a matching sidecar endpoint entry', () => {
    const sidecarLeaves = new Set(
      ENDPOINTS.map((e) => e.replace(/^\/__margo\//, '')),
    );
    const nextLeaves = new Set(ROUTES.map((r) => r.route));

    const missingFromSidecar = [...nextLeaves].filter((l) => !sidecarLeaves.has(l));
    expect(
      missingFromSidecar,
      `route${missingFromSidecar.length === 1 ? '' : 's'} registered in plugin/next-server.ts but missing from server/endpoints.ts ENDPOINTS (would 404 on Vite/sidecar workspaces): ${missingFromSidecar.join(', ')}`,
    ).toEqual([]);
  });

  it('isKnownRoute() answers true for every (route, method) pair declared in ROUTES', () => {
    // Sanity: the helper that powers the 404 short-circuit must agree
    // with its own table. Defends against a future refactor where the
    // helper goes out of sync (e.g. someone adds a route to ROUTES
    // but breaks isKnownRoute's matcher).
    for (const { route, methods } of ROUTES) {
      for (const method of methods) {
        expect(isKnownRoute(route, method), `isKnownRoute('${route}', '${method}') must be true`).toBe(true);
      }
    }
  });

  it('isKnownRoute() answers false for unregistered combos', () => {
    expect(isKnownRoute('not-a-route', 'GET')).toBe(false);
    expect(isKnownRoute('list', 'POST')).toBe(false); // list is GET-only
    expect(isKnownRoute('sync', 'GET')).toBe(false);  // sync is POST-only
    expect(isKnownRoute('sync-status', 'POST')).toBe(false); // sync-status is GET-only
  });
});

describe('Next handler — every ROUTES entry returns non-404', () => {
  beforeEach(() => {
    // Force the dev gate open so dispatch() doesn't 404 us out on
    // NODE_ENV=production-ish defaults the vitest harness might use.
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  // Pre-baked bodies for the method/route combos that read JSON. Empty
  // for everything else. The shapes don't need to be valid — the
  // dispatcher only cares that the route exists and that the handler
  // doesn't throw before returning. Any 5xx (e.g. from a missing
  // margo.config.json in test cwd) is a fine signal: the route was
  // recognized.
  const BODIES: Record<string, unknown> = {
    'POST comment': { body: 'probe', target: { kind: 'element', selector: '.x', url: 'http://localhost/' } },
    'PATCH comment': { id: 'c-probe', patch: { status: 'open' } },
    'POST me': { name: 'Probe', email: 'probe@example.com' },
  };

  for (const { route, methods } of ROUTES) {
    for (const method of methods) {
      it(`${method.padEnd(6)} /__margo/${route} is dispatched (non-404)`, async () => {
        const url = `http://localhost/__margo/${route}${method === 'DELETE' ? '?id=c-probe' : ''}`;
        const init: RequestInit = { method };
        const bodyKey = `${method} ${route}`;
        if (bodyKey in BODIES) {
          init.headers = { 'content-type': 'application/json' };
          init.body = JSON.stringify(BODIES[bodyKey]);
        }
        const handler = (handlers as Record<string, (req: Request, ctx: { params: Promise<{ path?: string[] }> }) => Promise<Response>>)[method];
        expect(handler, `handlers.${method} must exist`).toBeDefined();
        const res = await handler(
          new Request(url, init),
          { params: Promise.resolve({ path: [route] }) },
        );
        expect(
          res.status,
          `dispatcher 404'd ${method} /__margo/${route} — did the dispatch case get registered with the ROUTES entry?`,
        ).not.toBe(404);
      });
    }
  }

  it('events GET — long-lived SSE response is recognized', async () => {
    // The events route returns a streaming Response with text/event-stream.
    // Status is 200 immediately; the body keeps the connection open. We
    // only care that it's not 404 here.
    const res = await handlers.GET(
      new Request('http://localhost/__margo/events'),
      { params: Promise.resolve({ path: ['events'] }) },
    );
    expect(res.status).not.toBe(404);
    // Best-effort cleanup so the test runner doesn't hang on the open stream.
    try { await (res.body as ReadableStream | null)?.cancel(); } catch { /* ignore */ }
  });
});
