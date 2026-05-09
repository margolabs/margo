// Capture a pin anchor at the moment a comment is created.
//
// Robust strategy: store multiple signals so we can re-resolve the same
// element later even if the DOM changes underneath us.
//
//   selector   — best-effort short CSS path
//   text       — visible text content (bounded to ~120 chars)
//   role       — ARIA role or tag name
//   coords     — viewport-relative anchor point (range center if textAnchor, else element center)
//   viewport   — at-time-of-pin viewport size (so coords are interpretable)
//   textAnchor — optional phrase/before/after, when the click landed on a text node

import type { GapAnchor, Target, TextAnchor } from '../shared/types.js';

export function captureTargetFromGap(first: Element, second: Element, currentUrl: string): Target {
  // Auto-detect axis from element centers — bigger delta in y means vertically
  // stacked (gap runs left-to-right between them); bigger delta in x means
  // side-by-side (gap runs top-to-bottom between them).
  const a = first.getBoundingClientRect();
  const b = second.getBoundingClientRect();
  const dx = Math.abs((a.left + a.right) / 2 - (b.left + b.right) / 2);
  const dy = Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2);
  const axis: 'vertical' | 'horizontal' = dy >= dx ? 'vertical' : 'horizontal';

  // Order so `first` is the upper / left one — keeps the rect math sane and
  // lets the resolver assume first → second runs the gap direction.
  const [topOrLeft, bottomOrRight] =
    axis === 'vertical'
      ? (a.top <= b.top ? [first, second] : [second, first])
      : (a.left <= b.left ? [first, second] : [second, first]);

  const r1 = topOrLeft.getBoundingClientRect();
  const r2 = bottomOrRight.getBoundingClientRect();
  const gap = computeGapRect(r1, r2, axis);

  const anchor: GapAnchor = {
    first: descriptor(topOrLeft),
    second: descriptor(bottomOrRight),
    axis,
  };
  return {
    url: currentUrl,
    selector: shortSelector(topOrLeft),
    text: visibleText(topOrLeft),
    role: ariaRoleOrTag(topOrLeft),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    coords: { x: Math.round(gap.left + gap.width / 2), y: Math.round(gap.top + gap.height / 2) },
    gapAnchor: anchor,
  };
}

export function computeGapRect(
  a: { left: number; top: number; right: number; bottom: number; width: number; height: number },
  b: { left: number; top: number; right: number; bottom: number; width: number; height: number },
  axis: 'vertical' | 'horizontal',
): { left: number; top: number; width: number; height: number } {
  if (axis === 'vertical') {
    const top = a.bottom;
    const bottom = b.top;
    const left = Math.max(Math.min(a.left, b.left), 0);
    const right = Math.min(Math.max(a.right, b.right), window.innerWidth);
    return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  } else {
    const left = a.right;
    const right = b.left;
    const top = Math.max(Math.min(a.top, b.top), 0);
    const bottom = Math.min(Math.max(a.bottom, b.bottom), window.innerHeight);
    return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }
}

function descriptor(el: Element) {
  return {
    selector: shortSelector(el),
    text: visibleText(el),
    role: ariaRoleOrTag(el),
  };
}

export function captureTargetFromEvent(e: MouseEvent, currentUrl: string): Target {
  const clickEl = e.target as Element;
  const range = caretRangeAtPoint(e.clientX, e.clientY);
  if (range && range.startContainer.nodeType === Node.TEXT_NODE) {
    const wordRange = expandToPhrase(range);
    if (wordRange) {
      const phrase = wordRange.toString().trim();
      if (phrase.length > 0) {
        const containerEl = wordRange.startContainer.parentElement ?? clickEl;
        const anchor = buildTextAnchor(containerEl, phrase);
        const r = wordRange.getBoundingClientRect();
        return {
          url: currentUrl,
          selector: shortSelector(containerEl),
          text: visibleText(containerEl),
          role: ariaRoleOrTag(containerEl),
          viewport: { w: window.innerWidth, h: window.innerHeight },
          coords: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
          textAnchor: anchor,
        };
      }
    }
  }
  return captureTarget(clickEl, currentUrl);
}

export function captureTargetFromRange(range: Range, currentUrl: string): Target {
  const phrase = range.toString().replace(/\s+/g, ' ').trim().slice(0, 200);
  const node = range.commonAncestorContainer;
  const containerEl = (node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement) ?? document.body;
  const anchor = buildTextAnchor(containerEl, phrase);
  const rects = range.getClientRects();
  const r = rects.length > 0 ? rects[0]! : range.getBoundingClientRect();
  return {
    url: currentUrl,
    selector: shortSelector(containerEl),
    text: visibleText(containerEl),
    role: ariaRoleOrTag(containerEl),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    coords: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
    textAnchor: anchor,
  };
}

export function captureTarget(el: Element, currentUrl: string): Target {
  const rect = el.getBoundingClientRect();
  return {
    url: currentUrl,
    selector: shortSelector(el),
    text: visibleText(el),
    role: ariaRoleOrTag(el),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    coords: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) },
  };
}

function caretRangeAtPoint(x: number, y: number): Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof doc.caretRangeFromPoint === 'function') {
    return doc.caretRangeFromPoint(x, y);
  }
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y);
    if (!pos) return null;
    const r = document.createRange();
    r.setStart(pos.offsetNode, pos.offset);
    r.setEnd(pos.offsetNode, pos.offset);
    return r;
  }
  return null;
}

function expandToPhrase(range: Range): Range | null {
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.nodeValue ?? '';
  if (!text) return null;
  const offset = Math.min(range.startOffset, text.length);
  // Expand to the surrounding word, then widen to ~6-word phrase for stability.
  let wordStart = offset;
  while (wordStart > 0 && /\S/.test(text[wordStart - 1]!)) wordStart--;
  let wordEnd = offset;
  while (wordEnd < text.length && /\S/.test(text[wordEnd]!)) wordEnd++;
  if (wordEnd === wordStart) return null;
  // Widen by including up to 3 words on each side, capped at 80 chars total.
  const phraseStart = widenLeft(text, wordStart, 3);
  const phraseEnd = widenRight(text, wordEnd, 3);
  let start = phraseStart;
  let end = phraseEnd;
  if (end - start > 80) {
    start = Math.max(phraseStart, wordStart - 20);
    end = Math.min(phraseEnd, wordEnd + 20);
  }
  const r = document.createRange();
  r.setStart(node, start);
  r.setEnd(node, end);
  return r;
}

function widenLeft(text: string, from: number, words: number): number {
  let i = from;
  let seen = 0;
  while (i > 0 && seen < words) {
    while (i > 0 && /\s/.test(text[i - 1]!)) i--;
    while (i > 0 && /\S/.test(text[i - 1]!)) i--;
    seen++;
  }
  return i;
}

function widenRight(text: string, from: number, words: number): number {
  let i = from;
  let seen = 0;
  while (i < text.length && seen < words) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    while (i < text.length && /\S/.test(text[i]!)) i++;
    seen++;
  }
  return i;
}

function buildTextAnchor(container: Element, phrase: string): TextAnchor {
  const flat = (container.textContent ?? '').replace(/\s+/g, ' ').trim();
  const idx = flat.indexOf(phrase);
  const before = idx >= 0 ? flat.slice(Math.max(0, idx - 24), idx).trim() : '';
  const after = idx >= 0 ? flat.slice(idx + phrase.length, idx + phrase.length + 24).trim() : '';
  return { phrase, before, after };
}

/**
 * Build a CSS selector that uniquely identifies the element among siblings,
 * preferring stable attributes (data-testid, id) over class names that
 * frameworks frequently rotate.
 */
function shortSelector(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body && parts.length < 6) {
    const part = nodeSelector(cur);
    parts.unshift(part);
    if ('id' in cur && (cur as HTMLElement).id) break; // anchor at first id
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}

function nodeSelector(el: Element): string {
  const id = (el as HTMLElement).id;
  if (id) return `${el.tagName.toLowerCase()}#${id}`;
  const testid = el.getAttribute('data-testid');
  if (testid) return `${el.tagName.toLowerCase()}[data-testid="${testid}"]`;
  const role = el.getAttribute('role');
  if (role) return `${el.tagName.toLowerCase()}[role="${role}"]`;
  // nth-of-type as last resort
  const parent = el.parentElement;
  if (!parent) return el.tagName.toLowerCase();
  const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
  const idx = sameTag.indexOf(el) + 1;
  return `${el.tagName.toLowerCase()}:nth-of-type(${idx})`;
}

function visibleText(el: Element): string {
  const t = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
  return t.length > 120 ? t.slice(0, 117) + '...' : t;
}

function ariaRoleOrTag(el: Element): string {
  return el.getAttribute('role') ?? el.tagName.toLowerCase();
}
