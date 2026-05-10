// Node http adapter for the margo handlers. The Vite plugin mounts this on
// the dev server's middleware. All business logic lives in `./handlers.ts`;
// this file only translates between Node's IncomingMessage/ServerResponse
// and the transport-agnostic handler signatures.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  HandlerError,
  broadcastSse as broadcastSseCore,
  createComment,
  deleteComment,
  getGitState,
  getMe,
  listComments,
  syncFromRemote,
  updateComment,
  type HandlerContext,
  type SseClient,
} from './handlers.js';
import type { CreateCommentRequest, UpdateCommentRequest } from '../shared/types.js';

// Re-export handler context as the public type the plugin uses, so the rest
// of the package keeps the existing import path.
export type EndpointContext = HandlerContext;

const ENDPOINTS = ['/__margo/comment', '/__margo/list', '/__margo/events', '/__margo/sync', '/__margo/me', '/__margo/git-state'] as const;

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
    if (url === '/__margo/list' && req.method === 'GET') {
      return sendJson(res, 200, await listComments(ctx));
    }
    if (url === '/__margo/me' && req.method === 'GET') {
      return sendJson(res, 200, await getMe(ctx));
    }
    if (url === '/__margo/git-state' && req.method === 'GET') {
      return sendJson(res, 200, await getGitState(ctx));
    }
    if (url === '/__margo/comment' && req.method === 'POST') {
      const body = await readJson<CreateCommentRequest>(req);
      return sendJson(res, 201, await createComment(ctx, body));
    }
    if (url === '/__margo/comment' && req.method === 'PATCH') {
      const body = await readJson<UpdateCommentRequest>(req);
      return sendJson(res, 200, await updateComment(ctx, body));
    }
    if (url.startsWith('/__margo/comment') && req.method === 'DELETE') {
      const id = parseQueryParam(req.url ?? '', 'id') ?? '';
      return sendJson(res, 200, await deleteComment(ctx, id));
    }
    if (url === '/__margo/events' && req.method === 'GET') {
      return handleEvents(ctx, req, res);
    }
    if (url === '/__margo/sync' && req.method === 'POST') {
      return sendJson(res, 200, await syncFromRemote(ctx));
    }
    res.writeHead(404).end('not found');
  } catch (err) {
    if (err instanceof HandlerError) {
      const payload = typeof err.payload === 'string' ? { error: err.payload } : err.payload;
      return sendJson(res, err.status, payload ?? { error: err.message });
    }
    sendJson(res, 500, { error: (err as Error).message });
  }
}

function handleEvents(ctx: EndpointContext, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(`: connected ${new Date().toISOString()}\n\n`);
  // ServerResponse.write is structurally compatible enough — wrap so we don't
  // depend on the return type matching SseClient's signature.
  const client: SseClient = { write: (payload) => { res.write(payload); } };
  ctx.sseClients.add(client);
  req.on('close', () => ctx.sseClients.delete(client));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
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

// Kept for vite.ts — broadcasts a watcher-driven event to all connected SSE
// clients without going through a request. Just a re-export so the Vite
// plugin doesn't need to know about handlers.ts.
export function broadcastSse(ctx: EndpointContext, payload: unknown): void {
  broadcastSseCore(ctx, payload);
}
