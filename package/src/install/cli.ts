#!/usr/bin/env node
// `npx @margo/dev <command>` — explicit init / update / uninstall.
// Idempotent. Designed to be invoked by Claude Code during the
// `claude "add margo to this project"` flow.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';

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

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'init';
  const cwd = process.cwd();
  switch (cmd) {
    case 'init':
      await init(cwd);
      break;
    case 'update':
      await init(cwd, { overwriteTemplates: true });
      break;
    case 'uninstall':
      await uninstall(cwd);
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      console.error('usage: margo <init|update|uninstall>');
      process.exit(1);
  }
}

async function init(cwd: string, opts: { overwriteTemplates?: boolean } = {}): Promise<void> {
  const margoDir = path.join(cwd, '.margo');
  const claudeSkillsDir = path.join(cwd, '.claude', 'skills');
  await fs.mkdir(path.join(margoDir, 'comments'), { recursive: true });
  await fs.mkdir(claudeSkillsDir, { recursive: true });

  await copyTemplate('config.json', path.join(margoDir, 'config.json'), opts.overwriteTemplates);
  await copyTemplate('CLAUDE.md', path.join(margoDir, 'CLAUDE.md'), opts.overwriteTemplates);
  await copyTemplate('claude-skill.md', path.join(claudeSkillsDir, 'margo.md'), opts.overwriteTemplates);
  await ensureGitkeep(path.join(margoDir, 'comments'));

  await ensureRootClaudeBlock(cwd);
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
}

async function uninstall(cwd: string): Promise<void> {
  await removeRootClaudeBlock(cwd);
  // We deliberately do NOT delete .margo/ — comment history may still be wanted.
  console.log('[margo] removed root CLAUDE.md block. .margo/ left in place.');
  console.log('       To remove fully: `rm -r .margo .claude/skills/margo.md` and uninstall the package.');
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

  const hasAppDir = await pathExists(path.join(cwd, 'app'));
  const hasPagesDir = await pathExists(path.join(cwd, 'pages'));
  const hasViteConfig = await pathExists(path.join(cwd, 'vite.config.ts'))
    || await pathExists(path.join(cwd, 'vite.config.js'))
    || await pathExists(path.join(cwd, 'vite.config.mjs'));

  if (hasNextDep || hasAppDir || hasPagesDir) return 'next';
  if (hasViteDep || hasViteConfig) return 'vite';
  return 'unknown';
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function patchNextProject(cwd: string, overwrite = false): Promise<void> {
  // 1. Drop the catch-all Route Handler at app/margo-runtime/[[...path]]/route.ts.
  //    The folder name has no leading underscore so it isn't private; the
  //    public URL stays /__margo/* via a rewrite in next.config.*.
  const routeDir = path.join(cwd, 'app', 'margo-runtime', '[[...path]]');
  await fs.mkdir(routeDir, { recursive: true });
  const routeFile = path.join(routeDir, 'route.ts');
  if (overwrite || !(await pathExists(routeFile))) {
    await fs.writeFile(routeFile, NEXT_ROUTE_FILE, 'utf8');
  }

  // 2. Patch next.config.{ts,js,mjs} — add serverExternalPackages + rewrite.
  await patchNextConfig(cwd);

  // 3. Insert <MargoScript /> into app/layout.tsx.
  await patchNextLayout(cwd);
}

const NEXT_ROUTE_FILE = `// Catch-all Route Handler for margo's /__margo/* surface (App Router).
// All four methods point to the same dispatcher; it inspects path + method.
import { handlers } from '@margo/dev/next';

export const { GET, POST, PATCH, DELETE } = handlers;

// Node runtime is required: handlers shell out to git and use chokidar.
export const runtime = 'nodejs';
// Never cache — comment writes and SSE streams must hit the live handler.
export const dynamic = 'force-dynamic';
`;

async function patchNextConfig(cwd: string): Promise<void> {
  const candidates = ['next.config.ts', 'next.config.mjs', 'next.config.js'];
  let target: string | undefined;
  for (const c of candidates) {
    if (await pathExists(path.join(cwd, c))) { target = path.join(cwd, c); break; }
  }
  if (!target) {
    console.log('[margo] no next.config.* found — add this to your config:');
    console.log("       serverExternalPackages: ['@margo/dev'],");
    console.log("       async rewrites() { return [{ source: '/__margo/:path*', destination: '/margo-runtime/:path*' }]; }");
    return;
  }
  const original = await fs.readFile(target, 'utf8');
  if (original.includes('@margo/dev') || original.includes('margo-runtime')) return; // already wired

  // Naive but readable insertion: find the first object literal `{` after a
  // `NextConfig =` (TS) or `module.exports =` (JS), and inject our keys.
  const anchor = original.match(/(?:NextConfig\s*=\s*|module\.exports\s*=\s*)\{/);
  if (!anchor || anchor.index === undefined) {
    console.log(`[margo] could not auto-patch ${target}.`);
    console.log("       Add: serverExternalPackages: ['@margo/dev'], and a rewrite from /__margo/:path* to /margo-runtime/:path*");
    return;
  }
  const insertAt = anchor.index + anchor[0].length;
  const inject = `\n  serverExternalPackages: ['@margo/dev'],\n  async rewrites() {\n    return [{ source: '/__margo/:path*', destination: '/margo-runtime/:path*' }];\n  },\n`;
  const next = original.slice(0, insertAt) + inject + original.slice(insertAt);
  await fs.writeFile(target, next, 'utf8');
}

async function patchNextLayout(cwd: string): Promise<void> {
  const candidates = ['app/layout.tsx', 'app/layout.jsx', 'app/layout.ts', 'app/layout.js'];
  let target: string | undefined;
  for (const c of candidates) {
    if (await pathExists(path.join(cwd, c))) { target = path.join(cwd, c); break; }
  }
  if (!target) {
    console.log('[margo] no app/layout.* found — add manually to your root layout:');
    console.log("       import { MargoScript } from '@margo/dev/next';");
    console.log('       <body>{children}<MargoScript /></body>');
    return;
  }
  const original = await fs.readFile(target, 'utf8');
  if (original.includes('@margo/dev/next') || original.includes('MargoScript')) return;

  // Add the import after the last existing import line.
  const importLines = [...original.matchAll(/^import .+;$/gm)];
  const lastImport = importLines[importLines.length - 1];
  let next = original;
  const importStmt = `import { MargoScript } from '@margo/dev/next';`;
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
    console.log("       import margo from '@margo/dev';");
    console.log('       export default { plugins: [margo()] };');
    return;
  }
  const original = await fs.readFile(target, 'utf8');
  if (original.includes('@margo/dev')) return; // already wired
  // Naive injection: prepend import, then attempt to add to first plugins: array.
  const importLine = `import margo from '@margo/dev';\n`;
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

main().catch((err) => {
  console.error('[margo]', err);
  process.exit(1);
});
