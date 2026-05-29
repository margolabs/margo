// Server-side project store. Each project lives in its own subdirectory
// under the host's data root, with the same `.margo/comments/*.md` shape
// as a local-mode repo, plus a per-project `.git` for history.
//
// Layout:
//   <dataRoot>/
//   ├── <project-a>/
//   │   ├── .git/
//   │   └── .margo/comments/c-*.md
//   ├── <project-b>/
//   │   └── ...
//
// The host never pushes git anywhere — server-local history is the audit
// trail. Clients sync over HTTP; nothing here ever runs `git push`.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseComment } from './shared/frontmatter.js';
async function run(cwd, args) {
    return new Promise((resolve) => {
        const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d.toString()));
        child.stderr.on('data', (d) => (stderr += d.toString()));
        child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    });
}
export class ProjectStore {
    dataRoot;
    constructor(opts) {
        this.dataRoot = path.resolve(opts.dataRoot);
    }
    /** Resolve a project name to its absolute path on disk. Throws on names
     *  that try to escape the data root via `..` or absolute paths — the
     *  project name is part of the URL and must not double as a path traversal. */
    projectDir(project) {
        if (!/^[a-zA-Z0-9._-]+$/.test(project)) {
            throw new Error(`invalid project name: ${project}`);
        }
        return path.join(this.dataRoot, project);
    }
    commentsDir(project) {
        return path.join(this.projectDir(project), '.margo', 'comments');
    }
    commentFile(project, id) {
        if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
            throw new Error(`invalid comment id: ${id}`);
        }
        return path.join(this.commentsDir(project), `${id}.md`);
    }
    /** Initialize a project's storage and git repo. Idempotent — running it
     *  twice does not destroy existing data. Called lazily on the first write
     *  so operators don't have to pre-provision. */
    async ensureProject(project, authorEmail = 'margo-host@localhost', authorName = 'margo host') {
        const dir = this.projectDir(project);
        const gitDir = path.join(dir, '.git');
        await fs.mkdir(this.commentsDir(project), { recursive: true });
        try {
            await fs.access(gitDir);
        }
        catch {
            // Fresh project — init the repo so commits work. Use the configured
            // author so the first commit has a sensible signature.
            const init = await run(dir, ['init', '-q', '-b', 'main']);
            if (init.code !== 0)
                throw new Error(`git init failed: ${init.stderr}`);
            await run(dir, ['config', 'user.email', authorEmail]);
            await run(dir, ['config', 'user.name', authorName]);
            // Empty initial commit so HEAD exists — `git rev-parse HEAD` returns
            // null on a virgin repo and would short-circuit downstream tooling
            // that expects a non-empty history.
            await run(dir, ['commit', '-q', '--allow-empty', '-m', 'init project']);
        }
    }
    async listProjects() {
        try {
            const entries = await fs.readdir(this.dataRoot, { withFileTypes: true });
            return entries
                .filter((e) => e.isDirectory() && /^[a-zA-Z0-9._-]+$/.test(e.name))
                .map((e) => e.name);
        }
        catch {
            return [];
        }
    }
    async list(project) {
        const dir = this.commentsDir(project);
        let files;
        try {
            files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md'));
        }
        catch {
            return [];
        }
        const out = [];
        for (const f of files) {
            const full = path.join(dir, f);
            const raw = await fs.readFile(full, 'utf8');
            try {
                out.push(parseComment(raw, full));
            }
            catch {
                // Malformed file — skip rather than crash. Same behavior as the
                // local-mode list path.
            }
        }
        return out;
    }
    async read(project, id) {
        const file = this.commentFile(project, id);
        try {
            const raw = await fs.readFile(file, 'utf8');
            return { raw, comment: parseComment(raw, file) };
        }
        catch {
            return null;
        }
    }
    async write(project, id, raw, opts) {
        await this.ensureProject(project, opts.authorEmail, opts.authorName);
        const file = this.commentFile(project, id);
        await fs.writeFile(file, raw, 'utf8');
        await this.commit(project, [file], opts);
    }
    async remove(project, id, opts) {
        const file = this.commentFile(project, id);
        await fs.unlink(file).catch(() => { });
        await this.commit(project, [file], opts);
    }
    /** Append a one-line decision entry to `.margo/decisions.md` and commit. */
    async appendDecision(project, entry, opts) {
        await this.ensureProject(project, opts.authorEmail, opts.authorName);
        const file = path.join(this.projectDir(project), '.margo', 'decisions.md');
        let content;
        try {
            content = await fs.readFile(file, 'utf8');
        }
        catch {
            content = [
                '# Decisions log',
                '',
                'Resolved comments distilled to one-line decisions. Newest first.',
                'Each entry references the source comment in `.margo/comments/<id>.md`.',
                '',
            ].join('\n');
        }
        const lines = content.split('\n');
        let insertAt = lines.length;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('- ')) {
                insertAt = i;
                break;
            }
        }
        lines.splice(insertAt, 0, entry);
        let next = lines.join('\n');
        if (!next.endsWith('\n'))
            next += '\n';
        await fs.writeFile(file, next, 'utf8');
        await this.commit(project, [file], opts);
    }
    /** Commit a list of files in the project's repo, attributing them to the
     *  authenticated user (so the audit trail shows who did what, not the
     *  server's own service account). Failures are logged, not thrown — a
     *  successful disk write must not become a 5xx because git complained. */
    async commit(project, files, opts) {
        const cwd = this.projectDir(project);
        const rel = files.map((f) => path.relative(cwd, f));
        const add = await run(cwd, ['add', '--', ...rel]);
        if (add.code !== 0) {
            console.error(`[margo-host] git add failed for ${project}: ${add.stderr}`);
            return;
        }
        const env = ['-c', `user.email=${opts.authorEmail}`, '-c', `user.name=${opts.authorName}`];
        const message = `margo: ${opts.commitMessage}`;
        const commit = await run(cwd, [...env, 'commit', '-q', '--allow-empty', '-m', message]);
        if (commit.code !== 0) {
            console.error(`[margo-host] git commit failed for ${project}: ${commit.stderr}`);
        }
    }
}
