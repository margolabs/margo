// Next.js umbrella entry. Re-exports the public surface so existing user
// imports `from 'margo-dev/next'` keep working. The split-out subpaths
// (margo-dev/next-server, margo-dev/next-client-script, margo-dev/next-config)
// exist because Turbopack's resolver chokes on subpath exports whose keys
// contain a `/` — `./next/server` consistently fails to resolve even when
// the file is on disk, while flat keys like `./next-server` resolve cleanly.
//
// handlers lives at margo-dev/next-server only — re-exporting it from the
// umbrella would drag chokidar through Next's compiled bundle for any caller
// that touches the umbrella, since the umbrella is the import-graph entry.
// Layouts/configs that don't touch the route handler stay light.

export { withMargo } from './next-config.js';
export { MargoScript, type MargoScriptProps } from './next-client-script.js';
