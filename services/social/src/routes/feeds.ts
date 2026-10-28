import type { FastifyPluginAsync } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type {
  Database,
  PostPageDto,
  TrendingHashtagsDto,
  TrendingHashtagDto,
} from '../db/types.js';
import type { Env } from '../config/env.js';
import { ProblemError } from '../errors/problem.js';
import { getCaller, requireAuth, isValidUuid } from '../utils/auth.js';
import { encodeCursor, decodeCursor } from '../utils/pagination.js';
import { hydratePostsBatch, type RawPostRow } from '../utils/post-builder.js';
import { isBlockedEitherWay } from '../utils/blocks.js';
import type { Redis } from 'ioredis';

export interface FeedsRouteOptions {
  db: Kysely<Database>;
  env: Env;
  redis?: Redis | null;
}

interface KeysetCursor {
  created_at: string;
  id: string;
}

interface ExploreCursor {
  s: number;
  id: string;
  ts: number;
}

export const feedsRoute: FastifyPluginAsync<FeedsRouteOptions> = async (
  fastify,
  { db, env, redis },
) => {
  // 1. Following Feed: "Đang theo dõi"
  fastify.get<{
    Querystring: { cursor?: string; limit?: string };
  }>('/v1/feed/following', async (request, reply) => {
    const caller = requireAuth(request);

    const limitNum = Math.min(100, Math.max(1, parseInt(request.query.limit || '24', 10) || 24));
    const cursor = request.query.cursor;

    // Cache the first page (no cursor) in Valkey for 30 seconds
    const cacheKey = `social:feed:following:${caller.userId}:first_page:${limitNum}`;
    if (!cursor && redis) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          reply.header('Cache-Control', 'private, max-age=30');
          return reply.status(200).send(JSON.parse(cached));
        }
      } catch {
        // Ignore cache lookup errors
      }
    }

    let cursorData: KeysetCursor | null = null;
    if (cursor) {
      cursorData = decodeCursor<KeysetCursor>(cursor);
      if (
        !cursorData ||
        !isValidUuid(cursorData.id) ||
        !cursorData.created_at ||
        isNaN(Date.parse(cursorData.created_at))
      ) {
        throw ProblemError.badRequest('Invalid pagination cursor', undefined, 'INVALID_CURSOR');
      }
    }

    // Authors = caller ∪ subscriptions, minus blocks and mutes
    const followedAuthors = await sql<{ author_id: string }>`
      SELECT channel_id AS author_id
      FROM social.subscriptions
      WHERE subscriber_id = ${caller.userId}::uuid
      UNION ALL
      SELECT ${caller.userId}::uuid AS author_id
    `.execute(db);

    const authorIds = followedAuthors.rows.map((r) => r.author_id);

    // Filter out blocked and muted authors
    const excludedRows = await sql<{ user_id: string }>`
      SELECT blocked_id AS user_id FROM social.blocks WHERE blocker_id = ${caller.userId}::uuid
      UNION
      SELECT blocker_id AS user_id FROM social.blocks WHERE blocked_id = ${caller.userId}::uuid
      UNION
      SELECT muted_id AS user_id FROM social.mutes WHERE muter_id = ${caller.userId}::uuid
    `.execute(db);

    const excludedSet = new Set(excludedRows.rows.map((r) => r.user_id));
    const eligibleAuthorIds = Array.from(new Set(authorIds.filter((id) => !excludedSet.has(id))));

    if (eligibleAuthorIds.length === 0) {
      const emptyPage: PostPageDto = { items: [], next_cursor: null };
      return reply.status(200).send(emptyPage);
    }

    const pageSize = limitNum + 1;
    const cursorClause = cursorData
      ? sql`AND (p_inner.created_at, p_inner.id) < (${cursorData.created_at}::timestamptz, ${cursorData.id}::uuid)`
      : sql``;

    let rows: (RawPostRow & { created_at_cursor?: string })[];

    if (eligibleAuthorIds.length === 1) {
      const singleAuthorId = eligibleAuthorIds[0];
      const result = await sql<RawPostRow & { created_at_cursor: string }>`
        SELECT p_inner.*,
               to_char(p_inner.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
        FROM social.posts AS p_inner
        WHERE p_inner.author_id = ${singleAuthorId}::uuid
          AND p_inner.status = 'VISIBLE'
          ${cursorClause}
        ORDER BY p_inner.created_at DESC, p_inner.id DESC
        LIMIT ${pageSize}
      `.execute(db);
      rows = result.rows;
    } else {
      const result = await sql<RawPostRow & { created_at_cursor: string }>`
        SELECT p.*,
               to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
        FROM unnest(${eligibleAuthorIds}::uuid[]) AS a(id)
        CROSS JOIN LATERAL (
          SELECT p_inner.*
          FROM social.posts AS p_inner
          WHERE p_inner.author_id = a.id
            AND p_inner.status = 'VISIBLE'
            ${cursorClause}
          ORDER BY p_inner.created_at DESC, p_inner.id DESC
          LIMIT ${pageSize}
        ) p
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ${pageSize}
      `.execute(db);
      rows = result.rows;
    }

    const hasMore = rows.length > limitNum;
    const pageRows = hasMore ? rows.slice(0, limitNum) : rows;

    const items = await hydratePostsBatch(db, pageRows as RawPostRow[], caller, env);

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      const cursorCreatedAt =
        (last as { created_at_cursor?: string }).created_at_cursor ||
        new Date(last.created_at).toISOString();
      nextCursor = encodeCursor<KeysetCursor>({
        created_at: cursorCreatedAt,
        id: last.id,
      });
    }

    const response: PostPageDto = {
      items,
      next_cursor: nextCursor,
    };

    if (!cursor && redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(response), 'EX', 30);
      } catch {
        // Ignore cache set errors
      }
    }

    return reply.status(200).send(response);
  });

  // 2. Explore Feed: "Khám phá"
  fastify.get<{
    Querystring: { cursor?: string; limit?: string };
  }>('/v1/feed/explore', async (request, reply) => {
    const caller = getCaller(request);
    const limitNum = Math.min(100, Math.max(1, parseInt(request.query.limit || '24', 10) || 24));
    const cursorStr = request.query.cursor;

    // Check latest snapshot timestamp
    const snapshotRow = await sql<{ max_ts: Date }>`
      SELECT max(computed_at) AS max_ts FROM social.post_scores
    `.execute(db);

    const currentSnapshotTs = snapshotRow.rows[0]?.max_ts
      ? new Date(snapshotRow.rows[0].max_ts).getTime()
      : 0;

    let cursorData: ExploreCursor | null = null;
    if (cursorStr) {
      cursorData = decodeCursor<ExploreCursor>(cursorStr);
      if (
        !cursorData ||
        typeof cursorData.s !== 'number' ||
        !isValidUuid(cursorData.id) ||
        typeof cursorData.ts !== 'number'
      ) {
        throw ProblemError.badRequest('Invalid pagination cursor', undefined, 'INVALID_CURSOR');
      }

      // Check if cursor snapshot has expired (snapshot changed)
      if (currentSnapshotTs > 0 && cursorData.ts < currentSnapshotTs) {
        throw ProblemError.badRequest(
          'Explore feed snapshot has expired, please refresh',
          undefined,
          'CURSOR_EXPIRED',
        );
      }
    }

    // Query reads from post_scores using index post_scores_rank (score DESC, post_id DESC)
    // Joined with posts on p.id = ps.post_id (PK lookup)
    let query = db
      .selectFrom('social.post_scores as ps')
      .innerJoin('social.posts as p', 'p.id', 'ps.post_id')
      .selectAll('p')
      .select([
        'ps.score',
        'ps.computed_at',
        sql<string>`to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'created_at_cursor',
        ),
      ])
      .where('p.status', '=', 'VISIBLE')
      .where('p.visibility', '=', 'PUBLIC');

    // Filter out blocks and mutes for signed-in viewer
    if (caller.userId) {
      query = query
        .where(
          sql<boolean>`NOT EXISTS (
            SELECT 1 FROM social.blocks b
            WHERE (b.blocker_id = ${caller.userId} AND b.blocked_id = p.author_id)
               OR (b.blocker_id = p.author_id AND b.blocked_id = ${caller.userId})
          )`,
        )
        .where(
          sql<boolean>`NOT EXISTS (
            SELECT 1 FROM social.mutes m
            WHERE m.muter_id = ${caller.userId} AND m.muted_id = p.author_id
          )`,
        );
    }

    // Keyset pagination condition: (score, post_id) < (cursor.s, cursor.id)
    if (cursorData) {
      query = query.where(
        sql<boolean>`(ps.score, ps.post_id) < (${cursorData.s}::double precision, ${cursorData.id}::uuid)`,
      );
    }

    query = query
      .orderBy('ps.score', 'desc')
      .orderBy('ps.post_id', 'desc')
      .limit(limitNum + 1);

    const rows = await query.execute();
    const hasMore = rows.length > limitNum;
    const pageRows = hasMore ? rows.slice(0, limitNum) : rows;

    const items = await hydratePostsBatch(db, pageRows as RawPostRow[], caller, env);

    const snapshotTs = cursorData
      ? cursorData.ts
      : pageRows[0]?.computed_at
        ? new Date(pageRows[0].computed_at).getTime()
        : currentSnapshotTs;

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      nextCursor = encodeCursor<ExploreCursor>({
        s: Number(last.score),
        id: last.id,
        ts: snapshotTs,
      });
    }

    const response: PostPageDto = {
      items,
      next_cursor: nextCursor,
    };

    return reply.status(200).send(response);
  });

  // 3. Hashtag Posts: /v1/hashtags/:tag/posts
  fastify.get<{
    Params: { tag: string };
    Querystring: { cursor?: string; limit?: string };
  }>('/v1/hashtags/:tag/posts', async (request, reply) => {
    const { tag } = request.params;
    const caller = getCaller(request);
    const limitNum = Math.min(100, Math.max(1, parseInt(request.query.limit || '24', 10) || 24));
    const cursor = request.query.cursor;

    const slugRes = await sql<{ slug: string }>`
      SELECT public.winkey_tag_slug(${tag}) AS slug
    `.execute(db);

    const slug = slugRes.rows[0]?.slug;
    if (!slug || slug.length === 0) {
      throw ProblemError.badRequest('Invalid hashtag', undefined, 'INVALID_TAG');
    }

    let cursorData: KeysetCursor | null = null;
    if (cursor) {
      cursorData = decodeCursor<KeysetCursor>(cursor);
      if (
        !cursorData ||
        !isValidUuid(cursorData.id) ||
        !cursorData.created_at ||
        isNaN(Date.parse(cursorData.created_at))
      ) {
        throw ProblemError.badRequest('Invalid pagination cursor', undefined, 'INVALID_CURSOR');
      }
    }

    // Join from social.post_hashtags (index post_hashtags_slug on (slug, created_at DESC, post_id DESC))
    // into social.posts on p.id = ph.post_id (PK lookup)
    let query = db
      .selectFrom('social.post_hashtags as ph')
      .innerJoin('social.posts as p', 'p.id', 'ph.post_id')
      .innerJoin('auth.public_profiles as pr', 'pr.id', 'p.author_id')
      .selectAll('p')
      .select([
        'ph.created_at as hashtag_created_at',
        sql<string>`to_char(ph.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'created_at_cursor',
        ),
      ])
      .where('ph.slug', '=', slug)
      .where('p.status', '=', 'VISIBLE');

    // Visibility filter
    if (caller.userId) {
      query = query
        .where(
          sql<boolean>`(
            p.author_id = ${caller.userId}
            OR (p.visibility = 'PUBLIC' AND (pr.is_private IS NULL OR pr.is_private = false))
            OR EXISTS (
              SELECT 1 FROM social.subscriptions s
              WHERE s.subscriber_id = ${caller.userId} AND s.channel_id = p.author_id
            )
          )`,
        )
        .where(
          sql<boolean>`NOT EXISTS (
            SELECT 1 FROM social.blocks b
            WHERE (b.blocker_id = ${caller.userId} AND b.blocked_id = p.author_id)
               OR (b.blocker_id = p.author_id AND b.blocked_id = ${caller.userId})
          )`,
        )
        .where(
          sql<boolean>`NOT EXISTS (
            SELECT 1 FROM social.mutes m
            WHERE m.muter_id = ${caller.userId} AND m.muted_id = p.author_id
          )`,
        );
    } else {
      query = query
        .where('p.visibility', '=', 'PUBLIC')
        .where(sql<boolean>`(pr.is_private IS NULL OR pr.is_private = false)`);
    }

    // Keyset pagination on (ph.created_at, ph.post_id)
    if (cursorData) {
      query = query.where(
        sql<boolean>`(((ph.created_at < ${cursorData.created_at}::timestamptz) OR (ph.created_at = ${cursorData.created_at}::timestamptz AND ph.post_id < ${cursorData.id}::uuid)))`,
      );
    }

    query = query
      .orderBy('ph.created_at', 'desc')
      .orderBy('ph.post_id', 'desc')
      .limit(limitNum + 1);

    const rows = await query.execute();
    const hasMore = rows.length > limitNum;
    const pageRows = hasMore ? rows.slice(0, limitNum) : rows;

    const items = await hydratePostsBatch(db, pageRows as RawPostRow[], caller, env);

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      const cursorCreatedAt =
        (last as { created_at_cursor?: string }).created_at_cursor ||
        new Date(last.hashtag_created_at).toISOString();
      nextCursor = encodeCursor<KeysetCursor>({
        created_at: cursorCreatedAt,
        id: last.id,
      });
    }

    const response: PostPageDto = {
      items,
      next_cursor: nextCursor,
    };

    return reply.status(200).send(response);
  });

  // 4. Trending Hashtags: /v1/hashtags/trending
  fastify.get<{
    Querystring: { limit?: string };
  }>('/v1/hashtags/trending', async (request, reply) => {
    reply.header('Cache-Control', 'public, max-age=60');

    const limitNum = Math.min(20, Math.max(1, parseInt(request.query.limit || '10', 10) || 10));
    const cacheKey = `social:trending_hashtags:${limitNum}`;

    if (redis) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          return reply.status(200).send(JSON.parse(cached));
        }
      } catch {
        // Ignore cache lookup errors
      }
    }

    // Top hashtags of the last 24 hours from public posts of public accounts
    const result = await sql<TrendingHashtagDto>`
      WITH recent_hashtags AS (
        SELECT ph.slug, ph.tag
        FROM social.post_hashtags ph
        INNER JOIN social.posts p ON p.id = ph.post_id
        INNER JOIN auth.public_profiles pr ON pr.id = p.author_id
        WHERE ph.created_at >= NOW() - INTERVAL '24 hours'
          AND p.status = 'VISIBLE'
          AND p.visibility = 'PUBLIC'
          AND (pr.is_private IS NULL OR pr.is_private = false)
      ),
      slug_counts AS (
        SELECT slug, count(*)::int AS post_count
        FROM recent_hashtags
        GROUP BY slug
        ORDER BY post_count DESC, slug ASC
        LIMIT ${limitNum}
      ),
      top_spellings AS (
        SELECT DISTINCT ON (r.slug) r.slug, r.tag, count(*)::int AS tag_count
        FROM recent_hashtags r
        INNER JOIN slug_counts sc ON sc.slug = r.slug
        GROUP BY r.slug, r.tag
        ORDER BY r.slug, tag_count DESC, r.tag ASC
      )
      SELECT ts.tag, sc.slug, sc.post_count
      FROM slug_counts sc
      INNER JOIN top_spellings ts ON ts.slug = sc.slug
      ORDER BY sc.post_count DESC, sc.slug ASC;
    `.execute(db);

    const response: TrendingHashtagsDto = {
      items: result.rows.map((r) => ({
        tag: r.tag,
        slug: r.slug,
        post_count: Number(r.post_count),
      })),
    };

    if (redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(response), 'EX', 60);
      } catch {
        // Ignore cache set errors
      }
    }

    return reply.status(200).send(response);
  });

  // 5. Channel Posts: /v1/channels/:channel_id/posts
  fastify.get<{
    Params: { channel_id: string };
    Querystring: { cursor?: string; limit?: string };
  }>('/v1/channels/:channel_id/posts', async (request, reply) => {
    const { channel_id } = request.params;
    if (!isValidUuid(channel_id)) {
      throw ProblemError.notFound('Channel not found', 'CHANNEL_NOT_FOUND');
    }

    const caller = getCaller(request);
    const limitNum = Math.min(100, Math.max(1, parseInt(request.query.limit || '24', 10) || 24));
    const cursor = request.query.cursor;

    const channelProfile = await db
      .selectFrom('auth.public_profiles')
      .select(['id', 'is_private'])
      .where('id', '=', channel_id)
      .executeTakeFirst();

    if (!channelProfile) {
      throw ProblemError.notFound('Channel not found', 'CHANNEL_NOT_FOUND');
    }

    // Check block relations
    if (caller.userId) {
      const blocked = await isBlockedEitherWay(db, caller.userId, channel_id);
      if (blocked) {
        const emptyPage: PostPageDto = { items: [], next_cursor: null };
        return reply.status(200).send(emptyPage);
      }
    }

    // If channel is private and caller is not owner and not subscribed -> empty page
    const isOwner = Boolean(caller.userId && caller.userId === channel_id);
    let isSubscribed = false;

    if (caller.userId && !isOwner) {
      const sub = await db
        .selectFrom('social.subscriptions')
        .select(sql`1`.as('sub'))
        .where('subscriber_id', '=', caller.userId)
        .where('channel_id', '=', channel_id)
        .executeTakeFirst();
      isSubscribed = Boolean(sub);
    }

    if (channelProfile.is_private && !isOwner && !isSubscribed) {
      const emptyPage: PostPageDto = { items: [], next_cursor: null };
      return reply.status(200).send(emptyPage);
    }

    let cursorData: KeysetCursor | null = null;
    if (cursor) {
      cursorData = decodeCursor<KeysetCursor>(cursor);
      if (
        !cursorData ||
        !isValidUuid(cursorData.id) ||
        !cursorData.created_at ||
        isNaN(Date.parse(cursorData.created_at))
      ) {
        throw ProblemError.badRequest('Invalid pagination cursor', undefined, 'INVALID_CURSOR');
      }
    }

    // Index posts_author_timeline (author_id, created_at DESC, id DESC) WHERE status = 'VISIBLE'
    let query = db
      .selectFrom('social.posts as p')
      .selectAll('p')
      .select([
        sql<string>`to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'created_at_cursor',
        ),
      ])
      .where('p.author_id', '=', channel_id)
      .where('p.status', '=', 'VISIBLE');

    // If viewer is not owner and not subscribed, can only see PUBLIC posts
    if (!isOwner && !isSubscribed) {
      query = query.where('p.visibility', '=', 'PUBLIC');
    }

    if (cursorData) {
      query = query.where(
        sql<boolean>`(((p.created_at < ${cursorData.created_at}::timestamptz) OR (p.created_at = ${cursorData.created_at}::timestamptz AND p.id < ${cursorData.id}::uuid)))`,
      );
    }

    query = query
      .orderBy('p.created_at', 'desc')
      .orderBy('p.id', 'desc')
      .limit(limitNum + 1);

    const rows = await query.execute();
    const hasMore = rows.length > limitNum;
    const pageRows = hasMore ? rows.slice(0, limitNum) : rows;

    const items = await hydratePostsBatch(db, pageRows as RawPostRow[], caller, env);

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      const cursorCreatedAt =
        (last as { created_at_cursor?: string }).created_at_cursor ||
        new Date(last.created_at).toISOString();
      nextCursor = encodeCursor<KeysetCursor>({
        created_at: cursorCreatedAt,
        id: last.id,
      });
    }

    const response: PostPageDto = {
      items,
      next_cursor: nextCursor,
    };

    return reply.status(200).send(response);
  });
};
