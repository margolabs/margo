import chokidar from 'chokidar';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

// Wire-compatible with the overlay's SyncEvent variants so the plugin can
// broadcast the watcher output verbatim. Files that change via the POST
// handlers ALSO produce these events (broadcastSse from handlers.ts), so the
// overlay always speaks the same vocabulary regardless of who wrote the file.
export type WatcherEvent =
  | { type: 'created'; id: string }
  | { type: 'updated'; id: string }
  | { type: 'deleted'; id: string };

function fileToId(file: string): string {
  return path.basename(file, '.md');
}

export class CommentWatcher extends EventEmitter {
  private watcher?: chokidar.FSWatcher;

  constructor(private readonly commentsDir: string) {
    super();
  }

  start(): void {
    this.watcher = chokidar.watch(path.join(this.commentsDir, '*.md'), {
      // Initial state is already delivered to the overlay via /__margo/list.
      // Firing per-file 'created' events here would just trigger N redundant
      // refetches at startup.
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    });
    this.watcher
      .on('add', (file) => this.emit('event', { type: 'created', id: fileToId(file) } satisfies WatcherEvent))
      .on('change', (file) => this.emit('event', { type: 'updated', id: fileToId(file) } satisfies WatcherEvent))
      .on('unlink', (file) => this.emit('event', { type: 'deleted', id: fileToId(file) } satisfies WatcherEvent));
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
  }
}
