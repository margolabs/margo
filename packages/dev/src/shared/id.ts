// Stable, short, unique-enough comment IDs.
// Format: c-<6 hex chars>. Collision probability is negligible at expected
// scale (small product team writing dozens of comments per project).

import { randomBytes } from 'node:crypto';

export function newCommentId(): string {
  return `c-${randomBytes(3).toString('hex')}`;
}
