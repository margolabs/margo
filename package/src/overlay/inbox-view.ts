// Pure filter/count logic for the inbox panel. Extracted from inject.ts so
// it can be unit-tested without spinning up the whole DOM overlay.
//
// The inbox has four orthogonal filter dimensions:
//   - statusFilter: 'open' | 'all' | 'closed' — three-way status scope.
//     Open = active comments (open/in-progress/ready-for-review/blocked),
//     Closed = resolved/wontfix only, All = everything.
//   - mine: comments authored by the current user
//   - thisPage: comments anchored to the current route
//   - search: substring match across author, body, id, url
//
// Plus three derived lists used by the bulk-action buttons at the top of
// the panel — all scoped to `all` so the labels match what the user sees:
//   - onPage: subset of `all` that's open AND on this route
//   - visibleOrphans: subset of `all` that's open AND anchor-lost
//   - visibleClosed: subset of `all` that's resolved/wontfix (Closed view)

import type { Comment } from '../shared/types.js';

export type StatusFilter = 'open' | 'all' | 'closed';

export interface InboxFilters {
  mine: boolean;
  thisPage: boolean;
  search: string;
}

export interface ComputeInboxViewInput {
  comments: Comment[];
  statusFilter: StatusFilter;
  filters: InboxFilters;
  orphanIds: Set<string>;
  route: string;
  meEmail: string | null;
}

export interface InboxView {
  /** Final visible list — orphans-first within the filtered + sorted set. */
  all: Comment[];
  /** Open + on-current-route subset of `all`. Drives the page-bulk button. */
  onPage: Comment[];
  /** Open + anchor-lost subset of `all`. Drives the orphan-bulk button. */
  visibleOrphans: Comment[];
  /** Resolved/wontfix subset of `all`. Drives the Closed-view bulk delete. */
  visibleClosed: Comment[];
  /** Counts shown on each chip — intersection-aware. */
  openCount: number;
  allCount: number;
  closedCount: number;
  mineCount: number;
  thisPageCount: number;
}

export const OPEN_STATUSES: ReadonlySet<string> = new Set([
  'open',
  'in-progress',
  'ready-for-review',
  'blocked',
]);

export const CLOSED_STATUSES: ReadonlySet<string> = new Set([
  'resolved',
  'wontfix',
]);

function statusesFor(filter: StatusFilter): ReadonlySet<string> {
  if (filter === 'open') return OPEN_STATUSES;
  if (filter === 'closed') return CLOSED_STATUSES;
  return new Set([...OPEN_STATUSES, ...CLOSED_STATUSES]);
}

export function computeInboxView(input: ComputeInboxViewInput): InboxView {
  const { comments, statusFilter, filters, orphanIds, route, meEmail } = input;
  const visibleStatuses = statusesFor(statusFilter);
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
  const all = comments
    .filter((c) => visibleStatuses.has(c.frontmatter.status))
    .filter((c) => (!filters.mine || matchesMine(c)))
    .filter((c) => (!filters.thisPage || matchesThisPage(c)))
    .filter(matchesSearch)
    .sort((a, b) => (b.frontmatter.created || '').localeCompare(a.frontmatter.created || ''))
    .sort((a, b) => {
      // Resolved comments aren't actionable orphans even if their anchor
      // doesn't resolve — don't yank them to the top of the All view with
      // the "anchor lost" treatment.
      const ao = orphanIds.has(a.frontmatter.id) && OPEN_STATUSES.has(a.frontmatter.status) ? 0 : 1;
      const bo = orphanIds.has(b.frontmatter.id) && OPEN_STATUSES.has(b.frontmatter.status) ? 0 : 1;
      return ao - bo;
    });

  // Chip counts. For each status chip, count what THAT filter would show
  // with the other (mine/thisPage/search) filters held constant. Search is
  // always applied (continuous reduction, not a tab).
  const baseFiltered = comments
    .filter((c) => (!filters.mine || matchesMine(c)))
    .filter((c) => (!filters.thisPage || matchesThisPage(c)))
    .filter(matchesSearch);
  const openCount = baseFiltered.filter((c) => OPEN_STATUSES.has(c.frontmatter.status)).length;
  const closedCount = baseFiltered.filter((c) => CLOSED_STATUSES.has(c.frontmatter.status)).length;
  const allCount = baseFiltered.length;
  const mineCount = comments
    .filter((c) => visibleStatuses.has(c.frontmatter.status))
    .filter((c) => (!filters.thisPage || matchesThisPage(c)))
    .filter(matchesSearch)
    .filter(matchesMine).length;
  const thisPageCount = comments
    .filter((c) => visibleStatuses.has(c.frontmatter.status))
    .filter((c) => (!filters.mine || matchesMine(c)))
    .filter(matchesSearch)
    .filter(matchesThisPage).length;

  // Bulk-action subsets. Scoped to `all` (filter-aware) so the labels match
  // the visible list — never promise to act on comments the user can't see.
  const onPage = all.filter(
    (c) => OPEN_STATUSES.has(c.frontmatter.status) && c.frontmatter.target.url === route,
  );
  const visibleOrphans = all.filter(
    (c) => orphanIds.has(c.frontmatter.id) && OPEN_STATUSES.has(c.frontmatter.status),
  );
  const visibleClosed = all.filter((c) => CLOSED_STATUSES.has(c.frontmatter.status));

  return {
    all,
    onPage,
    visibleOrphans,
    visibleClosed,
    openCount,
    allCount,
    closedCount,
    mineCount,
    thisPageCount,
  };
}
