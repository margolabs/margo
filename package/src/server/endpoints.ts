// Local HTTP endpoints exposed by the margo dev plugin.
//
// All routes mounted under /__margo/. The Vite plugin attaches these to the
// dev server's middleware. They are explicitly NOT exposed in production
// builds; the plugin only mounts them when `command === 'serve'`.
//
// No auth: this is localhost only. The plugin refuses to start if it
// detects it is being served on a non-loopback host without explicit
// override (TODO).

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseComment, serializeComment, appendReply } from '../shared/frontmatter.js';
import { newCommentId } from '../shared/id.js';
import {
  backgroundPull,
  commitAndPush,
  getAuthor,
  getCurrentBranch,
  getDeclaredRole,
  removeAndCommit,
  type GitOptions,
} from './git.js';
import type {
  Comment,
  CreateCommentRequest,
  MargoConfig,
  UpdateCommentRequest,
} from '../shared/types.js';

export interface EndpointContext {
  rootDir: string; // git repo root
  commentsDir: string; // .margo/comments
  config: MargoConfig;
  sseClients: Set<ServerResponse>;
}

const ENDPOINTS = ['/__margo/comment', '/__margo/list', '/__margo/events', '/__margo/sync', '/__margo/me'] as const;

export function isMargoEndpoint(url: string | undefined): boolean {
  if (!url) return false;
  return ENDPOINTS.some((e) => url === e || url.startsWith(e + '?'));
}

export async function handleEndpoint(
  ctx: EndpointContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = req.url ?? '';
  try {
    if (url === '/__margo/list' && req.method === 'GET') return await handleList(ctx, res);
    if (url === '/__margo/me' && req.method === 'GET') return await handleMe(ctx, res);
    if (url === '/__margo/comment' && req.method === 'POST') return await handleCreate(ctx, req, res);
    if (url === '/__margo/comment' && req.method === 'PATCH') return await handleUpdate(ctx, req, res);
    if (url.startsWith('/__margo/comment') && req.method === 'DELETE') return await handleDelete(ctx, req, res);
    if (url === '/__margo/events' && req.method === 'GET') return handleEvents(ctx, req, res);
    if (url === '/__margo/sync' && req.method === 'POST') return await handleSync(ctx, res);
    res.writeHead(404).end('not found');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

async function handleList(ctx: EndpointContext, res: ServerResponse): Promise<void> {
  const comments = await readAllComments(ctx.commentsDir);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ comments }));
}

async function handleMe(ctx: EndpointContext, res: ServerResponse): Promise<void> {
  // Identifies the local user via git config so the overlay can show
  // own-only delete affordances. No auth — this is localhost only.
  const author = await getAuthor(ctx.rootDir);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ email: author.email, name: author.name }));
}

async function handleDelete(
  ctx: EndpointContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // ?id=<commentId> — kept in the query string so the request is trivially
  // cacheable/loggable. We re-validate authorship server-side regardless of
  // what the UI shows.
  const id = parseQueryParam(req.url ?? '', 'id');
  if (!id || !/^[a-zA-Z0-9._-]+$/.test(id)) {
    res.writeHead(400).end('bad id');
    return;
  }
  const file = path.join(ctx.commentsDir, `${id}.md`);
  let comment;
  try {
    const raw = await fs.readFile(file, 'utf8');
    comment = parseComment(raw, file);
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  const me = await getAuthor(ctx.rootDir);
  if (comment.frontmatter.author !== me.email) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'only the original author can delete a comment' }));
    return;
  }
  // Authorship is the only gate. Status doesn't matter: resolved comments
  // are kept as audit-trail by default (the overlay hides them), but the
  // owner can prune their own at any time. Git history preserves the file.
  await removeAndCommit([file], `delete ${id} by ${me.email}`, gitOpts(ctx));
  broadcastSse(ctx, { type: 'deleted', id });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

function parseQueryParam(url: string, name: string): string | null {
  const q = url.split('?')[1];
  if (!q) return null;
  for (const pair of q.split('&')) {
    const [k, v] = pair.split('=');
    if (decodeURIComponent(k ?? '') === name) return decodeURIComponent(v ?? '');
  }
  return null;
}

async function handleCreate(
  ctx: EndpointContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJson<CreateCommentRequest>(req));
  const id = newCommentId();
  const author = await getAuthor(ctx.rootDir);
  const role = await resolveRole(author.email, ctx.config, ctx.rootDir);
  const branch = await getCurrentBranch(ctx.rootDir);
  const created = new Date().toISOString();

  const fm = {
    id,
    type: body.type ?? 'task',
    author: author.email,
    ...(author.name ? { authorName: author.name } : {}),
    ...(role ? { role } : {}),
    branch,
    created,
    status: 'open' as const,
    target: body.target,
  };
  const file = path.join(ctx.commentsDir, `${id}.md`);
  await fs.mkdir(ctx.commentsDir, { recursive: true });
  await fs.writeFile(file, serializeComment(fm, body.body), 'utf8');

  await commitAndPush([file], `comment by ${author.email} on ${body.target.url}`, gitOpts(ctx));

  broadcastSse(ctx, { type: 'created', id });
  res.writeHead(201, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id }));
}

async function handleUpdate(
  ctx: EndpointContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJson<UpdateCommentRequest>(req);
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
  // Strip non-frontmatter patch fields before merging.
  const { reply: _reply, decisionSummary, ...fmPatch } = body.patch;
  const fm = { ...comment.frontmatter, ...fmPatch };
  await fs.writeFile(file, serializeComment(fm, newBody), 'utf8');

  const filesToCommit = [file];
  if (body.patch.status === 'resolved' && decisionSummary && decisionSummary.trim()) {
    const decisionsFile = await appendDecision(ctx, body.id, decisionSummary.trim());
    filesToCommit.push(decisionsFile);
  }

  await commitAndPush(filesToCommit, `update on ${body.id}`, gitOpts(ctx));
  broadcastSse(ctx, { type: 'updated', id: body.id });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

async function appendDecision(
  ctx: EndpointContext,
  commentId: string,
  summary: string,
): Promise<string> {
  // .margo/decisions.md lives next to the comments dir.
  const file = path.join(path.dirname(ctx.commentsDir), 'decisions.md');
  const author = await getAuthor(ctx.rootDir);
  const date = new Date().toISOString().slice(0, 10);
  // Single-line entry; safe even if the summary contains markdown.
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

function handleEvents(ctx: EndpointContext, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(`: connected ${new Date().toISOString()}\n\n`);
  ctx.sseClients.add(res);
  req.on('close', () => ctx.sseClients.delete(res));
}

async function handleSync(ctx: EndpointContext, res: ServerResponse): Promise<void> {
  await backgroundPull(ctx.rootDir);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
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

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

type ValidRole = 'pm' | 'designer' | 'dev';
const VALID_ROLES: ValidRole[] = ['pm', 'designer', 'dev'];

async function resolveRole(
  email: string,
  config: MargoConfig,
  cwd: string,
): Promise<ValidRole | undefined> {
  // 1. roster lookup (team-shared, lives in .margo/config.json)
  const fromRoster = config.roster.find((r) => r.email === email)?.role;
  if (fromRoster && VALID_ROLES.includes(fromRoster as ValidRole)) {
    return fromRoster as ValidRole;
  }
  // 2. self-declaration (`git config margo.role designer`) — per-user, no config edit needed
  const declared = await getDeclaredRole(cwd);
  if (declared) return declared;
  // 3. nothing — return undefined so the chip doesn't render
  return undefined;
}

function gitOpts(ctx: EndpointContext): GitOptions {
  return {
    cwd: ctx.rootDir,
    commitPrefix: ctx.config.git.commitPrefix,
    autoCommit: ctx.config.git.autoCommit,
    autoPush: ctx.config.git.autoPush,
    pullBeforePush: ctx.config.git.pullBeforePush,
  };
}

export function broadcastSse(ctx: EndpointContext, payload: unknown): void {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of ctx.sseClients) client.write(data);
}
