import { defineConfig } from 'vitest/config';

// Forks pool, one file at a time. Two reasons:
//   1. comment-pin tests `execSync` git and create/destroy temp repos —
//      libuv handle counts spike when those run in shared worker threads,
//      and vitest's default thread pool can crash with SIGABRT on teardown.
//   2. handlers.ts keeps a module-global gitQueue (a promise chain). Per-file
//      process isolation means one test file's queued ops can't bleed into
//      another's working tree.
export default defineConfig({
  test: {
    pool: 'forks',
    fileParallelism: false,
  },
});
