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

export interface Target {
  url: string;
  selector: string;
  text: string;
  role?: string;
  viewport: { w: number; h: number };
  coords: { x: number; y: number };
  textAnchor?: TextAnchor;
  gapAnchor?: GapAnchor;
  // Short SHA of HEAD when the pin was authored. Lets viewers detect
  // "this pin was made against a different commit than what I'm rendering."
  commit?: string;
  // True if the author's working tree had uncommitted changes when they
  // pinned. Pin may anchor to DOM that only exists in their local edits;
  // viewers won't see it even on the same commit.
  dirty?: boolean;
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
