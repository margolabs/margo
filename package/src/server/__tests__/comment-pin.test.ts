// Basic comment-pin functional tests — exercises the handler surface a
// margo pin goes through end-to-end:
//
//   create  → file lands in .margo/comments/<id>.md with parseable frontmatter,
//             and SSE fires a `created` event with the id.
//   list    → returns the comment we just created.
//   update  → reply appends to the body; status change rewrites frontmatter.
//   delete  → file is removed; SSE fires `deleted`; non-author is forbidden.
//
// Uses a real temp git repo (not mocked) so we catch breakage in the git
// integration — getAuthor / branch / commit / dirty all run for real. The
// handlers enqueue commit/push to a background queue; we don't await that
// (it'd require network for push), only the synchronous part the client sees.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createComment,
  deleteComment,
  listComments,
  updateComment,
  type HandlerContext,
  type SseClient,
} from '../handlers.js';
import { parseComment } from '../../shared/frontmatter.js';
import type { CreateCommentRequest, MargoConfig, Target } from '../../shared/types.js';

const TEST_AUTHOR_EMAIL = 'pin-tester@example.com';
const TEST_AUTHOR_NAME = 'Pin Tester';

function makeTarget(overrides: Partial<Target> = {}): Target {
  return {
    url: 'http://localhost:3000/dashboard',
    selector: 'main > section:nth-child(2) > h2',
    text: 'Revenue',
    role: 'heading',
    viewport: { w: 1440, h: 900 },
    coords: { x: 320, y: 240 },
    textAnchor: { phrase: 'Revenue', before: 'Q3 ', after: ' breakdown' },
    ...overrides,
  };
}

const DEFAULT_CONFIG: MargoConfig = {
  workspace: { name: 'test', appUrl: { dev: 'http://localhost:3000', preview: null } },
  roster: [],
  git: {
    autoCommit: false, // disable git side-effects from the queue — file ops are what we test
    autoPush: false,
    commitPrefix: 'margo:',
    branchPolicy: 'current',
    pullBeforePush: false,
  },
  ai: { implicitTaskTrigger: false, proactiveInboxSummaryAtSessionStart: false },
};

describe('comment-pin handlers — happy path', () => {
  let rootDir: string;
  let ctx: HandlerContext;
  let sseEvents: unknown[];

  beforeEach(async () => {
    // Fresh temp git repo per test — isolation matters since the handlers
    // touch a process-global background git queue, and we don't want one
    // test's queued op to race into another's working tree.
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'margo-test-'));
    execSync('git init -q -b main', { cwd: rootDir });
    execSync(`git config user.email ${TEST_AUTHOR_EMAIL}`, { cwd: rootDir });
    execSync(`git config user.name "${TEST_AUTHOR_NAME}"`, { cwd: rootDir });
    // commit something so HEAD exists — getCurrentCommit returns null on a
    // virgin repo, and we want a realistic created-against-commit field.
    await fs.writeFile(path.join(rootDir, 'README.md'), '# test\n', 'utf8');
    execSync('git add README.md && git commit -q -m initial', { cwd: rootDir });

    sseEvents = [];
    const sseClients = new Set<SseClient>();
    sseClients.add({ write: (payload) => sseEvents.push(payload) });
    ctx = {
      rootDir,
      commentsDir: path.join(rootDir, '.margo', 'comments'),
      config: DEFAULT_CONFIG,
      sseClients,
    };
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('create → writes a .md pin file with parseable frontmatter and fires SSE', async () => {
    const req: CreateCommentRequest = {
      type: 'task',
      body: "Revenue header is overlapping the chart legend on this breakpoint.",
      target: makeTarget(),
    };
    const { id } = await createComment(ctx, req);

    expect(id).toMatch(/^[a-zA-Z0-9-]+$/);

    const file = path.join(ctx.commentsDir, `${id}.md`);
    const raw = await fs.readFile(file, 'utf8');
    const parsed = parseComment(raw, file);

    expect(parsed.frontmatter.id).toBe(id);
    expect(parsed.frontmatter.type).toBe('task');
    expect(parsed.frontmatter.status).toBe('open');
    expect(parsed.frontmatter.author).toBe(TEST_AUTHOR_EMAIL);
    expect(parsed.frontmatter.authorName).toBe(TEST_AUTHOR_NAME);
    expect(parsed.frontmatter.branch).toBe('main');
    expect(parsed.frontmatter.target.url).toBe(req.target.url);
    expect(parsed.frontmatter.target.selector).toBe(req.target.selector);
    expect(parsed.frontmatter.target.textAnchor?.phrase).toBe('Revenue');
    // commit gets stamped onto the pin so viewers can detect drift.
    expect(parsed.frontmatter.target.commit).toMatch(/^[a-f0-9]+$/);
    expect(parsed.body.trim()).toBe(req.body);

    // SSE — handlers fire `created` synchronously after the file lands so
    // the overlay re-renders without waiting on git.
    const created = sseEvents.find((e) =>
      typeof e === 'string' && e.includes('"type":"created"') && e.includes(`"id":"${id}"`),
    );
    expect(created).toBeDefined();
  });

  it('list → returns all created comments', async () => {
    const { id: a } = await createComment(ctx, {
      type: 'task',
      body: 'first',
      target: makeTarget({ selector: '#a' }),
    });
    const { id: b } = await createComment(ctx, {
      type: 'discussion',
      body: 'second',
      target: makeTarget({ selector: '#b' }),
    });

    const { comments } = await listComments(ctx);
    const ids = comments.map((c) => c.frontmatter.id).sort();
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    expect(comments.find((c) => c.frontmatter.id === a)?.body.trim()).toBe('first');
    expect(comments.find((c) => c.frontmatter.id === b)?.frontmatter.type).toBe('discussion');
  });

  it('update → appending a reply preserves the original body and adds a reply block', async () => {
    const { id } = await createComment(ctx, {
      type: 'question',
      body: 'Why does this card use a different font weight than the others?',
      target: makeTarget(),
    });

    await updateComment(ctx, {
      id,
      patch: { reply: { body: 'Intentional — it carries the marketing emphasis.' } },
    });

    const raw = await fs.readFile(path.join(ctx.commentsDir, `${id}.md`), 'utf8');
    expect(raw).toContain('Why does this card use a different font weight');
    expect(raw).toContain('**reply**');
    expect(raw).toContain(TEST_AUTHOR_EMAIL);
    expect(raw).toContain('Intentional — it carries the marketing emphasis.');
  });

  it('update → status change rewrites frontmatter and fires SSE', async () => {
    const { id } = await createComment(ctx, {
      type: 'task',
      body: 'tweak the padding',
      target: makeTarget(),
    });
    sseEvents.length = 0;

    await updateComment(ctx, { id, patch: { status: 'resolved' } });

    const raw = await fs.readFile(path.join(ctx.commentsDir, `${id}.md`), 'utf8');
    const parsed = parseComment(raw, '');
    expect(parsed.frontmatter.status).toBe('resolved');
    const updated = sseEvents.find((e) =>
      typeof e === 'string' && e.includes('"type":"updated"') && e.includes(`"id":"${id}"`),
    );
    expect(updated).toBeDefined();
  });

  it('delete → removes the file and fires SSE; same-author is allowed', async () => {
    const { id } = await createComment(ctx, {
      type: 'task',
      body: 'remove me',
      target: makeTarget(),
    });
    const file = path.join(ctx.commentsDir, `${id}.md`);
    await expect(fs.access(file)).resolves.toBeUndefined();
    sseEvents.length = 0;

    await deleteComment(ctx, id);

    await expect(fs.access(file)).rejects.toThrow();
    const deleted = sseEvents.find((e) =>
      typeof e === 'string' && e.includes('"type":"deleted"') && e.includes(`"id":"${id}"`),
    );
    expect(deleted).toBeDefined();
  });

  it('delete → rejects when a different author tries to delete', async () => {
    const { id } = await createComment(ctx, {
      type: 'task',
      body: 'mine',
      target: makeTarget(),
    });
    // Change the repo's configured author — emulates a different teammate.
    execSync('git config user.email other-teammate@example.com', { cwd: rootDir });

    await expect(deleteComment(ctx, id)).rejects.toMatchObject({ status: 403 });
    // File should still exist — the rejection happened before any unlink.
    await expect(fs.access(path.join(ctx.commentsDir, `${id}.md`))).resolves.toBeUndefined();
  });

  it('delete → rejects an obviously malformed id without touching the filesystem', async () => {
    await expect(deleteComment(ctx, '../../etc/passwd')).rejects.toMatchObject({ status: 400 });
  });

  it('delete → returns 404 for an id whose file does not exist', async () => {
    await expect(deleteComment(ctx, 'ghost-id-123')).rejects.toMatchObject({ status: 404 });
  });
});
