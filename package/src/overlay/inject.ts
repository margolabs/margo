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
import type { Comment, CommentType, GitState } from '../shared/types.js';

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
  // Local repo state — drives the divergence diagnostics in expanded
  // orphan rows of the inbox.
  // Refreshed on SSE events (someone else's commit landed) and on tab focus
  // (user may have run git checkout / git pull in another terminal).
  let gitState: GitState | null = null;
  // Set when the server's RemotePoller spots new comment changes on upstream.
  // Drives the "N new comments · Pull" banner. Null when there's nothing
  // incoming (either we're up to date or we already pulled).
  let remoteIncoming: { added: string[]; modified: string[]; deleted: string[]; total: number } | null = null;
  // Persist the "show resolved" choice across reloads — surveying past
  // decisions is a recurring task, so the user shouldn't have to re-toggle.
  const showResolvedKey = 'margo:showResolved';
  let showResolved = localStorage.getItem(showResolvedKey) === '1';
  // Hide-pins toggle — flips off pin/highlight/orphan-tray rendering so
  // the user can review their product without comment dots cluttering it.
  // The FAB menu and other controls stay visible so the user can still
  // open the inbox, create new pins, etc. Persisted across reloads.
  const hidePinsKey = 'margo:hidePins';
  let hidePins = localStorage.getItem(hidePinsKey) === '1';
  root.toggleAttribute('data-margo-hidden', hidePins);
  // Inbox panel — cross-page list of all comments. Open state is persisted
  // in sessionStorage so cross-page navigation from the inbox doesn't drop
  // the user out of triage mode. (sessionStorage rather than localStorage:
  // closing the tab should reset, opening a new one starts fresh.)
  const inboxOpenKey = 'margo:inboxOpen';
  let inboxOpen = sessionStorage.getItem(inboxOpenKey) === '1';
  // When the inbox was open on the previous page and we landed here via a
  // hard navigation, skip the slide-in animation on the first render — it
  // wasn't really "opening," it's just continuing from the previous view.
  // Subsequent toggles (user-initiated) still animate.
  let suppressInboxEntranceAnim = inboxOpen;
  // Comments whose anchor on the current route returns lost-anchor. Shared
  // between renderAllPins (populates) and renderInboxPanel (reads, to badge
  // the affected rows). Only meaningful for the current route — comments on
  // other routes can't be checked without navigating.
  const orphanIds = new Set<string>();

  // Inbox filter state. Three independent dimensions on top of the existing
  // Open/All status tabs:
  // - mine: localStorage — durable preference ("I always want to see only mine")
  // - thisPage: sessionStorage — contextual to the current browsing session
  //   (durable would footgun: page B with this-page on hides everything else)
  // - search: volatile — clears on reload, no need to persist a transient query
  const filterMineKey = 'margo:filterMine';
  const filterThisPageKey = 'margo:filterThisPage';
  let filterMine = localStorage.getItem(filterMineKey) === '1';
  let filterThisPage = sessionStorage.getItem(filterThisPageKey) === '1';
  let searchQuery = '';

  const renderPins = () => {
    renderAllPins(root, store, sync, opts.mode === 'preview', me, showResolved, gitState, hidePins, orphanIds);
    renderInbox();
  };
  const renderInbox = () => {
    renderInboxPanel(
      root, store, sync, inboxOpen, opts.mode === 'preview', showResolved, orphanIds, me, gitState,
      { mine: filterMine, thisPage: filterThisPage, search: searchQuery },
      suppressInboxEntranceAnim,
      (next) => {
        // The inbox's "Open" / "All" filter doubles as the global show-resolved
        // control — there's no value in two separate UIs for the same idea.
        showResolved = next;
        localStorage.setItem(showResolvedKey, next ? '1' : '0');
        renderPins();
      },
      (patch) => {
        if (patch.mine !== undefined) {
          filterMine = patch.mine;
          localStorage.setItem(filterMineKey, patch.mine ? '1' : '0');
        }
        if (patch.thisPage !== undefined) {
          filterThisPage = patch.thisPage;
          sessionStorage.setItem(filterThisPageKey, patch.thisPage ? '1' : '0');
        }
        if (patch.search !== undefined) searchQuery = patch.search;
        renderInbox();
      },
      () => { inboxOpen = false; sessionStorage.setItem(inboxOpenKey, '0'); renderInbox(); },
    );
    // Only the very first render suppresses the entrance animation. Any
    // subsequent open (user click) animates normally.
    suppressInboxEntranceAnim = false;
  };

  const refreshGitState = async () => {
    if (opts.mode !== 'dev') return;
    const next = await sync.getGitState();
    if (next) { gitState = next; renderPins(); }
  };

  const renderRemoteBanner = () => {
    // Preview mode never sees this banner — there's nothing to "pull" into.
    if (opts.mode !== 'dev') return;
    renderRemoteChangesBanner(root, remoteIncoming, async () => {
      // Optimistic dismiss: the user clicked Pull, so hide the banner now.
      // If the pull fails, restore + surface the error.
      const stash = remoteIncoming;
      remoteIncoming = null;
      renderRemoteBanner();
      const result = await sync.syncFromRemote();
      if (!result.ok) {
        remoteIncoming = stash;
        renderRemoteBanner();
        await uiAlert(result.error, 'Pull failed');
        return;
      }
      // Pull succeeded. The CommentWatcher will fire add/change events for
      // the newly-arrived files, which already trigger refetchAndRender +
      // refreshGitState in the SSE handler above. Nothing else to do here.
    });
  };

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
      void refetchAndRender(store, renderPins).then(() => {
        // If the panel is open for the comment that just changed (e.g. the
        // user just submitted a reply, or a teammate did), surgically update
        // its thread so the user sees the new content without losing their
        // place. Skipped for 'deleted' — the panel's outside-click handler
        // already cleans up if the user navigates away.
        if (e.type === 'updated' || e.type === 'created') {
          refreshOpenPanelThreadIfMatches(store, e.id);
        }
      });
      // A new comment file probably means a teammate pushed; their push may
      // have advanced our HEAD via the background pull. Refresh git state too.
      void refreshGitState();
    }
    if (e.type === 'remote-changes') {
      remoteIncoming = e.total > 0
        ? { added: e.added, modified: e.modified, deleted: e.deleted, total: e.total }
        : null;
      renderRemoteBanner();
    }
  });

  sync.start();
  if (opts.mode === 'dev') {
    void (async () => {
      let u = await sync.getMe();
      // Missing git config user.name / user.email is the most common cause of
      // "author api failed" surfacing later when the user clicks Pin. Catch
      // it now, prompt for setup, persist via `git config --global`, then
      // continue normally.
      if (!u) u = await openIdentitySetup(sync);
      me = u;
      renderPins();
    })();
    void refreshGitState();
    // Catches the common case: user runs `git checkout other-branch` in a
    // terminal, alt-tabs back to the browser. Without this the inbox would
    // still show divergence diagnostics for the previous branch.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void refreshGitState();
    });
  }
  // Toggle is rendered once and lives outside renderAllPins (which clears its
  // own children every cycle). The button mutates `showResolved` and triggers
  // a re-render — no need to re-create the toggle each time.
  renderHidePinsToggle(root, hidePins, (next) => {
    hidePins = next;
    localStorage.setItem(hidePinsKey, next ? '1' : '0');
    root.toggleAttribute('data-margo-hidden', next);
    renderPins();
  });
  renderInboxToggle(root, () => {
    inboxOpen = !inboxOpen;
    sessionStorage.setItem(inboxOpenKey, inboxOpen ? '1' : '0');
    renderInbox();
    if (inboxOpen) setFabOpen(false); // collapse menu when surfacing the panel
  });

  // Single primary FAB collapses all the sub-actions (pin, pin gap, inbox,
  // hide-pins) into one button. State is intentionally NOT persisted —
  // every page load starts collapsed, the whole point is unobtrusiveness.
  let fabOpen = false;
  const setFabOpen = (next: boolean) => {
    if (next === fabOpen) return;
    fabOpen = next;
    root.toggleAttribute('data-margo-fab-open', next);
    fabMain.setAttribute('aria-expanded', String(next));
    fabMain.setAttribute('aria-label', next ? 'close margo menu' : 'open margo menu');
  };
  const fabMain = document.createElement('button');
  fabMain.type = 'button';
  fabMain.className = 'margo-fab-main';
  fabMain.setAttribute('aria-expanded', 'false');
  fabMain.setAttribute('aria-label', 'open margo menu');
  fabMain.title = 'Margo';
  fabMain.innerHTML = `<span class="margo-fab-main-pin">📌</span><span class="margo-fab-main-label">Pin</span><span class="margo-fab-main-chev" aria-hidden="true">▾</span>`;
  fabMain.addEventListener('click', (e) => {
    e.stopPropagation();
    setFabOpen(!fabOpen);
  });
  root.appendChild(fabMain);

  // Bubble-phase click listener. Sub-FAB's own click handler runs first
  // (target phase); we collapse the menu after, so the close never fights
  // with the action. Outside-click anywhere → collapse.
  document.addEventListener('click', (e) => {
    if (!fabOpen) return;
    const t = e.target as Element | null;
    if (!t) return;
    // The main pill manages its own toggle in its click handler — nothing to
    // do here when it's the target.
    if (fabMain.contains(t)) return;
    setFabOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && fabOpen) setFabOpen(false);
  });

  // Hash deep-link: `#margo=<id>` makes the overlay scroll to that pin once
  // it lands. Used by inbox cross-page navigation. Cleared after handling
  // so it doesn't re-trigger on subsequent renders.
  handleHashDeepLink();
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
  // Capture-phase scroll listener catches scrolling on *any* ancestor, not
  // just the document — without this, a pin inside an overflow:auto card
  // would stay anchored to its old viewport position while the underlying
  // element scrolled away. `passive: true` so we never interfere with the
  // browser's smooth-scroll path.
  //
  // Skip scrolls originating inside the overlay itself (e.g. the inbox list).
  // Without this filter, scrolling the inbox triggers renderInbox via
  // renderPins, which rebuilds panel.innerHTML and resets scrollTop to 0 —
  // the scrollbar appears but every scroll tick snaps back to top.
  window.addEventListener('scroll', (e) => {
    const t = e.target;
    if (t instanceof Element && t.closest('[data-margo]')) return;
    schedule();
  }, { capture: true, passive: true });
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(schedule).observe(document.documentElement);
  }
  // Catch DOM mutations (font load, async content, tab/wizard panel swaps)
  // that change phrase positions or which view is currently shown. We watch
  // attribute changes too — toggling `hidden`, `aria-selected`, `aria-current`,
  // `aria-expanded`, `data-state`, `style`, or `class` is how almost every
  // tab/wizard/accordion UI signals a view change, and those are attribute
  // mutations (no children added/removed). Without attributes:true the pin
  // resolver never re-fires after the user clicks a tab, and the stale
  // "previous view" pin stays drawn forever.
  //
  // Skip mutations inside the overlay itself, otherwise rendering pins triggers
  // the observer and we infinite-loop.
  const RELEVANT_ATTRS = [
    'hidden', 'aria-selected', 'aria-current', 'aria-expanded',
    'aria-hidden', 'aria-pressed', 'data-state', 'data-step',
    'style', 'class',
  ];
  new MutationObserver((records) => {
    for (const m of records) {
      const t = m.target as Node;
      if (t.nodeType === Node.ELEMENT_NODE && (t as Element).closest('[data-margo]')) continue;
      // For attribute changes, only react to ones that plausibly affect
      // visibility / which view is active. Otherwise every focus ring or
      // input event would re-render pins.
      if (m.type === 'attributes' && (!m.attributeName || !RELEVANT_ATTRS.includes(m.attributeName))) continue;
      schedule();
      return;
    }
  }).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: RELEVANT_ATTRS,
  });

  if (opts.mode === 'dev') {
    enablePinComposer(root, sync, renderPins);
  }
}

async function refetchAndRender(
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

// If the comment panel is currently open and shows the comment that just
// changed, replace JUST the thread (not the header/banner/reply form/
// footer). Keeps the reply form's draft + collapse state intact and avoids
// re-running the panel's entrance animation. The new thread is scrolled to
// the bottom so the just-arrived message is visible without manual scroll.
function refreshOpenPanelThreadIfMatches(
  store: Map<string, Comment>,
  id: string,
): void {
  const panel = document.querySelector('.margo-panel') as HTMLElement | null;
  if (!panel || panel.dataset.commentId !== id) return;
  const c = store.get(id);
  if (!c) return;
  const oldThread = panel.querySelector('.margo-thread');
  if (!oldThread) return;
  const temp = document.createElement('div');
  temp.innerHTML = renderThread(c);
  const next = temp.firstElementChild as HTMLElement | null;
  if (!next) return;
  oldThread.replaceWith(next);
  next.scrollTop = next.scrollHeight;
}

function renderAllPins(
  root: HTMLElement,
  store: Map<string, Comment>,
  sync: SyncClient,
  readOnly: boolean,
  me: { email: string } | null,
  showResolved: boolean,
  gitState: GitState | null,
  hidePins: boolean,
  orphanIds: Set<string>,
): void {
  // Clear existing pin + highlight nodes (keep the launcher and toggle)
  for (const el of Array.from(root.querySelectorAll('[data-margo-pin],[data-margo-highlight]'))) el.remove();
  // Reset for this render — same Set instance so callers (the inbox) see
  // updates without re-passing.
  orphanIds.clear();
  // Focus mode: leave the cleared state — no pins, no tray, no bulk bar.
  // Other affordances (launcher, show-resolved toggle) are hidden via CSS
  // on the [data-margo-hidden] root attribute set by start().
  if (hidePins) return;
  const url = currentRoute();
  const orphans: Comment[] = [];
  const onPage: Comment[] = []; // unresolved-only — bulk resolve operates on these
  for (const c of store.values()) {
    const isResolved = c.frontmatter.status === 'resolved' || c.frontmatter.status === 'wontfix';
    if (isResolved && !showResolved) continue;
    const result = resolveTarget(c.frontmatter.target, url);
    if (result.kind === 'wrong-route') continue;
    // wrong-view: comment is for THIS route but a different view state
    // (other tab, other wizard step, etc.). Suppress the pin without
    // orphaning — the user can navigate back to the original view to
    // see the pin again, and the comment stays visible in the inbox.
    if (result.kind === 'wrong-view') continue;
    if (result.kind === 'lost-anchor') {
      orphans.push(c);
      orphanIds.add(c.frontmatter.id);
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
    // Pin position: anchor to the live rect for every anchor kind. The rect
    // is what `getBoundingClientRect()` produces, so it reflects the element's
    // current viewport position whether the page, an inner overflow:auto
    // container, or anything else has scrolled.
    //
    // We used to take a different path for element/container anchors —
    // scaling the captured click point (target.coords) by viewport ratios.
    // That only handled window resize. On scroll, `cap.coords` is the
    // viewport position *at capture time* and combining it with the
    // *current* `window.scrollX/Y` gave a document position fixed to the
    // capture-time scroll. The highlight tracked correctly but the pin
    // drifted by exactly the scroll delta. Top-right of the rect is the
    // same place users park the dot anyway.
    const PIN_SIZE = 22;
    const PAD = 4;
    const docLeft = r.left + r.width - 8 + window.scrollX;
    const docTop = r.top - 8 + window.scrollY;
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
    pin.addEventListener('mouseenter', () => { setHover(true); showTooltip(pin, tipText, c.frontmatter.id); });
    pin.addEventListener('mouseleave', () => { setHover(false); hideTooltip(); });
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTooltip();
      openCommentPanel(root, c, sync, readOnly, me, pin);
    });
    root.appendChild(pin);
  }

  // Orphaned comments are surfaced inside the inbox panel (sorted to top,
  // expandable inline with diagnostics + actions). renderAllPins only needs
  // to populate the shared orphanIds Set so renderInboxPanel can read it.
}

function renderInboxToggle(root: HTMLElement, onClick: () => void): void {
  // Stays mounted across renders; the panel itself is rebuilt on demand.
  // Click toggles the open/closed state via the supplied callback.
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'margo-inbox-toggle';
  btn.dataset.margoToggle = 'inbox';
  btn.setAttribute('aria-label', 'open margo inbox');
  btn.title = 'All comments — across every page';
  btn.innerHTML = `<span class="margo-eye">📋</span><span>inbox</span>`;
  btn.addEventListener('click', onClick);
  root.appendChild(btn);
}

interface InboxFilterState {
  mine: boolean;
  thisPage: boolean;
  search: string;
}

function renderInboxPanel(
  root: HTMLElement,
  store: Map<string, Comment>,
  sync: SyncClient,
  open: boolean,
  readOnly: boolean,
  showResolved: boolean,
  orphanIds: Set<string>,
  me: { email: string } | null,
  gitState: GitState | null,
  filters: InboxFilterState,
  suppressEntranceAnim: boolean,
  onShowResolvedChange: (next: boolean) => void,
  onFiltersChange: (patch: Partial<InboxFilterState>) => void,
  onClose: () => void,
): void {
  let panel = root.querySelector('[data-margo-inbox]') as HTMLElement | null;
  if (!open) {
    if (panel) panel.remove();
    return;
  }
  // Reuse the existing panel when present — only the inner content changes
  // on filter swap / list refresh / SSE events. Avoids the slide-in
  // animation re-firing and avoids the 1-frame flash that destroy+rebuild
  // shows. First open (no existing panel) plays the entrance animation
  // unless the caller asked us to skip it (e.g. session-restored after a
  // cross-page nav).
  if (!panel) {
    panel = document.createElement('aside');
    panel.dataset.margoInbox = '';
    panel.className = suppressEntranceAnim ? 'margo-inbox margo-inbox-no-animate' : 'margo-inbox';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'margo inbox');
    root.appendChild(panel);
  }

  // Preserve the user's typing across the imminent innerHTML rebuild — SSE
  // events, status changes, and filter toggles all re-render the panel, and
  // we don't want any of them to wipe the search box mid-keystroke. Capture
  // the input's current value (which may be ahead of state.search if a
  // re-render fires during a fast-typing burst), focus, and selection.
  const existingSearch = panel.querySelector<HTMLInputElement>('.margo-inbox-search-input');
  const searchFocusState = existingSearch && document.activeElement === existingSearch
    ? {
      value: existingSearch.value,
      selectionStart: existingSearch.selectionStart,
      selectionEnd: existingSearch.selectionEnd,
    }
    : null;

  // The "Open" / "All" filter is bound to the global show-resolved state
  // (see start()), so the inbox doubles as the show-resolved control.
  const openStatuses: ReadonlySet<string> = new Set(['open', 'in-progress', 'ready-for-review', 'blocked']);
  const visibleStatuses: ReadonlySet<string> = showResolved
    ? new Set([...openStatuses, 'resolved', 'wontfix'])
    : openStatuses;
  const route = currentRoute();
  const meEmail = me?.email ?? null;
  // Each chip count is computed by applying every OTHER active filter but
  // not the chip's own dimension — so the number on "This page · N" shows
  // how many comments would be visible if the user toggled that filter on.
  // Search is always applied (it's a continuous reduction, not a tab).
  const q = filters.search.trim().toLowerCase();
  const matchesSearch = (c: Comment): boolean => {
    if (!q) return true;
    const url = c.frontmatter.target.url || '';
    const author = (c.frontmatter.authorName || c.frontmatter.author || '').toLowerCase();
    return (
      author.includes(q) ||
      c.frontmatter.id.toLowerCase().includes(q) ||
      url.toLowerCase().includes(q) ||
      c.body.toLowerCase().includes(q)
    );
  };
  const matchesMine = (c: Comment): boolean => !meEmail || c.frontmatter.author === meEmail;
  const matchesThisPage = (c: Comment): boolean => c.frontmatter.target.url === route;

  // Final visible list: status + mine + thisPage + search.
  // Sort: orphans first (they need attention), then by created desc.
  // Stable sort preserves the date order within each group.
  const all = Array.from(store.values())
    .filter((c) => visibleStatuses.has(c.frontmatter.status))
    .filter((c) => (!filters.mine || matchesMine(c)))
    .filter((c) => (!filters.thisPage || matchesThisPage(c)))
    .filter(matchesSearch)
    .sort((a, b) => (b.frontmatter.created || '').localeCompare(a.frontmatter.created || ''))
    .sort((a, b) => {
      // Resolved comments aren't actionable orphans even if their anchor
      // doesn't resolve — don't yank them to the top of the All view with
      // the "anchor lost" treatment.
      const ao = orphanIds.has(a.frontmatter.id) && openStatuses.has(a.frontmatter.status) ? 0 : 1;
      const bo = orphanIds.has(b.frontmatter.id) && openStatuses.has(b.frontmatter.status) ? 0 : 1;
      return ao - bo;
    });

  // Chip counts. For status tabs we also apply mine/thisPage/search; for
  // the mine chip we drop mine; for thisPage we drop thisPage.
  const baseFiltered = Array.from(store.values())
    .filter((c) => (!filters.mine || matchesMine(c)))
    .filter((c) => (!filters.thisPage || matchesThisPage(c)))
    .filter(matchesSearch);
  const openCount = baseFiltered.filter((c) => openStatuses.has(c.frontmatter.status)).length;
  const allCount = baseFiltered.length;
  // For Mine count: respect status (current showResolved) + thisPage + search,
  // and count what's mine.
  const mineCount = Array.from(store.values())
    .filter((c) => visibleStatuses.has(c.frontmatter.status))
    .filter((c) => (!filters.thisPage || matchesThisPage(c)))
    .filter(matchesSearch)
    .filter(matchesMine).length;
  const thisPageCount = Array.from(store.values())
    .filter((c) => visibleStatuses.has(c.frontmatter.status))
    .filter((c) => (!filters.mine || matchesMine(c)))
    .filter(matchesSearch)
    .filter(matchesThisPage).length;

  // Unresolved comments anchored to the current page — drives the
  // contextual "Resolve N on this page" button at the top of the list.
  // Independent of filters because the action operates on a fixed scope.
  const onPage = Array.from(store.values()).filter((c) =>
    openStatuses.has(c.frontmatter.status) && c.frontmatter.target.url === route,
  );
  // Orphans visible in the current filter — drives the "Resolve N orphans"
  // bulk action. Resolved/wontfix comments are never actionable orphans, so
  // exclude them even when they sneak in via the All view.
  const visibleOrphans = all.filter(
    (c) => orphanIds.has(c.frontmatter.id) && openStatuses.has(c.frontmatter.status),
  );

  // Hide the "Mine" chip when we don't know the user (preview mode).
  const showMineChip = !!meEmail;
  // Single unified chip row. Open/All are radio-like (clicking one selects
  // it, the other deselects); Mine/This page are independent toggles. A
  // hairline divider visually groups them without enforcing it via separate
  // rows. Order is intentional: status first (anchors the user's mental
  // model — "am I looking at open or everything?"), then narrow-or-widen
  // toggles to the right.
  panel.innerHTML = `
    <header class="margo-inbox-header">
      <div class="margo-inbox-titlebar">
        <strong>Inbox</strong>
        <span class="margo-inbox-count">${all.length} ${all.length === 1 ? 'comment' : 'comments'}</span>
        <button type="button" class="margo-inbox-close" aria-label="close inbox">×</button>
      </div>
      <div class="margo-inbox-search">
        <span class="margo-inbox-search-icon" aria-hidden="true">🔍</span>
        <input
          type="search"
          class="margo-inbox-search-input"
          placeholder="Search comments…"
          value="${escapeHtml(filters.search)}"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <div class="margo-inbox-chips" role="group" aria-label="filters">
        <button type="button" class="margo-inbox-chip margo-inbox-chip-status" data-chip="open" aria-pressed="${!showResolved}">Open · ${openCount}</button>
        <button type="button" class="margo-inbox-chip margo-inbox-chip-status" data-chip="all" aria-pressed="${showResolved}">All · ${allCount}</button>
        <span class="margo-inbox-chips-divider" aria-hidden="true"></span>
        ${showMineChip ? `<button type="button" class="margo-inbox-chip" data-chip="mine" aria-pressed="${filters.mine}">Mine · ${mineCount}</button>` : ''}
        <button type="button" class="margo-inbox-chip" data-chip="thisPage" aria-pressed="${filters.thisPage}">This page · ${thisPageCount}</button>
      </div>
    </header>
    <div class="margo-inbox-list" role="list"></div>
  `;
  const list = panel.querySelector('.margo-inbox-list') as HTMLElement;

  // Restore the search input's value + focus + selection if it was focused
  // before this re-render. Done before re-binding so the listener sees the
  // restored value if the user keeps typing.
  if (searchFocusState) {
    const newSearch = panel.querySelector<HTMLInputElement>('.margo-inbox-search-input');
    if (newSearch) {
      newSearch.value = searchFocusState.value;
      newSearch.focus();
      try {
        newSearch.setSelectionRange(searchFocusState.selectionStart ?? 0, searchFocusState.selectionEnd ?? 0);
      } catch {
        // setSelectionRange on type=search can throw in older Safari — non-fatal.
      }
    }
  }

  // Bulk action: only when there are >1 orphaned comments (1 expands fine
  // inline), and we're not in preview/read-only. Sits at the very top
  // because orphans need attention — easy to see, easy to clear in bulk.
  if (!readOnly && visibleOrphans.length > 1) {
    const bulk = document.createElement('button');
    bulk.type = 'button';
    bulk.className = 'margo-inbox-bulk margo-inbox-bulk-orphan';
    bulk.innerHTML = `<span class="margo-bulk-warn">⚠</span> Resolve all ${visibleOrphans.length} orphaned`;
    bulk.addEventListener('click', () => bulkResolve(bulk, visibleOrphans, sync, 'orphans'));
    list.appendChild(bulk);
  }
  // On-page bulk: same rationale as before, but only show when there are
  // >1 unresolved comments on the current route. Orphans aren't included
  // here — they have their own bulk above.
  if (!readOnly && onPage.length > 1) {
    const bulk = document.createElement('button');
    bulk.type = 'button';
    bulk.className = 'margo-inbox-bulk';
    bulk.innerHTML = `<span class="margo-bulk-check">✓</span> Resolve ${onPage.length} on this page`;
    bulk.addEventListener('click', () => bulkResolve(bulk, onPage, sync, 'on this page'));
    list.appendChild(bulk);
  }

  if (all.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'margo-inbox-empty';
    // Tailor the empty-state message to the active filters so the user
    // knows WHY the list is empty (and what to toggle to fix it).
    const hasNarrowingFilter = filters.mine || filters.thisPage || q.length > 0;
    if (hasNarrowingFilter) {
      empty.textContent = 'No matches. Try clearing filters or search.';
    } else if (!showResolved) {
      empty.textContent = 'No open comments. Switch to All to see resolved ones.';
    } else {
      empty.textContent = 'No comments yet. Pin something on the live app.';
    }
    list.appendChild(empty);
  } else {
    for (const c of all) {
      const isOrphan = orphanIds.has(c.frontmatter.id) && openStatuses.has(c.frontmatter.status);
      list.appendChild(renderInboxItem(
        c,
        isOrphan,
        // Orphans can't be navigated to (no pin to land on), so clicking
        // opens the standard comment panel anchored to the inbox row. The
        // panel's positioner places it to the left of the inbox when the
        // inbox is open, giving the "popup beside the list item" feel.
        isOrphan
          ? (item) => openCommentPanel(root, c, sync, readOnly, me, item, { orphan: { gitState } })
          : undefined,
      ));
    }
  }

  panel.querySelector('.margo-inbox-close')!.addEventListener('click', onClose);
  // All filter chips in one row. Open/All are radio-like (clicking a
  // not-currently-selected one flips showResolved); Mine/This page are
  // independent toggles. Clicking the already-pressed status chip is a
  // no-op — they don't both deselect because status is required.
  for (const chip of Array.from(panel.querySelectorAll<HTMLElement>('.margo-inbox-chip'))) {
    chip.addEventListener('click', () => {
      const dim = chip.dataset.chip as 'open' | 'all' | 'mine' | 'thisPage';
      if (dim === 'open') {
        if (showResolved) onShowResolvedChange(false);
      } else if (dim === 'all') {
        if (!showResolved) {
          // "All" reads as "expand to everything" — silently leaving the
          // page-scope narrowing on contradicts that intent and made users
          // think the count was buggy ("All · N counted only this page").
          // Mine stays — it's a user scope, not a visibility expansion.
          onShowResolvedChange(true);
          if (filters.thisPage) onFiltersChange({ thisPage: false });
        }
      } else if (dim === 'mine') {
        onFiltersChange({ mine: !filters.mine });
      } else {
        onFiltersChange({ thisPage: !filters.thisPage });
      }
    });
  }
  // Search input — instant filter, no debounce. Capture+restore around the
  // re-render keeps the cursor put. The chip counts get recomputed too.
  const searchInput = panel.querySelector<HTMLInputElement>('.margo-inbox-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      onFiltersChange({ search: searchInput.value });
    });
  }
}

function renderInboxItem(
  c: Comment,
  isOrphan: boolean,
  onClick?: (item: HTMLElement) => void,
): HTMLElement {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'margo-inbox-item';
  item.dataset.commentId = c.frontmatter.id;
  item.dataset.status = c.frontmatter.status;
  if (isOrphan) item.dataset.orphan = '';
  const url = c.frontmatter.target.url || '/';
  const preview = (c.body.split(/\n---\n/)[0] || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const author = c.frontmatter.authorName || c.frontmatter.author;
  const orphanBadge = isOrphan ? `<span class="margo-inbox-item-orphan" title="Anchor not found on this view">⚠ anchor lost</span>` : '';
  const avatarColor = colorForEmail(c.frontmatter.author);
  const avatarInitial = initialOf(c.frontmatter.authorName || c.frontmatter.author);
  item.innerHTML = `
    <span class="margo-inbox-item-avatar" style="background:${avatarColor.bg};color:${avatarColor.fg}" title="${escapeHtml(c.frontmatter.author)}">${escapeHtml(avatarInitial)}</span>
    <span class="margo-inbox-item-main">
      <span class="margo-inbox-item-head">
        <code class="margo-inbox-item-id">${escapeHtml(c.frontmatter.id)}</code>
        ${orphanBadge}
        <span class="margo-inbox-item-url">${escapeHtml(url)}</span>
        <span class="margo-inbox-item-status" data-status="${escapeHtml(c.frontmatter.status)}">${escapeHtml(c.frontmatter.status)}</span>
      </span>
      <span class="margo-inbox-item-body">${escapeHtml(preview) || '<em>(empty)</em>'}</span>
      <span class="margo-inbox-item-foot">
        <span>${escapeHtml(author)}</span>
        <span>${escapeHtml(formatTime(c.frontmatter.created))}</span>
      </span>
    </span>
  `;
  if (onClick) {
    item.addEventListener('click', () => onClick(item));
  } else {
    item.addEventListener('click', () => navigateToComment(c.frontmatter.target.url, c.frontmatter.id));
  }
  return item;
}

function navigateToComment(targetUrl: string, commentId: string): void {
  // Same-route → just scroll. The pin is already in the DOM (or will be on
  // the next render cycle if it was off-screen).
  const currentRoute = window.location.pathname + window.location.search;
  const targetPath = targetUrl.split('#')[0];
  if (currentRoute === targetPath || currentRoute === targetUrl) {
    suppressNextPanelAnim = true;
    scrollToPin(commentId);
    requestAnimationFrame(() => { suppressNextPanelAnim = false; });
    return;
  }
  // Different route → hard navigation. There's no framework-agnostic way
  // to trigger SPA navigation from vanilla code (Next.js's router is only
  // accessible via a React hook; React Router's API is similar). The
  // overlay's session-restored inbox + suppressed entrance animations on
  // the new page make the transition as smooth as the platform allows.
  window.location.assign(`${targetUrl}${targetUrl.includes('#') ? '&' : '#'}margo=${commentId}`);
}

function scrollToPin(commentId: string): void {
  // Pin DOM may not be present yet (cross-page SPA nav: framework needs to
  // render the new page, then the overlay's route tracker re-renders pins).
  // Retry generously — at 60fps, ~30 frames covers ~480ms which is enough
  // for typical Next.js / Vite re-render after a pushState.
  let tries = 0;
  const attempt = () => {
    const pin = document.querySelector(`[data-margo-pin="${CSS.escape(commentId)}"]`) as HTMLElement | null;
    if (pin) {
      pin.scrollIntoView({ behavior: 'smooth', block: 'center' });
      pin.classList.add('margo-pin-pulse');
      setTimeout(() => pin.classList.remove('margo-pin-pulse'), 1500);
      // Bonus: open the comment panel so the user lands on the body, not just the dot.
      pin.click();
      return;
    }
    if (++tries < 30) requestAnimationFrame(attempt);
  };
  attempt();
}

// Module-level flag: openCommentPanel reads this on its next call to decide
// whether to skip the pop-in animation. Used by handleHashDeepLink so that
// arriving at a new page via inbox cross-page nav doesn't make the panel
// appear to "render" again — it should feel like a continuation.
let suppressNextPanelAnim = false;

function handleHashDeepLink(): void {
  // Format: `#margo=<id>` (or appended after an existing hash via `&`).
  const hash = window.location.hash;
  const m = hash.match(/[#&]margo=([\w.-]+)/);
  if (!m) return;
  const id = m[1];
  // Strip the margo segment from the hash so re-renders don't re-trigger.
  const cleaned = hash.replace(/[#&]margo=[\w.-]+/, '').replace(/^#$/, '');
  history.replaceState(null, '', window.location.pathname + window.location.search + cleaned);
  // Defer until the snapshot lands and the resolver has a shot at the pin.
  setTimeout(() => {
    suppressNextPanelAnim = true;
    scrollToPin(id);
    // If scrollToPin finds the pin, openCommentPanel runs synchronously and
    // consumes the flag. If not, clear it on the next frame so a later
    // user-initiated pin click still gets its animation.
    requestAnimationFrame(() => { suppressNextPanelAnim = false; });
  }, 400);
}

function renderRemoteChangesBanner(
  root: HTMLElement,
  state: { added: string[]; modified: string[]; deleted: string[]; total: number } | null,
  onPull: () => Promise<void> | void,
): void {
  const existing = root.querySelector('.margo-remote-banner');
  if (!state) {
    existing?.remove();
    return;
  }
  // Reuse the existing node when present so the banner doesn't flicker if a
  // subsequent remote-changes event arrives with a different count.
  const banner = (existing as HTMLDivElement | null) ?? document.createElement('div');
  if (!existing) {
    banner.className = 'margo-remote-banner';
    banner.setAttribute('role', 'status');
    root.appendChild(banner);
  }
  const noun = state.total === 1 ? 'comment' : 'comments';
  banner.innerHTML = `
    <span class="margo-remote-banner-text">${state.total} new ${noun} on origin</span>
    <button type="button" class="margo-remote-banner-pull">Pull</button>
    <button type="button" class="margo-remote-banner-dismiss" aria-label="dismiss">×</button>
  `;
  const pullBtn = banner.querySelector('.margo-remote-banner-pull') as HTMLButtonElement;
  const dismissBtn = banner.querySelector('.margo-remote-banner-dismiss') as HTMLButtonElement;
  pullBtn.addEventListener('click', async () => {
    pullBtn.disabled = true;
    pullBtn.textContent = 'Pulling…';
    await onPull();
  });
  // Dismiss is local-only: the next poller tick will re-surface the banner
  // if upstream still has changes the user hasn't pulled. That's deliberate —
  // the user can stash the nag for a minute without losing it for good.
  dismissBtn.addEventListener('click', () => banner.remove());
}

function renderHidePinsToggle(
  root: HTMLElement,
  initial: boolean,
  onChange: (next: boolean) => void,
): void {
  // Stays visible at all times — it's the only escape hatch out of focus
  // mode once the user toggles the rest of the overlay off. The `pinned`
  // dataset bit raises its z-index/contrast above other overlay UI.
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'margo-hide-pins';
  btn.dataset.margoToggle = 'hide-pins';
  let value = initial;
  const refresh = () => {
    btn.classList.toggle('margo-hide-pins-on', value);
    btn.setAttribute('aria-pressed', String(value));
    btn.setAttribute('aria-label', value ? 'show margo pins' : 'hide margo pins');
    btn.title = value ? 'Pins hidden — click to show' : 'Hide pins to view your product without overlay';
    btn.innerHTML = value
      ? `<span class="margo-eye">👁</span><span>show pins</span>`
      : `<span class="margo-eye">⊘</span><span>hide pins</span>`;
  };
  refresh();
  btn.addEventListener('click', () => {
    value = !value;
    refresh();
    onChange(value);
  });
  root.appendChild(btn);
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

// Diagnose why a comment failed to anchor on this view.
// Order of checks matters — a dirty author WT poisons the comment regardless
// of commit match, so we surface that first. After that, commit drift is the
// most common cause; viewer's own dirty WT is checked last because it's the
// most recoverable.
function diagnoseOrphan(c: Comment, gitState: GitState | null): { label: string; hint: string | null } {
  const target = c.frontmatter.target;
  if (!gitState) {
    return { label: 'Anchor not found in this view.', hint: null };
  }
  // Commit mismatch is the dominant signal — when the pin's commit and the
  // viewer's commit differ, anything else (author-was-dirty, viewer-is-dirty)
  // is secondary noise. The element legitimately may have been added,
  // removed, or restructured between commits.
  if (target.commit && gitState.commit && target.commit !== gitState.commit) {
    const behind = gitState.behind ?? 0;
    const hint = behind > 0
      ? `You're ${behind} commit${behind === 1 ? '' : 's'} behind upstream — try \`git pull\`.`
      : `Author was on commit \`${target.commit}\`; you're on \`${gitState.commit}\`. The element may exist on a different branch or commit.`;
    return {
      label: `Pinned at ${target.commit} — you're on ${gitState.commit}.`,
      hint,
    };
  }
  // Same commit. The viewer's own dirty WT can hide an element that exists
  // in HEAD — surface that before pointing fingers at the author.
  if (gitState.dirty) {
    return {
      label: `Your working tree has ${gitState.dirtyCount} uncommitted file${gitState.dirtyCount === 1 ? '' : 's'}.`,
      hint: 'This anchor may exist in HEAD but be hidden by your local changes. Stash or revert to re-check.',
    };
  }
  // Same commit, viewer is clean. Now author-was-dirty is a real
  // explanation: the element only ever existed in their working tree.
  if (target.dirty) {
    return {
      label: "Pinned with author's uncommitted changes.",
      hint: "This element may have only existed in their working tree at pin time. If they've committed since, try git pull.",
    };
  }
  return {
    label: 'Element no longer exists in the code at this commit.',
    hint: null,
  };
}

// Compact, panel-embedded version of the orphan card content. Used when the
// comment panel is opened for an orphaned comment from the inbox — there's
// no pin to anchor the panel to in the page itself, so the banner replaces
// what the pin's visual presence would have conveyed (which element, what
// the anchor text was, and why we couldn't find it).
function buildOrphanBannerHtml(c: Comment, gitState: GitState | null): string {
  const diag = diagnoseOrphan(c, gitState);
  const target = c.frontmatter.target;
  const quoted = target.textAnchor?.phrase ?? target.text ?? '';
  const role = target.role ?? '';
  const wasAt = `${role ? `&lt;${escapeHtml(role)}&gt;` : ''}${role ? ' on ' : ''}${escapeHtml(target.url || '/')}`;
  return `
    <div class="margo-panel-orphan">
      <p class="margo-panel-orphan-label">${escapeHtml(diag.label)}</p>
      ${diag.hint ? `<p class="margo-panel-orphan-hint">${escapeHtml(diag.hint)}</p>` : ''}
      ${quoted ? `<blockquote class="margo-panel-orphan-quote"><span class="margo-panel-orphan-quote-text">${escapeHtml(truncate(quoted, 200))}</span></blockquote>` : ''}
      <p class="margo-panel-orphan-meta">${wasAt}</p>
    </div>
  `;
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


interface OpenPanelOptions {
  // When present, render a small diagnostic banner near the top of the
  // panel — used when the panel is opened for an orphaned comment from the
  // inbox (no pin exists to anchor it; the banner replaces what the pin's
  // visual presence would have conveyed).
  orphan?: { gitState: GitState | null };
}

function openCommentPanel(
  root: HTMLElement,
  c: Comment,
  sync: SyncClient,
  readOnly: boolean,
  me: { email: string } | null,
  anchor?: Element,
  options?: OpenPanelOptions,
): void {
  // Reuse the existing panel element when present so swapping between
  // comments (clicking through the inbox) doesn't destroy + rebuild the
  // DOM. Only the inner content + handlers + position get updated.
  let panel = root.querySelector('.margo-panel') as HTMLElement | null;
  const isUpdate = !!panel;
  if (!panel) {
    panel = document.createElement('div');
    // Skip the entrance animation when the deep-link handler set the flag.
    // The user already feels mid-flow (just clicked from inbox + crossed
    // page); a pop-in here reads as a re-render.
    panel.className = suppressNextPanelAnim ? 'margo-panel margo-panel-no-animate' : 'margo-panel';
    suppressNextPanelAnim = false;
    root.appendChild(panel);
  }
  // Header layout: author + status on the left, primary action (Resolve /
  // Reopen) + ⋯ overflow + close on the right. This keeps actions inline
  // with the comment identity, mirroring Slack / Linear / Zeplin, and saves
  // a whole horizontal row below the thread.
  // Prefer a friendly display name in the header — full email is verbose
  // and forces the toolbar buttons off the visible row. Hovering surfaces
  // the canonical email for cases where two teammates share a first name.
  const displayName = displayNameOf(c.frontmatter);
  const orphanBanner = options?.orphan ? buildOrphanBannerHtml(c, options.orphan.gitState) : '';
  panel.innerHTML = `
    <header>
      <div class="margo-panel-titlebar">
        <div class="margo-panel-identity">
          <strong class="margo-panel-author" title="${escapeHtml(c.frontmatter.author)}">${escapeHtml(displayName)}</strong>
          <div class="margo-panel-meta">
            ${c.frontmatter.role ? `<span class="margo-role">${escapeHtml(c.frontmatter.role)}</span>` : ''}
            <span class="margo-status" data-status="${escapeHtml(c.frontmatter.status)}">${escapeHtml(c.frontmatter.status)}</span>
            ${options?.orphan ? '<span class="margo-status margo-status-orphan" title="Anchor not found on this view">⚠ anchor lost</span>' : ''}
          </div>
        </div>
        <div class="margo-panel-toolbar" data-margo-toolbar></div>
        <button class="margo-close" type="button" aria-label="close">×</button>
      </div>
    </header>
    ${orphanBanner}
    ${renderThread(c)}
    ${readOnly ? '<p class="margo-readonly">read-only — run <code>npm run dev</code> locally to reply</p>' : ''}
  `;

  const close = () => panel!.remove();
  panel.querySelector('.margo-close')!.addEventListener('click', close);
  // Esc closes the panel — wire only on first open. The handler queries
  // the live DOM, so it correctly closes whichever comment is currently in
  // the panel even after swaps.
  if (!isUpdate) {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const live = document.querySelector('.margo-panel');
        if (live) live.remove();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);
    // Outside-click closes the panel. Bound on the next tick so the click
    // that just opened it doesn't immediately close it. The bubble-phase
    // listener runs after element-level handlers (pin click, inbox-item
    // click) — those already update the panel in place by calling
    // openCommentPanel again, so we skip-close when the target is one of
    // them (otherwise we'd close-then-reopen with a flicker). Modals are
    // skipped too because the panel triggered them, not the user dismissing
    // the panel.
    const SKIP_CLOSE_SELECTOR =
      '.margo-panel, .margo-pin, .margo-inbox-item, [data-margo-modal], .margo-modal-backdrop';
    let onOutsideClick: ((e: MouseEvent) => void) | null = null;
    setTimeout(() => {
      onOutsideClick = (e: MouseEvent) => {
        const live = document.querySelector('.margo-panel');
        if (!live) {
          if (onOutsideClick) document.removeEventListener('click', onOutsideClick);
          return;
        }
        const target = e.target as Element | null;
        if (!target || target.closest(SKIP_CLOSE_SELECTOR)) return;
        live.remove();
        if (onOutsideClick) document.removeEventListener('click', onOutsideClick);
      };
      document.addEventListener('click', onOutsideClick);
    }, 0);
  }

  if (!readOnly) {
    const toolbar = panel.querySelector('[data-margo-toolbar]') as HTMLElement;
    for (const el of buildHeaderActions(c, sync, close, me)) toolbar.appendChild(el);
    const replyForm = buildReplyForm(c, sync);
    if (replyForm) panel.appendChild(replyForm);
  }
  panel.appendChild(makeIdFooter(c.frontmatter.id));
  // Tag the panel with the comment id so SSE-driven thread refreshes can
  // find the matching open panel (see refreshOpenPanelThreadIfMatches).
  panel.dataset.commentId = c.frontmatter.id;
  // Anchor the panel near the pin. Done after content is in place so
  // we can measure the final panel size for placement.
  if (anchor) positionPanelNearAnchor(panel, anchor);
}

function positionPanelNearAnchor(panel: HTMLElement, anchor: Element): void {
  const a = anchor.getBoundingClientRect();
  const PAD = 8;
  // The inbox is the one fixed margo affordance that takes meaningful screen
  // real estate. When it's open we treat its left edge as the right edge of
  // the placement viewport so the comment panel never lands behind it.
  const inbox = document.querySelector('[data-margo-inbox]') as HTMLElement | null;
  const inboxRect = inbox ? inbox.getBoundingClientRect() : null;
  const rightLimit = inboxRect ? inboxRect.left - PAD : window.innerWidth - PAD;
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
  if (a.right + PAD + pw <= rightLimit) {
    left = a.right + PAD;
  } else if (a.left - PAD - pw >= PAD) {
    left = a.left - PAD - pw;
  } else {
    left = Math.max(PAD, Math.min(rightLimit - pw, a.left - pw / 2 + a.width / 2));
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

/**
 * Header toolbar — primary actions live here next to the close button,
 * inline with the comment identity. Saves the entire action-row that
 * used to sit between the thread and the footer.
 *
 *   open: [Reply] [Resolve] [⋯]
 *   resolved/wontfix: [Reopen] [⋯]
 *
 * Reply doesn't post directly — it reveals the inline reply form below
 * the thread. This keeps the textarea hidden by default so the panel
 * stays compact, then expands when the user actually wants to type.
 */
function buildHeaderActions(
  c: Comment,
  sync: SyncClient,
  close: () => void,
  me: { email: string } | null,
): HTMLElement[] {
  const isResolved = c.frontmatter.status === 'resolved' || c.frontmatter.status === 'wontfix';
  const buttons: HTMLElement[] = [];

  if (isResolved) {
    const reopen = document.createElement('button');
    reopen.type = 'button';
    reopen.dataset.margoAction = 'reopen';
    reopen.className = 'margo-btn margo-btn-primary';
    reopen.textContent = 'Reopen';
    reopen.addEventListener('click', async () => {
      reopen.disabled = true;
      try {
        await sync.patchComment(c.frontmatter.id, { status: 'open' });
        close();
      } catch (err) {
        reopen.disabled = false;
        await uiAlert((err as Error).message, 'Reopen failed');
      }
    });
    buttons.push(reopen);
    buttons.push(makeOverflowMenu(buildOverflowItems(c, sync, close, me, /* showDismiss */ false)));
    return buttons;
  }

  // Reply toggle — reveals the inline form. We look the form up by its
  // data-attribute rather than holding a reference, so this button works
  // even if openCommentPanel rebuilds the panel for a different comment
  // and the form is recreated.
  const replyBtn = document.createElement('button');
  replyBtn.type = 'button';
  replyBtn.dataset.margoAction = 'reply-toggle';
  replyBtn.className = 'margo-btn';
  replyBtn.textContent = 'Reply';
  replyBtn.addEventListener('click', () => {
    const form = document.querySelector('[data-margo-reply-form]') as HTMLElement | null;
    if (!form) return;
    const willOpen = form.hidden;
    form.hidden = !willOpen;
    if (willOpen) form.querySelector('textarea')?.focus();
  });
  buttons.push(replyBtn);

  const resolve = document.createElement('button');
  resolve.type = 'button';
  resolve.dataset.margoAction = 'resolve';
  resolve.className = 'margo-btn margo-btn-primary';
  resolve.innerHTML = '<span class="margo-btn-icon-inline" aria-hidden="true">✓</span><span>Resolve</span>';
  resolve.addEventListener('click', async () => {
    const summary = await promptDecisionSummary(c);
    if (summary === null) return;
    resolve.disabled = true;
    try {
      await sync.patchComment(c.frontmatter.id, {
        status: 'resolved',
        ...(summary ? { decisionSummary: summary } : {}),
      });
      close();
    } catch (err) {
      resolve.disabled = false;
      await uiAlert((err as Error).message, 'Resolve failed');
    }
  });
  buttons.push(resolve);

  buttons.push(makeOverflowMenu(buildOverflowItems(c, sync, close, me, /* showDismiss */ true)));
  return buttons;
}

/**
 * The collapsible reply form. Hidden by default; revealed by the Reply
 * button in the header toolbar. Returns null for resolved/wontfix
 * comments (no replying once a thread is closed) and for read-only mode.
 *
 * Submit does NOT close the panel — the user wants to see their reply
 * land in the thread (otherwise the panel vanishes before they can
 * confirm what they wrote). The SSE 'updated' event refreshes the open
 * panel's thread; we just collapse + clear the form here.
 */
function buildReplyForm(c: Comment, sync: SyncClient): HTMLElement | null {
  const isResolved = c.frontmatter.status === 'resolved' || c.frontmatter.status === 'wontfix';
  if (isResolved) return null;

  const form = document.createElement('form');
  form.className = 'margo-reply-form';
  form.dataset.margoReplyForm = '';
  form.hidden = true;

  const ta = document.createElement('textarea');
  ta.className = 'margo-reply-input';
  ta.placeholder = 'Reply…';
  ta.rows = 2;

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'margo-btn margo-reply-submit';
  submit.textContent = 'Reply';
  submit.disabled = true;

  ta.addEventListener('input', () => {
    submit.disabled = !ta.value.trim();
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
    if (e.key === 'Escape') {
      form.hidden = true;
      ta.value = '';
      submit.disabled = true;
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = ta.value.trim();
    if (!body) return;
    submit.disabled = true;
    ta.disabled = true;
    try {
      await sync.patchComment(c.frontmatter.id, { reply: { body } });
      // Reset the form for the next reply. Don't close the panel; the
      // SSE-driven thread refresh will surface the just-posted reply.
      ta.value = '';
      ta.style.height = 'auto';
      ta.disabled = false;
      submit.disabled = true;
      form.hidden = true;
    } catch (err) {
      submit.disabled = false;
      ta.disabled = false;
      await uiAlert((err as Error).message, 'Reply failed');
    }
  });

  form.appendChild(ta);
  form.appendChild(submit);
  return form;
}

/** Build the list of items that go into the ⋯ overflow menu. */
function buildOverflowItems(
  c: Comment,
  sync: SyncClient,
  close: () => void,
  me: { email: string } | null,
  showDismiss: boolean,
): OverflowItem[] {
  const items: OverflowItem[] = [];

  if (showDismiss) {
    items.push({
      // "Dismiss" reads softer than Reject and more decisive than Archive
      // for a feedback tool. Internally the status remains 'wontfix' — same
      // bug-tracker convention, same AI-skip rule. The UI label is the
      // human-facing knob; the persisted status is the machine-facing one.
      label: 'Dismiss',
      hint: 'AI skips dismissed comments. Reversible via Reopen.',
      onSelect: async () => {
        try {
          await sync.patchComment(c.frontmatter.id, { status: 'wontfix' });
          close();
        } catch (err) {
          await uiAlert((err as Error).message, 'Dismiss failed');
        }
      },
    });
  }

  items.push({
    label: 'Copy link',
    hint: 'Direct link to this comment — paste in PR / Slack',
    onSelect: async () => {
      // The overlay already handles `#margo=<id>` on load (scrolls to the
      // pin + opens this panel). Build that URL against the captured page
      // URL so the link works across the user's local + preview environments.
      const base = (() => {
        try { return new URL(c.frontmatter.target.url, window.location.origin).toString(); }
        catch { return window.location.origin + c.frontmatter.target.url; }
      })();
      const href = `${base}${base.includes('#') ? '&' : '#'}margo=${encodeURIComponent(c.frontmatter.id)}`;
      try {
        await navigator.clipboard.writeText(href);
      } catch {
        // Some browsers refuse writeText without a user gesture or over http;
        // surface the link so the user can copy manually.
        await uiAlert(href, 'Copy this link');
      }
    },
  });

  if (canDelete(c, me)) {
    items.push({
      label: 'Delete comment',
      hint: 'Hard delete (removes the file). Prefer Dismiss — this is for accidental commits.',
      destructive: true,
      onSelect: async () => {
        if (!(await confirmDelete(c))) return;
        try {
          await sync.deleteComment(c.frontmatter.id);
          close();
        } catch (err) {
          await uiAlert((err as Error).message, 'Delete failed');
        }
      },
    });
  }

  return items;
}

interface OverflowItem {
  label: string;
  hint?: string;
  destructive?: boolean;
  onSelect: () => void | Promise<void>;
}

/**
 * Compact "⋯" button that toggles a small popover menu. Anchored to its
 * button; opens left of the button (matches Zeplin's placement) so it
 * stays inside the comment panel. Closes on outside-click and Escape.
 */
function makeOverflowMenu(items: OverflowItem[]): HTMLElement {
  const container = document.createElement('div');
  container.className = 'margo-overflow';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'margo-btn margo-btn-icon margo-overflow-trigger';
  trigger.setAttribute('aria-label', 'More actions');
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = '<span aria-hidden="true">⋯</span>';
  container.appendChild(trigger);

  const menu = document.createElement('div');
  menu.className = 'margo-overflow-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;

  for (const it of items) {
    const mi = document.createElement('button');
    mi.type = 'button';
    mi.className = 'margo-overflow-item' + (it.destructive ? ' margo-overflow-item-destructive' : '');
    mi.setAttribute('role', 'menuitem');
    mi.textContent = it.label;
    if (it.hint) mi.title = it.hint;
    mi.addEventListener('click', async () => {
      close();
      await it.onSelect();
    });
    menu.appendChild(mi);
  }
  container.appendChild(menu);

  const open = () => {
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    setTimeout(() => {
      document.addEventListener('click', onDocClick, { capture: true });
      document.addEventListener('keydown', onKey);
    }, 0);
  };
  const close = () => {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocClick, { capture: true });
    document.removeEventListener('keydown', onKey);
  };
  const onDocClick = (e: Event) => {
    if (!container.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) open();
    else close();
  });

  return container;
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
function showTooltip(anchor: HTMLElement, text: string, id?: string): void {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  let tip = root.querySelector('.margo-tip') as HTMLElement | null;
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'margo-tip';
    tip.dataset.margoTip = '';
    root.appendChild(tip);
  }
  // Render the id as a separate dim/monospace span so it reads as metadata,
  // not as part of the body. Falls back to plain text when no id is given.
  if (id) {
    tip.innerHTML = `<span class="margo-tip-id">${escapeHtml(id)}</span><span class="margo-tip-sep"> · </span>${escapeHtml(text)}`;
  } else {
    tip.textContent = text;
  }
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

// Fallback chain: explicit authorName → email local-part (title-cased
// when the local part has dot/underscore separators, otherwise kept as-is
// since slack-style usernames are typically lowercase) → full email.
//
// Accepts any shape with `author` + optional `authorName` so the same logic
// works for Message (thread entries) and Comment.frontmatter (panel header).
// Showing a full email in the panel header was loud — "xhsong" or "Stanley
// Song" reads as a name; "xhsong@fortinet.com" reads as metadata.
function displayNameOf(m: { author: string; authorName?: string }): string {
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

/**
 * First-run identity setup. Two-input modal (name + email) that POSTs to
 * /__margo/me on Save, which runs `git config --global user.name/email` so
 * subsequent operations (createComment, commitAndPush) have a real author.
 *
 * Returns the persisted identity on Save, null on Cancel/Escape/backdrop.
 * Cancelling leaves the overlay running with me=null — the user can still
 * read pins, but attempts to create or update comments will fail until they
 * refresh and complete setup. We don't loop-on-cancel because some users
 * (preview deploys, read-only walkthroughs) genuinely don't need to write.
 */
function openIdentitySetup(sync: SyncClient): Promise<{ email: string; name: string } | null> {
  return new Promise((resolve) => {
    const root = document.getElementById(ROOT_ID);
    if (!root) { resolve(null); return; }
    root.querySelector('[data-margo-modal]')?.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'margo-modal-backdrop';
    backdrop.dataset.margoModal = '';

    const modal = document.createElement('div');
    modal.className = 'margo-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const header = document.createElement('header');
    const h = document.createElement('h3');
    h.textContent = 'Set up your margo identity';
    header.appendChild(h);
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
    const p = document.createElement('p');
    p.className = 'margo-modal-message';
    p.textContent =
      "git config user.name / user.email aren't set on this machine. "
      + 'margo uses them to attribute every comment. Save once and you\'re done — '
      + 'they\'ll be written to your global git config.';
    body.appendChild(p);

    const nameInput = document.createElement('input');
    nameInput.className = 'margo-modal-input';
    nameInput.type = 'text';
    nameInput.placeholder = 'Your name';
    nameInput.autocomplete = 'name';
    body.appendChild(nameInput);

    const emailInput = document.createElement('input');
    emailInput.className = 'margo-modal-input';
    emailInput.type = 'email';
    emailInput.placeholder = 'you@example.com';
    emailInput.autocomplete = 'email';
    body.appendChild(emailInput);

    const errorEl = document.createElement('p');
    errorEl.className = 'margo-modal-error';
    body.appendChild(errorEl);

    modal.appendChild(body);

    const footer = document.createElement('footer');
    const cancel = document.createElement('button');
    cancel.className = 'margo-modal-cancel';
    cancel.type = 'button';
    cancel.textContent = 'Later';
    cancel.addEventListener('click', () => done(null));
    footer.appendChild(cancel);

    const confirm = document.createElement('button');
    confirm.className = 'margo-modal-confirm';
    confirm.type = 'button';
    confirm.textContent = 'Save';
    confirm.addEventListener('click', () => void submit());
    footer.appendChild(confirm);
    modal.appendChild(footer);

    backdrop.appendChild(modal);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) done(null);
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(null); }
      else if (e.key === 'Enter') { e.preventDefault(); void submit(); }
    };
    document.addEventListener('keydown', onKey, true);

    root.appendChild(backdrop);
    queueMicrotask(() => nameInput.focus());

    async function submit(): Promise<void> {
      const name = nameInput.value.trim();
      const email = emailInput.value.trim();
      if (!name) return showError('Name is required.');
      if (!email) return showError('Email is required.');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showError('That email doesn\'t look right.');
      hideError();
      confirm.disabled = true;
      confirm.textContent = 'Saving…';
      const result = await sync.setMe(name, email);
      confirm.disabled = false;
      confirm.textContent = 'Save';
      if ('error' in result) { showError(result.error); return; }
      done(result);
    }
    function showError(msg: string): void {
      errorEl.textContent = msg;
      errorEl.classList.add('margo-modal-error-shown');
    }
    function hideError(): void {
      errorEl.classList.remove('margo-modal-error-shown');
    }
    function done(result: { email: string; name: string } | null): void {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(result);
    }
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
    /* ——— remote-changes banner (fetch+notify; click to pull) ——— */
    .margo-remote-banner {
      position: fixed; top: 16px; right: 16px; z-index: 999999;
      display: inline-flex; align-items: center; gap: 10px;
      max-width: calc(100vw - 32px);
      padding: 8px 8px 8px 14px;
      background: var(--margo-bg); color: var(--margo-fg);
      border: 1px solid var(--margo-border);
      border-radius: 9999px;
      font: inherit; font-size: 13px;
      box-shadow: 0 1px 2px rgb(0 0 0 / .08), 0 8px 24px rgb(0 0 0 / .08);
    }
    .margo-remote-banner-text { font-weight: 500; }
    .margo-remote-banner-pull {
      display: inline-flex; align-items: center; height: 26px; padding: 0 12px;
      background: var(--margo-primary); color: var(--margo-primary-fg);
      border: 0; border-radius: 9999px;
      font: inherit; font-weight: 500; font-size: 12px;
      cursor: pointer;
      transition: background-color .12s;
    }
    .margo-remote-banner-pull:hover { background: hsl(240 5.9% 18%); }
    .margo-remote-banner-pull:disabled { opacity: .6; cursor: progress; }
    .margo-remote-banner-dismiss {
      display: inline-flex; align-items: center; justify-content: center;
      width: 24px; height: 24px;
      background: transparent; color: var(--margo-muted-fg);
      border: 0; border-radius: 9999px;
      font: inherit; font-size: 18px; line-height: 1;
      cursor: pointer;
    }
    .margo-remote-banner-dismiss:hover { background: var(--margo-muted); color: var(--margo-fg); }
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
    .margo-tip-id {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: hsl(0 0% 70%);
      font-size: 11px;
    }
    .margo-tip-sep { color: hsl(0 0% 50%); }
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
      padding: 12px 12px 12px 16px;
      border-bottom: 1px solid var(--margo-border);
    }
    .margo-panel-titlebar {
      display: flex; align-items: center; gap: 8px;
    }
    .margo-panel-identity {
      flex: 1; min-width: 0;
      display: flex; flex-direction: column; gap: 4px;
    }
    .margo-panel-author {
      font-weight: 600; font-size: 13px; line-height: 1.3;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .margo-panel-meta { display: flex; gap: 6px; flex-wrap: wrap; }
    .margo-panel-toolbar {
      display: flex; align-items: center; gap: 6px;
      flex-shrink: 0;
    }
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
    /* ——— button family ——— */
    .margo-btn {
      display: inline-flex; align-items: center; gap: 6px;
      box-sizing: border-box;
      height: 28px;
      padding: 0 10px;
      border-radius: 6px; border: 1px solid var(--margo-border);
      background: white; color: var(--margo-fg);
      font-family: inherit; font-size: 12px; font-weight: 500; line-height: 1;
      cursor: pointer;
      transition: background-color .12s, border-color .12s, color .12s, box-shadow .12s;
    }
    .margo-btn:hover { background: var(--margo-bg); border-color: hsl(240 4% 78%); }
    .margo-btn:focus-visible { outline: 2px solid var(--margo-ring); outline-offset: 2px; }
    .margo-btn:disabled { opacity: .45; cursor: not-allowed; background: white; border-color: var(--margo-border); }
    .margo-btn-primary {
      background: var(--margo-fg); color: white; border-color: var(--margo-fg);
    }
    .margo-btn-primary:hover { background: hsl(240 4% 18%); border-color: hsl(240 4% 18%); }
    .margo-btn-primary .margo-btn-icon-inline { opacity: .85; }
    .margo-btn-icon {
      width: 28px; padding: 0; justify-content: center;
      color: var(--margo-muted-fg);
      font-size: 16px;
    }
    .margo-btn-icon:hover { color: var(--margo-fg); }
    .margo-btn-icon[aria-expanded="true"] {
      background: var(--margo-bg); border-color: hsl(240 4% 78%); color: var(--margo-fg);
    }
    .margo-btn-icon-inline {
      display: inline-flex; align-items: center; justify-content: center;
      width: 13px; height: 13px; line-height: 1;
      font-size: 11px;
    }
    /* ——— ⋯ overflow menu ——— */
    .margo-overflow { position: relative; margin-left: auto; }
    .margo-overflow-menu {
      position: absolute; right: 0; top: calc(100% + 6px);
      min-width: 184px;
      padding: 4px;
      background: white;
      border: 1px solid hsl(240 4% 88%); border-radius: 10px;
      box-shadow:
        0 12px 28px hsl(240 4% 0% / .10),
        0 2px 8px hsl(240 4% 0% / .06);
      z-index: 999999;
      animation: margo-overflow-in .12s ease-out;
    }
    @keyframes margo-overflow-in {
      from { opacity: 0; transform: translateY(-2px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .margo-overflow-item {
      display: flex; align-items: center;
      width: 100%; box-sizing: border-box;
      padding: 7px 10px;
      background: transparent;
      border: 0; /* explicit — overrides UA + page styles */
      border-radius: 6px;
      box-shadow: none;
      font-family: inherit; font-size: 13px; font-weight: 400;
      color: var(--margo-fg);
      text-align: left; line-height: 1.3;
      cursor: pointer;
      transition: background-color .1s, color .1s;
    }
    .margo-overflow-item + .margo-overflow-item { margin-top: 1px; }
    .margo-overflow-item:hover { background: hsl(240 5% 96%); }
    .margo-overflow-item:focus-visible { outline: 2px solid var(--margo-ring); outline-offset: -2px; }
    .margo-overflow-item-destructive { color: hsl(0 72% 42%); }
    .margo-overflow-item-destructive:hover { background: hsl(0 84% 97%); color: hsl(0 72% 36%); }
    /* Optional thin divider before the destructive item — separates it visually
       from the safe actions above, matching how Linear / Notion render. */
    .margo-overflow-item-destructive { margin-top: 4px; position: relative; }
    .margo-overflow-item-destructive::before {
      content: ''; position: absolute; left: 8px; right: 8px; top: -3px;
      height: 1px; background: hsl(240 5% 92%);
    }
    /* ——— inline reply form (hidden until Reply button clicked) ——— */
    .margo-reply-form {
      position: relative;
      margin: 0 16px 12px;
      border: 1px solid var(--margo-border);
      border-radius: 8px;
      background: white;
      transition: border-color .12s, box-shadow .12s;
      animation: margo-reply-in .14s ease-out;
    }
    @keyframes margo-reply-in {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .margo-reply-form:focus-within {
      border-color: var(--margo-ring);
      box-shadow: 0 0 0 3px hsl(217 91% 60% / .12);
    }
    .margo-reply-input {
      display: block; width: 100%; box-sizing: border-box;
      min-height: 56px; max-height: 168px;
      padding: 9px 12px 32px;
      border: 0;
      background: transparent; color: var(--margo-fg);
      font-family: inherit; font-size: 13px; line-height: 1.45;
      resize: none;
    }
    .margo-reply-input:focus { outline: none; }
    .margo-reply-input::placeholder { color: var(--margo-muted-fg); }
    .margo-reply-submit {
      position: absolute; right: 6px; bottom: 6px;
      height: 24px; padding: 0 10px;
      font-size: 12px; font-weight: 600;
      background: var(--margo-fg); color: white; border-color: var(--margo-fg);
    }
    .margo-reply-submit:hover { background: hsl(240 4% 18%); border-color: hsl(240 4% 18%); }
    .margo-reply-submit:disabled {
      background: hsl(240 5% 94%); color: var(--margo-muted-fg);
      border-color: hsl(240 5% 92%);
    }
    /* keyboard hint, only visible on focus */
    .margo-reply-form::after {
      content: '⌘↵';
      position: absolute; right: 70px; bottom: 9px;
      font-size: 11px; color: var(--margo-muted-fg);
      opacity: 0; pointer-events: none;
      transition: opacity .12s;
    }
    .margo-reply-form:focus-within::after { opacity: .6; }
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
    /* ——— orphan-info banner inside the standard comment panel ——— */
    .margo-panel-orphan {
      margin: 12px 16px 0; padding: 10px 12px;
      background: hsl(38 92% 96%);
      border: 1px solid hsl(38 92% 80%);
      border-left: 3px solid hsl(38 92% 50%);
      border-radius: 6px;
      display: flex; flex-direction: column; gap: 6px;
    }
    .margo-panel-orphan-label {
      margin: 0;
      font-size: 12px; font-weight: 600; color: hsl(28 80% 28%);
      line-height: 1.4;
    }
    .margo-panel-orphan-hint {
      margin: 0;
      font-size: 11px; color: hsl(28 50% 32%);
      line-height: 1.45;
    }
    .margo-panel-orphan-quote {
      margin: 2px 0 0; padding: 6px 10px;
      background: var(--margo-bg); border: 1px solid hsl(38 92% 85%);
      border-radius: 4px;
      font-size: 12px; color: var(--margo-muted-fg);
    }
    .margo-panel-orphan-quote-text {
      text-decoration: line-through; text-decoration-color: hsl(0 60% 55% / .6);
    }
    .margo-panel-orphan-meta {
      margin: 0;
      font-size: 11px; color: var(--margo-muted-fg);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      word-break: break-all;
    }
    .margo-status.margo-status-orphan {
      background: hsl(28 80% 92%); color: hsl(28 80% 30%);
      font-weight: 500;
    }
    /* ——— inbox-internal "Resolve N on this page" bulk action ——— */
    .margo-inbox-bulk {
      display: flex; align-items: center; gap: 6px;
      width: 100%; height: 36px; padding: 0 12px; margin: 4px 0 8px;
      background: var(--margo-muted); color: var(--margo-fg);
      border: 1px solid var(--margo-border); border-radius: 8px;
      font: inherit; font-size: 12px; font-weight: 500;
      cursor: pointer;
      transition: background-color .12s;
    }
    .margo-inbox-bulk:hover { background: hsl(140 30% 92%); border-color: hsl(160 84% 60%); }
    .margo-inbox-bulk:disabled { opacity: .6; cursor: not-allowed; }
    .margo-bulk-check { color: hsl(160 84% 39%); font-weight: 700; }
    /* Orphan variant — warning tones so it reads as "needs attention" */
    .margo-inbox-bulk.margo-inbox-bulk-orphan {
      background: hsl(38 92% 96%); border-color: hsl(38 92% 75%); color: hsl(28 80% 28%);
    }
    .margo-inbox-bulk.margo-inbox-bulk-orphan:hover {
      background: hsl(38 92% 92%); border-color: hsl(38 92% 65%);
    }
    .margo-bulk-warn { font-weight: 700; }
    /* ——— inbox toggle (sits above hide-pins) ——— */
    .margo-inbox-toggle {
      position: fixed; bottom: 104px; right: 16px; z-index: 1000000;
      display: inline-flex; align-items: center; gap: 6px;
      height: 32px; padding: 0 12px;
      background: var(--margo-bg); color: var(--margo-muted-fg);
      border: 1px solid var(--margo-border); border-radius: 9999px;
      font: inherit; font-size: 12px; font-weight: 500;
      cursor: pointer;
      box-shadow: 0 2px 6px rgb(0 0 0 / .08);
      transition: color .12s, background-color .12s, border-color .12s;
    }
    .margo-inbox-toggle:hover { background: var(--margo-muted); color: var(--margo-fg); }
    .margo-inbox-toggle:focus-visible { outline: 2px solid var(--margo-ring); outline-offset: 2px; }
    /* ——— hide-pins (focus-mode) toggle ——— */
    .margo-hide-pins {
      position: fixed; bottom: 60px; right: 16px; z-index: 1000000;
      display: inline-flex; align-items: center; gap: 6px;
      height: 32px; padding: 0 12px;
      background: var(--margo-bg); color: var(--margo-muted-fg);
      border: 1px solid var(--margo-border); border-radius: 9999px;
      font: inherit; font-size: 12px; font-weight: 500;
      cursor: pointer;
      box-shadow: 0 2px 6px rgb(0 0 0 / .08);
      transition: color .12s, background-color .12s, border-color .12s;
    }
    .margo-hide-pins:hover { background: var(--margo-muted); color: var(--margo-fg); }
    .margo-hide-pins:focus-visible { outline: 2px solid var(--margo-ring); outline-offset: 2px; }
    .margo-hide-pins .margo-eye { font-size: 14px; line-height: 1; }
    .margo-hide-pins-on { color: var(--margo-fg); border-color: var(--margo-ring); background: var(--margo-muted); }
    /* When focus mode is on, hide every other margo affordance — pins,
       highlights, the orphan tray, the bulk-resolve bar, the launcher,
       and the show-resolved toggle. The hide-pins button itself stays
       so the user can leave focus mode. */
    /* Hide-pins toggles ONLY the pin/highlight/tray rendering — the FAB
       menu, launcher, inbox, and hide-pins button itself stay visible so
       the user can still create comments, browse the inbox, etc. */
    [data-margo-hidden] [data-margo-pin],
    [data-margo-hidden] [data-margo-highlight] { display: none !important; }
    /* ——— main FAB (pill, always visible) ——— */
    .margo-fab-main {
      position: fixed; bottom: 16px; right: 16px; z-index: 1000002;
      height: 40px; padding: 0 14px 0 12px;
      display: inline-flex; align-items: center; gap: 8px;
      background: var(--margo-primary); color: var(--margo-primary-fg);
      border: 0; border-radius: 9999px; cursor: pointer;
      font: inherit; font-size: 13px; font-weight: 500;
      box-shadow: 0 4px 14px rgb(0 0 0 / .18);
      transition: background-color .12s, box-shadow .12s;
    }
    .margo-fab-main:hover { box-shadow: 0 6px 18px rgb(0 0 0 / .22); }
    .margo-fab-main:focus-visible { outline: 2px solid var(--margo-ring); outline-offset: 3px; }
    .margo-fab-main-pin { font-size: 14px; line-height: 1; }
    .margo-fab-main-label { line-height: 1; }
    .margo-fab-main-chev {
      font-size: 10px; opacity: .8; line-height: 1;
      transition: transform .18s ease;
    }
    [data-margo-fab-open] .margo-fab-main-chev { transform: rotate(180deg); }
    /* Sub-FABs are hidden by default and revealed when the menu opens.
       Position is set both at base and open states to the *same* coords
       so opacity is the only thing that animates — otherwise the items
       fade-in while sliding from their old default position, which reads
       as flicker. visibility delay matches the fade so they don't
       intercept clicks while invisible. */
    .margo-launcher,
    .margo-launcher-gap,
    .margo-inbox-toggle,
    .margo-hide-pins {
      visibility: hidden;
      opacity: 0;
      pointer-events: none;
      transition: opacity .14s ease, visibility 0s linear .14s;
    }
    [data-margo-fab-open] .margo-launcher,
    [data-margo-fab-open] .margo-launcher-gap,
    [data-margo-fab-open] .margo-inbox-toggle,
    [data-margo-fab-open] .margo-hide-pins {
      visibility: visible;
      opacity: 1;
      pointer-events: auto;
      transition: opacity .14s ease, visibility 0s linear 0s;
    }
    /* Single source of truth for menu-item positions — applied unconditionally
       so opening doesn't trigger position transitions. */
    .margo-launcher       { bottom: 64px;  right: 16px; }
    .margo-launcher-gap   { bottom: 112px; right: 16px; }
    .margo-inbox-toggle   { bottom: 160px; right: 16px; }
    .margo-hide-pins      { bottom: 208px; right: 16px; }
    /* ——— inbox panel (slides in from the right) ——— */
    .margo-inbox {
      position: fixed; top: 16px; right: 16px; bottom: 16px;
      width: min(380px, calc(100vw - 32px));
      z-index: 1000001;
      background: var(--margo-bg); color: var(--margo-fg);
      border: 1px solid var(--margo-border); border-radius: 12px;
      box-shadow: 0 12px 40px rgb(0 0 0 / .18);
      display: grid; grid-template-rows: auto 1fr;
      animation: margo-inbox-in .16s ease-out;
      overflow: hidden;
    }
    @keyframes margo-inbox-in {
      from { opacity: 0; transform: translateX(8px); }
      to { opacity: 1; transform: none; }
    }
    .margo-inbox.margo-inbox-no-animate { animation: none; }
    .margo-panel.margo-panel-no-animate { animation: none; }
    .margo-inbox-header {
      padding: 12px 14px 8px; border-bottom: 1px solid var(--margo-border);
    }
    .margo-inbox-titlebar {
      display: flex; align-items: center; gap: 10px; margin-bottom: 8px;
    }
    .margo-inbox-titlebar strong { font-size: 14px; }
    .margo-inbox-count {
      font-size: 12px; color: var(--margo-muted-fg); flex: 1;
    }
    .margo-inbox-close {
      background: transparent; border: 0; color: var(--margo-muted-fg);
      font-size: 20px; line-height: 1; cursor: pointer;
      width: 24px; height: 24px; border-radius: 6px;
    }
    .margo-inbox-close:hover { background: var(--margo-muted); color: var(--margo-fg); }
    /* ——— search input ——— */
    .margo-inbox-search {
      position: relative;
      margin: 0 0 6px;
    }
    .margo-inbox-search-icon {
      position: absolute; left: 9px; top: 50%; transform: translateY(-50%);
      font-size: 12px; opacity: .6; pointer-events: none;
    }
    .margo-inbox-search-input {
      width: 100%; height: 28px;
      padding: 0 26px 0 28px;
      background: var(--margo-bg); color: var(--margo-fg);
      border: 1px solid var(--margo-border); border-radius: 6px;
      font: inherit; font-size: 12px;
      box-sizing: border-box;
    }
    .margo-inbox-search-input::placeholder { color: var(--margo-muted-fg); }
    .margo-inbox-search-input:focus {
      outline: 2px solid var(--margo-ring); outline-offset: -1px;
      border-color: transparent;
    }
    /* Native clear button — works in Chromium/Safari. Firefox falls back to
       the user clearing the field manually, which is fine. */
    .margo-inbox-search-input::-webkit-search-cancel-button {
      -webkit-appearance: none; appearance: none;
      width: 14px; height: 14px;
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path fill='%23999' d='M4 4l8 8M12 4l-8 8' stroke='%23999' stroke-width='1.5' stroke-linecap='round'/></svg>");
      background-repeat: no-repeat; background-position: center;
      cursor: pointer; opacity: .7;
    }
    .margo-inbox-search-input::-webkit-search-cancel-button:hover { opacity: 1; }
    /* ——— filter chips (Open · All · Mine · This page) — one row ——— */
    .margo-inbox-chips {
      display: flex; gap: 4px; flex-wrap: wrap; align-items: center;
    }
    .margo-inbox-chip {
      background: transparent; color: var(--margo-muted-fg);
      border: 1px solid var(--margo-border); border-radius: 9999px;
      padding: 2px 10px;
      font: inherit; font-size: 11px;
      cursor: pointer;
      transition: background-color .1s, color .1s, border-color .1s;
    }
    .margo-inbox-chip:hover { background: var(--margo-muted); color: var(--margo-fg); }
    .margo-inbox-chip[aria-pressed="true"] {
      background: var(--margo-fg); color: var(--margo-bg);
      border-color: var(--margo-fg);
      font-weight: 500;
    }
    /* Status chips (Open/All) get a subtle filled look when pressed so they
       read as "the currently selected scope" rather than "an added filter".
       Reuses the same pressed style; the divider after them does the
       grouping work. */
    .margo-inbox-chip-status[aria-pressed="true"] {
      background: var(--margo-fg); color: var(--margo-bg);
    }
    .margo-inbox-chip:focus-visible { outline: 2px solid var(--margo-ring); outline-offset: 1px; }
    .margo-inbox-chips-divider {
      width: 1px; height: 16px;
      background: var(--margo-border);
      margin: 0 4px;
    }
    .margo-inbox-list {
      min-height: 0; overflow-y: auto; overscroll-behavior: contain;
      padding: 6px;
    }
    .margo-inbox-empty {
      padding: 24px 16px; text-align: center;
      color: var(--margo-muted-fg); font-size: 13px; line-height: 1.5;
    }
    .margo-inbox-item {
      display: flex; gap: 10px; align-items: flex-start;
      width: 100%; text-align: left;
      background: transparent; border: 0;
      padding: 10px 12px; margin: 2px 0; border-radius: 8px;
      cursor: pointer; font: inherit;
      transition: background-color .1s;
    }
    .margo-inbox-item:hover { background: var(--margo-muted); }
    .margo-inbox-item:focus-visible { outline: 2px solid var(--margo-ring); outline-offset: -2px; }
    .margo-inbox-item-avatar {
      flex: 0 0 auto;
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; border-radius: 9999px;
      font-size: 12px; font-weight: 600;
      box-shadow: 0 1px 2px rgb(0 0 0 / .08);
      margin-top: 1px;
    }
    .margo-inbox-item-main {
      flex: 1; min-width: 0;
      display: flex; flex-direction: column;
    }
    .margo-inbox-item-head {
      display: flex; align-items: center; gap: 6px; margin-bottom: 4px;
    }
    .margo-inbox-item-id {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px; color: var(--margo-muted-fg);
    }
    .margo-inbox-item-orphan {
      font-size: 10px; padding: 1px 6px; border-radius: 9999px;
      background: hsl(28 80% 92%); color: hsl(28 80% 30%);
      text-transform: uppercase; letter-spacing: .03em; font-weight: 500;
      white-space: nowrap;
    }
    .margo-inbox-item[data-orphan] {
      border-left: 2px solid hsl(28 80% 60%);
      padding-left: 10px;
      background: hsl(38 92% 99%);
    }
    .margo-inbox-item[data-orphan]:hover { background: hsl(38 92% 95%); }
    .margo-inbox-item-url {
      font-size: 11px; color: var(--margo-muted-fg);
      flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .margo-inbox-item-status {
      font-size: 10px; padding: 1px 6px; border-radius: 9999px;
      background: var(--margo-muted); color: var(--margo-muted-fg);
      text-transform: uppercase; letter-spacing: .03em; font-weight: 500;
    }
    .margo-inbox-item-status[data-status="ready-for-review"] { background: hsl(45 90% 92%); color: hsl(28 80% 32%); }
    .margo-inbox-item-status[data-status="blocked"] { background: hsl(0 60% 94%); color: hsl(0 60% 35%); }
    .margo-inbox-item-status[data-status="resolved"],
    .margo-inbox-item-status[data-status="wontfix"] { background: hsl(140 40% 92%); color: hsl(140 40% 28%); }
    .margo-inbox-item-body {
      font-size: 13px; color: var(--margo-fg); line-height: 1.4;
      overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .margo-inbox-item-foot {
      display: flex; justify-content: space-between;
      margin-top: 6px;
      font-size: 11px; color: var(--margo-muted-fg);
    }
    /* ——— pulse for the pin we just navigated to ——— */
    .margo-pin-pulse {
      animation: margo-pin-pulse 1.4s ease-out;
    }
    @keyframes margo-pin-pulse {
      0% { box-shadow: 0 0 0 0 hsl(214 95% 60% / .55); transform: scale(1); }
      40% { box-shadow: 0 0 0 16px hsl(214 95% 60% / 0); transform: scale(1.25); }
      100% { box-shadow: 0 0 0 0 hsl(214 95% 60% / 0); transform: scale(1); }
    }
    /* ——— muted styling for resolved pins / highlights ——— */
    .margo-pin[data-resolved] { opacity: .5; filter: grayscale(.45); }
    .margo-pin[data-resolved]:hover { opacity: .9; }
    .margo-hl[data-resolved] { opacity: .35; filter: grayscale(.55); }
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
    .margo-modal-error {
      display: none;
      margin: 0;
      font-size: 12px; color: hsl(0 72% 42%);
    }
    .margo-modal-error.margo-modal-error-shown { display: block; }
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
