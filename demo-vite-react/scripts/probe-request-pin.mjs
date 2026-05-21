// Smoke test for the network-request-pin feature.
// Opens the React demo, triggers fetches against the local fake API,
// opens the margo FAB, clicks the "+ request" sub-FAB, and asserts the
// picker panel surfaces the captured requests.

import { chromium } from 'playwright';

const URL = 'http://localhost:5175/';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

// Real overlay errors only — the demo deliberately fires a 500 from
// /api/subscribe, and the browser logs that as `Failed to load resource:
// 500`. That's expected; ignore it.
const consoleErrors = [];
const isExpectedHttpFailure = (text) =>
  /Failed to load resource.*status of (4|5)\d\d/.test(text);
page.on('console', (m) => {
  if (m.type() === 'error' && !isExpectedHttpFailure(m.text())) {
    consoleErrors.push(m.text());
  }
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

// `networkidle` would never settle — the overlay holds an open SSE stream
// for /__margo/events. Wait for the document and then poll for the FAB.
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.margo-fab-main', { timeout: 15_000 });

// Generate three captured fetches the user's app would normally make.
await page.evaluate(async () => {
  await fetch('/api/health').catch(() => {});
  await fetch('/api/tiers').catch(() => {});
  await fetch('/api/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'someone-with-a-very-long-email@example.com' }),
  }).catch(() => {});
});

// Give the interceptor a moment to settle all three.
await page.waitForTimeout(500);

await page.click('.margo-fab-main');
await page.waitForSelector('.margo-launcher-request', { state: 'visible', timeout: 5000 });
await page.click('.margo-launcher-request');
await page.waitForSelector('.margo-request-panel', { state: 'visible', timeout: 5000 });

const probe = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('.margo-request-row'));
  return {
    rowCount: rows.length,
    methods: rows.map((r) => r.querySelector('.margo-request-method')?.textContent ?? ''),
    endpoints: rows.map((r) => r.querySelector('.margo-request-endpoint')?.textContent ?? ''),
    statuses: rows.map((r) => r.querySelector('.margo-request-status')?.textContent ?? ''),
    margoTraffic: rows
      .map((r) => r.querySelector('.margo-request-endpoint')?.textContent ?? '')
      .filter((s) => s.includes('__margo')),
  };
});

console.log(JSON.stringify(probe, null, 2));
if (consoleErrors.length) console.log('CONSOLE ERRORS:', consoleErrors);

const ok =
  probe.rowCount >= 3 &&
  probe.endpoints.some((e) => e.includes('/api/subscribe')) &&
  probe.endpoints.some((e) => e.includes('/api/tiers')) &&
  probe.endpoints.some((e) => e.includes('/api/health')) &&
  probe.margoTraffic.length === 0 &&
  consoleErrors.length === 0;

console.log(ok ? 'OK ✓' : 'FAIL ✗');
await browser.close();
process.exit(ok ? 0 : 1);
