import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'kysely';
import type {
  CinemaCatalogItemDto,
  CinemaCatalogPageDto,
  CinemaCatalogSeriesDto,
  CinemaCatalogVideoDto,
  SeriesEpisodeContextDto,
  SeriesEpisodeDto,
  SeriesEpisodePageDto,
  SeriesSummaryDto,
} from '../db/types.js';
import { ProblemError } from '../errors/problem.js';
import type { PlaylistsRouteOptions } from './playlists.js';
import { resolveOwnerProfile } from './playlists.js';
import { decodeCursor, encodeCursor } from '../utils/pagination.js';
import { isValidUuid } from '../utils/auth.js';

interface CinemaCatalogCursor {
  t: string;
  id: string;
  k: 's' | 'v';
}

interface SeriesEpisodesCursor {
  p: number | string;
  id: string;
}

const DEFAULT_CATALOG_LIMIT = 24;
const MAX_CATALOG_LIMIT = 48;
const DEFAULT_EPISODES_LIMIT = 48;
const MAX_EPISODES_LIMIT = 48;

export const cinemaRoute: FastifyPluginAsync<PlaylistsRouteOptions> = async (
  fastify,
  { db, env },
) => {
  // 1. GET /v1/cinema/catalog - Public cinema catalogue (newest first, optional auth)
  fastify.get<{
    Querystring: {
      kind?: string;
      limit?: string;
      cursor?: string;
    };
  }>('/v1/cinema/catalog', async (request, reply) => {
    reply.header('Cache-Control', 'public, max-age=60');

    const kindParam = request.query.kind ?? 'all';
    if (kindParam !== 'all' && kindParam !== 'series' && kindParam !== 'video') {
      throw ProblemError.badRequest(
        'kind must be all, series, or video',
        undefined,
        'INVALID_KIND',
      );
    }

    let limitNum = DEFAULT_CATALOG_LIMIT;
    if (request.query.limit !== undefined) {
      const parsed = parseInt(request.query.limit, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > MAX_CATALOG_LIMIT) {
        throw ProblemError.badRequest(
          `limit must be an integer between 1 and ${MAX_CATALOG_LIMIT}`,
          undefined,
          'INVALID_LIMIT',
        );
      }
      limitNum = parsed;
    }

    let cursorData: CinemaCatalogCursor | null = null;
    if (request.query.cursor) {
      cursorData = decodeCursor<CinemaCatalogCursor>(request.query.cursor);
      if (
        !cursorData ||
        typeof cursorData.t !== 'string' ||
        typeof cursorData.id !== 'string' ||
        !isValidUuid(cursorData.id) ||
        (cursorData.k !== 's' && cursorData.k !== 'v')
      ) {
        throw ProblemError.badRequest('Invalid pagination cursor', undefined, 'INVALID_CURSOR');
      }
    }

    interface CatalogRawRow {
      kind: 'SERIES' | 'VIDEO';
      id: string;
      sort_time: Date;
      sort_time_str: string;
      title: string | null;
      description: string | null;
      owner_id: string | null;
      episode_count: number | null;
      first_video_id: string | null;
      prof_id: string | null;
      prof_handle: string | null;
      prof_display_name: string | null;
      prof_avatar_key: string | null;
    }

    let rows: CatalogRawRow[] = [];

    if (kindParam === 'series') {
      const seriesQuery = sql<CatalogRawRow>`
        SELECT
          'SERIES'::text AS kind,
          p.id AS id,
          max(pi.added_at) AS sort_time,
          to_char(max(pi.added_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_time_str,
          p.title,
          p.description,
          p.owner_id,
          count(pi.video_id)::int AS episode_count,
          (array_agg(pi.video_id ORDER BY pi.position ASC, pi.video_id ASC))[1] AS first_video_id,
          prof.id AS prof_id,
          prof.handle AS prof_handle,
          prof.display_name AS prof_display_name,
          prof.avatar_key AS prof_avatar_key
        FROM social.playlists p
        JOIN social.playlist_items pi ON pi.playlist_id = p.id
        JOIN social.videos v ON v.id = pi.video_id
        LEFT JOIN auth.public_profiles prof ON prof.id = p.owner_id
        WHERE p.is_series = true
          AND p.visibility = 'PUBLIC'
          AND v.visibility = 'PUBLIC'
          AND NOT v.hidden
          AND v.owner_id = p.owner_id
        GROUP BY p.id, p.title, p.description, p.owner_id, prof.id, prof.handle, prof.display_name, prof.avatar_key
        HAVING count(pi.video_id) >= 1
          ${
            cursorData
              ? sql`AND (max(pi.added_at) < ${cursorData.t}::timestamptz OR (max(pi.added_at) = ${cursorData.t}::timestamptz AND p.id < ${cursorData.id}::uuid))`
              : sql``
          }
        ORDER BY sort_time DESC, id DESC
        LIMIT ${limitNum + 1}
      `;
      const res = await seriesQuery.execute(db);
      rows = res.rows;
    } else if (kindParam === 'video') {
      const videoQuery = sql<CatalogRawRow>`
        SELECT
          'VIDEO'::text AS kind,
          v.id AS id,
          v.created_at AS sort_time,
          to_char(v.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_time_str,
          NULL::text AS title,
          NULL::text AS description,
          NULL::uuid AS owner_id,
          NULL::int AS episode_count,
          NULL::uuid AS first_video_id,
          NULL::uuid AS prof_id,
          NULL::text AS prof_handle,
          NULL::text AS prof_display_name,
          NULL::text AS prof_avatar_key
        FROM social.videos v
        WHERE v.visibility = 'PUBLIC'
          AND NOT v.hidden
          AND NOT EXISTS (
            SELECT 1
            FROM social.playlist_items pi
            JOIN social.playlists p ON p.id = pi.playlist_id
            WHERE pi.video_id = v.id
              AND p.is_series = true
              AND p.visibility = 'PUBLIC'
              AND p.owner_id = v.owner_id
          )
          ${
            cursorData
              ? sql`AND (v.created_at < ${cursorData.t}::timestamptz OR (v.created_at = ${cursorData.t}::timestamptz AND v.id < ${cursorData.id}::uuid))`
              : sql``
          }
        ORDER BY sort_time DESC, id DESC
        LIMIT ${limitNum + 1}
      `;
      const res = await videoQuery.execute(db);
      rows = res.rows;
    } else {
      // kindParam === 'all': interleave both by timestamp DESC, id DESC
      const combinedQuery = sql<CatalogRawRow>`
        WITH series_candidates AS (
          SELECT
            'SERIES'::text AS kind,
            p.id AS id,
            max(pi.added_at) AS sort_time,
            to_char(max(pi.added_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_time_str,
            p.title,
            p.description,
            p.owner_id,
            count(pi.video_id)::int AS episode_count,
            (array_agg(pi.video_id ORDER BY pi.position ASC, pi.video_id ASC))[1] AS first_video_id,
            prof.id AS prof_id,
            prof.handle AS prof_handle,
            prof.display_name AS prof_display_name,
            prof.avatar_key AS prof_avatar_key
          FROM social.playlists p
          JOIN social.playlist_items pi ON pi.playlist_id = p.id
          JOIN social.videos v ON v.id = pi.video_id
          LEFT JOIN auth.public_profiles prof ON prof.id = p.owner_id
          WHERE p.is_series = true
            AND p.visibility = 'PUBLIC'
            AND v.visibility = 'PUBLIC'
            AND NOT v.hidden
            AND v.owner_id = p.owner_id
          GROUP BY p.id, p.title, p.description, p.owner_id, prof.id, prof.handle, prof.display_name, prof.avatar_key
          HAVING count(pi.video_id) >= 1
            ${
              cursorData
                ? sql`AND (max(pi.added_at) < ${cursorData.t}::timestamptz OR (max(pi.added_at) = ${cursorData.t}::timestamptz AND p.id < ${cursorData.id}::uuid))`
                : sql``
            }
          ORDER BY sort_time DESC, id DESC
          LIMIT ${limitNum + 1}
        ),
        videos_candidates AS (
          SELECT
            'VIDEO'::text AS kind,
            v.id AS id,
            v.created_at AS sort_time,
            to_char(v.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_time_str,
            NULL::text AS title,
            NULL::text AS description,
            NULL::uuid AS owner_id,
            NULL::int AS episode_count,
            NULL::uuid AS first_video_id,
            NULL::uuid AS prof_id,
            NULL::text AS prof_handle,
            NULL::text AS prof_display_name,
            NULL::text AS prof_avatar_key
          FROM social.videos v
          WHERE v.visibility = 'PUBLIC'
            AND NOT v.hidden
            AND NOT EXISTS (
              SELECT 1
              FROM social.playlist_items pi
              JOIN social.playlists p ON p.id = pi.playlist_id
              WHERE pi.video_id = v.id
                AND p.is_series = true
                AND p.visibility = 'PUBLIC'
                AND p.owner_id = v.owner_id
            )
            ${
              cursorData
                ? sql`AND (v.created_at < ${cursorData.t}::timestamptz OR (v.created_at = ${cursorData.t}::timestamptz AND v.id < ${cursorData.id}::uuid))`
                : sql``
            }
          ORDER BY sort_time DESC, id DESC
          LIMIT ${limitNum + 1}
        ),
        combined AS (
          SELECT * FROM series_candidates
          UNION ALL
          SELECT * FROM videos_candidates
        )
        SELECT * FROM combined
        ORDER BY sort_time DESC, id DESC
        LIMIT ${limitNum + 1}
      `;
      const res = await combinedQuery.execute(db);
      rows = res.rows;
    }

    const hasMore = rows.length > limitNum;
    const pageRows = hasMore ? rows.slice(0, limitNum) : rows;

    const items: CinemaCatalogItemDto[] = pageRows.map((r) => {
      if (r.kind === 'SERIES') {
        const seriesItem: CinemaCatalogSeriesDto = {
          kind: 'SERIES',
          series: {
            playlist_id: r.id,
            title: r.title ?? '',
            description: r.description ?? '',
            owner: resolveOwnerProfile(
              r.prof_id
                ? {
                    id: r.prof_id,
                    handle: r.prof_handle!,
                    display_name: r.prof_display_name!,
                    avatar_key: r.prof_avatar_key,
                  }
                : undefined,
              r.owner_id!,
              env.MEDIA_BASE_URL,
            ),
            episode_count: Number(r.episode_count),
            first_video_id: r.first_video_id!,
            updated_at: r.sort_time_str,
          },
        };
        return seriesItem;
      }
      const videoItem: CinemaCatalogVideoDto = {
        kind: 'VIDEO',
        video_id: r.id,
        added_at: r.sort_time_str,
      };
      return videoItem;
    });

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      nextCursor = encodeCursor<CinemaCatalogCursor>({
        t: last.sort_time_str,
        id: last.id,
        k: last.kind === 'SERIES' ? 's' : 'v',
      });
    }

    const pageDto: CinemaCatalogPageDto = {
      items,
      next_cursor: nextCursor,
    };

    return reply.status(200).send(pageDto);
  });

  // 2. GET /v1/series/:playlist_id/episodes - Playable episodes of a public series
  fastify.get<{
    Params: { playlist_id: string };
    Querystring: {
      limit?: string;
      cursor?: string;
    };
  }>('/v1/series/:playlist_id/episodes', async (request, reply) => {
    reply.header('Cache-Control', 'public, max-age=60');
    const { playlist_id } = request.params;

    if (!isValidUuid(playlist_id)) {
      throw ProblemError.badRequest('Invalid playlist ID', undefined, 'INVALID_ID');
    }

    let limitNum = DEFAULT_EPISODES_LIMIT;
    if (request.query.limit !== undefined) {
      const parsed = parseInt(request.query.limit, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > MAX_EPISODES_LIMIT) {
        throw ProblemError.badRequest(
          `limit must be an integer between 1 and ${MAX_EPISODES_LIMIT}`,
          undefined,
          'INVALID_LIMIT',
        );
      }
      limitNum = parsed;
    }

    let cursorData: SeriesEpisodesCursor | null = null;
    if (request.query.cursor) {
      cursorData = decodeCursor<SeriesEpisodesCursor>(request.query.cursor);
      if (
        !cursorData ||
        (typeof cursorData.p !== 'number' && typeof cursorData.p !== 'string') ||
        typeof cursorData.id !== 'string' ||
        !isValidUuid(cursorData.id)
      ) {
        throw ProblemError.badRequest('Invalid pagination cursor', undefined, 'INVALID_CURSOR');
      }
    }

    // Check series validity
    const seriesMeta = await db
      .selectFrom('social.playlists as p')
      .leftJoin('auth.public_profiles as prof', 'prof.id', 'p.owner_id')
      .select([
        'p.id',
        'p.owner_id',
        'p.title',
        'p.description',
        'p.visibility',
        'p.is_series',
        'prof.id as prof_id',
        'prof.handle as prof_handle',
        'prof.display_name as prof_display_name',
        'prof.avatar_key as prof_avatar_key',
      ])
      .where('p.id', '=', playlist_id)
      .executeTakeFirst();

    if (!seriesMeta || seriesMeta.visibility !== 'PUBLIC' || !seriesMeta.is_series) {
      throw ProblemError.notFound('Series not found', 'SERIES_NOT_FOUND');
    }

    // Fetch all playable episodes for this series
    interface EpisodeRow {
      video_id: string;
      position: string;
      added_at: Date;
    }

    const playableEpisodesRes = await sql<EpisodeRow>`
      SELECT
        pi.video_id,
        pi.position,
        pi.added_at
      FROM social.playlist_items pi
      JOIN social.videos v ON v.id = pi.video_id
      WHERE pi.playlist_id = ${playlist_id}::uuid
        AND v.visibility = 'PUBLIC'
        AND NOT v.hidden
        AND v.owner_id = ${seriesMeta.owner_id}::uuid
      ORDER BY pi.position ASC, pi.video_id ASC
    `.execute(db);

    const playableEpisodes = playableEpisodesRes.rows;

    if (playableEpisodes.length === 0) {
      throw ProblemError.notFound('Series not found', 'SERIES_NOT_FOUND');
    }

    // Calculate SeriesSummary
    const maxAddedAt = playableEpisodes.reduce(
      (max, ep) => (ep.added_at > max ? ep.added_at : max),
      playableEpisodes[0].added_at,
    );

    const seriesSummary: SeriesSummaryDto = {
      playlist_id: seriesMeta.id,
      title: seriesMeta.title,
      description: seriesMeta.description,
      owner: resolveOwnerProfile(
        seriesMeta.prof_id
          ? {
              id: seriesMeta.prof_id,
              handle: seriesMeta.prof_handle!,
              display_name: seriesMeta.prof_display_name!,
              avatar_key: seriesMeta.prof_avatar_key,
            }
          : undefined,
        seriesMeta.owner_id,
        env.MEDIA_BASE_URL,
      ),
      episode_count: playableEpisodes.length,
      first_video_id: playableEpisodes[0].video_id,
      updated_at: maxAddedAt.toISOString(),
    };

    // Filter by cursor on (position, video_id)
    let startIndex = 0;
    if (cursorData) {
      const cursorBigInt = BigInt(cursorData.p);
      const foundIdx = playableEpisodes.findIndex((ep) => {
        const epPos = BigInt(ep.position);
        return epPos > cursorBigInt || (epPos === cursorBigInt && ep.video_id > cursorData!.id);
      });
      startIndex = foundIdx === -1 ? playableEpisodes.length : foundIdx;
    }

    const remaining = playableEpisodes.slice(startIndex);
    const hasMore = remaining.length > limitNum;
    const pageRows = hasMore ? remaining.slice(0, limitNum) : remaining;

    const items: SeriesEpisodeDto[] = pageRows.map((ep, idx) => ({
      video_id: ep.video_id,
      episode_number: startIndex + idx + 1,
    }));

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      nextCursor = encodeCursor<SeriesEpisodesCursor>({
        p: Number(last.position),
        id: last.video_id,
      });
    }

    const pageDto: SeriesEpisodePageDto = {
      series: seriesSummary,
      items,
      next_cursor: nextCursor,
    };

    return reply.status(200).send(pageDto);
  });

  // 3. GET /v1/series/:playlist_id/episodes/:video_id - Context of one episode for watch page
  fastify.get<{
    Params: {
      playlist_id: string;
      video_id: string;
    };
  }>('/v1/series/:playlist_id/episodes/:video_id', async (request, reply) => {
    reply.header('Cache-Control', 'public, max-age=60');
    const { playlist_id, video_id } = request.params;

    if (!isValidUuid(playlist_id) || !isValidUuid(video_id)) {
      throw ProblemError.badRequest('Invalid ID', undefined, 'INVALID_ID');
    }

    // Check series validity
    const seriesMeta = await db
      .selectFrom('social.playlists as p')
      .leftJoin('auth.public_profiles as prof', 'prof.id', 'p.owner_id')
      .select([
        'p.id',
        'p.owner_id',
        'p.title',
        'p.description',
        'p.visibility',
        'p.is_series',
        'prof.id as prof_id',
        'prof.handle as prof_handle',
        'prof.display_name as prof_display_name',
        'prof.avatar_key as prof_avatar_key',
      ])
      .where('p.id', '=', playlist_id)
      .executeTakeFirst();

    if (!seriesMeta || seriesMeta.visibility !== 'PUBLIC' || !seriesMeta.is_series) {
      throw ProblemError.notFound('Series not found', 'SERIES_NOT_FOUND');
    }

    interface EpisodeRow {
      video_id: string;
      position: string;
      added_at: Date;
    }

    const playableEpisodesRes = await sql<EpisodeRow>`
      SELECT
        pi.video_id,
        pi.position,
        pi.added_at
      FROM social.playlist_items pi
      JOIN social.videos v ON v.id = pi.video_id
      WHERE pi.playlist_id = ${playlist_id}::uuid
        AND v.visibility = 'PUBLIC'
        AND NOT v.hidden
        AND v.owner_id = ${seriesMeta.owner_id}::uuid
      ORDER BY pi.position ASC, pi.video_id ASC
    `.execute(db);

    const playableEpisodes = playableEpisodesRes.rows;

    if (playableEpisodes.length === 0) {
      throw ProblemError.notFound('Series not found', 'SERIES_NOT_FOUND');
    }

    const targetIdx = playableEpisodes.findIndex((ep) => ep.video_id === video_id);
    if (targetIdx === -1) {
      throw ProblemError.notFound('Episode not found in series', 'EPISODE_NOT_FOUND');
    }

    const maxAddedAt = playableEpisodes.reduce(
      (max, ep) => (ep.added_at > max ? ep.added_at : max),
      playableEpisodes[0].added_at,
    );

    const seriesSummary: SeriesSummaryDto = {
      playlist_id: seriesMeta.id,
      title: seriesMeta.title,
      description: seriesMeta.description,
      owner: resolveOwnerProfile(
        seriesMeta.prof_id
          ? {
              id: seriesMeta.prof_id,
              handle: seriesMeta.prof_handle!,
              display_name: seriesMeta.prof_display_name!,
              avatar_key: seriesMeta.prof_avatar_key,
            }
          : undefined,
        seriesMeta.owner_id,
        env.MEDIA_BASE_URL,
      ),
      episode_count: playableEpisodes.length,
      first_video_id: playableEpisodes[0].video_id,
      updated_at: maxAddedAt.toISOString(),
    };

    const episodeNumber = targetIdx + 1;
    const previousVideoId = targetIdx > 0 ? playableEpisodes[targetIdx - 1].video_id : null;
    const nextVideoId =
      targetIdx < playableEpisodes.length - 1 ? playableEpisodes[targetIdx + 1].video_id : null;

    // page_cursor is the listSeriesEpisodes cursor of the page (default limit 48) containing this episode
    // null for page 1
    const pageIndex = Math.floor(targetIdx / DEFAULT_EPISODES_LIMIT);
    let pageCursor: string | null = null;
    if (pageIndex > 0) {
      const prevPageLastIdx = pageIndex * DEFAULT_EPISODES_LIMIT - 1;
      const prevPageLastItem = playableEpisodes[prevPageLastIdx];
      pageCursor = encodeCursor<SeriesEpisodesCursor>({
        p: Number(prevPageLastItem.position),
        id: prevPageLastItem.video_id,
      });
    }

    const contextDto: SeriesEpisodeContextDto = {
      series: seriesSummary,
      episode_number: episodeNumber,
      previous_video_id: previousVideoId,
      next_video_id: nextVideoId,
      page_cursor: pageCursor,
    };

    return reply.status(200).send(contextDto);
  });
};
