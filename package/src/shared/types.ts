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
