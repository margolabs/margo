// @vitest-environment happy-dom
//
// Smoke + chip-click tests for renderInboxPanel. The first test would have
// caught the `ReferenceError: openStatuses is not defined` regression that
// shipped after extracting computeInboxView — chips were rendered but the
// function threw before the click handlers were bound, so nothing was
// clickable. The remaining tests verify each chip dispatches the right
// callback when clicked.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderInboxPanel } from '../inject.js';
import type { Comment } from '../../shared/types.js';
import type { SyncClient } from '../sync.js';

function mkComment(over: {
  id: string;
  author: string;
  url?: string;
  status?: string;
  authorName?: string;
}): Comment {
  return {
    frontmatter: {
      id: over.id,
      author: over.author,
      authorName: over.authorName ?? over.author.split('@')[0],
      type: 'task',
      branch: 'main',
      created: '2026-05-13T10:00:00.000Z',
      status: (over.status ?? 'open') as Comment['frontmatter']['status'],
      target: {
        url: over.url ?? '/',
        selector: 'div',
        text: '',
        role: 'div',
        viewport: { w: 1440, h: 900 },
        coords: { x: 0, y: 0 },
      },
    },
    body: '',
  } as Comment;
}

// Minimal SyncClient stub. The chip handlers don't invoke sync, but
// renderInboxPanel takes a SyncClient for the per-row click handlers it
// also wires up. A typed cast is enough — the methods aren't called in
// these tests.
const fakeSync = {} as unknown as SyncClient;

const baseFilters = { mine: false, thisPage: false, search: '' };

interface Handlers {
  onShowResolvedChange: ReturnType<typeof vi.fn>;
  onFiltersChange: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
}

function render(
  store: Map<string, Comment>,
  opts?: {
    showResolved?: boolean;
    filters?: { mine: boolean; thisPage: boolean; search: string };
    me?: { email: string } | null;
  },
): { root: HTMLElement; panel: HTMLElement; handlers: Handlers } {
  const root = document.createElement('div');
  root.id = 'margo-overlay-root';
  document.body.appendChild(root);
  const handlers: Handlers = {
    onShowResolvedChange: vi.fn(),
    onFiltersChange: vi.fn(),
    onClose: vi.fn(),
  };
  renderInboxPanel(
    root,
    store,
    fakeSync,
    true, // open
    false, // readOnly
    opts?.showResolved ?? false,
    new Set<string>(), // orphanIds
    // Caller may pass `me: null` explicitly to simulate preview mode; only
    // fall back to the default when `me` was omitted entirely.
    opts && 'me' in opts ? opts.me ?? null : { email: 'me@team.com' },
    null, // gitState
    opts?.filters ?? baseFilters,
    true, // suppressEntranceAnim
    handlers.onShowResolvedChange,
    handlers.onFiltersChange,
    handlers.onClose,
  );
  const panel = root.querySelector('[data-margo-inbox]') as HTMLElement;
  return { root, panel, handlers };
}

describe('renderInboxPanel — smoke', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    // happy-dom may have stale window.location from prior tests — point to
    // a stable URL so currentRoute() returns "/" inside the panel.
    history.replaceState(null, '', '/');
  });

  it('renders without throwing (regression: openStatuses ReferenceError)', () => {
    const store = new Map<string, Comment>();
    store.set('c-1', mkComment({ id: 'c-1', author: 'alice@team.com' }));
    expect(() => render(store)).not.toThrow();
    const panel = document.querySelector('[data-margo-inbox]');
    expect(panel).not.toBeNull();
    // Four chips: Open, All, Mine, This page.
    const chips = document.querySelectorAll('.margo-inbox-chip');
    expect(chips.length).toBe(4);
  });
});

describe('renderInboxPanel — chip clicks dispatch the right callbacks', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    history.replaceState(null, '', '/');
  });

  function getChip(panel: HTMLElement, dim: 'open' | 'all' | 'mine' | 'thisPage'): HTMLElement {
    const el = panel.querySelector<HTMLElement>(`.margo-inbox-chip[data-chip="${dim}"]`);
    if (!el) throw new Error(`chip ${dim} not found`);
    return el;
  }

  it('clicking "All" turns on showResolved (and not yet on)', () => {
    const store = new Map([['c-1', mkComment({ id: 'c-1', author: 'alice@team.com' })]]);
    const { panel, handlers } = render(store, { showResolved: false });
    getChip(panel, 'all').click();
    expect(handlers.onShowResolvedChange).toHaveBeenCalledWith(true);
  });

  it('clicking "Open" turns off showResolved when currently on', () => {
    const store = new Map([['c-1', mkComment({ id: 'c-1', author: 'alice@team.com' })]]);
    const { panel, handlers } = render(store, { showResolved: true });
    getChip(panel, 'open').click();
    expect(handlers.onShowResolvedChange).toHaveBeenCalledWith(false);
  });

  it('clicking "Open" while already on does NOT dispatch (no-op)', () => {
    const store = new Map([['c-1', mkComment({ id: 'c-1', author: 'alice@team.com' })]]);
    const { panel, handlers } = render(store, { showResolved: false });
    getChip(panel, 'open').click();
    expect(handlers.onShowResolvedChange).not.toHaveBeenCalled();
  });

  it('clicking "Mine" toggles the mine filter', () => {
    const store = new Map([['c-1', mkComment({ id: 'c-1', author: 'alice@team.com' })]]);
    const { panel, handlers } = render(store, { filters: { mine: false, thisPage: false, search: '' } });
    getChip(panel, 'mine').click();
    expect(handlers.onFiltersChange).toHaveBeenCalledWith({ mine: true });
  });

  it('clicking "Mine" again toggles back off', () => {
    const store = new Map([['c-1', mkComment({ id: 'c-1', author: 'me@team.com' })]]);
    const { panel, handlers } = render(store, { filters: { mine: true, thisPage: false, search: '' } });
    getChip(panel, 'mine').click();
    expect(handlers.onFiltersChange).toHaveBeenCalledWith({ mine: false });
  });

  it('clicking "This page" toggles the thisPage filter', () => {
    const store = new Map([['c-1', mkComment({ id: 'c-1', author: 'alice@team.com' })]]);
    const { panel, handlers } = render(store, { filters: { mine: false, thisPage: false, search: '' } });
    getChip(panel, 'thisPage').click();
    expect(handlers.onFiltersChange).toHaveBeenCalledWith({ thisPage: true });
  });

  it('renders only three chips when me is unknown (preview/no-Mine)', () => {
    // Mine is hidden when we don't know the user — verifies the conditional
    // render doesn't crash and the remaining chips are still wired.
    const store = new Map([['c-1', mkComment({ id: 'c-1', author: 'alice@team.com' })]]);
    const { panel } = render(store, { me: null });
    expect(panel.querySelectorAll('.margo-inbox-chip').length).toBe(3);
    expect(panel.querySelector('[data-chip="mine"]')).toBeNull();
    expect(panel.querySelector('[data-chip="thisPage"]')).not.toBeNull();
  });
});
