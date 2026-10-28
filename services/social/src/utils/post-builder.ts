import { sql, type Kysely } from 'kysely';
import type {
  Database,
  PostDto,
  PostImageDto,
  PostMentionDto,
  PostHashtagDto,
  ReactionCountDto,
  ReactionKind,
} from '../db/types.js';
import type { Env } from '../config/env.js';
import type { CallerIdentity } from './auth.js';
import { batchCheckCanSeePosts } from './visibility.js';
import { formatPublicProfile } from './profile.js';

export type RawPostRow = {
  id: string;
  author_id: string;
  body: string;
  visibility: 'PUBLIC' | 'FOLLOWERS';
  status: 'VISIBLE' | 'DELETED' | 'HIDDEN';
  video_id: string | null;
  reshare_of: string | null;
  media_count: number;
  reaction_count: string | number;
  comment_count: string | number;
  reshare_count: string | number;
  created_at: Date;
  edited_at: Date | string | null;
  created_at_cursor?: string;
};

/**
 * Hydrates an array of raw post rows into complete PostDto objects,
 * executing batched queries (O(1) database round-trips) to avoid N+1 problems.
 */
export async function hydratePostsBatch(
  db: Kysely<Database>,
  rawPosts: RawPostRow[],
  caller: CallerIdentity | { userId: string | null; isModeratorOrAdmin?: boolean },
  env: Env,
): Promise<PostDto[]> {
  if (rawPosts.length === 0) {
    return [];
  }

  // 1. Collect reshare_of IDs (one level deep)
  const reshareIds = Array.from(
    new Set(rawPosts.map((p) => p.reshare_of).filter((id): id is string => Boolean(id))),
  );

  const visibleResharedMap = new Map<string, RawPostRow>();
  if (reshareIds.length > 0) {
    const candidateReshares = await db
      .selectFrom('social.posts')
      .selectAll()
      .where('id', 'in', reshareIds)
      .execute();

    // Check visibility for all candidate original posts in a single batch
    const visibilityMap = await batchCheckCanSeePosts(
      db,
      caller,
      candidateReshares.map((rp) => ({
        id: rp.id,
        author_id: rp.author_id,
        visibility: rp.visibility,
        status: rp.status,
      })),
      { allowHiddenForMods: false }, // In feeds and reshares, hidden originals are unavailable
    );

    for (const rp of candidateReshares) {
      if (visibilityMap.get(rp.id)) {
        visibleResharedMap.set(rp.id, rp as RawPostRow);
      }
    }
  }

  // Combine all post rows that need auxiliary data (base posts + visible reshared originals)
  const allPostRows = [...rawPosts, ...Array.from(visibleResharedMap.values())];
  const allPostIds = Array.from(new Set(allPostRows.map((p) => p.id)));
  const allAuthorIds = Array.from(new Set(allPostRows.map((p) => p.author_id)));
  const allVideoIds = Array.from(
    new Set(allPostRows.map((p) => p.video_id).filter((id): id is string => Boolean(id))),
  );

  // 2. Parallel batched queries
  const [
    authorProfiles,
    mediaRows,
    hashtagRows,
    mentionRows,
    reactionCountRows,
    myReactionRows,
    videoRows,
  ] = await Promise.all([
    // Authors
    db
      .selectFrom('auth.public_profiles')
      .select(['id', 'handle', 'display_name', 'avatar_key', 'is_private'])
      .where('id', 'in', allAuthorIds)
      .execute(),

    // Media
    db
      .selectFrom('social.post_media')
      .selectAll()
      .where('post_id', 'in', allPostIds)
      .orderBy('position', 'asc')
      .execute(),

    // Hashtags
    db
      .selectFrom('social.post_hashtags')
      .select(['post_id', 'tag', 'slug'])
      .where('post_id', 'in', allPostIds)
      .execute(),

    // Mentions (joined with auth.public_profiles to return current handle)
    db
      .selectFrom('social.post_mentions as pm')
      .innerJoin('auth.public_profiles as p', 'p.id', 'pm.user_id')
      .select(['pm.post_id', 'pm.user_id', 'p.handle'])
      .where('pm.post_id', 'in', allPostIds)
      .execute(),

    // Top reactions (counts per post and reaction)
    sql<{ post_id: string; reaction: ReactionKind; count: number }>`
      SELECT post_id, reaction, count(*)::int AS count
      FROM social.post_reactions
      WHERE post_id = ANY(${sql.val(allPostIds)}::uuid[])
      GROUP BY post_id, reaction
      ORDER BY count DESC, reaction ASC
    `.execute(db),

    // Caller's reactions
    caller.userId
      ? db
          .selectFrom('social.post_reactions')
          .select(['post_id', 'reaction'])
          .where('user_id', '=', caller.userId)
          .where('post_id', 'in', allPostIds)
          .execute()
      : Promise.resolve([]),

    // Embedded video playability check
    allVideoIds.length > 0
      ? db
          .selectFrom('social.videos')
          .select(['id', 'owner_id', 'hidden', 'visibility'])
          .where('id', 'in', allVideoIds)
          .execute()
      : Promise.resolve([]),
  ]);

  // 3. Assemble auxiliary lookups
  const baseUrl = env.MEDIA_BASE_URL.replace(/\/+$/, '');

  const authorMap = new Map<string, ReturnType<typeof formatPublicProfile>>();
  for (const prof of authorProfiles) {
    authorMap.set(prof.id, formatPublicProfile(prof, env.MEDIA_BASE_URL));
  }

  const mediaMap = new Map<string, PostImageDto[]>();
  for (const m of mediaRows) {
    const list = mediaMap.get(m.post_id) ?? [];
    list.push({
      id: m.image_id,
      url: `${baseUrl}/${m.image_key.replace(/^\/+/, '')}`,
      thumb_url: `${baseUrl}/${m.thumb_key.replace(/^\/+/, '')}`,
      width: m.width,
      height: m.height,
    });
    mediaMap.set(m.post_id, list);
  }

  const hashtagMap = new Map<string, PostHashtagDto[]>();
  for (const h of hashtagRows) {
    const list = hashtagMap.get(h.post_id) ?? [];
    list.push({ tag: h.tag, slug: h.slug });
    hashtagMap.set(h.post_id, list);
  }

  const mentionMap = new Map<string, PostMentionDto[]>();
  for (const m of mentionRows) {
    const list = mentionMap.get(m.post_id) ?? [];
    list.push({ user_id: m.user_id, handle: m.handle });
    mentionMap.set(m.post_id, list);
  }

  const topReactionsMap = new Map<string, ReactionCountDto[]>();
  for (const r of reactionCountRows.rows) {
    const list = topReactionsMap.get(r.post_id) ?? [];
    if (list.length < 3) {
      list.push({ reaction: r.reaction, count: Number(r.count) });
      topReactionsMap.set(r.post_id, list);
    }
  }

  const myReactionMap = new Map<string, ReactionKind>();
  for (const r of myReactionRows) {
    myReactionMap.set(r.post_id, r.reaction);
  }

  // Playable video IDs (PUBLIC/UNLISTED and not hidden, or caller owns it)
  const playableVideoIds = new Set<string>();
  for (const v of videoRows) {
    if (
      !v.hidden &&
      (v.visibility !== 'PRIVATE' || (caller.userId && v.owner_id === caller.userId))
    ) {
      playableVideoIds.add(v.id);
    }
  }

  // 4. Assemble DTO function
  const assemblePost = (row: RawPostRow, includeReshare: boolean): PostDto => {
    const isAuthor = Boolean(caller.userId && caller.userId === row.author_id);
    const canEdit = isAuthor && row.status === 'VISIBLE';
    const canDelete = isAuthor || Boolean(caller.isModeratorOrAdmin);

    const videoId = row.video_id && playableVideoIds.has(row.video_id) ? row.video_id : null;

    let resharedPost: PostDto | null = null;
    let reshareUnavailable = false;

    if (includeReshare && row.reshare_of) {
      const orig = visibleResharedMap.get(row.reshare_of);
      if (orig) {
        resharedPost = assemblePost(orig, false);
      } else {
        reshareUnavailable = true;
      }
    }

    const createdAtStr =
      row.created_at_cursor ||
      (row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString());

    const editedAtStr = row.edited_at
      ? row.edited_at instanceof Date
        ? row.edited_at.toISOString()
        : new Date(row.edited_at).toISOString()
      : null;

    return {
      id: row.id,
      author: authorMap.get(row.author_id) ?? null,
      body: row.status === 'DELETED' ? '' : row.body,
      visibility: row.visibility,
      status: row.status,
      images: row.status === 'DELETED' ? [] : (mediaMap.get(row.id) ?? []),
      video_id: row.status === 'DELETED' ? null : videoId,
      reshare_of: row.reshare_of,
      reshared_post: resharedPost,
      reshare_unavailable: reshareUnavailable,
      mentions: row.status === 'DELETED' ? [] : (mentionMap.get(row.id) ?? []),
      hashtags: row.status === 'DELETED' ? [] : (hashtagMap.get(row.id) ?? []),
      reaction_count: Number(row.reaction_count || 0),
      top_reactions: topReactionsMap.get(row.id) ?? [],
      my_reaction: myReactionMap.get(row.id) ?? null,
      comment_count: Number(row.comment_count || 0),
      reshare_count: Number(row.reshare_count || 0),
      created_at: createdAtStr,
      edited_at: editedAtStr,
      can_edit: canEdit,
      can_delete: canDelete,
    };
  };

  return rawPosts.map((p) => assemblePost(p, true));
}
