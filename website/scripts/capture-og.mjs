// Capture an Open Graph / Twitter card image from the live margo-dev.com
// hero. Waits for the hero animation to reach its "fixed" final state (both
// pins green, CTA green, SAML clarifier revealed, terminal shows the diff),
// then snapshots a 1200×630 viewport. Output → website/public/og.png.
//
// Run: cd website && node scripts/capture-og.mjs

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, '..', 'public', 'og.png');
const URL = process.env.OG_URL ?? 'https://www.margo-dev.com';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  // Standard Open Graph / Twitter card size. Both Facebook and Twitter
  // crop or pad at this ratio (1.91:1). deviceScaleFactor stays at 1 so
  // the output PNG is exactly 1200×630 — OG validators flag any deviation
  // from those exact dimensions (cropping/padding is platform-dependent).
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 1,
});

await page.goto(URL, { waitUntil: 'networkidle' });

// Wait for the hero animation to land its `.fix-landed` state (pins green,
// CTA green, SAML revealed). Timeout generous because the full loop is
// ~17s and we might enter mid-cycle.
console.log('waiting for .hero-demo.fix-landed …');
await page.waitForSelector('.hero-demo.fix-landed', { timeout: 30_000 });
// Brief settle so transitions finish.
await page.waitForTimeout(400);

await page.screenshot({ path: OUT_PATH, omitBackground: false });
console.log(`wrote ${OUT_PATH}`);

await browser.close();
