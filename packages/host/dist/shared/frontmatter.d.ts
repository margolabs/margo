import type { Comment, CommentFrontmatter } from './types.js';
export declare function parseComment(raw: string, path: string): Comment;
export declare function serializeComment(fm: CommentFrontmatter, body: string): string;
export declare function appendReply(body: string, reply: {
    author: string;
    role?: string;
    timestamp: string;
    body: string;
    isAi?: boolean;
    aiModel?: string;
}): string;
