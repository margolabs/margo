// Pure-function tests for the inbox filter pipeline. The bug under test:
// "Resolve N on this page" was counting EVERY open comment on the current
// route, ignoring whether the user had narrowed the view via Mine /
// search — so the label could promise "Resolve 4" while only 1 row was
// visible. The fix scopes onPage (and visibleOrphans) to the post-filter
// `all` list so the button count matches what the user sees.

import { describe, expect, it } from 'vitest';
import { computeInboxView, type InboxFilters } from '../inbox-view.js';
import type { Comment } from '../../shared/types.js';

const ROUTE = '/admin/operation';
const ME = 'me@team.com';

// Minimal Comment factory — only the fields the filter pipeline touches.
function mkComment(over: {
  id: string;
  author: string;
  url?: string;
  status?: string;
  body?: string;
  created?: string;
  authorName?: string;
}): Comment {
  return {
    frontmatter: {
      id: over.id,
      author: over.author,
      authorName: over.authorName ?? over.author.split('@')[0],
      type: 'task',
      branch: 'main',
      created: over.created ?? '2026-05-12T10:00:00.000Z',
      status: (over.status ?? 'open') as Comment['frontmatter']['status'],
      target: {
        url: over.url ?? ROUTE,
        selector: 'div',
        text: '',
        role: 'div',
        viewport: { w: 1440, h: 900 },
        coords: { x: 0, y: 0 },
      },
    },
    body: over.body ?? '',
  } as Comment;
}

const baseFilters: InboxFilters = { mine: false, thisPage: false, search: '' };

describe('computeInboxView — bulk-action counts respect active filters', () => {
  it('onPage counts only filtered-in comments, not every comment on the route', () => {
    // Four open comments on this page; only one is "mine". Before the fix
    // this returned 4 even when the inbox was narrowed to Mine, so the
    // button label said "Resolve 4 on this page" with 1 row visible.
    const comments = [
      mkComment({ id: 'c-1', author: 'alice@team.com' }),
      mkComment({ id: 'c-2', author: 'bob@team.com' }),
      mkComment({ id: 'c-3', author: 'eve@team.com' }),
      mkComment({ id: 'c-4', author: ME }),
    ];
    const view = computeInboxView({
      comments,
      statusFilter: "open",
      filters: { ...baseFilters, mine: true },
      orphanIds: new Set(),
      route: ROUTE,
      meEmail: ME,
    });
    expect(view.all.map((c) => c.frontmatter.id)).toEqual(['c-4']);
    expect(view.onPage.map((c) => c.frontmatter.id)).toEqual(['c-4']);
  });

  it('onPage drops comments hidden by an active search filter', () => {
    const comments = [
      mkComment({ id: 'c-1', author: 'alice@team.com', body: 'fix the upgrade banner' }),
      mkComment({ id: 'c-2', author: 'bob@team.com', body: 'change the checkout button' }),
      mkComment({ id: 'c-3', author: 'eve@team.com', body: 'rename pricing card' }),
    ];
    const view = computeInboxView({
      comments,
      statusFilter: "open",
      filters: { ...baseFilters, search: 'checkout' },
      orphanIds: new Set(),
      route: ROUTE,
      meEmail: null,
    });
    expect(view.all.map((c) => c.frontmatter.id)).toEqual(['c-2']);
    expect(view.onPage.map((c) => c.frontmatter.id)).toEqual(['c-2']);
  });

  it('onPage excludes resolved comments even when shown in the All view', () => {
    const comments = [
      mkComment({ id: 'c-1', author: 'alice@team.com', status: 'open' }),
      mkComment({ id: 'c-2', author: 'bob@team.com', status: 'resolved' }),
      mkComment({ id: 'c-3', author: 'eve@team.com', status: 'wontfix' }),
    ];
    const view = computeInboxView({
      comments,
      statusFilter: "all", // All view — resolved/wontfix appear in `all`
      filters: baseFilters,
      orphanIds: new Set(),
      route: ROUTE,
      meEmail: null,
    });
    expect(view.all.map((c) => c.frontmatter.id).sort()).toEqual(['c-1', 'c-2', 'c-3']);
    expect(view.onPage.map((c) => c.frontmatter.id)).toEqual(['c-1']);
  });

  it('onPage excludes comments on other routes', () => {
    const comments = [
      mkComment({ id: 'c-here', author: 'alice@team.com', url: ROUTE }),
      mkComment({ id: 'c-else', author: 'alice@team.com', url: '/other/page' }),
    ];
    const view = computeInboxView({
      comments,
      statusFilter: "open",
      filters: baseFilters,
      orphanIds: new Set(),
      route: ROUTE,
      meEmail: null,
    });
    expect(view.onPage.map((c) => c.frontmatter.id)).toEqual(['c-here']);
  });

  it('visibleOrphans is also scoped to the filtered view (orphan bulk button)', () => {
    // Two orphaned comments on this page; one is mine. With Mine filter on,
    // only mine should count for "Resolve all N orphaned".
    const comments = [
      mkComment({ id: 'c-orph-alice', author: 'alice@team.com' }),
      mkComment({ id: 'c-orph-me', author: ME }),
      mkComment({ id: 'c-not-orph', author: ME }),
    ];
    const view = computeInboxView({
      comments,
      statusFilter: "open",
      filters: { ...baseFilters, mine: true },
      orphanIds: new Set(['c-orph-alice', 'c-orph-me']),
      route: ROUTE,
      meEmail: ME,
    });
    expect(view.visibleOrphans.map((c) => c.frontmatter.id)).toEqual(['c-orph-me']);
  });
});

describe('computeInboxView — chip counts are intersection-aware', () => {
  it('Mine count respects status + thisPage + search but not mine', () => {
    const comments = [
      mkComment({ id: 'c-1', author: ME, status: 'open', url: ROUTE }),
      mkComment({ id: 'c-2', author: ME, status: 'resolved', url: ROUTE }),
      mkComment({ id: 'c-3', author: ME, status: 'open', url: '/other' }),
      mkComment({ id: 'c-4', author: 'alice@team.com', status: 'open', url: ROUTE }),
    ];
    // Open + thisPage on. mineCount should count what's mine within that
    // intersection: c-1 only. (c-2 excluded by Open, c-3 excluded by
    // thisPage, c-4 not mine.)
    const view = computeInboxView({
      comments,
      statusFilter: "open",
      filters: { ...baseFilters, thisPage: true },
      orphanIds: new Set(),
      route: ROUTE,
      meEmail: ME,
    });
    expect(view.mineCount).toBe(1);
  });

  it('This-page count respects status + mine + search but not thisPage', () => {
    const comments = [
      mkComment({ id: 'c-1', author: ME, status: 'open', url: ROUTE }),
      mkComment({ id: 'c-2', author: 'alice@team.com', status: 'open', url: ROUTE }),
      mkComment({ id: 'c-3', author: ME, status: 'open', url: '/other' }),
    ];
    // Mine on. thisPageCount: comments that ARE on this route AND mine.
    // c-1 qualifies; c-2 not mine; c-3 not on this page.
    const view = computeInboxView({
      comments,
      statusFilter: "open",
      filters: { ...baseFilters, mine: true },
      orphanIds: new Set(),
      route: ROUTE,
      meEmail: ME,
    });
    expect(view.thisPageCount).toBe(1);
  });
});

describe('computeInboxView — sort order', () => {
  it('puts open orphans at the top, then sorts the rest by created desc', () => {
    const comments = [
      mkComment({ id: 'c-old', author: 'a@x', created: '2026-05-01T00:00:00Z' }),
      mkComment({ id: 'c-new', author: 'a@x', created: '2026-05-10T00:00:00Z' }),
      mkComment({ id: 'c-orph', author: 'a@x', created: '2026-05-05T00:00:00Z' }),
    ];
    const view = computeInboxView({
      comments,
      statusFilter: "open",
      filters: baseFilters,
      orphanIds: new Set(['c-orph']),
      route: ROUTE,
      meEmail: null,
    });
    expect(view.all.map((c) => c.frontmatter.id)).toEqual(['c-orph', 'c-new', 'c-old']);
  });

  it('does NOT promote resolved orphans to the top', () => {
    // Resolved comments aren't actionable as orphans, so they should sort
    // by date in the All view rather than getting yanked to the top.
    const comments = [
      mkComment({ id: 'c-a', author: 'a@x', status: 'open', created: '2026-05-10T00:00:00Z' }),
      mkComment({ id: 'c-resolved-orph', author: 'a@x', status: 'resolved', created: '2026-05-05T00:00:00Z' }),
    ];
    const view = computeInboxView({
      comments,
      statusFilter: "all",
      filters: baseFilters,
      orphanIds: new Set(['c-resolved-orph']),
      route: ROUTE,
      meEmail: null,
    });
    expect(view.all.map((c) => c.frontmatter.id)).toEqual(['c-a', 'c-resolved-orph']);
  });
});

describe('computeInboxView — Closed status filter', () => {
  it('Closed shows only resolved/wontfix and excludes active statuses', () => {
    const comments = [
      mkComment({ id: 'c-open', author: 'a@x', status: 'open' }),
      mkComment({ id: 'c-wip', author: 'a@x', status: 'in-progress' }),
      mkComment({ id: 'c-resolved', author: 'a@x', status: 'resolved' }),
      mkComment({ id: 'c-wontfix', author: 'a@x', status: 'wontfix' }),
    ];
    const view = computeInboxView({
      comments,
      statusFilter: 'closed',
      filters: baseFilters,
      orphanIds: new Set(),
      route: ROUTE,
      meEmail: null,
    });
    expect(view.all.map((c) => c.frontmatter.id).sort()).toEqual(['c-resolved', 'c-wontfix']);
  });

  it('visibleClosed mirrors `all` when statusFilter is closed', () => {
    const comments = [
      mkComment({ id: 'c-r1', author: ME, status: 'resolved' }),
      mkComment({ id: 'c-r2', author: 'a@x', status: 'wontfix' }),
      mkComment({ id: 'c-open', author: ME, status: 'open' }),
    ];
    const view = computeInboxView({
      comments,
      statusFilter: 'closed',
      filters: baseFilters,
      orphanIds: new Set(),
      route: ROUTE,
      meEmail: ME,
    });
    expect(view.visibleClosed.map((c) => c.frontmatter.id).sort()).toEqual(['c-r1', 'c-r2']);
    expect(view.all.length).toBe(view.visibleClosed.length);
  });

  it('Closed view + Mine filter narrows visibleClosed to the user’s own', () => {
    const comments = [
      mkComment({ id: 'c-mine', author: ME, status: 'resolved' }),
      mkComment({ id: 'c-theirs', author: 'alice@team.com', status: 'resolved' }),
    ];
    const view = computeInboxView({
      comments,
      statusFilter: 'closed',
      filters: { ...baseFilters, mine: true },
      orphanIds: new Set(),
      route: ROUTE,
      meEmail: ME,
    });
    expect(view.visibleClosed.map((c) => c.frontmatter.id)).toEqual(['c-mine']);
  });

  it('closedCount reflects status-axis-only intersection with other filters', () => {
    const comments = [
      mkComment({ id: 'c-1', author: ME, status: 'resolved', url: ROUTE }),
      mkComment({ id: 'c-2', author: 'a@x', status: 'resolved', url: ROUTE }),
      mkComment({ id: 'c-3', author: ME, status: 'resolved', url: '/other' }),
      mkComment({ id: 'c-4', author: ME, status: 'open', url: ROUTE }),
    ];
    // Mine + thisPage on. closedCount should be the count under those
    // narrowings ignoring the status axis itself: c-1 only.
    const view = computeInboxView({
      comments,
      statusFilter: 'open',
      filters: { ...baseFilters, mine: true, thisPage: true },
      orphanIds: new Set(),
      route: ROUTE,
      meEmail: ME,
    });
    expect(view.closedCount).toBe(1);
  });
});
