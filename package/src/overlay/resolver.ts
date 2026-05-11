// Resolve a pinned target back to a live DOM element + rect, in priority order:
//
//   1. text + role match — most resilient against refactors
//   2. selector — handles the common "nothing changed" case fast
//   3. coords + viewport — last-resort heuristic, may have moved
//
// When the target carries a textAnchor (a phrase + before/after context), the
// returned rect is the bounding rect of that text Range, not the element's.
// This keeps the pin glued to the actual word the user clicked on rather than
// the corner of the parent paragraph.
//
// Returns 'orphaned' if nothing reasonable resolves; the caller should surface
// the comment in the inbox without rendering a pin.

import type { GapAnchor, Target, TextAnchor, ViewContext } from '../shared/types.js';
import { computeGapRect } from './pin.js';

export type ResolveResult =
  | { kind: 'exact'; el: Element; rects: DOMRect[] }
  | { kind: 'moved'; el: Element; rects: DOMRect[] }
  // Comment is for a different route — don't surface on this page at all.
  | { kind: 'wrong-route' }
  // Comment is for THIS route but the view state (tab/wizard step/accordion
  // panel/etc.) the user pinned on isn't currently shown. The anchor still
  // exists somewhere in the document; the user just hasn't navigated back
  // to that state. Treated like 'wrong-route' by the renderer — pin hidden,
  // comment stays in the inbox, NOT orphaned.
  | { kind: 'wrong-view' }
  // Comment is for THIS route but the anchored element/text no longer exists.
  // Surface in the orphan tray so the commenter knows their context was edited away.
  | { kind: 'lost-anchor' };

export function resolveTarget(target: Target, currentUrl: string): ResolveResult {
  if (target.url !== currentUrl) return { kind: 'wrong-route' };

  // Gap and box anchors take precedence — they describe a region/spacing,
  // so a single-element resolve would be wrong even if it succeeded.
  if (target.gapAnchor) {
    const gap = resolveGap(target.gapAnchor);
    if (gap) return gap;
    return { kind: 'lost-anchor' };
  }

  // Resolve cascade — each layer downgrades to `moved` (dashed pin) so the
  // user sees "may have changed." Order is from most-confident to least.
  // The goal: anchor recovery for structural changes (renames, paraphrasing,
  // tag swaps, section moves) so they don't end up in the orphan tray. Only
  // genuine deletions should fail through to lost-anchor.

  // Pre-filter helpers. Two guards run on every candidate set before we
  // consider it a match:
  //
  //   - visibility: drop elements that aren't actually rendered (display:none,
  //     0×0 rect, detached). They can't be pin anchors regardless of which
  //     resolution step found them, and including them was the proximate
  //     cause of pins being misplaced on hidden tab/wizard panels.
  //   - view-context: when target.viewContext is present, drop elements that
  //     don't belong to the same view state (different tab, different wizard
  //     step, etc.). Comments without a viewContext skip this filter and
  //     behave exactly as before — old pins keep working.
  const filterByContext = (els: Element[]): Element[] => {
    let out = els.filter(isVisible);
    if (target.viewContext) {
      // Strict filter — drop candidates that don't reproduce the captured
      // view signature. If this empties the candidate pool but there were
      // visible candidates in foreign views, `sawForeignViewCandidates`
      // (set by noteForeignView before this filter ran) tells the outer
      // function to return 'wrong-view' instead of 'lost-anchor'.
      out = out.filter((el) => viewContextMatches(el, target.viewContext!));
    }
    return out;
  };
  // True when the only candidates we found live in a different view than
  // the comment was pinned on. Used to short-circuit later resolution steps
  // and report 'wrong-view' instead of 'lost-anchor'.
  let sawForeignViewCandidates = false;
  const noteForeignView = (els: Element[]) => {
    if (!target.viewContext) return;
    if (els.some((el) => isVisible(el) && !viewContextMatches(el, target.viewContext!))) {
      sawForeignViewCandidates = true;
    }
  };

  // 1. Selector match — exact text (highest confidence)
  let selectorMatches: Element[] = [];
  try {
    selectorMatches = Array.from(document.querySelectorAll(target.selector));
    noteForeignView(selectorMatches);
    const exact = filterByContext(selectorMatches).filter((el) => matchesText(el, target.text));
    if (exact.length === 1) {
      return { kind: 'exact', el: exact[0], rects: rectsFor(exact[0], target.textAnchor) };
    }
    if (exact.length > 1) {
      const best = pickByCoords(exact, target) ?? exact[0];
      return { kind: 'moved', el: best, rects: rectsFor(best, target.textAnchor) };
    }
  } catch {
    // invalid selector — selectorMatches stays empty; fall through.
  }

  // 2. Selector still resolves but the visible text changed. Common case:
  //    a designer/dev renamed a button label or tweaked copy. The element
  //    itself is the same; we just can't text-match it anymore.
  const visibleSelectorMatches = filterByContext(selectorMatches);
  if (visibleSelectorMatches.length === 1) {
    return { kind: 'moved', el: visibleSelectorMatches[0], rects: rectsFor(visibleSelectorMatches[0], target.textAnchor) };
  }
  if (visibleSelectorMatches.length > 1) {
    const fuzzy = pickByFuzzyText(visibleSelectorMatches, target.text)
      ?? pickByCoords(visibleSelectorMatches, target)
      ?? visibleSelectorMatches[0];
    return { kind: 'moved', el: fuzzy, rects: rectsFor(fuzzy, target.textAnchor) };
  }

  // 3. Text + role exact (scan candidates)
  if (target.text) {
    const exactTextRoleRaw = textCandidates(target, { fuzzy: false, requireRole: true });
    noteForeignView(exactTextRoleRaw);
    const exactTextRole = filterByContext(exactTextRoleRaw);
    if (exactTextRole.length === 1) {
      return { kind: 'exact', el: exactTextRole[0], rects: rectsFor(exactTextRole[0], target.textAnchor) };
    }
    if (exactTextRole.length > 1) {
      const best = pickByCoords(exactTextRole, target);
      if (best) return { kind: 'moved', el: best, rects: rectsFor(best, target.textAnchor) };
    }

    // 4. Text exact, role relaxed. Catches tag swaps (h2→h1, span→p),
    //    role-attribute removals, button → link conversions etc.
    const exactTextNoRoleRaw = textCandidates(target, { fuzzy: false, requireRole: false });
    noteForeignView(exactTextNoRoleRaw);
    const exactTextNoRole = filterByContext(exactTextNoRoleRaw);
    if (exactTextNoRole.length >= 1) {
      const best = pickByCoords(exactTextNoRole, target) ?? exactTextNoRole[0];
      return { kind: 'moved', el: best, rects: rectsFor(best, target.textAnchor) };
    }

    // 5. Fuzzy text (Sørensen–Dice ≥ 0.6), role relaxed. Catches paraphrasing,
    //    typo fixes, translation, copy editing.
    const fuzzyTextRaw = textCandidates(target, { fuzzy: true, requireRole: false });
    noteForeignView(fuzzyTextRaw);
    const fuzzyText = filterByContext(fuzzyTextRaw);
    if (fuzzyText.length >= 1) {
      const best = pickByCoords(fuzzyText, target) ?? fuzzyText[0];
      return { kind: 'moved', el: best, rects: rectsFor(best, target.textAnchor) };
    }
  }

  // 6. Document-wide phrase search using the textAnchor. Catches the case
  //    where the original phrase was moved into a different parent/section
  //    so the captured selector + container both miss.
  if (target.textAnchor?.phrase) {
    const wide = findPhraseAnywhere(target.textAnchor);
    if (wide && isVisible(wide.el) && (!target.viewContext || viewContextMatches(wide.el, target.viewContext))) {
      return { kind: 'moved', el: wide.el, rects: wide.rects };
    }
    if (wide && target.viewContext && !viewContextMatches(wide.el, target.viewContext)) {
      sawForeignViewCandidates = true;
    }
  }

  // 7. Coord-based fallback (existing behavior)
  const atCoords = elementAtScaledCoords(target);
  if (atCoords && (!target.viewContext || viewContextMatches(atCoords, target.viewContext))) {
    return { kind: 'moved', el: atCoords, rects: rectsFor(atCoords, target.textAnchor) };
  }
  if (atCoords && target.viewContext && !viewContextMatches(atCoords, target.viewContext)) {
    sawForeignViewCandidates = true;
  }

  // Nothing matched in the current view. If we saw matches in OTHER views
  // (different tab, different wizard step), the anchor isn't lost — just
  // currently hidden. Tell the caller so the comment stays in the inbox
  // without polluting the orphan tray.
  if (sawForeignViewCandidates) return { kind: 'wrong-view' };
  return { kind: 'lost-anchor' };
}

function resolveGap(anchor: GapAnchor): ResolveResult | null {
  const a = findElement(anchor.first);
  const b = findElement(anchor.second);
  if (!a || !b) return null;
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  // The captured axis + order are hints, not oracles. Auto-detection at
  // capture time picks axis by larger centroid distance, which can disagree
  // with visual intent (e.g. wide h1 + narrow nav link have a wider x-delta
  // than y-delta even when they're vertically stacked). And reflow can swap
  // which element is "first". Try all (axis, order) combinations and use
  // the first that yields a positive-area gap.
  const altAxis = anchor.axis === 'vertical' ? 'horizontal' : 'vertical';
  const attempts: Array<[DOMRect, DOMRect, 'vertical' | 'horizontal']> = [
    [ra, rb, anchor.axis],
    [rb, ra, anchor.axis],
    [ra, rb, altAxis],
    [rb, ra, altAxis],
  ];
  for (const [first, second, axis] of attempts) {
    const g = computeGapRect(first, second, axis);
    if (g.width > 0 && g.height > 0) {
      // `el` is one of the boundary elements so click events + element-based
      // UI affordances still work; the rect drives visual placement.
      return { kind: 'exact', el: a, rects: [new DOMRect(g.left, g.top, g.width, g.height)] };
    }
  }
  return null;
}

function findElement(d: { selector: string; text: string; role: string }): Element | null {
  try {
    const matches = Array.from(document.querySelectorAll(d.selector))
      .filter((el) => matchesText(el, d.text));
    if (matches.length >= 1) return matches[0];
  } catch { /* invalid selector */ }
  // Fallback: scan candidates by text + role.
  if (d.text) {
    const trimmed = d.text.replace(/\.\.\.$/, '').trim();
    if (!trimmed) return null;
    const probe = trimmed.slice(0, 48);
    const candidates = Array.from(document.querySelectorAll('*')).filter((el) => {
      if (el.children.length > 0 && el.tagName !== 'BUTTON' && el.tagName !== 'A') return false;
      const t = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
      if (!t.includes(probe)) return false;
      const role = el.getAttribute('role') ?? el.tagName.toLowerCase();
      return role === d.role;
    });
    if (candidates.length >= 1) return candidates[0];
  }
  return null;
}

function rectsFor(el: Element, anchor: TextAnchor | undefined): DOMRect[] {
  if (anchor) {
    const rects = findPhraseRects(el, anchor);
    if (rects && rects.length > 0) return rects;
  }
  return [el.getBoundingClientRect()];
}

function findPhraseRects(el: Element, anchor: TextAnchor): DOMRect[] | null {
  const phrase = anchor.phrase;
  if (!phrase) return null;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  // Build a flat string with per-node offsets so we can map matches back to ranges.
  const segments: { node: Text; start: number }[] = [];
  let flat = '';
  let n: Node | null = walker.nextNode();
  while (n) {
    const t = n as Text;
    segments.push({ node: t, start: flat.length });
    flat += t.nodeValue ?? '';
    n = walker.nextNode();
  }
  if (!flat) return null;
  // Search with whitespace flexibility: collapse runs of whitespace in both
  // haystack and needle so a phrase split across text nodes still matches.
  const flatNorm = flat.replace(/\s+/g, ' ');
  const needle = phrase.replace(/\s+/g, ' ');
  const matches = allIndices(flatNorm, needle);
  if (matches.length === 0) return null;
  const flatIdx = pickMatch(flatNorm, matches, needle.length, anchor.before, anchor.after);
  // Map normalized index back to raw flat index (they differ when whitespace was collapsed).
  const rawIdx = mapNormalizedToRaw(flat, flatIdx);
  const rawEnd = mapNormalizedToRaw(flat, flatIdx + needle.length);
  const range = rangeFromFlatRange(segments, rawIdx, rawEnd);
  if (!range) return null;
  const rects = Array.from(range.getClientRects());
  if (rects.length === 0) return [range.getBoundingClientRect()];
  return rects;
}

function allIndices(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let i = 0;
  while (i <= haystack.length - needle.length) {
    const j = haystack.indexOf(needle, i);
    if (j < 0) break;
    out.push(j);
    i = j + 1;
  }
  return out;
}

function pickMatch(
  haystack: string,
  matches: number[],
  needleLen: number,
  before: string,
  after: string,
): number {
  if (matches.length === 1) return matches[0]!;
  let best = matches[0]!;
  let bestScore = -1;
  for (const m of matches) {
    const ctxBefore = haystack.slice(Math.max(0, m - 24), m);
    const ctxAfter = haystack.slice(m + needleLen, m + needleLen + 24);
    const score = (before && ctxBefore.endsWith(before) ? 2 : 0) +
                  (after && ctxAfter.startsWith(after) ? 2 : 0) +
                  (before ? sharedTail(ctxBefore, before) : 0) +
                  (after ? sharedHead(ctxAfter, after) : 0);
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return best;
}

function sharedTail(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function sharedHead(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function mapNormalizedToRaw(raw: string, normIdx: number): number {
  // Walk raw, counting normalized characters, until we hit normIdx.
  let i = 0;
  let nIdx = 0;
  let prevWasSpace = false;
  while (i < raw.length && nIdx < normIdx) {
    const c = raw[i]!;
    const isSpace = /\s/.test(c);
    if (isSpace) {
      if (!prevWasSpace) nIdx++;
      prevWasSpace = true;
    } else {
      nIdx++;
      prevWasSpace = false;
    }
    i++;
  }
  return i;
}

function rangeFromFlatRange(
  segments: { node: Text; start: number }[],
  flatStart: number,
  flatEnd: number,
): Range | null {
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;
  for (const seg of segments) {
    const segEnd = seg.start + (seg.node.nodeValue?.length ?? 0);
    if (!startNode && flatStart >= seg.start && flatStart <= segEnd) {
      startNode = seg.node;
      startOffset = flatStart - seg.start;
    }
    if (!endNode && flatEnd >= seg.start && flatEnd <= segEnd) {
      endNode = seg.node;
      endOffset = flatEnd - seg.start;
    }
    if (startNode && endNode) break;
  }
  if (!startNode || !endNode) return null;
  const r = document.createRange();
  r.setStart(startNode, startOffset);
  r.setEnd(endNode, endOffset);
  return r;
}

function matchesText(el: Element, text: string): boolean {
  if (!text) return true;
  const live = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
  return live.startsWith(text.replace(/\.\.\.$/, '').slice(0, 64));
}

function textCandidates(target: Target, opts: { fuzzy: boolean; requireRole: boolean }): Element[] {
  if (!target.text) return [];
  const trimmed = target.text.replace(/\.\.\.$/, '').trim();
  if (!trimmed) return [];
  const probe = trimmed.slice(0, 48);
  const fuzzyProbe = trimmed.slice(0, 200);
  const all = Array.from(document.querySelectorAll('*'));
  return all.filter((el) => {
    if (el.children.length > 0 && el.tagName !== 'BUTTON' && el.tagName !== 'A') return false;
    if (el.closest('[data-margo]')) return false; // never match our own UI
    const t = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
    if (!t) return false;
    if (opts.requireRole && target.role) {
      const role = el.getAttribute('role') ?? el.tagName.toLowerCase();
      if (role !== target.role) return false;
    }
    if (opts.fuzzy) {
      // Compare against the live text trimmed to the same window so a long
      // <main> doesn't always score high on overlap.
      const liveProbe = t.slice(0, 200);
      return similarity(liveProbe, fuzzyProbe) >= 0.6;
    }
    return t.includes(probe);
  });
}

// Sørensen–Dice on character bigrams. Cheap, language-agnostic, robust to
// word reordering and short edits. Returns 0–1.
function similarity(a: string, b: string): number {
  const A = a.toLowerCase().replace(/\s+/g, ' ').trim();
  const B = b.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.length < 2 || B.length < 2) return 0;
  const grams = (s: string): Map<string, number> => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const ga = grams(A);
  const gb = grams(B);
  let common = 0;
  for (const [g, n] of ga) {
    const m = gb.get(g);
    if (m) common += Math.min(n, m);
  }
  return (2 * common) / ((A.length - 1) + (B.length - 1));
}

function pickByFuzzyText(candidates: Element[], text: string): Element | null {
  if (!text) return null;
  const trimmed = text.replace(/\.\.\.$/, '').trim();
  if (!trimmed) return null;
  const target = trimmed.slice(0, 200);
  let best: Element | null = null;
  let bestScore = 0.6; // refuse to recover below this similarity
  for (const el of candidates) {
    if (el.closest('[data-margo]')) continue;
    const live = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
    const s = similarity(live, target);
    if (s > bestScore) { bestScore = s; best = el; }
  }
  return best;
}

// Document-wide search for the captured phrase. Used when the section was
// restructured and the original container no longer holds the text. Skips
// our own overlay nodes so a comment quoting the body of another comment
// can't recurse onto itself.
function findPhraseAnywhere(anchor: TextAnchor): { el: Element; rects: DOMRect[] } | null {
  const phrase = anchor.phrase;
  if (!phrase) return null;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('[data-margo]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const segments: { node: Text; start: number }[] = [];
  let flat = '';
  let n: Node | null = walker.nextNode();
  while (n) {
    const t = n as Text;
    segments.push({ node: t, start: flat.length });
    flat += t.nodeValue ?? '';
    n = walker.nextNode();
  }
  if (!flat) return null;
  const flatNorm = flat.replace(/\s+/g, ' ');
  const needle = phrase.replace(/\s+/g, ' ');
  const matches = allIndices(flatNorm, needle);
  if (matches.length === 0) return null;
  const flatIdx = pickMatch(flatNorm, matches, needle.length, anchor.before, anchor.after);
  const rawIdx = mapNormalizedToRaw(flat, flatIdx);
  const rawEnd = mapNormalizedToRaw(flat, flatIdx + needle.length);
  const range = rangeFromFlatRange(segments, rawIdx, rawEnd);
  if (!range) return null;
  const rects = Array.from(range.getClientRects());
  const container = range.commonAncestorContainer;
  const el = (container.nodeType === Node.ELEMENT_NODE
    ? (container as Element)
    : container.parentElement) ?? document.body;
  return { el, rects: rects.length > 0 ? rects : [range.getBoundingClientRect()] };
}

// Visibility — drop elements that aren't actually rendered. Caught:
//   - display:none (rect is 0×0)
//   - detached from DOM (rect is 0×0)
//   - hidden attribute (rect is 0×0 via the UA stylesheet)
// Not caught: visibility:hidden (element still occupies layout space).
// That's intentional — tab UIs almost never use visibility:hidden for
// panels, and dropping otherwise-visible elements based on a CSS property
// is more brittle than useful.
function isVisible(el: Element): boolean {
  if (el.closest('[data-margo]')) return false; // never anchor onto our own UI
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

// Compare the candidate's live ancestor chain against a captured ViewContext.
// Returns true when:
//   - the captured panel (tabpanel/dialog/region) is reachable from the
//     candidate AND its label matches (or its id, as a weaker fallback), AND
//   - every state attribute captured on an ancestor of the original element
//     is still set to the same value somewhere up the candidate's chain.
//
// Permissive by design: missing signals are treated as "doesn't disqualify"
// rather than "doesn't match", because the live DOM may not reproduce every
// signal we captured (an aria-expanded ancestor might collapse, etc.). We
// only reject when a captured signal contradicts the live one.
function viewContextMatches(el: Element, ctx: ViewContext): boolean {
  // Panel check — most discriminating signal when present.
  if (ctx.panel) {
    const want = ctx.panel;
    // The panel ancestor we're looking for: same role, ideally same id or
    // labelledBy or resolved label.
    let panelMatch = false;
    let cur: Element | null = el;
    while (cur && cur !== document.body) {
      const role = cur.getAttribute('role');
      if (role && (want.role ? role === want.role : true)) {
        const id = (cur as HTMLElement).id;
        const labelledBy = cur.getAttribute('aria-labelledby');
        let liveLabel: string | undefined;
        if (labelledBy) {
          const labelEl = cur.ownerDocument?.getElementById(labelledBy);
          liveLabel = labelEl?.textContent?.trim() || undefined;
        }
        const matchById = !!want.id && !!id && id === want.id;
        const matchByLabelledBy = !!want.labelledBy && !!labelledBy && labelledBy === want.labelledBy;
        const matchByLabel = !!want.label && !!liveLabel && liveLabel === want.label;
        if (matchById || matchByLabelledBy || matchByLabel) {
          panelMatch = true;
          break;
        }
        // Same role but different identity — a sibling panel. Keep walking
        // up in case there's a nesting (panel-in-dialog etc.); if none, the
        // outer loop will eventually fall off the document.
      }
      cur = cur.parentElement;
    }
    if (!panelMatch) return false;
  }

  // State check — every captured attribute must surface with the same value
  // somewhere on the ancestor chain. Missing the attribute entirely is also
  // a fail (the captured state has been lost).
  if (ctx.state) {
    for (const [attr, want] of Object.entries(ctx.state)) {
      let found = false;
      let cur: Element | null = el;
      while (cur && cur !== document.body) {
        const v = cur.getAttribute(attr);
        if (v === want) { found = true; break; }
        cur = cur.parentElement;
      }
      if (!found) return false;
    }
  }

  // Heading is a last-resort, weak signal. Don't reject solely because the
  // heading drifted — accept the match if panel + state passed (or were
  // absent). This lets copy edits to nearby headings not break anchoring,
  // while still letting heading text serve as the discriminator when it's
  // the only thing captured (no panel, no state).
  if (!ctx.panel && !ctx.state && ctx.nearestHeading) {
    const live = findNearestHeadingText(el);
    if (live && live !== ctx.nearestHeading) return false;
  }
  return true;
}

function findNearestHeadingText(el: Element): string | undefined {
  let cur: Element | null = el;
  while (cur && cur !== document.body) {
    let sib: Element | null = cur.previousElementSibling;
    while (sib) {
      if (/^H[1-6]$/.test(sib.tagName)) {
        const t = sib.textContent?.trim().replace(/\s+/g, ' ');
        if (t) return t.length > 80 ? t.slice(0, 77) + '...' : t;
      }
      const inner = sib.querySelector('h1, h2, h3, h4, h5, h6');
      if (inner) {
        const t = inner.textContent?.trim().replace(/\s+/g, ' ');
        if (t) return t.length > 80 ? t.slice(0, 77) + '...' : t;
      }
      sib = sib.previousElementSibling;
    }
    cur = cur.parentElement;
  }
  return undefined;
}

function pickByCoords(candidates: Element[], target: Target): Element | null {
  let best: Element | null = null;
  let bestDist = Infinity;
  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const sx = (target.coords.x / target.viewport.w) * window.innerWidth;
    const sy = (target.coords.y / target.viewport.h) * window.innerHeight;
    const d = Math.hypot(cx - sx, cy - sy);
    if (d < bestDist) { bestDist = d; best = el; }
  }
  return best;
}

function elementAtScaledCoords(target: Target): Element | null {
  const x = (target.coords.x / target.viewport.w) * window.innerWidth;
  const y = (target.coords.y / target.viewport.h) * window.innerHeight;
  const el = document.elementFromPoint(x, y);
  if (!el || el.closest('[data-margo]')) return null; // ignore overlay itself
  // Guard: only treat as "moved" if the candidate has *some* textual relation
  // to the original target. Otherwise the pin lands on a completely unrelated
  // element that merely occupies the old coordinates after layout shifted —
  // e.g. when the original element was deleted and its neighbour reflowed
  // into the same spot. In that case "lost-anchor" is more honest than
  // "moved", and the orphan tray will show the original quoted text.
  if (!hasTextualRelation(el, target)) return null;
  return el;
}

function hasTextualRelation(el: Element, target: Target): boolean {
  const needle = (target.textAnchor?.phrase ?? target.text ?? '')
    .replace(/\.\.\.$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!needle) return true; // element-only pin (icon button, image) — allow coord fallback
  const live = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!live) return false;
  // Match either way to handle (a) text moved into a wrapper and
  // (b) wrapper text was trimmed down to the original phrase.
  const probe = needle.slice(0, 32);
  if (live.includes(probe)) return true;
  if (needle.includes(live.slice(0, 32))) return true;
  return false;
}
