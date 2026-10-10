import type { FastifyPluginAsync } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type {
  Database,
  PublicProfileDto,
  PlaylistDto,
  PlaylistPageDto,
  PlaylistItemDto,
  PlaylistItemPageDto,
  PlaylistMembershipDto,
  PlaylistVisibility,
} from '../db/types.js';
import type { Env } from '../config/env.js';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';
import {
  buildCreatePlaylistRateLimitKey,
  buildAddPlaylistItemRateLimitKey,
} from '../rate-limit/valkey-limiter.js';
import { ProblemError } from '../errors/problem.js';
import { getCaller, requireAuth, isValidUuid } from '../utils/auth.js';
import { encodeCursor, decodeCursor } from '../utils/pagination.js';
import { formatPublicProfile } from '../utils/profile.js';
import { playlistItemsAddedCounter, playlistRenumbersCounter } from '../metrics.js';

export interface PlaylistsRouteOptions {
  db: Kysely<Database>;
  env: Env;
  rateLimiter: RateLimiter;
}

const STEP = 1048576n; // 2^20

interface ChannelPlaylistCursor {
  updated_at: string;
  id: string;
}

interface PlaylistItemCursor {
  position: number;
}

export function resolveOwnerProfile(
  profile:
    | {
        id: string;
        handle: string;
        display_name: string;
        avatar_key: string | null;
      }
    | undefined
    | null,
  ownerId: string,
  mediaBaseUrl: string,
): PublicProfileDto {
  const formatted = formatPublicProfile(profile, mediaBaseUrl);
  if (formatted) return formatted;
  return {
    id: ownerId,
    handle: '',
    display_name: '',
    avatar_url: null,
  };
}

export const playlistsRoute: FastifyPluginAsync<PlaylistsRouteOptions> = async (
  fastify,
  { db, env, rateLimiter },
) => {
  // 1. POST /v1/playlists - Create a playlist owned by the caller
  fastify.post<{
    Body: {
      title?: unknown;
      description?: unknown;
      visibility?: unknown;
      is_series?: unknown;
    };
  }>('/v1/playlists', async (request, reply) => {
    const caller = requireAuth(request);

    // Rate limit: 30 / min per user
    await rateLimiter.consume({
      key: buildCreatePlaylistRateLimitKey(caller.userId),
      limit: 30,
      windowSeconds: 60,
    });

    const body = request.body || {};
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw ProblemError.badRequest('Request body must be an object', undefined, 'INVALID_BODY');
    }

    // Strict validation: check for unknown properties
    const allowedKeys = new Set(['title', 'description', 'visibility', 'is_series']);
    for (const key of Object.keys(body)) {
      if (!allowedKeys.has(key)) {
        throw ProblemError.badRequest(`Unknown property: ${key}`, undefined, 'INVALID_BODY');
      }
    }

    const { title, description, visibility, is_series } = body as {
      title?: unknown;
      description?: unknown;
      visibility?: unknown;
      is_series?: unknown;
    };

    if (typeof title !== 'string' || title.trim().length < 1 || title.length > 150) {
      throw ProblemError.badRequest(
        'Title must be a string between 1 and 150 characters',
        undefined,
        'INVALID_TITLE',
      );
    }

    let descStr = '';
    if (description !== undefined) {
      if (typeof description !== 'string' || description.length > 5000) {
        throw ProblemError.badRequest(
          'Description must be a string up to 5000 characters',
          undefined,
          'INVALID_DESCRIPTION',
        );
      }
      descStr = description;
    }

    let vis: PlaylistVisibility = 'PRIVATE';
    if (visibility !== undefined) {
      if (visibility !== 'PUBLIC' && visibility !== 'UNLISTED' && visibility !== 'PRIVATE') {
        throw ProblemError.badRequest(
          'Visibility must be PUBLIC, UNLISTED, or PRIVATE',
          undefined,
          'INVALID_VISIBILITY',
        );
      }
      vis = visibility;
    }

    if (is_series !== undefined && typeof is_series !== 'boolean') {
      throw ProblemError.badRequest('is_series must be a boolean', undefined, 'INVALID_BODY');
    }

    const newId = uuidv7();

    const created = await db.transaction().execute(async (trx) => {
      // Per-owner advisory transaction lock to serialize count & insert:
      // pg_advisory_xact_lock(hashtext('playlists:' || owner))
      await sql`SELECT pg_advisory_xact_lock(hashtext('playlists:' || ${caller.userId}::text))`.execute(
        trx,
      );

      const countRes = await trx
        .selectFrom('social.playlists')
        .select(sql<number>`count(*)::int`.as('count'))
        .where('owner_id', '=', caller.userId)
        .executeTakeFirst();

      const currentCount = countRes?.count ?? 0;
      if (currentCount >= 200) {
        throw ProblemError.conflict('User playlist limit reached (maximum 200)', 'PLAYLIST_LIMIT');
      }

      return trx
        .insertInto('social.playlists')
        .values({
          id: newId,
          owner_id: caller.userId,
          kind: 'REGULAR',
          title,
          description: descStr,
          visibility: vis,
          is_series: is_series === true,
          item_count: 0,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });

    // Fetch profile
    const profile = await db
      .selectFrom('auth.public_profiles')
      .selectAll()
      .where('id', '=', caller.userId)
      .executeTakeFirst();

    const playlistDto: PlaylistDto = {
      id: created.id,
      owner: resolveOwnerProfile(profile, caller.userId, env.MEDIA_BASE_URL),
      kind: created.kind,
      title: created.title,
      description: created.description,
      visibility: created.visibility,
      is_series: created.is_series,
      item_count: created.item_count,
      created_at: created.created_at.toISOString(),
      updated_at: created.updated_at.toISOString(),
    };

    return reply.status(201).send(playlistDto);
  });

  // 2. GET /v1/playlists/:playlist_id - One playlist (Optional auth)
  fastify.get<{
    Params: { playlist_id: string };
  }>('/v1/playlists/:playlist_id', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const { playlist_id } = request.params;

    if (!isValidUuid(playlist_id)) {
      throw ProblemError.badRequest('Invalid playlist ID', undefined, 'INVALID_ID');
    }

    const caller = getCaller(request);

    const playlist = await db
      .selectFrom('social.playlists as p')
      .leftJoin('auth.public_profiles as prof', 'prof.id', 'p.owner_id')
      .select([
        'p.id',
        'p.owner_id',
        'p.kind',
        'p.title',
        'p.description',
        'p.visibility',
        'p.is_series',
        'p.item_count',
        'p.created_at',
        'p.updated_at',
        'prof.id as prof_id',
        'prof.handle as prof_handle',
        'prof.display_name as prof_display_name',
        'prof.avatar_key as prof_avatar_key',
      ])
      .where('p.id', '=', playlist_id)
      .executeTakeFirst();

    if (!playlist) {
      throw ProblemError.notFound('Playlist not found', 'PLAYLIST_NOT_FOUND');
    }

    // Visibility check: PRIVATE or WATCH_LATER -> owner only (404 otherwise, never 403)
    if (playlist.kind === 'WATCH_LATER' || playlist.visibility === 'PRIVATE') {
      if (!caller.userId || caller.userId !== playlist.owner_id) {
        throw ProblemError.notFound('Playlist not found', 'PLAYLIST_NOT_FOUND');
      }
    }

    const playlistDto: PlaylistDto = {
      id: playlist.id,
      owner: resolveOwnerProfile(
        playlist.prof_id
          ? {
              id: playlist.prof_id,
              handle: playlist.prof_handle!,
              display_name: playlist.prof_display_name!,
              avatar_key: playlist.prof_avatar_key,
            }
          : undefined,
        playlist.owner_id,
        env.MEDIA_BASE_URL,
      ),
      kind: playlist.kind,
      title: playlist.title,
      description: playlist.description,
      visibility: playlist.visibility,
      is_series: playlist.is_series,
      item_count: playlist.item_count,
      created_at: playlist.created_at.toISOString(),
      updated_at: playlist.updated_at.toISOString(),
    };

    return reply.status(200).send(playlistDto);
  });

  // 3. PATCH /v1/playlists/:playlist_id - Update playlist
  fastify.patch<{
    Params: { playlist_id: string };
    Body: {
      title?: unknown;
      description?: unknown;
      visibility?: unknown;
      is_series?: unknown;
    };
  }>('/v1/playlists/:playlist_id', async (request, reply) => {
    const caller = requireAuth(request);
    const { playlist_id } = request.params;

    if (!isValidUuid(playlist_id)) {
      throw ProblemError.badRequest('Invalid playlist ID', undefined, 'INVALID_ID');
    }

    const body = request.body || {};
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw ProblemError.badRequest('Request body must be an object', undefined, 'INVALID_BODY');
    }

    const allowedKeys = new Set(['title', 'description', 'visibility', 'is_series']);
    for (const key of Object.keys(body)) {
      if (!allowedKeys.has(key)) {
        throw ProblemError.badRequest(`Unknown property: ${key}`, undefined, 'INVALID_BODY');
      }
    }

    const { title, description, visibility, is_series } = body as {
      title?: unknown;
      description?: unknown;
      visibility?: unknown;
      is_series?: unknown;
    };

    if (
      title === undefined &&
      description === undefined &&
      visibility === undefined &&
      is_series === undefined
    ) {
      throw ProblemError.badRequest(
        'At least one field (title, description, visibility, is_series) must be provided',
        undefined,
        'INVALID_BODY',
      );
    }

    if (
      title !== undefined &&
      (typeof title !== 'string' || title.trim().length < 1 || title.length > 150)
    ) {
      throw ProblemError.badRequest(
        'Title must be a string between 1 and 150 characters',
        undefined,
        'INVALID_TITLE',
      );
    }

    if (
      description !== undefined &&
      (typeof description !== 'string' || description.length > 5000)
    ) {
      throw ProblemError.badRequest(
        'Description must be a string up to 5000 characters',
        undefined,
        'INVALID_DESCRIPTION',
      );
    }

    if (
      visibility !== undefined &&
      visibility !== 'PUBLIC' &&
      visibility !== 'UNLISTED' &&
      visibility !== 'PRIVATE'
    ) {
      throw ProblemError.badRequest(
        'Visibility must be PUBLIC, UNLISTED, or PRIVATE',
        undefined,
        'INVALID_VISIBILITY',
      );
    }

    if (is_series !== undefined && typeof is_series !== 'boolean') {
      throw ProblemError.badRequest('is_series must be a boolean', undefined, 'INVALID_BODY');
    }

    // Check ownership and kind
    const existing = await db
      .selectFrom('social.playlists')
      .selectAll()
      .where('id', '=', playlist_id)
      .executeTakeFirst();

    if (!existing || existing.owner_id !== caller.userId) {
      throw ProblemError.notFound('Playlist not found', 'PLAYLIST_NOT_FOUND');
    }

    if (existing.kind === 'WATCH_LATER') {
      throw ProblemError.conflict(
        'The watch later playlist cannot be modified',
        'WATCH_LATER_IMMUTABLE',
      );
    }

    // If turning on is_series, check for foreign items
    if (is_series === true) {
      const foreignItem = await db
        .selectFrom('social.playlist_items as pi')
        .innerJoin('social.videos as v', 'v.id', 'pi.video_id')
        .select('pi.video_id')
        .where('pi.playlist_id', '=', playlist_id)
        .where('v.owner_id', '<>', existing.owner_id)
        .executeTakeFirst();

      if (foreignItem) {
        throw ProblemError.conflict(
          'Playlist contains videos belonging to another channel',
          'SERIES_FOREIGN_ITEM',
        );
      }
    }

    const updates: Partial<{
      title: string;
      description: string;
      visibility: PlaylistVisibility;
      is_series: boolean;
      updated_at: Date;
    }> = {
      updated_at: new Date(),
    };

    if (title !== undefined) updates.title = title as string;
    if (description !== undefined) updates.description = description as string;
    if (visibility !== undefined) updates.visibility = visibility as PlaylistVisibility;
    if (is_series !== undefined) updates.is_series = is_series as boolean;

    try {
      const updated = await db
        .updateTable('social.playlists')
        .set(updates)
        .where('id', '=', playlist_id)
        .returningAll()
        .executeTakeFirstOrThrow();

      const profile = await db
        .selectFrom('auth.public_profiles')
        .selectAll()
        .where('id', '=', caller.userId)
        .executeTakeFirst();

      const playlistDto: PlaylistDto = {
        id: updated.id,
        owner: resolveOwnerProfile(profile, caller.userId, env.MEDIA_BASE_URL),
        kind: updated.kind,
        title: updated.title,
        description: updated.description,
        visibility: updated.visibility,
        is_series: updated.is_series,
        item_count: updated.item_count,
        created_at: updated.created_at.toISOString(),
        updated_at: updated.updated_at.toISOString(),
      };

      return reply.status(200).send(playlistDto);
    } catch (err: unknown) {
      if (err instanceof ProblemError) throw err;
      const pgErr = err as { code?: string; message?: string };
      if (pgErr.code === '23514' && pgErr.message?.includes('SERIES_FOREIGN_ITEM')) {
        throw ProblemError.conflict(
          'Playlist contains videos belonging to another channel',
          'SERIES_FOREIGN_ITEM',
        );
      }
      throw err;
    }
  });

  // 4. DELETE /v1/playlists/:playlist_id - Delete playlist
  fastify.delete<{
    Params: { playlist_id: string };
  }>('/v1/playlists/:playlist_id', async (request, reply) => {
    const caller = requireAuth(request);
    const { playlist_id } = request.params;

    if (!isValidUuid(playlist_id)) {
      throw ProblemError.badRequest('Invalid playlist ID', undefined, 'INVALID_ID');
    }

    const existing = await db
      .selectFrom('social.playlists')
      .select(['id', 'owner_id', 'kind'])
      .where('id', '=', playlist_id)
      .executeTakeFirst();

    if (!existing || existing.owner_id !== caller.userId) {
      throw ProblemError.notFound('Playlist not found', 'PLAYLIST_NOT_FOUND');
    }

    if (existing.kind === 'WATCH_LATER') {
      throw ProblemError.conflict(
        'The watch later playlist cannot be deleted',
        'WATCH_LATER_IMMUTABLE',
      );
    }

    await db.deleteFrom('social.playlists').where('id', '=', playlist_id).execute();

    return reply.status(204).send();
  });

  // 5. GET /v1/playlists/:playlist_id/items - List playlist items
  fastify.get<{
    Params: { playlist_id: string };
    Querystring: {
      limit?: string;
      cursor?: string;
    };
  }>('/v1/playlists/:playlist_id/items', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const { playlist_id } = request.params;

    if (!isValidUuid(playlist_id)) {
      throw ProblemError.badRequest('Invalid playlist ID', undefined, 'INVALID_ID');
    }

    const caller = getCaller(request);

    // Verify playlist visibility
    const playlist = await db
      .selectFrom('social.playlists')
      .select(['id', 'owner_id', 'kind', 'visibility'])
      .where('id', '=', playlist_id)
      .executeTakeFirst();

    if (!playlist) {
      throw ProblemError.notFound('Playlist not found', 'PLAYLIST_NOT_FOUND');
    }

    if (playlist.kind === 'WATCH_LATER' || playlist.visibility === 'PRIVATE') {
      if (!caller.userId || caller.userId !== playlist.owner_id) {
        throw ProblemError.notFound('Playlist not found', 'PLAYLIST_NOT_FOUND');
      }
    }

    let limitNum = 24;
    if (request.query.limit !== undefined) {
      const parsed = parseInt(request.query.limit, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 100) {
        throw ProblemError.badRequest(
          'Limit must be an integer between 1 and 100',
          undefined,
          'INVALID_LIMIT',
        );
      }
      limitNum = parsed;
    }

    let cursorData: PlaylistItemCursor | null = null;
    if (request.query.cursor) {
      cursorData = decodeCursor<PlaylistItemCursor>(request.query.cursor);
      if (!cursorData || typeof cursorData.position !== 'number') {
        throw ProblemError.badRequest('Invalid pagination cursor', undefined, 'INVALID_CURSOR');
      }
    }

    // Join social.videos; filter at read time:
    // video not hidden, not private unless owned by caller
    let query = db
      .selectFrom('social.playlist_items as pi')
      .innerJoin('social.videos as v', 'v.id', 'pi.video_id')
      .select(['pi.video_id', 'pi.position', 'pi.added_at'])
      .where('pi.playlist_id', '=', playlist_id)
      .where(
        sql<boolean>`((NOT v.hidden AND v.visibility <> 'PRIVATE') OR ${
          caller.userId ? sql`v.owner_id = ${caller.userId}` : sql`false`
        })`,
      )
      .orderBy('pi.position', 'asc');

    if (cursorData) {
      query = query.where('pi.position', '>', String(cursorData.position));
    }

    const rows = await query.limit(limitNum + 1).execute();

    const hasMore = rows.length > limitNum;
    const items = hasMore ? rows.slice(0, limitNum) : rows;

    const playlistItems: PlaylistItemDto[] = items.map((r) => ({
      video_id: r.video_id,
      position: Number(r.position),
      added_at: r.added_at.toISOString(),
    }));

    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1];
      nextCursor = encodeCursor<PlaylistItemCursor>({
        position: Number(last.position),
      });
    }

    const pageDto: PlaylistItemPageDto = {
      items: playlistItems,
      next_cursor: nextCursor,
    };

    return reply.status(200).send(pageDto);
  });

  // 6. POST /v1/playlists/:playlist_id/items - Append video to playlist
  fastify.post<{
    Params: { playlist_id: string };
    Body: { video_id?: unknown };
  }>('/v1/playlists/:playlist_id/items', async (request, reply) => {
    const caller = requireAuth(request);
    const { playlist_id } = request.params;

    if (!isValidUuid(playlist_id)) {
      throw ProblemError.badRequest('Invalid playlist ID', undefined, 'INVALID_ID');
    }

    // Rate limit: 120 / min per user
    await rateLimiter.consume({
      key: buildAddPlaylistItemRateLimitKey(caller.userId),
      limit: 120,
      windowSeconds: 60,
    });

    const body = request.body || {};
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw ProblemError.badRequest('Request body must be an object', undefined, 'INVALID_BODY');
    }

    const { video_id } = body as { video_id?: unknown };
    if (!isValidUuid(video_id)) {
      throw ProblemError.badRequest('Invalid video ID', undefined, 'INVALID_ID');
    }

    // Check video readability first
    const video = await db
      .selectFrom('social.videos')
      .select(['id', 'owner_id', 'hidden', 'visibility'])
      .where('id', '=', video_id)
      .executeTakeFirst();

    if (!video) {
      throw ProblemError.notFound('Video not found or not accessible', 'VIDEO_NOT_FOUND');
    }

    const isReadable =
      (!video.hidden && video.visibility !== 'PRIVATE') || video.owner_id === caller.userId;
    if (!isReadable) {
      throw ProblemError.notFound('Video not found or not accessible', 'VIDEO_NOT_FOUND');
    }

    // Perform inside transaction with playlist locked FOR UPDATE
    let isNew = false;
    let resultItem: { video_id: string; position: number; added_at: Date };

    try {
      resultItem = await db.transaction().execute(async (trx) => {
        const playlist = await trx
          .selectFrom('social.playlists')
          .select(['id', 'owner_id', 'item_count', 'is_series'])
          .where('id', '=', playlist_id)
          .forUpdate()
          .executeTakeFirst();

        if (!playlist || playlist.owner_id !== caller.userId) {
          throw ProblemError.notFound('Playlist not found', 'PLAYLIST_NOT_FOUND');
        }

        // A series only accepts the owner's own videos
        if (playlist.is_series && video.owner_id !== playlist.owner_id) {
          throw ProblemError.conflict(
            'Cannot add video of another channel to a series',
            'SERIES_FOREIGN_ITEM',
          );
        }

        // Check if already in playlist (idempotent 200)
        const existingItem = await trx
          .selectFrom('social.playlist_items')
          .select(['video_id', 'position', 'added_at'])
          .where('playlist_id', '=', playlist_id)
          .where('video_id', '=', video_id)
          .executeTakeFirst();

        if (existingItem) {
          return {
            video_id: existingItem.video_id,
            position: Number(existingItem.position),
            added_at: existingItem.added_at,
          };
        }

        // Enforce 5000 item limit before insert
        if (playlist.item_count >= 5000) {
          throw ProblemError.conflict('Playlist is full (maximum 5000 items)', 'PLAYLIST_FULL');
        }

        // Append at max(position) + 2^20
        const maxPosRes = await trx
          .selectFrom('social.playlist_items')
          .select(sql<string | null>`max(position)`.as('max_pos'))
          .where('playlist_id', '=', playlist_id)
          .executeTakeFirst();

        const currentMax = maxPosRes?.max_pos ? BigInt(maxPosRes.max_pos) : 0n;
        const newPos = currentMax + STEP;

        const inserted = await trx
          .insertInto('social.playlist_items')
          .values({
            playlist_id,
            video_id,
            position: newPos.toString(),
          })
          .returning(['video_id', 'position', 'added_at'])
          .executeTakeFirstOrThrow();

        isNew = true;
        return {
          video_id: inserted.video_id,
          position: Number(inserted.position),
          added_at: inserted.added_at,
        };
      });
    } catch (err: unknown) {
      if (err instanceof ProblemError) throw err;
      // Map check_violation (code 23514)
      const pgErr = err as { code?: string; message?: string };
      if (pgErr.code === '23514') {
        if (pgErr.message?.includes('SERIES_FOREIGN_ITEM')) {
          throw ProblemError.conflict(
            'Cannot add video of another channel to a series',
            'SERIES_FOREIGN_ITEM',
          );
        }
        throw ProblemError.conflict('Playlist is full (maximum 5000 items)', 'PLAYLIST_FULL');
      }
      throw err;
    }

    if (isNew) {
      playlistItemsAddedCounter.inc();
    }

    const itemDto: PlaylistItemDto = {
      video_id: resultItem.video_id,
      position: resultItem.position,
      added_at: resultItem.added_at.toISOString(),
    };

    return reply.status(isNew ? 201 : 200).send(itemDto);
  });

  // 7. DELETE /v1/playlists/:playlist_id/items/:video_id - Remove video from playlist
  fastify.delete<{
    Params: { playlist_id: string; video_id: string };
  }>('/v1/playlists/:playlist_id/items/:video_id', async (request, reply) => {
    const caller = requireAuth(request);
    const { playlist_id, video_id } = request.params;

    if (!isValidUuid(playlist_id) || !isValidUuid(video_id)) {
      throw ProblemError.badRequest('Invalid ID', undefined, 'INVALID_ID');
    }

    const playlist = await db
      .selectFrom('social.playlists')
      .select(['id', 'owner_id'])
      .where('id', '=', playlist_id)
      .executeTakeFirst();

    if (!playlist || playlist.owner_id !== caller.userId) {
      throw ProblemError.notFound('Playlist not found', 'PLAYLIST_NOT_FOUND');
    }

    await db
      .deleteFrom('social.playlist_items')
      .where('playlist_id', '=', playlist_id)
      .where('video_id', '=', video_id)
      .execute();

    return reply.status(204).send();
  });

  // 8. POST /v1/playlists/:playlist_id/items/:video_id/move - Move item
  fastify.post<{
    Params: { playlist_id: string; video_id: string };
    Body: { before_video_id?: unknown };
  }>('/v1/playlists/:playlist_id/items/:video_id/move', async (request, reply) => {
    const caller = requireAuth(request);
    const { playlist_id, video_id } = request.params;

    if (!isValidUuid(playlist_id) || !isValidUuid(video_id)) {
      throw ProblemError.badRequest('Invalid ID', undefined, 'INVALID_ID');
    }

    const body = request.body || {};
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw ProblemError.badRequest('Request body must be an object', undefined, 'INVALID_BODY');
    }

    if (!('before_video_id' in body)) {
      throw ProblemError.badRequest('before_video_id must be provided', undefined, 'INVALID_BODY');
    }

    const { before_video_id } = body as { before_video_id?: unknown };
    if (before_video_id !== null && !isValidUuid(before_video_id)) {
      throw ProblemError.badRequest(
        'before_video_id must be null or a valid UUID',
        undefined,
        'INVALID_ID',
      );
    }

    // Moving before itself is a no-op 200
    if (before_video_id === video_id) {
      const existing = await db
        .selectFrom('social.playlist_items as pi')
        .innerJoin('social.playlists as p', 'p.id', 'pi.playlist_id')
        .select(['pi.video_id', 'pi.position', 'pi.added_at', 'p.owner_id'])
        .where('pi.playlist_id', '=', playlist_id)
        .where('pi.video_id', '=', video_id)
        .executeTakeFirst();

      if (!existing || existing.owner_id !== caller.userId) {
        throw ProblemError.notFound('Item or playlist not found', 'NOT_FOUND');
      }

      return reply.status(200).send({
        video_id: existing.video_id,
        position: Number(existing.position),
        added_at: existing.added_at.toISOString(),
      });
    }

    const updatedItem = await db.transaction().execute(async (trx) => {
      const playlist = await trx
        .selectFrom('social.playlists')
        .select(['id', 'owner_id'])
        .where('id', '=', playlist_id)
        .forUpdate()
        .executeTakeFirst();

      if (!playlist || playlist.owner_id !== caller.userId) {
        throw ProblemError.notFound('Playlist not found', 'PLAYLIST_NOT_FOUND');
      }

      // Fetch all items in playlist sorted by position
      const allItems = await trx
        .selectFrom('social.playlist_items')
        .select(['video_id', 'position', 'added_at'])
        .where('playlist_id', '=', playlist_id)
        .orderBy('position', 'asc')
        .execute();

      const movingItem = allItems.find((i) => i.video_id === video_id);
      if (!movingItem) {
        throw ProblemError.notFound('Item not found in playlist', 'ITEM_NOT_FOUND');
      }

      if (before_video_id !== null) {
        const targetBefore = allItems.find((i) => i.video_id === before_video_id);
        if (!targetBefore) {
          throw ProblemError.notFound(
            'Target before_video_id not found in playlist',
            'TARGET_NOT_FOUND',
          );
        }
      }

      // Filter out moving item from remaining items
      const remaining = allItems.filter((i) => i.video_id !== video_id);

      let targetIndex: number;
      if (before_video_id === null) {
        targetIndex = remaining.length;
      } else {
        targetIndex = remaining.findIndex((i) => i.video_id === before_video_id);
      }

      const posBefore = targetIndex > 0 ? BigInt(remaining[targetIndex - 1].position) : 0n;
      const posAfter =
        targetIndex < remaining.length ? BigInt(remaining[targetIndex].position) : null;

      let newPosition: bigint | null = null;

      if (posAfter === null) {
        // Moved to the end
        newPosition = posBefore + STEP;
      } else if (posBefore === 0n) {
        // Moved to the front
        if (posAfter > 1n) {
          newPosition = posAfter / 2n;
        }
      } else {
        // Moved between posBefore and posAfter
        if (posAfter - posBefore > 1n) {
          newPosition = posBefore + (posAfter - posBefore) / 2n;
        }
      }

      if (newPosition === null) {
        // No integer gap exists -> renumber the whole playlist with step 2^20
        playlistRenumbersCounter.inc();

        const newOrderedList = [
          ...remaining.slice(0, targetIndex),
          movingItem,
          ...remaining.slice(targetIndex),
        ];

        // Defer unique position constraint
        await sql`SET CONSTRAINTS social.playlist_items_position DEFERRED`.execute(trx);

        let curStep = STEP;
        for (const item of newOrderedList) {
          await trx
            .updateTable('social.playlist_items')
            .set({ position: curStep.toString() })
            .where('playlist_id', '=', playlist_id)
            .where('video_id', '=', item.video_id)
            .execute();

          if (item.video_id === video_id) {
            newPosition = curStep;
          }
          curStep += STEP;
        }

        await sql`SET CONSTRAINTS social.playlist_items_position IMMEDIATE`.execute(trx);
      } else {
        await trx
          .updateTable('social.playlist_items')
          .set({ position: newPosition.toString() })
          .where('playlist_id', '=', playlist_id)
          .where('video_id', '=', video_id)
          .execute();
      }

      return {
        video_id: movingItem.video_id,
        position: Number(newPosition),
        added_at: movingItem.added_at,
      };
    });

    const itemDto: PlaylistItemDto = {
      video_id: updatedItem.video_id,
      position: updatedItem.position,
      added_at: updatedItem.added_at.toISOString(),
    };

    return reply.status(200).send(itemDto);
  });

  // 9. GET /v1/channels/:channel_id/playlists - Playlists of a channel
  fastify.get<{
    Params: { channel_id: string };
    Querystring: {
      limit?: string;
      cursor?: string;
    };
  }>('/v1/channels/:channel_id/playlists', async (request, reply) => {
    const { channel_id } = request.params;

    if (!isValidUuid(channel_id)) {
      throw ProblemError.badRequest('Invalid channel ID', undefined, 'INVALID_ID');
    }

    const caller = getCaller(request);
    const isOwner = caller.userId !== null && caller.userId === channel_id;

    let limitNum = 24;
    if (request.query.limit !== undefined) {
      const parsed = parseInt(request.query.limit, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 100) {
        throw ProblemError.badRequest(
          'Limit must be an integer between 1 and 100',
          undefined,
          'INVALID_LIMIT',
        );
      }
      limitNum = parsed;
    }

    let cursorData: ChannelPlaylistCursor | null = null;
    if (request.query.cursor) {
      cursorData = decodeCursor<ChannelPlaylistCursor>(request.query.cursor);
      if (
        !cursorData ||
        typeof cursorData.updated_at !== 'string' ||
        typeof cursorData.id !== 'string' ||
        !isValidUuid(cursorData.id)
      ) {
        throw ProblemError.badRequest('Invalid pagination cursor', undefined, 'INVALID_CURSOR');
      }
    }

    let query = db
      .selectFrom('social.playlists as p')
      .leftJoin('auth.public_profiles as prof', 'prof.id', 'p.owner_id')
      .select([
        'p.id',
        'p.owner_id',
        'p.kind',
        'p.title',
        'p.description',
        'p.visibility',
        'p.is_series',
        'p.item_count',
        'p.created_at',
        'p.updated_at',
        sql<string>`to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'updated_at_cursor',
        ),
        'prof.id as prof_id',
        'prof.handle as prof_handle',
        'prof.display_name as prof_display_name',
        'prof.avatar_key as prof_avatar_key',
      ])
      .where('p.owner_id', '=', channel_id);

    if (isOwner) {
      // Owner sees all of theirs: watch-later first, then updated_at DESC, id DESC
      query = query.orderBy(sql`(CASE WHEN p.kind = 'WATCH_LATER' THEN 0 ELSE 1 END)`, 'asc');
    } else {
      // Others see only PUBLIC (never UNLISTED, PRIVATE, or watch-later)
      query = query.where('p.visibility', '=', 'PUBLIC').where('p.kind', '<>', 'WATCH_LATER');
    }

    query = query.orderBy('p.updated_at', 'desc').orderBy('p.id', 'desc');

    if (cursorData) {
      query = query.where(
        sql<boolean>`(p.updated_at < ${cursorData.updated_at}::timestamptz OR (p.updated_at = ${cursorData.updated_at}::timestamptz AND p.id < ${cursorData.id}::uuid))`,
      );
    }

    const rows = await query.limit(limitNum + 1).execute();

    const hasMore = rows.length > limitNum;
    const items = hasMore ? rows.slice(0, limitNum) : rows;

    const playlists: PlaylistDto[] = items.map((r) => ({
      id: r.id,
      owner: resolveOwnerProfile(
        r.prof_id
          ? {
              id: r.prof_id,
              handle: r.prof_handle!,
              display_name: r.prof_display_name!,
              avatar_key: r.prof_avatar_key,
            }
          : undefined,
        r.owner_id,
        env.MEDIA_BASE_URL,
      ),
      kind: r.kind,
      title: r.title,
      description: r.description,
      visibility: r.visibility,
      is_series: r.is_series,
      item_count: r.item_count,
      created_at: r.created_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
    }));

    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1];
      nextCursor = encodeCursor<ChannelPlaylistCursor>({
        updated_at: last.updated_at_cursor,
        id: last.id,
      });
    }

    const pageDto: PlaylistPageDto = {
      items: playlists,
      next_cursor: nextCursor,
    };

    return reply.status(200).send(pageDto);
  });

  // 10. GET /v1/videos/:video_id/playlist-membership - Caller's playlists containing video
  fastify.get<{
    Params: { video_id: string };
  }>('/v1/videos/:video_id/playlist-membership', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const caller = requireAuth(request);
    const { video_id } = request.params;

    if (!isValidUuid(video_id)) {
      throw ProblemError.badRequest('Invalid video ID', undefined, 'INVALID_ID');
    }

    const rows = await db
      .selectFrom('social.playlist_items as pi')
      .innerJoin('social.playlists as p', 'p.id', 'pi.playlist_id')
      .select('pi.playlist_id')
      .where('p.owner_id', '=', caller.userId)
      .where('pi.video_id', '=', video_id)
      .orderBy('pi.added_at', 'desc')
      .execute();

    const dto: PlaylistMembershipDto = {
      playlist_ids: rows.map((r) => r.playlist_id),
    };

    return reply.status(200).send(dto);
  });

  // 11. GET /v1/me/watch-later - Caller's watch-later playlist (created on first use)
  fastify.get('/v1/me/watch-later', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const caller = requireAuth(request);

    // Insert ON CONFLICT DO NOTHING (never fail getWatchLater on the 200 limit)
    const newId = uuidv7();
    await db
      .insertInto('social.playlists')
      .values({
        id: newId,
        owner_id: caller.userId,
        kind: 'WATCH_LATER',
        title: 'Xem sau',
        description: '',
        visibility: 'PRIVATE',
        item_count: 0,
      })
      .onConflict((oc) => oc.column('owner_id').where('kind', '=', 'WATCH_LATER').doNothing())
      .execute();

    const playlist = await db
      .selectFrom('social.playlists as p')
      .leftJoin('auth.public_profiles as prof', 'prof.id', 'p.owner_id')
      .select([
        'p.id',
        'p.owner_id',
        'p.kind',
        'p.title',
        'p.description',
        'p.visibility',
        'p.is_series',
        'p.item_count',
        'p.created_at',
        'p.updated_at',
        'prof.id as prof_id',
        'prof.handle as prof_handle',
        'prof.display_name as prof_display_name',
        'prof.avatar_key as prof_avatar_key',
      ])
      .where('p.owner_id', '=', caller.userId)
      .where('p.kind', '=', 'WATCH_LATER')
      .executeTakeFirstOrThrow();

    const playlistDto: PlaylistDto = {
      id: playlist.id,
      owner: resolveOwnerProfile(
        playlist.prof_id
          ? {
              id: playlist.prof_id,
              handle: playlist.prof_handle!,
              display_name: playlist.prof_display_name!,
              avatar_key: playlist.prof_avatar_key,
            }
          : undefined,
        caller.userId,
        env.MEDIA_BASE_URL,
      ),
      kind: playlist.kind,
      title: playlist.title,
      description: playlist.description,
      visibility: playlist.visibility,
      is_series: false,
      item_count: playlist.item_count,
      created_at: playlist.created_at.toISOString(),
      updated_at: playlist.updated_at.toISOString(),
    };

    return reply.status(200).send(playlistDto);
  });
};
