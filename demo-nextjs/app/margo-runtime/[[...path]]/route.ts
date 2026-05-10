// Catch-all Route Handler for margo's /__margo/* surface (App Router).
// All four methods point to the same dispatcher; it inspects path + method.
import { handlers } from 'margo-dev/next';

export const { GET, POST, PATCH, DELETE } = handlers;

// Node runtime is required: handlers shell out to git and use chokidar.
export const runtime = 'nodejs';
// Never cache — comment writes and SSE streams must hit the live handler.
export const dynamic = 'force-dynamic';
