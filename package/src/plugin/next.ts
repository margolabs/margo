// Next.js umbrella entry — kept for convenience and backwards compatibility.
// Two things live here:
//
//   1. withMargo()      — next.config.* wrapper (no React, no chokidar deps).
//   2. MargoScript      — React component, re-exported from
//                          ./next-client-script.js so users still have one
//                          familiar import path for layouts.
//
// handlers is NOT re-exported from here. It lives only at
// margo-dev/next/server so that withMargo can scope the
// serverExternalPackages entry to that subpath alone — see the comment in
// next-client-script.ts for why we must keep MargoScript out of the
// externalized set.
//
// Existing route.ts files that still import { handlers } from 'margo-dev/next'
// will fail to typecheck after upgrading; the init CLI now generates
// 'margo-dev/next/server' and the README documents the rename.

export { withMargo } from './next-config.js';
export { MargoScript } from './next-client-script.js';
