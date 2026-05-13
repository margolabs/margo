// Subscribe to comment changes streamed by the local margo server.
// Emits typed events the UI uses to keep its store in sync.

import type { Comment, GitState } from '../shared/types.js';

export type SyncEvent =
  | { type: 'snapshot'; comments: Comment[] }
  | { type: 'created'; id: string }
  | { type: 'updated'; id: string }
  | { type: 'deleted'; id: string }
  // Server detected new comment changes on upstream (origin/<branch>).
  // The overlay shows a one-click "pull" banner; total === 0 dismisses it.
  | {
      type: 'remote-changes';
      added: string[];
      modified: string[];
      deleted: string[];
      total: number;
    };

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
      const body = await res.json();
      // Server returns null when git config is missing — propagate as null
      // so the overlay can prompt for setup.
      if (!body || !body.email) return null;
      return body as { email: string; name: string };
    } catch { return null; }
  }

  /** Persist git user.name / user.email so subsequent operations succeed. */
  async setMe(name: string, email: string): Promise<{ email: string; name: string } | { error: string }> {
    try {
      const res = await fetch('/__margo/me', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, email }),
      });
      if (!res.ok) {
        let error = `${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) error = body.error;
        } catch { /* fall through */ }
        return { error };
      }
      return await res.json();
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  /** Trigger a `git pull --rebase --autostash` on the dev server. */
  async syncFromRemote(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const res = await fetch('/__margo/sync', { method: 'POST' });
      if (!res.ok) {
        let error = `${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) error = body.error;
        } catch { /* fall through */ }
        return { ok: false, error };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
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
