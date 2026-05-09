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

import type { GapAnchor, Target, TextAnchor } from '../shared/types.js';
import { computeGapRect } from './pin.js';

export type ResolveResult =
  | { kind: 'exact'; el: Element; rects: DOMRect[] }
  | { kind: 'moved'; el: Element; rects: DOMRect[] }
  // Comment is for a different route — don't surface on this page at all.
  | { kind: 'wrong-route' }
  // Comment is for THIS route but the anchored element/text no longer exists.
  // Surface in the orphan tray so the commenter knows their context was edited away.
  | { kind: 'lost-anchor' };

export function resolveTarget(target: Target, currentUrl: string): ResolveResult {
  if (target.url !== currentUrl) return { kind: 'wrong-route' };

  // Gap anchors take precedence — they describe the space between two
  // elements, so a single-element resolve would be wrong even if it succeeded.
  if (target.gapAnchor) {
    const gap = resolveGap(target.gapAnchor);
    if (gap) return gap;
    return { kind: 'lost-anchor' };
  }

  // 1. Selector match
  // Use querySelectorAll, not querySelector: if the selector is structural
  // and matches multiple elements (e.g. `nav > a:nth-of-type(2)` after a
  // refactor duplicated the layout), silently picking the first match would
  // hide ambiguity from the user. Count matches and downgrade to "moved"
  // when there are several — the dashed pin outline tells the user "this
  // might not be on the original element."
  try {
    const all = Array.from(document.querySelectorAll(target.selector))
      .filter((el) => matchesText(el, target.text));
    if (all.length === 1) {
      return { kind: 'exact', el: all[0], rects: rectsFor(all[0], target.textAnchor) };
    }
    if (all.length > 1) {
      const best = pickByCoords(all, target) ?? all[0];
      return { kind: 'moved', el: best, rects: rectsFor(best, target.textAnchor) };
    }
  } catch {
    // invalid selector — fall through
  }

  // 2. Text + role match (scan candidates)
  if (target.text) {
    const candidates = textCandidates(target);
    if (candidates.length === 1) {
      return { kind: 'exact', el: candidates[0], rects: rectsFor(candidates[0], target.textAnchor) };
    }
    if (candidates.length > 1) {
      const best = pickByCoords(candidates, target);
      if (best) return { kind: 'moved', el: best, rects: rectsFor(best, target.textAnchor) };
    }
  }

  // 3. Coord-based fallback
  const atCoords = elementAtScaledCoords(target);
  if (atCoords) return { kind: 'moved', el: atCoords, rects: rectsFor(atCoords, target.textAnchor) };

  return { kind: 'lost-anchor' };
}

function resolveGap(anchor: GapAnchor): ResolveResult | null {
  const a = findElement(anchor.first);
  const b = findElement(anchor.second);
  if (!a || !b) return null;
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  const gap = computeGapRect(ra, rb, anchor.axis);
  // Degenerate (overlapping or touching elements) — treat as lost.
  if (gap.width <= 0 || gap.height <= 0) return null;
  // Wrap as a single DOMRect so the renderer treats it like other anchors.
  const rect = new DOMRect(gap.left, gap.top, gap.width, gap.height);
  // We deliberately use the closer element as `el` so that pin click events
  // and existing element-based UI affordances still work; the rect drives
  // visual placement.
  return { kind: 'exact', el: a, rects: [rect] };
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

function textCandidates(target: Target): Element[] {
  if (!target.text) return [];
  const trimmed = target.text.replace(/\.\.\.$/, '').trim();
  if (!trimmed) return [];
  const all = Array.from(document.querySelectorAll('*'));
  return all.filter((el) => {
    if (el.children.length > 0 && el.tagName !== 'BUTTON' && el.tagName !== 'A') return false;
    const t = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
    if (!t.includes(trimmed.slice(0, 48))) return false;
    if (target.role) {
      const role = el.getAttribute('role') ?? el.tagName.toLowerCase();
      if (role !== target.role) return false;
    }
    return true;
  });
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
