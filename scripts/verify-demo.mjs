// Boot a demo's dev script, navigate the headless browser to its URL, and
// assert the overlay mounted + /__margo/me responded. The dev process gets
// killed cleanly on exit. Run from repo root:
//
//   node scripts/verify-demo.mjs <demo-dir> <url> [<ready-pattern>]
//
// ready-pattern is a regex applied to dev-script stdout/stderr. The probe
// waits for one match before opening the browser. Default looks for either
// a Vite-style "Local:" line or Next-style "Ready in" line.

import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const [demoDir, url, readyPattern] = process.argv.slice(2);
if (!demoDir || !url) {
  console.error('usage: node scripts/verify-demo.mjs <demo-dir> <url> [<ready-pattern>]');
  process.exit(2);
}

const pattern = new RegExp(readyPattern ?? 'Local:\\s+http|Ready in');

console.log(`\n=== ${demoDir} ===`);

const dev = spawn('npm', ['run', 'dev'], {
  cwd: demoDir,
  stdio: ['ignore', 'pipe', 'pipe'],
  // Ensure children get killed when we kill the group leader.
  detached: false,
});

let ready = false;
function watch(stream, label) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    process.stdout.write(`[${label}] ${chunk}`);
    if (pattern.test(chunk)) ready = true;
  });
}
watch(dev.stdout, demoDir);
watch(dev.stderr, demoDir);

const deadline = Date.now() + 60_000;
while (!ready && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 250));
}
if (!ready) {
  console.error('TIMED OUT waiting for dev server ready');
  killTree();
  process.exit(1);
}

// Give Vite/Next a beat after "ready" to finish wiring middleware.
await new Promise((r) => setTimeout(r, 1500));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});

let probe;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.margo-fab-main', { timeout: 15_000 });
  probe = await page.evaluate(async () => {
    const list = await fetch('/__margo/list').then((r) => r.json()).catch((e) => ({ error: String(e) }));
    const me = await fetch('/__margo/me').then((r) => r.json()).catch((e) => ({ error: String(e) }));
    return {
      fabMain: !!document.querySelector('.margo-fab-main'),
      overlayRoot: !!document.getElementById('margo-overlay-root'),
      pinScript: !!document.querySelector('script[data-margo], script[src*="/__margo/bootstrap.js"]'),
      me,
      listCommentCount: list?.comments?.length ?? null,
    };
  });
} catch (err) {
  console.error(`\nPROBE ERROR for ${demoDir}:`, err.message);
  await browser.close();
  killTree();
  process.exit(1);
}

await browser.close();
killTree();

const ok =
  probe.fabMain &&
  probe.overlayRoot &&
  probe.me &&
  !('error' in probe.me) &&
  probe.me.email;

console.log('\nprobe:', JSON.stringify(probe, null, 2));
if (errors.length) console.log('console errors:', errors);
console.log(ok ? `${demoDir}: OK ✓` : `${demoDir}: FAIL ✗`);
process.exit(ok ? 0 : 1);

function killTree() {
  if (!dev.killed) {
    try { dev.kill('SIGINT'); } catch {}
    setTimeout(() => { try { dev.kill('SIGKILL'); } catch {} }, 1500);
  }
}
