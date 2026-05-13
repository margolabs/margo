// Transport-agnostic business logic. Both the Vite plugin (Node http) and
// the Next.js plugin (Web Fetch) call these handlers, then serialize the
// returned plain objects to wire format. SSE streaming stays per-transport
// because the streaming APIs (Node ServerResponse vs. Web ReadableStream) are
// fundamentally different — but `broadcastSse` here writes through a
// transport-supplied `SseClient` so handlers can fire events without caring.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseComment, serializeComment, appendReply } from '../shared/frontmatter.js';
import { newCommentId } from '../shared/id.js';
import {
  backgroundPull,
  commitAndPush,
  getAheadBehind,
  getAuthor,
  getCurrentBranch,
  getCurrentCommit,
  getDeclaredRole,
  getDirtyState,
  removeAndCommit,
  setAuthor,
  type GitOptions,
} from './git.js';
import type {
  Comment,
  CreateCommentRequest,
  GitState,
  MargoConfig,
  UpdateCommentRequest,
} from '../shared/types.js';

/** Transport-agnostic SSE subscriber — the adapter knows how to push bytes. */
export interface SseClient {
  write(payload: string): void;
}

export interface HandlerContext {
  rootDir: string;       // git repo root
  commentsDir: string;   // .margo/comments
  config: MargoConfig;
  sseClients: Set<SseClient>;
  // Called after a new SSE client is registered, so plugins can replay any
  // "sticky" state (e.g. the remote-changes snapshot) the client missed by
  // connecting after the originating event fired.
  onSseClientConnect?: (client: SseClient) => void;
  // Called after `syncFromRemote` succeeds. Plugins use this to clear the
  // poller's cached snapshot so newly-connected tabs don't see a stale
  // "incoming comments" banner for changes that have already been pulled.
  onAfterSync?: () => void;
}

/** Throw from a handler to surface a specific HTTP status to the adapter. */
export class HandlerError extends Error {
  constructor(public readonly status: number, public readonly payload?: unknown) {
    super(typeof payload === 'string' ? payload : `HTTP ${status}`);
  }
}

// Background git queue. Comment writes return to the client as soon as the
// .md file is on disk; the git add/commit/pull/push runs after, serialized
// through this promise chain. Two reasons for the chain:
//
//   1. UX: the user's POST returns in <50ms instead of waiting 2-3s for the
//      git push to round-trip.
//   2. Dev-server stability: `git pull --rebase --autostash` temporarily
//      moves any unstaged changes via stash. Turbopack's file watcher sees
//      those mtime changes and restarts the dev server — killing any
//      in-flight HTTP request. With async git, the response has already
//      flushed before the stash dance starts, so a restart never strands
//      a client mid-request.
//
// Cost: errors during commit/push are visible in the dev-server console,
// not surfaced to the client. Acceptable trade-off — the .md file is on
// disk, so subsequent reads work; the user can `git status` to see the
// uncommitted file if they care, and the next margo write retries the
// queue from the top.
let gitQueue: Promise<unknown> = Promise.resolve();

function enqueueGitOp(label: string, op: () => Promise<unknown>): void {
  gitQueue = gitQueue
    .catch(() => undefined) // a prior failure mustn't poison subsequent ops
    .then(() => op().catch((err) => {
      console.error(`[margo] background git op failed (${label}):`, (err as Error).message);
    }));
}

export async function listComments(ctx: HandlerContext): Promise<{ comments: Comment[] }> {
  return { comments: await readAllComments(ctx.commentsDir) };
}

export async function getMe(ctx: HandlerContext): Promise<{ email: string; name: string } | null> {
  // Return null on missing config so the overlay can prompt for setup instead
  // of treating the request as a 5xx and surfacing a cryptic "author api
  // failed" error on the next pin attempt.
  try {
    const author = await getAuthor(ctx.rootDir);
    return { email: author.email, name: author.name };
  } catch {
    return null;
  }
}

export async function setMe(
  ctx: HandlerContext,
  body: { name?: string; email?: string },
): Promise<{ email: string; name: string }> {
  const name = (body.name ?? '').trim();
  const email = (body.email ?? '').trim();
  if (!name) throw new HandlerError(400, 'name is required');
  // Permissive email regex — git itself doesn't validate, but a leading sanity
  // check catches typos before we shell out to `git config`.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HandlerError(400, 'invalid email');
  await setAuthor(name, email, ctx.rootDir);
  return { name, email };
}

export async function getGitState(ctx: HandlerContext): Promise<GitState> {
  const [commit, branch, dirtyState, aheadBehind] = await Promise.all([
    getCurrentCommit(ctx.rootDir),
    getCurrentBranch(ctx.rootDir).catch(() => 'unknown'),
    getDirtyState(ctx.rootDir),
    getAheadBehind(ctx.rootDir),
  ]);
  return {
    commit: commit ?? '',
    branch,
    dirty: dirtyState.dirty,
    dirtyCount: dirtyState.count,
    ahead: aheadBehind?.ahead ?? null,
    behind: aheadBehind?.behind ?? null,
  };
}

export async function createComment(
  ctx: HandlerContext,
  body: CreateCommentRequest,
): Promise<{ id: string }> {
  const id = newCommentId();
  const author = await getAuthor(ctx.rootDir);
  const role = await resolveRole(author.email, ctx.config, ctx.rootDir);
  const [branch, commit, dirtyState] = await Promise.all([
    getCurrentBranch(ctx.rootDir),
    getCurrentCommit(ctx.rootDir),
    getDirtyState(ctx.rootDir),
  ]);
  const created = new Date().toISOString();
  const target = {
    ...body.target,
    ...(commit ? { commit } : {}),
    ...(dirtyState.dirty ? { dirty: true } : {}),
  };
  const fm = {
    id,
    type: body.type ?? 'task',
    author: author.email,
    ...(author.name ? { authorName: author.name } : {}),
    ...(role ? { role } : {}),
    branch,
    created,
    status: 'open' as const,
    target,
  };
  const file = path.join(ctx.commentsDir, `${id}.md`);
  await fs.mkdir(ctx.commentsDir, { recursive: true });
  await fs.writeFile(file, serializeComment(fm, body.body), 'utf8');
  // SSE fires immediately so the local overlay (and any other tabs on this
  // dev server) re-render with the new pin without waiting on git.
  broadcastSse(ctx, { type: 'created', id });
  enqueueGitOp(`comment ${id}`, () =>
    commitAndPush([file], `comment by ${author.email} on ${body.target.url}`, gitOpts(ctx)),
  );
  return { id };
}

export async function updateComment(
  ctx: HandlerContext,
  body: UpdateCommentRequest,
): Promise<{ ok: true }> {
  const file = path.join(ctx.commentsDir, `${body.id}.md`);
  const raw = await fs.readFile(file, 'utf8');
  const comment = parseComment(raw, file);
  let newBody = comment.body;
  if (body.patch.reply) {
    const author = await getAuthor(ctx.rootDir);
    newBody = appendReply(newBody, {
      author: author.email,
      role: await resolveRole(author.email, ctx.config, ctx.rootDir),
      timestamp: new Date().toISOString(),
      body: body.patch.reply.body,
    });
  }
  const { reply: _reply, decisionSummary, ...fmPatch } = body.patch;
  const fm = { ...comment.frontmatter, ...fmPatch };
  await fs.writeFile(file, serializeComment(fm, newBody), 'utf8');

  const filesToCommit = [file];
  if (body.patch.status === 'resolved' && decisionSummary && decisionSummary.trim()) {
    const decisionsFile = await appendDecision(ctx, body.id, decisionSummary.trim());
    filesToCommit.push(decisionsFile);
  }

  broadcastSse(ctx, { type: 'updated', id: body.id });
  enqueueGitOp(`update ${body.id}`, () =>
    commitAndPush(filesToCommit, `update on ${body.id}`, gitOpts(ctx)),
  );
  return { ok: true };
}

export async function deleteComment(
  ctx: HandlerContext,
  id: string,
): Promise<{ ok: true }> {
  if (!id || !/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new HandlerError(400, 'bad id');
  }
  const file = path.join(ctx.commentsDir, `${id}.md`);
  let comment;
  try {
    const raw = await fs.readFile(file, 'utf8');
    comment = parseComment(raw, file);
  } catch {
    throw new HandlerError(404, 'not found');
  }
  // Comments are a shared resource — anyone on the team can resolve,
  // reopen, reply, or delete any comment. The author is captured for
  // attribution + audit (commit message records who did the delete) but
  // does NOT gate the action. Git history preserves the file regardless.
  const actor = await getAuthor(ctx.rootDir);
  await fs.unlink(file).catch(() => { /* already gone is fine */ });
  broadcastSse(ctx, { type: 'deleted', id });
  enqueueGitOp(`delete ${id}`, () =>
    removeAndCommit([file], `delete ${id} by ${actor.email}`, gitOpts(ctx)),
  );
  return { ok: true };
}

export async function syncFromRemote(ctx: HandlerContext): Promise<{ ok: true }> {
  await backgroundPull(ctx.rootDir);
  ctx.onAfterSync?.();
  return { ok: true };
}

export function broadcastSse(ctx: HandlerContext, payload: unknown): void {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of ctx.sseClients) client.write(data);
}

async function appendDecision(
  ctx: HandlerContext,
  commentId: string,
  summary: string,
): Promise<string> {
  // .margo/decisions.md lives next to the comments dir.
  const file = path.join(path.dirname(ctx.commentsDir), 'decisions.md');
  const author = await getAuthor(ctx.rootDir);
  const date = new Date().toISOString().slice(0, 10);
  const entry = `- **${date}** · \`${commentId}\` · ${author.email} · ${summary.replace(/\n/g, ' ').trim()}`;

  let content: string;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch {
    content = [
      '# Decisions log',
      '',
      'Resolved comments distilled to one-line decisions. Newest first.',
      'Each entry references the source comment in `.margo/comments/<id>.md`.',
      '',
    ].join('\n');
  }
  // Insert before the first existing list item (newest-first ordering).
  const lines = content.split('\n');
  let insertAt = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('- ')) { insertAt = i; break; }
  }
  lines.splice(insertAt, 0, entry);
  let next = lines.join('\n');
  if (!next.endsWith('\n')) next += '\n';

  await fs.writeFile(file, next, 'utf8');
  return file;
}

async function readAllComments(dir: string): Promise<Comment[]> {
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  const comments: Comment[] = [];
  for (const f of files) {
    const full = path.join(dir, f);
    const raw = await fs.readFile(full, 'utf8');
    try {
      comments.push(parseComment(raw, full));
    } catch {
      // Malformed file — skip rather than crash. The overlay surfaces a banner.
    }
  }
  return comments;
}

type ValidRole = 'pm' | 'designer' | 'dev';
const VALID_ROLES: ValidRole[] = ['pm', 'designer', 'dev'];

async function resolveRole(
  email: string,
  config: MargoConfig,
  cwd: string,
): Promise<ValidRole | undefined> {
  const fromRoster = config.roster.find((r) => r.email === email)?.role;
  if (fromRoster && VALID_ROLES.includes(fromRoster as ValidRole)) {
    return fromRoster as ValidRole;
  }
  const declared = await getDeclaredRole(cwd);
  if (declared) return declared;
  return undefined;
}

function gitOpts(ctx: HandlerContext): GitOptions {
  return {
    cwd: ctx.rootDir,
    commitPrefix: ctx.config.git.commitPrefix,
    autoCommit: ctx.config.git.autoCommit,
    autoPush: ctx.config.git.autoPush,
    pullBeforePush: ctx.config.git.pullBeforePush,
  };
}
