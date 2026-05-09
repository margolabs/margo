import chokidar from 'chokidar';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

export type WatcherEvent =
  | { type: 'add'; file: string }
  | { type: 'change'; file: string }
  | { type: 'unlink'; file: string };

export class CommentWatcher extends EventEmitter {
  private watcher?: chokidar.FSWatcher;

  constructor(private readonly commentsDir: string) {
    super();
  }

  start(): void {
    this.watcher = chokidar.watch(path.join(this.commentsDir, '*.md'), {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    });
    this.watcher
      .on('add', (file) => this.emit('event', { type: 'add', file } satisfies WatcherEvent))
      .on('change', (file) => this.emit('event', { type: 'change', file } satisfies WatcherEvent))
      .on('unlink', (file) => this.emit('event', { type: 'unlink', file } satisfies WatcherEvent));
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
  }
}
