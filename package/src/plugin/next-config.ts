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
//   import { withMargo } from 'margo-dev/next/config';
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

// Only the server subpath is externalized — never the whole 'margo-dev'
// package. Externalizing the whole package also caught margo-dev/next
// (the umbrella) and margo-dev/next/client-script, forcing <MargoScript />
// to resolve `react` from node_modules/react while Next SSR uses
// next/dist/compiled/react. Two React instances collided and SSR threw
// "A React Element from an older version of React was rendered."
//
// Next matches serverExternalPackages entries against the resolved
// file path with a regex like [/\\]node_modules[/\\]margo-dev[/\\]next[/\\]server[/\\]
// (see next/dist/build/webpack-config.js — optOutBundlingPackageRegex).
// To make that match work, the build emits a thin shim at
// node_modules/margo-dev/next/server/index.js that re-exports the real
// compiled module from dist/ — see scripts/build-subpath-shims.mjs.
// Only the entry path needs to match; transitive imports inside an
// externalized module are resolved by Node at runtime, not by webpack.
const MARGO_SERVER_PACKAGE = 'margo-dev/next/server';

export function withMargo<T extends MinimalNextConfig>(config: T = {} as T): T {
  // Preserve any external packages the user already configured; only add
  // ours if it's missing. Same for the rewrite — wrapped via composition
  // so the user's own rewrites still run.
  const userExternals = config.serverExternalPackages ?? [];
  const serverExternalPackages = userExternals.includes(MARGO_SERVER_PACKAGE)
    ? userExternals
    : [...userExternals, MARGO_SERVER_PACKAGE];

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
