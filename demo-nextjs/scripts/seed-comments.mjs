#!/usr/bin/env node
// Stress-test seeder: generate N margo comments across demo routes.
//
//   node scripts/seed-comments.mjs                  # default 100, append
//   node scripts/seed-comments.mjs 500              # 500 comments
//   node scripts/seed-comments.mjs 200 --clean      # wipe prior seeded comments first
//   node scripts/seed-comments.mjs 300 --route=/pricing  # all on one route
//
// Seeded comments are identified by author=perf-seeder@margo.dev so --clean
// can remove them without touching real comments.

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMENTS_DIR = join(__dirname, '..', '.margo', 'comments');
const SEED_AUTHOR = 'perf-seeder@margo.dev';

const ROUTES = [
  {
    url: '/',
    role: 'main',
    selectors: [
      'main:nth-of-type(1)',
      'main:nth-of-type(1) > section:nth-of-type(1)',
      'main:nth-of-type(1) > section:nth-of-type(2)',
      'nav:nth-of-type(1)',
    ],
  },
  {
    url: '/features',
    role: 'section',
    selectors: [
      'main:nth-of-type(1) > section:nth-of-type(1)',
      'main:nth-of-type(1) > section:nth-of-type(2)',
      'main:nth-of-type(1) article:nth-of-type(1)',
      'main:nth-of-type(1) article:nth-of-type(2)',
    ],
  },
  {
    url: '/pricing',
    role: 'article',
    selectors: [
      'main:nth-of-type(1) > section:nth-of-type(1) > article:nth-of-type(1)',
      'main:nth-of-type(1) > section:nth-of-type(1) > article:nth-of-type(2)',
      'main:nth-of-type(1) > section:nth-of-type(1) > article:nth-of-type(3)',
      'main:nth-of-type(1) [data-testid="cta-primary"]',
    ],
  },
  {
    url: '/contact',
    role: 'form',
    selectors: [
      'main:nth-of-type(1) > form:nth-of-type(1)',
      'main:nth-of-type(1) > form input:nth-of-type(1)',
      'main:nth-of-type(1) > form textarea:nth-of-type(1)',
    ],
  },
  {
    url: '/scroll-test',
    role: 'section',
    selectors: [
      'main:nth-of-type(1) > section:nth-of-type(1)',
      'main:nth-of-type(1) > section:nth-of-type(2)',
      'main:nth-of-type(1) > section:nth-of-type(3)',
    ],
  },
  {
    url: '/tabs-test',
    role: 'tab',
    selectors: [
      'main:nth-of-type(1) [role="tab"]:nth-of-type(1)',
      'main:nth-of-type(1) [role="tabpanel"]:nth-of-type(1)',
    ],
  },
];

const TYPES = ['task', 'question', 'discussion'];
const OPEN_STATUSES = ['open', 'open', 'open', 'in-progress', 'ready-for-review'];

function parseArgs() {
  const args = process.argv.slice(2);
  const count = parseInt(args.find((a) => /^\d+$/.test(a)) ?? '100', 10);
  const clean = args.includes('--clean');
  const routeArg = args.find((a) => a.startsWith('--route='))?.split('=')[1];
  return { count, clean, onlyRoute: routeArg };
}

function genId() {
  return 'c-' + randomBytes(3).toString('hex');
}

function isSeeded(path) {
  try {
    return readFileSync(path, 'utf-8').includes(`author: ${SEED_AUTHOR}`);
  } catch {
    return false;
  }
}

function cleanSeeded() {
  let n = 0;
  for (const f of readdirSync(COMMENTS_DIR)) {
    if (!f.endsWith('.md')) continue;
    const path = join(COMMENTS_DIR, f);
    if (isSeeded(path)) {
      unlinkSync(path);
      n++;
    }
  }
  console.log(`removed ${n} previously seeded comments`);
}

function build(i, routes) {
  const route = routes[i % routes.length];
  const selector = route.selectors[i % route.selectors.length];
  const id = genId();
  const type = TYPES[i % TYPES.length];
  const status = i % 6 === 0 ? 'resolved' : OPEN_STATUSES[i % OPEN_STATUSES.length];
  const x = 80 + ((i * 47) % 1280);
  const y = 100 + ((i * 73) % 680);
  const created = new Date(Date.now() - i * 60000).toISOString();
  const body = `Perf seed #${i + 1} on ${route.url}. Lorem ipsum placeholder so the panel has body content to layout.`;

  const md = `---
id: ${id}
type: ${type}
author: ${SEED_AUTHOR}
authorName: Perf Seeder
branch: main
created: '${created}'
status: ${status}
target:
  url: ${route.url}
  selector: ${selector}
  text: Sample anchor text for seeded comment ${i + 1}
  role: ${route.role}
  viewport:
    w: 1512
    h: 827
  coords:
    x: ${x}
    'y': ${y}
---

${body}
`;
  return { id, md };
}

function main() {
  const { count, clean, onlyRoute } = parseArgs();
  mkdirSync(COMMENTS_DIR, { recursive: true });
  if (clean) cleanSeeded();

  const routes = onlyRoute ? ROUTES.filter((r) => r.url === onlyRoute) : ROUTES;
  if (routes.length === 0) {
    console.error(`no route matches --route=${onlyRoute}`);
    process.exit(1);
  }

  for (let i = 0; i < count; i++) {
    const { id, md } = build(i, routes);
    writeFileSync(join(COMMENTS_DIR, `${id}.md`), md);
  }
  const scope = onlyRoute ? ` on ${onlyRoute}` : ` across ${routes.length} routes`;
  console.log(`seeded ${count} comments${scope} in ${COMMENTS_DIR}`);
}

main();
