// Background fetch-and-notify for `.margo/comments/` on the upstream branch.
// Distinct from `backgroundPull` in that it never touches the working tree —
// the only mutation a poller does is a `git fetch`, which only updates refs
// under .git/. Comment changes are surfaced to the overlay as a notification
// the user explicitly acts on, never as a silent rebase that could surprise
// in-progress work.

import { EventEmitter } from 'node:events';
import { fetchRemote, listIncomingChanges } from './git.js';

export interface RemoteChangesPayload {
  type: 'remote-changes';
  added: string[];
  modified: string[];
  deleted: string[];
  // Total files changed — convenience for the overlay so it doesn't have to
  // sum three arrays before rendering the badge text.
  total: number;
}

const DEFAULT_INTERVAL_MS = 60_000;
const POLL_PATH_FILTER = '.margo/comments/';

export class RemotePoller extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastTotal = 0;
  // Last payload broadcast — replayed to SSE clients that connect after the
  // tick fires. Without this, a tab opened later than the initial tick would
  // never see the banner: the broadcast went to an empty client set, and the
  // next tick dedups on lastTotal.
  private lastPayload: RemoteChangesPayload | null = null;

  /** Most recent broadcast payload, or null if nothing is incoming. */
  getLastPayload(): RemoteChangesPayload | null {
    return this.lastPayload;
  }

  constructor(
    private readonly rootDir: string,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {
    super();
  }

  start(): void {
    if (this.timer || this.intervalMs <= 0) return;
    // Run once immediately so a freshly-opened overlay sees pending incoming
    // comments without waiting a full interval.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return; // skip if the previous tick is still in flight
    this.running = true;
    try {
      const fetched = await fetchRemote(this.rootDir).catch(() => false);
      if (!fetched) return;
      const incoming = await listIncomingChanges(this.rootDir, POLL_PATH_FILTER);
      if (!incoming) return;
      const total = incoming.added.length + incoming.modified.length + incoming.deleted.length;
      // Only emit when the set actually moves. Avoids re-toasting on every
      // tick when nothing has changed but the count is still > 0.
      if (total === this.lastTotal) return;
      this.lastTotal = total;
      const payload: RemoteChangesPayload = {
        type: 'remote-changes',
        added: incoming.added,
        modified: incoming.modified,
        deleted: incoming.deleted,
        total,
      };
      this.lastPayload = total > 0 ? payload : null;
      this.emit('event', payload);
    } finally {
      this.running = false;
    }
  }

  /**
   * Clear cached state after a successful pull. Drops the replayed snapshot
   * (so a tab opened between the pull and the next tick doesn't see the now-
   * stale "N new comments" banner) and resets dedup so the next tick will
   * re-emit if upstream gained more changes during the pull.
   */
  reset(): void {
    this.lastTotal = 0;
    this.lastPayload = null;
  }
}
