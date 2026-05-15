// End-to-end probe: boots Angular's dev server (via npm run dev), waits for
// readiness, opens the page in headless Chromium, and asserts the overlay
// mounted (FAB rendered + /__margo/list responded). Use when you change the
// sidecar or proxy config to confirm the round-trip still works.
//
// Run: node scripts/verify-overlay.mjs

import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const dev = spawn('npm', ['run', 'dev'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
let ngReady = false;
let margoReady = false;

function watch(stream) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    process.stdout.write(`[dev] ${chunk}`);
    if (/Local:\s+http:\/\/localhost:4200/.test(chunk)) ngReady = true;
    if (/serve listening on http:\/\/localhost:3001/.test(chunk)) margoReady = true;
  });
}
watch(dev.stdout);
watch(dev.stderr);

const deadline = Date.now() + 60_000;
while ((!ngReady || !margoReady) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 250));
}
if (!ngReady || !margoReady) {
  console.error('timed out waiting for ng/margo to be ready');
  dev.kill('SIGINT');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (msg) => {
  if (msg.type() === 'error' || /margo/i.test(msg.text())) {
    console.log(`[browser:${msg.type()}] ${msg.text()}`);
  }
});

await page.goto('http://localhost:4200/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.margo-fab-main', { timeout: 10_000 });

const probe = await page.evaluate(async () => {
  const list = await fetch('/__margo/list').then((r) => r.json());
  const me = await fetch('/__margo/me').then((r) => r.json());
  return {
    fabMain: !!document.querySelector('.margo-fab-main'),
    overlayLoaded: !!document.getElementById('margo-overlay-root'),
    me,
    listCount: list.comments.length,
  };
});

console.log('probe:', JSON.stringify(probe, null, 2));
const ok = probe.fabMain && probe.overlayLoaded && probe.me?.email;
console.log(ok ? 'OK ✓' : 'FAIL ✗');

await browser.close();
dev.kill('SIGINT');
process.exit(ok ? 0 : 1);
