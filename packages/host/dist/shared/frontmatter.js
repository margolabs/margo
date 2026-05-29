import * as yaml from 'js-yaml';
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
export function parseComment(raw, path) {
    const match = raw.match(FRONTMATTER_RE);
    if (!match) {
        throw new Error(`Comment file ${path} is missing YAML frontmatter`);
    }
    const frontmatter = yaml.load(match[1]);
    const body = match[2];
    return { frontmatter, body, raw, path };
}
export function serializeComment(fm, body) {
    // Preserve key order matching the canonical example in the README.
    const ordered = {
        id: fm.id,
        type: fm.type,
        author: fm.author,
        ...(fm.authorName ? { authorName: fm.authorName } : {}),
        role: fm.role,
        branch: fm.branch,
        created: fm.created,
        status: fm.status,
        target: fm.target,
    };
    const yamlStr = yaml.dump(ordered, { lineWidth: 120, noRefs: true });
    const trimmedBody = body.endsWith('\n') ? body : body + '\n';
    return `---\n${yamlStr}---\n\n${trimmedBody}`;
}
export function appendReply(body, reply) {
    const header = reply.isAi
        ? `**ai-reply** — ${reply.aiModel ?? 'unknown-model'} — ${reply.timestamp}`
        : `**reply** — ${reply.author}${reply.role ? ` (${reply.role})` : ''} — ${reply.timestamp}`;
    const sep = body.endsWith('\n') ? '' : '\n';
    return `${body}${sep}\n---\n${header}\n\n${reply.body.trim()}\n`;
}
