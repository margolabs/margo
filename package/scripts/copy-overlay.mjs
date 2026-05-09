// Bundle the overlay into a single browser-ready ES module.
// Output: dist/overlay.bundle.js — served by the plugin at /__margo/overlay.js.

import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['src/overlay/inject.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  outfile: 'dist/overlay.bundle.js',
  sourcemap: true,
  // The overlay imports from `../shared/types.js` for type-only references;
  // TS strips those at compile, but we still want to be safe with externals.
  external: [],
  logLevel: 'info',
});

console.log('[margo build] overlay bundled to dist/overlay.bundle.js');
