// Diagnostic: open the demo, surface the inbox, and probe the scroll container.
//
// Usage: node scripts/debug-inbox-scroll.mjs [url]
//
// Prints computed styles, scroll geometry, and the result of a programmatic
// scroll attempt. If scrollTop stays at 0 after assignment, the container
// isn't scrollable and we know the fix didn't land.

import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:3000/';

const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('[browser]', msg.text());
});

await page.goto(url, { waitUntil: 'domcontentloaded' });

// Wait for overlay to mount. The primary FAB trigger expands the sub-menu.
await page.waitForSelector('.margo-fab-main', { timeout: 8000 });
await page.click('.margo-fab-main');
await page.waitForSelector('.margo-inbox-toggle', { state: 'visible', timeout: 4000 });

// Open inbox.
await page.click('.margo-inbox-toggle');
await page.waitForSelector('.margo-inbox-list', { state: 'visible', timeout: 4000 });

// Move mouse over the list, then dispatch a real wheel event the way the
// browser would for a touchpad gesture. If list scrolls = wheel routing is
// healthy. If body scrolls = something is eating the event on the list.
const listBox = await page.locator('.margo-inbox-list').boundingBox();
const cx = listBox.x + listBox.width / 2;
const cy = listBox.y + listBox.height / 2;
await page.mouse.move(cx, cy);

// What element is actually at that point? If it's not inside the list, wheel
// goes elsewhere.
const elemPath = await page.evaluate(({ x, y }) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return 'no element';
  const path = [];
  let cur = el;
  for (let i = 0; i < 6 && cur; i++) {
    path.push(`${cur.tagName.toLowerCase()}.${(cur.className || '').toString().split(' ').filter(Boolean).join('.') || '<no-class>'}`);
    cur = cur.parentElement;
  }
  return path.join(' < ');
}, { x: cx, y: cy });
console.log('element under cursor:', elemPath);

// Pre-flight: install a global wheel listener that logs which element fired
// it. Will print after we dispatch the wheel.
await page.evaluate(() => {
  globalThis.__margoWheelLog = [];
  window.addEventListener('wheel', (e) => {
    const t = e.target;
    const name = `${t.tagName.toLowerCase()}.${(t.className || '').toString().split(' ').filter(Boolean).join('.')}`;
    globalThis.__margoWheelLog.push({
      target: name,
      deltaY: e.deltaY,
      defaultPrevented: e.defaultPrevented,
      cancelable: e.cancelable,
      phase: e.eventPhase,
    });
  }, true); // capture
});
const bodyScrollBefore = await page.evaluate(() => window.scrollY);
const listScrollBefore = await page.evaluate(
  () => document.querySelector('.margo-inbox-list').scrollTop,
);
// Sanity: is the body even scrollable on this route?
const bodyScrollable = await page.evaluate(() => ({
  scrollHeight: document.documentElement.scrollHeight,
  clientHeight: document.documentElement.clientHeight,
}));
console.log(`body scrollHeight=${bodyScrollable.scrollHeight}, clientHeight=${bodyScrollable.clientHeight}`);

await page.mouse.wheel(0, 600);
await page.waitForTimeout(300);
const wheelLog = await page.evaluate(() => globalThis.__margoWheelLog);
console.log('wheel events captured:', JSON.stringify(wheelLog, null, 2));

// Test 2: also try wheel over the BODY (outside the inbox) on /scroll-test
// to confirm Playwright's mouse.wheel works at all.

// Also try a real-browser-style cancelable wheel via dispatchEvent on the list.
// If THIS scrolls but mouse.wheel doesn't, the issue is Playwright's synth wheel.
await page.evaluate(({ x, y }) => {
  const el = document.elementFromPoint(x, y);
  const evt = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaY: 600,
    clientX: x,
    clientY: y,
  });
  el.dispatchEvent(evt);
}, { x: cx, y: cy });
await page.waitForTimeout(150);
const listAfterDispatch = await page.evaluate(
  () => document.querySelector('.margo-inbox-list').scrollTop,
);
console.log(`list scrollTop after dispatchEvent wheel: ${listAfterDispatch}`);
const bodyScrollAfter = await page.evaluate(() => window.scrollY);
const listScrollAfter = await page.evaluate(
  () => document.querySelector('.margo-inbox-list').scrollTop,
);
console.log('wheel event test:');
console.log(`  body scrollY:    ${bodyScrollBefore} → ${bodyScrollAfter}`);
console.log(`  list scrollTop:  ${listScrollBefore} → ${listScrollAfter}`);
console.log(
  `  verdict: wheel scrolled the ${
    listScrollAfter > listScrollBefore ? 'LIST ✓' : bodyScrollAfter > bodyScrollBefore ? 'BODY (bug)' : 'NOTHING'
  }`,
);

// Reset list scroll for the static probe below.
await page.evaluate(() => {
  document.querySelector('.margo-inbox-list').scrollTop = 0;
});

// CRITICAL: does scrollTop survive across scroll events / rAF ticks?
// The bug was: every scroll fired renderInbox, which set innerHTML, which
// reset scrollTop to 0. So scroll-and-wait should show retention.
const retention = await page.evaluate(async () => {
  const list = document.querySelector('.margo-inbox-list');
  list.scrollTop = 500;
  // Fire a real scroll event so the capture-phase window listener runs.
  list.dispatchEvent(new Event('scroll', { bubbles: true }));
  // Wait two animation frames (schedule rAF + safety frame).
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise((r) => setTimeout(r, 100));
  return list.scrollTop;
});
console.log(`scrollTop retention after scroll event + 2 rAFs: ${retention}`);
console.log(`  verdict: ${retention === 500 ? 'PRESERVED ✓' : `RESET to ${retention} (renderInbox is still firing on scroll)`}`);

await page.evaluate(() => {
  document.querySelector('.margo-inbox-list').scrollTop = 0;
});

const probe = await page.evaluate(() => {
  const panel = document.querySelector('.margo-inbox');
  const list = document.querySelector('.margo-inbox-list');
  if (!panel || !list) return { error: 'panel or list missing' };

  const cs = (el) => getComputedStyle(el);
  const panelCS = cs(panel);
  const listCS = cs(list);

  // Try a programmatic scroll. If scrollTop stays at 0 after assignment,
  // there's nothing scrollable in this element.
  const before = list.scrollTop;
  list.scrollTop = 500;
  const after = list.scrollTop;

  return {
    panel: {
      position: panelCS.position,
      display: panelCS.display,
      flexDirection: panelCS.flexDirection,
      overflow: panelCS.overflow,
      height: panel.offsetHeight,
      clientHeight: panel.clientHeight,
    },
    list: {
      minHeight: listCS.minHeight,
      maxHeight: listCS.maxHeight,
      height: listCS.height,
      overflow: listCS.overflow,
      overflowY: listCS.overflowY,
      overscrollBehavior: listCS.overscrollBehavior,
      pointerEvents: listCS.pointerEvents,
      touchAction: listCS.touchAction,
      flex: `${listCS.flexGrow} ${listCS.flexShrink} ${listCS.flexBasis}`,
      offsetHeight: list.offsetHeight,
      clientHeight: list.clientHeight,
      scrollHeight: list.scrollHeight,
      isScrollable: list.scrollHeight > list.clientHeight,
      programmaticScrollWorked: before === 0 && after > 0,
      scrollTopBefore: before,
      scrollTopAfter: after,
      childCount: list.children.length,
    },
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
  };
});

console.log(JSON.stringify(probe, null, 2));

await browser.close();
