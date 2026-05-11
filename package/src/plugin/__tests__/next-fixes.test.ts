// Functional tests for the three Next.js integration bugs fixed in v0.0.4.
// These exercise the public surface from a consumer's perspective:
//   1. withMargo() scopes serverExternalPackages to the server subpath.
//   2. The handlers dispatcher matches Next 15+'s route-handler signature.
//   3. MargoScript threads a `nonce` prop onto the rendered <script>.
//
// We don't run a full Next.js build here — that lives in demo-nextjs as the
// end-to-end smoke. These tests verify the upstream contract.

import { describe, expect, it } from 'vitest';
import { withMargo } from '../next-config.js';
import { MargoScript } from '../next-client-script.js';
import { handlers } from '../next-server.js';

describe('withMargo — serverExternalPackages scoped to the server subpath', () => {
  it("adds 'margo-dev/next/server', NOT the whole 'margo-dev' package", () => {
    const out = withMargo({});
    expect(out.serverExternalPackages).toContain('margo-dev/next/server');
    // The whole-package form was the bug — externalizing it caught MargoScript
    // and triggered the React-duplication SSR error. Make sure we don't
    // accidentally regress to it.
    expect(out.serverExternalPackages).not.toContain('margo-dev');
  });

  it('preserves the user-supplied serverExternalPackages', () => {
    const out = withMargo({ serverExternalPackages: ['better-sqlite3', '@prisma/client'] });
    expect(out.serverExternalPackages).toEqual([
      'better-sqlite3',
      '@prisma/client',
      'margo-dev/next/server',
    ]);
  });

  it('is idempotent — calling withMargo twice does not duplicate the entry', () => {
    const once = withMargo({});
    const twice = withMargo(once);
    const occurrences = twice.serverExternalPackages!.filter((p) => p === 'margo-dev/next/server').length;
    expect(occurrences).toBe(1);
  });

  it('composes rewrites — preserves user rewrites and prepends margo', async () => {
    const out = withMargo({
      rewrites: async () => [{ source: '/old', destination: '/new' }],
    });
    const result = await out.rewrites!();
    expect(Array.isArray(result)).toBe(true);
    const arr = result as { source: string; destination: string }[];
    expect(arr[0]).toEqual({ source: '/__margo/:path*', destination: '/margo-runtime/:path*' });
    expect(arr[1]).toEqual({ source: '/old', destination: '/new' });
  });

  it('composes rewrites — structured form puts margo in beforeFiles', async () => {
    const out = withMargo({
      rewrites: async () => ({
        beforeFiles: [{ source: '/a', destination: '/b' }],
        afterFiles: [{ source: '/c', destination: '/d' }],
      }),
    });
    const result = (await out.rewrites!()) as {
      beforeFiles: { source: string; destination: string }[];
      afterFiles: { source: string; destination: string }[];
    };
    expect(result.beforeFiles[0].source).toBe('/__margo/:path*');
    expect(result.beforeFiles[1].source).toBe('/a');
    expect(result.afterFiles[0].source).toBe('/c');
  });
});

describe('handlers — Next 15+ route handler signature', () => {
  it('exports GET/POST/PATCH/DELETE that accept (Request, { params: Promise<...> })', async () => {
    // Type-level check: assigning to Next 15's route-handler shape must
    // compile. If dispatch were typed `ctx?: RouteContext`, this assignment
    // would be the spot where the Next-generated validator complains.
    type Next15RouteHandler = (
      request: Request,
      context: { params: Promise<{ path?: string[] }> },
    ) => Response | Promise<Response>;
    const _typecheck: {
      GET: Next15RouteHandler;
      POST: Next15RouteHandler;
      PATCH: Next15RouteHandler;
      DELETE: Next15RouteHandler;
    } = handlers;
    // Touch the value so the assignment isn't tree-shaken away even in
    // future ts-compiled outputs.
    expect(typeof _typecheck.GET).toBe('function');
    expect(typeof _typecheck.POST).toBe('function');
    expect(typeof _typecheck.PATCH).toBe('function');
    expect(typeof _typecheck.DELETE).toBe('function');
  });

  it('returns a 404 Response for an unknown route', async () => {
    // Smoke: call the dispatcher with the same shape Next would.
    const res = await handlers.GET(
      new Request('http://localhost/margo-runtime/nope'),
      { params: Promise.resolve({ path: ['nope'] }) },
    );
    expect(res.status).toBe(404);
  });

  it('serves overlay.js as JavaScript (or 404 if not built)', async () => {
    const res = await handlers.GET(
      new Request('http://localhost/margo-runtime/overlay.js'),
      { params: Promise.resolve({ path: ['overlay.js'] }) },
    );
    // overlay.bundle.js is produced by the build; either it's there
    // (200 + JS content-type) or the test runs against a freshly cloned
    // tree where dist/ isn't yet built (404 with a 'run npm run build'
    // hint). Both are acceptable shapes — what matters is that the
    // route dispatched correctly and didn't throw.
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.headers.get('content-type')).toContain('javascript');
    }
  });
});

describe('MargoScript — CSP nonce prop', () => {
  // Vitest defaults NODE_ENV='test', so MargoScript treats it as dev and
  // renders the element rather than null.

  it('renders a <script type="module"> with the bootstrap inline', () => {
    const el = MargoScript() as ReactScriptElement;
    expect(el).not.toBeNull();
    expect(el.type).toBe('script');
    expect(el.props.type).toBe('module');
    expect(el.props.dangerouslySetInnerHTML.__html).toContain("/__margo/overlay.js");
  });

  it('threads the nonce prop onto the rendered <script>', () => {
    const el = MargoScript({ nonce: 'abc123' }) as ReactScriptElement;
    expect(el.props.nonce).toBe('abc123');
  });

  it('omits the nonce attribute when not provided', () => {
    const el = MargoScript() as ReactScriptElement;
    expect(el.props.nonce).toBeUndefined();
  });

  it('renders null in production when MARGO_ENABLED is unset', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(MargoScript()).toBeNull();
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('renders in production when MARGO_ENABLED=1 (preview deploys)', () => {
    const originalEnv = process.env.NODE_ENV;
    const originalFlag = process.env.MARGO_ENABLED;
    process.env.NODE_ENV = 'production';
    process.env.MARGO_ENABLED = '1';
    try {
      const el = MargoScript({ nonce: 'preview-nonce' }) as ReactScriptElement;
      expect(el).not.toBeNull();
      expect(el.props.nonce).toBe('preview-nonce');
      expect(el.props['data-margo-mode']).toBe('preview');
    } finally {
      process.env.NODE_ENV = originalEnv;
      if (originalFlag === undefined) delete process.env.MARGO_ENABLED;
      else process.env.MARGO_ENABLED = originalFlag;
    }
  });
});

// The React element shape we inspect — narrow to just what we assert on,
// so we don't depend on @types/react being the version that ships ReactElement
// generics for script tags.
type ReactScriptElement = {
  type: string;
  props: {
    type: string;
    nonce?: string;
    'data-margo-mode': string;
    dangerouslySetInnerHTML: { __html: string };
  };
};
