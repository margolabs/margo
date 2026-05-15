import { defineConfig } from 'astro/config';

// Static site (default). Vercel auto-detects, builds to ./dist, serves
// from edge. No server runtime — every page is pre-rendered.
//
// To grow this into docs later: add `@astrojs/starlight` and a `/docs`
// route, or use Astro's content collections for `src/content/docs/`.
export default defineConfig({
  site: 'https://margo-dev.com',
});
