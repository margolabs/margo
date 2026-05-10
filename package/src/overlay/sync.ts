// Subscribe to comment changes streamed by the local margo server.
// Emits typed events the UI uses to keep its store in sync.

import type { Comment, GitState } from '../shared/types.js';

export type SyncEvent =
  | { type: 'snapshot'; comments: Comment[] }
  | { type: 'created'; id: string }
  | { type: 'updated'; id: string }
  | { type: 'deleted'; id: string };

export class SyncClient extends EventTarget {
  private es?: EventSource;

  start(): void {
    void this.fetchSnapshot();
    this.es = new EventSource('/__margo/events');
    this.es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        this.dispatchEvent(new CustomEvent('event', { detail: payload }));
      } catch { /* ignore malformed */ }
    };
    this.es.onerror = () => {
      // Browser auto-reconnects; nothing to do here.
    };
  }

  stop(): void {
    this.es?.close();
  }

  async createComment(req: { type: string; body: string; target: unknown }): Promise<{ id: string }> {
    const res = await fetch('/__margo/comment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`createComment failed: ${res.status}`);
    return res.json();
  }

  async patchComment(id: string, patch: Record<string, unknown>): Promise<void> {
    const res = await fetch('/__margo/comment', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, patch }),
    });
    if (!res.ok) throw new Error(`patchComment failed: ${res.status}`);
  }

  async deleteComment(id: string): Promise<void> {
    const res = await fetch(`/__margo/comment?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) {
      // Backend returns a JSON error body for 403/409; surface it verbatim.
      let detail = `${res.status}`;
      try {
        const body = await res.json() as { error?: string };
        if (body.error) detail = body.error;
      } catch { /* fall through with status code */ }
      throw new Error(detail);
    }
  }

  async getMe(): Promise<{ email: string; name: string } | null> {
    try {
      const res = await fetch('/__margo/me');
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  async getGitState(): Promise<GitState | null> {
    try {
      const res = await fetch('/__margo/git-state');
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  private async fetchSnapshot(): Promise<void> {
    try {
      const res = await fetch('/__margo/list');
      if (!res.ok) return;
      const { comments } = (await res.json()) as { comments: Comment[] };
      this.dispatchEvent(new CustomEvent('event', { detail: { type: 'snapshot', comments } satisfies SyncEvent }));
    } catch {
      // Plugin may not be ready yet during first render.
    }
  }
}
