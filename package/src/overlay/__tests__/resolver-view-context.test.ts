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
