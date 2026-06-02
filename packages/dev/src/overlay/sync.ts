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

  async getMe(): Promise<{
    email: string;
    name: string;
    role?: 'read' | 'write' | 'admin' | null;
    projectExists?: boolean;
    mode?: 'standalone' | 'server';
    server?: { host: string; project: string };
    needsAuth?: boolean;
  } | null> {
    try {
      const res = await fetch('/__margo/me');
      if (!res.ok) return null;
      const body = await res.json();
      if (!body) return null;
      // Server-mode but no credential yet — the overlay drives the
      // in-browser device flow. Return a sparse identity so the boot
      // path can short-circuit to the login UI without falling into
      // the "missing git config" prompt branch (which doesn't apply
      // when the plugin itself isn't logged in to the host).
      if (body.needsAuth === true) {
        return {
          email: '',
          name: '',
          mode: body.mode === 'server' || body.mode === 'standalone' ? body.mode : 'server',
          server: body.server && typeof body.server === 'object'
            ? { host: String(body.server.host ?? ''), project: String(body.server.project ?? '') }
            : undefined,
          needsAuth: true,
        };
      }
      const role = body.role;
      return {
        email: typeof body.email === 'string' ? body.email : '',
        name: typeof body.name === 'string' ? body.name : '',
        // Explicit null = "not a member" (server-mode access denied);
        // undefined = role wasn't reported (standalone mode, or older host).
        role: role === 'read' || role === 'write' || role === 'admin'
          ? role
          : (role === null ? null : undefined),
        projectExists: typeof body.projectExists === 'boolean' ? body.projectExists : undefined,
        mode: body.mode === 'server' || body.mode === 'standalone' ? body.mode : undefined,
        server: body.server && typeof body.server === 'object'
          ? { host: String(body.server.host ?? ''), project: String(body.server.project ?? '') }
          : undefined,
      };
    } catch { return null; }
  }

  /** Trigger the in-browser device-login flow via the plugin proxy.
   *  Opens the host's confirmation page in a new tab and polls the
   *  plugin until the user authorizes — the plugin saves the credential
   *  on success. Resolves on success, throws with a user-readable
   *  message on failure / expiry. */
  async signIn(opts: { onPrompt?: (verifyUrl: string) => void; pollEveryMs?: number } = {}): Promise<{ email: string; name: string }> {
    const startRes = await fetch('/__margo/auth/start', { method: 'POST' });
    if (!startRes.ok) {
      const body = await safeJson(startRes);
      throw new Error(body?.error ?? `could not start sign-in (HTTP ${startRes.status})`);
    }
    const { deviceCode, verifyUrl, pollInterval, expiresAt } = (await startRes.json()) as {
      deviceCode: string;
      verifyUrl: string;
      pollInterval: number;
      expiresAt: string;
    };
    opts.onPrompt?.(verifyUrl);
    // Try to pop the host confirmation page in a fresh tab so the user
    // doesn't have to copy/paste. Modern browsers will allow this only
    // when called synchronously from a user gesture; the caller must
    // invoke signIn() from a click handler for the window.open to land.
    try { window.open(verifyUrl, '_blank', 'noopener'); } catch { /* popup blocked; user can still click the printed URL */ }
    const intervalMs = Math.max(1000, (opts.pollEveryMs ?? pollInterval ?? 2) * 1000);
    const deadlineMs = Date.parse(expiresAt) || (Date.now() + 10 * 60_000);
    while (Date.now() < deadlineMs) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const r = await fetch('/__margo/auth/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode }),
      });
      if (r.status === 202) continue; // pending
      if (r.status === 200) {
        const body = (await r.json()) as { status?: string; user?: { email: string; name: string } };
        if (body.status === 'authorized' && body.user) return body.user;
        continue; // odd shape; keep polling
      }
      if (r.status === 410) throw new Error('sign-in expired — please try again');
      if (r.status === 404) throw new Error('sign-in session not found — please try again');
      // 4xx / 5xx — surface and keep polling so a transient host hiccup
      // doesn't kill the whole flow. We'll bail when the deadline passes.
    }
    throw new Error('sign-in timed out — please try again');
  }

  /** Outbox status — surfaces how many writes haven't reached the host
   *  yet. The plugin's RemoteTransport returns the real count; standalone
   *  mode returns { pending: 0 } so the overlay's banner logic doesn't
   *  branch on mode. */
  async getSyncStatus(): Promise<{ pending: number; lastSyncAt: string | null; lastError: string | null } | null> {
    try {
      const res = await fetch('/__margo/sync-status');
      if (!res.ok) return null;
      const body = await res.json();
      return {
        pending: typeof body.pending === 'number' ? body.pending : 0,
        lastSyncAt: typeof body.lastSyncAt === 'string' ? body.lastSyncAt : null,
        lastError: typeof body.lastError === 'string' ? body.lastError : null,
      };
    } catch { return null; }
  }

  /** Forget the credential for the host this plugin is configured
   *  against. The bearer token remains valid server-side until revoked
   *  in the host dashboard; this just removes it from local storage. */
  async signOut(): Promise<void> {
    const res = await fetch('/__margo/auth/logout', { method: 'POST' });
    if (!res.ok) {
      const body = await safeJson(res);
      throw new Error(body?.error ?? `could not sign out (HTTP ${res.status})`);
    }
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

async function safeJson(res: Response): Promise<{ error?: string } | null> {
  try { return await res.json() as { error?: string }; } catch { return null; }
}
