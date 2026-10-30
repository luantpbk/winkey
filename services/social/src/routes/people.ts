import type { FastifyPluginAsync } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { Database, PublicProfileDto } from '../db/types.js';
import type { Env } from '../config/env.js';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';
import { buildPeopleSearchRateLimitKey } from '../rate-limit/valkey-limiter.js';
import { ProblemError } from '../errors/problem.js';
import { getCaller } from '../utils/auth.js';
import { encodeCursor, decodeCursor } from '../utils/pagination.js';
import { formatPublicProfile } from '../utils/profile.js';

export interface PeopleRouteOptions {
  db: Kysely<Database>;
  env: Env;
  rateLimiter: RateLimiter;
}

/** Search is for picking a person, not browsing: results stop after this many matches (contract). */
export const PEOPLE_SEARCH_MAX_RESULTS = 100;
/** Below this length display names match by prefix only, so every branch is served by an index (migration 000035). */
const SUBSTRING_MIN_LENGTH = 3;

interface PeopleCursor {
  q: string;
  o: number;
}

/** Trims `q` and drops one leading `@`; returns null unless 1–64 characters are left. */
export function normalizePeopleQuery(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let q = raw.trim();
  if (q.startsWith('@')) q = q.slice(1).trim();
  const length = [...q].length;
  return length >= 1 && length <= 64 ? q : null;
}

/**
 * Escapes LIKE wildcards so `%` and `_` in the query are literal. The escape character is `!` (`ESCAPE '!'`), not a
 * backslash: Kysely's `sql` tag drops a backslash inside a string literal, which silently disables `ESCAPE '\'`.
 */
export function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, (c) => `!${c}`);
}

export const peopleRoute: FastifyPluginAsync<PeopleRouteOptions> = async (
  fastify,
  { db, env, rateLimiter },
) => {
  fastify.get<{ Querystring: { q?: string; limit?: string; cursor?: string } }>(
    '/v1/people/search',
    async (request, reply) => {
      const caller = getCaller(request);

      await rateLimiter.consume({
        key: buildPeopleSearchRateLimitKey(caller.userId ?? `ip:${request.ip}`),
        limit: 60,
        windowSeconds: 60,
      });

      const q = normalizePeopleQuery(request.query.q);
      if (q === null) {
        throw ProblemError.badRequest('q must be 1–64 characters', undefined, 'INVALID_QUERY');
      }

      const rawLimit = request.query.limit;
      const limitNum = rawLimit === undefined ? 10 : Number(rawLimit);
      if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 20) {
        throw ProblemError.badRequest('limit must be an integer from 1 to 20', undefined, 'INVALID_LIMIT');
      }

      let offset = 0;
      if (request.query.cursor) {
        const cursor = decodeCursor<PeopleCursor>(request.query.cursor);
        if (
          !cursor ||
          cursor.q !== q ||
          !Number.isInteger(cursor.o) ||
          cursor.o <= 0 ||
          cursor.o >= PEOPLE_SEARCH_MAX_RESULTS
        ) {
          throw ProblemError.badRequest('Invalid pagination cursor', undefined, 'INVALID_CURSOR');
        }
        offset = cursor.o;
      }
      const take = Math.min(limitNum, PEOPLE_SEARCH_MAX_RESULTS - offset);

      const pattern = escapeLike(q);
      const nameMatch =
        [...q].length >= SUBSTRING_MIN_LENGTH
          ? sql`public.winkey_fold(p.display_name) LIKE '%' || public.winkey_fold(${pattern}) || '%' ESCAPE '!'`
          : sql`public.winkey_fold(p.display_name) LIKE public.winkey_fold(${pattern}) || '%' ESCAPE '!'`;

      const callerFilter = caller.userId
        ? sql`AND p.id <> ${caller.userId}::uuid
              AND NOT EXISTS (
                SELECT 1 FROM social.blocks b
                WHERE (b.blocker_id = ${caller.userId}::uuid AND b.blocked_id = p.id)
                   OR (b.blocker_id = p.id AND b.blocked_id = ${caller.userId}::uuid)
              )`
        : sql``;

      const relationRank = caller.userId
        ? sql`CASE
                WHEN EXISTS (SELECT 1 FROM social.subscriptions s
                             WHERE s.subscriber_id = ${caller.userId}::uuid AND s.channel_id = p.id)
                THEN CASE WHEN EXISTS (SELECT 1 FROM social.subscriptions s
                                       WHERE s.subscriber_id = p.id AND s.channel_id = ${caller.userId}::uuid)
                          THEN 0 ELSE 1 END
                ELSE 2
              END`
        : sql`2`;

      const rows = await sql<{
        id: string;
        handle: string;
        display_name: string;
        avatar_key: string | null;
      }>`
        SELECT p.id, p.handle, p.display_name, p.avatar_key
        FROM auth.public_profiles p
        WHERE (lower(p.handle) LIKE lower(${pattern}) || '%' ESCAPE '!' OR ${nameMatch})
          ${callerFilter}
        ORDER BY ${relationRank},
                 CASE
                   WHEN lower(p.handle) = lower(${q}) THEN 0
                   WHEN lower(p.handle) LIKE lower(${pattern}) || '%' ESCAPE '!' THEN 1
                   WHEN public.winkey_fold(p.display_name) LIKE public.winkey_fold(${pattern}) || '%' ESCAPE '!' THEN 2
                   ELSE 3
                 END,
                 lower(p.handle), p.id
        LIMIT ${take + 1} OFFSET ${offset}
      `.execute(db);

      const page = rows.rows.slice(0, take);
      const nextOffset = offset + page.length;
      const hasMore = rows.rows.length > take && nextOffset < PEOPLE_SEARCH_MAX_RESULTS;

      const items = page
        .map((row) => formatPublicProfile(row, env.MEDIA_BASE_URL))
        .filter((p): p is PublicProfileDto => p !== null);

      return reply.status(200).send({
        items,
        next_cursor: hasMore ? encodeCursor<PeopleCursor>({ q, o: nextOffset }) : null,
      });
    },
  );
};
