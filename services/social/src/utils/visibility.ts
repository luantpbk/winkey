import { sql, type Kysely } from 'kysely';
import type { Database, PostVisibility, PostStatus } from '../db/types.js';
import type { CallerIdentity } from './auth.js';
import { isBlockedEitherWay } from './blocks.js';

export interface PostVisibilityTarget {
  id: string;
  author_id: string;
  visibility: PostVisibility;
  status: PostStatus;
}

export interface CanSeePostOptions {
  allowHiddenForMods?: boolean;
}

/**
 * Checks whether a viewer can see a given post.
 * Rules per ADR-049 and social.v1.yaml:
 * 1. Post status = 'VISIBLE' (moderator/admin also sees 'HIDDEN' when allowHiddenForMods is true).
 * 2. Author has an active profile (auth.public_profiles).
 * 3. Viewer is author, OR
 *    (post visibility = 'PUBLIC' AND author's profile is_private = false), OR
 *    viewer has a row in social.subscriptions to the author.
 * 4. No block either way between viewer and author.
 */
export async function canSeePost(
  db: Kysely<Database>,
  caller: CallerIdentity | { userId: string | null; isModeratorOrAdmin?: boolean },
  post: PostVisibilityTarget,
  options: CanSeePostOptions = { allowHiddenForMods: true },
): Promise<boolean> {
  const isMod = !!caller.isModeratorOrAdmin;

  if (post.status === 'DELETED') {
    return false;
  }

  if (post.status === 'HIDDEN') {
    if (!isMod || options.allowHiddenForMods === false) {
      return false;
    }
  } else if (post.status !== 'VISIBLE') {
    return false;
  }

  // Author must have an active profile
  const profile = await db
    .selectFrom('auth.public_profiles')
    .select(['id', 'is_private'])
    .where('id', '=', post.author_id)
    .executeTakeFirst();

  if (!profile) {
    return false;
  }

  // Author always sees their own post
  if (caller.userId && caller.userId === post.author_id) {
    return true;
  }

  // Check block relationship
  if (caller.userId) {
    const blocked = await isBlockedEitherWay(db, caller.userId, post.author_id);
    if (blocked) {
      return false;
    }
  }

  // If public post and author is not private
  const isPrivateAccount = !!profile.is_private;
  if (post.visibility === 'PUBLIC' && !isPrivateAccount) {
    return true;
  }

  // If FOLLOWERS post or private account, viewer must be an approved subscriber
  if (!caller.userId) {
    return false;
  }

  const sub = await db
    .selectFrom('social.subscriptions')
    .select(sql`1`.as('sub'))
    .where('subscriber_id', '=', caller.userId)
    .where('channel_id', '=', post.author_id)
    .executeTakeFirst();

  return !!sub;
}
