// Overlay entry point — loaded into the running app via the Vite plugin.
// Renders pins for existing comments, captures targets for new ones, and
// stays in sync with the local margo server via SSE.
//
// Intentionally plain DOM + minimal CSS: this code lives inside the host
// app's page, and we cannot assume any framework or styling library.

import { captureTarget, captureTargetFromEvent, captureTargetFromGap, captureTargetFromRange } from './pin.js';
import { resolveTarget } from './resolver.js';
import { installRouteTracker, onRouteChange, currentRoute } from './route-tracker.js';
import { SyncClient, type SyncEvent } from './sync.js';
import type { Comment, CommentType } from '../shared/types.js';

interface StartOptions {
  mode: 'dev' | 'preview';
}

const ROOT_ID = 'margo-overlay-root';
const STYLE_ID = 'margo-overlay-style';

export function start(opts: StartOptions): void {
  if (document.getElementById(ROOT_ID)) return; // already started
  injectStyles();
  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.dataset.margo = '';
  root.dataset.mode = opts.mode;
  document.body.appendChild(root);

  const sync = new SyncClient();
  const store = new Map<string, Comment>();
  // Holds the local git user once /__margo/me resolves. Used to gate the
  // own-only delete affordance — null while the fetch is in flight or in
  // preview mode (where we don't ask the backend at all).
  let me: { email: string } | null = null;
  // Persist the "show resolved" choice across reloads — surveying past
  // decisions is a recurring task, so the user shouldn't have to re-toggle.
  const showResolvedKey = 'margo:showResolved';
  let showResolved = localStorage.getItem(showResolvedKey) === '1';

  const renderPins = () => renderAllPins(root, store, sync, opts.mode === 'preview', me, showResolved);

  sync.addEventListener('event', (ev) => {
    const e = (ev as CustomEvent<SyncEvent>).detail;
    if (e.type === 'snapshot') {
      store.clear();
      for (const c of e.comments) store.set(c.frontmatter.id, c);
      renderPins();
    }
    // For created / updated / deleted, naive refetch keeps things simple in v0.
    // Optimization (delta fetches) deferred.
    if (e.type === 'created' || e.type === 'updated' || e.type === 'deleted') {
      void refetchAndRender(sync, store, renderPins);
    }
  });

  sync.start();
  if (opts.mode === 'dev') {
    void sync.getMe().then((u) => { me = u; renderPins(); });
  }
  // Toggle is rendered once and lives outside renderAllPins (which clears its
  // own children every cycle). The button mutates `showResolved` and triggers
  // a re-render — no need to re-create the toggle each time.
  renderShowResolvedToggle(root, showResolved, (next) => {
    showResolved = next;
    localStorage.setItem(showResolvedKey, next ? '1' : '0');
    renderPins();
  });
  installRouteTracker();
  onRouteChange(renderPins);

  // Re-render on layout shifts so pins follow text reflow at any viewport size.
  // rAF-debounced: coalesces bursts of resize/mutation events into one frame.
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; renderPins(); });
  };
  window.addEventListener('resize', schedule);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(schedule).observe(document.documentElement);
  }
  // Catch DOM mutations (font load, async content) that change phrase positions.
  // Skip mutations inside the overlay itself, otherwise rendering pins triggers
  // the observer and we infinite-loop.
  new MutationObserver((records) => {
    for (const m of records) {
      const t = m.target as Node;
      if (t.nodeType === Node.ELEMENT_NODE && (t as Element).closest('[data-margo]')) continue;
      schedule();
      return;
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  if (opts.mode === 'dev') {
    enablePinComposer(root, sync, renderPins);
  }
}

async function refetchAndRender(
  sync: SyncClient,
  store: Map<string, Comment>,
  renderPins: () => void,
): Promise<void> {
  const res = await fetch('/__margo/list');
  if (!res.ok) return;
  const { comments } = (await res.json()) as { comments: Comment[] };
  store.clear();
  for (const c of comments) store.set(c.frontmatter.id, c);
  renderPins();
}

function renderAllPins(
  root: HTMLElement,
  store: Map<string, Comment>,
  sync: SyncClient,
  readOnly: boolean,
  me: { email: string } | null,
  showResolved: boolean,
): void {
  // Clear existing pin + highlight + tray + bulk-action nodes (keep the launcher and toggle)
  for (const el of Array.from(root.querySelectorAll('[data-margo-pin],[data-margo-highlight],[data-margo-tray],[data-margo-bulk]'))) el.remove();
  const url = currentRoute();
  const orphans: Comment[] = [];
  const onPage: Comment[] = []; // unresolved-only — bulk resolve operates on these
  for (const c of store.values()) {
    const isResolved = c.frontmatter.status === 'resolved' || c.frontmatter.status === 'wontfix';
    if (isResolved && !showResolved) continue;
    const result = resolveTarget(c.frontmatter.target, url);
    if (result.kind === 'wrong-route') continue;
    if (result.kind === 'lost-anchor') {
      orphans.push(c);
      continue;
    }
    if (!isResolved) onPage.push(c);
    const rects = result.rects;
    const isTextAnchor = !!c.frontmatter.target.textAnchor;
    const isGapAnchor = !!c.frontmatter.target.gapAnchor;

    // Draw highlight rects under the pin so the user can see what was anchored.
    // - text anchors: one rect per visual line of the phrase
    // - gap anchors: the rect between the two boundary elements (hatched)
    // - element anchors: a single rect outlining the element
    for (const r of rects) {
      const hl = document.createElement('div');
      hl.dataset.margoHighlight = c.frontmatter.id;
      hl.className = isGapAnchor
        ? 'margo-hl margo-hl-gap'
        : isTextAnchor ? 'margo-hl margo-hl-text' : 'margo-hl margo-hl-el';
      hl.dataset.status = c.frontmatter.status;
      hl.dataset.kind = result.kind;
      if (isResolved) hl.dataset.resolved = '';
      hl.style.left = `${r.left + window.scrollX}px`;
      hl.style.top = `${r.top + window.scrollY}px`;
      hl.style.width = `${r.width}px`;
      hl.style.height = `${r.height}px`;
      root.appendChild(hl);
    }

    const r = rects[0]!;
    const pin = document.createElement('button');
    pin.dataset.margoPin = c.frontmatter.id;
    pin.className = 'margo-pin';
    // Pin position. For text/gap anchors the rect is small and meaningful —
    // park the pin at its top-right corner. For element/container anchors
    // the rect can be huge (a tall <main> spans the page) so the corner is
    // visually disconnected from where the user actually clicked. In that
    // case use the captured click point (target.coords) scaled from the
    // capture-time viewport to the current viewport.
    const PIN_SIZE = 22;
    const PAD = 4;
    let docLeft: number, docTop: number;
    if (isTextAnchor || isGapAnchor) {
      docLeft = r.left + r.width - 8 + window.scrollX;
      docTop = r.top - 8 + window.scrollY;
    } else {
      const cap = c.frontmatter.target;
      const sx = cap.viewport.w > 0 ? window.innerWidth / cap.viewport.w : 1;
      const sy = cap.viewport.h > 0 ? window.innerHeight / cap.viewport.h : 1;
      docLeft = cap.coords.x * sx - PIN_SIZE / 2 + window.scrollX;
      docTop = cap.coords.y * sy - PIN_SIZE / 2 + window.scrollY;
    }
    const minLeft = window.scrollX + PAD;
    const maxLeft = window.scrollX + window.innerWidth - PIN_SIZE - PAD;
    const minTop = window.scrollY + PAD;
    pin.style.left = `${Math.min(Math.max(docLeft, minLeft), maxLeft)}px`;
    pin.style.top = `${Math.max(docTop, minTop)}px`;
    pin.dataset.status = c.frontmatter.status;
    pin.dataset.kind = result.kind;
    if (isResolved) pin.dataset.resolved = '';
    pin.textContent = result.kind === 'moved' ? '?' : '·';
    // Hover the pin → intensify the matching highlight(s) + show our custom
    // tooltip (replacing the native `title` which the OS positions and
    // happily lets clip past the viewport edge).
    const tipText = `${c.frontmatter.author}: ${truncate(c.body.split('\n').find((l) => l.trim()) ?? '', 80)}`;
    const setHover = (on: boolean) => {
      for (const el of Array.from(root.querySelectorAll(`[data-margo-highlight="${c.frontmatter.id}"]`))) {
        (el as HTMLElement).classList.toggle('margo-hl-hover', on);
      }
    };
    pin.addEventListener('mouseenter', () => { setHover(true); showTooltip(pin, tipText); });
    pin.addEventListener('mouseleave', () => { setHover(false); hideTooltip(); });
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTooltip();
      openCommentPanel(root, c, sync, readOnly, me, pin);
    });
    root.appendChild(pin);
  }

  if (orphans.length > 0) renderOrphanTray(root, orphans, sync, readOnly, me);
  if (!readOnly && onPage.length > 0) renderPageBulkActions(root, onPage, sync);
}

function renderShowResolvedToggle(
  root: HTMLElement,
  initial: boolean,
  onChange: (next: boolean) => void,
): void {
  // Pill toggle, bottom-left above the orphan tray. Survives renderAllPins
  // (which only clears its own children) so we don't need to recreate it
  // every render — just flip the `aria-pressed` + class.
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'margo-show-resolved';
  btn.dataset.margoToggle = '';
  let value = initial;
  const refresh = () => {
    btn.classList.toggle('margo-show-resolved-on', value);
    btn.setAttribute('aria-pressed', String(value));
    btn.innerHTML = `
      <span class="margo-toggle-pill"><span class="margo-toggle-dot"></span></span>
      <span>show resolved</span>
    `;
  };
  refresh();
  btn.addEventListener('click', () => {
    value = !value;
    refresh();
    onChange(value);
  });
  root.appendChild(btn);
}

function renderPageBulkActions(root: HTMLElement, onPage: Comment[], sync: SyncClient): void {
  const bar = document.createElement('div');
  bar.dataset.margoBulk = '';
  bar.className = 'margo-bulk';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'margo-bulk-resolve';
  btn.innerHTML = `<span class="margo-bulk-check">✓</span> resolve ${onPage.length} on this page`;
  btn.addEventListener('click', () => bulkResolve(btn, onPage, sync, 'on this page'));
  bar.appendChild(btn);
  root.appendChild(bar);
}

async function bulkResolve(
  trigger: HTMLButtonElement,
  comments: Comment[],
  sync: SyncClient,
  scopeLabel: string,
): Promise<void> {
  const noun = comments.length === 1 ? 'comment' : 'comments';
  // Single dialog: one shared summary applied to every comment, with the
  // count + scope explained in the message. Leaving blank still resolves but
  // skips the decisions log.
  const summary = await uiPrompt({
    title: `Resolve ${comments.length} ${noun}`,
    message: `Applies to all ${comments.length} ${noun} ${scopeLabel}. One-line decision summary (leave blank to resolve without logging):`,
    placeholder: 'e.g. "Q3 cleanup of typo callouts"',
    confirmLabel: `Resolve ${comments.length}`,
  });
  if (summary === null) return;
  const trimmedSummary = summary.trim();

  trigger.disabled = true;
  const original = trigger.innerHTML;
  let done = 0;
  // Sequential — each PATCH triggers a git commit on the backend; parallel
  // requests would race on the working tree.
  for (const c of comments) {
    trigger.textContent = `resolving ${++done}/${comments.length}…`;
    try {
      await sync.patchComment(c.frontmatter.id, {
        status: 'resolved',
        ...(trimmedSummary ? { decisionSummary: trimmedSummary } : {}),
      });
    } catch (err) {
      await uiAlert(
        `Stopped after ${done - 1}/${comments.length}: ${(err as Error).message}`,
        'Bulk resolve failed',
      );
      trigger.disabled = false;
      trigger.innerHTML = original;
      return;
    }
  }
  // SSE refresh will re-render and remove the bar.
}

function renderOrphanTray(
  root: HTMLElement,
  orphans: Comment[],
  sync: SyncClient,
  readOnly: boolean,
  me: { email: string } | null,
): void {
  const tray = document.createElement('div');
  tray.dataset.margoTray = '';
  tray.className = 'margo-tray';

  const toggle = document.createElement('button');
  toggle.className = 'margo-tray-toggle';
  toggle.type = 'button';
  toggle.innerHTML = `
    <span class="margo-tray-icon">⚠</span>
    <span class="margo-tray-label">${orphans.length} orphaned ${orphans.length === 1 ? 'comment' : 'comments'}</span>
    <span class="margo-tray-chev">▾</span>
  `;
  tray.appendChild(toggle);

  const list = document.createElement('div');
  list.className = 'margo-tray-list';
  list.hidden = true;
  if (!readOnly && orphans.length > 1) {
    const bulk = document.createElement('button');
    bulk.type = 'button';
    bulk.className = 'margo-tray-resolve-all';
    bulk.textContent = `resolve all ${orphans.length}`;
    bulk.addEventListener('click', () => bulkResolve(bulk, orphans, sync, 'orphans'));
    list.appendChild(bulk);
  }
  for (const c of orphans) list.appendChild(renderOrphanCard(c, sync, readOnly, me));
  tray.appendChild(list);

  toggle.addEventListener('click', () => {
    list.hidden = !list.hidden;
    tray.classList.toggle('margo-tray-open', !list.hidden);
  });

  root.appendChild(tray);
}

function renderOrphanCard(
  c: Comment,
  sync: SyncClient,
  readOnly: boolean,
  me: { email: string } | null,
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'margo-orphan';
  card.dataset.commentId = c.frontmatter.id;
  const isResolved = c.frontmatter.status === 'resolved' || c.frontmatter.status === 'wontfix';
  if (isResolved) card.dataset.resolved = '';

  // Show what was originally anchored — phrase if it was a text selection,
  // else the element's captured text snippet. Strikethrough signals "gone".
  const anchor = c.frontmatter.target.textAnchor;
  const quoted = anchor?.phrase ?? c.frontmatter.target.text ?? '';
  const role = c.frontmatter.target.role ?? '';
  const wasAt = `${role ? `<${role}>` : ''} on ${c.frontmatter.target.url}`;

  const header = document.createElement('header');
  header.innerHTML = `
    <div class="margo-panel-titlebar">
      <strong class="margo-panel-author">${escapeHtml(c.frontmatter.author)}</strong>
      <button class="margo-close" type="button" aria-label="dismiss">×</button>
    </div>
    <div class="margo-panel-meta">
      ${c.frontmatter.role ? `<span class="margo-role">${escapeHtml(c.frontmatter.role)}</span>` : ''}
      <span class="margo-status" data-status="${escapeHtml(c.frontmatter.status)}">${escapeHtml(c.frontmatter.status)}</span>
    </div>
  `;
  // Close just dismisses this card from the current view. The orphan stays
  // in the file system; next renderAllPins (resize, mutation, SSE refresh)
  // will surface it again until the user actually replies / resolves / deletes.
  header.querySelector('.margo-close')!.addEventListener('click', () => card.remove());
  card.appendChild(header);

  const lostLabel = document.createElement('p');
  lostLabel.className = 'margo-orphan-label';
  lostLabel.textContent = 'Anchor removed — coworker edited this away.';
  card.appendChild(lostLabel);

  if (quoted) {
    const q = document.createElement('blockquote');
    q.className = 'margo-orphan-quote';
    q.innerHTML = `<span class="margo-orphan-quote-text">${escapeHtml(truncate(quoted, 220))}</span>`;
    card.appendChild(q);
  }

  const meta = document.createElement('p');
  meta.className = 'margo-orphan-meta';
  meta.textContent = wasAt;
  card.appendChild(meta);

  // Use the chat thread renderer so orphan cards match the panel's premium look.
  const threadWrap = document.createElement('div');
  threadWrap.innerHTML = renderThread(c);
  card.appendChild(threadWrap.firstElementChild!);

  if (!readOnly) {
    const actions = document.createElement('div');
    actions.className = 'margo-actions';
    if (isResolved) {
      actions.appendChild(makeOrphanButton('reopen', 'reopen', async (btn) => {
        btn.disabled = true;
        await sync.patchComment(c.frontmatter.id, { status: 'open' });
      }));
      if (canDelete(c, me)) {
        actions.appendChild(makeOrphanButton('delete', 'delete', async (btn) => {
          if (!(await confirmDelete(c))) return;
          btn.disabled = true;
          await sync.deleteComment(c.frontmatter.id);
        }));
      }
    } else {
      actions.appendChild(makeOrphanButton('reply', 'reply', async (btn) => {
        const text = await uiPrompt({
          title: 'Reply',
          message: 'The commenter will see this in the comment file and the inbox.',
          placeholder: 'e.g. "Removed because the section was deprecated."',
          multiline: true,
          confirmLabel: 'Post reply',
        });
        if (!text || !text.trim()) return;
        btn.disabled = true;
        await sync.patchComment(c.frontmatter.id, { reply: { body: text.trim() } });
      }));
      actions.appendChild(makeOrphanButton('resolve', 'resolved', async (btn) => {
        const summary = await promptDecisionSummary(c);
        if (summary === null) return;
        btn.disabled = true;
        await sync.patchComment(c.frontmatter.id, {
          status: 'resolved',
          ...(summary ? { decisionSummary: summary } : {}),
        });
      }));
      actions.appendChild(makeOrphanButton('wontfix', "won't fix", async (btn) => {
        btn.disabled = true;
        await sync.patchComment(c.frontmatter.id, { status: 'wontfix' });
      }));
      if (canDelete(c, me)) {
        actions.appendChild(makeOrphanButton('delete', 'delete', async (btn) => {
          if (!(await confirmDelete(c))) return;
          btn.disabled = true;
          await sync.deleteComment(c.frontmatter.id);
        }));
      }
    }
    card.appendChild(actions);
  }
  card.appendChild(makeIdFooter(c.frontmatter.id));

  return card;
}

function makeOrphanButton(
  action: string,
  label: string,
  run: (btn: HTMLButtonElement) => Promise<void>,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.dataset.margoAction = action;
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', async () => {
    try { await run(b); }
    catch (err) {
      b.disabled = false;
      await uiAlert((err as Error).message, `${action} failed`);
    }
  });
  return b;
}

async function promptDecisionSummary(c: Comment): Promise<string | null> {
  // Pre-fill with the first non-empty line of the comment so trivial cases
  // ("fix the typo") can be accepted in one click. Returns null on cancel,
  // empty string if user explicitly cleared and accepted (skip the log).
  const seed = (c.body.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 120);
  const result = await uiPrompt({
    title: 'Resolve comment',
    message: 'One-line decision summary — what was decided and why. Leave blank to resolve without logging.',
    defaultValue: seed,
    placeholder: 'e.g. "Removed pricing nav — single-page layout doesn\'t need it"',
    confirmLabel: 'Resolve',
  });
  return result === null ? null : result.trim();
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function enablePinComposer(
  root: HTMLElement,
  sync: SyncClient,
  renderPins: () => void,
): void {
  // Two launchers, mutually exclusive — clicking one cancels the other.
  // pin mode: single click / drag-select → comment on element or text
  // gap mode: two clicks → comment on the space between two elements
  const launcher = document.createElement('button');
  launcher.className = 'margo-launcher';
  launcher.textContent = '+ pin';
  const gapLauncher = document.createElement('button');
  gapLauncher.className = 'margo-launcher margo-launcher-gap';
  gapLauncher.textContent = '+ gap';

  let active = false;
  let gapActive = false;
  let gapFirst: Element | null = null;

  const setPin = (on: boolean) => {
    active = on;
    document.body.classList.toggle('margo-targeting', on);
    launcher.textContent = on ? 'cancel' : '+ pin';
    if (on) setGap(false);
    if (!on) clearHoverHint();
  };
  const setGap = (on: boolean) => {
    gapActive = on;
    gapFirst = null;
    document.body.classList.toggle('margo-gap-targeting', on);
    document.body.classList.toggle('margo-gap-step1', on);
    document.body.classList.toggle('margo-gap-step2', false);
    gapLauncher.textContent = on ? 'cancel' : '+ gap';
    clearGapHighlight();
    if (on) setPin(false);
    if (!on) clearHoverHint();
  };

  launcher.addEventListener('click', () => setPin(!active));
  gapLauncher.addEventListener('click', () => setGap(!gapActive));
  root.appendChild(gapLauncher);
  root.appendChild(launcher);

  // Hover-target state: starts as the leafmost element under the cursor.
  // For "pure container" cases (where children fill the entire box and
  // there's no empty area to click), the user can jump directly to any
  // ancestor via the breadcrumb chips on the hint.
  let currentTarget: Element | null = null;
  let currentChain: Element[] = [];
  let walkedUp = false;

  const setHoverTarget = (el: Element | null) => {
    currentTarget = el;
    currentChain = el ? ancestorChain(el) : [];
    if (el) paintHoverHint(el, currentChain, walkedUp);
    else clearHoverHint();
  };

  document.addEventListener('mousemove', (e) => {
    if (!active && !gapActive) return;
    // Lock the hint on the chosen target while the comment composer is open —
    // otherwise the outline would follow the cursor into the modal, obscuring
    // which element the comment is actually being attached to.
    if (root.querySelector('[data-margo-modal]')) return;
    const leaf = leafmostNonOverlayAt(e.clientX, e.clientY);
    // If user picked a specific ancestor and the cursor is still inside
    // that walked-up element, preserve their choice. Move the cursor out
    // and the hint resets to the new leafmost.
    if (walkedUp && currentTarget && leaf && currentTarget.contains(leaf)) return;
    walkedUp = false;
    setHoverTarget(leaf);
  });

  // Esc cancels pin/gap mode. Skipped when a modal or panel is open so
  // those handlers (which Esc-close themselves) take precedence.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (root.querySelector('[data-margo-modal]')) return;
    if (root.querySelector('.margo-panel')) return;
    if (active) { e.preventDefault(); setPin(false); }
    else if (gapActive) { e.preventDefault(); setGap(false); }
  });

  // Breadcrumb crumb click (delegated on overlay root). Each crumb maps
  // back to a stored ancestor by index — clicking it sets the target to
  // that ancestor without leaving the cursor.
  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && t.classList.contains('margo-hover-hint-crumb')) {
      e.stopPropagation();
      e.preventDefault();
      const idx = parseInt(t.dataset.margoCrumbIndex ?? '-1', 10);
      if (idx >= 0 && idx < currentChain.length) {
        const picked = currentChain[idx];
        walkedUp = true;
        currentTarget = picked;
        paintHoverHint(picked, currentChain, true);
      }
    }
  });

  // Gap mode: two-click selection. First click marks element A (visual
  // outline), second click captures A + B, computes the gap, opens composer.
  document.addEventListener('click', async (e) => {
    if (!gapActive) return;
    const target = e.target as Element | null;
    if (!target || target.closest('[data-margo]')) return;
    e.preventDefault();
    e.stopPropagation();
    if (!gapFirst) {
      gapFirst = target;
      paintGapHighlight(gapFirst, 'first');
      document.body.classList.remove('margo-gap-step1');
      document.body.classList.add('margo-gap-step2');
      return;
    }
    if (gapFirst === target) return; // ignore double-click on same element
    paintGapHighlight(target, 'second');
    const captured = captureTargetFromGap(gapFirst, target, currentRoute());
    const body = await uiPrompt({
      title: 'Comment on this gap',
      message: `Pinned to the space between two elements (axis: ${captured.gapAnchor!.axis}).`,
      placeholder: 'What\'s up with this spacing? Prefix with ? for question, // for discussion.',
      multiline: true,
      confirmLabel: 'Post',
    });
    setGap(false);
    if (!body || !body.trim()) return;
    const trimmed = body.trim();
    const type: CommentType = trimmed.startsWith('?') ? 'question' : trimmed.startsWith('//') ? 'discussion' : 'task';
    const cleanedBody = trimmed.replace(/^(\?|\/\/)\s*/, '');
    await sync.createComment({ type, body: cleanedBody, target: captured });
    renderPins();
  }, true);

  // Capture on mouseup (not click) so drag-to-select selections are still in
  // window.getSelection() — a click event would have collapsed them.
  document.addEventListener('mouseup', async (e) => {
    if (!active) return;
    const target = e.target as Element | null;
    if (!target || target.closest('[data-margo]')) return;
    e.preventDefault();
    e.stopPropagation();
    // Defer one tick so the browser has finalized the selection state.
    await Promise.resolve();
    const sel = window.getSelection();
    const hasSelection = !!sel && !sel.isCollapsed && sel.rangeCount > 0
      && sel.toString().trim().length > 0;
    const captured = hasSelection
      ? captureTargetFromRange(sel!.getRangeAt(0), currentRoute())
      : (walkedUp && currentTarget)
        ? captureTarget(currentTarget, currentRoute())
        : captureTargetFromEvent(e, currentRoute());
    // Override coords with the actual click point (in viewport space). For
    // element/container anchors this is what positions the pin — without
    // this, the pin lands at the resolved rect's corner, which for a tall
    // container is the top edge (far from where the user clicked, often
    // visually overlapping the first child).
    if (!hasSelection) {
      captured.coords = { x: e.clientX, y: e.clientY };
      captured.viewport = { w: window.innerWidth, h: window.innerHeight };
    }
    const body = await uiPrompt({
      title: 'New comment',
      message: hasSelection
        ? `On selected text: "${truncate(sel!.toString().trim().replace(/\s+/g, ' '), 80)}"`
        : undefined,
      placeholder: 'What\'s up with this? Prefix with ? for question, // for discussion.',
      multiline: true,
      confirmLabel: 'Post',
    });
    sel?.removeAllRanges();
    if (!body || !body.trim()) {
      setPin(false);
      return;
    }
    const trimmed = body.trim();
    const type: CommentType = trimmed.startsWith('?') ? 'question' : trimmed.startsWith('//') ? 'discussion' : 'task';
    const cleanedBody = trimmed.replace(/^(\?|\/\/)\s*/, '');
    await sync.createComment({ type, body: cleanedBody, target: captured });
    setPin(false);
    renderPins();
  }, true);
  // Suppress the synthetic click that follows mouseup so the underlying app
  // doesn't react (e.g. navigating, toggling). Note: gap mode has its own
  // click handler above (capture phase) — that runs first and preventDefaults.
  document.addEventListener('click', (e) => {
    if (!active) return;
    const target = e.target as Element | null;
    if (!target || target.closest('[data-margo]')) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

// Visual feedback for gap-mode element selection. Two divs in the overlay
// root, absolutely positioned over the chosen elements with dashed outlines.
function paintGapHighlight(el: Element, slot: 'first' | 'second'): void {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  const r = el.getBoundingClientRect();
  const div = document.createElement('div');
  div.dataset.margoGapPick = slot;
  div.className = `margo-gap-pick margo-gap-pick-${slot}`;
  div.style.left = `${r.left + window.scrollX}px`;
  div.style.top = `${r.top + window.scrollY}px`;
  div.style.width = `${r.width}px`;
  div.style.height = `${r.height}px`;
  root.appendChild(div);
}

function clearGapHighlight(): void {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  for (const el of Array.from(root.querySelectorAll('[data-margo-gap-pick]'))) el.remove();
}

// Single-element hover hint shared by pin + gap modes. Outlines exactly one
// element — the leafmost non-overlay element under the cursor — so the
// visual feedback matches what click would capture (e.target is the
// leafmost; CSS :hover misleadingly matches all ancestors).
function paintHoverHint(el: Element, chain: Element[], walkedUp = false): void {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  const r = el.getBoundingClientRect();
  let div = root.querySelector('[data-margo-hover-hint]') as HTMLElement | null;
  if (!div) {
    div = document.createElement('div');
    div.dataset.margoHoverHint = '';
    div.className = 'margo-hover-hint';
    root.appendChild(div);
  }
  div.classList.toggle('margo-hover-hint-walked', walkedUp);
  div.style.left = `${r.left + window.scrollX}px`;
  div.style.top = `${r.top + window.scrollY}px`;
  div.style.width = `${r.width}px`;
  div.style.height = `${r.height}px`;
  // Breadcrumb of ancestors (root → leaf). Click any crumb to jump-target
  // that ancestor — solves the "pure container fully filled by children"
  // case where there's no empty area to hover-target the container directly.
  const crumbs = chain.map((a, i) => {
    const active = a === el ? ' margo-hover-hint-crumb-active' : '';
    return `<button class="margo-hover-hint-crumb${active}" type="button" data-margo-crumb-index="${i}">${escapeHtml(describeElement(a))}</button>`;
  }).join('<span class="margo-hover-hint-sep">›</span>');
  div.innerHTML = `<div class="margo-hover-hint-tag">${crumbs}</div>`;
}

function clearHoverHint(): void {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  for (const el of Array.from(root.querySelectorAll('[data-margo-hover-hint]'))) el.remove();
}

function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : '';
  const cls = el.classList.length > 0 ? `.${el.classList[0]}` : '';
  return `${tag}${id}${cls}`;
}

function ancestorChain(el: Element, max = 5): Element[] {
  const chain: Element[] = [];
  let cur: Element | null = el;
  while (cur && cur.tagName !== 'HTML' && cur.tagName !== 'BODY') {
    chain.push(cur);
    cur = cur.parentElement;
    if (chain.length >= max) break;
  }
  return chain.reverse(); // root → leaf, reads like a path
}

// Returns the leafmost non-overlay element under the cursor — same element
// that e.target would yield on click.
function leafmostNonOverlayAt(x: number, y: number): Element | null {
  const stack = document.elementsFromPoint(x, y);
  for (const el of stack) {
    if (!el.closest('[data-margo]')) return el;
  }
  return null;
}


function openCommentPanel(
  root: HTMLElement,
  c: Comment,
  sync: SyncClient,
  readOnly: boolean,
  me: { email: string } | null,
  anchor?: Element,
): void {
  const existing = root.querySelector('.margo-panel');
  if (existing) existing.remove();
  const panel = document.createElement('div');
  panel.className = 'margo-panel';
  panel.innerHTML = `
    <header>
      <div class="margo-panel-titlebar">
        <strong class="margo-panel-author">${escapeHtml(c.frontmatter.author)}</strong>
        <button class="margo-close" type="button" aria-label="close">×</button>
      </div>
      <div class="margo-panel-meta">
        ${c.frontmatter.role ? `<span class="margo-role">${escapeHtml(c.frontmatter.role)}</span>` : ''}
        <span class="margo-status" data-status="${escapeHtml(c.frontmatter.status)}">${escapeHtml(c.frontmatter.status)}</span>
      </div>
    </header>
    ${renderThread(c)}
    ${readOnly ? '<p class="margo-readonly">read-only — run <code>npm run dev</code> locally to reply</p>' : ''}
  `;

  const close = () => panel.remove();
  panel.querySelector('.margo-close')!.addEventListener('click', close);
  // Esc closes the panel.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  };
  document.addEventListener('keydown', onKey);

  if (!readOnly) {
    panel.appendChild(makeActionRow(c, sync, close, me));
  }
  panel.appendChild(makeIdFooter(c.frontmatter.id));
  root.appendChild(panel);
  // Anchor the panel near the pin (or fall back to the bottom-right corner
  // when there's no anchor — e.g. opened programmatically). Done after
  // appending so we can measure the rendered panel's height.
  if (anchor) positionPanelNearAnchor(panel, anchor);
}

function positionPanelNearAnchor(panel: HTMLElement, anchor: Element): void {
  const a = anchor.getBoundingClientRect();
  const PAD = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Force position-fixed + measure rendered size. The panel was rendered
  // with the default bottom-right CSS, but those rules are overridden here.
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  panel.style.left = '0px';
  panel.style.top = '0px';
  const pw = panel.offsetWidth;
  const ph = panel.offsetHeight;

  // Prefer right of pin → left of pin → centered above/below if neither fits.
  let left: number;
  if (a.right + PAD + pw <= vw - PAD) {
    left = a.right + PAD;
  } else if (a.left - PAD - pw >= PAD) {
    left = a.left - PAD - pw;
  } else {
    left = Math.max(PAD, Math.min(vw - pw - PAD, a.left - pw / 2 + a.width / 2));
  }
  // Prefer aligning panel's top with pin's top, but clamp to viewport so
  // the panel never overflows top/bottom.
  let top = a.top;
  if (top + ph > vh - PAD) top = vh - ph - PAD;
  if (top < PAD) top = PAD;

  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function makeIdFooter(id: string): HTMLElement {
  const footer = document.createElement('div');
  footer.className = 'margo-panel-footer';
  footer.innerHTML = `
    <span class="margo-footer-label">ID</span>
    <button class="margo-id" type="button" aria-label="Copy comment ID for AI invocation">
      <code>${escapeHtml(id)}</code>
      <span class="margo-id-icon" aria-hidden="true">⎘</span>
      <span class="margo-id-hint">copy for /margo</span>
    </button>
  `;
  wireCopyId(footer.querySelector('.margo-id') as HTMLButtonElement, id);
  return footer;
}

function makeActionRow(
  c: Comment,
  sync: SyncClient,
  close: () => void,
  me: { email: string } | null,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'margo-actions';
  row.dataset.commentId = c.frontmatter.id;

  const isResolved = c.frontmatter.status === 'resolved' || c.frontmatter.status === 'wontfix';
  if (isResolved) {
    const reopen = document.createElement('button');
    reopen.dataset.margoAction = 'reopen';
    reopen.textContent = 'reopen';
    reopen.addEventListener('click', async () => {
      setBusy(row, true);
      try {
        await sync.patchComment(c.frontmatter.id, { status: 'open' });
        close();
      } catch (err) {
        setBusy(row, false);
        await uiAlert((err as Error).message, 'Reopen failed');
      }
    });
    row.appendChild(reopen);
    if (canDelete(c, me)) {
      const del = document.createElement('button');
      del.dataset.margoAction = 'delete';
      del.textContent = 'delete';
      del.title = 'Permanently remove this comment file (git history retains it)';
      del.addEventListener('click', async () => {
        if (!(await confirmDelete(c))) return;
        setBusy(row, true);
        try {
          await sync.deleteComment(c.frontmatter.id);
          close();
        } catch (err) {
          setBusy(row, false);
          await uiAlert((err as Error).message, 'Delete failed');
        }
      });
      row.appendChild(del);
    }
    return row;
  }

  const reply = document.createElement('button');
  reply.dataset.margoAction = 'reply';
  reply.textContent = 'reply';
  reply.addEventListener('click', async () => {
    const body = await uiPrompt({
      title: 'Reply',
      placeholder: 'Add a note for the thread…',
      multiline: true,
      confirmLabel: 'Post reply',
    });
    if (!body || !body.trim()) return;
    setBusy(row, true);
    try {
      await sync.patchComment(c.frontmatter.id, { reply: { body: body.trim() } });
      close();
    } catch (err) {
      setBusy(row, false);
      await uiAlert((err as Error).message, 'Reply failed');
    }
  });

  const resolve = document.createElement('button');
  resolve.dataset.margoAction = 'resolve';
  resolve.textContent = 'mark resolved';
  resolve.addEventListener('click', async () => {
    const summary = await promptDecisionSummary(c);
    if (summary === null) return; // user cancelled
    setBusy(row, true);
    try {
      await sync.patchComment(c.frontmatter.id, {
        status: 'resolved',
        ...(summary ? { decisionSummary: summary } : {}),
      });
      close();
    } catch (err) {
      setBusy(row, false);
      await uiAlert((err as Error).message, 'Resolve failed');
    }
  });

  row.appendChild(reply);
  row.appendChild(resolve);

  if (canDelete(c, me)) {
    const del = document.createElement('button');
    del.dataset.margoAction = 'delete';
    del.textContent = 'delete';
    del.title = 'Delete this comment (own + open/wontfix only)';
    del.addEventListener('click', async () => {
      if (!(await confirmDelete(c))) return;
      setBusy(row, true);
      try {
        await sync.deleteComment(c.frontmatter.id);
        close();
      } catch (err) {
        setBusy(row, false);
        await uiAlert((err as Error).message, 'Delete failed');
      }
    });
    row.appendChild(del);
  }

  return row;
}

// Own-only: matches what the backend enforces. Status doesn't matter — the
// owner can prune any of their own comments; git history preserves the file.
function canDelete(c: Comment, me: { email: string } | null): boolean {
  return !!me && me.email === c.frontmatter.author;
}

async function confirmDelete(c: Comment): Promise<boolean> {
  const preview = c.body.split('\n').find((l) => l.trim())?.slice(0, 80) ?? '';
  return uiConfirm({
    title: `Delete comment ${c.frontmatter.id}?`,
    message: `"${preview}"\n\nThis removes the file from .margo/comments/. Git history retains it, but it won't appear in the inbox.`,
    confirmLabel: 'Delete',
    destructive: true,
  });
}

function setBusy(row: HTMLElement, busy: boolean): void {
  for (const b of Array.from(row.querySelectorAll('button'))) {
    (b as HTMLButtonElement).disabled = busy;
  }
}

// ——— viewport-clamped tooltip (replaces native `title`) ———
function showTooltip(anchor: HTMLElement, text: string): void {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  let tip = root.querySelector('.margo-tip') as HTMLElement | null;
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'margo-tip';
    tip.dataset.margoTip = '';
    root.appendChild(tip);
  }
  tip.textContent = text;
  // Measure with display:block but invisible so the layout is correct before
  // we calculate placement.
  tip.style.display = 'block';
  tip.style.visibility = 'hidden';
  const tipRect = tip.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const margin = 6;
  // Try above first (above the pin), flip below if there isn't room.
  let top = anchorRect.top - tipRect.height - margin;
  let placement: 'top' | 'bottom' = 'top';
  if (top < margin) {
    top = anchorRect.bottom + margin;
    placement = 'bottom';
  }
  let left = anchorRect.left + anchorRect.width / 2 - tipRect.width / 2;
  // Clamp horizontally to viewport with margin so it never clips off-screen.
  const minLeft = margin;
  const maxLeft = window.innerWidth - tipRect.width - margin;
  left = Math.min(Math.max(left, minLeft), maxLeft);
  tip.style.left = `${left + window.scrollX}px`;
  tip.style.top = `${top + window.scrollY}px`;
  tip.dataset.placement = placement;
  tip.style.visibility = 'visible';
}

function hideTooltip(): void {
  const root = document.getElementById(ROOT_ID);
  const tip = root?.querySelector('.margo-tip') as HTMLElement | null;
  if (tip) tip.style.display = 'none';
}

// ——— thread rendering: parse the markdown body into messages, render as chat ———

interface Message {
  kind: 'human' | 'ai';
  author: string;            // email (humans) or model name (ai)
  authorName?: string;       // friendly display name when known (frontmatter.authorName)
  role?: string;             // designer/dev/pm — only on humans
  timestamp?: string;
  body: string;
}

function parseThread(c: Comment): Message[] {
  const out: Message[] = [];
  // First chunk before any `---` separator is the original comment.
  const parts = c.body.split(/\n---\n/);
  out.push({
    kind: 'human',
    author: c.frontmatter.author,
    authorName: c.frontmatter.authorName,
    role: c.frontmatter.role,
    timestamp: c.frontmatter.created,
    body: (parts[0] ?? '').trim(),
  });
  for (const part of parts.slice(1)) {
    const trimmed = part.trim();
    // `**ai-reply** — <model> — <ts>\n\n<body>`
    const ai = trimmed.match(/^\*\*ai-reply\*\*\s*—\s*([^—\n]+?)\s*—\s*([^\n]+)\n+([\s\S]*)$/);
    if (ai) {
      out.push({ kind: 'ai', author: ai[1].trim(), timestamp: ai[2].trim(), body: ai[3].trim() });
      continue;
    }
    // `**reply** — <author> (<role>) — <ts>\n\n<body>`
    const human = trimmed.match(/^\*\*reply\*\*\s*—\s*(\S+)(?:\s*\(([^)]+)\))?\s*—\s*([^\n]+)\n+([\s\S]*)$/);
    if (human) {
      out.push({ kind: 'human', author: human[1].trim(), role: human[2]?.trim(), timestamp: human[3].trim(), body: human[4].trim() });
      continue;
    }
    // Fallback — preserve unparseable block as a generic note so nothing is lost.
    out.push({ kind: 'human', author: 'unknown', body: trimmed });
  }
  return out;
}

function renderThread(c: Comment): string {
  const messages = parseThread(c);
  const items = messages
    .map((m) => (m.kind === 'ai' ? renderAiMessage(m) : renderHumanMessage(m)))
    .join('');
  return `<div class="margo-thread">${items}</div>`;
}

function renderHumanMessage(m: Message): string {
  const display = displayNameOf(m);
  const initial = initialOf(display);
  const color = colorForEmail(m.author);
  const time = m.timestamp ? formatTime(m.timestamp) : '';
  return `
    <div class="margo-msg margo-msg-human">
      <div class="margo-avatar margo-avatar-human" style="background:${color.bg};color:${color.fg}" title="${escapeHtml(m.author)}">${escapeHtml(initial)}</div>
      <div class="margo-msg-stack">
        <div class="margo-msg-meta">
          <span class="margo-msg-author" title="${escapeHtml(m.author)}">${escapeHtml(display)}</span>
          ${m.role ? `<span class="margo-msg-role">${escapeHtml(m.role)}</span>` : ''}
          ${time ? `<span class="margo-msg-time">${escapeHtml(time)}</span>` : ''}
        </div>
        <div class="margo-bubble">${escapeHtml(m.body)}</div>
      </div>
    </div>
  `;
}

// Fallback chain: frontmatter.authorName → email local-part (title-cased
// when the local part has dot/underscore separators, otherwise kept as-is
// since slack-style usernames are typically lowercase) → full email.
function displayNameOf(m: Message): string {
  if (m.authorName && m.authorName.trim()) return m.authorName.trim();
  const local = (m.author.split('@')[0] ?? m.author).trim();
  if (!local) return m.author;
  if (/[._-]/.test(local)) {
    return local
      .split(/[._-]+/)
      .filter(Boolean)
      .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }
  return local;
}

function renderAiMessage(m: Message): string {
  const time = m.timestamp ? formatTime(m.timestamp) : '';
  return `
    <div class="margo-msg margo-msg-ai">
      <div class="margo-avatar margo-avatar-ai" aria-label="AI">✦</div>
      <div class="margo-msg-stack">
        <div class="margo-msg-meta">
          <span class="margo-msg-author">AI</span>
          <span class="margo-msg-model">${escapeHtml(m.author)}</span>
          <span class="margo-msg-time">${escapeHtml(time)}</span>
        </div>
        <div class="margo-bubble">${escapeHtml(m.body)}</div>
      </div>
    </div>
  `;
}

function initialOf(displayOrEmail: string): string {
  const s = (displayOrEmail.split('@')[0] ?? displayOrEmail).trim();
  return (s[0] ?? '?').toUpperCase();
}

function colorForEmail(email: string): { bg: string; fg: string } {
  // Stable per-email hue so the same person gets the same avatar color across renders.
  let h = 0;
  for (let i = 0; i < email.length; i++) h = ((h << 5) - h + email.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return { bg: `hsl(${hue} 65% 90%)`, fg: `hsl(${hue} 60% 32%)` };
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  const min = 60_000, hr = 60 * min, day = 24 * hr;
  if (diff < min) return 'just now';
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function wireCopyId(btn: HTMLButtonElement, id: string): void {
  // Copy ID to clipboard, briefly swap the icon to a check + show "copied"
  // text so the user gets confirmation without an alert.
  const original = btn.innerHTML;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(id);
      btn.innerHTML = `<code>${escapeHtml(id)}</code><span class="margo-id-icon" aria-hidden="true">✓</span>`;
      btn.classList.add('margo-id-copied');
      setTimeout(() => {
        btn.innerHTML = original;
        btn.classList.remove('margo-id-copied');
      }, 1200);
    } catch {
      // Clipboard API can be blocked (insecure context, permissions); fall
      // back to selecting the ID text so the user can ⌘C manually.
      const range = document.createRange();
      range.selectNode(btn.querySelector('code')!);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  });
}

function escapeHtml(s: string | null | undefined): string {
  // Defensive against optional fields slipping through (e.g. role can be
  // undefined for users not in the roster). Without this, a single
  // undefined value crashes the whole HTML render.
  if (s == null) return '';
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

// ——— modal primitives (replaces window.prompt / confirm / alert) ———
//
// All dialogs are appended into #margo-overlay-root so they inherit the same
// scoped CSS as the rest of the overlay and never leak styles into the host
// app. Esc / backdrop click cancel; Enter confirms (Shift+Enter for newline
// in multiline mode).

interface DialogOpts {
  title?: string;
  message?: string;
  defaultValue?: string;       // when defined, an input is rendered
  multiline?: boolean;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  hideCancel?: boolean;
}

function openDialog(opts: DialogOpts): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const root = document.getElementById(ROOT_ID);
    if (!root) { resolve(null); return; }

    // Only one modal at a time — drop any previous one.
    root.querySelector('[data-margo-modal]')?.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'margo-modal-backdrop';
    backdrop.dataset.margoModal = '';

    const modal = document.createElement('div');
    modal.className = 'margo-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const header = document.createElement('header');
    if (opts.title) {
      const h = document.createElement('h3');
      h.textContent = opts.title;
      header.appendChild(h);
    }
    const close = document.createElement('button');
    close.className = 'margo-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'close');
    close.textContent = '×';
    close.addEventListener('click', () => done(null));
    header.appendChild(close);
    modal.appendChild(header);

    const body = document.createElement('div');
    body.className = 'margo-modal-body';
    if (opts.message) {
      const p = document.createElement('p');
      p.className = 'margo-modal-message';
      p.textContent = opts.message;
      body.appendChild(p);
    }
    let input: HTMLInputElement | HTMLTextAreaElement | null = null;
    if (opts.defaultValue !== undefined) {
      input = opts.multiline
        ? document.createElement('textarea')
        : document.createElement('input');
      input.className = 'margo-modal-input';
      input.value = opts.defaultValue;
      if (opts.placeholder) input.placeholder = opts.placeholder;
      if (opts.multiline) (input as HTMLTextAreaElement).rows = 4;
      body.appendChild(input);
    }
    modal.appendChild(body);

    const footer = document.createElement('footer');
    if (!opts.hideCancel) {
      const cancel = document.createElement('button');
      cancel.className = 'margo-modal-cancel';
      cancel.type = 'button';
      cancel.textContent = opts.cancelLabel ?? 'Cancel';
      cancel.addEventListener('click', () => done(null));
      footer.appendChild(cancel);
    }
    const confirm = document.createElement('button');
    confirm.className = 'margo-modal-confirm';
    if (opts.destructive) confirm.classList.add('margo-modal-destructive');
    confirm.type = 'button';
    confirm.textContent = opts.confirmLabel ?? 'OK';
    confirm.addEventListener('click', () => done(input ? input.value : ''));
    footer.appendChild(confirm);
    modal.appendChild(footer);

    backdrop.appendChild(modal);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) done(null);
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(null);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        // Multiline accepts Enter for newline; require Cmd/Ctrl+Enter to submit.
        if (opts.multiline && !(e.metaKey || e.ctrlKey)) return;
        e.preventDefault();
        confirm.click();
      }
    };
    document.addEventListener('keydown', onKey, true);

    function done(result: string | null): void {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(result);
    }

    root.appendChild(backdrop);
    requestAnimationFrame(() => {
      if (input) {
        input.focus();
        if ('select' in input) input.select();
      } else {
        confirm.focus();
      }
    });
  });
}

async function uiPrompt(opts: {
  title?: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  multiline?: boolean;
  confirmLabel?: string;
}): Promise<string | null> {
  return openDialog({
    title: opts.title,
    message: opts.message,
    defaultValue: opts.defaultValue ?? '',
    placeholder: opts.placeholder,
    multiline: opts.multiline,
    confirmLabel: opts.confirmLabel ?? 'Save',
  });
}

async function uiConfirm(opts: {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}): Promise<boolean> {
  const r = await openDialog({
    title: opts.title,
    message: opts.message,
    confirmLabel: opts.confirmLabel ?? 'Confirm',
    cancelLabel: opts.cancelLabel ?? 'Cancel',
    destructive: opts.destructive,
  });
  return r !== null;
}

async function uiAlert(message: string, title = 'Heads up'): Promise<void> {
  await openDialog({
    title,
    message,
    confirmLabel: 'OK',
    hideCancel: true,
  });
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  // Tokens mirror shadcn/ui defaults (zinc neutral palette, --radius: 0.5rem).
  // Scoped via #margo-overlay-root descendant selectors so we don't touch host styles.
  style.textContent = `
    #${ROOT_ID} {
      --margo-bg: hsl(0 0% 100%);
      --margo-fg: hsl(240 10% 3.9%);
      --margo-muted: hsl(240 4.8% 95.9%);
      --margo-muted-fg: hsl(240 3.8% 46.1%);
      --margo-border: hsl(240 5.9% 90%);
      --margo-ring: hsl(240 5.9% 10%);
      --margo-primary: hsl(240 5.9% 10%);
      --margo-primary-fg: hsl(0 0% 98%);
      --margo-radius: 0.5rem;
      font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: var(--margo-fg);
    }
    /* ——— launcher (Button: variant=default, size=sm, shape=pill) ——— */
    .margo-launcher {
      position: fixed; bottom: 16px; right: 16px; z-index: 999999;
      display: inline-flex; align-items: center; gap: 6px;
      height: 36px; padding: 0 14px;
      background: var(--margo-primary); color: var(--margo-primary-fg);
      border: 0; border-radius: 9999px;
      font: inherit; font-weight: 500; font-size: 13px;
      cursor: pointer; transition: background-color .12s, box-shadow .12s, transform .06s;
      box-shadow: 0 1px 2px rgb(0 0 0 / .08), 0 4px 12px rgb(0 0 0 / .08);
    }
    .margo-launcher:hover { background: hsl(240 5.9% 18%); }
    .margo-launcher:active { transform: translateY(1px); }
    .margo-launcher:focus-visible { outline: 2px solid var(--margo-ring); outline-offset: 2px; }
    /* gap launcher sits to the left of the pin launcher, slightly subdued */
    .margo-launcher-gap {
      right: 80px; bottom: 16px;
      background: var(--margo-bg); color: var(--margo-fg);
      border: 1px solid var(--margo-border);
    }
    .margo-launcher-gap:hover { background: var(--margo-muted); }
    /* targeting cursor variants */
    body.margo-gap-targeting * { cursor: crosshair !important; }
    /* Single-element hover hint (JS-driven) — replaces CSS *:hover which was
       misleading because :hover matches all ancestors. We outline only the
       leafmost element under the cursor, matching what click captures. */
    .margo-hover-hint {
      position: absolute; z-index: 999996; pointer-events: none;
      outline: 1.5px dashed hsl(217 91% 60%); outline-offset: 2px;
      background: hsl(217 91% 60% / .06);
      border-radius: 2px;
      transition: all .06s ease-out;
    }
    .margo-hover-hint-tag {
      position: absolute; top: -26px; left: 0;
      display: inline-flex; align-items: center; gap: 0;
      background: hsl(217 91% 60%);
      font: inherit; font-size: 10px; font-weight: 600;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      padding: 3px 4px; border-radius: 4px;
      box-shadow: 0 1px 2px rgb(0 0 0 / .15);
      white-space: nowrap; max-width: calc(100vw - 32px); overflow: hidden;
      pointer-events: auto;
    }
    .margo-hover-hint-crumb {
      display: inline-flex; align-items: center;
      padding: 2px 6px;
      background: transparent; color: rgb(255 255 255 / .85);
      border: 0; border-radius: 3px;
      font: inherit; font-size: 10px; font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: background-color .12s, color .12s;
    }
    .margo-hover-hint-crumb:hover { background: rgb(255 255 255 / .2); color: white; }
    .margo-hover-hint-crumb-active {
      background: white; color: hsl(217 91% 32%);
    }
    .margo-hover-hint-crumb-active:hover { background: white; color: hsl(217 91% 32%); }
    .margo-hover-hint-sep {
      color: rgb(255 255 255 / .55); padding: 0 1px; font-weight: 400;
    }
    /* Stronger fill when user picked a non-leaf ancestor explicitly */
    .margo-hover-hint-walked {
      background: hsl(217 91% 60% / .15);
      outline-color: hsl(217 91% 48%);
    }
    /* gap-pick visual feedback (during 2-click selection) */
    .margo-gap-pick {
      position: absolute; z-index: 999998; pointer-events: none;
      border: 2px dashed hsl(217 91% 60%);
      background: hsl(217 91% 60% / .08);
      border-radius: 4px;
      transition: opacity .12s ease;
    }
    .margo-gap-pick-second { border-color: hsl(160 84% 39%); background: hsl(160 84% 39% / .08); }
    /* gap anchor highlight (rendered for existing gap-anchored comments) */
    .margo-hl-gap {
      background: repeating-linear-gradient(
        45deg,
        hsl(38 92% 50% / .15),
        hsl(38 92% 50% / .15) 6px,
        hsl(38 92% 50% / .25) 6px,
        hsl(38 92% 50% / .25) 12px
      );
      outline: 1px dashed hsl(38 92% 50% / .85); outline-offset: -1px;
      border-radius: 2px;
    }
    /* ——— pin (status-colored dot) ——— */
    .margo-pin {
      position: absolute; z-index: 999998;
      width: 22px; height: 22px; padding: 0;
      border-radius: 9999px;
      background: hsl(38 92% 50%); color: #fff;
      border: 2px solid var(--margo-bg);
      cursor: pointer;
      box-shadow: 0 1px 2px rgb(0 0 0 / .15), 0 2px 6px rgb(0 0 0 / .12);
      transition: transform .08s ease, box-shadow .12s ease;
    }
    .margo-pin:hover { transform: scale(1.1); }
    .margo-pin:focus-visible { outline: 2px solid var(--margo-ring); outline-offset: 2px; }
    .margo-pin[data-status="ready-for-review"] { background: hsl(160 84% 39%); }
    .margo-pin[data-status="blocked"] { background: hsl(0 84% 60%); }
    .margo-pin[data-kind="moved"] { outline: 2px dashed hsl(38 92% 50%); outline-offset: 2px; }
    /* ——— pin hover tooltip (viewport-clamped, replaces native title) ——— */
    .margo-tip {
      position: absolute; z-index: 999998;
      max-width: 280px;
      padding: 6px 10px;
      background: hsl(240 10% 12%); color: hsl(0 0% 98%);
      border-radius: 6px;
      font: inherit; font-size: 12px; line-height: 1.4;
      box-shadow: 0 4px 12px rgb(0 0 0 / .25);
      pointer-events: none;
      white-space: pre-wrap; word-break: break-word;
      animation: margo-tip-in .12s ease-out;
    }
    @keyframes margo-tip-in { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }
    .margo-tip[data-placement="bottom"] { animation-name: margo-tip-in-bottom; }
    @keyframes margo-tip-in-bottom { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
    /* ——— highlight layer — sits behind the pin, doesn't block clicks ——— */
    .margo-hl { position: absolute; z-index: 999997; pointer-events: none;
      transition: background-color .12s ease, box-shadow .12s ease; }
    .margo-hl-text {
      background: hsl(38 92% 50% / .22);
      box-shadow: inset 0 -1px 0 hsl(38 92% 50% / .9);
      border-radius: 2px;
    }
    .margo-hl-el {
      background: hsl(38 92% 50% / .08);
      outline: 1px dashed hsl(38 92% 50% / .7); outline-offset: -1px;
    }
    .margo-hl[data-status="ready-for-review"] {
      background: hsl(160 84% 39% / .2);
      box-shadow: inset 0 -1px 0 hsl(160 84% 39% / .9);
    }
    .margo-hl[data-status="blocked"] {
      background: hsl(0 84% 60% / .22);
      box-shadow: inset 0 -1px 0 hsl(0 84% 60% / .9);
    }
    .margo-hl-hover {
      background: hsl(38 92% 50% / .45) !important;
      box-shadow: inset 0 0 0 1px hsl(38 92% 50%) !important;
    }
    /* ——— panel (Card: header / content / actions / footer) ——— */
    .margo-panel {
      position: fixed; right: 16px; bottom: 64px;
      width: 380px; max-width: calc(100vw - 32px);
      background: var(--margo-bg); color: var(--margo-fg);
      border: 1px solid var(--margo-border);
      border-radius: var(--margo-radius);
      box-shadow: 0 10px 15px -3px rgb(0 0 0 / .1), 0 4px 6px -4px rgb(0 0 0 / .1);
      padding: 0; z-index: 999999; overflow: hidden;
      animation: margo-pop .14s ease-out;
      display: flex; flex-direction: column;
    }
    @keyframes margo-pop {
      from { opacity: 0; transform: translateY(4px) scale(.98); }
      to   { opacity: 1; transform: none; }
    }
    /* CardHeader */
    .margo-panel header {
      display: flex; flex-direction: column; gap: 6px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--margo-border);
    }
    .margo-panel-titlebar {
      display: flex; align-items: center; gap: 8px;
    }
    .margo-panel-author {
      font-weight: 600; font-size: 13px; line-height: 1.3;
      flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .margo-panel-meta { display: flex; gap: 6px; flex-wrap: wrap; }
    /* CardContent */
    .margo-body {
      white-space: pre-wrap; margin: 0;
      padding: 14px 16px;
      font: inherit; font-size: 13px; color: var(--margo-fg);
      max-height: 260px; overflow: auto;
    }
    /* ——— chat thread (humans left, AI right) ——— */
    .margo-thread {
      display: flex; flex-direction: column; gap: 14px;
      padding: 14px 14px;
      max-height: 380px; overflow: auto;
      background: hsl(240 5% 98%);
    }
    .margo-thread::-webkit-scrollbar { width: 8px; }
    .margo-thread::-webkit-scrollbar-thumb { background: hsl(240 5% 88%); border-radius: 999px; }
    .margo-msg {
      display: flex; gap: 8px; align-items: flex-start;
      max-width: 88%;
    }
    /* Slack/Linear-style — all messages left-aligned, avatar identifies the
       speaker. AI keeps its distinct gradient avatar + tinted bubble below
       so it's still unmistakable in a multi-user thread. */
    .margo-msg { align-self: flex-start; }
    .margo-msg-stack { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .margo-avatar {
      width: 28px; height: 28px; border-radius: 9999px;
      flex: 0 0 auto;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 12px; font-weight: 600;
      box-shadow: 0 1px 2px rgb(0 0 0 / .08);
    }
    .margo-avatar-ai {
      background: linear-gradient(135deg, hsl(280 70% 60%), hsl(217 91% 60%));
      color: white; font-size: 14px;
    }
    .margo-msg-meta {
      display: flex; gap: 6px; align-items: baseline;
      font-size: 10px; line-height: 1.2;
      padding: 0 4px;
    }
    .margo-msg-author { font-weight: 600; color: var(--margo-fg); font-size: 11px; }
    .margo-msg-role {
      color: var(--margo-muted-fg); font-size: 10px;
      padding: 1px 5px; background: var(--margo-muted); border-radius: 999px;
    }
    .margo-msg-model {
      color: var(--margo-muted-fg); font-size: 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      padding: 1px 5px; background: var(--margo-muted); border-radius: 4px;
    }
    .margo-msg-time { color: var(--margo-muted-fg); font-size: 10px; }
    .margo-bubble {
      background: var(--margo-bg);
      border: 1px solid var(--margo-border);
      border-radius: 14px;
      padding: 9px 12px;
      font-size: 13px; line-height: 1.5; color: var(--margo-fg);
      white-space: pre-wrap; word-break: break-word;
      box-shadow: 0 1px 1px rgb(0 0 0 / .03);
    }
    .margo-msg .margo-bubble { border-top-left-radius: 4px; }
    .margo-msg-ai .margo-bubble {
      background: linear-gradient(180deg, hsl(217 91% 97%), hsl(280 70% 97%));
      border-color: hsl(217 91% 88%);
    }
    /* ——— action row (sits between thread and footer) ——— */
    .margo-actions {
      display: flex; gap: 8px; align-items: center;
      padding: 12px 16px 14px;
      border-top: 1px solid var(--margo-border);
    }
    /* ——— Badge (variant=secondary, status-aware) ——— */
    .margo-role, .margo-status {
      display: inline-flex; align-items: center;
      background: var(--margo-muted); color: var(--margo-muted-fg);
      padding: 1px 8px; border-radius: 9999px;
      font-size: 11px; font-weight: 500; line-height: 1.5;
      border: 1px solid transparent;
    }
    .margo-status { text-transform: lowercase; }
    /* status-tinted variants */
    .margo-status[data-status="open"] {
      background: hsl(38 92% 95%); color: hsl(28 80% 32%); border-color: hsl(38 92% 80%);
    }
    .margo-status[data-status="in-progress"] {
      background: hsl(217 91% 95%); color: hsl(217 91% 36%); border-color: hsl(217 91% 80%);
    }
    .margo-status[data-status="ready-for-review"] {
      background: hsl(160 84% 95%); color: hsl(160 84% 28%); border-color: hsl(160 84% 70%);
    }
    .margo-status[data-status="blocked"] {
      background: hsl(0 84% 96%); color: hsl(0 70% 42%); border-color: hsl(0 84% 80%);
    }
    .margo-status[data-status="resolved"], .margo-status[data-status="wontfix"] {
      background: var(--margo-muted); color: var(--margo-muted-fg);
    }
    /* CardFooter — copyable ID lives here, away from primary content */
    .margo-panel-footer {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 16px;
      background: hsl(240 5% 98%);
      border-top: 1px solid var(--margo-border);
      font-size: 11px;
    }
    .margo-footer-label {
      font-size: 10px; font-weight: 600; letter-spacing: .04em;
      text-transform: uppercase; color: hsl(240 4% 60%);
    }
    /* ——— copyable comment-id button (lives in footer, hint visible on hover) ——— */
    .margo-id {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 8px;
      background: transparent; color: var(--margo-fg);
      border: 1px solid transparent; border-radius: 6px;
      font: inherit; font-size: 11px; cursor: pointer;
      transition: background-color .12s, color .12s, border-color .12s;
      white-space: nowrap;
    }
    .margo-id:hover {
      background: var(--margo-bg); border-color: var(--margo-border);
    }
    .margo-id:focus-visible { outline: 2px solid var(--margo-ring); outline-offset: 2px; }
    .margo-id code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px; background: transparent; padding: 0; color: inherit;
    }
    .margo-id-icon { font-size: 11px; opacity: .55; }
    .margo-id:hover .margo-id-icon { opacity: 1; }
    .margo-id-hint {
      font-size: 10px; color: var(--margo-muted-fg);
      opacity: 0; max-width: 0; overflow: hidden;
      transition: opacity .12s ease, max-width .12s ease;
    }
    .margo-id:hover .margo-id-hint { opacity: 1; max-width: 120px; }
    .margo-id-copied {
      background: hsl(160 84% 96%); color: hsl(160 84% 28%);
      border-color: hsl(160 84% 75%);
    }
    .margo-id-copied .margo-id-icon { opacity: 1; color: hsl(160 84% 39%); }
    /* ——— close (Button: variant=ghost, size=icon) ——— */
    .margo-close {
      margin-left: auto;
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; padding: 0;
      background: transparent; color: var(--margo-muted-fg);
      border: 0; border-radius: 6px; cursor: pointer;
      font-size: 18px; line-height: 1;
      transition: background-color .12s, color .12s;
    }
    .margo-close:hover { background: var(--margo-muted); color: var(--margo-fg); }
    .margo-close:focus-visible { outline: 2px solid var(--margo-ring); outline-offset: 2px; }
    .margo-body {
      white-space: pre-wrap; margin: 0 0 12px;
      font: inherit; font-size: 13px; color: var(--margo-fg);
      max-height: 260px; overflow: auto;
    }
    /* ——— action buttons (Button: variant=outline / variant=default) ——— */
    .margo-actions button {
      display: inline-flex; align-items: center; justify-content: center;
      height: 32px; padding: 0 12px;
      background: var(--margo-bg); color: var(--margo-fg);
      border: 1px solid var(--margo-border); border-radius: 6px;
      font: inherit; font-size: 13px; font-weight: 500;
      cursor: pointer;
      transition: background-color .12s, border-color .12s;
    }
    .margo-actions button:hover { background: var(--margo-muted); }
    .margo-actions button:focus-visible { outline: 2px solid var(--margo-ring); outline-offset: 2px; }
    .margo-actions button:disabled { opacity: .5; cursor: not-allowed; }
    .margo-actions button[data-margo-action="resolve"] {
      background: var(--margo-primary); color: var(--margo-primary-fg); border-color: var(--margo-primary);
    }
    .margo-actions button[data-margo-action="resolve"]:hover { background: hsl(240 5.9% 18%); }
    /* destructive ghost — kept tertiary so it's not the easy-click target */
    .margo-actions button[data-margo-action="delete"] {
      margin-left: auto;
      background: transparent; color: hsl(0 70% 50%); border-color: transparent;
    }
    .margo-actions button[data-margo-action="delete"]:hover {
      background: hsl(0 84% 96%); border-color: hsl(0 84% 88%);
    }
    .margo-readonly { color: var(--margo-muted-fg); font-size: 12px; margin: 0; padding: 0 16px 14px; }
    .margo-readonly code {
      background: var(--margo-muted); padding: 1px 6px; border-radius: 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    }
    body.margo-targeting * { cursor: crosshair !important; }
    /* ——— orphan tray (bottom-left, opposite the launcher) ——— */
    .margo-tray {
      position: fixed; bottom: 16px; left: 16px; z-index: 999999;
      display: flex; flex-direction: column-reverse; align-items: flex-start;
      gap: 8px;
      max-width: min(420px, calc(100vw - 32px));
    }
    .margo-tray-toggle {
      display: inline-flex; align-items: center; gap: 8px;
      height: 36px; padding: 0 14px;
      background: hsl(38 92% 96%); color: hsl(28 80% 28%);
      border: 1px solid hsl(38 92% 75%); border-radius: 9999px;
      font: inherit; font-size: 13px; font-weight: 500;
      cursor: pointer;
      box-shadow: 0 1px 2px rgb(0 0 0 / .08), 0 4px 12px rgb(0 0 0 / .08);
      transition: background-color .12s, border-color .12s;
    }
    .margo-tray-toggle:hover { background: hsl(38 92% 92%); }
    .margo-tray-toggle:focus-visible { outline: 2px solid var(--margo-ring); outline-offset: 2px; }
    .margo-tray-icon { font-size: 14px; }
    .margo-tray-chev { transition: transform .12s ease; font-size: 10px; opacity: .6; }
    .margo-tray.margo-tray-open .margo-tray-chev { transform: rotate(180deg); }
    .margo-tray-list {
      display: flex; flex-direction: column; gap: 8px;
      max-height: 60vh; overflow: auto;
      padding: 4px; /* breathing room for focus rings */
    }
    .margo-orphan {
      width: 380px; max-width: 100%;
      background: var(--margo-bg); color: var(--margo-fg);
      border: 1px solid var(--margo-border); border-left: 3px solid hsl(38 92% 50%);
      border-radius: var(--margo-radius);
      box-shadow: 0 10px 15px -3px rgb(0 0 0 / .1), 0 4px 6px -4px rgb(0 0 0 / .1);
      padding: 0; overflow: hidden;
      animation: margo-pop .14s ease-out;
      display: flex; flex-direction: column;
    }
    /* Reuse panel header styling */
    .margo-orphan > header {
      display: flex; flex-direction: column; gap: 6px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--margo-border);
    }
    .margo-orphan-label {
      margin: 0; padding: 10px 16px 0;
      font-size: 12px; font-weight: 500; color: hsl(28 80% 32%);
    }
    .margo-orphan-quote {
      margin: 8px 16px 0; padding: 8px 10px;
      background: var(--margo-muted); border-left: 2px solid var(--margo-border);
      border-radius: 4px;
      font-size: 12px; color: var(--margo-muted-fg);
    }
    .margo-orphan-quote-text { text-decoration: line-through; text-decoration-color: hsl(0 60% 55% / .6); }
    .margo-orphan-meta {
      margin: 8px 16px 0;
      font-size: 11px; color: var(--margo-muted-fg);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      word-break: break-all;
    }
    .margo-orphan .margo-body { font-size: 13px; max-height: 160px; padding: 12px 16px 0; }
    /* ——— page-level bulk resolve (above the show-resolved toggle) ——— */
    .margo-bulk {
      position: fixed; bottom: 104px; right: 16px; z-index: 999999;
    }
    .margo-bulk-resolve {
      display: inline-flex; align-items: center; gap: 6px;
      height: 32px; padding: 0 12px;
      background: var(--margo-bg); color: var(--margo-fg);
      border: 1px solid var(--margo-border); border-radius: 9999px;
      font: inherit; font-size: 12px; font-weight: 500;
      cursor: pointer;
      box-shadow: 0 1px 2px rgb(0 0 0 / .08), 0 4px 12px rgb(0 0 0 / .08);
      transition: background-color .12s, border-color .12s;
    }
    .margo-bulk-resolve:hover { background: var(--margo-muted); }
    .margo-bulk-resolve:focus-visible { outline: 2px solid var(--margo-ring); outline-offset: 2px; }
    .margo-bulk-resolve:disabled { opacity: .6; cursor: not-allowed; }
    .margo-bulk-check { color: hsl(160 84% 39%); font-weight: 700; }
    /* ——— orphan tray "resolve all" (sticky inside the list) ——— */
    .margo-tray-resolve-all {
      align-self: stretch;
      height: 30px; padding: 0 12px;
      background: var(--margo-primary); color: var(--margo-primary-fg);
      border: 0; border-radius: 6px;
      font: inherit; font-size: 12px; font-weight: 500;
      cursor: pointer;
      transition: background-color .12s;
    }
    .margo-tray-resolve-all:hover { background: hsl(240 5.9% 18%); }
    .margo-tray-resolve-all:focus-visible { outline: 2px solid var(--margo-ring); outline-offset: 2px; }
    .margo-tray-resolve-all:disabled { opacity: .6; cursor: not-allowed; }
    /* ——— show-resolved toggle (bottom-right, above the launcher) ——— */
    .margo-show-resolved {
      position: fixed; bottom: 60px; right: 16px; z-index: 999999;
      display: inline-flex; align-items: center; gap: 8px;
      height: 32px; padding: 0 12px 0 6px;
      background: var(--margo-bg); color: var(--margo-muted-fg);
      border: 1px solid var(--margo-border); border-radius: 9999px;
      font: inherit; font-size: 12px; font-weight: 500;
      cursor: pointer;
      box-shadow: 0 1px 2px rgb(0 0 0 / .06);
      transition: color .12s, background-color .12s, border-color .12s;
    }
    .margo-show-resolved:hover { background: var(--margo-muted); }
    .margo-show-resolved:focus-visible { outline: 2px solid var(--margo-ring); outline-offset: 2px; }
    .margo-toggle-pill {
      width: 24px; height: 14px; border-radius: 9999px;
      background: var(--margo-border);
      position: relative; flex: 0 0 auto;
      transition: background-color .12s;
    }
    .margo-toggle-dot {
      position: absolute; top: 2px; left: 2px;
      width: 10px; height: 10px; border-radius: 9999px;
      background: var(--margo-bg);
      box-shadow: 0 1px 2px rgb(0 0 0 / .2);
      transition: transform .12s ease;
    }
    .margo-show-resolved-on { color: var(--margo-fg); border-color: var(--margo-ring); }
    .margo-show-resolved-on .margo-toggle-pill { background: var(--margo-primary); }
    .margo-show-resolved-on .margo-toggle-dot { transform: translateX(10px); }
    /* ——— muted styling for resolved pins / highlights / orphan cards ——— */
    .margo-pin[data-resolved] { opacity: .5; filter: grayscale(.45); }
    .margo-pin[data-resolved]:hover { opacity: .9; }
    .margo-hl[data-resolved] { opacity: .35; filter: grayscale(.55); }
    .margo-orphan[data-resolved] { opacity: .7; border-left-color: var(--margo-border); }
    .margo-orphan[data-resolved]:hover { opacity: 1; }
    /* ——— reopen action (Button: variant=outline, with an arrow hint) ——— */
    .margo-actions button[data-margo-action="reopen"] {
      background: var(--margo-bg); color: var(--margo-fg);
      border-color: var(--margo-border);
    }
    .margo-actions button[data-margo-action="reopen"]:hover { background: var(--margo-muted); }
    /* ——— modal (Dialog: backdrop + centered content) ——— */
    .margo-modal-backdrop {
      position: fixed; inset: 0; z-index: 2147483646;
      background: hsl(0 0% 0% / .55);
      display: flex; align-items: center; justify-content: center;
      padding: 24px;
      animation: margo-fade .14s ease-out;
    }
    @keyframes margo-fade { from { opacity: 0; } to { opacity: 1; } }
    .margo-modal {
      width: 100%; max-width: 440px;
      background: var(--margo-bg); color: var(--margo-fg);
      border: 1px solid var(--margo-border);
      border-radius: var(--margo-radius);
      box-shadow: 0 25px 50px -12px rgb(0 0 0 / .25);
      display: flex; flex-direction: column;
      animation: margo-zoom .14s ease-out;
      max-height: calc(100vh - 48px);
    }
    @keyframes margo-zoom {
      from { opacity: 0; transform: translateY(8px) scale(.96); }
      to   { opacity: 1; transform: none; }
    }
    .margo-modal header {
      display: flex; align-items: center; gap: 8px;
      padding: 16px 16px 12px;
      border-bottom: 1px solid var(--margo-border);
    }
    .margo-modal header h3 {
      margin: 0; font-size: 15px; font-weight: 600;
      flex: 1;
    }
    .margo-modal header .margo-close { margin-left: auto; }
    .margo-modal-body {
      padding: 16px;
      overflow: auto;
      display: flex; flex-direction: column; gap: 12px;
    }
    .margo-modal-message {
      margin: 0;
      font-size: 13px; color: var(--margo-muted-fg);
      white-space: pre-wrap;
    }
    .margo-modal-input {
      width: 100%; box-sizing: border-box;
      background: var(--margo-bg); color: var(--margo-fg);
      border: 1px solid var(--margo-border);
      border-radius: 6px;
      padding: 8px 10px;
      font: inherit; font-size: 13px; line-height: 1.4;
      resize: vertical;
      transition: border-color .12s, box-shadow .12s;
    }
    .margo-modal-input:focus {
      outline: none; border-color: var(--margo-ring);
      box-shadow: 0 0 0 3px hsl(240 5.9% 10% / .12);
    }
    .margo-modal-input::placeholder { color: hsl(240 3.8% 60%); }
    textarea.margo-modal-input { min-height: 80px; }
    .margo-modal footer {
      display: flex; justify-content: flex-end; gap: 8px;
      padding: 12px 16px 16px;
    }
    .margo-modal footer button {
      display: inline-flex; align-items: center; justify-content: center;
      height: 34px; padding: 0 14px;
      border-radius: 6px;
      font: inherit; font-size: 13px; font-weight: 500;
      cursor: pointer;
      transition: background-color .12s, border-color .12s, color .12s;
    }
    .margo-modal footer button:focus-visible {
      outline: 2px solid var(--margo-ring); outline-offset: 2px;
    }
    .margo-modal-cancel {
      background: var(--margo-bg); color: var(--margo-fg);
      border: 1px solid var(--margo-border);
    }
    .margo-modal-cancel:hover { background: var(--margo-muted); }
    .margo-modal-confirm {
      background: var(--margo-primary); color: var(--margo-primary-fg);
      border: 1px solid var(--margo-primary);
    }
    .margo-modal-confirm:hover { background: hsl(240 5.9% 18%); }
    .margo-modal-confirm.margo-modal-destructive {
      background: hsl(0 72% 51%); color: hsl(0 0% 100%);
      border-color: hsl(0 72% 51%);
    }
    .margo-modal-confirm.margo-modal-destructive:hover { background: hsl(0 72% 44%); }
  `;
  document.head.appendChild(style);
}
