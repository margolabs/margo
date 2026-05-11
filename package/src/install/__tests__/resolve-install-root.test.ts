// Verifies `margo init` (and update/uninstall) anchors at the git repo
// root regardless of which subdirectory the user invoked it from. The
// previous behavior dropped `.margo/` and `.claude/skills/margo.md` at
// `process.cwd()`, which surfaced three symptoms in monorepo setups —
// missed slash command, sparse-checkout invisibility, config drift.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveInstallRoot } from '../cli.js';

describe('resolveInstallRoot', () => {
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
    const root = await resolveInstallRoot(repoRoot);
    expect(root).toBe(repoRoot);
  });

  it('returns the repo root when invoked from a nested subdir (the monorepo case)', async () => {
    const sub = path.join(repoRoot, 'apps', 'web');
    await fs.mkdir(sub, { recursive: true });
    const root = await resolveInstallRoot(sub);
    // The whole point of the function: install where margo can be found
    // by every teammate, not where one developer happened to run the CLI.
    expect(root).toBe(repoRoot);
    expect(root).not.toBe(sub);
  });

  it('returns the repo root when invoked from a deeply nested subdir', async () => {
    const sub = path.join(repoRoot, 'a', 'b', 'c', 'd');
    await fs.mkdir(sub, { recursive: true });
    const root = await resolveInstallRoot(sub);
    expect(root).toBe(repoRoot);
  });
});
