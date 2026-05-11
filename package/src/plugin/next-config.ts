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
type NextRewrite = { source: string; destination: string };
type NextRewritesArray = NextRewrite[];
type NextRewritesObject = {
  beforeFiles?: NextRewrite[];
  afterFiles?: NextRewrite[];
  fallback?: NextRewrite[];
};
type NextRewritesResult = NextRewritesArray | NextRewritesObject;

interface MinimalNextConfig {
  serverExternalPackages?: string[];
  rewrites?: () => Promise<NextRewritesResult> | NextRewritesResult;
  [key: string]: unknown;
}

const MARGO_REWRITE: NextRewrite = {
  source: '/__margo/:path*',
  destination: '/margo-runtime/:path*',
};

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

  const userRewrites = config.rewrites;
  const rewrites: MinimalNextConfig['rewrites'] = async () => {
    const fromUser = userRewrites ? await userRewrites() : undefined;
    if (!fromUser) return [MARGO_REWRITE];
    if (Array.isArray(fromUser)) return [MARGO_REWRITE, ...fromUser];
    // Structured form: put margo in beforeFiles so it always wins over
    // user routes (e.g. catch-alls). Preserves user's other buckets.
    return {
      ...fromUser,
      beforeFiles: [MARGO_REWRITE, ...(fromUser.beforeFiles ?? [])],
    };
  };

  return { ...config, serverExternalPackages, rewrites };
}
