export type CommentType = 'task' | 'discussion' | 'question';

export type CommentStatus =
  | 'open'
  | 'in-progress'
  | 'ready-for-review'
  | 'blocked'
  | 'resolved'
  | 'wontfix';

export type Role = 'pm' | 'designer' | 'dev' | 'other';

export interface TextAnchor {
  phrase: string;
  before: string;
  after: string;
}

// Paired-element gap anchor — captures *the space between two elements*.
// Survives layout changes as long as both boundary elements still exist;
// the resolver re-derives the gap rect from their live positions.
export interface GapAnchor {
  first: { selector: string; text: string; role: string };
  second: { selector: string; text: string; role: string };
  axis: 'vertical' | 'horizontal'; // vertical = stacked (gap is bottom-of-A → top-of-B)
}

/**
 * Discriminator for what kind of "thing" a pin is anchored to.
 *
 * `element` (default, omitted in existing comments) — the original margo
 * pin: anchored to a DOM element via selector + text + role + coords.
 *
 * `request` — anchored to a captured network call (fetch/XHR) seen by
 * the overlay's interceptor. No DOM target; the pin lives in the inbox
 * only. AI uses the `request` field to find the matching route handler.
 *
 * Comments authored before this field existed implicitly have `kind:
 * 'element'`. Keep the field optional at the schema level so a missing
 * value means element, preserving backward compatibility.
 */
export type TargetKind = 'element' | 'request';

/**
 * Snapshot of a network call captured by the overlay's fetch/XHR
 * interceptor at pin time. Headers and body are intentionally omitted
 * in v1 — privacy concerns + comment-file size — and will be added in a
 * follow-up if AI processing demands them.
 */
export interface RequestAnchor {
  method: string;            // GET, POST, PATCH, DELETE, …
  endpoint: string;          // fully-qualified URL of the captured call
  status: number;            // HTTP status returned. 0 for network errors.
  statusText?: string;       // e.g. 'Not Found'. Often empty for HTTP/2.
  duration?: number;         // ms, from fetch dispatch to response settle
  timestamp: string;         // ISO when the request settled
}

export interface Target {
  url: string;
  /** What the pin is anchored to. Omitted/missing => 'element'. */
  kind?: TargetKind;
  selector: string;
  text: string;
  role?: string;
  viewport: { w: number; h: number };
  coords: { x: number; y: number };
  textAnchor?: TextAnchor;
  gapAnchor?: GapAnchor;
  /** Populated when `kind === 'request'`. The network call's metadata. */
  request?: RequestAnchor;
  /**
   * For element pins, up to 5 recent fetch/XHR calls that fired in the
   * causal window after the user's last interaction with the page (~3s).
   * Heuristic time-window correlation — not trace-based — so occasional
   * false positives are possible (analytics, prefetch, autosave racing
   * with the click). AI should treat the list as evidence, not gospel.
   *
   * Snapshot at pin time. Don't refresh this field when fixing the code;
   * the user pinned the symptom *with* this context, and rewriting it
   * loses the causal hint.
   */
  relatedRequests?: RequestAnchor[];
  // Short SHA of HEAD when the pin was authored. Lets viewers detect
  // "this pin was made against a different commit than what I'm rendering."
  commit?: string;
  // True if the author's working tree had uncommitted changes when they
  // pinned. Pin may anchor to DOM that only exists in their local edits;
  // viewers won't see it even on the same commit.
  dirty?: boolean;
  // Snapshot of which "view state" the page was in at pin time. Used to
  // disambiguate pins on pages where the URL stays the same but content
  // swaps — tabs, wizards, accordions, modals, conditional renders. Without
  // this, a selector built from structural paths (`main > section >
  // article:nth-of-type(3)`) matches the corresponding container in any
  // active view and the resolver dots the wrong element. Optional — old
  // comments and pages with no detectable view markers skip view filtering.
  viewContext?: ViewContext;
}

export interface ViewContext {
  // Closest "named view" ancestor — covers role="tabpanel", role="dialog",
  // role="region", role="article" with an aria-labelledby reference. Both
  // the id reference AND the resolved label text are stored: ids can rotate
  // across builds, the human-visible label tends to be stable.
  panel?: {
    role?: string;       // tabpanel | dialog | region | article | ...
    id?: string;         // panel element's own id, if any
    labelledBy?: string; // value of the panel's aria-labelledby
    label?: string;      // resolved text of the labelledBy target
  };
  // "Currently active" state markers gathered from the ancestor chain.
  // Keys are the attribute names (aria-current, aria-selected, aria-expanded,
  // aria-pressed, data-state, data-step); values are the live attribute
  // values at capture time. At resolve, the candidate's chain must surface
  // the same values for any keys recorded here.
  state?: Record<string, string>;
  // Text of the closest preceding heading (h1-h6) inside the same panel,
  // or just up the ancestor chain when no panel is found. Last-resort
  // signal for UIs that use no ARIA and no data-state attributes — the
  // user almost always pinned near a visible heading, and headings tend
  // to identify "which screen am I on" better than anything else available.
  nearestHeading?: string;
}

export interface CommentFrontmatter {
  id: string;
  type: CommentType;
  author: string;          // canonical id (email) — used for own-only delete check etc.
  authorName?: string;     // friendly name from `git config user.name` at creation time
  role?: Role;             // optional — only set when configured (roster or git config margo.role)
  branch: string;
  created: string;
  status: CommentStatus;
  target: Target;
}

export interface Comment {
  frontmatter: CommentFrontmatter;
  body: string;
  raw: string;
  path: string;
}

export interface Reply {
  author: string;
  role?: Role | string;
  timestamp: string;
  body: string;
  isAi?: boolean;
  aiModel?: string;
}

export interface RosterEntry {
  email: string;
  role: Role;
  displayName?: string;
}

export interface MargoConfig {
  workspace: { name: string; appUrl: { dev: string; preview: string | null } };
  roster: RosterEntry[];
  git: {
    autoCommit: boolean;
    autoPush: boolean;
    commitPrefix: string;
    branchPolicy: 'current' | 'main-only';
    pullBeforePush: boolean;
    // Interval (ms) between background `git fetch` ticks that look for new
    // teammate comments on upstream. Surfaces a notification in the overlay;
    // never auto-pulls. Set 0 to disable. Default 60000.
    remotePollIntervalMs?: number;
  };
  ai: {
    implicitTaskTrigger: boolean;
    proactiveInboxSummaryAtSessionStart: boolean;
  };
}

export interface CreateCommentRequest {
  type: CommentType;
  body: string;
  target: Target;
}

// Local repo state, returned by GET /__margo/git-state. The overlay uses this
// to diagnose why a comment failed to anchor — same commit + clean WT means
// the element really is gone; otherwise the viewer's checkout is the cause.
export interface GitState {
  commit: string;       // short SHA of HEAD
  branch: string;
  dirty: boolean;
  dirtyCount: number;   // number of changed files; 0 when clean
  // Number of commits the local branch is behind the upstream tracking
  // branch, when both exist. Lets the overlay say "you're 3 commits behind"
  // instead of just "different commit." Null when there's no upstream.
  behind: number | null;
  // Same shape, ahead.
  ahead: number | null;
}

export interface UpdateCommentRequest {
  id: string;
  patch: Partial<Pick<CommentFrontmatter, 'status'>> & {
    reply?: { body: string };
    // One-line distillation of what was decided. Recorded in .margo/decisions.md
    // when present alongside `status: resolved`. Lets us purge resolved-comment
    // noise later without losing the institutional memory.
    decisionSummary?: string;
  };
}
