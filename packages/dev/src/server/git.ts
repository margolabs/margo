// Tiny wrapper over the local `git` CLI. The dev plugin uses these
// READ-ONLY diagnostics to surface "your working tree is divergent from
// when the pin was made" warnings in the overlay, plus the author of
// new comments. Margo never commits or pushes from the user's repo —
// comment storage lives in `~/.margo/` (standalone) or on a self-
// hostable host (server mode), not in the repo's git history.

import { spawn } from 'node:child_process';

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

/**
 * Persist `user.name` and `user.email` into git config so subsequent
 * getAuthor()s succeed without the operator manually running `git config`.
 *
 * Scope: `--global` so a one-time setup carries to every repo on this
 * machine. The overlay-side prompt only fires when both values are
 * missing, which is by definition a fresh-environment problem.
 */
export async function setAuthor(name: string, email: string, cwd: string): Promise<void> {
  await run(cwd, ['config', '--global', 'user.name', name]);
  await run(cwd, ['config', '--global', 'user.email', email]);
}

/** Read user's self-declared margo role from `git config margo.role`. */
export async function getDeclaredRole(cwd: string): Promise<'pm' | 'designer' | 'dev' | undefined> {
  const v = (await run(cwd, ['config', 'margo.role'])).stdout.trim().toLowerCase();
  if (v === 'pm' || v === 'designer' || v === 'dev') return v;
  return undefined;
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
  const { stdout, code } = await run(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  if (code !== 0) return null;
  const [aheadStr, behindStr] = stdout.trim().split(/\s+/);
  const ahead = Number.parseInt(aheadStr ?? '', 10);
  const behind = Number.parseInt(behindStr ?? '', 10);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
  return { ahead, behind };
}
