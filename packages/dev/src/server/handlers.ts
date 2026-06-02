// Transport-agnostic business logic. Both the Vite plugin (Node http) and
// the Next.js plugin (Web Fetch) call these handlers, then serialize the
// returned plain objects to wire format. SSE streaming stays per-transport
// because the streaming APIs (Node ServerResponse vs. Web ReadableStream) are
// fundamentally different — but `broadcastSse` here writes through a
// transport-supplied `SseClient` so handlers can fire events without caring.
//
// Storage (read/write comment files, identity, sync) is delegated to a
// `Transport` (see ../storage/transport.ts). The current local-fs+git
// behavior lives in LocalTransport; a future RemoteTransport will swap in
// for server mode without touching this file.

import { serializeComment, appendReply } from '../shared/frontmatter.js';
import { newCommentId } from '../shared/id.js';
import {
  getAheadBehind,
  getCurrentBranch,
  getCurrentCommit,
  getDirtyState,
} from './git.js';
import type { Transport } from '../storage/transport.js';
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
  /** Repo root — used for git-state diagnostics (commit/branch/dirty), which
   *  always describes the user's code repo regardless of where comments are
   *  stored. */
  rootDir: string;
  /** Storage backend — StandaloneTransport (solo, files in $HOME) or
   *  RemoteTransport (team, HTTP against margo-host). */
  transport: Transport;
  /** Which backend is wired up. Surfaced to the overlay via /__margo/me so
   *  the UI can show "connected to server" indicators when relevant. */
  storageMode: 'standalone' | 'server';
  /** Server connection info — only populated when storageMode === 'server'.
   *  The overlay shows the project + host (not the token) in its identity
   *  panel so teammates can tell which workspace they're connected to. */
  serverInfo?: { host: string; project: string };
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

export async function listComments(ctx: HandlerContext): Promise<{ comments: Comment[] }> {
  return { comments: await ctx.transport.list() };
}

export async function getMe(
  ctx: HandlerContext,
): Promise<{
  email: string;
  name: string;
  role?: 'read' | 'write' | 'admin' | null;
  projectExists?: boolean;
  mode: 'standalone' | 'server';
  server?: { host: string; project: string };
} | null> {
  // Return null on missing identity so the overlay can prompt for setup
  // instead of treating the request as a 5xx and surfacing a cryptic
  // "author api failed" error on the next pin attempt.
  const identity = await ctx.transport.getIdentity();
  if (!identity) return null;
  return {
    ...identity,
    mode: ctx.storageMode,
    ...(ctx.serverInfo ? { server: ctx.serverInfo } : {}),
  };
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
  await ctx.transport.setIdentity({ name, email });
  return { name, email };
}

export async function getGitState(ctx: HandlerContext): Promise<GitState> {
  // Git state describes the user's working repo (used for pin diagnostics:
  // "you're on a different commit / dirty tree than when the pin was made").
  // It always reads from ctx.rootDir, NOT from the transport — even in server
  // mode, the user's code repo is what we want to describe.
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
  const identity = await ctx.transport.getIdentity();
  if (!identity) throw new HandlerError(412, 'identity not configured');
  const role = await resolveRole(identity.email, ctx);
  // Git state captured into the pin still describes the user's working repo —
  // independent of comment storage. Commit/branch/dirty go onto target so the
  // pin can be diagnosed later ("pin made against commit X, dirty tree").
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
    author: identity.email,
    ...(identity.name ? { authorName: identity.name } : {}),
    ...(role ? { role } : {}),
    branch,
    created,
    status: 'open' as const,
    target,
  };
  await ctx.transport.write(id, serializeComment(fm, body.body), `comment by ${identity.email} on ${body.target.url}`);
  // SSE fires immediately so the local overlay (and any other tabs on this
  // dev server) re-render with the new pin without waiting on the transport's
  // own change notification round-trip.
  broadcastSse(ctx, { type: 'created', id });
  return { id };
}

export async function updateComment(
  ctx: HandlerContext,
  body: UpdateCommentRequest,
): Promise<{ ok: true }> {
  const comment = await ctx.transport.read(body.id);
  if (!comment) throw new HandlerError(404, 'not found');
  const identity = await ctx.transport.getIdentity();
  if (!identity) throw new HandlerError(412, 'identity not configured');
  let newBody = comment.body;
  if (body.patch.reply) {
    newBody = appendReply(newBody, {
      author: identity.email,
      role: await resolveRole(identity.email, ctx),
      timestamp: new Date().toISOString(),
      body: body.patch.reply.body,
    });
  }
  const { reply: _reply, decisionSummary, ...fmPatch } = body.patch;
  const fm = { ...comment.frontmatter, ...fmPatch };
  await ctx.transport.write(body.id, serializeComment(fm, newBody), `update on ${body.id}`);

  if (body.patch.status === 'resolved' && decisionSummary && decisionSummary.trim()) {
    const date = new Date().toISOString().slice(0, 10);
    const entry = `- **${date}** · \`${body.id}\` · ${identity.email} · ${decisionSummary.trim().replace(/\n/g, ' ').trim()}`;
    await ctx.transport.appendDecision(entry, `decision for ${body.id}`);
  }

  broadcastSse(ctx, { type: 'updated', id: body.id });
  return { ok: true };
}

export async function deleteComment(
  ctx: HandlerContext,
  id: string,
): Promise<{ ok: true }> {
  if (!id || !/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new HandlerError(400, 'bad id');
  }
  const existing = await ctx.transport.read(id);
  if (!existing) throw new HandlerError(404, 'not found');
  // Comments are a shared resource — anyone on the team can resolve,
  // reopen, reply, or delete any comment. The author is captured for
  // attribution + audit (commit message records who did the delete) but
  // does NOT gate the action. Git history preserves the file regardless.
  const actor = await ctx.transport.getIdentity();
  const actorEmail = actor?.email ?? 'unknown';
  await ctx.transport.remove(id, `delete ${id} by ${actorEmail}`);
  broadcastSse(ctx, { type: 'deleted', id });
  return { ok: true };
}

export async function syncFromRemote(ctx: HandlerContext): Promise<{ ok: true }> {
  await ctx.transport.sync();
  ctx.onAfterSync?.();
  return { ok: true };
}

export function broadcastSse(ctx: HandlerContext, payload: unknown): void {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of ctx.sseClients) client.write(data);
}

type ValidRole = 'pm' | 'designer' | 'dev';
const VALID_ROLES: ValidRole[] = ['pm', 'designer', 'dev'];

async function resolveRole(
  email: string,
  ctx: HandlerContext,
): Promise<ValidRole | undefined> {
  const fromRoster = ctx.config.roster.find((r) => r.email === email)?.role;
  if (fromRoster && VALID_ROLES.includes(fromRoster as ValidRole)) {
    return fromRoster as ValidRole;
  }
  const declared = await ctx.transport.getDeclaredRole(email);
  if (declared && VALID_ROLES.includes(declared as ValidRole)) {
    return declared as ValidRole;
  }
  return undefined;
}
