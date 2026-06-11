// withMargo(nextConfig) — Next.js config wrapper.
//
// Without this, users would have to remember two unrelated knobs in
// next.config.* (serverExternalPackages + a rewrites mapping) and risk
// breaking existing rewrites by overwriting them. Wrapping is the standard
// Next.js HOC pattern (withMDX, withSentryConfig, withBundleAnalyzer).
//
// Usage:
//
//   // next.config.ts
//   import type { NextConfig } from 'next';
//   import { withMargo } from 'margo-dev/next-config';
//
//   const nextConfig: NextConfig = { /* your stuff */ };
//   export default withMargo(nextConfig);

// We intentionally don't import NextConfig from 'next' here — the type lives
// in a peer dep, and importing it forces consumers without `next` installed
// to install it just to typecheck the package. A structural shape we can
// satisfy with `unknown` interop is plenty for what we touch.
type NextRewrite = {
  source: string;
  destination: string;
  /** Required when the rewrite needs to match origin-root URLs in a
   *  project that has a `basePath` set. Defaults to true (rewrite is
   *  auto-prefixed by the basePath). */
  basePath?: false;
};
type NextRewritesArray = NextRewrite[];
type NextRewritesObject = {
  beforeFiles?: NextRewrite[];
  afterFiles?: NextRewrite[];
  fallback?: NextRewrite[];
};
type NextRewritesResult = NextRewritesArray | NextRewritesObject;

interface MinimalNextConfig {
  /** When set, every Next route is served under this prefix (e.g.
   *  `/ui`). The overlay calls origin-root `/__margo/*` regardless, so
   *  the rewrite must use `basePath: false` + an absolute destination
   *  URL to reach the route handler under `<basePath>/margo-runtime/`. */
  basePath?: string;
  serverExternalPackages?: string[];
  rewrites?: () => Promise<NextRewritesResult> | NextRewritesResult;
  [key: string]: unknown;
}

/** Build the rewrite that exposes the overlay's `/__margo/*` URLs to
 *  the route handler at `<appRoot>/margo-runtime/`.
 *
 *  Without basePath: a simple internal rewrite. Both ends live at the
 *  origin root and Next applies the destination directly.
 *
 *  With basePath: the overlay still calls origin-root `/__margo/*`, but
 *  the route handler lives under `<basePath>/margo-runtime/`. Next
 *  forbids a `basePath: false` rewrite from targeting an internal
 *  basePath'd path via a relative destination, so the destination has
 *  to be an absolute URL. PORT is read from env at config-evaluation
 *  time — that's when Next boots and PORT reflects the dev server's
 *  port (3000 by default). */
export function makeMargoRewrite(basePath: string | undefined): NextRewrite {
  if (!basePath) {
    return { source: '/__margo/:path*', destination: '/margo-runtime/:path*' };
  }
  const port = process.env.PORT || '3000';
  return {
    source: '/__margo/:path*',
    destination: `http://localhost:${port}${basePath}/margo-runtime/:path*`,
    basePath: false,
  };
}

// Externalize chokidar specifically — NOT the whole 'margo-dev' package.
//
// Earlier versions did `serverExternalPackages: ['margo-dev']`, which
// externalized <MargoScript /> too. Externalized modules resolve their own
// dependencies — including `react` — against the package's own node_modules,
// while Next SSR uses next/dist/compiled/react. Two React instances collided
// and SSR threw "A React Element from an older version of React was rendered."
//
// The reason externalization existed at all was chokidar's optional native
// dep (fsevents.node on macOS) — webpack bundles the binary as raw bytes and
// fails with "ModuleParseError: Unexpected character". Externalizing chokidar
// directly (not the whole margo-dev) keeps that binary out of the bundle
// without touching any React-bearing code in margo. Turbopack is fine with
// chokidar bundled, but webpack mode needs this.
const EXTERNALIZED: readonly string[] = ['chokidar'];

// Return type explicitly merges in the properties we always set, so callers
// like withMargo({}) get a result whose `serverExternalPackages` and
// `rewrites` fields are visible to the type system rather than narrowed away.
type WithMargoResult<T extends MinimalNextConfig> = T & {
  serverExternalPackages: string[];
  rewrites: NonNullable<MinimalNextConfig['rewrites']>;
};

export function withMargo<T extends MinimalNextConfig>(config: T = {} as T): WithMargoResult<T> {
  // Preserve any external packages the user already configured; only add
  // ours if missing. Same for the rewrite — composed so the user's own
  // rewrites still run.
  const userExternals = config.serverExternalPackages ?? [];
  const serverExternalPackages = [
    ...userExternals,
    ...EXTERNALIZED.filter((p) => !userExternals.includes(p)),
  ];

  const margoRewrite = makeMargoRewrite(config.basePath);
  const userRewrites = config.rewrites;
  const rewrites: MinimalNextConfig['rewrites'] = async () => {
    const fromUser = userRewrites ? await userRewrites() : undefined;
    if (!fromUser) return [margoRewrite];
    if (Array.isArray(fromUser)) return [margoRewrite, ...fromUser];
    // Structured form: put margo in beforeFiles so it always wins over
    // user routes (e.g. catch-alls). Preserves user's other buckets.
    return {
      ...fromUser,
      beforeFiles: [margoRewrite, ...(fromUser.beforeFiles ?? [])],
    };
  };

  return { ...config, serverExternalPackages, rewrites };
}
