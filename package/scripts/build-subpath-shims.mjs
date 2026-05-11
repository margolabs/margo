// Generates shim entry files at top-level published paths so Next.js's
// serverExternalPackages can target the server subpath cleanly.
//
// Next matches `serverExternalPackages` entries by testing the resolved file
// path with a regex like  /[\/\\]node_modules[\/\\]margo-dev[\/\\]next[\/\\]server[\/\\]/
// (see node_modules/next/dist/build/webpack-config.js — optOutBundlingPackageRegex).
// A resolved path under `node_modules/margo-dev/dist/plugin/next-server.js`
// does NOT match because of the `dist/` segment, so the package wouldn't get
// externalized and chokidar/git would end up bundled by webpack/turbopack.
//
// Fix: ship a thin shim at `next/server/index.js` (and `next/client-script/
// index.js`) that re-exports from the real compiled file under `dist/`.
// Once the entry path matches the regex, Next externalizes the request and
// Node loads the shim at runtime — Node then follows the relative re-export
// into `dist/` normally. Webpack/Turbopack never see the chokidar imports
// because externalized modules are opaque to the bundler.

import { mkdirSync, writeFileSync } from 'node:fs';

const SHIMS = [
  {
    dir: 'next/server',
    targetFromShim: '../../dist/plugin/next-server.js',
    typesFromShim: '../../dist/plugin/next-server.js',
  },
  {
    dir: 'next/client-script',
    targetFromShim: '../../dist/plugin/next-client-script.js',
    typesFromShim: '../../dist/plugin/next-client-script.js',
  },
];

for (const { dir, targetFromShim, typesFromShim } of SHIMS) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    `${dir}/index.js`,
    `// Auto-generated shim — see scripts/build-subpath-shims.mjs.\n` +
      `// This file exists so the resolved path under node_modules matches\n` +
      `// Next.js's serverExternalPackages regex (which keys off the literal\n` +
      `// directory chain, not the import specifier).\n` +
      `export * from '${targetFromShim}';\n`,
  );
  writeFileSync(
    `${dir}/index.d.ts`,
    `// Auto-generated shim — see scripts/build-subpath-shims.mjs.\n` +
      `export * from '${typesFromShim.replace(/\.js$/, '.js')}';\n`,
  );
}

console.log(`[margo build] generated ${SHIMS.length} subpath shims`);
