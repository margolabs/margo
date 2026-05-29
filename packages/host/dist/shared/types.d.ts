export type CommentType = 'task' | 'discussion' | 'question';
export type CommentStatus = 'open' | 'in-progress' | 'ready-for-review' | 'blocked' | 'resolved' | 'wontfix';
export type Role = 'pm' | 'designer' | 'dev' | 'other';
export interface TextAnchor {
    phrase: string;
    before: string;
    after: string;
}
export interface GapAnchor {
    first: {
        selector: string;
        text: string;
        role: string;
    };
    second: {
        selector: string;
        text: string;
        role: string;
    };
    axis: 'vertical' | 'horizontal';
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
 * Snapshot of the UI element whose interaction triggered a network call.
 * Recorded at fetch/XHR dispatch from the most recent non-margo click,
 * submit, or Enter keypress. Descriptive only — not re-resolved on read.
 * Lets AI answer "which button caused this request" without the user
 * having to manually pin the button.
 */
export interface TriggerInfo {
    selector: string;
    text: string;
    role: string;
    coords?: {
        x: number;
        y: number;
    };
    viewport?: {
        w: number;
        h: number;
    };
}
/**
 * Snapshot of a network call captured by the overlay's fetch/XHR
 * interceptor at pin time. Headers and body are intentionally omitted
 * in v1 — privacy concerns + comment-file size — and will be added in a
 * follow-up if AI processing demands them.
 */
export interface RequestAnchor {
    method: string;
    endpoint: string;
    status: number;
    statusText?: string;
    duration?: number;
    timestamp: string;
    traceId?: string;
    trigger?: TriggerInfo;
}
export interface Target {
    url: string;
    /** What the pin is anchored to. Omitted/missing => 'element'. */
    kind?: TargetKind;
    selector: string;
    text: string;
    role?: string;
    viewport: {
        w: number;
        h: number;
    };
    coords: {
        x: number;
        y: number;
    };
    textAnchor?: TextAnchor;
    gapAnchor?: GapAnchor;
    /** Populated when `kind === 'request'`. The network call's metadata,
     *  including the UI trigger info under `request.trigger` when the call
     *  was fired by a user interaction. */
    request?: RequestAnchor;
    commit?: string;
    dirty?: boolean;
    viewContext?: ViewContext;
}
export interface ViewContext {
    panel?: {
        role?: string;
        id?: string;
        labelledBy?: string;
        label?: string;
    };
    state?: Record<string, string>;
    nearestHeading?: string;
}
export interface CommentFrontmatter {
    id: string;
    type: CommentType;
    author: string;
    authorName?: string;
    role?: Role;
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
    workspace: {
        name: string;
        appUrl: {
            dev: string;
            preview: string | null;
        };
    };
    roster: RosterEntry[];
    git: {
        autoCommit: boolean;
        autoPush: boolean;
        commitPrefix: string;
        branchPolicy: 'current' | 'main-only';
        pullBeforePush: boolean;
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
export interface GitState {
    commit: string;
    branch: string;
    dirty: boolean;
    dirtyCount: number;
    behind: number | null;
    ahead: number | null;
}
export interface UpdateCommentRequest {
    id: string;
    patch: Partial<Pick<CommentFrontmatter, 'status'>> & {
        reply?: {
            body: string;
        };
        decisionSummary?: string;
    };
}
