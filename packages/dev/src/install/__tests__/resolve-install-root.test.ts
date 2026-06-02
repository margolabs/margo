// Verifies the install-time path resolution:
//   - `resolveGitRoot` returns the git repo root regardless of CWD subdir
//     depth. Used for skill placement (Claude Code only discovers project
//     skills at workspace root) and the git-repo-present precondition.
//   - `findMargoDir` walks up from CWD to find the nearest ancestor
//     containing `margo.config.json`. This is what lets `install-skill`
//     / `update` / `uninstall` be run from any subdirectory of a
//     margo-enabled project. Returns `null` if none.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { findMargoDir, resolveGitRoot } from '../cli.js';

describe('resolveGitRoot', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'margo-cli-root-')));
    execSync('git init -q -b main', { cwd: repoRoot });
    execSync('git config user.email test@example.com', { cwd: repoRoot });
    execSync('git config user.name "Test"', { cwd: repoRoot });
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('returns the repo root when invoked from the repo root', async () => {
    expect(await resolveGitRoot(repoRoot)).toBe(repoRoot);
  });

  it('returns the repo root when invoked from a nested subdir', async () => {
    const sub = path.join(repoRoot, 'apps', 'web');
    await fs.mkdir(sub, { recursive: true });
    expect(await resolveGitRoot(sub)).toBe(repoRoot);
  });
});

describe('findMargoDir', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'margo-find-')));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('returns null when no margo.config.json is found anywhere upward', async () => {
    const sub = path.join(tmp, 'apps', 'web');
    await fs.mkdir(sub, { recursive: true });
    expect(await findMargoDir(sub)).toBeNull();
  });

  it('returns the same dir when margo.config.json is right there', async () => {
    await fs.writeFile(path.join(tmp, 'margo.config.json'), '{"storage":"standalone","id":"wsp-test"}', 'utf8');
    expect(await findMargoDir(tmp)).toBe(tmp);
  });

  it('walks up to find an ancestor margo.config.json', async () => {
    // Config at the app level; CWD inside a deeply nested subdir of that app.
    // This is the "user ran install-skill from src/components/foo" case.
    const app = path.join(tmp, 'apps', 'web');
    await fs.mkdir(app, { recursive: true });
    await fs.writeFile(path.join(app, 'margo.config.json'), '{"storage":"standalone","id":"wsp-test"}', 'utf8');
    const deep = path.join(app, 'src', 'components', 'foo');
    await fs.mkdir(deep, { recursive: true });
    expect(await findMargoDir(deep)).toBe(app);
  });

  it('picks the nearest config when multiple exist on the path', async () => {
    // Monorepo case: both git root and per-app have margo.config.json. The
    // nearer one wins — that's the project the user is currently working in.
    await fs.writeFile(path.join(tmp, 'margo.config.json'), '{"storage":"standalone","id":"wsp-root"}', 'utf8');
    const app = path.join(tmp, 'apps', 'web');
    await fs.mkdir(app, { recursive: true });
    await fs.writeFile(path.join(app, 'margo.config.json'), '{"storage":"standalone","id":"wsp-app"}', 'utf8');
    expect(await findMargoDir(app)).toBe(app);
  });
});
