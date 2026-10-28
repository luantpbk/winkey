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
 * Batched visibility check for multiple posts, eliminating N+1 queries.
 * Evaluates visibility rules across candidate posts in O(1) database round-trips:
 * 1. Post status = 'VISIBLE' (or 'HIDDEN' when viewer is moderator/admin and allowHiddenForMods is true).
 * 2. Author has an active profile (auth.public_profiles).
 * 3. Viewer is author, OR
 *    (post visibility = 'PUBLIC' AND author's profile is_private = false), OR
 *    viewer has an active subscription to the author (social.subscriptions).
 * 4. No bidirectional block between viewer and author (social.blocks).
 */
export async function batchCheckCanSeePosts(
  db: Kysely<Database>,
  caller:
    CallerIdentity | { userId: string | null; isModeratorOrAdmin?: boolean; roles?: string[] },
  posts: PostVisibilityTarget[],
  options: CanSeePostOptions = { allowHiddenForMods: true },
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (posts.length === 0) {
    return result;
  }

  const isMod =
    Boolean(caller.isModeratorOrAdmin) ||
    Boolean(caller.roles?.includes('moderator')) ||
    Boolean(caller.roles?.includes('admin'));
  const allowHidden = Boolean(options.allowHiddenForMods) && isMod;

  // Step 1: Filter out inactive or unauthorized statuses immediately
  const activeCandidates = posts.filter((p) => {
    if (p.status === 'DELETED') {
      result.set(p.id, false);
      return false;
    }
    if (p.status === 'HIDDEN') {
      if (!allowHidden) {
        result.set(p.id, false);
        return false;
      }
    } else if (p.status !== 'VISIBLE') {
      result.set(p.id, false);
      return false;
    }
    return true;
  });

  if (activeCandidates.length === 0) {
    return result;
  }

  const allAuthorIds = Array.from(new Set(activeCandidates.map((p) => p.author_id)));
  const otherAuthorIds = caller.userId
    ? allAuthorIds.filter((id) => id !== caller.userId)
    : allAuthorIds;

  // Step 2: Fetch profiles and bidirectional blocks in parallel
  const [profiles, blockedRows] = await Promise.all([
    db
      .selectFrom('auth.public_profiles')
      .select(['id', 'is_private'])
      .where('id', 'in', allAuthorIds)
      .execute(),

    caller.userId && otherAuthorIds.length > 0
      ? db
          .selectFrom('social.blocks')
          .select(['blocker_id', 'blocked_id'])
          .where((eb) =>
            eb.or([
              eb.and([
                eb('blocker_id', '=', caller.userId!),
                eb('blocked_id', 'in', otherAuthorIds),
              ]),
              eb.and([
                eb('blocker_id', 'in', otherAuthorIds),
                eb('blocked_id', '=', caller.userId!),
              ]),
            ]),
          )
          .execute()
      : Promise.resolve([]),
  ]);

  const profileMap = new Map(profiles.map((pr) => [pr.id, pr]));
  const blockedAuthorIds = new Set<string>();
  for (const b of blockedRows) {
    blockedAuthorIds.add(b.blocker_id === caller.userId ? b.blocked_id : b.blocker_id);
  }

  // Step 3: Only check subscriptions for authors requiring follow (private accounts or FOLLOWERS posts)
  const authorsNeedingSubCheck = new Set<string>();
  if (caller.userId) {
    for (const p of activeCandidates) {
      if (p.author_id === caller.userId || blockedAuthorIds.has(p.author_id)) {
        continue;
      }
      const prof = profileMap.get(p.author_id);
      if (!prof) continue;
      if (prof.is_private || p.visibility === 'FOLLOWERS') {
        authorsNeedingSubCheck.add(p.author_id);
      }
    }
  }

  const subscribedAuthorIds = new Set<string>();
  if (caller.userId && authorsNeedingSubCheck.size > 0) {
    const subRows = await db
      .selectFrom('social.subscriptions')
      .select('channel_id')
      .where('subscriber_id', '=', caller.userId)
      .where('channel_id', 'in', Array.from(authorsNeedingSubCheck))
      .execute();

    for (const s of subRows) {
      subscribedAuthorIds.add(s.channel_id);
    }
  }

  // Step 4: Evaluate visibility in memory
  for (const post of activeCandidates) {
    const prof = profileMap.get(post.author_id);
    if (!prof) {
      result.set(post.id, false);
      continue;
    }

    // Author always sees own active post
    if (caller.userId && caller.userId === post.author_id) {
      result.set(post.id, true);
      continue;
    }

    // Blocked in either direction -> hidden
    if (blockedAuthorIds.has(post.author_id)) {
      result.set(post.id, false);
      continue;
    }

    const isSubscribed = subscribedAuthorIds.has(post.author_id);

    // Private account requires active subscription
    if (prof.is_private && !isSubscribed) {
      result.set(post.id, false);
      continue;
    }

    // Post-level visibility
    if (post.visibility === 'PUBLIC') {
      result.set(post.id, true);
    } else if (post.visibility === 'FOLLOWERS') {
      result.set(post.id, isSubscribed);
    } else {
      result.set(post.id, false);
    }
  }

  return result;
}

/**
 * Checks whether a viewer can see a given post.
 * Delegates to batchCheckCanSeePosts to maintain a single source of truth.
 */
export async function canSeePost(
  db: Kysely<Database>,
  caller:
    CallerIdentity | { userId: string | null; isModeratorOrAdmin?: boolean; roles?: string[] },
  post: PostVisibilityTarget,
  options: CanSeePostOptions = { allowHiddenForMods: true },
): Promise<boolean> {
  const map = await batchCheckCanSeePosts(db, caller, [post], options);
  return map.get(post.id) ?? false;
}
