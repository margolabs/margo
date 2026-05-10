// Tiny wrapper over the local `git` CLI. We never import a JS git library —
// shelling out to the system git binary is what makes margo host-agnostic.

import { spawn } from 'node:child_process';
import * as path from 'node:path';

export interface GitOptions {
  cwd: string;
  commitPrefix: string;
  autoCommit: boolean;
  autoPush: boolean;
  pullBeforePush: boolean;
}

async function run(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  const { stdout, code } = await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (code !== 0) throw new Error('not a git repository or no HEAD');
  return stdout.trim();
}

export async function getAuthor(cwd: string): Promise<{ name: string; email: string }> {
  const name = (await run(cwd, ['config', 'user.name'])).stdout.trim();
  const email = (await run(cwd, ['config', 'user.email'])).stdout.trim();
  if (!email) throw new Error('git config user.email is not set');
  return { name, email };
}

/** Read user's self-declared margo role from `git config margo.role`. */
export async function getDeclaredRole(cwd: string): Promise<'pm' | 'designer' | 'dev' | undefined> {
  const v = (await run(cwd, ['config', 'margo.role'])).stdout.trim().toLowerCase();
  if (v === 'pm' || v === 'designer' || v === 'dev') return v;
  return undefined;
}

/** Stage, commit, and (optionally) push files under .margo/ */
export async function commitAndPush(
  files: string[],
  message: string,
  opts: GitOptions,
): Promise<void> {
  if (!opts.autoCommit) return;
  const rel = files.map((f) => path.relative(opts.cwd, f));
  const add = await run(opts.cwd, ['add', ...rel]);
  if (add.code !== 0) throw new Error(`git add failed: ${add.stderr}`);

  await commitAndMaybePush(message, opts);
}

/** Remove files from disk + git index, commit, and (optionally) push. */
export async function removeAndCommit(
  files: string[],
  message: string,
  opts: GitOptions,
): Promise<void> {
  const rel = files.map((f) => path.relative(opts.cwd, f));
  if (!opts.autoCommit) {
    // No git ops — just unlink from disk so the local view updates.
    const fs = await import('node:fs/promises');
    for (const f of files) await fs.unlink(f).catch(() => {});
    return;
  }
  // `git rm` both deletes the file and stages the deletion. `--ignore-unmatch`
  // makes the call idempotent when the file is already gone (e.g. a stale
  // duplicate request after the SSE refresh).
  const rm = await run(opts.cwd, ['rm', '--ignore-unmatch', '--', ...rel]);
  if (rm.code !== 0) throw new Error(`git rm failed: ${rm.stderr}`);

  await commitAndMaybePush(message, opts);
}

async function commitAndMaybePush(message: string, opts: GitOptions): Promise<void> {
  const fullMessage = `${opts.commitPrefix} ${message}`.trim();
  const commit = await run(opts.cwd, ['commit', '-m', fullMessage]);
  if (commit.code !== 0 && !commit.stdout.includes('nothing to commit')) {
    throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
  }

  if (!opts.autoPush) return;

  if (opts.pullBeforePush) {
    // --autostash so the rebase doesn't refuse to start when the user has
    // unstaged work-in-progress alongside the comment file. Their unstaged
    // changes are stashed before the rebase, reapplied after, and never
    // included in the push (only what we explicitly committed goes out).
    const pull = await run(opts.cwd, ['pull', '--rebase', '--autostash']);
    if (pull.code !== 0) {
      throw new Error(
        `git pull --rebase failed before push. Resolve manually and re-run: ${pull.stderr}`,
      );
    }
  }

  const push = await run(opts.cwd, ['push']);
  if (push.code !== 0) {
    throw new Error(`git push failed: ${push.stderr}`);
  }
}

/** Background: pull from remote so local sees others' new comments. */
export async function backgroundPull(cwd: string): Promise<void> {
  // --rebase to avoid generating merge commits inside the comment stream.
  // --autostash so a dirty WT doesn't block the silent background pull.
  await run(cwd, ['pull', '--rebase', '--autostash', '--quiet']);
}

/** Short SHA of HEAD, or null if not in a git repo / no commits yet. */
export async function getCurrentCommit(cwd: string): Promise<string | null> {
  const { stdout, code } = await run(cwd, ['rev-parse', '--short', 'HEAD']);
  if (code !== 0) return null;
  return stdout.trim() || null;
}

/** Whether the working tree has uncommitted changes, plus how many files. */
export async function getDirtyState(cwd: string): Promise<{ dirty: boolean; count: number }> {
  const { stdout, code } = await run(cwd, ['status', '--porcelain']);
  if (code !== 0) return { dirty: false, count: 0 };
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  return { dirty: lines.length > 0, count: lines.length };
}

/** Commits ahead/behind the upstream tracking branch, or null when none configured. */
export async function getAheadBehind(cwd: string): Promise<{ ahead: number; behind: number } | null> {
  // `@{u}` resolves to the configured upstream; if there isn't one, the call
  // exits non-zero and we treat the repo as having no remote tracking.
  const { stdout, code } = await run(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  if (code !== 0) return null;
  const [aheadStr, behindStr] = stdout.trim().split(/\s+/);
  const ahead = Number.parseInt(aheadStr ?? '', 10);
  const behind = Number.parseInt(behindStr ?? '', 10);
  if (Number.isNaN(ahead) || Number.isNaN(behind)) return null;
  return { ahead, behind };
}
