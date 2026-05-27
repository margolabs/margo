#!/usr/bin/env node
// `npx margo-dev <command>` — explicit init / install-skill / update / uninstall.
// Idempotent. Designed to be invoked by Claude Code during the
// `claude "add margo to this project"` flow.
//
// Split of concerns:
//   - `init` handles the runtime requirements: `.margo/` scaffold + framework
//     wiring. Not negotiable — without this margo doesn't run.
//   - `install-skill` handles the optional Claude Code integration: drops
//     the `/margo` skill + a root `CLAUDE.md` reference block. Opt-in;
//     not every user runs Claude Code, and some prefer the skill at user
//     scope (`~/.claude/skills/`) rather than committed per-repo.

import * as os from 'node:os';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { promisify } from 'node:util';
import { serve } from '../cli/serve.js';
import { startHost } from '../host/index.js';
import { UserStore } from '../host/user-store.js';

const execFileP = promisify(execFile);

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
// When built, templates ship at <package>/src/templates relative to compiled CLI.
// Resolve robustly whether running from dist/ or src/.
const TEMPLATE_CANDIDATES = [
  path.join(HERE, '..', '..', 'src', 'templates'),
  path.join(HERE, '..', 'templates'),
];

const MARGO_BLOCK_START = '<!-- margo:start -->';
const MARGO_BLOCK_END = '<!-- margo:end -->';
const ROOT_CLAUDE_BLOCK = `${MARGO_BLOCK_START}
This project uses margo for live-app feedback. See \`.margo/CLAUDE.md\` for how AI should engage with the comment inbox. The \`/margo\` skill triages and processes the open inbox.
${MARGO_BLOCK_END}`;

const USAGE = `usage: margo <command> [flags]

Commands:
  init                  scaffold .margo/ in the current project
  install-skill         install the /margo skill into Claude Code
  update                update the .margo/ scaffold to the latest templates
  uninstall             remove the .margo/ scaffold
  serve                 run the sidecar (proxy-mountable dev-time backend)
  host                  run the team host (server-mode storage backend)
  host:create-user      --email E --name N [--superuser]
  host:create-token     --user-id ID --label L
  host:list-users
  host:list-tokens
  host:revoke-token     --token-id ID
  host:set-superuser    --user-id ID --value true|false
  host:create-project   --slug S --name N
  host:list-projects
  host:add-member       --project SLUG --user-id ID --role read|write|admin
  host:remove-member    --project SLUG --user-id ID
  host:list-members     --project SLUG

Host CLI commands all accept --data-dir DIR.
Common flags: --port N, --cwd DIR, --data-dir DIR, --user|--project`;

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'init';
  const rest = process.argv.slice(3);
  const flags = parseFlags(rest);
  const cwd = process.cwd();
  switch (cmd) {
    case 'init':
      await init(cwd);
      break;
    case 'install-skill':
      await installSkill(cwd, { scope: flags.scope });
      break;
    case 'update':
      await update(cwd);
      break;
    case 'uninstall':
      await uninstall(cwd);
      break;
    case 'serve':
      await serve({ port: flags.port, cwd: flags.cwd ?? cwd });
      break;
    case 'host':
      await runHost({ port: flags.port, dataDir: flags.dataDir ?? path.join(cwd, 'margo-data') });
      break;
    case 'host:create-user':
      await runCreateUser({ dataDir: flags.dataDir ?? path.join(cwd, 'margo-data'), email: flags.email, name: flags.name });
      break;
    case 'host:create-token':
      await runCreateToken({ dataDir: flags.dataDir ?? path.join(cwd, 'margo-data'), userId: flags.userId, label: flags.label });
      break;
    case 'host:list-users':
      await runListUsers({ dataDir: flags.dataDir ?? path.join(cwd, 'margo-data') });
      break;
    case 'host:list-tokens':
      await runListTokens({ dataDir: flags.dataDir ?? path.join(cwd, 'margo-data') });
      break;
    case 'host:revoke-token':
      await runRevokeToken({ dataDir: flags.dataDir ?? path.join(cwd, 'margo-data'), tokenId: flags.tokenId });
      break;
    case 'host:set-superuser':
      await runSetSuperuser({ dataDir: flags.dataDir ?? path.join(cwd, 'margo-data'), userId: flags.userId, value: flags.value });
      break;
    case 'host:create-project':
      await runCreateProject({ dataDir: flags.dataDir ?? path.join(cwd, 'margo-data'), slug: flags.slug, name: flags.name });
      break;
    case 'host:list-projects':
      await runListProjects({ dataDir: flags.dataDir ?? path.join(cwd, 'margo-data') });
      break;
    case 'host:add-member':
      await runAddMember({ dataDir: flags.dataDir ?? path.join(cwd, 'margo-data'), project: flags.project, userId: flags.userId, role: flags.role });
      break;
    case 'host:remove-member':
      await runRemoveMember({ dataDir: flags.dataDir ?? path.join(cwd, 'margo-data'), project: flags.project, userId: flags.userId });
      break;
    case 'host:list-members':
      await runListMembers({ dataDir: flags.dataDir ?? path.join(cwd, 'margo-data'), project: flags.project });
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      console.error(USAGE);
      process.exit(1);
  }
}

async function runHost(opts: { port: number; dataDir: string }): Promise<void> {
  const users = new UserStore(opts.dataDir);
  await users.load();
  const handle = await startHost({ port: opts.port, dataRoot: opts.dataDir, users });
  const shutdown = (): void => {
    void handle.close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function runCreateUser(opts: { dataDir: string; email?: string; name?: string; superuser?: boolean }): Promise<void> {
  if (!opts.email || !opts.name) {
    console.error('usage: margo host:create-user --email <e> --name <n> [--superuser] [--data-dir DIR]');
    process.exit(1);
  }
  const users = new UserStore(opts.dataDir);
  const user = await users.createUser(opts.email, opts.name, { isSuperuser: opts.superuser });
  // Auto-issue a token on user creation — the operator almost always
  // wants a token to hand to the new teammate, and a second command for
  // that is friction.
  const { record, plainToken } = await users.createToken(user.id, 'initial');
  const flag = opts.superuser ? ' [superuser]' : '';
  console.log(`created user ${user.id} (${user.email})${flag}`);
  console.log(`token   ${record.id}  label=${record.label}`);
  console.log('');
  console.log('  TOKEN (shown once — store securely, the host only keeps a hash):');
  console.log(`  ${plainToken}`);
}

async function runSetSuperuser(opts: { dataDir: string; userId?: string; value?: string }): Promise<void> {
  if (!opts.userId || (opts.value !== 'true' && opts.value !== 'false')) {
    console.error('usage: margo host:set-superuser --user-id <id> --value true|false');
    process.exit(1);
  }
  const users = new UserStore(opts.dataDir);
  await users.setSuperuser(opts.userId, opts.value === 'true');
  console.log(`user ${opts.userId} isSuperuser=${opts.value}`);
}

async function runCreateProject(opts: { dataDir: string; slug?: string; name?: string }): Promise<void> {
  if (!opts.slug || !opts.name) {
    console.error('usage: margo host:create-project --slug <s> --name <n>');
    process.exit(1);
  }
  const users = new UserStore(opts.dataDir);
  const project = await users.createProject(opts.slug, opts.name);
  console.log(`created project ${project.slug} (${project.name})`);
  console.log('Note: project is now ACL-enforced. Add members with `margo host:add-member`.');
}

async function runListProjects(opts: { dataDir: string }): Promise<void> {
  const users = new UserStore(opts.dataDir);
  const list = await users.listProjects();
  if (list.length === 0) {
    console.log('(no projects registered — unregistered slugs are legacy-open)');
    return;
  }
  for (const p of list) {
    console.log(`${p.slug}  ${p.name}  created=${p.createdAt}`);
  }
}

async function runAddMember(opts: { dataDir: string; project?: string; userId?: string; role?: string }): Promise<void> {
  if (!opts.project || !opts.userId || (opts.role !== 'read' && opts.role !== 'write' && opts.role !== 'admin')) {
    console.error('usage: margo host:add-member --project <slug> --user-id <id> --role read|write|admin');
    process.exit(1);
  }
  const users = new UserStore(opts.dataDir);
  await users.addMember(opts.userId, opts.project, opts.role);
  console.log(`added/updated ${opts.userId} on ${opts.project} as ${opts.role}`);
}

async function runRemoveMember(opts: { dataDir: string; project?: string; userId?: string }): Promise<void> {
  if (!opts.project || !opts.userId) {
    console.error('usage: margo host:remove-member --project <slug> --user-id <id>');
    process.exit(1);
  }
  const users = new UserStore(opts.dataDir);
  await users.removeMember(opts.userId, opts.project);
  console.log(`removed ${opts.userId} from ${opts.project}`);
}

async function runListMembers(opts: { dataDir: string; project?: string }): Promise<void> {
  if (!opts.project) {
    console.error('usage: margo host:list-members --project <slug>');
    process.exit(1);
  }
  const users = new UserStore(opts.dataDir);
  const members = await users.listMembers(opts.project);
  if (members.length === 0) {
    console.log(`(no members on ${opts.project})`);
    return;
  }
  for (const m of members) {
    console.log(`${m.userId}  role=${m.role}  added=${m.addedAt}`);
  }
}

async function runCreateToken(opts: { dataDir: string; userId?: string; label?: string }): Promise<void> {
  if (!opts.userId || !opts.label) {
    console.error('usage: margo host:create-token --user-id <id> --label <l> [--data-dir DIR]');
    process.exit(1);
  }
  const users = new UserStore(opts.dataDir);
  const { record, plainToken } = await users.createToken(opts.userId, opts.label);
  console.log(`token ${record.id}  user=${record.userId}  label=${record.label}`);
  console.log('');
  console.log('  TOKEN (shown once — store securely):');
  console.log(`  ${plainToken}`);
}

async function runListUsers(opts: { dataDir: string }): Promise<void> {
  const users = new UserStore(opts.dataDir);
  const list = await users.listUsers();
  if (list.length === 0) {
    console.log('(no users)');
    return;
  }
  for (const u of list) {
    console.log(`${u.id}  ${u.email}  ${u.name}  created=${u.createdAt}`);
  }
}

async function runListTokens(opts: { dataDir: string }): Promise<void> {
  const users = new UserStore(opts.dataDir);
  const list = await users.listTokens();
  if (list.length === 0) {
    console.log('(no active tokens)');
    return;
  }
  for (const t of list) {
    const last = t.lastUsedAt ?? 'never';
    console.log(`${t.id}  user=${t.userId}  label=${t.label}  prefix=${t.plainPrefix}…  last-used=${last}`);
  }
}

async function runRevokeToken(opts: { dataDir: string; tokenId?: string }): Promise<void> {
  if (!opts.tokenId) {
    console.error('usage: margo host:revoke-token --token-id <id> [--data-dir DIR]');
    process.exit(1);
  }
  const users = new UserStore(opts.dataDir);
  await users.revokeToken(opts.tokenId);
  console.log(`revoked token ${opts.tokenId}`);
}

function parseFlags(args: string[]): {
  scope: 'project' | 'user';
  port: number;
  cwd?: string;
  dataDir?: string;
  email?: string;
  name?: string;
  userId?: string;
  label?: string;
  tokenId?: string;
  superuser?: boolean;
  value?: string;
  slug?: string;
  project?: string;
  role?: string;
} {
  const user = args.includes('--user');
  const project = args.includes('--project');
  if (user && project) {
    console.error('[margo] cannot combine --user and --project; pick one.');
    process.exit(1);
  }
  return {
    scope: user ? 'user' : 'project',
    port: readValueFlag(args, '--port', 3001),
    cwd: readValueFlag(args, '--cwd', undefined),
    dataDir: readValueFlag(args, '--data-dir', undefined),
    email: readValueFlag(args, '--email', undefined),
    name: readValueFlag(args, '--name', undefined),
    userId: readValueFlag(args, '--user-id', undefined),
    label: readValueFlag(args, '--label', undefined),
    tokenId: readValueFlag(args, '--token-id', undefined),
    superuser: args.includes('--superuser'),
    value: readValueFlag(args, '--value', undefined),
    slug: readValueFlag(args, '--slug', undefined),
    project: readValueFlag(args, '--project', undefined),
    role: readValueFlag(args, '--role', undefined),
  };
}

// Tiny `--flag value` reader. Accepts `--name value` and `--name=value`.
// Number-typed callers pass a numeric default and we coerce; string callers
// (cwd) pass undefined to opt out of coercion.
function readValueFlag<D extends string | number | undefined>(
  args: string[],
  name: string,
  fallback: D,
): D {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === name && i + 1 < args.length) return coerce(args[i + 1], fallback);
    if (a.startsWith(`${name}=`)) return coerce(a.slice(name.length + 1), fallback);
  }
  return fallback;

  function coerce(raw: string, fb: D): D {
    if (typeof fb === 'number') {
      const n = Number(raw);
      return (Number.isFinite(n) ? n : fb) as D;
    }
    return raw as D;
  }
}

/**
 * Resolve the git repo root for `cwd`. Used for skill placement (Claude
 * Code only discovers project skills at `<git-root>/.claude/skills/`) and
 * to verify the user is inside a git repo at all — margo's comment-sync
 * model relies on git, so we refuse to operate outside one rather than
 * silently scaffold something that won't sync.
 */
export async function resolveGitRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', '--show-toplevel'], { cwd });
    const root = stdout.trim();
    if (!root) throw new Error('empty git rev-parse output');
    return root;
  } catch {
    console.error('[margo] not inside a git repository.');
    console.error('       margo stores comments as files synced by git — `cd` into a repo (or `git init`) and try again.');
    process.exit(1);
  }
}

/**
 * Walk up from `cwd` to find the nearest ancestor containing a `.margo/`
 * directory. Returns the *parent* (the project root where margo lives), or
 * `null` if none found. Used by `install-skill`, `update`, and `uninstall`
 * so they can be run from any subdirectory of a margo-enabled project.
 */
export async function findMargoDir(cwd: string): Promise<string | null> {
  let dir = path.resolve(cwd);
  // Stop at filesystem root: when dirname(dir) === dir we've walked past `/`.
  while (true) {
    if (await pathExists(path.join(dir, '.margo'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Drop `.margo/` in CWD — wherever the user ran `margo init` is where
 * the project root for margo lives. Mirrors how Vercel/Supabase/Prisma
 * place their per-project state. In a monorepo, run `init` once per app
 * you want margo on; each gets its own inbox.
 *
 * We still require a git repo (the comment-sync model needs it), but we
 * don't anchor to git root — that's what produced the cross-app inbox
 * bleed before.
 */
async function init(cwd: string, opts: { overwriteTemplates?: boolean } = {}): Promise<void> {
  // Verify a git repo exists above CWD; abort otherwise.
  await resolveGitRoot(cwd);

  // Warn (but proceed) if there's an existing `.margo/` higher up — the
  // user might have init'd at git root earlier and now be confused about
  // why a new init at the app level creates a separate inbox. They asked
  // for it; explain what they're getting.
  const existing = await findMargoDir(cwd);
  if (existing && path.resolve(existing) !== path.resolve(cwd)) {
    console.log(`[margo] note: existing .margo/ found at ${existing}`);
    console.log(`        this new inbox at ${cwd} will be separate (per-app).`);
    console.log(`        cd to ${existing} if you wanted to use the existing one.`);
  }

  const margoDir = path.join(cwd, '.margo');
  await fs.mkdir(path.join(margoDir, 'comments'), { recursive: true });

  await copyTemplate('config.json', path.join(margoDir, 'config.json'), opts.overwriteTemplates);
  await copyTemplate('CLAUDE.md', path.join(margoDir, 'CLAUDE.md'), opts.overwriteTemplates);
  await ensureGitkeep(path.join(margoDir, 'comments'));

  // Pick the first integration that matches the project. We don't try both —
  // a project that mixes Vite + Next.js is unusual enough to handle by hand.
  const framework = await detectFramework(cwd);
  if (framework === 'next') {
    await patchNextProject(cwd, opts.overwriteTemplates);
  } else {
    await patchViteConfig(cwd);
  }

  console.log('[margo] init complete.');
  console.log('       Review .margo/config.json (especially the roster) and run `npm run dev`.');
  await printSkillHint(cwd);
}

/**
 * Install the Claude Code integration: drop the `/margo` skill and add a
 * reference block to the repo's root `CLAUDE.md`. Separate from `init`
 * because not every user runs Claude Code, and because writing to
 * `~/.claude/` (scope=user) is a different blast radius than writing to
 * the repo. Matches the pattern other ecosystems use for AI-tool
 * integrations (Stripe, Sentry, Prisma all ship their MCP server as a
 * separate package/command from the SDK CLI).
 *
 * - scope=project (default): skill goes to `<repo>/.claude/skills/margo/SKILL.md`,
 *   gets committed with the repo. Good default for teams.
 * - scope=user: skill goes to `~/.claude/skills/margo/SKILL.md`, shared
 *   across every repo on this machine. Good for solo devs who want one
 *   copy of the skill across many margo-using projects.
 *
 * Either way, the root `CLAUDE.md` block is written — it points the AI at
 * `.margo/CLAUDE.md` for *this* repo, regardless of where the skill lives.
 */
async function installSkill(cwd: string, opts: { scope: 'project' | 'user' }): Promise<void> {
  // Find the project this skill belongs to: walk up to the nearest `.margo/`.
  // We don't accept "install the skill but there's no inbox to point at" —
  // the skill would error on every `/margo` invocation. Cheaper to surface
  // the ordering error here.
  const projectDir = await findMargoDir(cwd);
  if (!projectDir) {
    console.error('[margo] no .margo/ found in this directory or any parent — run `npx margo init` first.');
    process.exit(1);
  }

  // Skill placement:
  //   - project scope → git-root `.claude/skills/margo/`. Forced by Claude
  //     Code's discovery rule: it only picks up project skills at the
  //     workspace root. Putting the skill in `<project>/.claude/` instead
  //     would silently fail to register when `<project>` isn't git root.
  //   - user scope → `~/.claude/skills/margo/`. Shared across every repo
  //     on this machine; not committed.
  //
  // The reference block in CLAUDE.md goes next to `.margo/` (not git root),
  // so a monorepo with multiple apps gets per-app references instead of
  // one global one that mentions margo for apps that don't use it.
  const gitRoot = await resolveGitRoot(cwd);
  const skillDir = opts.scope === 'user'
    ? path.join(os.homedir(), '.claude', 'skills', 'margo')
    : path.join(gitRoot, '.claude', 'skills', 'margo');
  await fs.mkdir(skillDir, { recursive: true });
  await copyTemplate('claude-skill.md', path.join(skillDir, 'SKILL.md'), true);
  await migrateLegacySkillPath(gitRoot);
  await ensureRootClaudeBlock(projectDir);

  const where = opts.scope === 'user'
    ? '~/.claude/skills/margo/'
    : path.relative(cwd, path.join(gitRoot, '.claude', 'skills', 'margo')) + '/';
  console.log(`[margo] installed Claude Code skill at ${where}SKILL.md`);
  console.log(`       Added margo block to ${path.relative(cwd, path.join(projectDir, 'CLAUDE.md')) || 'CLAUDE.md'}.`);
  console.log('       Restart Claude Code or open the repo to pick up `/margo`.');
}

/**
 * Idempotent refresh of whichever artifacts already exist. We don't want
 * `update` to silently install new things — that turns it into a hidden
 * `init`. If only `.margo/` is installed, only `.margo/` gets refreshed;
 * the user runs `install-skill` separately when they want it.
 */
async function update(cwd: string): Promise<void> {
  const projectDir = await findMargoDir(cwd);
  if (!projectDir) {
    console.error('[margo] nothing installed in this directory or any parent — run `npx margo init` first.');
    process.exit(1);
  }
  await init(projectDir, { overwriteTemplates: true });

  // Refresh the skill only if it was already installed somewhere. We don't
  // want `update` to silently install new things — that turns it into a
  // hidden `install-skill`.
  const gitRoot = await resolveGitRoot(cwd);
  const projectSkill = path.join(gitRoot, '.claude', 'skills', 'margo', 'SKILL.md');
  const userSkill = path.join(os.homedir(), '.claude', 'skills', 'margo', 'SKILL.md');
  if (await pathExists(projectSkill)) {
    await installSkill(cwd, { scope: 'project' });
  } else if (await pathExists(userSkill)) {
    await installSkill(cwd, { scope: 'user' });
  }
}

async function uninstall(cwd: string): Promise<void> {
  const projectDir = await findMargoDir(cwd);
  if (projectDir) {
    await removeRootClaudeBlock(projectDir);
  }
  // Remove the project-scope skill if present. We intentionally do NOT
  // touch the user-scope skill (`~/.claude/skills/margo/`) — it's shared
  // across repos; uninstalling margo from one project shouldn't delete
  // it for the others.
  const gitRoot = await resolveGitRoot(cwd);
  const projectSkill = path.join(gitRoot, '.claude', 'skills', 'margo');
  if (await pathExists(projectSkill)) {
    await fs.rm(projectSkill, { recursive: true, force: true });
    console.log(`[margo] removed ${path.relative(cwd, projectSkill) || '.claude/skills/margo'}/`);
  }
  // We deliberately do NOT delete .margo/ — comment history may still be wanted.
  const margoRel = projectDir ? path.relative(cwd, path.join(projectDir, '.margo')) || '.margo' : '.margo';
  console.log(`[margo] removed CLAUDE.md block. ${margoRel}/ left in place.`);
  console.log(`       To remove fully: \`rm -r ${margoRel}\` and uninstall the package.`);
}

/**
 * After `init`, nudge users who look like Claude Code users toward
 * `install-skill`. We don't auto-install — it would surprise people and
 * write to `~/.claude/` without consent in the `--user` case.
 */
async function printSkillHint(cwd: string): Promise<void> {
  const projectClaude = await pathExists(path.join(cwd, '.claude'));
  const userClaude = await pathExists(path.join(os.homedir(), '.claude'));
  if (!projectClaude && !userClaude) return;
  console.log('');
  console.log('       Tip: run `npx margo install-skill` to add the Claude Code `/margo` skill.');
  console.log('       Use `--user` to install at `~/.claude/skills/` instead of committing it per-repo.');
}

/**
 * Older versions of `margo init` (≤ 0.0.6) wrote the Claude Code skill to
 * the flat path `.claude/skills/margo.md`. Claude Code only registers
 * skills from per-skill directories (`.claude/skills/<name>/SKILL.md`),
 * so the flat file silently fails to appear as a slash command. On every
 * init/update, sweep any stale flat file aside so `/margo` actually shows
 * up. Best-effort: errors are swallowed (the user might not have the old
 * file at all, or might have removed it manually).
 */
async function migrateLegacySkillPath(cwd: string): Promise<void> {
  const legacy = path.join(cwd, '.claude', 'skills', 'margo.md');
  try {
    await fs.access(legacy);
  } catch {
    return;
  }
  try {
    await fs.unlink(legacy);
    console.log('[margo] removed legacy .claude/skills/margo.md — superseded by .claude/skills/margo/SKILL.md');
  } catch {
    // ignore — user may have read-only filesystem or permissions issue
  }
}

async function copyTemplate(name: string, dest: string, overwrite = false): Promise<void> {
  let src: string | undefined;
  for (const candidate of TEMPLATE_CANDIDATES) {
    const full = path.join(candidate, name);
    try {
      await fs.access(full);
      src = full;
      break;
    } catch {
      // try next
    }
  }
  if (!src) throw new Error(`template ${name} not found in package`);
  if (!overwrite) {
    try {
      await fs.access(dest);
      return; // exists; preserve user customizations
    } catch {
      // doesn't exist; copy
    }
  }
  await fs.copyFile(src, dest);
}

async function ensureGitkeep(dir: string): Promise<void> {
  const f = path.join(dir, '.gitkeep');
  try { await fs.access(f); } catch { await fs.writeFile(f, ''); }
}

async function ensureRootClaudeBlock(cwd: string): Promise<void> {
  const file = path.join(cwd, 'CLAUDE.md');
  let existing = '';
  try {
    existing = await fs.readFile(file, 'utf8');
  } catch {
    existing = '# CLAUDE.md\n\nProject instructions for Claude Code.\n\n';
  }
  if (existing.includes(MARGO_BLOCK_START)) {
    // Replace existing block in place.
    const re = new RegExp(`${escapeRe(MARGO_BLOCK_START)}[\\s\\S]*?${escapeRe(MARGO_BLOCK_END)}`);
    existing = existing.replace(re, ROOT_CLAUDE_BLOCK);
  } else {
    existing = existing.trimEnd() + '\n\n' + ROOT_CLAUDE_BLOCK + '\n';
  }
  await fs.writeFile(file, existing, 'utf8');
}

async function removeRootClaudeBlock(cwd: string): Promise<void> {
  const file = path.join(cwd, 'CLAUDE.md');
  let existing: string;
  try { existing = await fs.readFile(file, 'utf8'); } catch { return; }
  const re = new RegExp(`\\n*${escapeRe(MARGO_BLOCK_START)}[\\s\\S]*?${escapeRe(MARGO_BLOCK_END)}\\n*`);
  const next = existing.replace(re, '\n');
  await fs.writeFile(file, next, 'utf8');
}

async function detectFramework(cwd: string): Promise<'vite' | 'next' | 'unknown'> {
  // Look at package.json deps + the on-disk shape. We trust the deps first;
  // the file checks are a fallback for unusual setups (e.g. monorepos that
  // hoist deps to a parent package.json).
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
  } catch { /* no package.json — neither framework */ }
  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const hasNextDep = !!allDeps['next'];
  const hasViteDep = !!allDeps['vite'];

  const hasAppDir = await pathExists(path.join(cwd, 'app'))
    || await pathExists(path.join(cwd, 'src', 'app'));
  const hasPagesDir = await pathExists(path.join(cwd, 'pages'))
    || await pathExists(path.join(cwd, 'src', 'pages'));
  const hasViteConfig = await pathExists(path.join(cwd, 'vite.config.ts'))
    || await pathExists(path.join(cwd, 'vite.config.js'))
    || await pathExists(path.join(cwd, 'vite.config.mjs'));

  if (hasNextDep || hasAppDir || hasPagesDir) return 'next';
  if (hasViteDep || hasViteConfig) return 'vite';
  return 'unknown';
}

// Next.js supports both `app/` and `src/app/`. Pick the one the project
// actually uses; if neither exists yet, default to `app`.
async function detectNextAppRoot(cwd: string): Promise<string> {
  if (await pathExists(path.join(cwd, 'src', 'app'))) return path.join('src', 'app');
  if (await pathExists(path.join(cwd, 'app'))) return 'app';
  if (await pathExists(path.join(cwd, 'src', 'pages'))) return path.join('src', 'app');
  return 'app';
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function patchNextProject(cwd: string, overwrite = false): Promise<void> {
  const appRoot = await detectNextAppRoot(cwd);

  // 1. Drop the catch-all Route Handler at <appRoot>/margo-runtime/[[...path]]/route.ts.
  //    The folder name has no leading underscore so it isn't private; the
  //    public URL stays /__margo/* via a rewrite in next.config.*.
  const routeDir = path.join(cwd, appRoot, 'margo-runtime', '[[...path]]');
  await fs.mkdir(routeDir, { recursive: true });
  const routeFile = path.join(routeDir, 'route.ts');
  if (overwrite || !(await pathExists(routeFile))) {
    await fs.writeFile(routeFile, NEXT_ROUTE_FILE, 'utf8');
  }

  // 2. Patch next.config.{ts,js,mjs} — add serverExternalPackages + rewrite.
  await patchNextConfig(cwd);

  // 3. Insert <MargoScript /> into <appRoot>/layout.tsx.
  await patchNextLayout(cwd, appRoot);
}

const NEXT_ROUTE_FILE = `// Catch-all Route Handler for margo's /__margo/* surface (App Router).
// All four methods point to the same dispatcher; it inspects path + method.
//
// Imported from 'margo-dev/next-server' (not 'margo-dev/next'). The umbrella
// re-exports MargoScript + withMargo only; pulling handlers through it would
// drag chokidar through Next's compiled bundle for callers that don't need
// the route handler.
import { handlers } from 'margo-dev/next-server';

export const { GET, POST, PATCH, DELETE } = handlers;

// Node runtime is required: handlers shell out to git and use chokidar.
export const runtime = 'nodejs';
// Never cache — comment writes and SSE streams must hit the live handler.
export const dynamic = 'force-dynamic';
`;

async function patchNextConfig(cwd: string): Promise<void> {
  // We use the withMargo() HOC instead of injecting raw config keys —
  // wrapping is the standard Next.js pattern (withMDX, withSentryConfig
  // etc.), reads as one obvious line, and composes safely with whatever
  // rewrites/externalPackages the user already has.
  const candidates = ['next.config.ts', 'next.config.mjs', 'next.config.js'];
  let target: string | undefined;
  for (const c of candidates) {
    if (await pathExists(path.join(cwd, c))) { target = path.join(cwd, c); break; }
  }
  if (!target) {
    console.log('[margo] no next.config.* found — add this to your config:');
    console.log("       import { withMargo } from 'margo-dev/next-config';");
    console.log('       export default withMargo(nextConfig);');
    return;
  }
  const original = await fs.readFile(target, 'utf8');
  if (original.includes('withMargo')) return;

  // Find the `export default <expr>;` we'll wrap, and the import section
  // we'll prepend our import to. Naive regexes — good enough for the
  // generated next.config.ts and most user-edited variants.
  const exportMatch = original.match(/export\s+default\s+([^;\n]+);?/);
  if (!exportMatch || exportMatch.index === undefined) {
    console.log(`[margo] could not auto-wrap ${target}.`);
    console.log("       Add: import { withMargo } from 'margo-dev/next-config';");
    console.log('       And change `export default nextConfig;` to `export default withMargo(nextConfig);`');
    return;
  }
  const exportExpr = exportMatch[1].trim();
  const wrappedExport = `export default withMargo(${exportExpr});`;

  // Insert our import after the last existing import line, or at the top
  // if there are none.
  const importStmt = `import { withMargo } from 'margo-dev/next-config';`;
  const importLines = [...original.matchAll(/^import .+;$/gm)];
  const lastImport = importLines[importLines.length - 1];
  let next: string;
  if (lastImport && lastImport.index !== undefined) {
    const end = lastImport.index + lastImport[0].length;
    next = original.slice(0, end) + `\n${importStmt}` + original.slice(end);
  } else {
    next = `${importStmt}\n${original}`;
  }
  // Replace the export — recompute index because we inserted text earlier.
  const newExportMatch = next.match(/export\s+default\s+([^;\n]+);?/);
  if (newExportMatch && newExportMatch.index !== undefined) {
    next = next.slice(0, newExportMatch.index) + wrappedExport + next.slice(newExportMatch.index + newExportMatch[0].length);
  }
  await fs.writeFile(target, next, 'utf8');
}

async function patchNextLayout(cwd: string, appRoot: string): Promise<void> {
  const exts = ['tsx', 'jsx', 'ts', 'js'];
  const candidates = exts.map((e) => path.join(appRoot, `layout.${e}`));
  let target: string | undefined;
  for (const c of candidates) {
    if (await pathExists(path.join(cwd, c))) { target = path.join(cwd, c); break; }
  }
  if (!target) {
    console.log(`[margo] no ${appRoot}/layout.* found — add manually to your root layout:`);
    console.log("       import { MargoScript } from 'margo-dev/next-client-script';");
    console.log('       <body>{children}<MargoScript /></body>');
    return;
  }
  const original = await fs.readFile(target, 'utf8');
  if (original.includes('margo-dev/next-client-script') || original.includes('MargoScript')) return;

  // Add the import after the last existing import line.
  const importLines = [...original.matchAll(/^import .+;$/gm)];
  const lastImport = importLines[importLines.length - 1];
  let next = original;
  // Use the dedicated -client-script subpath rather than the umbrella.
  // The umbrella works too (it re-exports MargoScript), but pinning the
  // subpath makes the intent explicit and gives Turbopack the simplest
  // possible resolution.
  const importStmt = `import { MargoScript } from 'margo-dev/next-client-script';`;
  if (lastImport && lastImport.index !== undefined) {
    const end = lastImport.index + lastImport[0].length;
    next = original.slice(0, end) + `\n${importStmt}` + original.slice(end);
  } else {
    next = `${importStmt}\n${original}`;
  }
  // Insert <MargoScript /> just before the closing </body>.
  if (next.includes('</body>')) {
    next = next.replace('</body>', '<MargoScript /></body>');
  } else {
    console.log(`[margo] inserted import into ${target}, but couldn't find </body> — add <MargoScript /> manually.`);
  }
  await fs.writeFile(target, next, 'utf8');
}

async function patchViteConfig(cwd: string): Promise<void> {
  // Look for vite.config.ts / .js / .mjs and add the margo() plugin if absent.
  // This is best-effort string-level patching; on failure we print a manual
  // instruction. AST patching is out of scope for v0 — too many config dialects.
  const candidates = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'];
  let target: string | undefined;
  for (const c of candidates) {
    const full = path.join(cwd, c);
    try { await fs.access(full); target = full; break; } catch { /* try next */ }
  }
  if (!target) {
    console.log('[margo] no vite.config.* found — add this manually if you use Vite:');
    console.log("       import margo from 'margo-dev';");
    console.log('       export default { plugins: [margo()] };');
    return;
  }
  const original = await fs.readFile(target, 'utf8');
  if (original.includes('margo-dev')) return; // already wired
  // Naive injection: prepend import, then attempt to add to first plugins: array.
  const importLine = `import margo from 'margo-dev';\n`;
  let next = importLine + original;
  if (/plugins\s*:\s*\[/.test(next)) {
    next = next.replace(/plugins\s*:\s*\[/, (m) => `${m}margo(), `);
  } else {
    console.log(`[margo] could not auto-add plugin to ${target}.`);
    console.log("       Add this to your config: plugins: [margo(), ...]");
    return;
  }
  await fs.writeFile(target, next, 'utf8');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Only run when this file is invoked directly (e.g. via the `margo` bin
// entry). Without the guard, importing helpers like `resolveGitRoot` from
// the test suite would re-execute `main()` and scaffold `.margo/` into
// whatever directory the test runner happens to be in.
//
// argv[1] is the symlink path when invoked via `node_modules/.bin/margo`;
// import.meta.url is the resolved real path. Compare realpaths so the
// symlink shape doesn't make the check silently false (which would have
// the process exit immediately with no output).
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    const realArg = fsSync.realpathSync(process.argv[1]);
    const realSelf = fsSync.realpathSync(url.fileURLToPath(import.meta.url));
    return realArg === realSelf;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[margo]', err);
    process.exit(1);
  });
}
