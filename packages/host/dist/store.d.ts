import type { Comment } from './shared/types.js';
export interface ProjectStoreOptions {
    /** Absolute path to the host's data directory. */
    dataRoot: string;
}
export declare class ProjectStore {
    private readonly dataRoot;
    constructor(opts: ProjectStoreOptions);
    /** Resolve a project name to its absolute path on disk. Throws on names
     *  that try to escape the data root via `..` or absolute paths — the
     *  project name is part of the URL and must not double as a path traversal. */
    private projectDir;
    private commentsDir;
    private commentFile;
    /** Initialize a project's storage and git repo. Idempotent — running it
     *  twice does not destroy existing data. Called lazily on the first write
     *  so operators don't have to pre-provision. */
    ensureProject(project: string, authorEmail?: string, authorName?: string): Promise<void>;
    listProjects(): Promise<string[]>;
    list(project: string): Promise<Comment[]>;
    read(project: string, id: string): Promise<{
        raw: string;
        comment: Comment;
    } | null>;
    write(project: string, id: string, raw: string, opts: {
        commitMessage: string;
        authorEmail: string;
        authorName: string;
    }): Promise<void>;
    remove(project: string, id: string, opts: {
        commitMessage: string;
        authorEmail: string;
        authorName: string;
    }): Promise<void>;
    /** Append a one-line decision entry to `.margo/decisions.md` and commit. */
    appendDecision(project: string, entry: string, opts: {
        commitMessage: string;
        authorEmail: string;
        authorName: string;
    }): Promise<void>;
    /** Commit a list of files in the project's repo, attributing them to the
     *  authenticated user (so the audit trail shows who did what, not the
     *  server's own service account). Failures are logged, not thrown — a
     *  successful disk write must not become a 5xx because git complained. */
    private commit;
}
