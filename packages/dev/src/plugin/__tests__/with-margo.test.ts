// Tests for the withMargo(nextConfig) wrapper. The 0.4.x line saw a real
// user trip over the basePath case: when their Next app set
// basePath:'/ui', our rewrite source ended up at '/ui/__margo/*' (Next
// auto-prefixes the basePath onto rewrites unless told otherwise), while
// the overlay always calls origin-root '/__margo/*'. Result: 404 on
// every overlay request, the user had to hand-write a custom rewrite
// with basePath:false + an absolute destination URL.
//
// makeMargoRewrite + withMargo now do that automatically. These tests
// pin the contract so the no-basePath case stays byte-identical to the
// old behavior and the basePath case matches Next's API rules.

import { describe, expect, it } from 'vitest';
import { withMargo, makeMargoRewrite } from '../next-config.js';

describe('makeMargoRewrite', () => {
  it('returns a simple internal rewrite when basePath is unset', () => {
    expect(makeMargoRewrite(undefined)).toEqual({
      source: '/__margo/:path*',
      destination: '/margo-runtime/:path*',
    });
  });

  it('returns the same simple rewrite for an empty-string basePath', () => {
    // Defensive: some users set basePath:'' to mean "no prefix"; treat
    // that the same as undefined.
    expect(makeMargoRewrite('')).toEqual({
      source: '/__margo/:path*',
      destination: '/margo-runtime/:path*',
    });
  });

  it('emits basePath:false + absolute destination when basePath is set', () => {
    const originalPort = process.env.PORT;
    delete process.env.PORT;
    try {
      const r = makeMargoRewrite('/ui');
      expect(r.source).toBe('/__margo/:path*');
      expect(r.basePath).toBe(false);
      // Absolute URL so Next allows the basePath:false→basePath'd
      // destination combo. Default port 3000 when PORT is unset.
      expect(r.destination).toBe('http://localhost:3000/ui/margo-runtime/:path*');
    } finally {
      if (originalPort === undefined) delete process.env.PORT;
      else process.env.PORT = originalPort;
    }
  });

  it('honors PORT env var in the absolute destination URL', () => {
    const originalPort = process.env.PORT;
    process.env.PORT = '4321';
    try {
      const r = makeMargoRewrite('/admin');
      expect(r.destination).toBe('http://localhost:4321/admin/margo-runtime/:path*');
    } finally {
      if (originalPort === undefined) delete process.env.PORT;
      else process.env.PORT = originalPort;
    }
  });
});

describe('withMargo — composed rewrites + serverExternalPackages', () => {
  it('returns the simple rewrite (no basePath) inside an empty config', async () => {
    const wrapped = withMargo({});
    const rewrites = await wrapped.rewrites();
    expect(rewrites).toEqual([{
      source: '/__margo/:path*',
      destination: '/margo-runtime/:path*',
    }]);
  });

  it('returns the basePath-aware rewrite when basePath is set', async () => {
    const originalPort = process.env.PORT;
    delete process.env.PORT;
    try {
      const wrapped = withMargo({ basePath: '/ui' });
      const rewrites = await wrapped.rewrites();
      expect(rewrites).toEqual([{
        source: '/__margo/:path*',
        destination: 'http://localhost:3000/ui/margo-runtime/:path*',
        basePath: false,
      }]);
    } finally {
      if (originalPort === undefined) delete process.env.PORT;
      else process.env.PORT = originalPort;
    }
  });

  it('externalizes chokidar in serverExternalPackages', () => {
    expect(withMargo({}).serverExternalPackages).toContain('chokidar');
  });

  it("preserves the user's existing serverExternalPackages", () => {
    const result = withMargo({ serverExternalPackages: ['some-other-package'] });
    expect(result.serverExternalPackages).toContain('some-other-package');
    expect(result.serverExternalPackages).toContain('chokidar');
  });

  it("doesn't duplicate chokidar if the user already listed it", () => {
    const result = withMargo({ serverExternalPackages: ['chokidar'] });
    const count = result.serverExternalPackages.filter((p) => p === 'chokidar').length;
    expect(count).toBe(1);
  });

  it("composes with the user's existing rewrites (array form)", async () => {
    const user = [{ source: '/foo', destination: '/bar' }];
    const wrapped = withMargo({ rewrites: () => user });
    const result = await wrapped.rewrites();
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result[0].source).toBe('/__margo/:path*');
      // The user's rewrites come after margo's so margo's catch-all
      // always wins over their general routes.
      expect(result[1]).toEqual(user[0]);
    }
  });

  it("composes with the user's existing rewrites (structured form)", async () => {
    const user = {
      beforeFiles: [{ source: '/early', destination: '/here-first' }],
      afterFiles: [{ source: '/late', destination: '/here-later' }],
    };
    const wrapped = withMargo({ rewrites: () => user });
    const result = await wrapped.rewrites();
    expect(Array.isArray(result)).toBe(false);
    if (!Array.isArray(result)) {
      // Margo goes first in beforeFiles so it always matches before any
      // user route. Other buckets preserved verbatim.
      expect(result.beforeFiles?.[0].source).toBe('/__margo/:path*');
      expect(result.beforeFiles?.[1]).toEqual(user.beforeFiles[0]);
      expect(result.afterFiles).toEqual(user.afterFiles);
    }
  });

  it("preserves arbitrary user config fields verbatim", () => {
    const wrapped = withMargo({ basePath: '/ui', reactStrictMode: true, output: 'standalone' } as Record<string, unknown>);
    expect((wrapped as Record<string, unknown>).reactStrictMode).toBe(true);
    expect((wrapped as Record<string, unknown>).output).toBe('standalone');
    expect((wrapped as Record<string, unknown>).basePath).toBe('/ui');
  });
});
