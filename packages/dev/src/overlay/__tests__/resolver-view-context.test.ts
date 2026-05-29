// @vitest-environment happy-dom
//
// Regression test for the "dot on the wrong container in another tab/wizard
// step" bug. The page has the same URL in every state; the resolver has to
// use the captured ViewContext to decide which view a comment belongs to
// and either render the pin (right view), suppress it (wrong view, but the
// anchor still exists), or orphan it (the anchor really is gone).
//
// Uses happy-dom (set via the doc-comment env directive above) rather than
// jsdom — both work, happy-dom is lighter for narrow resolver tests.

import { beforeEach, describe, expect, it } from 'vitest';
import { captureTarget, captureViewContext } from '../pin.js';
import { resolveTarget } from '../resolver.js';

const URL_HERE = 'http://localhost/dashboard';

// happy-dom: getBoundingClientRect returns 0×0 by default for elements that
// don't have layout. The visibility filter in resolver.ts treats 0×0 as
// hidden — which is exactly what we want for display:none, but means we
// need to *stub* getBoundingClientRect for elements we want the resolver
// to treat as visible. Helper does that for a subtree.
function makeVisible(el: Element, rect: { x: number; y: number; w: number; h: number }) {
  const r = new DOMRect(rect.x, rect.y, rect.w, rect.h);
  (el as HTMLElement).getBoundingClientRect = () => r;
  for (const child of Array.from(el.children)) {
    // Default children to a small box inside the parent so they're visible
    // but distinguishable. Tests override as needed.
    const cr = new DOMRect(rect.x + 4, rect.y + 4, rect.w - 8, rect.h - 8);
    (child as HTMLElement).getBoundingClientRect = () => cr;
  }
}

function makeHidden(el: Element) {
  (el as HTMLElement).style.display = 'none';
  const r = new DOMRect(0, 0, 0, 0);
  (el as HTMLElement).getBoundingClientRect = () => r;
  for (const child of Array.from(el.querySelectorAll('*'))) {
    (child as HTMLElement).getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  }
}

describe('view-context capture', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('captures the closest tabpanel + its label', () => {
    document.body.innerHTML = `
      <div role="tablist">
        <button id="tab-plans" role="tab">Plans</button>
        <button id="tab-features" role="tab">Features</button>
      </div>
      <div role="tabpanel" id="panel-plans" aria-labelledby="tab-plans">
        <article><p id="target">Custom</p></article>
      </div>
    `;
    const el = document.getElementById('target')!;
    const ctx = captureViewContext(el);
    expect(ctx?.panel?.role).toBe('tabpanel');
    expect(ctx?.panel?.id).toBe('panel-plans');
    expect(ctx?.panel?.labelledBy).toBe('tab-plans');
    expect(ctx?.panel?.label).toBe('Plans');
  });

  it('captures aria-current step for wizards', () => {
    document.body.innerHTML = `
      <ol>
        <li aria-current="step">
          <h2>Step 2: Payment</h2>
          <fieldset><label id="target">Card number</label></fieldset>
        </li>
      </ol>
    `;
    const el = document.getElementById('target')!;
    const ctx = captureViewContext(el);
    expect(ctx?.state?.['aria-current']).toBe('step');
    expect(ctx?.nearestHeading).toBe('Step 2: Payment');
  });

  it('captures the nearest preceding heading as last resort', () => {
    document.body.innerHTML = `
      <section>
        <h1>Account settings</h1>
        <div><p id="target">Some setting</p></div>
      </section>
    `;
    const el = document.getElementById('target')!;
    const ctx = captureViewContext(el);
    expect(ctx?.nearestHeading).toBe('Account settings');
  });

  it('returns undefined when there is no view signal at all', () => {
    document.body.innerHTML = `<div><p id="target">Plain text</p></div>`;
    const el = document.getElementById('target')!;
    expect(captureViewContext(el)).toBeUndefined();
  });
});

describe('resolveTarget — tab/wizard disambiguation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it("does NOT dot the other tab's lookalike container after a tab switch", () => {
    // Author the pin on Plans → Custom card.
    document.body.innerHTML = `
      <div role="tablist">
        <button id="tab-plans" role="tab">Plans</button>
        <button id="tab-features" role="tab">Features</button>
      </div>
      <div role="tabpanel" id="panel-plans" aria-labelledby="tab-plans">
        <article><p id="pin-here">Custom</p></article>
      </div>
    `;
    makeVisible(document.getElementById('panel-plans')!, { x: 0, y: 100, w: 800, h: 400 });
    const pinEl = document.getElementById('pin-here')!;
    (pinEl as HTMLElement).getBoundingClientRect = () => new DOMRect(50, 150, 200, 40);
    const target = captureTarget(pinEl, URL_HERE);
    expect(target.viewContext?.panel?.label).toBe('Plans');

    // User switches to Features. The DOM now has Features' panel mounted
    // in the same slot (React in-place swap). Features ALSO has a
    // <p>Custom</p> in a similar structural position — the bug-trigger.
    document.body.innerHTML = `
      <div role="tablist">
        <button id="tab-plans" role="tab">Plans</button>
        <button id="tab-features" role="tab">Features</button>
      </div>
      <div role="tabpanel" id="panel-features" aria-labelledby="tab-features">
        <article><p>Custom</p></article>
      </div>
    `;
    makeVisible(document.getElementById('panel-features')!, { x: 0, y: 100, w: 800, h: 400 });
    for (const p of Array.from(document.querySelectorAll('p'))) {
      (p as HTMLElement).getBoundingClientRect = () => new DOMRect(50, 150, 200, 40);
    }

    const result = resolveTarget(target, URL_HERE);
    // The bug would surface here as kind === 'exact' or 'moved' with el
    // pointing at the Features <p>. The fix returns 'wrong-view': the
    // anchor isn't lost, just behind a tab switch.
    expect(result.kind).toBe('wrong-view');
  });

  it("dots the right container when the user returns to the original tab", () => {
    document.body.innerHTML = `
      <div role="tablist">
        <button id="tab-plans" role="tab">Plans</button>
      </div>
      <div role="tabpanel" id="panel-plans" aria-labelledby="tab-plans">
        <article><p id="target">Custom</p></article>
      </div>
    `;
    makeVisible(document.getElementById('panel-plans')!, { x: 0, y: 100, w: 800, h: 400 });
    const pinEl = document.getElementById('target')!;
    (pinEl as HTMLElement).getBoundingClientRect = () => new DOMRect(50, 150, 200, 40);
    const target = captureTarget(pinEl, URL_HERE);
    const result = resolveTarget(target, URL_HERE);
    expect(result.kind).toBe('exact');
    if (result.kind === 'exact') {
      expect(result.el).toBe(pinEl);
    }
  });

  it('repro: both panels in DOM, inactive uses [hidden]; pin must not surface on the visible panel', () => {
    // Mirrors the demo-nextjs /tabs-test page after the user clicks
    // Features. Plans panel is still in the DOM, just `hidden`. Features
    // panel is visible. Both panels' middle cards have a button labeled
    // "Start free trial" — which is a substring of the captured Team card
    // textContent. That substring overlap was triggering the coord
    // fallback's hasTextualRelation() check and resolving the pin onto
    // the visible Features → Reports card.
    document.body.innerHTML = `
      <div role="tablist">
        <button id="tab-plans" role="tab">Plans</button>
        <button id="tab-features" role="tab">Features</button>
      </div>
      <div role="tabpanel" id="panel-plans" aria-labelledby="tab-plans" hidden>
        <section>
          <article data-testid="plans-starter"><h2>Starter</h2><p>$0</p><button>Start free</button></article>
          <article data-testid="plans-team"><h2>Team</h2><p>$12/seat / mo</p><ul><li>Unlimited seats</li><li>SSO + audit log</li><li>Priority support</li></ul><button>Start free trial</button></article>
          <article data-testid="plans-enterprise"><h2>Enterprise</h2><p>Custom</p><button>Talk to sales</button></article>
        </section>
      </div>
      <div role="tabpanel" id="panel-features" aria-labelledby="tab-features">
        <section>
          <article data-testid="features-billing"><h2>Billing</h2><p>Auto</p><button>Start free</button></article>
          <article data-testid="features-reports"><h2>Reports</h2><p>Weekly summaries</p><ul><li>Email digests</li><li>Trend charts</li><li>Export CSV</li></ul><button>Start free trial</button></article>
          <article data-testid="features-integrations"><h2>Integrations</h2><p>Custom</p><button>Talk to sales</button></article>
        </section>
      </div>
    `;
    // Hidden panel: zero out every descendant's rect (mirrors UA stylesheet
    // applying display:none from the hidden attribute).
    for (const el of Array.from(document.querySelector('[hidden]')!.querySelectorAll('*'))) {
      (el as HTMLElement).getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    }
    (document.querySelector('[hidden]') as HTMLElement).getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    // Visible panel: each card gets a real rect.
    makeVisible(document.getElementById('panel-features')!, { x: 0, y: 100, w: 1200, h: 400 });
    for (const a of Array.from(document.querySelectorAll('#panel-features article'))) {
      (a as HTMLElement).getBoundingClientRect = () => new DOMRect(400, 200, 300, 200);
      // Buttons inside Features → Reports must be hit-testable at the captured coords.
      const btn = a.querySelector('button');
      if (btn) (btn as HTMLElement).getBoundingClientRect = () => new DOMRect(500, 350, 120, 36);
    }
    // happy-dom doesn't implement layout, so document.elementFromPoint is a
    // no-op by default. In a real browser, the captured coords (which after
    // scaling land roughly over the Features → Reports button "Start free
    // trial") would hit that button, and hasTextualRelation would see
    // "Start free trial" as a substring of the captured Team card text —
    // tripping the coord fallback. Mirror that here so we exercise the
    // path that was actually triggering the bug in the live demo.
    const reportsButton = document.querySelector('#panel-features article[data-testid="features-reports"] button');
    (document as Document & { elementFromPoint: typeof document.elementFromPoint }).elementFromPoint = () => reportsButton ?? null;

    // The actual target captured from the user's pin on Plans → Team:
    const target = {
      url: 'http://localhost/tabs-test',
      selector: 'div#panel-plans > section:nth-of-type(1) > article[data-testid="plans-team"]',
      text: 'Team$12/seat / moUnlimited seatsSSO + audit logPriority supportStart free trial',
      role: 'article',
      viewport: { w: 2560, h: 1318 },
      coords: { x: 1390, y: 321 },
      viewContext: {
        panel: { role: 'tabpanel', id: 'panel-plans', labelledBy: 'tab-plans', label: 'Plans' },
        nearestHeading: 'Starter',
      },
    };
    const result = resolveTarget(target, 'http://localhost/tabs-test');
    expect(result.kind).toBe('wrong-view');
  });

  it('hides pins on display:none panels even when selectors match', () => {
    document.body.innerHTML = `
      <div role="tabpanel" id="panel-a" aria-labelledby="tab-a">
        <article><p id="target">Custom</p></article>
      </div>
      <div role="tabpanel" id="panel-b" aria-labelledby="tab-b">
        <article><p>Custom</p></article>
      </div>
    `;
    const labA = document.createElement('button');
    labA.id = 'tab-a';
    labA.textContent = 'Plans';
    document.body.prepend(labA);
    const pinEl = document.getElementById('target')!;
    makeVisible(document.getElementById('panel-a')!, { x: 0, y: 100, w: 800, h: 400 });
    (pinEl as HTMLElement).getBoundingClientRect = () => new DOMRect(50, 150, 200, 40);
    const target = captureTarget(pinEl, URL_HERE);

    // Now hide panel-a (user navigates away). panel-b is visible, with a
    // matching <p>Custom</p>. Without the visibility filter, the resolver
    // would land on panel-b's <p>.
    makeHidden(document.getElementById('panel-a')!);
    makeVisible(document.getElementById('panel-b')!, { x: 0, y: 100, w: 800, h: 400 });
    const labB = document.createElement('button');
    labB.id = 'tab-b';
    labB.textContent = 'Features';
    document.body.prepend(labB);
    for (const p of Array.from(document.querySelectorAll('#panel-b p'))) {
      (p as HTMLElement).getBoundingClientRect = () => new DOMRect(50, 150, 200, 40);
    }
    const result = resolveTarget(target, URL_HERE);
    expect(result.kind).toBe('wrong-view');
  });

  it('old comments without viewContext keep working (no regression)', () => {
    document.body.innerHTML = `
      <main>
        <section>
          <p id="target">Some copy</p>
        </section>
      </main>
    `;
    const el = document.getElementById('target')!;
    (el as HTMLElement).getBoundingClientRect = () => new DOMRect(0, 0, 100, 30);
    const target = captureTarget(el, URL_HERE);
    // Strip viewContext to emulate a pin captured before this feature shipped.
    delete (target as Partial<typeof target>).viewContext;
    const result = resolveTarget(target, URL_HERE);
    expect(result.kind).toBe('exact');
  });

  it('returns wrong-view (not lost-anchor) when the captured panel is hidden — even with no foreign-view candidates', () => {
    // Regression for the inbox-orphan bug: when the captured panel is the
    // only place the selector matches, AND it's currently hidden, the
    // visibility filter zeroed the candidate pool and the resolver fell
    // through to 'lost-anchor', which the inbox treats as orphaned. The
    // anchor is fine — the user has just navigated to a different view.
    document.body.innerHTML = `
      <div role="tablist">
        <button id="tab-plans" role="tab" aria-selected="false">Plans</button>
        <button id="tab-features" role="tab" aria-selected="true">Features</button>
      </div>
      <div role="tabpanel" id="panel-plans" aria-labelledby="tab-plans" hidden>
        <article data-testid="plans-team"><h2>Team</h2><button>Start free trial</button></article>
      </div>
      <div role="tabpanel" id="panel-features" aria-labelledby="tab-features">
        <article data-testid="features-reports"><h2>Reports</h2><button>Different copy</button></article>
      </div>
    `;
    // Plans panel hidden: zero rects everywhere inside.
    for (const el of Array.from(document.querySelector('#panel-plans')!.querySelectorAll('*'))) {
      (el as HTMLElement).getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    }
    (document.getElementById('panel-plans') as HTMLElement).getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    makeVisible(document.getElementById('panel-features')!, { x: 0, y: 100, w: 800, h: 400 });

    const target = {
      url: 'http://localhost/tabs-test',
      selector: 'div#panel-plans > article[data-testid="plans-team"]',
      text: 'Team Start free trial',
      role: 'article',
      viewport: { w: 1440, h: 900 },
      coords: { x: 500, y: 300 },
      viewContext: {
        panel: { role: 'tabpanel', id: 'panel-plans', labelledBy: 'tab-plans', label: 'Plans' },
      },
    };
    const result = resolveTarget(target, 'http://localhost/tabs-test');
    // Anchor exists, just hidden. Must be wrong-view, NOT lost-anchor —
    // the inbox uses lost-anchor to surface "your context was edited away"
    // which would mis-message to the user.
    expect(result.kind).toBe('wrong-view');
  });

  // Earlier tests in this file stub document.elementFromPoint to return a
  // specific element for their coord-fallback assertions. Happy-dom's
  // document is shared across tests, so without a reset the stub bleeds
  // into the next test and the cached element triggers the coord fallback
  // in ways the new test wasn't expecting.
  function resetElementFromPoint() {
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  }

  it('returns lost-anchor when a brittle nth-of-type selector coincidentally matches an unrelated link on a different page', () => {
    resetElementFromPoint();
    // Real-world repro: comment captured on a sidebar link "Capacity &
    // Health" at /admin/operation. The route was later renamed to
    // /admin/clusters, so /admin/operation is now a 404. The captured
    // selector is a brittle nth-of-type chain that happens to resolve on
    // the 404 page to an unrelated <a> (e.g. "Back to home"). Before the
    // fix, step 2 of the resolver returned that <a> as `kind: 'moved'`
    // because it was the only element matching the selector — completely
    // ignoring that the live text bears no relation to "Capacity & Health".
    // The inbox then showed the comment without an anchor-lost badge.
    document.body.innerHTML = `
      <div>
        <div>
          <div>nope</div>
          <div>
            <div>nope</div>
            <div>
              <span>nope</span>
              <span>
                <a>one</a><a>two</a><a>three</a><a>four</a><a>Back to home</a>
              </span>
            </div>
          </div>
        </div>
      </div>
    `;
    // Make the 5th <a> visible at the captured coords so the resolver
    // sees it as a candidate.
    const link = document.querySelectorAll('a')[4]!;
    (link as HTMLElement).getBoundingClientRect = () => new DOMRect(50, 100, 200, 30);
    // Ancestors visible too, so isVisible's offsetParent walk doesn't reject.
    for (
      let cur: Element | null = link;
      cur && cur !== document.body;
      cur = cur.parentElement
    ) {
      (cur as HTMLElement).getBoundingClientRect = () => new DOMRect(50, 100, 800, 400);
    }

    const target = {
      url: 'http://localhost/admin/operation',
      selector:
        'div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(2) > div:nth-of-type(2) > span:nth-of-type(2) > a:nth-of-type(5)',
      text: 'Capacity & Health',
      role: 'a',
      viewport: { w: 2560, h: 1318 },
      coords: { x: 163, y: 411 },
      viewContext: { nearestHeading: 'Fortinet' },
    };
    const result = resolveTarget(target, 'http://localhost/admin/operation');
    expect(result.kind).toBe('lost-anchor');
  });

  it('still recovers as "moved" when the selector matches AND text is similar (legitimate copy edit)', () => {
    resetElementFromPoint();
    // Counter-test: the step-2 fallback exists for the case where a dev
    // edits a button's copy but the selector still resolves to the same
    // element. The textual-relation guard must let that through — only
    // unrelated-text matches should fall through to lost-anchor.
    //
    // Setup: button text was originally "Start free trial — limited time"
    // (captured). The dev shortened it to "Start free trial". matchesText
    // (step 1) is a startsWith check against the FULL captured text, so
    // it fails. Step 2 sees a single visible selector match; the textual
    // relation holds (captured text includes live text), so accept.
    document.body.innerHTML = `
      <div>
        <button id="cta">Start free trial</button>
      </div>
    `;
    const btn = document.getElementById('cta')!;
    (btn as HTMLElement).getBoundingClientRect = () => new DOMRect(50, 100, 200, 40);
    (btn.parentElement as HTMLElement).getBoundingClientRect = () => new DOMRect(0, 0, 800, 400);

    const target = {
      url: URL_HERE,
      selector: 'div > button#cta',
      text: 'Start free trial — limited time', // captured before the copy edit
      role: 'button',
      viewport: { w: 1440, h: 900 },
      coords: { x: 100, y: 120 },
    };
    const result = resolveTarget(target, URL_HERE);
    expect(result.kind).toBe('moved');
    if (result.kind === 'moved') expect(result.el).toBe(btn);
  });

  it("returns lost-anchor when target's viewContext.nearestHeading differs from any selector-matched element on a 404-style page", () => {
    resetElementFromPoint();
    // Real-world repro #2: comment captured on a sidebar link "Capacity &
    // Health" at /admin/operation with viewContext.nearestHeading="Fortinet"
    // (the app's brand banner). The route was renamed; /admin/operation now
    // serves the Next.js built-in 404 page, which has its own h2 ("This
    // page could not be found.") with an h1 "404" as the nearest heading.
    // The captured selector ("h2") matches that h2. Before the fix:
    //   - noteForeignView(selectorMatches) saw a visible h2 whose
    //     nearestHeading="404" != "Fortinet" → viewContextMatches=false →
    //     sawForeignViewCandidates=true → resolver returned 'wrong-view',
    //     which the renderer treats as "for this route but hidden" and
    //     skips orphaning — so the inbox showed the comment with no badge.
    // After the fix:
    //   - selectorMatches no longer fires the visible-not-matching signal,
    //     so this case correctly falls through to lost-anchor.
    document.body.innerHTML = `
      <div>
        <div>
          <h1>404</h1>
          <div>
            <h2>This page could not be found.</h2>
          </div>
        </div>
      </div>
    `;
    const h2 = document.querySelector('h2')!;
    (h2 as HTMLElement).getBoundingClientRect = () => new DOMRect(100, 200, 300, 30);
    for (
      let cur: Element | null = h2;
      cur && cur !== document.body;
      cur = cur.parentElement
    ) {
      (cur as HTMLElement).getBoundingClientRect = () => new DOMRect(0, 0, 800, 400);
    }

    const target = {
      url: 'http://localhost/admin/operation',
      selector: 'h2',
      text: 'Capacity & Health dashboard overview',
      role: 'h2',
      viewport: { w: 2560, h: 1318 },
      coords: { x: 163, y: 411 },
      viewContext: { nearestHeading: 'Fortinet' },
    };
    const result = resolveTarget(target, 'http://localhost/admin/operation');
    expect(result.kind).toBe('lost-anchor');
  });

  it('returns lost-anchor when the route is now a 404-style page with no matching candidates', () => {
    resetElementFromPoint();
    // Regression guard: a comment captured on a real page (with viewContext
    // + selector + text) was showing up in the inbox WITHOUT an "anchor
    // lost" badge after the underlying page route was deleted and turned
    // into a generic 404. The 404 page has no element matching the
    // captured selector, no text overlap, no role overlap — so every step
    // in the resolver cascade should miss and the result should be
    // lost-anchor (NOT wrong-view, which would suppress the badge).
    document.body.innerHTML = `
      <div role="tablist">
        <button id="tab-plans" role="tab" aria-selected="true">Plans</button>
      </div>
      <div role="tabpanel" id="panel-plans" aria-labelledby="tab-plans">
        <article data-testid="plans-team">
          <h2>Team</h2>
          <button>Start free trial</button>
        </article>
      </div>
    `;
    makeVisible(document.getElementById('panel-plans')!, { x: 0, y: 100, w: 800, h: 400 });
    const pinEl = document.querySelector('[data-testid="plans-team"]')!;
    (pinEl as HTMLElement).getBoundingClientRect = () => new DOMRect(50, 150, 400, 200);
    const target = captureTarget(pinEl, URL_HERE);
    expect(target.role).toBe('article');
    expect(target.viewContext?.panel?.id).toBe('panel-plans');

    // Replace the page with a typical 404. No tabpanel, no article, no
    // matching IDs — just a heading and a link. Both are visible, neither
    // shares the captured 'article' role.
    document.body.innerHTML = `
      <main role="main">
        <h1>404 — Page not found</h1>
        <p>The page you were looking for doesn't exist.</p>
        <a href="/" role="link">Back to home</a>
      </main>
    `;
    makeVisible(document.querySelector('main')!, { x: 0, y: 100, w: 800, h: 400 });
    for (const el of Array.from(document.querySelectorAll('main > *'))) {
      (el as HTMLElement).getBoundingClientRect = () => new DOMRect(50, 150, 200, 40);
    }

    const result = resolveTarget(target, URL_HERE);
    expect(result.kind).toBe('lost-anchor');
  });

  it('returns lost-anchor (not wrong-view) when the anchor really is gone', () => {
    document.body.innerHTML = `
      <div role="tabpanel" id="panel-plans" aria-labelledby="tab-plans">
        <article><p id="target">Original copy</p></article>
      </div>
    `;
    const labA = document.createElement('button');
    labA.id = 'tab-plans';
    labA.textContent = 'Plans';
    document.body.prepend(labA);
    makeVisible(document.getElementById('panel-plans')!, { x: 0, y: 100, w: 800, h: 400 });
    const pinEl = document.getElementById('target')!;
    (pinEl as HTMLElement).getBoundingClientRect = () => new DOMRect(50, 150, 200, 40);
    const target = captureTarget(pinEl, URL_HERE);

    // Replace the whole document — no tab panel, no matching text anywhere.
    document.body.innerHTML = '<div>Totally unrelated content</div>';
    const result = resolveTarget(target, URL_HERE);
    expect(result.kind).toBe('lost-anchor');
  });
});
